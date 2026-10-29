/**
 * Reconnect behavior of the browser transport: resuming the attachment a drop
 * interrupted (no history, no remount), reconciling a history frame against
 * the transcript on screen, and the bounded replay-dedup window.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ClientCommand, WebSessionState } from "#lib/wire/protocol";
import { connect, call, setState, state } from "../state";
import { SeqWindow } from "../store/seq-window";
import { rejectPendingAttach, rejectPendingCalls } from "../store/transport";
import {
	attached,
	callResult,
	dispatch,
	dispatchSeq,
	FakeWebSocket,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	userMsg,
	assistantMsg,
} from "./web.testkit";

const SCOPE = { workspaceId: "d1", sessionId: "s1", generation: "1" } as const;

function attachCommands(): Array<Extract<ClientCommand, { type: "attach" }>> {
	return posted.filter((c): c is Extract<ClientCommand, { type: "attach" }> => c.type === "attach");
}

/** Connected and attached to d1 with a two-message transcript, a scoped state and readiness. */
function onSession(): FakeWebSocket {
	connect();
	const ws = FakeWebSocket.instances.at(-1)!;
	ws.onopen?.();
	dispatch(attached("d1"));
	dispatch({ type: "history", messages: [userMsg("q"), assistantMsg("a")] } as never);
	dispatch({ type: "state", state: { sessionScope: SCOPE } as WebSessionState });
	dispatch({ type: "ready", readyAt: 77 });
	return ws;
}

beforeEach(() => {
	installTransportStubs();
	setState({
		currentWorkspaceId: "",
		sessionScope: undefined,
		connected: false,
		readyAt: undefined,
		items: [],
		error: null,
		debugLog: [],
		reconnectDelay: 0,
		transcriptPhase: "idle",
		transcriptError: null,
		transcriptTarget: null,
		protoMismatch: false,
	});
});

afterEach(() => {
	vi.useRealTimers();
	rejectPendingCalls(new Error("test teardown"));
	rejectPendingAttach(new Error("test teardown"));
	restoreBrowserGlobals();
});

describe("resuming the attachment after a drop", () => {
	/** The socket drops and the backoff redial opens; returns the new socket. */
	function dropAndRedial(ws: FakeWebSocket): FakeWebSocket {
		ws.serverClose(1006);
		vi.advanceTimersByTime(state.reconnectDelay);
		const next = FakeWebSocket.instances.at(-1)!;
		expect(next).not.toBe(ws);
		next.onopen?.();
		return next;
	}

	test("the reconnect's re-attach asks to resume; an ordinary attach does not", () => {
		vi.useFakeTimers();
		const ws = onSession();
		posted.length = 0;
		dropAndRedial(ws);
		expect(attachCommands().map((c) => ({ id: c.workspaceId, resume: c.resume }))).toEqual([
			{ id: "d1", resume: true },
		]);
	});

	test("a resumed attach keeps the transcript, scope and readiness and primes nothing", () => {
		vi.useFakeTimers();
		const ws = onSession();
		const shown = [...state.items];
		expect(shown).toHaveLength(2);
		const startupCallIds = new Set(posted.filter((c) => c.type === "call").map((c) => c.id));
		posted.length = 0;
		dropAndRedial(ws);
		// The drop cleared readiness per connection.
		expect(state.readyAt).toBeUndefined();
		const [attach] = attachCommands();
		dispatch({
			type: "attach_result",
			id: attach!.id,
			ok: true,
			workspaceId: "d1",
			resumed: true,
		});
		expect(state.readyAt).toBe(77);
		expect(state.sessionScope).toEqual(SCOPE);
		expect(state.transcriptPhase).toBe("loaded");
		expect(state.items).toHaveLength(2);
		expect(state.items[0]).toBe(shown[0]!);
		expect(state.items[1]).toBe(shown[1]!);
		// No attachment-start work ran: the subagent forest, settings and roster are
		// not pulled again (a call still unanswered at the drop goes out under its own id).
		const newCalls = posted.filter((c) => c.type === "call" && !startupCallIds.has(c.id));
		expect(newCalls).toEqual([]);
	});

	test("a missed delta the ring replays lands once on the kept transcript", () => {
		vi.useFakeTimers();
		const ws = onSession();
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("while-live") } },
			1030,
		);
		expect(state.items).toHaveLength(3);
		posted.length = 0;
		const next = dropAndRedial(ws);
		// The replay at open re-sends nothing the page already applied, and the one it missed.
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("while-away") } },
			1031,
		);
		dispatch({
			type: "attach_result",
			id: attachCommands()[0]!.id,
			ok: true,
			workspaceId: "d1",
			resumed: true,
		});
		expect(state.items.map((it) => (it.kind === "user" ? it.text : it.kind))).toEqual([
			"q",
			"assistant",
			"while-live",
			"while-away",
		]);
		expect(next.url).toContain("after=1030");
	});

	test("priming seqs on a resumed socket do not replace the delta resume point", () => {
		vi.useFakeTimers();
		const ws = onSession();
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("while-live") } },
			1030,
		);
		posted.length = 0;
		const second = dropAndRedial(ws);
		// The resumed attach sends no priming of its own, so the socket's open-time
		// priming seqs (1..k, below DELTA_SEQ_START) are the only frames that follow.
		dispatchSeq({ type: "ready", readyAt: 77 }, 1);
		dispatchSeq({ type: "ready", readyAt: 77 }, 2);
		dispatch({
			type: "attach_result",
			id: attachCommands()[0]!.id,
			ok: true,
			workspaceId: "d1",
			resumed: true,
		});
		expect(second.url).toContain("after=1030");
		const third = dropAndRedial(second);
		// The edge adopts a parked attachment only for a delta-era `after`; k would force a full re-prime.
		expect(third.url).toContain("after=1030");
	});

	test("a restarted server's fresh seq space replaces the old resume point", () => {
		vi.useFakeTimers();
		const ws = onSession();
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("while-live") } },
			1030,
		);
		const second = dropAndRedial(ws);
		// A restarted server numbers from DELTA_SEQ_START again; its first delta wins.
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("after-restart") } },
			1024,
		);
		expect(dropAndRedial(second).url).toContain("after=1024");
	});

	test("a call parked as not attached while the socket was down goes out again on a resume", () => {
		vi.useFakeTimers();
		const ws = onSession();
		posted.length = 0;
		dropAndRedial(ws);
		const parked = call("getQueuedMessages").catch(() => {});
		const sentCall = posted.find((c) => c.type === "call");
		if (sentCall === undefined) throw new Error("expected the call to be posted");
		const callId = sentCall.id;
		dispatch(callResult(callId, undefined, false, "not attached"));
		const sentBefore = posted.filter((c) => c.type === "call").length;
		dispatch({
			type: "attach_result",
			id: attachCommands()[0]!.id,
			ok: true,
			workspaceId: "d1",
			resumed: true,
		});
		const resent = posted.filter((c) => c.type === "call");
		expect(resent).toHaveLength(sentBefore + 1);
		expect(resent.at(-1)).toMatchObject({ id: callId });
		void parked;
	});

	test("an attach_result without `resumed` leaves readiness to the priming that follows", () => {
		vi.useFakeTimers();
		const ws = onSession();
		posted.length = 0;
		dropAndRedial(ws);
		dispatch({
			type: "attach_result",
			id: attachCommands()[0]!.id,
			ok: true,
			workspaceId: "d1",
		});
		expect(state.readyAt).toBeUndefined();
		dispatch(attached("d1"));
		expect(state.sessionScope).toBeUndefined();
	});
});

describe("a history frame for the session on screen", () => {
	const turn = (n: number) => [userMsg(`q${n}`), assistantMsg(`a${n}`)];
	const text = () => state.items.map((it) => (it.kind === "user" ? it.text : it.kind));

	function onTranscript(...messages: unknown[]): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d1"));
		dispatch({ type: "history", messages } as never);
	}

	test("the same transcript keeps every item object", () => {
		onTranscript(...turn(1), ...turn(2));
		const shown = [...state.items];
		dispatch({ type: "history", messages: [...turn(1), ...turn(2)] } as never);
		expect(state.items).toHaveLength(4);
		state.items.forEach((item, i) => expect(item).toBe(shown[i]!));
	});

	test("an appended tail adds items and keeps the ones on screen", () => {
		onTranscript(...turn(1), ...turn(2));
		const shown = [...state.items];
		dispatch({ type: "history", messages: [...turn(1), ...turn(2), ...turn(3)] } as never);
		expect(text()).toEqual(["q1", "assistant", "q2", "assistant", "q3", "assistant"]);
		shown.forEach((item, i) => expect(state.items[i]).toBe(item));
	});

	test("a change keeps the unchanged prefix and rebuilds from the first difference", () => {
		onTranscript(...turn(1), ...turn(2), ...turn(3));
		const shown = [...state.items];
		dispatch({
			type: "history",
			messages: [...turn(1), userMsg("q2 edited"), assistantMsg("a2"), ...turn(3)],
		} as never);
		expect(text()).toEqual(["q1", "assistant", "q2 edited", "assistant", "q3", "assistant"]);
		expect(state.items[0]).toBe(shown[0]!);
		expect(state.items[1]).toBe(shown[1]!);
		expect(state.items[2]).not.toBe(shown[2]!);
		expect(state.items[4]).not.toBe(shown[4]!);
	});

	test("a shorter transcript drops the tail and keeps the rest", () => {
		onTranscript(...turn(1), ...turn(2));
		const shown = [...state.items];
		dispatch({ type: "history", messages: turn(1) } as never);
		expect(text()).toEqual(["q1", "assistant"]);
		expect(state.items[0]).toBe(shown[0]!);
		expect(state.items[1]).toBe(shown[1]!);
	});

	test("an unrelated transcript replaces everything", () => {
		onTranscript(...turn(1), ...turn(2));
		const shown = [...state.items];
		dispatch({ type: "history", messages: [userMsg("other"), assistantMsg("reply")] } as never);
		expect(text()).toEqual(["other", "assistant"]);
		expect(state.items[0]).not.toBe(shown[0]!);
	});

	test("items are numbered from the transcript, so a later push never reuses an id", () => {
		onTranscript(...turn(1), ...turn(2));
		dispatch({ type: "history", messages: [...turn(1), ...turn(2), ...turn(3)] } as never);
		const ids = state.items.map((it) => it.id);
		expect(new Set(ids).size).toBe(ids.length);
		dispatchSeq(
			{ type: "event", event: { type: "message_start", message: userMsg("live") } },
			1100,
		);
		const withLive = state.items.map((it) => it.id);
		expect(new Set(withLive).size).toBe(withLive.length);
	});
});

describe("the replay-dedup window", () => {
	test("remembers the most recent seqs and forgets the oldest past its capacity", () => {
		const window = new SeqWindow(3);
		for (const seq of [10, 11, 12]) window.add(seq);
		expect([10, 11, 12].every((seq) => window.has(seq))).toBe(true);
		window.add(13);
		expect(window.has(10)).toBe(false);
		expect([11, 12, 13].every((seq) => window.has(seq))).toBe(true);
		expect(window.size).toBe(3);
	});

	test("a seq added twice takes one slot", () => {
		const window = new SeqWindow(2);
		window.add(1);
		window.add(1);
		window.add(2);
		expect(window.has(1)).toBe(true);
		expect(window.size).toBe(2);
	});

	test("clear forgets everything and the window fills again to capacity", () => {
		const window = new SeqWindow(2);
		window.add(1);
		window.add(2);
		window.clear();
		expect(window.has(1)).toBe(false);
		for (const seq of [5, 6, 7]) window.add(seq);
		expect([5, 6, 7].map((seq) => window.has(seq))).toEqual([false, true, true]);
	});
});
