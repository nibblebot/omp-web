/**
 * Session daemon lifecycle against a fake control plane. The daemon dials OUT
 * to the fake fleet over the callback pair; the fake never dials the daemon.
 *
 * Grace periods, idle timeouts, and quiet-time checks are process-level
 * behavior measured against the platform clock in a real subprocess, so those
 * waits are real time by design. Everything else awaits an observed event.
 */
import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_DOWN_PATH,
	CALLBACK_ERROR_HTTP_STATUS,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	type CallbackEnvelope,
	type CallbackKind,
	encodeSseEnvelope,
} from "#lib/wire/callback-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const WORKSPACE = "ws-control-plane";
const GENERATION = 1;
const TOKEN = "ab".repeat(32);

interface FakeFleet {
	url: string;
	/** Resolves when the daemon opens its down stream. */
	paired: Promise<void>;
	/** Envelopes the daemon uploaded on /callback/up, in arrival order. */
	up: CallbackEnvelope[];
	/** Resolves once `count` uploaded envelopes satisfy `match`. */
	waitForUp(match: (envelope: CallbackEnvelope) => boolean, count: number): Promise<void>;
	/** Sends one down envelope on the current pair. */
	send(streamId: string, kind: CallbackKind, payload: unknown): void;
	/** Requests the fake has answered (a refused pair dials again after its backoff). */
	readonly counters: { requests: number };
	stop(): void;
	/** Ends the current down stream (network loss); the daemon redials and a new pair forms. */
	dropPair(): void;
}

/** A refusal every request is answered with, standing in for the real fleet's error bodies. */
interface FakeRefusal {
	status: number;
	/** JSON-serialized when `json`, raw text otherwise. */
	body: unknown;
	json: boolean;
}

/**
 * The fleet's refusal shapes (callback-protocol error codes). The session treats
 * only `unauthorized` and `generation_obsolete` as terminal; every other code,
 * typed or inferred from the status, is retryable.
 */
const REFUSALS = {
	unauthorized: {
		status: CALLBACK_ERROR_HTTP_STATUS.unauthorized,
		body: { error: "unauthorized", message: "unknown credential" },
		json: true,
	},
	generationObsolete: {
		status: CALLBACK_ERROR_HTTP_STATUS.generation_obsolete,
		body: { error: "generation_obsolete" },
		json: true,
	},
	conflict: {
		status: CALLBACK_ERROR_HTTP_STATUS.conflict,
		body: { error: "conflict" },
		json: true,
	},
	plainConflict: {
		status: CALLBACK_ERROR_HTTP_STATUS.conflict,
		body: "conflict",
		json: false,
	},
} as const satisfies Record<string, FakeRefusal>;

function refusalResponse(refusal: FakeRefusal): Response {
	if (refusal.json) return Response.json(refusal.body, { status: refusal.status });
	return new Response(String(refusal.body), {
		status: refusal.status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

function startFakeFleet(options: { refuse?: FakeRefusal } = {}): FakeFleet {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const up: CallbackEnvelope[] = [];
	const arrivalListeners = new Set<() => void>();
	let down: ReadableStreamDefaultController<Uint8Array> | null = null;
	let connectionId = "";
	let seq = 0;
	const counters = { requests: 0 };
	let resolvePaired: () => void = () => {};
	const paired = new Promise<void>((resolve) => {
		resolvePaired = resolve;
	});

	const envelope = (streamId: string, kind: CallbackKind, payload: unknown): CallbackEnvelope => ({
		version: 1,
		workspaceId: WORKSPACE,
		generation: GENERATION,
		connectionId,
		streamId,
		seq: ++seq,
		kind,
		payload,
		at: Date.now(),
	});

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		async fetch(req) {
			counters.requests++;
			const pathname = new URL(req.url).pathname;
			const wrongCredential = req.headers.get("authorization") !== `Bearer ${TOKEN}`;
			if (options.refuse !== undefined || wrongCredential) {
				return refusalResponse(options.refuse ?? REFUSALS.unauthorized);
			}
			if (req.method === "GET" && pathname === CALLBACK_DOWN_PATH) {
				connectionId = req.headers.get("x-omp-connection-id") ?? "";
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						down = controller;
						const ready = envelope(CALLBACK_TRANSPORT_STREAM_ID, "control", {
							type: "pair_ready",
							connectionId,
							generation: GENERATION,
						});
						controller.enqueue(encoder.encode(encodeSseEnvelope(ready)));
						resolvePaired();
					},
					cancel() {
						down = null;
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}
			if (req.method === "POST" && pathname === CALLBACK_UP_PATH) {
				const reader = req.body?.getReader();
				if (!reader) return new Response("missing body", { status: 400 });
				let buffered = "";
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					buffered += decoder.decode(chunk.value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline !== -1) {
						const line = buffered.slice(0, newline).trim();
						buffered = buffered.slice(newline + 1);
						if (line.length > 0) {
							up.push(JSON.parse(line) as CallbackEnvelope);
							for (const notify of arrivalListeners) notify();
						}
						newline = buffered.indexOf("\n");
					}
				}
				return Response.json({ ok: true });
			}
			return new Response("not found", { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		paired,
		up,
		waitForUp(match, count) {
			return new Promise<void>((resolve) => {
				const check = (): void => {
					if (up.filter(match).length >= count) {
						arrivalListeners.delete(check);
						resolve();
					}
				};
				arrivalListeners.add(check);
				check();
			});
		},
		send(streamId, kind, payload) {
			if (!down) throw new Error("fake fleet has no open down stream");
			down.enqueue(encoder.encode(encodeSseEnvelope(envelope(streamId, kind, payload))));
		},
		counters,
		stop() {
			down?.close();
			server.stop(true);
		},
		dropPair() {
			const current = down;
			down = null;
			current?.close();
		},
	};
}

/** The sessionFile of a control-stream state frame, or undefined for any other envelope. */
function stateFrameSessionFile(envelope: CallbackEnvelope): string | undefined {
	const payload = envelope.payload;
	if (envelope.kind !== "frame" || envelope.streamId !== CALLBACK_CONTROL_STREAM_ID)
		return undefined;
	if (typeof payload !== "object" || payload === null) return undefined;
	if (!("type" in payload) || payload.type !== "state") return undefined;
	if (!("state" in payload) || typeof payload.state !== "object" || payload.state === null)
		return undefined;
	if (!("sessionFile" in payload.state) || typeof payload.state.sessionFile !== "string")
		return undefined;
	return payload.state.sessionFile;
}

/** The id of a call_result frame, or undefined for any other envelope. */
function callResultId(envelope: CallbackEnvelope): string | undefined {
	const payload = envelope.payload;
	if (envelope.kind !== "frame") return undefined;
	if (typeof payload !== "object" || payload === null) return undefined;
	if (!("type" in payload) || payload.type !== "call_result") return undefined;
	if (!("id" in payload) || typeof payload.id !== "string") return undefined;
	return payload.id;
}

/** The frame payload of an envelope on `streamId`, or undefined for any other envelope. */
function streamFrame(
	envelope: CallbackEnvelope,
	streamId: string,
): { type?: unknown; id?: unknown; messages?: unknown; state?: unknown } | undefined {
	if (envelope.kind !== "frame" || envelope.streamId !== streamId) return undefined;
	const payload = envelope.payload;
	return typeof payload === "object" && payload !== null ? payload : undefined;
}

/** The readiness stamp of a `state` frame payload, or undefined while the gate is open. */
function stateReadyAt(frame: { type?: unknown; state?: unknown } | undefined): number | undefined {
	if (frame?.type !== "state") return undefined;
	const state = frame.state;
	if (typeof state !== "object" || state === null || !("readyAt" in state)) return undefined;
	return typeof state.readyAt === "number" ? state.readyAt : undefined;
}

/** The sessionName of a `state` frame payload (undefined when absent/not a string). */
function stateSessionName(
	frame: { type?: unknown; state?: unknown } | undefined,
): string | undefined {
	if (frame?.type !== "state") return undefined;
	const state = frame.state;
	if (typeof state !== "object" || state === null || !("sessionName" in state)) return undefined;
	return typeof state.sessionName === "string" ? state.sessionName : undefined;
}

/** A loopback port with nothing listening on it. */
function closedPortUrl(): string {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const url = `http://127.0.0.1:${probe.port}`;
	probe.stop(true);
	return url;
}

const running: Subprocess[] = [];
const fleets: FakeFleet[] = [];

afterAll(async () => {
	for (const child of running) {
		if (child.exitCode === null) child.kill();
	}
	for (const fleet of fleets) fleet.stop();
	await cleanupTempDirs();
});

function trackFleet(options: { refuse?: FakeRefusal } = {}): FakeFleet {
	const fleet = startFakeFleet(options);
	fleets.push(fleet);
	return fleet;
}

function spawnDaemon(callbackUrl: string, extra: Record<string, string> = {}): Subprocess {
	const child = Bun.spawn(["bun", "apps/session/index.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			OMP_SESSION_PORT: "0",
			OMP_SESSION_CWD: tempDir("omp-session-cp-cwd-"),
			PI_NO_TITLE: "1",
			PI_CODING_AGENT_DIR: tempDir("omp-session-cp-agent-"),
			OMP_SESSION_CALLBACK_URL: callbackUrl,
			OMP_SESSION_CALLBACK_WORKSPACE: WORKSPACE,
			OMP_SESSION_CALLBACK_GENERATION: String(GENERATION),
			OMP_SESSION_CALLBACK_TOKEN: TOKEN,
			OMP_SESSION_CALLBACK_ALLOW_HTTP: "1",
			OMP_SESSION_LOG_MIRROR: "0",
			...extra,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	running.push(child);
	return child;
}

/** Exit code, or null when the child is still alive after timeoutMs. */
function exitWithin(child: Subprocess, timeoutMs: number): Promise<number | null> {
	return Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)]);
}

/** Poll `probe` until it holds, or throw once the deadline passes. */
async function waitUntil(probe: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!probe()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await Bun.sleep(25);
	}
}

test("a ShutdownControl from the fleet stops the session with exit 0", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a session with no reachable control plane exits after the grace period", async () => {
	const child = spawnDaemon(closedPortUrl(), { OMP_SESSION_CONTROL_GRACE: "2s" });
	const started = Date.now();
	expect(await exitWithin(child, 30_000)).toBe(0);
	expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
});

test("a credential the fleet rejects shuts the session down without waiting for the grace period", async () => {
	const fleet = trackFleet({ refuse: REFUSALS.unauthorized });
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a fleet generation_obsolete shuts the session down without waiting for the grace period", async () => {
	// The fleet announces a superseded generation with HTTP 409 and a typed
	// body (apps/fleet/test/daemon-transport.test.ts). Like a rejected
	// credential, it is terminal: the session must not keep dialing a pair the
	// fleet has already replaced, and it must not sit out the grace window.
	const fleet = trackFleet({ refuse: REFUSALS.generationObsolete });
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a 409 that is not a terminal refusal leaves the session dialing", async () => {
	// Only `unauthorized` and `generation_obsolete` stop the transport; every
	// other refusal (a typed conflict, or a 409 body the status must map) is
	// retried on the backoff, so the daemon keeps dialing instead of exiting.
	for (const refusal of [REFUSALS.conflict, REFUSALS.plainConflict]) {
		const fleet = trackFleet({ refuse: refusal });
		const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
		await waitUntil(
			() => fleet.counters.requests >= 2,
			30_000,
			`a second dial after HTTP ${refusal.status}`,
		);
		expect(await exitWithin(child, 2_000)).toBeNull();
		child.kill();
	}
}, 30_000);

test("a live pair keeps the session up past the grace period", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "2s" });
	await fleet.paired;
	// Real time: the grace window must elapse for this to prove anything.
	expect(await exitWithin(child, 4_000)).toBeNull();
	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown" });
	expect(await exitWithin(child, 20_000)).toBe(0);
}, 30_000);

test("a command repeated over the pair is dispatched once and its answer replayed", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	const command = { type: "call", id: "dup-cmd", method: "setSessionName", args: ["dup-name"] };
	fleet.send(CALLBACK_CONTROL_STREAM_ID, "command", command);
	fleet.send(CALLBACK_CONTROL_STREAM_ID, "command", command);
	await fleet.waitForUp((e) => callResultId(e) === "dup-cmd", 2);
	// Real time: a re-dispatch would land a third answer only after the
	// subprocess handled it, so only quiet time proves the duplicate was dropped.
	await Bun.sleep(1200);
	expect(fleet.up.filter((e) => callResultId(e) === "dup-cmd")).toHaveLength(2);
	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("an open browser stream keeps the idle timeout from stopping the session", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, {
		OMP_SESSION_CONTROL_GRACE: "0",
		OMP_SESSION_IDLE_TIMEOUT: "3s",
		OMP_SESSION_TEST_IDLE_CHECK_MS: "200",
	});
	await fleet.paired;
	fleet.send("browser-1", "control", { type: "stream_open" });
	// Real time: the idle timeout must elapse while the stream is open.
	expect(await exitWithin(child, 2_500)).toBeNull();
	fleet.send("browser-1", "control", { type: "stream_close" });
	expect(await exitWithin(child, 15_000)).toBe(0);
}, 30_000);

test("every pair-up publishes the session file on the control stream, including after a redial", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	// No browser stream is open: the state frame must not depend on one.
	await fleet.waitForUp((e) => stateFrameSessionFile(e) !== undefined, 1);
	fleet.dropPair();
	await fleet.waitForUp((e) => stateFrameSessionFile(e) !== undefined, 2);
	const sessionFiles = fleet.up.map(stateFrameSessionFile).filter((f) => f !== undefined);
	expect(sessionFiles).toHaveLength(2);
	expect(sessionFiles[0]).toBeString();
	expect(sessionFiles[0]!.length).toBeGreaterThan(0);
	expect(sessionFiles[1]).toBe(sessionFiles[0]);
	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("browser streams prime the transcript and get the history resync after newSession", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	const frames = (streamId: string) =>
		fleet.up.map((e) => streamFrame(e, streamId)).filter((f) => f !== undefined);
	const historyLengths = (streamId: string, beforeAnswer?: string): number[] => {
		const list = frames(streamId);
		const end =
			beforeAnswer === undefined
				? list.length
				: list.findIndex((f) => f.type === "call_result" && f.id === beforeAnswer);
		return list
			.slice(0, end)
			.filter((f) => f.type === "history")
			.map((f) => (Array.isArray(f.messages) ? f.messages.length : -1));
	};

	// Attach: the transcript (empty) primes between attached and state.
	fleet.send("browser/one", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.type === "state", 1);
	const primed = frames("browser/one").map((f) => f.type);
	expect(primed.slice(0, 4)).toEqual(["hello_ok", "attached", "history", "state"]);
	expect(historyLengths("browser/one")).toEqual([0]);

	// One transcript message, then a second browser attaches and primes it.
	fleet.send("browser/one", "command", {
		type: "call",
		id: "bash-1",
		method: "bash",
		args: ["echo primed", false],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.id === "bash-1", 1);
	fleet.send("browser/two", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/two")?.type === "state", 1);
	expect(historyLengths("browser/two")).toEqual([1]);

	// New session: both browser streams get the empty transcript before the answer.
	fleet.send("browser/one", "command", { type: "call", id: "new-1", method: "newSession" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/two")?.id === "new-1", 1);
	expect(historyLengths("browser/one", "new-1")).toEqual([0, 0]);
	expect(historyLengths("browser/two", "new-1")).toEqual([1, 0]);
	// The fleet's control mirror never carries the transcript.
	expect(frames(CALLBACK_CONTROL_STREAM_ID).some((f) => f.type === "history")).toBe(false);

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a history-reload call resyncs the transcript before its answer", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	// The transcript resync is browser-stream-only (the fleet's control mirror
	// never carries history), so the call is driven over the pair's control
	// stream while the browser stream attached to the same pair shows the order.
	fleet.send("browser/resync", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/resync")?.type === "state", 1);

	fleet.send(CALLBACK_CONTROL_STREAM_ID, "command", {
		type: "call",
		id: "reload-1",
		method: "newSession",
		args: [],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/resync")?.id === "reload-1", 1);

	const frames = fleet.up
		.map((e) => streamFrame(e, "browser/resync"))
		.filter((f) => f !== undefined);
	const at = (probe: (frame: (typeof frames)[number]) => boolean): number[] =>
		frames.map((frame, index) => (probe(frame) ? index : -1)).filter((index) => index >= 0);
	const answerAt = frames.findIndex((f) => f.type === "call_result" && f.id === "reload-1");
	// Attach priming + the reload's replacement, both before the answer: picker
	// success UI must run against the transcript the call produced.
	const historyAt = at((f) => f.type === "history");
	expect(historyAt).toHaveLength(2);
	expect(answerAt).toBeGreaterThan(historyAt[1]!);
	expect(at((f) => f.type === "state").at(-1)).toBeLessThan(answerAt);

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a read-only call broadcasts no state; a mutating call does", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "0" });
	await fleet.paired;
	fleet.send("browser/state", "control", { type: "stream_open" });
	// Wait for the snapshot to carry the readiness stamp: the gate clearing is
	// a state broadcast of its own, and it must land before the window below.
	await fleet.waitForUp((e) => stateReadyAt(streamFrame(e, "browser/state")) !== undefined, 1);

	const frames = () =>
		fleet.up.map((e) => streamFrame(e, "browser/state")).filter((f) => f !== undefined);
	const states = () => frames().filter((f) => f.type === "state");
	const before = states().length;

	fleet.send("browser/state", "command", {
		type: "call",
		id: "stats-1",
		method: "getSessionStats",
		args: [],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/state")?.id === "stats-1", 1);
	fleet.send("browser/state", "command", {
		type: "call",
		id: "name-1",
		method: "setSessionName",
		args: ["state-probe"],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/state")?.id === "name-1", 1);
	// The mutating resync lands after its answer (the title listener's frame
	// lands before it), so wait for both before counting: anything the read-only
	// call broadcast would have been enqueued before them and is already counted.
	await fleet.waitForUp(
		(e) => stateSessionName(streamFrame(e, "browser/state")) === "state-probe",
		2,
	);

	// Every state frame across both calls belongs to the mutating one: the
	// read-only row skipped the broadcast (one would carry the pre-rename name,
	// since its answer landed before the rename was sent). The rename yields two:
	// the SDK title listener's and the post-mutation resync after the answer.
	const after = states().slice(before);
	expect(after.map(stateSessionName)).toEqual(["state-probe", "state-probe"]);
	expect(frames().indexOf(after.at(-1)!)).toBeGreaterThan(
		frames().findIndex((f) => f.type === "call_result" && f.id === "name-1"),
	);

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a pair-attached browser with no local /events consumer answers a ui_request", async () => {
	// Locks the presence check to the callback pair: production browsers ride
	// the pair as `browser/<connId>` virtual streams and never enter the
	// daemon's own /events consumer set, so a local-only check rejected every
	// dialog with "No connected client to answer the UI request" (the
	// regression users saw in the ask card).
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, {
		OMP_SESSION_CONTROL_GRACE: "0",
		OMP_SESSION_TEST_UI_REQUEST: "1",
	});
	await fleet.paired;
	// Pair only: nothing here opens a local /events stream, so the daemon's
	// `streams` set stays empty for the whole test.
	fleet.send("browser/one", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.type === "state", 1);

	fleet.send("browser/one", "command", { type: "test_ui_request", id: "tui-1" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.type === "ui_request", 1);
	// `method` is absent from streamFrame's narrow shape, so the cast reads it
	// without widening the shared helper.
	const request = fleet.up
		.map((e) => streamFrame(e, "browser/one"))
		.find((f) => f?.type === "ui_request") as { id?: unknown; method?: unknown } | undefined;
	expect(request?.method).toBe("confirm");
	const requestId = request?.id;
	expect(typeof requestId).toBe("string");

	// The reject the local-only check produced must be gone from the wire: the
	// mirror's only sinks are the control stream and the browser streams.
	const errors = [CALLBACK_CONTROL_STREAM_ID, "browser/one"]
		.flatMap((streamId) => fleet.up.map((e) => streamFrame(e, streamId)))
		.filter((frame) => frame?.type === "error");
	expect(JSON.stringify(errors)).not.toContain("No connected client to answer the UI request");

	// Answer like the browser: the request settles and rings ui_request_end.
	fleet.send("browser/one", "command", { type: "ui_response", id: requestId, result: true });
	await fleet.waitForUp((e) => {
		const frame = streamFrame(e, "browser/one");
		return frame?.type === "ui_request_end" && frame.id === requestId;
	}, 1);

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});
