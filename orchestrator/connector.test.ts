/**
 * DaemonConnector tests. A fake ompd (Bun.serve speaking the hello_ok /
 * state / ready / event frame protocol) stands in for a real daemon; the
 * connector dials it over loopback with the bearer token on the upgrade.
 * Covers the status machine, cwd sanity, lastSessionFile tracking, clean vs
 * unexpected close (backoff redial + caps), idle-drop, waitReady, and frame
 * fan-out. All timers are shrunk via connector opts so tests stay fast.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { OMPD_PROTO, type ClientCommand } from "../src/protocol";
import { DaemonConnector, type ConnectorEvents } from "./connector";
import { Registry, type RegistryEntry } from "./registry";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompd-conn-"));
	tmpDirs.push(dir);
	return join(dir, "state.json");
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(25);
	}
}

type CreateInit = Parameters<Registry["create"]>[0];

function baseInit(overrides: Partial<CreateInit> = {}): CreateInit {
	return {
		name: "proj-a",
		cwd: "/srv/proj",
		project: "proj-a",
		labels: [],
		mode: "remote",
		...overrides,
	};
}

async function loadedRegistry(statePath: string): Promise<Registry> {
	const registry = new Registry(statePath);
	await registry.load();
	return registry;
}

interface FakeServer {
	server: Server<undefined>;
	port: number;
	url: string;
	/** Upgrades observed (each = one dial that reached the server). */
	openCount: number;
	openTimes: number[];
	headers: Array<Record<string, string>>;
	serverSockets: ServerWebSocket[];
	/** Server-side close observations: { code } (code = the close frame code). */
	serverCloses: Array<{ code: number }>;
	/** Ping frame payloads received from clients (LIVENESS keepalive). */
	pings: string[];
	received: unknown[];
	stop(): void;
}

interface FakeOptions {
	hello?: Record<string, unknown>;
	/** Prime state + ready on open (default true). */
	prime?: boolean;
	/** When true: nothing on open; the hello answer is followed by state+ready
	 * in order (exercises the session → resolving → ready ladder sequence). */
	primeOnHello?: boolean;
	onOpen?: (fake: FakeServer, ws: ServerWebSocket) => void;
	onMessage?: (fake: FakeServer, ws: ServerWebSocket, frame: unknown) => void;
}

const HELLO_CWD = "/srv/proj";

/** hello_ok frame with the test's default cwd/sessionFile, overridable. */
function helloFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "hello_ok",
		proto: OMPD_PROTO,
		name: "fake",
		cwd: HELLO_CWD,
		pid: 4242,
		version: "test",
		...overrides,
	};
}

/** Prime sequence on open: state (sessionFile) → ready. hello_ok is NOT
 * primed — like the real ompd, it is answered to the connector's hello. */
function prime(ws: ServerWebSocket, opts: { ready?: boolean } = {}): void {
	ws.send(
		JSON.stringify({
			type: "state",
			sessionId: "s1",
			state: { sessionId: "s1", sessionFile: "/srv/proj/sess.jsonl", isStreaming: false },
		}),
	);
	if (opts.ready !== false) ws.send(JSON.stringify({ type: "ready", readyAt: Date.now() }));
}

function startFake(opts: FakeOptions = {}): FakeServer {
	const fake: FakeServer = {
		server: null as unknown as Server<undefined>,
		port: 0,
		url: "",
		openCount: 0,
		openTimes: [],
		headers: [],
		serverSockets: [],
		serverCloses: [],
		pings: [],
		received: [],
		stop() {
			this.server.stop(true);
		},
	};
	fake.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			fake.openCount++;
			fake.openTimes.push(Date.now());
			fake.headers.push(Object.fromEntries(req.headers.entries()));
			if (!srv.upgrade(req)) return new Response("upgrade failed", { status: 500 });
		},
		websocket: {
			open(ws) {
				fake.serverSockets.push(ws);
				if (opts.onOpen) opts.onOpen(fake, ws);
				else if (opts.prime !== false && !opts.primeOnHello) prime(ws);
			},
			message(ws, message) {
				let frame: unknown;
				try {
					frame = JSON.parse(String(message));
				} catch {
					return;
				}
				// Real ompd behavior: a hello is answered hello_ok and is not
				// part of the command stream (received stays call-frames only).
				if (typeof frame === "object" && frame !== null && "type" in frame && frame.type === "hello") {
					ws.send(JSON.stringify(helloFrame(opts.hello)));
					if (opts.primeOnHello) prime(ws);
					return;
				}
				fake.received.push(frame);
				opts.onMessage?.(fake, ws, frame);
			},
			close(ws, code) {
				fake.serverCloses.push({ code });
			},
			ping(ws, data) {
				// Bun.serve surfaces client ping frames here; the server
				// auto-pongs (sendPings default), which is exactly the
				// responsive-peer behavior the keepalive relies on.
				fake.pings.push(data.toString());
			},
		},
	});
	fake.port = fake.server.port ?? 0;
	fake.url = `ws://127.0.0.1:${fake.port}`;
	return fake;
}

/** Connector with test-sized backoff/idle timers. */
function makeConnector(registry: Registry, events?: ConnectorEvents): DaemonConnector {
	return new DaemonConnector(registry, events, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 60_000 });
}

/**
 * A minimal raw-TCP WebSocket server that completes the upgrade handshake
 * and then NEVER answers ping frames. Bun.serve cannot fake a silent peer:
 * its ping→pong auto-response is hardwired (verified with sendPings:false),
 * so the silent-peer keepalive test speaks the WS protocol directly.
 * Client frames are masked per RFC 6455; opcode 0x9 = ping, 0x8 = close.
 */
function startSilentWsServer() {
	interface Conn {
		buf: Buffer;
		handshakeDone: boolean;
		pings: number;
		closed: boolean;
	}
	const connections: Conn[] = [];
	const server = Bun.listen<Conn>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, data) {
				const conn = socket.data;
				const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
				conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
				if (!conn.handshakeDone) {
					const headerEnd = conn.buf.indexOf("\r\n\r\n");
					if (headerEnd === -1) return;
					const head = conn.buf.subarray(0, headerEnd).toString("utf8");
					conn.buf = conn.buf.subarray(headerEnd + 4);
					conn.handshakeDone = true;
					const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "";
					const accept = createHash("sha1")
						.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
						.digest("base64");
					socket.write(
						`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
					);
				}
				for (;;) {
					if (conn.buf.length < 2) return;
					const opcode = conn.buf[0]! & 0x0f;
					let len = conn.buf[1]! & 0x7f;
					let offset = 2;
					if (len === 126) {
						if (conn.buf.length < 4) return;
						len = conn.buf.readUInt16BE(2);
						offset = 4;
					} else if (len === 127) {
						if (conn.buf.length < 10) return;
						len = Number(conn.buf.readBigUInt64BE(2));
						offset = 10;
					}
					if (conn.buf.length < offset + 4 + len) return; // 4 mask bytes
					if (opcode === 0x9) conn.pings++;
					else if (opcode === 0x8) socket.write(Buffer.from([0x88, 0x00])); // close echo
					conn.buf = conn.buf.subarray(offset + 4 + len);
				}
			},
			open(socket) {
				socket.data = { buf: Buffer.alloc(0), handshakeDone: false, pings: 0, closed: false } satisfies Conn;
				connections.push(socket.data);
			},
			close(socket) {
				socket.data.closed = true;
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		connections,
		stop: () => {
			server.stop(true);
		},
	};
}

describe("DaemonConnector", () => {
	test("status machine: connecting → session → resolving → ready; auth header; lastSessionFile", async () => {
		const fake = startFake({ hello: { sessionFile: "/srv/proj/hello.sess" }, primeOnHello: true });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok-1", mode: "attached" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 2000, "ready");
		expect(statuses).toEqual(["connecting", "session", "resolving", "ready"]);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		expect(fake.openCount).toBe(1);
		expect(fake.headers[0]?.["authorization"]).toBe("Bearer tok-1");
		// hello_ok.sessionFile then the state frame's sessionFile; the last wins.
		expect(registry.get(entry.daemonId)?.lastSessionFile).toBe("/srv/proj/sess.jsonl");
		expect(registry.get(entry.daemonId)?.readyAt).toBeTypeOf("number");
		await connector.close();
		fake.stop();
	});

	test("empty registry cwd adopts hello_ok.cwd", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", cwd: "", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 2000, "ready");
		expect(registry.get(entry.daemonId)?.cwd).toBe(HELLO_CWD);
		await connector.close();
		fake.stop();
	});

	test("hello_ok.cwd mismatch → error, no redial", async () => {
		const fake = startFake({ hello: { cwd: "/elsewhere" } });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null, 2000, "error");
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("cwd mismatch");
		expect(updated.status).toBe("error");
		await sleep(150);
		expect(fake.openCount).toBe(1); // error is terminal: no reconnect churn
		await connector.close();
		fake.stop();
	});

	test("clean close (1000) → asleep, no redial", async () => {
		const fake = startFake({
			onOpen: (fake, ws) => {
				prime(ws);
				ws.close(1000, "idle");
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "asleep" ? "asleep" : null), 2000, "asleep");
		await sleep(150);
		expect(fake.openCount).toBe(1);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		await connector.close();
		fake.stop();
	});

	test("unexpected close → reconnecting with redial; backoff stays capped", async () => {
		const fake = startFake({
			onOpen: (fake, ws) => {
				ws.send(JSON.stringify(helloFrame()));
				ws.close(1011, "crash");
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "remote" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		// Unbounded exponential backoff would take ~10s to reach 10 dials at
		// min=10ms; reaching 10 here within 5s proves the 50ms cap holds.
		await waitFor(() => (fake.openCount >= 10 ? "dialed" : null), 5000, "10 redials");
		expect(statuses).toContain("reconnecting");
		const gaps: number[] = [];
		for (let i = 1; i < fake.openTimes.length; i++) gaps.push(fake.openTimes[i] - fake.openTimes[i - 1]);
		expect(Math.max(...gaps)).toBeLessThanOrEqual(120); // 50ms cap × 1.5 jitter + slack
		await connector.close();
		fake.stop();
	});

	test("dial failure (close before hello) fires onDialFailed and keeps redialing", async () => {
		const fake = startFake({
			onOpen: (fake, ws) => {
				ws.close(1011, "boom"); // never a hello_ok
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "spawned" }));
		let dialFailed = 0;
		const connector = makeConnector(registry, { onDialFailed: () => dialFailed++ });
		connector.connect(entry.daemonId);
		await waitFor(() => (fake.openCount >= 3 ? "dialed" : null), 3000, "3 dials");
		expect(dialFailed).toBeGreaterThanOrEqual(1);
		expect(registry.get(entry.daemonId)?.status).toBe("reconnecting");
		await connector.close();
		fake.stop();
	});

	test("waitReady resolves on ready, rejects on error and on timeout", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000); // resolves on the ready frame
		await connector.waitReady(entry.daemonId, 2000); // immediate path: already ready
		await connector.close();
		fake.stop();

		// Timeout: the fake never sends ready.
		const slow = startFake({ onOpen: (_fake, ws) => prime(ws, { ready: false }) });
		const registry2 = await loadedRegistry(tmpStatePath());
		const entry2 = registry2.create(baseInit({ endpoint: slow.url, token: "tok", mode: "attached" }));
		const connector2 = makeConnector(registry2);
		connector2.connect(entry2.daemonId);
		await waitFor(() => (registry2.get(entry2.daemonId)?.status === "resolving" ? "resolving" : null), 2000, "resolving");
		await expect(connector2.waitReady(entry2.daemonId, 50)).rejects.toThrow(/timed out/);
		await connector2.close();
		slow.stop();

		// Error status rejects immediately.
		const bad = startFake({ hello: { cwd: "/elsewhere" } });
		const registry3 = await loadedRegistry(tmpStatePath());
		const entry3 = registry3.create(baseInit({ endpoint: bad.url, token: "tok", mode: "attached" }));
		const connector3 = makeConnector(registry3);
		connector3.connect(entry3.daemonId);
		await expect(connector3.waitReady(entry3.daemonId, 1000)).rejects.toThrow(/cwd mismatch/);
		await connector3.close();
		bad.stop();
	});

	test("real ompd frame order (state+ready before hello_ok) never downgrades from ready", async () => {
		// The real ompd sends its attach priming (history/state, and ready when
		// the gate already cleared) immediately on upgrade — BEFORE it answers
		// the connector's hello. The ladder must ignore the late session signal.
		const fake = startFake({
			onOpen: (_fake, ws) => {
				ws.send(
					JSON.stringify({
						type: "state",
						sessionId: "s1",
						state: { sessionId: "s1", sessionFile: "/srv/proj/sess.jsonl", isStreaming: false },
					}),
				);
				ws.send(JSON.stringify({ type: "ready", readyAt: Date.now() }));
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Give the hello_ok (answered to our hello) time to arrive and be processed.
		await sleep(150);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		// Early state/ready frames only mark progress; the validated hello_ok
		// replays straight to ready (no resolving/session regressions).
		expect(statuses).toEqual(["connecting", "ready"]);
		// Side effects still landed even though the status did not downgrade.
		expect(registry.get(entry.daemonId)?.lastSessionFile).toBe("/srv/proj/sess.jsonl");
		await connector.close();
		fake.stop();
	});

	test("onFrame fans out to multiple listeners; unsubscribe works", async () => {		const fake = startFake({
			onMessage: (fake, ws) => {
				ws.send(JSON.stringify({ type: "event", sessionId: "s1", event: { type: "notice", level: "info", message: "hi" } }));
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		const seen: string[][] = [[], []];
		const unsub1 = connector.onFrame(entry.daemonId, (f) => seen[0].push(f.type));
		const unsub2 = connector.onFrame(entry.daemonId, (f) => seen[1].push(f.type));
		const cmd: ClientCommand = { type: "call", id: "c1", method: "prompt", args: ["hi"] };
		expect(connector.send(entry.daemonId, cmd)).toBe(true);
		await waitFor(() => (seen[0].includes("event") && seen[1].includes("event") ? "both" : null), 2000, "both listeners");
		unsub1();
		expect(connector.send(entry.daemonId, cmd)).toBe(true);
		await waitFor(() => (seen[1].filter((t) => t === "event").length >= 2 ? "second" : null), 2000, "second event");
		expect(seen[0].filter((t) => t === "event")).toHaveLength(1); // unsubscribed
		expect(fake.received).toHaveLength(2);
		unsub2();
		await connector.close();
		fake.stop();
	});

	test("idle-drop: release to zero disconnects after idleDropMs; status unchanged; connect redials", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 50 });
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		connector.retain(entry.daemonId);
		connector.release(entry.daemonId);
		await waitFor(() => (fake.serverCloses.length >= 1 ? "closed" : null), 2000, "server-observed close");
		// Disconnect is intentional: no status change, no reconnect.
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		await sleep(150);
		expect(fake.openCount).toBe(1);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		// On-demand redial still works after the drop.
		connector.connect(entry.daemonId);
		await waitFor(() => (fake.openCount >= 2 && registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 2000, "redial ready");
		await connector.close();
		fake.stop();
	});

	test("retain/release are paired: one release does not drop a double-retained daemon", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 50 });
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		connector.retain(entry.daemonId);
		connector.retain(entry.daemonId);
		connector.release(entry.daemonId);
		await sleep(150);
		expect(fake.serverCloses).toHaveLength(0); // still retained once
		connector.release(entry.daemonId);
		await waitFor(() => (fake.serverCloses.length >= 1 ? "closed" : null), 2000, "server-observed close");
		await connector.close();
		fake.stop();
	});

	test("disconnect: no status change, no redial; send() reflects socket state", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		const cmd: ClientCommand = { type: "call", id: "c1", method: "prompt", args: ["hi"] };
		expect(connector.send(entry.daemonId, cmd)).toBe(false); // never connected
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		expect(connector.send(entry.daemonId, cmd)).toBe(true);
		connector.connect(entry.daemonId); // idempotent: no second dial
		await sleep(50);
		expect(fake.openCount).toBe(1);
		connector.disconnect(entry.daemonId);
		expect(connector.send(entry.daemonId, cmd)).toBe(false);
		expect(registry.get(entry.daemonId)?.status).toBe("ready"); // unchanged
		await waitFor(() => (fake.serverCloses.length >= 1 ? "closed" : null), 2000, "server-observed close");
		await sleep(150);
		expect(fake.openCount).toBe(1); // no reconnect after intentional drop
		await connector.close();
		fake.stop();
	});

	test("send returns false when the daemon errors out", async () => {
		const fake = startFake({ hello: { cwd: "/elsewhere" } });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "error" ? "error" : null), 2000, "error");
		const cmd: ClientCommand = { type: "call", id: "c1", method: "prompt", args: ["hi"] };
		expect(connector.send(entry.daemonId, cmd)).toBe(false);
		await connector.close();
		fake.stop();
	});

	test("registry removal stops the connector from touching the entry", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		expect(registry.remove(entry.daemonId)).toBe(true);
		expect(() => connector.connect(entry.daemonId)).not.toThrow(); // unknown id: no-op
		expect(connector.send(entry.daemonId, { type: "call", id: "x", method: "prompt", args: [] })).toBe(false);
		await connector.close();
		fake.stop();
	});

	test("keepalive pings an open socket; a responsive peer (auto-pong) stays connected", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
			pingIntervalMs: 30,
			pongTimeoutMs: 20,
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Ping frames reach the daemon (Bun.serve surfaces them in `ping`).
		await waitFor(() => (fake.pings.length >= 2 ? "pings" : null), 2000, "two server-side ping frames");
		// The fake auto-pongs (sendPings default): several more intervals must
		// NOT trip the silence deadline.
		await sleep(150);
		expect(fake.serverCloses).toHaveLength(0);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		await connector.close();
		fake.stop();
	});

	test("a silent peer (no pong) is terminated and the close path reconnects", async () => {
		const silent = startSilentWsServer();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: silent.url, token: "tok", mode: "remote" }));
		const statuses: string[] = [];
		const connector = new DaemonConnector(
			registry,
			{ onStatus: (e) => statuses.push(e.status) },
			{ backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 60_000, pingIntervalMs: 30, pongTimeoutMs: 20 },
		);
		connector.connect(entry.daemonId);
		// The ping goes out, no pong comes back → terminate → 1006 (unexpected)
		// → reconnecting + redial. The raw server counts ping frames.
		await waitFor(() => (silent.connections.some((c) => c.pings >= 1) ? "ping seen" : null), 2000, "server-side ping");
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "reconnecting" ? "reconnecting" : null),
			2000,
			"reconnecting status",
		);
		await waitFor(() => (silent.connections.length >= 2 ? "redial" : null), 3000, "second dial");
		// The redialed socket re-arms the keepalive and is terminated in turn.
		await waitFor(() => (silent.connections[1]?.pings >= 1 ? "second ping" : null), 2000, "ping on second dial");
		expect(statuses).toContain("reconnecting");
		await connector.close();
		silent.stop();
	});
});
