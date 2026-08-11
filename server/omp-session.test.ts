/**
 * omp-session Phase 1 server tests: config surface, stdout contract line, bearer
 * auth (R14), readiness gate (R8), idle auto-exit (R11), and (Phase 6) the
 * removed-mux-command fallthrough. Spawns server/index.ts as a subprocess on
 * an ephemeral port (OMP_SESSION_PORT=0) with a hermetic tmp cwd; connects over
 * loopback and (for the token-gate test) the machine's LAN IP. No external
 * network, no real model calls — the readiness gate is deferred via the
 * OMP_SESSION_TEST_READY_DELAY_MS test hook instead of racing provider discovery.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { OMP_CLOSE_UNAUTHORIZED, OMP_PROTO, type StdoutContractLine } from "../src/protocol";

const repoRoot = path.resolve(import.meta.dir, "..");

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll `probe` on a 50ms interval until it returns non-null; throw on timeout. */
async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(50);
	}
}

type Frame = { type: string; [key: string]: unknown };

/** Collect every frame the socket receives into a shared array (poll with waitFor). */
function collect(ws: WebSocket): Frame[] {
	const frames: Frame[] = [];
	ws.onmessage = ev => frames.push(JSON.parse(String(ev.data)) as Frame);
	return frames;
}

function openWebSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	// The DOM lib's WebSocket type only allows protocols as the second arg;
	// Bun's runtime accepts { headers } (Bun.WebSocketOptions).
	const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
	const timer = setTimeout(() => reject(new Error(`websocket open timed out: ${url}`)), 15_000);
	ws.onopen = () => {
		clearTimeout(timer);
		resolve(ws);
	};
	ws.onerror = () => {
		clearTimeout(timer);
		reject(new Error(`websocket failed: ${url}`));
	};
	return promise;
}

function onClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; reason: string }>();
	ws.onclose = ev => resolve({ code: ev.code, reason: ev.reason });
	return promise;
}

function parseContractLine(line: string): StdoutContractLine | null {
	if (!line.startsWith("OMP_SESSION|")) return null;
	try {
		return JSON.parse(line.slice("OMP_SESSION|".length)) as StdoutContractLine;
	} catch {
		return null;
	}
}

/** Read the server's stdout up to the first newline; resolves with that line. */
async function readFirstStdoutLine(stdout: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("timed out waiting for the first stdout line");
		const result = await Promise.race([
			reader.read().then(r => ({ ...r, timedOut: false as const })),
			sleep(remaining).then(() => ({ value: undefined, done: true, timedOut: true as const })),
		]);
		if (result.timedOut) throw new Error("timed out waiting for the first stdout line");
		if (result.done) throw new Error("server exited before printing the OMP_SESSION| line");
		buffer += decoder.decode(result.value, { stream: true });
		const nl = buffer.indexOf("\n");
		if (nl >= 0) return buffer.slice(0, nl);
	}
}

interface SessionProc {
	child: Subprocess<"ignore", "pipe", "pipe">;
	tmp: string;
	port: number;
	/** The first stdout line (the OMP_SESSION| listening line). */
	firstLine: string;
	stderrTail: () => string;
	cleanup: () => Promise<void>;
}

/** Spawn server/index.ts on an ephemeral port with a hermetic tmp cwd. */
async function spawnSession(opts: { args?: string[]; env?: Record<string, string> } = {}): Promise<SessionProc> {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "omp-session-test-"));
	const child = Bun.spawn(["bun", "server/index.ts", ...(opts.args ?? [])], {
		cwd: repoRoot,
		env: {
			...process.env,
			OMP_SESSION_PORT: "0",
			OMP_SESSION_CWD: tmp,
			PI_NO_TITLE: "1",
			...opts.env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	// Drain stderr so the pipe never backpressures; keep the tail for diagnostics.
	let stderrTail = "";
	const stderrReader = child.stderr.getReader();
	const stderrDecoder = new TextDecoder();
	const pumpStderr = async (): Promise<void> => {
		const result = await stderrReader.read();
		if (result.done) return;
		stderrTail = (stderrTail + stderrDecoder.decode(result.value)).slice(-8000);
		return pumpStderr();
	};
	void pumpStderr().catch(() => {});

	const line = await readFirstStdoutLine(child.stdout as ReadableStream<Uint8Array>, 45_000).catch(err => {
		child.kill();
		throw err;
	});
	const parsed = parseContractLine(line);
	if (!parsed || parsed.event !== "listening") {
		child.kill();
		throw new Error(`unexpected first stdout line: ${line}`);
	}
	const cleanup = async (): Promise<void> => {
		if (child.exitCode === null) {
			child.kill(); // SIGTERM → the server's graceful shutdown handler runs.
			await Promise.race([child.exited, sleep(15_000)]);
		}
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	};
	return { child, tmp, port: parsed.port, firstLine: line, stderrTail: () => stderrTail, cleanup };
}

/** Send a hello and wait for the hello_ok answer (R14). */
async function expectHelloOk(ws: WebSocket, token?: string): Promise<Frame> {
	const frames = collect(ws);
	ws.send(JSON.stringify({ type: "hello", proto: OMP_PROTO, ...(token !== undefined ? { token } : {}) }));
	return waitFor(() => frames.find(f => f.type === "hello_ok") ?? null, 10_000, "hello_ok");
}

/** First non-internal IPv4 address (the machine's LAN IP); undefined when none exists. */
function lanIpv4(): string | undefined {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === "IPv4" && !addr.internal) return addr.address;
		}
	}
	return undefined;
}

const running: SessionProc[] = [];

afterAll(async () => {
	await Promise.all(running.map(p => p.cleanup()));
});

test("SIGTERM runs the graceful shutdown path (exit 0, not 143)", async () => {
	// Regression: pi-utils' postmortem installs import-time SIGINT/SIGTERM/
	// SIGHUP handlers that exit 130/143/129, preempting omp-session's shutdown().
	const proc = await spawnSession();
	running.push(proc);
	proc.child.kill("SIGTERM");
	const code = await Promise.race([proc.child.exited, sleep(20_000).then(() => "timeout" as const)]);
	expect(code).toBe(0);
}, 60_000);

test("off-loopback bind without a token is a startup hard error", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "omp-session-test-"));
	const child = Bun.spawn(["bun", "server/index.ts", "--host", "0.0.0.0", "--cwd", tmp], {
		cwd: repoRoot,
		env: { ...process.env, OMP_SESSION_PORT: "0", PI_NO_TITLE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await Promise.race([child.exited, sleep(15_000).then(() => "timeout" as const)]);
	expect(code).not.toBe(0);
	const err = await new Response(child.stderr).text();
	expect(err).toContain("token");
	await rm(tmp, { recursive: true, force: true }).catch(() => {});
}, 30_000);

test("token gate: off-loopback peers need the token; loopback stays exempt", async () => {
	const lanIp = lanIpv4();
	if (!lanIp) {
		console.warn("no non-loopback IPv4 interface found; skipping token-gate test");
		return;
	}
	const proc = await spawnSession({ args: ["--host", "0.0.0.0", "--token", "sekret"] });
	running.push(proc);
	const { child, tmp, port, cleanup } = proc;
	const base = `ws://${lanIp}:${port}/ws`;

	// No credential: the socket upgrades unauthenticated and is closed 4001 when
	// the 5s hello window expires.
	const noToken = await openWebSocket(base);
	const closeInfo = await Promise.race([onClose(noToken), sleep(10_000).then(() => "timeout" as const)]);
	expect(closeInfo).not.toBe("timeout");
	expect((closeInfo as { code: number }).code).toBe(OMP_CLOSE_UNAUTHORIZED);

	// Authorization header → authenticated; a valid hello is answered hello_ok.
	const withHeader = await openWebSocket(base, { authorization: "Bearer sekret" });
	const headerHello = await expectHelloOk(withHeader, "sekret");
	expect(headerHello.proto).toBe(OMP_PROTO);
	expect(headerHello.cwd).toBe(tmp);
	expect(headerHello.pid).toBe(child.pid);
	expect(headerHello.name).toBe(path.basename(tmp));
	expect(typeof headerHello.version).toBe("string");

	// ?token= query → authenticated (same bearer, query form).
	const withQuery = await openWebSocket(`${base}?token=sekret`);
	const queryHello = await expectHelloOk(withQuery, "sekret");
	expect(queryHello.proto).toBe(OMP_PROTO);

	// Loopback without a token still works: the priming (attached) arrives.
	const loopback = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
	const lbFrames = collect(loopback);
	await waitFor(() => lbFrames.find(f => f.type === "attached") ?? null, 10_000, "loopback attached frame");

	// Static serving is gated for off-loopback peers too (Authorization or ?token=).
	const unauth = await fetch(`http://${lanIp}:${port}/`);
	expect(unauth.status).toBe(401);
	const authed = await fetch(`http://${lanIp}:${port}/?token=sekret`);
	expect(authed.status).toBe(200);

	for (const ws of [withHeader, withQuery, loopback]) ws.close();
	await cleanup();
}, 60_000);

test("OMP_SESSION| listening line is the first stdout line and parses as StdoutContractLine", async () => {
	const proc = await spawnSession({ args: ["--advertise", "myhost:9999"] });
	running.push(proc);
	const parsed = parseContractLine(proc.firstLine);
	if (!parsed) throw new Error(`first stdout line is not an OMP_SESSION| line: ${proc.firstLine}`);
	if (parsed.event !== "listening") throw new Error(`expected listening line, got ${parsed.event}`);
	expect(parsed.bind).toBe("127.0.0.1");
	expect(parsed.port).toBe(proc.port);
	expect(parsed.url).toBe(`ws://127.0.0.1:${proc.port}`);
	expect(parsed.advertise).toBe("myhost:9999");
	await proc.cleanup();
}, 30_000);

test("loopback hello is answered hello_ok with the daemon identity", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { child, tmp, port, cleanup } = proc;
	const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
	const hello = await expectHelloOk(ws);
	expect(hello.proto).toBe(OMP_PROTO);
	expect(hello.cwd).toBe(tmp);
	expect(hello.pid).toBe(child.pid);
	expect(hello.name).toBe(path.basename(tmp));
	expect(typeof hello.version).toBe("string");
	ws.close();
	await cleanup();
}, 30_000);

test("idle auto-exit: --idle-timeout 3s exits the process via shutdown", async () => {
	const proc = await spawnSession({ args: ["--idle-timeout", "3s"] });
	running.push(proc);
	expect(proc.port).toBeGreaterThan(0);
	// No sockets: the first 15s check finds it idle and shutdown() exits 0.
	const code = await Promise.race([proc.child.exited, sleep(30_000).then(() => "timeout" as const)]);
	expect(code).toBe(0);
	await proc.cleanup();
}, 45_000);

test("an attached web socket suppresses idle auto-exit", async () => {
	const proc = await spawnSession({ args: ["--idle-timeout", "3s"] });
	running.push(proc);
	const { child, port, cleanup } = proc;
	const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = collect(ws);
	await waitFor(() => frames.find(f => f.type === "attached") ?? null, 10_000, "attached frame");
	// Span at least one 15s idle-check tick with the socket attached.
	await sleep(17_000);
	expect(child.exitCode).toBeNull();
	ws.close();
	const code = await Promise.race([child.exited, sleep(30_000).then(() => "timeout" as const)]);
	expect(code).toBe(0);
	await cleanup();
}, 60_000);

test("prompt-family calls fail with not_ready until the readiness gate clears", async () => {
	const proc = await spawnSession({ env: { OMP_SESSION_TEST_READY_DELAY_MS: "5000" } });
	running.push(proc);
	const { port, cleanup } = proc;
	const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = collect(ws);
	// The open auto-attaches; the priming arrives with mode "single" (Phase 6:
	// de-muxed — the client hides the sessions sidebar) and the guard token.
	const attached = await waitFor(() => frames.find(f => f.type === "attached") ?? null, 10_000, "attached frame");
	expect(attached.mode).toBe("single");
	expect(attached.sessionId).toBe("s1");
	// The gate is still closed: prompt is rejected with not_ready, not a model error.
	ws.send(JSON.stringify({ type: "call", id: "c1", method: "prompt", args: ["hello"] }));
	const notReady = await waitFor(
		() => frames.find(f => f.type === "call_result" && f.id === "c1") ?? null,
		10_000,
		"not_ready call_result",
	);
	expect(notReady.ok).toBe(false);
	expect(notReady.error).toBe("not_ready");
	// The gate clears: ready is broadcast and state snapshots carry readyAt.
	await waitFor(() => frames.find(f => f.type === "ready") ?? null, 20_000, "ready frame");
	await waitFor(
		() => frames.find(f => f.type === "state" && (f.state as { readyAt?: number })?.readyAt !== undefined) ?? null,
		10_000,
		"state with readyAt",
	);
	ws.close();
	await cleanup();
}, 45_000);

test("removed mux commands fall through to the unknown-command error; process stats stay", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = collect(ws);
	// The attached frame says "single" with the constant guard token.
	const attached = await waitFor(() => frames.find(f => f.type === "attached") ?? null, 10_000, "attached frame");
	expect(attached.mode).toBe("single");
	expect(attached.sessionId).toBe("s1");

	// The four removed mux commands (plus attach/detach, which only exist at
	// the fleet edge) fall through to the generic unknown-command error;
	// get_process_stats is kept.
	ws.send(JSON.stringify({ type: "create_session", cwd: "/tmp" }));
	ws.send(JSON.stringify({ type: "attach", sessionId: "s1" }));
	ws.send(JSON.stringify({ type: "detach" }));
	ws.send(JSON.stringify({ type: "close_session", sessionId: "s1" }));
	ws.send(JSON.stringify({ type: "list_live_sessions" }));
	ws.send(JSON.stringify({ type: "get_process_stats" }));
	const unknown = await waitFor<Frame[]>(
		() => {
			const errors = frames.filter(f => f.type === "error" && String(f.error).includes("Unknown command:"));
			return errors.length >= 5 ? errors : null;
		},
		10_000,
		"five unknown-command errors",
	);
	for (const type of ["create_session", "attach", "detach", "close_session", "list_live_sessions"]) {
		expect(unknown.some(f => String(f.error).includes(`"${type}"`))).toBe(true);
	}
	const stats = await waitFor(() => frames.find(f => f.type === "process_stats") ?? null, 10_000, "process_stats");
	expect(typeof (stats.process as { uptimeSec?: unknown }).uptimeSec).toBe("number");
	expect((stats.process as { sessionCount?: unknown }).sessionCount).toBe(1);

	// live_sessions is never emitted (the frame is gone from the protocol).
	await sleep(1000);
	expect(frames.some(f => f.type === "live_sessions")).toBe(false);

	// Fleet-edge commands are rejected on a bare omp-session.
	ws.send(JSON.stringify({ type: "spawn", cwd: "/tmp" }));
	ws.send(JSON.stringify({ type: "list_projects" }));
	await waitFor(
		() => (frames.filter(f => f.type === "error" && f.error === "fleet-only command").length >= 2 ? true : null),
		10_000,
		"fleet-only errors",
	);
	ws.close();
	await cleanup();
}, 45_000);
