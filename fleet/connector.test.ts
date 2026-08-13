/**
 * DaemonConnector tests. A fake omp-session (Bun.serve speaking the /events
 * SSE + /command POST protocol) stands in for a real daemon; the connector
 * dials it over loopback with the bearer token on the Authorization header.
 * Covers the status machine, cwd sanity, lastSessionFile tracking, clean vs
 * unexpected stream end (backoff redial + caps), 401-terminal auth, silence
 * deadline (with and without keepalives: ping event and raw comment), idle-drop, waitReady,
 * Last-Event-ID resume, and frame fan-out. All timers are shrunk via
 * connector opts so tests stay fast.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
	OMP_PROTO,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_RING_CAP,
	type ClientCommand,
} from "../shared/protocol";
import { encodeSseEvent, SSE_PING_BLOCK, SseRing } from "../shared/sse";
import { DaemonConnector, daemonHttpBase, type ConnectorEvents } from "./connector";
import { Registry, type RegistryEntry } from "./registry";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-conn-"));
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

const HELLO_CWD = "/srv/proj";

/** hello_ok frame with the test's default cwd/sessionFile, overridable. */
function helloFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "hello_ok",
		proto: OMP_PROTO,
		name: "fake",
		cwd: HELLO_CWD,
		pid: 4242,
		version: "test",
		...overrides,
	};
}

/** The attach-priming state frame (sessionFile from the daemon). */
function stateFrame(sessionFile = "/srv/proj/sess.jsonl"): Record<string, unknown> {
	return {
		type: "state",
		sessionId: "s1",
		state: { sessionId: "s1", sessionFile, isStreaming: false },
	};
}

/** One open /events stream on the fake. */
interface FakeStream {
	/** Push a delta frame: ring-recorded with a seq from the fake's delta counter. */
	send(frame: unknown): void;
	/** Push a frame with an explicit seq (priming / ring replay). */
	write(frame: unknown, seq: number): void;
	/** Push the keepalive ping event (liveness only, never a frame). */
	comment(): void;
	/** Push a raw `: ping` comment (legacy liveness shape; parseSseUnits still surfaces it). */
	commentLine(): void;
	/** Cleanly end the stream (the daemon closed it — clean close). */
	close(): void;
	/** Abruptly error the stream (unexpected close). */
	error(): void;
	/** Optional cleanup hook, invoked when the client disconnects. */
	onEnd?: () => void;
	/** Internal: true once the stream has been closed (broadcast skips it). */
	closed?: boolean;
}

interface FakeServer {
	server: Server<undefined>;
	port: number;
	/** Registered endpoint: pathless ws:// (the connector maps it to http). */
	url: string;
	/** /events opens observed (each = one dial that reached the server). */
	openCount: number;
	openTimes: number[];
	headers: Array<Record<string, string>>;
	streams: FakeStream[];
	/** Client aborts observed server-side (client disconnect). */
	serverCloses: number;
	/** POST /command bodies received. */
	received: unknown[];
	/** Delta ring for Last-Event-ID replay (daemon-side). */
	ring: SseRing<unknown>;
	/** Delta seq counter: deltas start at SSE_DELTA_SEQ_START. */
	nextSeq: number;
	/** Ring entries replayed per stream open (after priming). */
	replayCounts: number[];
	/** Push one delta: ring-recorded AND delivered to every open stream. */
	broadcast(frame: unknown): void;
	/** When set, /events 401s unless the bearer token matches. */
	expectedToken?: string;
	stop(): void;
}

interface FakeOptions {
	hello?: Record<string, unknown>;
	/** Prime hello_ok → state → ready on open (default true). */
	prime?: boolean;
	onOpen?: (fake: FakeServer, stream: FakeStream) => void;
	onCommand?: (fake: FakeServer, stream: FakeStream, frame: unknown) => void;
	/** When set, /events 401s unless the bearer token matches. */
	expectedToken?: string;
}

/** Prime sequence on open: hello_ok (seq 1) → state (2) → ready (3). */
function prime(stream: FakeStream, opts: { ready?: boolean; hello?: Record<string, unknown> } = {}): void {
	stream.write(helloFrame(opts.hello), 1);
	stream.write(stateFrame(), 2);
	if (opts.ready !== false) stream.write({ type: "ready", readyAt: Date.now() }, 3);
}

function startFake(opts: FakeOptions = {}): FakeServer {
	const encoder = new TextEncoder();
	const fake: FakeServer = {
		server: null as unknown as Server<undefined>,
		port: 0,
		url: "",
		openCount: 0,
		openTimes: [],
		headers: [],
		streams: [],
		serverCloses: 0,
		received: [],
		ring: new SseRing<unknown>(SSE_RING_CAP),
		nextSeq: SSE_DELTA_SEQ_START,
		replayCounts: [],
		broadcast(frame) {
			const seq = fake.nextSeq++;
			fake.ring.push(seq, frame);
			for (const stream of fake.streams) {
				if (!stream.closed) stream.write(frame, seq);
			}
		},
		stop() {
			this.server.stop(true);
		},
	};
	fake.expectedToken = opts.expectedToken;
	fake.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					let frame: unknown;
					try {
						frame = await req.json();
					} catch {
						return new Response("malformed", { status: 400 });
					}
					fake.received.push(frame);
					const stream = fake.streams.at(-1);
					const id = (frame as { id?: string }).id ?? "";
					if (stream && opts.onCommand) opts.onCommand(fake, stream, frame);
					return Response.json({ commandId: id }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			fake.openCount++;
			fake.openTimes.push(Date.now());
			const headers = Object.fromEntries(req.headers.entries());
			fake.headers.push(headers);
			if (fake.expectedToken && headers.authorization !== `Bearer ${fake.expectedToken}`) {
				return new Response("unauthorized", { status: 401 });
			}
			const lastId = Number(headers["last-event-id"]);
			const wantsReplay = Number.isFinite(lastId) && lastId >= SSE_DELTA_SEQ_START;
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			let closeRecorded = false;
			const recordClose = (): void => {
				if (closeRecorded) return;
				closeRecorded = true;
				fake.serverCloses++;
				stream.onEnd?.();
			};
			const stream: FakeStream = {
				send(frame) {
					const seq = fake.nextSeq++;
					fake.ring.push(seq, frame);
					controller!.enqueue(encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, seq)));
				},
				write(frame, seq) {
					controller!.enqueue(encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, seq)));
				},
				comment() {
					controller!.enqueue(encoder.encode(SSE_PING_BLOCK));
				},
				commentLine() {
					controller!.enqueue(encoder.encode(": ping\n\n"));
				},
				close() {
					stream.closed = true;
					controller!.close();
				},
				error() {
					controller!.error(new Error("stream aborted"));
				},
			};
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					controller = ctrl;
					fake.streams.push(stream);
					req.signal.addEventListener("abort", recordClose);
					if (opts.onOpen) opts.onOpen(fake, stream);
					else if (opts.prime !== false) prime(stream, { hello: opts.hello });
					// Ring replay AFTER priming (wire contract); replayed entries
					// keep their original seqs.
					if (wantsReplay) {
						const replayed = fake.ring.after(lastId);
						fake.replayCounts.push(replayed.length);
						for (const { seq, value } of replayed) stream.write(value, seq);
					} else {
						fake.replayCounts.push(0);
					}
				},
				cancel() {
					recordClose();
				},
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
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

/** SSE chunk-wrapping for the raw crash server's HTTP/1.1 chunked body. */
function chunked(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	return bytes.length.toString(16) + "\r\n" + text + "\r\n";
}

/**
 * A minimal raw HTTP/1.1 SSE server that ends the connection mid-chunked-body
 * (like a real daemon crash): the client's body read rejects with a network
 * error — the "unexpected close" the connector maps to reconnecting. Bun.serve
 * cannot fake this: its fetch handler closes even errored response streams
 * cleanly (scratch-verified), which the connector would read as a dormant
 * daemon and go asleep.
 */
function startCrashServer(opts: { primeHello?: boolean } = {}) {
	interface Conn {
		buf: Buffer;
		handshakeDone: boolean;
	}
	const connections: Conn[] = [];
	const openTimes: number[] = [];
	const server = Bun.listen<Conn>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { buf: Buffer.alloc(0), handshakeDone: false } satisfies Conn;
			},
			data(socket, data) {
				const conn = socket.data;
				const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
				conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
				if (!conn.handshakeDone) {
					const headerEnd = conn.buf.indexOf("\r\n\r\n");
					if (headerEnd === -1) return;
					conn.buf = conn.buf.subarray(headerEnd + 4);
					conn.handshakeDone = true;
					connections.push(conn);
					openTimes.push(Date.now());
					let out = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
					if (opts.primeHello) out += chunked(encodeSseEvent(SSE_EVENT_NAME, helloFrame(), 1));
					socket.write(out);
					// Crash: FIN mid-body without the terminating 0-chunk. The
					// client's next read rejects → the connector redials.
					setTimeout(() => {
						try {
							socket.end();
						} catch {
							// Already closed.
						}
					}, 2);
				}
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		connections,
		openTimes,
		openCount: () => connections.length,
		stop: () => {
			server.stop(true);
		},
	};
}

describe("DaemonConnector", () => {
	test("daemonHttpBase derives the origin base for /events and /command", () => {
		expect(daemonHttpBase("ws://127.0.0.1:4721")).toBe("http://127.0.0.1:4721");
		expect(daemonHttpBase("wss://omp.example.com:9443")).toBe("https://omp.example.com:9443");
		expect(daemonHttpBase("ws://host:8000/ws")).toBe("http://host:8000");
		expect(daemonHttpBase("http://host:8000")).toBe("http://host:8000");
	});

	test("status machine: connecting → session → resolving → ready; auth header; lastSessionFile", async () => {
		const fake = startFake({ hello: { sessionFile: "/srv/proj/hello.sess" } });
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

	test("hello_ok.proto mismatch (protocol drift) → error, no redial", async () => {
		const fake = startFake({ hello: { proto: 1 } });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null, 2000, "error");
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("proto mismatch");
		expect(updated.status).toBe("error");
		await sleep(150);
		expect(fake.openCount).toBe(1); // error is terminal: no reconnect churn
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

	test("clean stream end → asleep, no redial", async () => {
		const fake = startFake({
			onOpen: (_fake, stream) => {
				prime(stream);
				stream.close();
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

	test("stream_reset before a clean end → reconnecting (drop-and-resume), never asleep", async () => {
		// Regression (audit #0): a backpressure-killed stream must NOT read as
		// a dormant close. The daemon's wire cannot error (Bun writes the
		// chunked terminator for both close and error), so it marks the drop
		// with a stream_reset frame immediately before EOF; the connector must
		// map that clean end to reconnecting + Last-Event-ID redial.
		const fake = startFake({
			onOpen: (fake, stream) => {
				prime(stream);
				if (fake.openCount === 1) {
					// The daemon dropped the stream for backpressure: reset
					// marker (delta-era seq) then the close.
					stream.write({ type: "stream_reset", reason: "backpressure" }, fake.nextSeq++);
					stream.close();
				}
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "remote" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		// The reset marks a LIVE daemon: redial, never the dormant branch.
		await waitFor(() => (fake.openCount >= 2 ? "redialed" : null), 3000, "redial after reset");
		expect(statuses).toContain("reconnecting");
		expect(statuses).not.toContain("asleep");
		// The redial resumes from the reset frame's seq (drop-and-resume).
		expect(fake.headers[1]?.["last-event-id"]).toBe(String(SSE_DELTA_SEQ_START));
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 2000, "ready after redial");
		await connector.close();
		fake.stop();
	});

	test("unexpected stream end → reconnecting with redial; backoff stays capped", async () => {
		const crash = startCrashServer({ primeHello: true });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: crash.url, token: "tok", mode: "remote" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		// Unbounded exponential backoff would take ~10s to reach 10 dials at
		// min=10ms; reaching 10 here within 5s proves the 50ms cap holds.
		await waitFor(() => (crash.openCount() >= 10 ? "dialed" : null), 5000, "10 redials");
		expect(statuses).toContain("reconnecting");
		const gaps: number[] = [];
		for (let i = 1; i < crash.openTimes.length; i++) gaps.push(crash.openTimes[i] - crash.openTimes[i - 1]);
		expect(Math.max(...gaps)).toBeLessThanOrEqual(120); // 50ms cap × 1.5 jitter + slack
		await connector.close();
		crash.stop();
	});

	test("dial failure (crash before hello) fires onDialFailed and keeps redialing", async () => {
		const crash = startCrashServer();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: crash.url, token: "tok", mode: "spawned" }));
		let dialFailed = 0;
		const connector = makeConnector(registry, { onDialFailed: () => dialFailed++ });
		connector.connect(entry.daemonId);
		await waitFor(() => (crash.openCount() >= 3 ? "dialed" : null), 3000, "3 dials");
		expect(dialFailed).toBeGreaterThanOrEqual(1);
		expect(registry.get(entry.daemonId)?.status).toBe("reconnecting");
		await connector.close();
		crash.stop();
	});

	test("snapshot exposes the live transport state per daemon; never tokens", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		const live = connector.snapshot()[entry.daemonId];
		expect(live).toBeDefined();
		expect(live?.state).toBe("streaming");
		expect(live?.attempts).toBe(0);
		expect(live?.nextRetryInMs).toBeUndefined();
		// The snapshot must never carry the bearer token.
		expect(JSON.stringify(connector.snapshot())).not.toContain("tok");
		await connector.close();
		fake.stop();
	});

	test("snapshot shows the reconnect state and countdown while backing off; onReconnect fires per schedule", async () => {
		const crash = startCrashServer({ primeHello: true });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: crash.url, token: "tok", mode: "remote" }));
		const reconnects: string[] = [];
		// A generous backoff keeps the reconnecting window wide enough to read.
		const connector = new DaemonConnector(
			registry,
			{ onReconnect: (daemonId, attempt, delayMs) => reconnects.push(`${daemonId}:${attempt}:${delayMs}`) },
			{ backoffMinMs: 200, backoffMaxMs: 300 },
		);
		connector.connect(entry.daemonId);
		await waitFor(() => (connector.snapshot()[entry.daemonId]?.state === "reconnecting" ? "reconnecting" : null), 3000, "reconnecting snapshot");
		const snap = connector.snapshot()[entry.daemonId];
		expect(snap?.attempts).toBeGreaterThanOrEqual(1);
		expect(typeof snap?.nextRetryInMs).toBe("number");
		expect(snap?.nextRetryInMs!).toBeLessThanOrEqual(300);
		expect(reconnects.length).toBeGreaterThanOrEqual(1);
		expect(reconnects[0]?.startsWith(`${entry.daemonId}:1:`)).toBe(true);
		await connector.close();
		crash.stop();
	});

	test("401 on /events (wrong token) → terminal error, no reconnect loop", async () => {
		const fake = startFake({ expectedToken: "right" });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "wrong", mode: "spawned" }));
		let dialFailed = 0;
		const connector = makeConnector(registry, { onDialFailed: () => dialFailed++ });
		connector.connect(entry.daemonId);
		await waitFor(() => registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null, 2000, "error");
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("401");
		expect(updated.status).toBe("error");
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		await sleep(150);
		expect(fake.openCount).toBe(1); // auth errors are terminal: no redial churn
		await expect(connector.waitReady(entry.daemonId, 200)).rejects.toThrow(/401/);
		// The respawn path fires once so a fresh token can be issued.
		expect(dialFailed).toBe(1);
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
		const slow = startFake({ onOpen: (_fake, stream) => prime(stream, { ready: false }) });
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

	test("waitReady ignores a stale ready status with no live stream; a fresh dial resolves it", async () => {
		// Regression: waitReady short-circuited on the registry's "ready" even
		// after an idle-drop removed the socket, so promptEntry's send() hit a
		// dead connection ("daemon not connected").
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Idle policy drop: stream gone, registry status stays "ready".
		connector.disconnect(entry.daemonId);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		// The stale status must NOT resolve a new waitReady...
		let resolved = false;
		const pending = connector.waitReady(entry.daemonId, 2000).then(() => {
			resolved = true;
		});
		await sleep(150);
		expect(resolved).toBe(false);
		// ...until a fresh dial's ready frame arrives over a live stream.
		connector.connect(entry.daemonId);
		await pending;
		expect(resolved).toBe(true);
		expect(fake.openCount).toBe(2);
		await connector.close();
		fake.stop();
	});

	test("replayed/stale frames after ready never downgrade (ring replay)", async () => {
		// A reconnect's ring replay can re-deliver frames the connector already
		// acted on (hello_ok, state). The ladder must stay put at ready and the
		// status history must show exactly the canonical rungs.
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const statuses: string[] = [];
		const connector = makeConnector(registry, { onStatus: (e) => statuses.push(e.status) });
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Replayed deltas: a duplicate hello_ok and an older state frame.
		const stream = fake.streams[0]!;
		stream.send(helloFrame());
		stream.send(stateFrame());
		await sleep(100);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		// The ladder must never regress: after the first ready, every
		// subsequent transition is a re-announcement of ready (the replayed
		// hello_ok replays the furthest ladder position), never a downgrade.
		const firstReady = statuses.indexOf("ready");
		expect(statuses.slice(firstReady).every((s) => s === "ready")).toBe(true);
		// Side effects still landed even though the status did not downgrade.
		expect(registry.get(entry.daemonId)?.lastSessionFile).toBe("/srv/proj/sess.jsonl");
		await connector.close();
		fake.stop();
	});

	test("onFrame fans out to multiple listeners; unsubscribe works", async () => {
		const fake = startFake({
			onCommand: (_fake, stream, frame) => {
				if ((frame as { type?: string }).type === "call") {
					stream.send({ type: "event", sessionId: "s1", event: { type: "notice", level: "info", message: "hi" } });
				}
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
		await waitFor(() => (fake.serverCloses >= 1 ? "closed" : null), 2000, "server-observed close");
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

	test("idle-drop arms at ready with no retain: a never-attached daemon's socket drops after idleDropMs", async () => {
		// Regression (audit #1): release() was the ONLY arming site, so a
		// daemon dialed without any retain/release pair (supervisor endpoint
		// resolution, /ctl add/provision) held its control socket open
		// forever, defeating the daemon's own idle auto-exit. The ready
		// transition must arm the timer itself.
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 50 });
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// No retain()/release() pair anywhere in this test.
		await waitFor(() => (fake.serverCloses >= 1 ? "closed" : null), 2000, "server-observed close");
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
		expect(fake.serverCloses).toBe(0); // still retained once
		connector.release(entry.daemonId);
		await waitFor(() => (fake.serverCloses >= 1 ? "closed" : null), 2000, "server-observed close");
		await connector.close();
		fake.stop();
	});

	test("disconnect: no status change, no redial; send() reflects stream state", async () => {
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
		await waitFor(() => (fake.serverCloses >= 1 ? "closed" : null), 2000, "server-observed close");
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

	test("#24 drop() rejects pending waitReady waiters immediately and prunes per-daemon state", async () => {
		// The fake never sends ready, so waitReady stays pending until drop.
		// Pre-fix, removal left the waiter hanging until its timeout: #transition
		// returns early once the registry entry is gone, so nothing flushed it.
		const slow = startFake({ onOpen: (_fake, stream) => prime(stream, { ready: false }) });
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: slow.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "resolving" ? "resolving" : null), 2000, "resolving");
		expect(connector.stateCount()).toBe(1);
		const pending = connector.waitReady(entry.daemonId, 5_000);
		const start = Date.now();
		connector.drop(entry.daemonId);
		registry.remove(entry.daemonId);
		await expect(pending).rejects.toThrow(/removed/);
		// Rejected immediately, not after the 60s waitReady timeout.
		expect(Date.now() - start).toBeLessThan(1_000);
		// The per-daemon state (listeners, waiters, retain count) is gone.
		expect(connector.stateCount()).toBe(0);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		expect(connector.send(entry.daemonId, { type: "call", id: "x", method: "prompt", args: [] })).toBe(false);
		await connector.close();
		slow.stop();
	});

	test("keepalive ping events reset the silence deadline; a responsive daemon stays connected", async () => {
		const fake = startFake({
			onOpen: (_fake, stream) => {
				prime(stream);
				// A keepalive ping event every 20ms — liveness that must keep
				// the stream alive far past the 50ms silence deadline. The ping
				// carries no id and must never be dispatched as a frame.
				const timer = setInterval(() => stream.comment(), 20);
				stream.onEnd = () => clearInterval(timer);
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
			silenceDeadlineMs: 50,
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Several deadlines' worth of comments: the stream must NOT be treated
		// as dead, and no reconnect may be scheduled.
		await sleep(200);
		expect(fake.serverCloses).toBe(0);
		expect(fake.openCount).toBe(1);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		await connector.close();
		fake.stop();
	});

	test("a raw `: ping` comment also resets the silence deadline (parseSseUnits surfaces comments)", async () => {
		const fake = startFake({
			onOpen: (_fake, stream) => {
				prime(stream);
				// Legacy comment keepalive — still surfaced by parseSseUnits and
				// still credited to the silence deadline.
				const timer = setInterval(() => stream.commentLine(), 20);
				stream.onEnd = () => clearInterval(timer);
			},
		});
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
			silenceDeadlineMs: 50,
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		await sleep(200);
		expect(fake.serverCloses).toBe(0);
		expect(fake.openCount).toBe(1);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		await connector.close();
		fake.stop();
	});

	test("a silent stream (no events, no comments) trips the silence deadline and reconnects", async () => {
		const fake = startFake(); // primes, then goes silent
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "remote" }));
		const statuses: string[] = [];
		const connector = new DaemonConnector(
			registry,
			{ onStatus: (e) => statuses.push(e.status) },
			{ backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 60_000, silenceDeadlineMs: 40 },
		);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// After priming nothing arrives: the silence deadline aborts the stream
		// and the reconnect path redials. Each fresh stream primes, then goes
		// silent in turn.
		await waitFor(() => (fake.openCount >= 3 ? "redials" : null), 3000, "3 redials");
		expect(statuses).toContain("reconnecting");
		await connector.close();
		fake.stop();
	});

	test("Last-Event-ID resume: reconnect replays ring deltas after the last seen id", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		const seen: string[] = [];
		const unsub = connector.onFrame(entry.daemonId, (f) => {
			if (f.type === "event") seen.push((f.event as { message?: string }).message ?? "");
		});
		// Two deltas land on stream 1 (and in the daemon-side ring).
		fake.broadcast({ type: "event", sessionId: "s1", event: { type: "notice", level: "info", message: "one" } });
		fake.broadcast({ type: "event", sessionId: "s1", event: { type: "notice", level: "info", message: "two" } });
		await waitFor(() => (seen.includes("one") && seen.includes("two") ? "both" : null), 2000, "both deltas");
		// Clean end → asleep; lastSeq is now 1025.
		fake.streams[0]!.close();
		await waitFor(() => (registry.get(entry.daemonId)?.status === "asleep" ? "asleep" : null), 2000, "asleep");
		// A delta emitted while no stream was open lands only in the ring.
		fake.broadcast({ type: "event", sessionId: "s1", event: { type: "notice", level: "info", message: "three" } });
		// Redial resumes from the last seen id; the server replays ring entries
		// with seqs strictly greater than it, AFTER priming.
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		expect(fake.headers[1]?.["last-event-id"]).toBe("1025");
		expect(fake.replayCounts[1]).toBe(1);
		await waitFor(() => (seen.includes("three") ? "replayed" : null), 2000, "replayed delta");
		unsub();
		await connector.close();
		fake.stop();
	});

	test("a stale resume point (priming only) skips ring replay", async () => {
		const fake = startFake();
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok", mode: "attached" }));
		const connector = makeConnector(registry);
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// The stream only ever carried priming (seqs 1..3 < SSE_DELTA_SEQ_START):
		// no delta ever arrived, so a reconnect must NOT request replay — the
		// fresh priming already carries full current state.
		fake.streams[0]!.close();
		await waitFor(() => (registry.get(entry.daemonId)?.status === "asleep" ? "asleep" : null), 2000, "asleep");
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		expect(fake.headers[1]?.["last-event-id"]).toBeUndefined();
		expect(fake.replayCounts[1]).toBe(0);
		await connector.close();
		fake.stop();
	});
});
