import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OMP_PROTO, SSE_EVENT_NAME } from "../shared/protocol";
import type { ClientCommand, ServerFrame } from "../shared/protocol";
import { attachSession, call, connect, setState, state, type SubagentInfo } from "./state";

// ---------------------------------------------------------------------------
// Minimal /events transport double. connect() registers its SSE handler on a
// FakeEventSource; tests dispatch frames through it exactly like the real
// stream and capture POSTed /command bodies via a stubbed fetch.
// ---------------------------------------------------------------------------
type SseHandler = (ev: { data: string; lastEventId?: string }) => void;

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static handlers = new Map<string, SseHandler>();
	onopen: (() => void) | null = null;
	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: SseHandler): void {
		FakeEventSource.handlers.set(type, handler);
	}
	close(): void {}
	/** Dispatch one SSE event; `lastEventId` mirrors native EventSource's
	 *  MessageEvent.lastEventId (the wire `id:` field, e.g. "1024"). */
	static dispatch(type: string, data: string, lastEventId?: string): void {
		FakeEventSource.handlers.get(type)?.({ data, lastEventId });
	}
}

const posted: ClientCommand[] = [];

function attached(sessionId: string): ServerFrame {
	return { type: "attached", sessionId };
}

function callResult(id: string, data: unknown): ServerFrame {
	return { type: "call_result", id, ok: true, data };
}

function dispatch(frame: ServerFrame): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame));
}

/** Dispatch one frame stamped with an SSE id (priming seqs 1..k or delta seqs >= SSE_DELTA_SEQ_START). */
function dispatchSeq(frame: ServerFrame, seq: number): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame), String(seq));
}

function userMsg(text: string): { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number } {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMsg(text: string): { role: "assistant"; content: Array<{ type: "text"; text: string }> } {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultMsg(toolCallId: string): { role: "toolResult"; toolCallId: string; toolName: string; content: Array<{ type: "text"; text: string }> } {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "out" }] };
}

/** A completed turn as it appears in history: user prompt, assistant message with a tool call, tool result. */
function completedTurnHistory(): unknown[] {
	return [
		userMsg("q"),
		{
			role: "assistant",
			content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } }],
		},
		toolResultMsg("t1"),
	];
}

/** The same turn re-streamed as live event deltas (what a resume replays). */
function completedTurnEvents(): ServerFrame[] {
	const ev = (event: unknown): ServerFrame => ({ type: "event", event } as ServerFrame);
	return [
		ev({ type: "message_start", message: userMsg("q") }),
		ev({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } }),
		ev({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { output: "out" } }),
		ev({ type: "message_end", message: assistantMsg("a") }),
	];
}

function itemCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of state.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
	return counts;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function sub(status: string): SubagentInfo {
	return { id: "s1", index: 0, agent: "task", status, lastUpdate: 0 };
}

beforeEach(() => {
	posted.length = 0;
	FakeEventSource.instances.length = 0;
	FakeEventSource.handlers.clear();
	// Browser globals the store's transport touches; the Bun test runner has none.
	globalThis.location = { search: "" } as Location;
	globalThis.window = { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) } as unknown as Window & typeof globalThis;
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch;
	setState({
		currentSessionId: "",
		sessionMode: "single",
		connected: false,
		readyAt: undefined,
		subagents: new Map(),
		error: null,
		// Transcript items are per-session view state; without a reset a test
		// that attached (no switch → no resetSessionView) leaks its items into
		// the next test.
		items: [],
	});
});

// The transport stubs are global and would otherwise leak into sibling test
// files run in the same process (`bun test a.ts b.ts` without --parallel);
// restore the originals once this file's own tests are done.
const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.location = originalLocation;
	globalThis.window = originalWindow;
	globalThis.EventSource = originalEventSource;
	globalThis.fetch = originalFetch;
});

describe("attached-frame handling", () => {
	test("daemon switch rejects the old session's calls but the fresh getSubagents pull survives", async () => {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.(); // connected = true; without this call() fails fast

		// A previous-session call is in flight when the switch lands.
		const oldCall = call("getSettings");
		expect(posted.map(c => (c.type === "call" ? c.method : c.type))).toEqual(["getSettings"]);

		// First attach: no switch, so the pull is issued and nothing is rejected.
		dispatch(attached("session-a"));
		expect(posted.map(c => (c.type === "call" ? c.method : c.type))).toEqual(["getSettings", "getSubagents"]);

		// The switch lands: the old session's calls are rejected and readiness
		// drops (the moved cleanup block still runs).
		setState("readyAt", 123);
		dispatch(attached("session-b"));
		await expect(oldCall).rejects.toThrow("session switched");
		expect(state.readyAt).toBeUndefined();

		// A fresh getSubagents is issued AFTER the cleanup — the regression was
		// rejectPendingCalls killing the just-registered pull (swallowed by its
		// .catch), leaving the panel empty until a later lifecycle frame.
		const calls = posted.filter((c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call");
		expect(calls.map(c => c.method)).toEqual(["getSettings", "getSubagents", "getSubagents"]);
		const freshId = calls[2].id;

		// Stale answers to rejected calls are ignored — the panel stays empty.
		dispatch(callResult(calls[1].id, [sub("stale")]));
		await flushMicrotasks();
		expect(state.subagents.size).toBe(0);

		// The fresh call's answer populates the panel for the new session.
		dispatch(callResult(freshId, [sub("running")]));
		await flushMicrotasks();
		expect(state.subagents.get("s1")?.status).toBe("running");
		expect(state.currentSessionId).toBe("session-b");
	});
});

describe("replay dedup (finding #2: resume must not double-apply deltas)", () => {
	function primeAndStream(): void {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("a delta live-delivered during priming is not double-applied by the ring replay", async () => {
		primeAndStream();
		// A fresh prime with an empty transcript; a NEW turn streams live while
		// the paced prime is still in flight (delta seqs >= SSE_DELTA_SEQ_START).
		dispatchSeq({ type: "history", messages: [] }, 3);
		const events = completedTurnEvents(); // user q → tool t1 (done) → assistant a
		events.forEach((frame, i) => dispatchSeq(frame, 1024 + i));
		expect(itemCounts()).toEqual({ user: 1, assistant: 1, tool: 1 });
		expect(state.items.filter(it => it.kind === "tool")[0]).toMatchObject({ toolCallId: "t1", status: "done" });

		// The ring replay re-sends those exact frames (same seqs) after
		// `ready`. Pre-guard, every item would double and a second tool card
		// would strand running (tool_execution_end resolves the FIRST match).
		events.forEach((frame, i) => dispatchSeq(frame, 1024 + i));
		expect(itemCounts()).toEqual({ user: 1, assistant: 1, tool: 1 });
		expect(state.items.filter(it => it.kind === "tool")[0]).toMatchObject({ toolCallId: "t1", status: "done" });
	});

	test("a delta live-delivered BEFORE the history rebuild is re-applied exactly once by the replay", async () => {
		primeAndStream();
		// Multi-chunk prime: a live delta lands between history chunks, so the
		// final chunk's loadHistory rebuild wipes its item; the ring replay
		// must re-deliver it (its seq was cleared by the rebuild), exactly once.
		dispatchSeq({ type: "event", event: { type: "message_start", message: userMsg("q") } }, 1024);
		expect(itemCounts()).toEqual({ user: 1 });
		dispatchSeq({ type: "history", messages: [] }, 3); // final chunk → rebuild wipes the live item
		expect(itemCounts()).toEqual({});
		dispatchSeq({ type: "event", event: { type: "message_start", message: userMsg("q") } }, 1024); // replay
		expect(itemCounts()).toEqual({ user: 1 });
		// And a SECOND replay copy is deduped like any other re-seen seq.
		dispatchSeq({ type: "event", event: { type: "message_start", message: userMsg("q") } }, 1024);
		expect(itemCounts()).toEqual({ user: 1 });
	});
});

describe("attach correlation (finding #28)", () => {
	/** The attach command posted by the last attachSession() call. */
	function lastAttach(): Extract<ClientCommand, { type: "attach" }> {
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");
		return cmd;
	}

	test("an unrelated global error frame does not reject an in-flight attach; the keyed attach_result settles it", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.(); // connected = true

		const attach = attachSession("daemon-a");
		const { id } = lastAttach();

		// A global error (e.g. ANOTHER daemon's pipe lost, or a spawn failure)
		// while this attach is in flight must not reject it — global errors are
		// uncorrelated broadcasts; only the id-keyed attach_result settles it.
		dispatch({ type: "error", error: "daemon connection lost" });
		let settled = false;
		void attach.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushMicrotasks();
		expect(settled).toBe(false);

		dispatch({ type: "attach_result", id, ok: true, sessionId: "daemon-a" });
		await expect(attach).resolves.toBe("daemon-a");
	});

	test("a keyed attach_result failure rejects the attach", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const attach = attachSession("daemon-b");
		const { id } = lastAttach();

		dispatch({ type: "attach_result", id, ok: false, error: "unknown daemon: d9" });
		await expect(attach).rejects.toThrow("unknown daemon: d9");
	});

	test("a stale attach_result for a superseded attach never settles the new waiter", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		// Latest-wins: the second attach supersedes the first (which resolves
		// immediately with whatever session is current — still "" here).
		const first = attachSession("daemon-a");
		const firstCmd = lastAttach();
		const second = attachSession("daemon-b");
		const secondCmd = lastAttach();
		expect(firstCmd.id).not.toBe(secondCmd.id);
		await expect(first).resolves.toBe("");

		// The superseded attach's keyed result must not settle the second waiter.
		dispatch({ type: "attach_result", id: firstCmd.id, ok: true, sessionId: "daemon-a" });
		let settled = false;
		void second.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushMicrotasks();
		expect(settled).toBe(false);

		dispatch({ type: "attach_result", id: secondCmd.id, ok: true, sessionId: "daemon-b" });
		await expect(second).resolves.toBe("daemon-b");
	});
});

describe("ui_request_end dismissal (finding #16)", () => {
	test("a settled dialog's ui_request_end dismisses it; ends for other ids leave it open", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch({ type: "ui_request", id: "ui1", method: "confirm", params: { title: "t", message: "m" } });
		expect(state.uiRequest?.id).toBe("ui1");
		// An end for a different (already-superseded) id must not close the
		// dialog currently shown.
		dispatch({ type: "ui_request_end", id: "ui0" });
		expect(state.uiRequest?.id).toBe("ui1");
		dispatch({ type: "ui_request_end", id: "ui1" });
		expect(state.uiRequest).toBeNull();
	});
});

describe("hello_ok proto gate (finding #61)", () => {
	test("hello_ok with a mismatched proto is terminal: error + teardown, no reconnect loop", () => {
		connect();
		const es = FakeEventSource.instances.at(-1)!;
		es.onopen?.();
		expect(state.connected).toBe(true);
		dispatch({ type: "hello_ok", proto: 1, name: "old", cwd: "/x", pid: 1, version: "0.0.0" });
		expect(state.error).toContain("proto mismatch");
		expect(state.error).toContain("expected 2");
		expect(state.connected).toBe(false);
		// Fail-closed: the stream is torn down and NO reconnect is scheduled
		// (a second connect() would create a second FakeEventSource).
		expect(FakeEventSource.instances.length).toBe(1);
	});

	test("hello_ok with the current proto is accepted", () => {
		connect();
		const es = FakeEventSource.instances.at(-1)!;
		es.onopen?.();
		expect(state.connected).toBe(true);
		dispatch({ type: "hello_ok", proto: OMP_PROTO, name: "ok", cwd: "/x", pid: 1, version: "0.0.0" });
		expect(state.error).toBeNull();
		expect(state.connected).toBe(true);
	});
});

describe("subagent placeholder migration (finding #30)", () => {
	test("progress before lifecycle migrates the placeholder into the real-id entry, preserving its data", () => {
		connect();
		// Progress lands first: the handler creates a `progress-3` placeholder.
		dispatch({ type: "subagent_progress", payload: { index: 3, agent: "task", task: "deploy the fleet", progress: { status: "running" } } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-3")?.status).toBe("running");

		// The lifecycle frame (no status field) arrives later: it must migrate
		// the placeholder rather than insert a second row with the same index.
		dispatch({ type: "subagent_lifecycle", payload: { id: "sub-7", index: 3, agent: "task" } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-3")).toBeUndefined();
		const entry = state.subagents.get("sub-7");
		expect(entry).toBeDefined();
		expect(entry?.index).toBe(3);
		expect(entry?.agent).toBe("task");
		expect(entry?.task).toBe("deploy the fleet");
		expect(entry?.status).toBe("running");
	});

	test("later progress frames update the migrated real entry, never a placeholder", () => {
		connect();
		dispatch({ type: "subagent_progress", payload: { index: 2, agent: "task", task: "t", progress: { status: "running" } } });
		dispatch({ type: "subagent_lifecycle", payload: { id: "sub-9", index: 2, status: "started" } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("sub-9")?.status).toBe("started");

		// The next progress frame must find the REAL entry (same index), not
		// resurrect the placeholder, and the strip stays at one row.
		dispatch({ type: "subagent_progress", payload: { index: 2, task: "t2", progress: { status: "running" } } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-2")).toBeUndefined();
		expect(state.subagents.get("sub-9")?.status).toBe("running");
		expect(state.subagents.get("sub-9")?.task).toBe("t2");
	});

	test("lifecycle-first ordering is unchanged", () => {
		connect();
		dispatch({ type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "task", status: "started" } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("sub-1")?.status).toBe("started");

		dispatch({ type: "subagent_progress", payload: { index: 0, task: "t", progress: { status: "running" } } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-0")).toBeUndefined();
		expect(state.subagents.get("sub-1")?.status).toBe("running");
		expect(state.subagents.get("sub-1")?.task).toBe("t");
	});
});
