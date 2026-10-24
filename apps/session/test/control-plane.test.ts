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
	CALLBACK_CLOSE_REFUSAL_BASE,
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_ERROR_HTTP_STATUS,
	CALLBACK_TRANSPORT_STREAM_ID,
	type CallbackEnvelope,
	type CallbackKind,
} from "#lib/wire/callback-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { startFakeFleet, type FakeFleetOptions } from "./fake-fleet.testkit";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const WORKSPACE = "ws-control-plane";
const GENERATION = 1;
const TOKEN = "ab".repeat(32);

/** The fake fleet the daemon dials, over the shared WebSocket fake (fake-fleet.testkit.ts). */
interface FakeFleet {
	url: string;
	/** Resolves when the daemon's pair socket has been sent pair_ready. */
	paired: Promise<void>;
	/** Envelopes the daemon sent on the pair, in arrival order. */
	up: CallbackEnvelope[];
	/** Resolves once `count` uploaded envelopes satisfy `match`. */
	waitForUp(match: (envelope: CallbackEnvelope) => boolean, count: number): Promise<void>;
	/** Sends one envelope on the current pair. */
	send(streamId: string, kind: CallbackKind, payload: unknown): void;
	/** Resolves once the daemon has dialed `count` times (a refused pair dials again after its backoff). */
	whenDials(count: number): Promise<void>;
	stop(): void;
	/** Closes the current pair socket (network loss); the daemon redials and a new pair forms. */
	dropPair(): void;
}

/** A refusal every upgrade is answered with, standing in for the real fleet's typed closes. */
type FakeRefusal = NonNullable<FakeFleetOptions["refuse"]>;

/**
 * The fleet's refusal shapes (callback-protocol error codes). The session treats a
 * credential rejection (`unauthorized`, `invalid_identity`), a superseded generation
 * and an unsupported protocol as terminal; every other code, typed or inferred from
 * the close status, is retryable.
 */
const REFUSALS = {
	unauthorized: { code: "unauthorized", message: "unknown credential" },
	invalidIdentity: { code: "invalid_identity", message: "missing x-omp-workspace-id header" },
	generationObsolete: { code: "generation_obsolete" },
	protoUnsupported: {
		code: "proto_unsupported",
		message: "callback protocol mismatch",
	},
	conflict: { code: "conflict" },
	/** A refusal close whose reason names no ledger code: the status alone maps it. */
	plainConflict: {
		close: {
			code: CALLBACK_CLOSE_REFUSAL_BASE + CALLBACK_ERROR_HTTP_STATUS.conflict,
			reason: "conflict",
		},
	},
} as const satisfies Record<string, FakeRefusal>;

function startFleet(options: { refuse?: FakeRefusal } = {}): FakeFleet {
	const fleet = startFakeFleet({
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		...options,
	});
	return {
		url: fleet.url,
		paired: fleet.paired,
		up: fleet.received,
		waitForUp: (match, count) => fleet.whenReceived(count, match),
		send: fleet.send,
		whenDials: fleet.whenUpgrades,
		stop: fleet.stop,
		dropPair: () => fleet.close(1012, "service restart"),
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
	const fleet = startFleet(options);
	fleets.push(fleet);
	return fleet;
}

function spawnDaemon(
	callbackUrl: string,
	extra: Record<string, string> = {},
	stdout: "ignore" | "pipe" = "ignore",
): Subprocess {
	// The callback pair travels on stdin (--fleet-stdin), never the environment. Ambient fleet
	// secrets are filtered out of the base env so a developer's shell cannot leak them in.
	const child = Bun.spawn(["bun", "apps/session/index.ts", "--fleet-stdin"], {
		cwd: repoRoot,
		env: {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !key.startsWith("OMP_SESSION_CALLBACK_") && key !== "OMP_SESSION_TOKEN",
				),
			),
			OMP_SESSION_PORT: "0",
			OMP_SESSION_CWD: tempDir("omp-session-cp-cwd-"),
			PI_NO_TITLE: "1",
			PI_CODING_AGENT_DIR: tempDir("omp-session-cp-agent-"),
			OMP_SESSION_LOG_MIRROR: "0",
			...extra,
		},
		stdin: "pipe",
		stdout,
		stderr: "ignore",
	});
	child.stdin.write(
		JSON.stringify({
			v: 1,
			callback: {
				url: callbackUrl,
				workspace: WORKSPACE,
				generation: GENERATION,
				token: TOKEN,
				allowHttp: true,
			},
		}),
	);
	child.stdin.end();
	running.push(child);
	return child;
}

/** Exit code, or null when the child is still alive after timeoutMs. */
function exitWithin(child: Subprocess, timeoutMs: number): Promise<number | null> {
	return Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)]);
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

test("a fleet-managed session binds no listener and prints no listening line", async () => {
	const child = spawnDaemon(closedPortUrl(), { OMP_SESSION_CONTROL_GRACE: "2s" }, "pipe");
	const stdout = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
	expect(await exitWithin(child, 30_000)).toBe(0);
	expect(stdout).not.toContain("OMP_SESSION|");
});

test("a credential the fleet rejects shuts the session down without waiting for the grace period", async () => {
	const fleet = trackFleet({ refuse: REFUSALS.unauthorized });
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a credential the fleet rejects exits 0 even while postmortem teardown is still running", async () => {
	// The rejected start() promise is expected on a stop-before-ready. It must not
	// surface as an unhandled rejection, which postmortem would turn into exit 1 when
	// the shutdown's async teardown is still running at that moment.
	const fleet = trackFleet({ refuse: REFUSALS.unauthorized });
	const child = spawnDaemon(fleet.url, {
		OMP_SESSION_CONTROL_GRACE: "10m",
		BUN_OPTIONS: `--preload=${repoRoot}apps/session/test/teardown-probe.preload.ts`,
		OMP_SESSION_TEST_TEARDOWN: "slow",
	});
	expect(await exitWithin(child, 20_000)).toBe(0);
}, 30_000);

test("a fleet generation_obsolete shuts the session down without waiting for the grace period", async () => {
	// The fleet announces a superseded generation with a typed refusal close
	// (apps/fleet/test/daemon-transport.test.ts). Like a rejected credential, it is
	// terminal: the session must not keep dialing a pair the fleet has already
	// replaced, and it must not sit out the grace window.
	const fleet = trackFleet({ refuse: REFUSALS.generationObsolete });
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("an invalid_identity or proto_unsupported refusal shuts the session down at once", async () => {
	// proto_unsupported is what a fleet answers a session speaking another callback
	// protocol; here the session itself is told its protocol is gone and must exit
	// instead of redialing a fleet that will never serve it.
	for (const refusal of [REFUSALS.invalidIdentity, REFUSALS.protoUnsupported]) {
		const fleet = trackFleet({ refuse: refusal });
		const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
		expect(await exitWithin(child, 20_000)).toBe(0);
	}
}, 60_000);

test("a 409 that is not a terminal refusal leaves the session dialing", async () => {
	// Only a credential rejection, a superseded generation and an unsupported protocol
	// stop the transport; every other refusal (a typed conflict, or a 4409 close whose
	// reason names no code) is retried on the backoff, so the daemon keeps dialing
	// instead of exiting.
	for (const refusal of [REFUSALS.conflict, REFUSALS.plainConflict]) {
		const fleet = trackFleet({ refuse: refusal });
		const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
		await fleet.whenDials(2);
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
	// The retry follows the recorded answer: a duplicate that races the first dispatch
	// is still in flight and has no answer to replay yet, so back-to-back frames on one
	// socket read would not prove the replay.
	fleet.send(CALLBACK_CONTROL_STREAM_ID, "command", command);
	await fleet.waitForUp((e) => callResultId(e) === "dup-cmd", 1);
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

test("agent subprocesses do not inherit the daemon's callback pair", async () => {
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, { OMP_SESSION_CONTROL_GRACE: "10m" });
	await fleet.paired;
	const dump = `${tempDir("omp-session-cp-env-")}/env.txt`;
	fleet.send("browser/env", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/env")?.type === "state", 1);
	fleet.send("browser/env", "command", {
		type: "call",
		id: "env-1",
		method: "bash",
		args: [`env > ${dump}`, false],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/env")?.id === "env-1", 1);
	const dumped = await Bun.file(dump).text();
	expect(dumped).toMatch(/^PATH=/m);
	expect(dumped).not.toMatch(/^OMP_SESSION_CALLBACK_/m);
	expect(dumped).not.toMatch(/^OMP_SESSION_TOKEN=/m);
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
	// A trailing read-only round trip: any resync the rename enqueued after its
	// answer lands before this answer, so the count below would include it.
	fleet.send("browser/state", "command", {
		type: "call",
		id: "stats-2",
		method: "getSessionStats",
		args: [],
	});
	await fleet.waitForUp((e) => streamFrame(e, "browser/state")?.id === "stats-2", 1);

	// Exactly one state frame across all three calls, and it carries the rename:
	// the read-only rows skipped the broadcast, and the SDK name listener's frame
	// is the rename's only one (setSessionName is NAME_ONLY, so no resync).
	expect(states()).toHaveLength(before + 1);
	expect(stateSessionName(states().at(-1))).toBe("state-probe");

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});

test("a pair-attached browser with no local /ws consumer answers a ui_request", async () => {
	// Locks the presence check to the callback pair: production browsers ride
	// the pair as `browser/<connId>` virtual streams and never enter the
	// daemon's own /ws consumer set, so a local-only check rejected every
	// dialog with "No connected client to answer the UI request" (the
	// regression users saw in the ask card).
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, {
		OMP_SESSION_CONTROL_GRACE: "0",
		OMP_SESSION_TEST_UI_REQUEST: "1",
	});
	await fleet.paired;
	// Pair only: nothing here opens a local /ws socket, so the daemon's
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

test("a state snapshot carries the ids of the ui_requests pending at that moment", async () => {
	// The fleet rebuilds a daemon's blocked flag from this field on every state
	// frame (notably the pair-up one), so the stream_open priming snapshot is
	// the observable seam: it must list the open dialog, then list none once settled.
	const fleet = trackFleet();
	const child = spawnDaemon(fleet.url, {
		OMP_SESSION_CONTROL_GRACE: "0",
		OMP_SESSION_TEST_UI_REQUEST: "1",
	});
	await fleet.paired;
	const pendingIds = (streamId: string): unknown => {
		const frame = fleet.up.map((e) => streamFrame(e, streamId)).find((f) => f?.type === "state");
		const state = frame?.state;
		return typeof state === "object" && state !== null && "pendingUiRequestIds" in state
			? state.pendingUiRequestIds
			: undefined;
	};

	fleet.send("browser/one", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.type === "state", 1);
	expect(pendingIds("browser/one")).toEqual([]);

	fleet.send("browser/one", "command", { type: "test_ui_request", id: "tui-1" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/one")?.type === "ui_request", 1);
	const requestId = (
		fleet.up.map((e) => streamFrame(e, "browser/one")).find((f) => f?.type === "ui_request") as
			| { id?: unknown }
			| undefined
	)?.id;
	expect(typeof requestId).toBe("string");

	fleet.send("browser/two", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/two")?.type === "state", 1);
	expect(pendingIds("browser/two")).toEqual([requestId]);

	fleet.send("browser/one", "command", { type: "ui_response", id: requestId, result: true });
	await fleet.waitForUp((e) => {
		const frame = streamFrame(e, "browser/one");
		return frame?.type === "ui_request_end" && frame.id === requestId;
	}, 1);
	fleet.send("browser/three", "control", { type: "stream_open" });
	await fleet.waitForUp((e) => streamFrame(e, "browser/three")?.type === "state", 1);
	expect(pendingIds("browser/three")).toEqual([]);

	fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "control", { type: "shutdown", reason: "test" });
	expect(await exitWithin(child, 20_000)).toBe(0);
});
