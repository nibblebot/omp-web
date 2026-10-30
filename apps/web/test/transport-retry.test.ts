import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { COMMAND_DEDUP_WINDOW_MS, OMP_PROTO } from "#lib/wire/protocol";
import type {
	ClientCommand,
	ServerFrame,
	WebMethodName,
	WebSessionState,
} from "#lib/wire/protocol";
import { connect, connectionState, setState, state } from "../state";
import {
	call,
	isSessionSwitchSupersession,
	pendingCalls,
	rejectPendingCalls,
	retryNotAttachedCalls,
	settleCallResult,
} from "../store/transport";
import {
	attached,
	dispatch,
	FakeWebSocket,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "./web.testkit";

// Controllable clock: window.setTimeout is recorded and fired only by advance(),
// clearTimeout cancels a recorded timer, and Date.now follows the same elapsed
// time, so the replay cadence and the dedup window are testable without real timers.
const START = 1_000_000;
let elapsed = 0;
type FakeTimer = { fn: () => void; due: number; live: boolean };
const timers: FakeTimer[] = [];

function advance(ms: number): void {
	elapsed += ms;
	for (const t of timers) {
		if (t.live && t.due <= elapsed) {
			t.live = false;
			t.fn();
		}
	}
}

function installClock(): void {
	timers.length = 0;
	elapsed = 0;
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => {
			timers.push({ fn, due: elapsed + (ms ?? 0), live: true });
			return timers.length; // 1-based: the id clearTimeout maps back to timers[id - 1]
		},
	} as unknown as Window & typeof globalThis);
	// Only this file's fake handles are cancelled here; a real timer (the store's roster pacing timer
	// is armed on the global setTimeout) must still be cleared, or it fires after this file and leaves
	// the store's timer bookkeeping out of step with its real timers for every later file.
	const realClearTimeout = globalThis.clearTimeout;
	spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		if (typeof id !== "number") return realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
		const t = timers[id - 1];
		if (t) t.live = false;
	});
	spyOn(Date, "now").mockImplementation(() => START + elapsed);
}

type CallResult = Extract<ServerFrame, { type: "call_result" }>;

/** A call_result answer for one call id: `ok` with data, or a failure with `error`. */
function answer(id: string, ok: boolean, data?: unknown, error?: string): CallResult {
	return { type: "call_result", id, ok, data, ...(error !== undefined ? { error } : {}) };
}

/** Outcome of one call(), recorded as its promise settles. */
type Outcome = { settled: boolean; value?: unknown; error?: Error };

/**
 * Start a call with no deadline (timeoutMs 0) so only the retry logic moves
 * it, and return its page-unique id plus the outcome recorder.
 */
function start(): { id: string; outcome: Outcome } {
	const outcome: Outcome = { settled: false };
	call("getSubagents", [], 0).then(
		(value) => Object.assign(outcome, { settled: true, value }),
		(error: Error) => Object.assign(outcome, { settled: true, error }),
	);
	const cmd = posted.at(-1);
	if (cmd?.type !== "call") throw new Error("expected a call command");
	return { id: cmd.id, outcome };
}

/** Number of sends that carried this call id. */
function copies(id: string): number {
	return posted.filter((c) => c.type === "call" && c.id === id).length;
}

beforeEach(() => {
	installTransportStubs();
	installClock();
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
});

afterEach(() => {
	mock.restore();
	rejectPendingCalls(new Error("test reset"));
	setState({ connected: false, sessionDownId: "", currentWorkspaceId: "" });
});

afterAll(() => {
	restoreBrowserGlobals();
});

describe("not-attached retry (SUB-02)", () => {
	test("a not-attached answer parks the call instead of rejecting it", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		await flushMicrotasks();
		expect(outcome.settled).toBe(false);
		expect(pendingCalls.get(id)?.awaitingAttach).toBe(true);
	});

	test("retryNotAttachedCalls re-sends the same command id once and the answer settles it", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		retryNotAttachedCalls();
		expect(copies(id)).toBe(2);
		expect(posted.at(-1)).toMatchObject({ type: "call", id, method: "getSubagents" });
		settleCallResult(answer(id, true, { ok: 1 }));
		await flushMicrotasks();
		expect(outcome.value).toEqual({ ok: 1 });
		expect(outcome.error).toBeUndefined();
	});

	test("a parked call refused again stays parked and settles on a later answer", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		retryNotAttachedCalls();
		settleCallResult(answer(id, false, undefined, "not attached"));
		await flushMicrotasks();
		expect(outcome.settled).toBe(false);
		expect(pendingCalls.get(id)?.awaitingAttach).toBe(true);
		settleCallResult(answer(id, true, { ok: 2 }));
		await flushMicrotasks();
		expect(outcome.value).toEqual({ ok: 2 });
	});

	test("a call past the dedup window fails instead of being re-sent", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		advance(COMMAND_DEDUP_WINDOW_MS + 1);
		retryNotAttachedCalls();
		await flushMicrotasks();
		expect(outcome.error?.message).toBe("not attached");
		expect(copies(id)).toBe(1);
	});

	test("a parked call keeps replaying under the same id until it is answered", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		advance(15_000);
		expect(copies(id)).toBeGreaterThan(1);
		settleCallResult(answer(id, true, { ok: 3 }));
		await flushMicrotasks();
		expect(outcome.value).toEqual({ ok: 3 });
	});

	test("a re-sent call returns to the normal replay cadence until it is answered", () => {
		const { id } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		retryNotAttachedCalls();
		advance(5_000);
		expect(copies(id)).toBe(3);
		settleCallResult(answer(id, true, { ok: 1 }));
		advance(5_000);
		expect(copies(id)).toBe(3);
	});

	test("disconnect rejects parked calls", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		rejectPendingCalls(new Error("Disconnected"));
		await flushMicrotasks();
		expect(outcome.error?.message).toBe("Disconnected");
		expect(pendingCalls.has(id)).toBe(false);
	});

	test("the attached frame re-sends parked calls under their original id", () => {
		const { id } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		dispatch(attached("workspace-a"));
		expect(copies(id)).toBe(2);
	});

	test("a reconnect (hello_ok then attached) replays a parked call once under its id and settles on the answer", async () => {
		const { id, outcome } = start();
		settleCallResult(answer(id, false, undefined, "not attached"));
		dispatch({
			type: "hello_ok",
			proto: OMP_PROTO,
			name: "workspace-a",
			cwd: "/x",
			pid: 1,
			version: "0.0.0",
		});
		dispatch(attached("workspace-a"));
		expect(copies(id)).toBe(2);
		settleCallResult(answer(id, true, { ok: 2 }));
		await flushMicrotasks();
		expect(outcome.value).toEqual({ ok: 2 });
		// The answered call is no longer parked: another attached frame sends nothing.
		dispatch(attached("workspace-a"));
		expect(copies(id)).toBe(2);
	});

	/** A state frame carrying the scope of the attachment it primes. */
	const stateFrame = (generation: string): ServerFrame => ({
		type: "state",
		state: {
			sessionId: "d9",
			sessionScope: { workspaceId: "w1", sessionId: "d9", generation },
		} as unknown as WebSessionState,
	});
	/** Issue one call with no deadline and record how it settles. */
	const sent = (method: WebMethodName) => {
		const outcome: Outcome = { settled: false };
		call(method, [], 0).then(
			(value) => Object.assign(outcome, { settled: true, value }),
			(error: Error) => Object.assign(outcome, { settled: true, error }),
		);
		const cmd = posted.at(-1);
		if (cmd?.type !== "call") throw new Error("expected a call command");
		return { cmd, outcome };
	};
	const reposted = (id: string) =>
		posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call" && c.id === id,
		);

	test("a re-attach re-posts a parked read at once, without its scope", () => {
		setState("sessionScope", { workspaceId: "w1", sessionId: "d9", generation: "1" });
		const { cmd: read } = sent("resumeList");
		expect(read.scope?.generation).toBe("1");
		settleCallResult(answer(read.id, false, undefined, "not attached"));

		// The attached frame clears the live scope before the parked read goes out.
		dispatch(attached("d9"));
		expect(state.sessionScope).toBeUndefined();
		expect(reposted(read.id)).toHaveLength(2);
		expect(reposted(read.id)[1]?.scope).toBeUndefined();
	});

	test("a parked mutation waits for the state frame and is dropped silently when the generation changed", async () => {
		setState("sessionScope", { workspaceId: "w1", sessionId: "d9", generation: "1" });
		const { cmd: mutation, outcome } = sent("setThinkingLevel");
		settleCallResult(answer(mutation.id, false, undefined, "not attached"));

		dispatch(attached("d9"));
		expect(reposted(mutation.id)).toHaveLength(1);
		advance(5_000); // the replay timer never posts a mutation waiting for the state frame
		expect(reposted(mutation.id)).toHaveLength(1);

		dispatch(stateFrame("2"));
		await flushMicrotasks();
		expect(reposted(mutation.id)).toHaveLength(1);
		expect(outcome.error?.message).toBe("session switched");
		expect(isSessionSwitchSupersession(outcome.error)).toBe(true);
		expect(pendingCalls.has(mutation.id)).toBe(false);
		expect(state.error ?? "").not.toMatch(/stale session|session switched/i);
		expect(state.toasts).toHaveLength(0);
		advance(COMMAND_DEDUP_WINDOW_MS);
		expect(reposted(mutation.id)).toHaveLength(1);
	});
	test("a parked mutation is re-posted once with its own scope when the state frame keeps the attachment", () => {
		setState("sessionScope", { workspaceId: "w1", sessionId: "d9", generation: "1" });
		const { cmd: mutation } = sent("setThinkingLevel");
		expect(mutation.scope?.generation).toBe("1");
		settleCallResult(answer(mutation.id, false, undefined, "not attached"));

		dispatch(attached("d9"));
		expect(reposted(mutation.id)).toHaveLength(1);
		dispatch(stateFrame("1"));
		expect(reposted(mutation.id)).toHaveLength(2);
		expect(reposted(mutation.id)[1]).toMatchObject({
			id: mutation.id,
			scope: { workspaceId: "w1", sessionId: "d9", generation: "1" },
		});
		// A later state frame sends nothing more: the mutation is no longer parked.
		dispatch(stateFrame("1"));
		expect(reposted(mutation.id)).toHaveLength(2);
	});

	test("a parked mutation past the dedup window fails with not attached and is never re-posted", async () => {
		setState("sessionScope", { workspaceId: "w1", sessionId: "d9", generation: "1" });
		const { cmd: mutation, outcome } = sent("setThinkingLevel");
		settleCallResult(answer(mutation.id, false, undefined, "not attached"));
		dispatch(attached("d9"));
		advance(COMMAND_DEDUP_WINDOW_MS + 1);
		dispatch(stateFrame("1"));
		await flushMicrotasks();
		expect(outcome.error?.message).toBe("not attached");
		expect(reposted(mutation.id)).toHaveLength(1);
	});
});

describe("connectionState()", () => {
	test("reconnecting while the browser socket is down", () => {
		setState({ connected: false });
		expect(connectionState()).toBe("reconnecting");
	});

	test("connected while the stream is up and no session is down", () => {
		setState({ connected: true, sessionDownId: "", currentWorkspaceId: "workspace-a" });
		expect(connectionState()).toBe("connected");
	});

	test("offline once the attached session process is down", () => {
		setState({ connected: true, sessionDownId: "workspace-a" });
		expect(connectionState()).toBe("offline");
	});

	test("an attached frame clears the offline state", () => {
		setState({ connected: true, sessionDownId: "workspace-a" });
		dispatch(attached("workspace-b"));
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
	});
});
