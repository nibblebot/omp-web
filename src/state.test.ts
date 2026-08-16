import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { OMP_PROTO, SSE_EVENT_NAME } from "../shared/protocol";
import type { ClientCommand, ServerFrame, SettingsModel, WebSessionState } from "../shared/protocol";
import { announce, attachSession, call, connect, pushNotice, refreshSettings, setState, state, updateSetting, type SubagentInfo } from "./state";

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
	/** Assigned by connect() like the real EventSource; tests invoke it. */
	onerror: (() => void) | null = null;
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
		debugLog: [],
		lastFrameAt: 0,
		reconnectDelay: 0,
		announcement: "",
		// Transcript items are per-session view state; without a reset a test
		// that attached (no switch → no resetSessionView) leaks its items into
		// the next test.
		items: [],
		streaming: false,
		workingIntent: undefined,
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

describe("client debug ring (transport observability)", () => {
	/** The attach command id posted by the last attachSession() call. */
	function lastAttachId(): string {
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");
		return cmd.id;
	}

	test("connect/open/teardown write ring entries; CLOSED onerror schedules the backoff retry", () => {
		vi.useFakeTimers();
		try {
			connect();
			expect(state.debugLog.at(-1)?.message).toBe("connecting /events");
			const es = FakeEventSource.instances.at(-1)!;
			es.onopen?.();
			expect(state.debugLog.at(-1)?.message).toBe("stream open");
			expect(state.reconnectDelay).toBe(0);

			// The stub carries no readyState, so onerror takes the terminal CLOSED
			// path (teardown + manual retry) rather than the transient-blip return.
			es.onerror?.();
			expect(state.connected).toBe(false);
			expect(state.reconnectDelay).toBe(1000);
			const messages = state.debugLog.map(e => e.message).join("\n");
			expect(messages).toContain("stream closed");
			expect(messages).toContain("connection lost — retrying in 1000ms");

			// The scheduled retry dials a fresh stream once the backoff elapses.
			vi.advanceTimersByTime(1000);
			expect(FakeEventSource.instances.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the ring is capped at 300 entries, oldest dropped", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		// daemon_status frames land one ring entry each; distinct daemon ids
		// make the cap's drop boundary observable in the messages.
		for (let i = 0; i < 320; i++) {
			dispatch({ type: "daemon_status", daemonId: `d${i}`, status: "ready" });
		}
		expect(state.debugLog.length).toBe(300);
		expect(state.debugLog[0].message).toContain("d20");
		expect(state.debugLog[299].message).toContain("d319");
	});

	test("attach/attach_result and error frames land ring entries", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch(attached("daemon-a"));
		expect(state.debugLog.at(-1)?.message).toBe("attached daemon-a");

		dispatch({ type: "error", error: "daemon connection lost" });
		expect(state.debugLog.at(-1)?.message).toBe("error frame: daemon connection lost");
		expect(state.debugLog.at(-1)?.level).toBe("error");

		const attach = attachSession("daemon-a");
		dispatch({ type: "attach_result", id: lastAttachId(), ok: true, sessionId: "daemon-a" });
		expect(state.debugLog.at(-1)?.message).toBe("attach ok: daemon-a");
		await expect(attach).resolves.toBe("daemon-a");

		// A failed attach writes a warn entry and rejects the caller.
		const bad = attachSession("daemon-b");
		dispatch({ type: "attach_result", id: lastAttachId(), ok: false, error: "unknown daemon: d9" });
		expect(state.debugLog.at(-1)?.message).toBe("attach failed: unknown daemon: d9");
		expect(state.debugLog.at(-1)?.level).toBe("warn");
		await expect(bad).rejects.toThrow("unknown daemon: d9");
	});
});

describe("fleet settings fallback (roster mode, no daemon attached)", () => {
	const model: SettingsModel = { tabs: [] };

	/** Drain the async fetch/.then/.finally chain (each hop is one microtask). */
	async function settle(): Promise<void> {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	}

	/** Swap globalThis.fetch for a JSON responder; records every request. */
	function stubFetch(
		respond: (url: string, init?: RequestInit) => { status: number; body: unknown },
	): Array<{ url: string; method: string; body?: unknown }> {
		const requests: Array<{ url: string; method: string; body?: unknown }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const { status, body } = respond(url, init);
			requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => body,
				text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
			} as unknown as Response;
		}) as unknown as typeof fetch;
		return requests;
	}

	test("refreshSettings GETs /ctl/settings and stores the model (no /command POST)", async () => {
		setState({ sessionMode: "roster", currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		const requests = stubFetch(() => ({ status: 200, body: model }));

		refreshSettings();
		await settle();

		expect(requests).toEqual([{ url: "/ctl/settings", method: "GET", body: undefined }]);
		expect(posted).toEqual([]); // nothing went over the /command uplink
		expect(state.settingsModel).toBe(model);
		expect(state.settingsLoading).toBe(false);
		expect(state.error).toBeNull();
	});

	test("updateSetting POSTs /ctl/settings/set with {path, value} and stores the response model", async () => {
		setState({ sessionMode: "roster", currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		const requests = stubFetch(() => ({ status: 200, body: model }));

		updateSetting("agent.model", "gpt-5");
		await settle();

		expect(requests).toEqual([
			{ url: "/ctl/settings/set", method: "POST", body: { path: "agent.model", value: "gpt-5" } },
		]);
		expect(posted).toEqual([]);
		expect(state.settingsModel).toBe(model);
		expect(state.error).toBeNull();
	});

	test("a non-ok /ctl/settings/set response surfaces the server {error} message in state.error", async () => {
		setState({ sessionMode: "roster", currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		stubFetch(() => ({ status: 400, body: { error: "unknown setting path" } }));

		updateSetting("bogus.path", 1);
		await settle();

		expect(state.error).toBe("unknown setting path");
		expect(state.settingsModel).toBeNull();
	});

	test("a non-ok /ctl/settings response surfaces the server error and leaves the model null", async () => {
		setState({ sessionMode: "roster", currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		stubFetch(() => ({ status: 500, body: "boom" }));

		refreshSettings();
		await settle();

		expect(state.error).toBe("boom");
		expect(state.settingsModel).toBeNull();
		expect(state.settingsLoading).toBe(false);
	});

	test("roster mode with a session attached keeps updateSetting on the /command call path (no /ctl fetch)", async () => {
		setState({ sessionMode: "single", currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.(); // connected = true so call() posts
		// Flip to the attached roster state AFTER the stream opens, so the
		// onopen auto-attach (roster + session) doesn't muddy the posted list.
		setState({ sessionMode: "roster", currentSessionId: "daemon-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();

		expect(requests.filter(r => r.url.startsWith("/ctl"))).toEqual([]); // no /ctl fetch in attached mode
		// The /command uplink carries the RPC (recorded by stubFetch, since it
		// replaced the beforeEach fetch stub that feeds `posted`).
		const calls = requests
			.filter(r => r.url === "/command")
			.map(r => r.body as Extract<ClientCommand, { type: "call" }>);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("setSetting");
		expect(calls[0].args).toEqual(["agent.model", "gpt-5"]);

		// Resolve the RPC so no dangling call timer survives the test. The
		// frame round-trips through JSON, so the model is a clone, not `model`.
		dispatch(callResult(calls[0].id, model));
		await settle();
		expect(state.settingsModel).toEqual(model);
	});
});

describe("state-frame application (model-role picker state)", () => {
	/** A complete `state` frame; `extra` overrides the role-picker fields under test. */
	function stateFrame(extra?: Partial<WebSessionState>): ServerFrame {
		const base: WebSessionState = {
			thinkingLevel: undefined,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			sessionId: "sess-1",
			autoCompactionEnabled: false,
			autoRetryEnabled: true,
			messageCount: 0,
			queuedMessageCount: 0,
			todoPhases: [],
			goalModeState: undefined,
			planModeEnabled: false,
			fastModeEnabled: false,
			computerToolEnabled: false,
			inspectImageMode: "auto",
			...(extra ?? {}),
		};
		return { type: "state", state: base };
	}

	test("modelRoleCatalog and modelRoleStorage mirror from a state frame alongside modelRoles", () => {
		connect();
		dispatch(
			stateFrame({
				modelRoles: [{ role: "default", provider: "anthropic", id: "claude-sonnet-4-5" }],
				modelRoleCatalog: [
					{ role: "default", name: "Default", hidden: false, provider: "anthropic", id: "claude-sonnet-4-5", source: "global" },
					{ role: "advisor", name: "Advisor", hidden: true, source: "default" },
				],
				modelRoleStorage: "project",
			}),
		);
		// The catalog/storage ride the same applyState path as modelRoles; the
		// frame round-trips through JSON, so expect structural equality.
		expect(state.modelRoles).toEqual([{ role: "default", provider: "anthropic", id: "claude-sonnet-4-5" }]);
		expect(state.modelRoleCatalog).toEqual([
			{ role: "default", name: "Default", hidden: false, provider: "anthropic", id: "claude-sonnet-4-5", source: "global" },
			{ role: "advisor", name: "Advisor", hidden: true, source: "default" },
		]);
		expect(state.modelRoleStorage).toBe("project");
	});

	test("a frame without role state clears the prior mirror (session-scoped, unlike the daemon roster)", () => {
		connect();
		dispatch(
			stateFrame({
				modelRoleCatalog: [{ role: "default", name: "Default", hidden: false, source: "default" }],
				modelRoleStorage: "global",
			}),
		);
		expect(state.modelRoleCatalog).toHaveLength(1);
		expect(state.modelRoleStorage).toBe("global");

		// A later snapshot without role state (e.g. taken before the catalog
		// could build) must reset the mirror, never keep stale entries.
		dispatch(stateFrame());
		expect(state.modelRoleCatalog).toBeUndefined();
		expect(state.modelRoleStorage).toBeUndefined();
		expect(state.modelRoles).toBeUndefined();
	});
});

describe("aria-live announcements (finding #P1)", () => {
	/** A fully primed stream: attached, empty history, readiness gate cleared. */
	function primeReady(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}

	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({ type: "event", event: { type: "agent_end", messages: [] } });

	test("an agent turn starting announces only after the session is ready", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		// Streaming flips during priming — no announcement until the gate clears.
		dispatchSeq(agentStart(), 1024);
		expect(state.streaming).toBe(true);
		expect(state.announcement).toBe("");

		// Post-readiness: turn end announces, and the next turn start does too.
		dispatch({ type: "ready", readyAt: 123 });
		dispatchSeq(agentEnd(), 1025);
		expect(state.announcement).toBe("agent finished");
		dispatchSeq(agentStart(), 1026);
		expect(state.announcement).toBe("agent started");
	});

	test("a tool run starting, completing, and failing announces its kind", () => {
		primeReady();
		dispatchSeq(
			{ type: "event", event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } } },
			1024,
		);
		expect(state.announcement).toBe("bash started");
		dispatchSeq(
			{ type: "event", event: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { output: "out" } } },
			1025,
		);
		expect(state.announcement).toBe("bash completed");
		// A failed run announces "failed" (the tool output itself is never announced).
		dispatchSeq(
			{ type: "event", event: { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "boom" } } },
			1026,
		);
		dispatchSeq(
			{ type: "event", event: { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { output: "" }, isError: true } },
			1027,
		);
		expect(state.announcement).toBe("bash failed");
	});

	test("an error notice announces its message; non-error notices stay silent", () => {
		primeReady();
		pushNotice("info", "not a status change");
		expect(state.announcement).toBe("");
		pushNotice("error", "nothing to retry");
		expect(state.announcement).toBe("nothing to retry");
	});

	test("two identical consecutive announcements collapse to one (consecutive-only dedupe)", () => {
		// The store field is the only observable here — Bun's runtime doesn't
		// propagate Solid 1.9 store notifications, so write-counting via an
		// effect would never fire. The field contract pins the dedupe: the
		// identical repeat is a no-op, and a repeat after an intervening message
		// re-announces (the region's content changed, so SRs hear it again).
		announce("tick");
		announce("tick"); // identical consecutive text → collapsed, no re-announce
		expect(state.announcement).toBe("tick");
		announce("tock");
		expect(state.announcement).toBe("tock");
		// Non-consecutive repeat of earlier text announces again.
		announce("tick");
		expect(state.announcement).toBe("tick");
	});
});

// ---------------------------------------------------------------------------
// workingIntent: the shimmer label's dynamic phrase (TUI setWorkingMessage
// parity). Sourced from tool_execution_start — the loop-resolved `intent`
// first, then the harness-injected `i` arg — and cleared with the turn.
// ---------------------------------------------------------------------------
describe("workingIntent (dynamic shimmer label)", () => {
	function primeReady(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}
	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({ type: "event", event: { type: "agent_end", messages: [] } });
	const toolStart = (toolCallId: string, extra: Record<string, unknown>): ServerFrame => ({
		type: "event",
		event: { type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "x.ts" }, ...extra },
	});

	test("loop-resolved intent wins; latest call's intent replaces it", () => {
		primeReady();
		dispatchSeq(agentStart(), 1024);
		expect(state.workingIntent).toBeUndefined();
		dispatchSeq(toolStart("t1", { intent: "Reading config files" }), 1025);
		expect(state.workingIntent).toBe("Reading config files");
		dispatchSeq(toolStart("t2", { intent: "Editing the parser" }), 1026);
		expect(state.workingIntent).toBe("Editing the parser");
	});

	test("falls back to the harness `i` arg when the event has no intent", () => {
		primeReady();
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(toolStart("t1", { args: { path: "x.ts", i: "Searching for shimmer styles" } }), 1025);
		expect(state.workingIntent).toBe("Searching for shimmer styles");
	});

	test("non-string intent payloads from partial JSON are ignored", () => {
		primeReady();
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(toolStart("t1", { intent: { partial: true } }), 1025);
		expect(state.workingIntent).toBeUndefined();
	});

	test("turn end and a fresh turn clear the intent", () => {
		primeReady();
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(toolStart("t1", { intent: "Reading config files" }), 1025);
		dispatchSeq(agentEnd(), 1026);
		expect(state.streaming).toBe(false);
		expect(state.workingIntent).toBeUndefined();
	});

	test("an idle state snapshot clears a stale intent from a pre-reconnect turn", () => {
		primeReady();
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(toolStart("t1", { intent: "Reading config files" }), 1025);
		// Reconnect primed against an idle daemon: the state frame says the turn
		// is over, so the last intent must not linger under the shimmer.
		dispatch({ type: "state", state: { isStreaming: false } as unknown as WebSessionState });
		expect(state.workingIntent).toBeUndefined();
	});
});
