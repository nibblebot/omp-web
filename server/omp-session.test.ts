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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { generateRoomId } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import {
	OMP_PROTO,
	OMP_SESSION_PREFIX,
	SSE_DELTA_SEQ_START,
	type StdoutContractLine,
} from "../shared/protocol";
import { parseSseUnits, SSE_PING_EVENT } from "../shared/sse";

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
 * exempt, so plain tests need none). `ids` runs parallel to `frames` with
 * each frame's SSE id (its seq: priming 1..k, deltas >= SSE_DELTA_SEQ_START)
 * for Last-Event-ID resume assertions.
 */
function openEvents(
	baseUrl: string,
	opts: { headers?: Record<string, string> } = {},
): Promise<{ frames: Frame[]; ids: number[]; pings: number; close: () => void }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		frames: Frame[];
		ids: number[];
		pings: number;
		close: () => void;
	}>();
	const controller = new AbortController();
	const frames: Frame[] = [];
	const ids: number[] = [];
	let pings = 0;
	const url = eventsUrlFor(baseUrl);
	const timer = setTimeout(() => reject(new Error(`events stream open timed out: ${url}`)), 15_000);
	void (async () => {
		try {
			const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
			if (!res.ok || !res.body) throw new Error(`GET /events returned ${res.status}`);
			clearTimeout(timer);
			resolve({
				frames,
				ids,
				get pings() {
					return pings;
				},
				close: () => controller.abort(),
			});
			for await (const unit of parseSseUnits(res.body)) {
				if (unit.kind !== "event") continue;
				// Keepalive pings are not frames (no id, empty-object data);
				// count them separately so the keepalive contract stays observable.
				if (unit.event === SSE_PING_EVENT) {
					pings++;
					continue;
				}
				frames.push(JSON.parse(unit.data) as Frame);
				ids.push(Number(unit.id));
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

/**
 * Like openEvents, but also resolves `ended` with how the stream finished:
 * "eof" (clean end), "aborted" (close()), or "error: …" (body read rejected).
 * Used where the distinction matters (backpressure drop vs dormant close).
 */
function openEventsTracked(
	baseUrl: string,
): Promise<{ frames: Frame[]; ended: Promise<string>; close: () => void }> {
	const { promise, resolve } = Promise.withResolvers<{
		frames: Frame[];
		ended: Promise<string>;
		close: () => void;
	}>();
	const controller = new AbortController();
	const frames: Frame[] = [];
	let settleEnd!: (kind: string) => void;
	const ended = new Promise<string>((r) => (settleEnd = r));
	const url = eventsUrlFor(baseUrl);
	void (async () => {
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok || !res.body) {
				settleEnd(`http-${res.status}`);
				return;
			}
			resolve({ frames, ended, close: () => controller.abort() });
			for await (const unit of parseSseUnits(res.body)) {
				if (unit.kind !== "event") continue;
				if (unit.event === SSE_PING_EVENT) continue;
				frames.push(JSON.parse(unit.data) as Frame);
			}
			settleEnd("eof");
		} catch (err) {
			settleEnd(
				controller.signal.aborted
					? "aborted"
					: `error:${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})();
	return promise;
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
function waitForFrame(
	frames: Frame[],
	type: string,
	timeoutMs: number,
	label: string,
): Promise<Frame> {
	return waitFor(() => frames.find((f) => f.type === type) ?? null, timeoutMs, label);
}

/** Read thinkingLevel out of a wire `state` frame (narrowed via `in`, no unchecked cast). */
function thinkingLevelOf(frame: Frame): string | undefined {
	const st = frame.state;
	if (st && typeof st === "object" && "thinkingLevel" in st)
		return st.thinkingLevel as string | undefined;
	return undefined;
}

function parseContractLine(line: string): StdoutContractLine | null {
	if (!line.startsWith(OMP_SESSION_PREFIX)) return null;
	try {
		return JSON.parse(line.slice(OMP_SESSION_PREFIX.length)) as StdoutContractLine;
	} catch {
		return null;
	}
}

/** Read the server's stdout up to the first newline; resolves with that line. */
async function readFirstStdoutLine(
	stdout: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("timed out waiting for the first stdout line");
		const result = await Promise.race([
			reader.read().then((r) => ({ ...r, timedOut: false as const })),
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
async function spawnSession(
	opts: { args?: string[]; env?: Record<string, string> } = {},
): Promise<SessionProc> {
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

	const line = await readFirstStdoutLine(child.stdout as ReadableStream<Uint8Array>, 45_000).catch(
		(err) => {
			child.kill();
			throw err;
		},
	);
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
	await Promise.all(running.map((p) => p.cleanup()));
});

test("SIGTERM runs the graceful shutdown path (exit 0, not 143)", async () => {
	// Regression: pi-utils' postmortem installs import-time SIGINT/SIGTERM/
	// SIGHUP handlers that exit 130/143/129, preempting omp-session's shutdown().
	const proc = await spawnSession();
	running.push(proc);
	proc.child.kill("SIGTERM");
	const code = await Promise.race([
		proc.child.exited,
		sleep(20_000).then(() => "timeout" as const),
	]);
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

test("127.* with non-numeric parts is not loopback: bind without a token is a startup hard error", async () => {
	// Regression: isLoopbackHost used to accept any 4-part host whose FIRST
	// octet was 127, so "127.a.b.c" (resolving off-loopback) skipped the token
	// gate. It must hit the same hard error as 0.0.0.0 — stderr names the token.
	const tmp = await mkdtemp(path.join(os.tmpdir(), "omp-session-test-"));
	const child = Bun.spawn(["bun", "server/index.ts", "--host", "127.a.b.c", "--cwd", tmp], {
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
		body: JSON.stringify({ type: "call", id: "c-wrong", method: "getSettings", args: [] }),
	});
	expect(wrongCommand.status).toBe(401);

	// Wrong-CASE token → 401 too: the scheme is case-insensitive, the token
	// value is not (regression: the whole header used to be lowercased, so
	// "Bearer SEKRET" slipped past a "sekret" token).
	const caseStream = await fetch(`${base}/events`, { headers: { authorization: "Bearer SEKRET" } });
	expect(caseStream.status).toBe(401);
	const caseCommand = await fetch(`${base}/command`, {
		method: "POST",
		headers: { authorization: "Bearer SEKRET", "content-type": "application/json" },
		body: JSON.stringify({ type: "call", id: "c-case", method: "getSettings", args: [] }),
	});
	expect(caseCommand.status).toBe(401);

	// Lowercase scheme with the exact token still authenticates.
	const lowerScheme = await fetch(`${base}/events`, {
		headers: { authorization: "bearer sekret" },
	});
	expect(lowerScheme.status).toBe(200);
	lowerScheme.body?.cancel();

	// Authorization header → the stream primes hello_ok with the daemon identity.
	const headerStream = await openEvents(base, { headers: { authorization: "Bearer sekret" } });
	const headerHello = await waitForFrame(
		headerStream.frames,
		"hello_ok",
		10_000,
		"header hello_ok",
	);
	expect(headerHello.proto).toBe(OMP_PROTO);
	expect(headerHello.cwd).toBe(tmp);
	expect(headerHello.pid).toBe(child.pid);
	expect(headerHello.name).toBe(path.basename(tmp));
	expect(typeof headerHello.version).toBe("string");
	// …and commands accept with 202 echoing the id.
	const headerCmd = await postCommand(
		base,
		{ type: "call", id: "c-h1", method: "getSettings", args: [] },
		{ headers: { authorization: "Bearer sekret" } },
	);
	expect(headerCmd.status).toBe(202);
	expect((await headerCmd.json()).commandId).toBe("c-h1");

	// ?token= query → same bearer, query form.
	const queryStream = await openEvents(`${base}?token=sekret`);
	const queryHello = await waitForFrame(queryStream.frames, "hello_ok", 10_000, "query hello_ok");
	expect(queryHello.proto).toBe(OMP_PROTO);
	const queryCmd = await postCommand(`${base}?token=sekret`, {
		type: "call",
		id: "c-q1",
		method: "getSettings",
		args: [],
	});
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

/** Open a relay WS to the daemon; resolves once the socket opens, rejects on error/timeout. */
function openRelaySocket(url: string, timeoutMs = 10_000): Promise<WebSocket> {
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`timed out opening ${url}`)), timeoutMs);
	ws.onopen = () => {
		clearTimeout(timer);
		resolve();
	};
	ws.onerror = () => {
		clearTimeout(timer);
		reject(new Error(`websocket failed before open: ${url}`));
	};
	return promise.then(() => ws);
}

test("relay host upgrades are gated like the agent endpoints; guests stay token-free", async () => {
	const lanIp = lanIpv4();
	if (!lanIp) {
		console.warn("no non-loopback IPv4 interface found; skipping relay host-gate test");
		return;
	}
	const proc = await spawnSession({ args: ["--host", "0.0.0.0", "--token", "sekret"] });
	running.push(proc);
	const { port, cleanup } = proc;
	const httpBase = `http://${lanIp}:${port}`;
	const wsBase = `ws://${lanIp}:${port}`;
	const room = generateRoomId();
	const sockets: WebSocket[] = [];

	// Off-loopback host upgrade without a credential → 401 before the
	// upgrade (no close code, no hello window).
	const unauth = await fetch(`${httpBase}/r/${room}?role=host`);
	expect(unauth.status).toBe(401);

	// Off-loopback host with ?token= → the upgrade succeeds.
	const host = await openRelaySocket(`${wsBase}/r/${room}?role=host&token=sekret`);
	sockets.push(host);

	// Guests are deliberately not gated: an off-loopback guest with no token
	// still upgrades (it then gets the ordinary no-room close).
	const guest = await openRelaySocket(`${wsBase}/r/${generateRoomId()}?role=guest`);
	sockets.push(guest);

	// Loopback host without a token stays exempt, same as /events.
	const loopHost = await openRelaySocket(`ws://127.0.0.1:${port}/r/${generateRoomId()}?role=host`);
	sockets.push(loopHost);

	for (const ws of sockets) ws.close();
	await cleanup();
}, 30_000);

test("collab room cap from config refuses the N+1th host room", async () => {
	const proc = await spawnSession({ env: { OMP_SESSION_COLLAB_MAX_ROOMS: "2" } });
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const wsBase = `ws://127.0.0.1:${port}`;

	const a = await openRelaySocket(`${wsBase}/r/${generateRoomId()}?role=host`);
	const b = await openRelaySocket(`${wsBase}/r/${generateRoomId()}?role=host`);

	// A third NEW room is refused with 503 before the upgrade.
	const res = await fetch(`${base}/r/${generateRoomId()}?role=host`);
	expect(res.status).toBe(503);

	a.close();
	b.close();
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
	const bad = await fetch(`http://127.0.0.1:${port}/command`, {
		method: "POST",
		body: "{not json",
	});
	expect(bad.status).toBe(400);
	events.close();
	await cleanup();
}, 30_000);

test("idle auto-exit: --idle-timeout 1s exits the process via shutdown", async () => {
	const proc = await spawnSession({
		args: ["--idle-timeout", "1s"],
		env: { OMP_SESSION_TEST_IDLE_CHECK_MS: "250" },
	});
	running.push(proc);
	expect(proc.port).toBeGreaterThan(0);
	// No streams: the first check past the 1s idle timeout finds it idle and
	// shutdown() exits 0 (250ms check tick via the test env hook, not the 15s default).
	const code = await Promise.race([
		proc.child.exited,
		sleep(10_000).then(() => "timeout" as const),
	]);
	expect(code).toBe(0);
	await proc.cleanup();
}, 30_000);

test("an attached /events stream suppresses idle auto-exit", async () => {
	const proc = await spawnSession({
		args: ["--idle-timeout", "1s"],
		env: { OMP_SESSION_TEST_IDLE_CHECK_MS: "250" },
	});
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
	// The delay must outlast the stream open + prompt + not_ready round-trip
	// (sub-second on any machine), then clear so the test sees the gate open.
	// 2000ms keeps that ordering with margin; 5000 only padded the suite.
	const proc = await spawnSession({ env: { OMP_SESSION_TEST_READY_DELAY_MS: "2000" } });
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	// The open auto-attaches; the priming arrives with the constant guard
	// token (Phase 6: de-muxed — the client hides the sessions sidebar).
	const attached = await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	expect(attached.sessionId).toBe("s1");
	// The gate is still closed: prompt is rejected with not_ready, not a model error.
	const resp = await postCommand(base, {
		type: "call",
		id: "c1",
		method: "prompt",
		args: ["hello"],
	});
	expect(resp.status).toBe(202);
	const notReady = await waitFor(
		() => events.frames.find((f) => f.type === "call_result" && f.id === "c1") ?? null,
		10_000,
		"not_ready call_result",
	);
	expect(notReady.ok).toBe(false);
	expect(notReady.error).toBe("not_ready");
	// The gate clears: ready is broadcast and state snapshots carry readyAt.
	await waitForFrame(events.frames, "ready", 20_000, "ready frame");
	await waitFor(
		() => {
			const frame = events.frames.find((f) => {
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

test("removed mux commands fall through to the unknown-command error; read-only call probes still answer", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	// The attached frame carries the constant guard token.
	const attached = await waitForFrame(events.frames, "attached", 10_000, "attached frame");
	expect(attached.sessionId).toBe("s1");

	// The four removed mux commands (plus attach/detach, which only exist at
	// the fleet edge) fall through to the generic unknown-command error; a
	// benign read-only call probe still answers with call_result.
	await postCommand(base, { type: "create_session", cwd: "/tmp", id: "m1" });
	await postCommand(base, { type: "attach", sessionId: "s1", id: "m2" });
	await postCommand(base, { type: "detach", id: "m3" });
	await postCommand(base, { type: "close_session", sessionId: "s1", id: "m4" });
	await postCommand(base, { type: "list_live_sessions", id: "m5" });
	await postCommand(base, { type: "call", id: "m6", method: "getSettings", args: [] });
	const unknown = await waitFor<Frame[]>(
		() => {
			const errors = events.frames.filter(
				(f) => f.type === "error" && String(f.error).includes("Unknown command:"),
			);
			return errors.length >= 5 ? errors : null;
		},
		10_000,
		"five unknown-command errors",
	);
	for (const type of [
		"create_session",
		"attach",
		"detach",
		"close_session",
		"list_live_sessions",
	]) {
		expect(unknown.some((f) => String(f.error).includes(`"${type}"`))).toBe(true);
	}
	const probe = await waitForFrame(
		events.frames,
		"call_result",
		10_000,
		"call_result for the probe",
	);
	expect(probe.id).toBe("m6");
	expect(probe.ok).toBe(true);

	// live_sessions is never emitted (the frame is gone from the protocol).
	// Real delay: the subprocess is the only authority on what it broadcasts;
	// fake timers cannot drive another process's event loop.
	await sleep(1000);
	expect(events.frames.some((f) => f.type === "live_sessions")).toBe(false);

	// Fleet-edge commands are rejected on a bare omp-session.
	await postCommand(base, { type: "spawn", cwd: "/tmp", id: "m7" });
	await postCommand(base, { type: "list_projects", id: "m8" });
	await waitFor(
		() =>
			events.frames.filter((f) => f.type === "error" && f.error === "fleet-only command").length >=
			2
				? true
				: null,
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
	// happens (a single call_result answer, not two).
	const payload = { type: "call", id: "dup-cmd", method: "getSettings", args: [] };
	const first = await postCommand(base, payload);
	const second = await postCommand(base, payload);
	expect(first.status).toBe(202);
	expect(second.status).toBe(202);
	await waitFor(
		() => events.frames.find((f) => f.type === "call_result" && f.id === "dup-cmd") ?? null,
		10_000,
		"call_result for dup-cmd",
	);
	// Real delay: the dedup window and answer delivery live in the subprocess;
	// only observing real time proves the duplicate was NOT re-dispatched.
	await sleep(1200);
	expect(events.frames.filter((f) => f.type === "call_result" && f.id === "dup-cmd").length).toBe(
		1,
	);
	events.close();
	await cleanup();
}, 30_000);

test("a >4 MiB transcript primes as chunked history; the stream stays attached (no backpressure kill)", async () => {
	// Fixture: a resumed session whose serialized transcript exceeds the 4 MiB
	// SSE backpressure cap (real transcripts cross it via base64 image data
	// URLs inside messages; a huge text payload exercises the same wire size).
	// Pre-fix, the single history frame tripped enqueueTo's cap and terminated
	// the stream right after `attached`, so the session could never attach.
	const bigDir = await mkdtemp(path.join(os.tmpdir(), "omp-session-test-big-"));
	try {
		const chunk = "x".repeat(900 * 1024);
		const fixture = path.join(bigDir, "big.jsonl");
		const entries = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "big",
				timestamp: new Date().toISOString(),
				cwd: bigDir,
			}),
		];
		for (let i = 0; i < 6; i++) {
			entries.push(
				JSON.stringify({
					type: "message",
					id: `m${i}`,
					parentId: i === 0 ? null : `m${i - 1}`,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: `${i}:${chunk}` }] },
				}),
			);
		}
		await writeFile(fixture, entries.join("\n") + "\n");

		const proc = await spawnSession({ args: ["--resume", fixture] });
		running.push(proc);
		const { port, cleanup } = proc;
		const base = `http://127.0.0.1:${port}`;
		const events = await openEvents(base);
		const hello = await waitForFrame(events.frames, "hello_ok", 10_000, "hello_ok");
		expect(hello.proto).toBe(OMP_PROTO);
		expect(events.frames[0].type).toBe("hello_ok");
		await waitForFrame(events.frames, "attached", 10_000, "attached frame");

		// The whole history arrives across multiple chunks, the last tagged
		// final: true. A terminated stream would have delivered nothing after
		// `attached` (the pre-fix behavior), so arrival alone proves survival.
		const historyFrames = await waitFor<Frame[]>(
			() => {
				const hs = events.frames.filter((f) => f.type === "history");
				return hs.length >= 2 && hs.at(-1)?.final === true ? hs : null;
			},
			20_000,
			"chunked history (>= 2 frames ending in final: true)",
		);
		// The fixture is genuinely over the cap, and every chunk is well under
		// it (a pre-fix single frame never fit the stream at all).
		const totalBytes = historyFrames.reduce((n, f) => n + JSON.stringify(f).length, 0);
		expect(totalBytes).toBeGreaterThan(4 * 1024 * 1024);
		for (const h of historyFrames) {
			expect(JSON.stringify(h).length).toBeLessThan(1024 * 1024);
			expect(Array.isArray(h.messages)).toBe(true);
		}
		expect(historyFrames.slice(0, -1).every((h) => h.final === false)).toBe(true);
		expect(historyFrames.at(-1)?.final).toBe(true);

		// Reassembling per the client contract (accumulate non-final chunks,
		// load on final) yields the complete transcript in order.
		const all = historyFrames.flatMap((h) => h.messages as unknown[]);
		expect(all).toHaveLength(6);
		const first = (all[0] as { content?: Array<{ type?: string; text?: unknown }> }).content?.[0];
		expect(first?.type).toBe("text");
		expect(typeof first?.text).toBe("string");
		expect(String(first?.text).startsWith("0:")).toBe(true);
		const last = (all[5] as { content?: Array<{ type?: string; text?: unknown }> }).content?.[0];
		expect(typeof last?.text).toBe("string");
		expect(String(last?.text).startsWith("5:")).toBe(true);

		// Priming continued past history (state follows it, reflecting the
		// resumed transcript), and the stream is STILL attached: a command
		// answer arrives on the same stream, which a terminated
		// (drop-and-resume) stream would never deliver.
		const state = await waitForFrame(events.frames, "state", 10_000, "state");
		expect((state.state as { messageCount?: number }).messageCount).toBe(6);
		expect(events.frames.findIndex((f) => f.type === "state")).toBeGreaterThan(
			events.frames.findIndex((f) => f.type === "history"),
		);
		await postCommand(base, { type: "call", id: "big-liveness", method: "getSettings", args: [] });
		await waitForFrame(events.frames, "call_result", 10_000, "call_result after priming");
		events.close();
		await cleanup();
	} finally {
		await rm(bigDir, { recursive: true, force: true }).catch(() => {});
	}
}, 60_000);

test("small transcripts keep the single-frame history shape (no `final` field)", async () => {
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const events = await openEvents(`http://127.0.0.1:${port}`);
	const history = await waitForFrame(events.frames, "history", 10_000, "history frame");
	expect(history.messages).toEqual([]);
	expect("final" in history).toBe(false);
	events.close();
	await cleanup();
}, 30_000);

test("backpressure drop is in-band: stream_reset precedes the end; the daemon stays alive for resume", async () => {
	// Regression (audit #0): a stream killed for exceeding the SSE
	// backpressure cap must NOT read as a dormant close on the connector.
	// Bun's HTTP layer writes the chunked terminator for both
	// controller.close() and controller.error(), so a wire error cannot carry
	// the distinction — the daemon marks the drop with a stream_reset frame
	// immediately before the end instead. This test overflows the cap with a
	// >4 MiB answer frame (formatSessionAsText serializes the whole resumed
	// transcript as ONE frame) and proves the marker arrives in-band, the
	// end still reads as a clean EOF (what the connector needs the marker
	// for), and the daemon serves a fresh stream right after.
	const bigDir = await mkdtemp(path.join(os.tmpdir(), "omp-session-test-bpres-"));
	try {
		const chunk = "x".repeat(900 * 1024);
		const fixture = path.join(bigDir, "big.jsonl");
		const entries = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "big",
				timestamp: new Date().toISOString(),
				cwd: bigDir,
			}),
		];
		for (let i = 0; i < 6; i++) {
			entries.push(
				JSON.stringify({
					type: "message",
					id: `m${i}`,
					parentId: i === 0 ? null : `m${i - 1}`,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: `${i}:${chunk}` }] },
				}),
			);
		}
		await writeFile(fixture, entries.join("\n") + "\n");

		const proc = await spawnSession({ args: ["--resume", fixture] });
		running.push(proc);
		const { port, cleanup } = proc;
		const base = `http://127.0.0.1:${port}`;
		const events = await openEventsTracked(base);
		await waitForFrame(events.frames, "hello_ok", 10_000, "hello_ok");
		await waitForFrame(events.frames, "attached", 10_000, "attached frame");
		// Priming completes (paced history) before the over-cap answer.
		await waitFor<Frame[]>(
			() => {
				const hs = events.frames.filter((f) => f.type === "history");
				if (hs.length === 0) return null;
				const last = hs.at(-1)!;
				return last.final === true || !("final" in last) ? hs : null;
			},
			20_000,
			"history primed",
		);
		// The answer serializes the whole transcript in one frame — over the
		// 4 MiB cap — tripping enqueueTo's drop-and-resume termination.
		await postCommand(base, { type: "call", id: "bp-1", method: "formatSessionAsText", args: [] });
		const reset = await waitForFrame(events.frames, "stream_reset", 10_000, "stream_reset frame");
		expect(reset.reason).toBe("backpressure");
		// The marker precedes the end: the wire close still reads clean (EOF),
		// which is exactly why the connector needs the in-band marker to tell
		// drop-and-resume apart from a dormant close.
		expect(await events.ended).toBe("eof");
		// The daemon is ALIVE: a fresh stream attaches and answers commands.
		const resumed = await openEvents(base);
		const hello2 = await waitForFrame(resumed.frames, "hello_ok", 10_000, "hello_ok after drop");
		expect(hello2.proto).toBe(OMP_PROTO);
		await postCommand(base, { type: "call", id: "bp-live", method: "getSettings", args: [] });
		await waitForFrame(resumed.frames, "call_result", 10_000, "call_result after resume");
		events.close();
		resumed.close();
		await cleanup();
	} finally {
		await rm(bigDir, { recursive: true, force: true }).catch(() => {});
	}
}, 60_000);

test("resume with a delta-era Last-Event-ID replays no snapshot-era deltas (finding #2)", async () => {
	// The finding: primeConsumer always sent the full priming, and then — for
	// a Last-Event-ID >= SSE_DELTA_SEQ_START — replayed ring.after(last). The
	// replayed window includes deltas whose effects are ALREADY inside the
	// just-primed fresh history/state, so a resume overlapping a completed turn
	// double-applies every message/tool item (duplicated chat items, stranded
	// tool cards). Fix: replay only deltas with seq > max(last, snapshotSeq-1),
	// where snapshotSeq is the delta high-water mark captured BEFORE the
	// priming snapshot is built.
	//
	// This exercises the overlap end-to-end at the SSE level: a ringed delta
	// whose effect the fresh priming provably carries must NOT come back down
	// the re-primed stream. The event-delta variant needs a live model turn
	// (integration tests cannot drive one), so the ringed `state` delta from a
	// settings mutation stands in — it is ringed and snapshot-carried exactly
	// like the message/tool event deltas, so the replay-window math is
	// identical.
	const proc = await spawnSession({});
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	await waitForFrame(events.frames, "ready", 20_000, "ready frame");

	// Deterministic ringed delta: setThinkingLevel broadcasts a state delta
	// (seq >= SSE_DELTA_SEQ_START), and every later prime's state snapshot
	// carries its effect (thinkingLevel "high").
	await postCommand(base, { type: "call", id: "tl1", method: "setThinkingLevel", args: ["high"] });
	const deltaIdx = await waitFor(
		() => {
			const idx = events.ids.findIndex(
				(id, i) =>
					id >= SSE_DELTA_SEQ_START &&
					events.frames[i]?.type === "state" &&
					thinkingLevelOf(events.frames[i]) === "high",
			);
			return idx >= 0 ? idx : null;
		},
		10_000,
		"setThinkingLevel state delta",
	);
	const deltaSeq = events.ids[deltaIdx];
	expect(deltaSeq).toBeGreaterThanOrEqual(SSE_DELTA_SEQ_START);

	// Drop and reconnect with Last-Event-ID INSIDE the delta window (one
	// behind the ringed delta): pre-fix, ring.after(deltaSeq-1) replayed it.
	events.close();
	const resumed = await openEvents(base, { headers: { "last-event-id": String(deltaSeq - 1) } });
	await waitForFrame(resumed.frames, "ready", 10_000, "resumed ready");
	// The overlap, proven: the fresh priming itself carries the delta's effect,
	// so re-delivering the delta would be a redundant double-apply.
	const resumedState = await waitForFrame(resumed.frames, "state", 10_000, "resumed state");
	expect(thinkingLevelOf(resumedState)).toBe("high");
	// The re-primed stream must contain no delta-era frame: the snapshot-era
	// delta was not replayed and the idle daemon emitted no new deltas during
	// the prime. The replay (pre-fix) is enqueued synchronously right after
	// the last priming frame, so a short real wait observes the subprocess's
	// delivery — fake timers cannot drive another process (same convention as
	// the POST-dedup and removed-mux tests above).
	await sleep(1500);
	expect(resumed.ids.every((id) => id < SSE_DELTA_SEQ_START)).toBe(true);
	resumed.close();
	await cleanup();
}, 30_000);

test("a settled ui_request is never a stale dialog: resumers see end-after-request or nothing (finding #16)", async () => {
	// The finding: ui_request is a ringed delta, but the ring copy was never
	// invalidated when the request settled — a client whose snapshot predates
	// the request would replay a stale dialog whose ui_response silently
	// no-ops. Fix: broadcast a ringed ui_request_end when the request settles,
	// so every live tab dismisses and a replay delivers request → end.
	// The web dialog path is only reached through SDK tool turns, so the
	// OMP_SESSION_TEST_UI_REQUEST test hook creates one deterministically.
	const proc = await spawnSession({ env: { OMP_SESSION_TEST_UI_REQUEST: "1" } });
	running.push(proc);
	const { port, cleanup } = proc;
	const base = `http://127.0.0.1:${port}`;
	const events = await openEvents(base);
	await waitForFrame(events.frames, "ready", 20_000, "ready frame");
	events.close();

	// The resumer opens fresh; once its FIRST frame lands its delta snapshot
	// is captured (primeConsumer's first statement) and the paced prime is in
	// flight. A request broadcast now has seq >= the snapshot mark, so the
	// resumer receives it either live (post-prime) or via the ring replay —
	// and pre-fix would receive it WITHOUT any end.
	const resumed = await openEvents(base);
	await waitFor(
		() => (resumed.frames.length > 0 ? resumed.frames[0] : null),
		10_000,
		"resumer first frame",
	);
	await postCommand(base, { type: "test_ui_request", id: "tui0" });
	const request = await waitForFrame(resumed.frames, "ui_request", 10_000, "ui_request on resumer");
	expect(typeof (request as { id?: unknown }).id).toBe("string");
	const requestId = (request as { id?: unknown }).id as string;

	// Answer it: the pending settles and a ringed ui_request_end broadcasts.
	await postCommand(base, { type: "ui_response", id: requestId, result: true });
	const ended = await waitForFrame(
		resumed.frames,
		"ui_request_end",
		10_000,
		"ui_request_end on resumer",
	);
	expect((ended as { id?: unknown }).id).toBe(requestId);
	// The end follows the request: the dialog is dismissed, never left hanging.
	expect(resumed.frames.indexOf(ended)).toBeGreaterThan(resumed.frames.indexOf(request));

	// A FRESH prime never shows the settled dialog at all ("does not
	// reappear"): priming re-derives current state and the snapshot mark
	// bounds replay, so neither frame comes back down a new stream.
	resumed.close();
	const later = await openEvents(base);
	await waitForFrame(later.frames, "ready", 10_000, "later ready");
	expect(later.frames.some((f) => f.type === "ui_request" || f.type === "ui_request_end")).toBe(
		false,
	);
	later.close();
	await cleanup();
}, 30_000);
