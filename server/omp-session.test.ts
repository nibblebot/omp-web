/**
 * omp-session Phase 1 server tests: config surface, stdout contract line, bearer
 * auth (R14), readiness gate (R8), idle auto-exit (R11), POST idempotency, and
 * the removed-mux-command fallthrough. Spawns server/index.ts as a subprocess on
 * an ephemeral port (OMP_SESSION_PORT=0) with a hermetic tmp cwd; connects over
 * loopback and (for the token-gate test) the machine's LAN IP using the
 * OMP_PROTO 2 transport (GET /events SSE down, POST /command up). No external
 * network, no real model calls — the readiness gate is deferred via the
 * OMP_SESSION_TEST_READY_DELAY_MS test hook instead of racing provider discovery.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { OMP_PROTO, type StdoutContractLine } from "../src/protocol";
import { parseSseUnits, SSE_PING_EVENT } from "../src/sse";

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

/** The daemon's /events URL for an origin (optionally carrying ?token=). */
function eventsUrlFor(baseUrl: string): string {
	const [origin, query] = baseUrl.split("?");
	return query === undefined ? `${origin}/events` : `${origin}/events?${query}`;
}

/**
 * Open a daemon /events SSE stream; resolves once the stream is established.
 * Frames accumulate on `frames` (poll with waitFor); `close()` aborts the
 * stream. Auth goes through an optional Authorization header (loopback is
 * exempt, so plain tests need none).
 */
function openEvents(
	baseUrl: string,
	opts: { headers?: Record<string, string> } = {},
): Promise<{ frames: Frame[]; pings: number; close: () => void }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ frames: Frame[]; pings: number; close: () => void }>();
	const controller = new AbortController();
	const frames: Frame[] = [];
	let pings = 0;
	const url = eventsUrlFor(baseUrl);
	const timer = setTimeout(() => reject(new Error(`events stream open timed out: ${url}`)), 15_000);
	void (async () => {
		try {
			const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
			if (!res.ok || !res.body) throw new Error(`GET /events returned ${res.status}`);
			clearTimeout(timer);
			resolve({ frames, get pings() { return pings; }, close: () => controller.abort() });
			for await (const unit of parseSseUnits(res.body)) {
				if (unit.kind !== "event") continue;
				// Keepalive pings are not frames (no id, empty-object data);
				// count them separately so the keepalive contract stays observable.
				if (unit.event === SSE_PING_EVENT) {
					pings++;
					continue;
				}
				frames.push(JSON.parse(unit.data) as Frame);
			}
		} catch (err) {
			if (controller.signal.aborted) return; // close() — expected teardown
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	})();
	return promise;
}

/** The daemon's /command URL for an origin (optionally carrying ?token=). */
function commandUrlFor(baseUrl: string): string {
	const [origin, query] = baseUrl.split("?");
	return query === undefined ? `${origin}/command` : `${origin}/command?${query}`;
}

/** POST one ClientCommand (JSON body); every command carries an id. */
function postCommand(
	baseUrl: string,
	cmd: Record<string, unknown>,
	opts: { headers?: Record<string, string> } = {},
): Promise<Response> {
	return fetch(commandUrlFor(baseUrl), {
		method: "POST",
		headers: { "content-type": "application/json", ...opts.headers },
		body: JSON.stringify(cmd),
	});
}

/** The first frame of a given type, waiting for it to arrive. */
function waitForFrame(frames: Frame[], type: string, timeoutMs: number, label: string): Promise<Frame> {
	return waitFor(() => frames.find(f => f.type === type) ?? null, timeoutMs, label);
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
}, 30_000);

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
	const base = `http://${lanIp}:${port}`;

	// Wrong credential → 401 on both endpoints (no hello window, no close codes).
	const wrongStream = await fetch(`${base}/events`, { headers: { authorization: "Bearer nope" } });
	expect(wrongStream.status).toBe(401);
	const wrongCommand = await fetch(`${base}/command`, {
		method: "POST",
		headers: { authorization: "Bearer nope", "content-type": "application/json" },
		body: JSON.stringify({ type: "get_process_stats", id: "c-wrong" }),
	});
	expect(wrongCommand.status).toBe(401);

	// Authorization header → the stream primes hello_ok with the daemon identity.
	const headerStream = await openEvents(base, { headers: { authorization: "Bearer sekret" } });
	const headerHello = await waitForFrame(headerStream.frames, "hello_ok", 10_000, "header hello_ok");
	expect(headerHello.proto).toBe(OMP_PROTO);
	expect(headerHello.cwd).toBe(tmp);
	expect(headerHello.pid).toBe(child.pid);
	expect(headerHello.name).toBe(path.basename(tmp));
	expect(typeof headerHello.version).toBe("string");
	// …and commands accept with 202 echoing the id.
	const headerCmd = await postCommand(base, { type: "get_process_stats", id: "c-h1" }, { headers: { authorization: "Bearer sekret" } });
	expect(headerCmd.status).toBe(202);
	expect((await headerCmd.json()).commandId).toBe("c-h1");

	// ?token= query → same bearer, query form.
	const queryStream = await openEvents(`${base}?token=sekret`);
	const queryHello = await waitForFrame(queryStream.frames, "hello_ok", 10_000, "query hello_ok");
	expect(queryHello.proto).toBe(OMP_PROTO);
	const queryCmd = await postCommand(`${base}?token=sekret`, { type: "get_process_stats", id: "c-q1" });
	expect(queryCmd.status).toBe(202);

	// Loopback without a token still works: the priming (attached) arrives.
	const loopback = await openEvents(`http://127.0.0.1:${port}`);
	await waitForFrame(loopback.frames, "attached", 10_000, "loopback attached frame");

	// Static serving is gated for off-loopback peers too (Authorization or ?token=).
	const unauth = await fetch(`${base}/`);
	expect(unauth.status).toBe(401);
	const authed = await fetch(`${base}/?token=sekret`);
	expect(authed.status).toBe(200);

	headerStream.close();
	queryStream.close();
	loopback.close();
	await cleanup();
}, 30_000);

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

test("loopback /events opens with hello_ok as the FIRST event, carrying the daemon identity", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { child, tmp, port, cleanup } = proc;
	const events = await openEvents(`http://127.0.0.1:${port}`);
	const hello = await waitForFrame(events.frames, "hello_ok", 10_000, "hello_ok");
	expect(hello.proto).toBe(OMP_PROTO);
	expect(hello.cwd).toBe(tmp);
	expect(hello.pid).toBe(child.pid);
	expect(hello.name).toBe(path.basename(tmp));
	expect(typeof hello.version).toBe("string");
	// hello_ok precedes the attach priming on every stream open.
	expect(events.frames[0].type).toBe("hello_ok");
	const attached = await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	expect(attached.sessionId).toBe("s1");

	// Malformed command bodies are rejected with 400.
	const bad = await fetch(`http://127.0.0.1:${port}/command`, { method: "POST", body: "{not json" });
	expect(bad.status).toBe(400);
	events.close();
	await cleanup();
}, 30_000);

test("idle auto-exit: --idle-timeout 1s exits the process via shutdown", async () => {
	const proc = await spawnSession({ args: ["--idle-timeout", "1s"], env: { OMP_SESSION_TEST_IDLE_CHECK_MS: "250" } });
	running.push(proc);
	expect(proc.port).toBeGreaterThan(0);
	// No streams: the first check past the 1s idle timeout finds it idle and
	// shutdown() exits 0 (250ms check tick via the test env hook, not the 15s default).
	const code = await Promise.race([proc.child.exited, sleep(10_000).then(() => "timeout" as const)]);
	expect(code).toBe(0);
	await proc.cleanup();
}, 30_000);

test("an attached /events stream suppresses idle auto-exit", async () => {
	const proc = await spawnSession({ args: ["--idle-timeout", "1s"], env: { OMP_SESSION_TEST_IDLE_CHECK_MS: "250" } });
	running.push(proc);
	const { child, port, cleanup } = proc;
	const events = await openEvents(`http://127.0.0.1:${port}`);
	await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	// Span several 250ms idle-check ticks (the env hook) with the stream
	// attached: an attached stream suppresses idle, so the process must stay
	// alive past ticks that would otherwise exit it (1s idle timeout).
	await sleep(1500);
	expect(child.exitCode).toBeNull();
	events.close();
	// The stream closed → nothing suppresses idle: the next tick (≤250ms)
	// finds it idle and shutdown() exits 0.
	const code = await Promise.race([child.exited, sleep(10_000).then(() => "timeout" as const)]);
	expect(code).toBe(0);
	await cleanup();
}, 30_000);

test("prompt-family calls fail with not_ready until the readiness gate clears", async () => {
	const proc = await spawnSession({ env: { OMP_SESSION_TEST_READY_DELAY_MS: "5000" } });
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	// The open auto-attaches; the priming arrives with mode "single" (Phase 6:
	// de-muxed — the client hides the sessions sidebar) and the guard token.
	const attached = await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	expect(attached.mode).toBe("single");
	expect(attached.sessionId).toBe("s1");
	// The gate is still closed: prompt is rejected with not_ready, not a model error.
	const resp = await postCommand(base, { type: "call", id: "c1", method: "prompt", args: ["hello"] });
	expect(resp.status).toBe(202);
	const notReady = await waitFor(
		() => events.frames.find(f => f.type === "call_result" && f.id === "c1") ?? null,
		10_000,
		"not_ready call_result",
	);
	expect(notReady.ok).toBe(false);
	expect(notReady.error).toBe("not_ready");
	// The gate clears: ready is broadcast and state snapshots carry readyAt.
	await waitForFrame(events.frames, "ready", 20_000, "ready frame");
	await waitFor(
		() => {
			const frame = events.frames.find(f => {
				if (f.type !== "state") return false;
				const st = f.state;
				return typeof st === "object" && st !== null && "readyAt" in st && st.readyAt !== undefined;
			});
			return frame ?? null;
		},
		10_000,
		"state with readyAt",
	);
	events.close();
	await cleanup();
}, 30_000);

test("removed mux commands fall through to the unknown-command error; process stats stay", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	// The attached frame says "single" with the constant guard token.
	const attached = await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	expect(attached.mode).toBe("single");
	expect(attached.sessionId).toBe("s1");

	// The four removed mux commands (plus attach/detach, which only exist at
	// the fleet edge) fall through to the generic unknown-command error;
	// get_process_stats is kept.
	await postCommand(base, { type: "create_session", cwd: "/tmp", id: "m1" });
	await postCommand(base, { type: "attach", sessionId: "s1", id: "m2" });
	await postCommand(base, { type: "detach", id: "m3" });
	await postCommand(base, { type: "close_session", sessionId: "s1", id: "m4" });
	await postCommand(base, { type: "list_live_sessions", id: "m5" });
	await postCommand(base, { type: "get_process_stats", id: "m6" });
	const unknown = await waitFor<Frame[]>(
		() => {
			const errors = events.frames.filter(f => f.type === "error" && String(f.error).includes("Unknown command:"));
			return errors.length >= 5 ? errors : null;
		},
		10_000,
		"five unknown-command errors",
	);
	for (const type of ["create_session", "attach", "detach", "close_session", "list_live_sessions"]) {
		expect(unknown.some(f => String(f.error).includes(`"${type}"`))).toBe(true);
	}
	const stats = await waitForFrame(events.frames, "process_stats", 10_000, "process_stats");
	const processField = stats.process;
	if (typeof processField !== "object" || processField === null || !("uptimeSec" in processField) || !("sessionCount" in processField)) {
		throw new Error("process_stats missing uptimeSec/sessionCount");
	}
	expect(typeof processField.uptimeSec).toBe("number");
	expect(processField.sessionCount).toBe(1);

	// live_sessions is never emitted (the frame is gone from the protocol).
	// Real delay: the subprocess is the only authority on what it broadcasts;
	// fake timers cannot drive another process's event loop.
	await sleep(1000);
	expect(events.frames.some(f => f.type === "live_sessions")).toBe(false);

	// Fleet-edge commands are rejected on a bare omp-session.
	await postCommand(base, { type: "spawn", cwd: "/tmp", id: "m7" });
	await postCommand(base, { type: "list_projects", id: "m8" });
	await waitFor(
		() => (events.frames.filter(f => f.type === "error" && f.error === "fleet-only command").length >= 2 ? true : null),
		10_000,
		"fleet-only errors",
	);
	events.close();
	await cleanup();
}, 30_000);

test("POST /command dedups by id within the window", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	// The same command id posted twice: both accept 202, but only ONE dispatch
	// happens (a single process_stats answer, not two).
	const payload = { type: "get_process_stats", id: "dup-cmd" };
	const first = await postCommand(base, payload);
	const second = await postCommand(base, payload);
	expect(first.status).toBe(202);
	expect(second.status).toBe(202);
	await waitForFrame(events.frames, "process_stats", 10_000, "process_stats");
	// Real delay: the dedup window and answer delivery live in the subprocess;
	// only observing real time proves the duplicate was NOT re-dispatched.
	await sleep(1200);
	expect(events.frames.filter(f => f.type === "process_stats").length).toBe(1);
	events.close();
	await cleanup();
}, 30_000);
