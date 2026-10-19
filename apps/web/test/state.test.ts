import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { OMP_PROTO } from "#lib/wire/protocol";
import type {
	ClientCommand,
	DaemonEntry,
	RegisteredProject,
	ServerFrame,
	SessionListEntry,
	SettingsModel,
	WebSessionState,
} from "#lib/wire/protocol";
import { FEATURE_IDS, type FeatureId } from "../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../features/registry";
import { pruneUnread, unreadIds } from "../fleet-ui/unread";
import { rejectPendingAttach, rejectPendingCalls } from "../store/transport";
import { attachForPanel } from "../store/roster";
import {
	addProject,
	announce,
	attachSession,
	call,
	connectionState,
	closeDrawers,
	connect,
	createClone,
	createWorktree,
	daemonsByProject,
	deleteQueuedMessage,
	hasLiveSession,
	initialView,
	isUserStopped,
	listProjectBranches,
	pushNotice,
	refreshSettings,
	restartDaemonById,
	sendDeleteWorktree,
	sendRemoveProject,
	sendWorktreeDeleteInfo,
	syncProjects,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	setView,
	spawnResume,
	stopDaemonById,
	state,
	updateSetting,
	requestDaemonSessions,
	resumeDaemonSession,
	startDaemonNewSession,
	type SubagentInfo,
} from "../state";
import { resetPendingProjects } from "../store/projects";
import { settingValue } from "../store/settings";
import { reportError } from "../store/toasts";
import {
	FakeEventSource,
	attached,
	assistantMsg,
	callResult,
	dispatch,
	dispatchSeq,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	itemCounts,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
	userMsg,
} from "./web.testkit";

function toolResultMsg(toolCallId: string): {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
} {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "out" }],
	};
}

/** A completed turn as it appears in history: user prompt, assistant message with a tool call, tool result. */
function completedTurnHistory(): unknown[] {
	return [
		userMsg("q"),
		{
			role: "assistant",
			content: [
				{ type: "text", text: "a" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } },
			],
		},
		toolResultMsg("t1"),
	];
}

/** The same turn re-streamed as live event deltas (what a resume replays). */
function completedTurnEvents(): ServerFrame[] {
	const ev = (event: unknown): ServerFrame => ({ type: "event", event }) as ServerFrame;
	return [
		ev({ type: "message_start", message: userMsg("q") }),
		ev({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
		}),
		ev({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { output: "out" },
		}),
		ev({ type: "message_end", message: assistantMsg("a") }),
	];
}

function sub(status: string): SubagentInfo {
	return { id: "s1", index: 0, agent: "task", status, lastUpdate: 0 };
}

let baselineFeatures: FeatureId[];
let baselineToasts: typeof state.toasts;
let baselinePlanModeEnabled: typeof state.planModeEnabled;

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	baselineToasts = [...state.toasts];
	baselinePlanModeEnabled = state.planModeEnabled;
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
	setState("toasts", baselineToasts);
	setState("planModeEnabled", baselinePlanModeEnabled);
});

beforeEach(() => {
	installTransportStubs();
	setState({
		currentSessionId: "",
		connected: false,
		readyAt: undefined,
		subagents: new Map(),
		error: null,
		debugLog: [],
		lastFrameAt: 0,
		reconnectDelay: 0,
		announcement: "",
		// Transcript pin mirror + unviewed-answer flag (useStickyScroll /
		// agent_end in store/chat.ts); reset for isolation.
		chatPinned: true,
		answerUnviewed: false,
		// Toasts are fleet/app-scoped ephemeral UI state; reset for isolation
		// like the fleet-scoped collections above (and their dismiss timers
		// only ever remove their own id, so a stale timer is a no-op).
		toasts: [],
		// Transcript items are per-session view state; without a reset a test
		// that attached (no switch → no resetSessionView) leaks its items into
		// the next test.
		items: [],
		streaming: false,
		workingIntent: undefined,
		// Phase 5 fleet-scoped + modal state: reset for isolation like the rest
		// (roster frames / picker-gate tests otherwise leak into each other).
		daemonRoster: [],
		daemonActivity: {},
		registeredProjects: [],
		providerProfiles: [],
		fleetConfigPath: null,
		worktreeDeleteInfo: {},
		pendingSessionPicker: null,
		sessionPickerGate: null,
		newWorkspaceProjectId: null,
		highlightProjectId: null,
		deleteWorkspaceTarget: null,
		removeProjectTarget: null,
		lightboxImage: null,
		daemonDetailsId: null,
		modal: null,
		// Top-level view mode + its UI flags (setView / setTxSidebarVisible /
		// chatUnviewed); reset for isolation.
		view: "chat",
		chatUnviewed: false,
		txSidebarVisible: true,
		modelSynced: false,
	});
});

// Browser doubles are process-global (see web.testkit.ts) and would otherwise
// leak into sibling test files run in the same process. Restore them after each
// test, including test-specific overrides. Unanswered calls (e.g. the boot and
// attach settings loads) are settled first so their replay timers never fire
// after `window` is gone.
afterEach(() => {
	rejectPendingCalls(new Error("test teardown"));
	restoreBrowserGlobals();
});

describe("attached-frame handling", () => {
	test("daemon switch rejects the old session's calls but the fresh getSubagents pull survives", async () => {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.(); // connected = true; without this call() fails fast

		// A previous-session call is in flight when the switch lands.
		const oldCall = call("getSettings");
		expect(posted.map((c) => (c.type === "call" ? c.method : c.type))).toEqual(["getSettings"]);

		// First attach: no switch, so the pull is issued and nothing is rejected.
		dispatch(attached("session-a"));
		expect(posted.map((c) => (c.type === "call" ? c.method : c.type))).toEqual([
			"getSettings",
			"getSubagents",
			"getSettings", // attach re-pulls the settings model (refreshSettings)
		]);

		// The switch lands: the old session's calls are rejected and readiness
		// drops (the moved cleanup block still runs).
		setState("readyAt", 123);
		dispatch(attached("session-b"));
		await expect(oldCall).rejects.toThrow("session switched");
		expect(state.readyAt).toBeUndefined();

		// A fresh getSubagents is issued AFTER the cleanup. The regression was
		// rejectPendingCalls killing the just-registered pull (swallowed by its
		// .catch), leaving the panel empty until a later lifecycle frame.
		const calls = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call",
		);
		expect(calls.map((c) => c.method)).toEqual([
			"getSettings",
			"getSubagents",
			"getSettings",
			"getSubagents",
			"getSettings",
		]);
		const freshId = calls[3].id;

		// Stale answers to rejected calls are ignored; the panel stays empty.
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
		expect(state.items.filter((it) => it.kind === "tool")[0]).toMatchObject({
			toolCallId: "t1",
			status: "done",
		});

		// The ring replay re-sends those exact frames (same seqs) after
		// `ready`. Pre-guard, every item would double and a second tool card
		// would strand running (tool_execution_end resolves the FIRST match).
		events.forEach((frame, i) => dispatchSeq(frame, 1024 + i));
		expect(itemCounts()).toEqual({ user: 1, assistant: 1, tool: 1 });
		expect(state.items.filter((it) => it.kind === "tool")[0]).toMatchObject({
			toolCallId: "t1",
			status: "done",
		});
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

describe("advisor notes render inline (TUI advisor card parity)", () => {
	beforeAll(async () => {
		await activateFeatures(["advisor"]);
	});

	const notes = [
		{ note: "check the null path", severity: "concern" },
		{ note: "ship it", advisor: "reviewer", turnsAgo: 2 },
	];
	const advisorMsg = {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "<advisory>…</advisory>",
		details: { notes },
		timestamp: 0,
	};

	function primed(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("history: advisor messages become advisor items; other custom messages stay hidden", () => {
		primed();
		dispatch({
			type: "history",
			messages: [
				userMsg("q"),
				advisorMsg,
				{
					role: "custom",
					customType: "loop-continuation",
					display: false,
					content: "x",
					timestamp: 0,
				},
				assistantMsg("a"),
			],
		} as ServerFrame);
		expect(state.items.map((it) => it.kind)).toEqual(["user", "advisor", "assistant"]);
		expect(state.items[1]).toMatchObject({ kind: "advisor", notes });
	});

	test("live: a steered/preserved advisor card (message_start + message_end) lands exactly once", () => {
		primed();
		dispatch({ type: "history", messages: [] });
		const ev = (event: unknown): ServerFrame => ({ type: "event", event }) as ServerFrame;
		dispatch(ev({ type: "message_start", message: advisorMsg }));
		dispatch(ev({ type: "message_end", message: advisorMsg }));
		expect(itemCounts()).toEqual({ advisor: 1 });
		expect(state.items[0]).toMatchObject({ kind: "advisor", notes });
	});
});

describe("history: bang-shell and python runs render as settled cards", () => {
	test("bashExecution and pythonExecution messages become bash items", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
		dispatch({
			type: "history",
			messages: [
				userMsg("q"),
				{
					role: "bashExecution",
					command: "echo hi",
					output: "hi\n",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 0,
				},
				{
					role: "bashExecution",
					command: "sleep 9",
					output: "",
					cancelled: true,
					truncated: true,
					excludeFromContext: true,
					timestamp: 0,
				},
				{
					role: "pythonExecution",
					code: "print(1)",
					output: "1\n",
					exitCode: 1,
					cancelled: false,
					truncated: false,
					timestamp: 0,
				},
			],
		} as ServerFrame);
		expect(state.items.map((it) => it.kind)).toEqual(["user", "bash", "bash", "bash"]);
		expect(state.items.slice(1)).toMatchObject([
			{
				command: "echo hi",
				lang: "bash",
				dimmed: false,
				status: "done",
				output: "hi\n",
				exitCode: 0,
			},
			{ command: "sleep 9", lang: "bash", dimmed: true, exitCode: null, truncated: true },
			{ command: "print(1)", lang: "python", dimmed: false, output: "1\n", exitCode: 1 },
		]);
	});
});

describe("replayed mid-ask transcript (an ask card must not read done while pending)", () => {
	/** A transcript as the session saves it mid-ask: the call is recorded, its result is not yet. */
	const pendingAskHistory = (): unknown[] => [
		userMsg("q"),
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "a1", name: "ask", arguments: { questions: [] } }],
		},
	];

	function primeAttached(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("an ask still awaiting its answer stays running while the turn streams", () => {
		primeAttached();
		dispatch({ type: "history", messages: pendingAskHistory() } as ServerFrame);
		dispatch({ type: "state", state: { isStreaming: true } as unknown as WebSessionState });
		expect(state.items.find((it) => it.kind === "tool")).toMatchObject({
			name: "ask",
			status: "running",
		});
	});

	test("a dangling tool call in an idle transcript settles to done", () => {
		primeAttached();
		dispatch({ type: "history", messages: pendingAskHistory() } as ServerFrame);
		dispatch({ type: "state", state: { isStreaming: false } as unknown as WebSessionState });
		expect(state.items.find((it) => it.kind === "tool")).toMatchObject({ status: "done" });
	});

	test("an answered ask keeps its recorded result status while the turn streams", () => {
		primeAttached();
		dispatch({
			type: "history",
			messages: [...pendingAskHistory(), toolResultMsg("a1")],
		} as ServerFrame);
		dispatch({ type: "state", state: { isStreaming: true } as unknown as WebSessionState });
		expect(state.items.find((it) => it.kind === "tool")).toMatchObject({ status: "done" });
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
		// while this attach is in flight must not reject it; global errors are
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
		// immediately with whatever session is current, still "" here).
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
		dispatch({
			type: "ui_request",
			id: "ui1",
			method: "confirm",
			params: { title: "t", message: "m" },
		});
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
		expect(state.error).toContain("expected 4");
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
		dispatch({
			type: "hello_ok",
			proto: OMP_PROTO,
			name: "ok",
			cwd: "/x",
			pid: 1,
			version: "0.0.0",
		});
		expect(state.error).toBeNull();
		expect(state.connected).toBe(true);
	});
});

describe("subagent placeholder migration (finding #30)", () => {
	test("progress before lifecycle migrates the placeholder into the real-id entry, preserving its data", () => {
		connect();
		// Progress lands first: the handler creates a `progress-3` placeholder.
		dispatch({
			type: "subagent_progress",
			payload: {
				index: 3,
				agent: "task",
				task: "deploy the fleet",
				progress: { status: "running" },
			},
		});
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
		dispatch({
			type: "subagent_progress",
			payload: { index: 2, agent: "task", task: "t", progress: { status: "running" } },
		});
		dispatch({ type: "subagent_lifecycle", payload: { id: "sub-9", index: 2, status: "started" } });
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("sub-9")?.status).toBe("started");

		// The next progress frame must find the REAL entry (same index), not
		// resurrect the placeholder, and the strip stays at one row.
		dispatch({
			type: "subagent_progress",
			payload: { index: 2, task: "t2", progress: { status: "running" } },
		});
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-2")).toBeUndefined();
		expect(state.subagents.get("sub-9")?.status).toBe("running");
		expect(state.subagents.get("sub-9")?.task).toBe("t2");
	});

	test("lifecycle-first ordering is unchanged", () => {
		connect();
		dispatch({
			type: "subagent_lifecycle",
			payload: { id: "sub-1", index: 0, agent: "task", status: "started" },
		});
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("sub-1")?.status).toBe("started");

		dispatch({
			type: "subagent_progress",
			payload: { index: 0, task: "t", progress: { status: "running" } },
		});
		expect(state.subagents.size).toBe(1);
		expect(state.subagents.get("progress-0")).toBeUndefined();
		expect(state.subagents.get("sub-1")?.status).toBe("running");
		expect(state.subagents.get("sub-1")?.task).toBe("t");
	});

	test("progress keys on the SDK subagent id, so equal indexes from two task calls stay distinct", () => {
		connect();
		for (const [id, call] of [
			["Owl", "call-a"],
			["Wren", "call-b"],
		]) {
			dispatch({
				type: "subagent_lifecycle",
				payload: { id, index: 0, agent: "task", status: "started", parentToolCallId: call },
			});
		}
		dispatch({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "task",
				task: "wren task",
				parentToolCallId: "call-b",
				progress: { id: "Wren", status: "running" },
			},
		});
		expect(state.subagents.size).toBe(2);
		expect(state.subagents.get("Owl")?.status).toBe("started");
		expect(state.subagents.get("Owl")?.task).toBeUndefined();
		expect(state.subagents.get("Wren")?.status).toBe("running");
		expect(state.subagents.get("Wren")?.task).toBe("wren task");
	});

	test("progress replaces the entry object so identity-keyed rows re-render", () => {
		connect();
		dispatch({
			type: "subagent_lifecycle",
			payload: { id: "Owl", index: 0, agent: "task", status: "started" },
		});
		const before = state.subagents.get("Owl");
		dispatch({
			type: "subagent_progress",
			payload: { index: 0, task: "t", progress: { id: "Owl", status: "running" } },
		});
		const after = state.subagents.get("Owl");
		expect(after).not.toBe(before);
		expect(before?.status).toBe("started");
		expect(after?.status).toBe("running");
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
			const messages = state.debugLog.map((e) => e.message).join("\n");
			expect(messages).toContain("stream closed");
			expect(messages).toContain("connection lost, retrying in 1000ms");

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

describe("fleet settings fallback (no daemon attached)", () => {
	const model: SettingsModel = { tabs: [] };

	/** Drain the async fetch/.then/.finally chain (each hop is one microtask); the write queue adds a few. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 32; i++) await Promise.resolve();
	}

	/** Swap globalThis.fetch for a JSON responder; records every request. */
	function stubFetch(
		respond: (url: string, init?: RequestInit) => { status: number; body: unknown },
	): Array<{ url: string; method: string; body?: unknown }> {
		const requests: Array<{ url: string; method: string; body?: unknown }> = [];
		setBrowserGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const { status, body } = respond(url, init);
			requests.push({
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => body,
				text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
			} as unknown as Response;
		}) as unknown as typeof fetch);
		return requests;
	}

	test("refreshSettings GETs /ctl/settings and stores the model (no /command POST)", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
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
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch(() => ({ status: 200, body: model }));

		expect(await updateSetting("agent.model", "gpt-5")).toBe(true);
		await settle();

		expect(requests).toEqual([
			{ url: "/ctl/settings/set", method: "POST", body: { path: "agent.model", value: "gpt-5" } },
		]);
		expect(posted).toEqual([]);
		expect(state.settingsModel).toBe(model);
		expect(state.error).toBeNull();
	});

	test("a non-ok /ctl/settings/set response surfaces the server {error} message in state.error", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		stubFetch(() => ({ status: 400, body: { error: "unknown setting path" } }));

		expect(await updateSetting("bogus.path", 1)).toBe(false);
		await settle();

		expect(state.error).toBe("unknown setting path");
		expect(state.settingsModel).toBeNull();
	});

	test("a revision-conflict 409 on /ctl/settings/set refetches the settings model so the next write is current", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch((url) => {
			if (url === "/ctl/settings/set") {
				return { status: 409, body: { error: "Settings changed; refresh before editing." } };
			}
			return { status: 200, body: model };
		});

		expect(await updateSetting("advisor.enabled", true)).toBe(false);
		await settle();

		expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
			"POST /ctl/settings/set",
			"GET /ctl/settings",
		]);
		expect(state.settingsModel).toBe(model);
	});

	test("a non-ok /ctl/settings response surfaces the server error and leaves the model null", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		stubFetch(() => ({ status: 500, body: "boom" }));

		refreshSettings();
		await settle();

		expect(state.error).toBe("boom");
		expect(state.settingsModel).toBeNull();
		expect(state.settingsLoading).toBe(false);
	});

	test("with a session attached, updateSetting stays on the /command call path (no /ctl fetch)", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.(); // connected = true so call() posts
		// Flip to an attached state AFTER the stream opens. onopen's boot refresh
		// is a GET /ctl/settings, which the assertion below excludes.
		setState({ currentSessionId: "daemon-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();

		expect(requests.filter((r) => r.url.startsWith("/ctl") && r.method !== "GET")).toEqual([]); // no /ctl write while attached
		// The /command uplink carries the RPC (recorded by stubFetch, since it
		// replaced the beforeEach fetch stub that feeds `posted`).
		const calls = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("setSetting");
		expect(calls[0].args).toEqual(["agent.model", "gpt-5", null, null, "revision"]);

		// Resolve the RPC so no dangling call timer survives the test. The
		// frame round-trips through JSON, so the model is a clone, not `model`.
		dispatch(callResult(calls[0].id, model));
		await settle();
		expect(state.settingsModel).toEqual(model);
	});

	test("a revision-reply write applies the pushed model and does not refetch when it arrived", async () => {
		setState({ currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState({ currentSessionId: "daemon-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();
		const write = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>)
			.find((c) => c.method === "setSetting")!;
		expect(write.args).toEqual(["agent.model", "gpt-5", null, null, "revision"]);

		const next: SettingsModel = { tabs: [], revision: 12 };
		dispatch({ type: "settings_changed", model: next });
		dispatch(callResult(write.id, { revision: 12 }));
		await settle();
		expect(state.settingsModel).toEqual(next);
		const reads = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>)
			.filter((c) => c.method === "getSettings");
		expect(reads).toEqual([]);
	});

	test("a revision reply ahead of the pushed model refetches the full model", async () => {
		setState({ currentSessionId: "", settingsModel: null, settingsLoading: false, error: null });
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState({ currentSessionId: "daemon-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();
		const write = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>)
			.find((c) => c.method === "setSetting")!;
		dispatch(callResult(write.id, { revision: 13 }));
		await settle();
		const read = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>)
			.find((c) => c.method === "getSettings");
		expect(read).toBeDefined();
		dispatch(callResult(read!.id, { tabs: [], revision: 13 }));
		await settle();
		expect(state.settingsModel?.revision).toBe(13);
	});

	test("queued writes run one at a time, each sending the revision the previous response produced", async () => {
		setState({
			currentSessionId: "",
			settingsModel: { tabs: [], revision: 7 },
			settingsLoading: false,
			error: null,
		});
		let nextRevision = 8;
		const requests = stubFetch(() => ({
			status: 200,
			body: { tabs: [], revision: nextRevision++ },
		}));

		// Both calls land before the first response, the case that used to share revision 7.
		updateSetting("agent.model", "a");
		updateSetting("agent.model", "b");
		for (let i = 0; i < 40; i++) await Promise.resolve();

		const revisions = requests.map((r) => {
			const body = r.body;
			return body && typeof body === "object" && "expectedRevision" in body
				? body.expectedRevision
				: undefined;
		});
		expect(revisions).toEqual([7, 8]);
		expect(state.settingsModel?.revision).toBe(9);
		expect(state.error).toBeNull();
	});

	test("a rejected session write surfaces its message once, without a doubled Error prefix", async () => {
		setState({
			currentSessionId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState({ currentSessionId: "daemon-a" });

		updateSetting("display.hideToolActivity", true, 3);
		await settle();
		const sent = requests
			.filter((r) => r.url === "/command")
			.map((r) => r.body as Extract<ClientCommand, { type: "call" }>);
		dispatch(
			callResult(sent.at(-1)!.id, undefined, false, "Settings changed; refresh before editing."),
		);
		await settle();
		expect(state.error).toBe("Settings changed; refresh before editing.");
	});
});

describe("settings_changed revision guard and settingValue()", () => {
	/** A one-item model whose agent.model value is `value` at `revision`. */
	function modelAt(revision: number, value: string): SettingsModel {
		return {
			revision,
			target: "current-session",
			tabs: [
				{
					id: "agent",
					label: "Agent",
					groups: [
						{
							name: "Model",
							items: [
								{
									path: "agent.model",
									label: "Model",
									description: "",
									type: "enum",
									value,
									changed: false,
								},
							],
						},
					],
				},
			],
		};
	}

	test("an older settings_changed frame is ignored; a newer one applies", () => {
		// Attached before connect(): the onopen boot refresh is for the fleet
		// path and must not run here.
		setState({ currentSessionId: "daemon-a", settingsModel: null });
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({ type: "settings_changed", model: modelAt(5, "gpt-5") });
		expect(state.settingsModel?.revision).toBe(5);

		dispatch({ type: "settings_changed", model: modelAt(4, "gpt-4") });
		expect(state.settingsModel?.revision).toBe(5);
		expect(settingValue<string>("agent.model")).toBe("gpt-5");

		dispatch({ type: "settings_changed", model: modelAt(6, "o3") });
		expect(state.settingsModel?.revision).toBe(6);
		expect(settingValue<string>("agent.model")).toBe("o3");
	});

	test("settingValue reads the current model and follows replacements", () => {
		setState({ currentSessionId: "daemon-a", settingsModel: null });
		expect(settingValue("agent.model")).toBeUndefined();

		setState({ settingsModel: modelAt(1, "gpt-5") });
		expect(settingValue<string>("agent.model")).toBe("gpt-5");
		expect(settingValue("no.such.path")).toBeUndefined();

		setState({ settingsModel: modelAt(2, "o3") });
		expect(settingValue<string>("agent.model")).toBe("o3");
	});
});

describe("state-frame application (model-role picker state)", () => {
	/** A complete `state` frame; `extra` overrides the role-picker fields under test. */
	function stateFrame(extra?: Partial<WebSessionState>): ServerFrame {
		const base: WebSessionState = {
			thinkingLevel: undefined,
			isStreaming: false,
			isCompacting: false,
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
					{
						role: "default",
						name: "Default",
						hidden: false,
						provider: "anthropic",
						id: "claude-sonnet-4-5",
						source: "global",
					},
					{ role: "advisor", name: "Advisor", hidden: true, source: "default" },
				],
				modelRoleStorage: "project",
			}),
		);
		// The catalog/storage ride the same applyState path as modelRoles; the
		// frame round-trips through JSON, so expect structural equality.
		expect(state.modelRoles).toEqual([
			{ role: "default", provider: "anthropic", id: "claude-sonnet-4-5" },
		]);
		expect(state.modelRoleCatalog).toEqual([
			{
				role: "default",
				name: "Default",
				hidden: false,
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				source: "global",
			},
			{ role: "advisor", name: "Advisor", hidden: true, source: "default" },
		]);
		expect(state.modelRoleStorage).toBe("project");
	});

	test("a waiting plan review opens the sheet once, on the false-to-true edge only", () => {
		connect();
		dispatch(stateFrame({ planReviewPending: true }));
		expect(state.planReviewPending).toBe(true);
		expect(state.modal).toBe("plan-review");
		// The operator dismisses; a re-broadcast of the same pending review must not reopen it.
		setState("modal", null);
		dispatch(stateFrame({ planReviewPending: true }));
		expect(state.modal).toBeNull();
		dispatch(stateFrame({ planReviewPending: false }));
		expect(state.planReviewPending).toBe(false);
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

	test("modelSynced holds the empty-state character until the loaded transcript's state lands", () => {
		const model = (id: string) =>
			({ provider: "anthropic", id }) as unknown as WebSessionState["model"];
		connect();
		// Priming sends history BEFORE state: on first attach the model is
		// still unknown, so nothing may render a (fallback) character yet.
		dispatch(attached("daemon-a"));
		dispatch({ type: "history", messages: [] });
		expect(state.modelSynced).toBe(false);
		dispatch(stateFrame({ model: model("gpt-5") }));
		expect(state.modelSynced).toBe(true);

		// newSession resync: the empty history lands while state.model is still
		// the previous session's; the new session's default model follows.
		dispatch({ type: "history", messages: [] });
		expect(state.modelSynced).toBe(false);
		expect(state.model?.id).toBe("gpt-5");
		dispatch(stateFrame({ model: model("claude-opus-5-5") }));
		expect(state.modelSynced).toBe(true);

		// A daemon switch drops the sync before the new daemon's priming.
		dispatch(attached("daemon-b"));
		expect(state.modelSynced).toBe(false);
	});
});

describe("answerUnviewed (turn ended below the viewport)", () => {
	/** A fully primed stream: attached, empty history, readiness gate cleared. */
	function primeReady(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}
	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end", messages: [] },
	});

	test("agent_end while the transcript is pinned → not flagged (the answer was in view)", () => {
		primeReady(); // chatPinned defaults true
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(agentEnd(), 1025);
		expect(state.streaming).toBe(false);
		expect(state.answerUnviewed).toBe(false);
	});

	test("agent_end while scrolled up → flagged; the next turn start clears it", () => {
		primeReady();
		setState("chatPinned", false); // user is scrolled up (useStickyScroll mirror)
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(agentEnd(), 1025);
		expect(state.answerUnviewed).toBe(true);
		dispatchSeq(agentStart(), 1026);
		expect(state.answerUnviewed).toBe(false);
	});

	test("a continuation keeps the composer busy without signaling a completed answer", () => {
		primeReady();
		setState({ chatPinned: false, view: "analysis" });
		dispatchSeq(agentStart(), 1024);
		setState("live", { active: true, blocks: [] });
		setState("workingIntent", "Retrying");
		dispatchSeq(
			{
				type: "event",
				event: { type: "agent_end", messages: [], isTerminal: false, yielded: false },
			},
			1025,
		);
		expect(state.streaming).toBe(true);
		expect(state.live.active).toBe(false);
		expect(state.workingIntent).toBeUndefined();
		expect(state.answerUnviewed).toBe(false);
		expect(state.chatUnviewed).toBe(false);
		expect(state.announcement).toBe("agent started");
	});

	test("a yielded turn awaiting background work still signals a completed answer", () => {
		primeReady();
		setState({ chatPinned: false, view: "analysis" });
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(
			{
				type: "event",
				event: {
					type: "agent_end",
					messages: [],
					isTerminal: false,
					yielded: true,
					awaitingAsyncWork: true,
				},
			},
			1025,
		);
		expect(state.streaming).toBe(false);
		expect(state.answerUnviewed).toBe(true);
		expect(state.chatUnviewed).toBe(true);
		expect(state.announcement).toBe("agent finished");
	});
});

describe("chatUnviewed (a turn ended while in Analysis)", () => {
	/** A fully primed stream: attached, empty history, readiness gate cleared. */
	function primeReady(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}
	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end", messages: [] },
	});

	test("agent_end while the view is chat → not flagged", () => {
		primeReady(); // view defaults chat
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(agentEnd(), 1025);
		expect(state.chatUnviewed).toBe(false);
	});

	test("agent_end while the view is analysis → flagged; setView(chat) clears it", () => {
		setView("analysis");
		primeReady();
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(agentEnd(), 1025);
		expect(state.chatUnviewed).toBe(true);

		setView("chat");
		expect(state.chatUnviewed).toBe(false);
		// Staying in analysis keeps the flag (only entering chat clears it).
		setState("chatUnviewed", true);
		setView("analysis");
		expect(state.chatUnviewed).toBe(true);
	});

	test("a detached daemon's streaming flip true→false while in analysis → flagged", () => {
		// Prime the connected transport without an attached session so d2 is
		// detached; then switch to analysis.
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setView("analysis");

		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		expect(state.chatUnviewed).toBe(false);
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: false });
		expect(state.chatUnviewed).toBe(true);

		// A detached daemon ending while in chat never flags.
		setView("chat");
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: false });
		expect(state.chatUnviewed).toBe(false);
	});

	test("the ATTACHED daemon's turn end is not chatUnviewed either", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("d2")); // currentSessionId = d2
		setView("analysis");
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: false });
		expect(state.chatUnviewed).toBe(false);
	});
});

describe("setView persistence and hash handling", () => {
	test("setView persists omp.view; setTxSidebarVisible persists its own key", () => {
		installLocalStorageShim();
		setView("analysis");
		expect(globalThis.localStorage.getItem("omp.view")).toBe("analysis");
		setTxSidebarVisible(false);
		expect(globalThis.localStorage.getItem("omp.txSidebarVisible")).toBe("false");
	});

	test("drawer viewport: sidebar toggles stay session-only and picks close both drawers", () => {
		installLocalStorageShim();
		setState({ drawerViewport: true, sidebarVisible: false, txSidebarVisible: false });
		try {
			setSidebarVisible(true);
			setTxSidebarVisible(true);
			expect(globalThis.localStorage.getItem("omp.sidebarVisible")).toBeNull();
			expect(globalThis.localStorage.getItem("omp.txSidebarVisible")).toBeNull();
			closeDrawers();
			expect(state.sidebarVisible).toBe(false);
			expect(state.txSidebarVisible).toBe(false);
		} finally {
			setState({ drawerViewport: false, sidebarVisible: true, txSidebarVisible: true });
		}
	});

	test("docked viewport: closeDrawers leaves the persisted sidebar choice alone", () => {
		installLocalStorageShim();
		setSidebarVisible(true);
		closeDrawers();
		expect(state.sidebarVisible).toBe(true);
		expect(globalThis.localStorage.getItem("omp.sidebarVisible")).toBe("true");
	});

	test("entering chat clears the hash via history.replaceState and the chatUnviewed dot", () => {
		installLocalStorageShim();
		setBrowserGlobal("history", {
			replaceState: vi.fn(),
		} as unknown as typeof history);
		setBrowserGlobal("location", { hash: "#/s/x", pathname: "/app", search: "?a=1" } as Location);
		setState("chatUnviewed", true);
		setView("analysis");
		setView("chat");
		expect(history.replaceState).toHaveBeenCalledWith(null, "", "/app?a=1");
		expect(state.chatUnviewed).toBe(false);
	});

	test("entering analysis keeps the hash untouched", () => {
		installLocalStorageShim();
		const replaceState = vi.fn();
		setBrowserGlobal("history", { replaceState } as unknown as typeof history);
		setBrowserGlobal("location", { hash: "", pathname: "/app", search: "" } as Location);
		setView("analysis");
		expect(replaceState).not.toHaveBeenCalled();
	});

	test("defaults: txSidebarVisible true, view chat, dot false", () => {
		installLocalStorageShim();
		expect(state.txSidebarVisible).toBe(true);
		expect(state.view).toBe("chat");
		expect(state.chatUnviewed).toBe(false);
	});
});

describe("initialView (boot view resolution)", () => {
	test("legacy values migrate: work → chat, transcripts → analysis", () => {
		expect(initialView("work", "", true)).toBe("chat");
		expect(initialView("transcripts", "", true)).toBe("analysis");
	});

	test("unknown/null persist values fall back to chat; current values pass through", () => {
		expect(initialView("analysis", "", true)).toBe("analysis");
		expect(initialView("chat", "", true)).toBe("chat");
		expect(initialView(null, "", true)).toBe("chat");
		expect(initialView("bogus", "", true)).toBe("chat");
		expect(initialView("", "", true)).toBe("chat");
	});

	test("a #/s/<file> hash deep-links into analysis even when chat is persisted", () => {
		expect(initialView("chat", "#/s/abc.jsonl", true)).toBe("analysis");
		expect(initialView("chat", "#s/abc.jsonl", true)).toBe("analysis");
	});

	test("a #/stored/<workspaceId>/<sessionId> hash deep-links into analysis (P8.5)", () => {
		expect(initialView("chat", "#/stored/d7/sess-1", true)).toBe("analysis");
		expect(initialView("chat", "#stored/d7/sess-1", true)).toBe("analysis");
	});

	test("a non-/s/ hash falls through to the persisted value", () => {
		expect(initialView("analysis", "#/settings", true)).toBe("analysis");
		expect(initialView("chat", "#/settings", true)).toBe("chat");
	});

	test("with analysis disabled, every route into Analysis falls back to Chat", () => {
		expect(initialView("analysis", "", false)).toBe("chat");
		expect(initialView("transcripts", "", false)).toBe("chat");
		expect(initialView("chat", "#/s/abc.jsonl", false)).toBe("chat");
		expect(initialView("chat", "#/stored/d7/sess-1", false)).toBe("chat");
	});

	test("a session route (#/d/<daemonId>[/s/<sessionId>]) boots into chat, even over a persisted analysis", () => {
		expect(initialView("analysis", "#/d/d7", true)).toBe("chat");
		expect(initialView("analysis", "#/d/d7/s/sess-1", true)).toBe("chat");
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
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end", messages: [] },
	});

	test("an agent turn starting announces only after the session is ready", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		// Streaming flips during priming; no announcement until the gate clears.
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
			{
				type: "event",
				event: {
					type: "tool_execution_start",
					toolCallId: "t1",
					toolName: "bash",
					args: { command: "echo hi" },
				},
			},
			1024,
		);
		expect(state.announcement).toBe("bash started");
		dispatchSeq(
			{
				type: "event",
				event: {
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { output: "out" },
				},
			},
			1025,
		);
		expect(state.announcement).toBe("bash completed");
		// A failed run announces "failed" (the tool output itself is never announced).
		dispatchSeq(
			{
				type: "event",
				event: {
					type: "tool_execution_start",
					toolCallId: "t2",
					toolName: "bash",
					args: { command: "boom" },
				},
			},
			1026,
		);
		dispatchSeq(
			{
				type: "event",
				event: {
					type: "tool_execution_end",
					toolCallId: "t2",
					toolName: "bash",
					result: { output: "" },
					isError: true,
				},
			},
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
		// The store field is the only observable here; Bun's runtime doesn't
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
// parity). Sourced from tool_execution_start, first the loop-resolved
// `intent`, then the harness-injected `i` arg, and cleared with the turn.
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
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end", messages: [] },
	});
	const toolStart = (toolCallId: string, extra: Record<string, unknown>): ServerFrame => ({
		type: "event",
		event: {
			type: "tool_execution_start",
			toolCallId,
			toolName: "read",
			args: { path: "x.ts" },
			...extra,
		},
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
		dispatchSeq(
			toolStart("t1", { args: { path: "x.ts", i: "Searching for shimmer styles" } }),
			1025,
		);
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

// ---------------------------------------------------------------------------
// Phase 5: project-first sidebar state: registered_projects frame handling
// (fleet-scoped, survives session resets) + daemonsByProject grouping.
// ---------------------------------------------------------------------------
describe("Phase 5: registered projects and project-first grouping", () => {
	const p1: RegisteredProject = { projectId: "p1", path: "/repos/a", name: "a", addedAt: 1 };
	const p2: RegisteredProject = { projectId: "p2", path: "/repos/b", name: "b", addedAt: 2 };
	const p3: RegisteredProject = { projectId: "p3", path: "/repos/c", name: "c", addedAt: 3 };

	/** Minimal roster entry; extra fields (projectId/worktreeOf/…) ride along. */
	function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			labels: [],
			status: "ready",
			...extra,
		};
	}

	test("registered_projects populates the store and survives a session reset (fleet-scoped)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({ type: "registered_projects", projects: [p1, p2, p3] });
		expect(state.registeredProjects).toEqual([p1, p2, p3]);

		// A daemon switch runs resetSessionView (session-scoped cleanup); the
		// project registry is fleet-scoped and must come through intact.
		dispatch(attached("daemon-a"));
		dispatch(attached("daemon-b")); // switch → resetSessionView
		expect(state.currentSessionId).toBe("daemon-b");
		expect(state.registeredProjects).toEqual([p1, p2, p3]);
	});

	test("a later registered_projects broadcast replaces the collection wholesale", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({ type: "registered_projects", projects: [p1, p2] });
		dispatch({ type: "registered_projects", projects: [p2] }); // p1 deregistered
		expect(state.registeredProjects).toEqual([p2]);
	});

	test("registered_projects carries the fleet config path (additive; missing = null, fleet-scoped)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		// Older edges omit configPath entirely: the store must read null.
		dispatch({ type: "registered_projects", projects: [p1] });
		expect(state.fleetConfigPath).toBeNull();

		// A config-carrying frame sets it (resolved config path, not null).
		dispatch({
			type: "registered_projects",
			projects: [p2],
			configPath: "/home/u/.omp-web/config.json",
		});
		expect(state.fleetConfigPath).toBe("/home/u/.omp-web/config.json");

		// An explicit null (defaults apply, no config file) is honored.
		dispatch({ type: "registered_projects", projects: [p3], configPath: null });
		expect(state.fleetConfigPath).toBeNull();

		// Fleet-scoped like the projects: a session switch (resetSessionView)
		// must not wipe it; the first-run signal lives until config exists.
		dispatch({
			type: "registered_projects",
			projects: [p1],
			configPath: "/home/u/.omp-web/config.json",
		});
		dispatch(attached("daemon-a"));
		dispatch(attached("daemon-b")); // switch → resetSessionView
		expect(state.currentSessionId).toBe("daemon-b");
		expect(state.registeredProjects).toEqual([p1]);
		expect(state.fleetConfigPath).toBe("/home/u/.omp-web/config.json");
	});

	test("daemonsByProject: registry order, zero-daemon projects present, main-checkout rows first", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		// Registry order deliberately differs from roster order.
		dispatch({ type: "registered_projects", projects: [p2, p1, p3] });
		dispatch({
			type: "roster",
			daemons: [
				daemon("b-main", { projectId: "p2" }),
				daemon("a-wt", { projectId: "p1", worktreeOf: "a" }),
				daemon("a-main", { projectId: "p1" }),
			],
		});

		const groups = daemonsByProject();
		expect(groups.map((g) => g.project.projectId)).toEqual(["p2", "p1", "p3"]);
		expect(groups[0].daemons.map((d) => d.daemonId)).toEqual(["b-main"]);
		// Main-checkout row first, then worktrees, regardless of roster order.
		expect(groups[1].daemons.map((d) => d.daemonId)).toEqual(["a-main", "a-wt"]);
		expect(groups[2].daemons).toEqual([]); // zero-daemon project still renders
	});

	test("daemonsByProject drops entries without a projectId and orders each group main, worktrees by branch, clones", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch({ type: "registered_projects", projects: [p1] });
		dispatch({
			type: "roster",
			daemons: [
				// Unregistered: no projectId, so no group shows it.
				daemon("zeta-main", { project: "zeta" }),
				daemon("clone-b", { projectId: "p1", workspaceKind: "clone", name: "clone-b" }),
				daemon("wt-zed", { projectId: "p1", worktreeOf: "a", branch: "zed" }),
				daemon("wt-alpha", { projectId: "p1", worktreeOf: "a", branch: "alpha" }),
				daemon("a-main", { projectId: "p1", workspaceKind: "direct" }),
				daemon("clone-a", { projectId: "p1", workspaceKind: "clone", name: "clone-a" }),
			],
		});

		const groups = daemonsByProject();
		expect(groups.map((g) => g.project.projectId)).toEqual(["p1"]);
		expect(groups[0].daemons.map((d) => d.daemonId)).toEqual([
			"a-main",
			"wt-alpha",
			"wt-zed",
			"clone-b",
			"clone-a",
		]);
	});

	test("worktree_delete_info answers populate the daemonId-keyed evidence map (fleet-scoped)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({
			type: "worktree_delete_info",
			daemonId: "d1",
			linked: true,
			dirty: true,
			git: { added: 1, modified: 0, deleted: 0, untracked: 2 },
			branch: "feat",
			merged: false,
			unpushed: true,
		});
		dispatch({
			type: "worktree_delete_info",
			daemonId: "d1",
			linked: true,
			dirty: false,
			branch: "feat",
			merged: true,
			unpushed: false,
		});
		dispatch({
			type: "worktree_delete_info",
			daemonId: "d2",
			linked: false,
			dirty: false,
			reason: "not a linked worktree",
		});

		expect(state.worktreeDeleteInfo["d1"]).toMatchObject({
			linked: true,
			dirty: false,
			merged: true,
		}); // latest-wins
		expect(state.worktreeDeleteInfo["d2"]).toMatchObject({
			linked: false,
			dirty: false,
			reason: "not a linked worktree",
		});

		// Fleet-scoped: survives the reset of a daemon switch.
		dispatch(attached("daemon-a"));
		dispatch(attached("daemon-b"));
		expect(state.worktreeDeleteInfo["d2"]).toMatchObject({
			linked: false,
			dirty: false,
			reason: "not a linked worktree",
		});
	});

	test("listProjectBranches resolves via a matching project_branches frame; other projects or remotes do not settle it", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.(); // connected = true

		const branches = listProjectBranches("p1");
		expect(posted).toEqual([
			{ type: "list_project_branches", id: expect.any(String), projectId: "p1" },
		]);

		let settled = false;
		void branches.then(() => {
			settled = true;
		});
		// Another project's frame and the same project's other-remote frame are not this answer.
		dispatch({ type: "project_branches", projectId: "p2", branches: [], remotes: [] });
		dispatch({
			type: "project_branches",
			projectId: "p1",
			remote: "origin",
			branches: [],
			remotes: ["origin"],
		});
		await flushMicrotasks();
		expect(settled).toBe(false);

		dispatch({
			type: "project_branches",
			projectId: "p1",
			branches: [{ name: "main", checkedOut: true, worktreePath: "/w/main" }],
			remotes: ["origin"],
			defaultBase: "main",
		});
		await expect(branches).resolves.toEqual({
			branches: [{ name: "main", checkedOut: true, worktreePath: "/w/main" }],
			remotes: ["origin"],
			defaultBase: "main",
		});
	});

	test("listProjectBranches with a remote posts it and settles from that remote's frame", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const fromOrigin = listProjectBranches("p1", "origin");
		expect(posted).toEqual([
			{ type: "list_project_branches", id: expect.any(String), projectId: "p1", remote: "origin" },
		]);
		dispatch({
			type: "project_branches",
			projectId: "p1",
			remote: "origin",
			branches: [{ name: "feat", checkedOut: false }],
			remotes: ["origin"],
		});
		await expect(fromOrigin).resolves.toMatchObject({
			branches: [{ name: "feat", checkedOut: false }],
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 5: project/worktree command senders. Each POSTs the exact
// ClientCommand variant the fleet edge allowlists.
// ---------------------------------------------------------------------------
/** Id of the most recent command posted; keyed result frames answer it. */
function lastCommandId(): string {
	const cmd = posted.at(-1);
	if (cmd === undefined) throw new Error("expected a posted command");
	return cmd.id;
}

describe("Phase 5: project/worktree command senders", () => {
	test("addProject posts add_project and resolves from add_project_result", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const added = addProject("/repos/a");
		expect(posted).toEqual([{ type: "add_project", id: expect.any(String), path: "/repos/a" }]);
		dispatch({
			type: "add_project_result",
			id: lastCommandId(),
			ok: true,
			projectId: "p1",
			existing: false,
		});
		await expect(added).resolves.toEqual({ projectId: "p1", existing: false });
	});

	test("addProject reports an already-registered checkout as existing; a refusal rejects with the fleet's message", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const again = addProject("/repos/a/src");
		dispatch({
			type: "add_project_result",
			id: lastCommandId(),
			ok: true,
			projectId: "p1",
			existing: true,
		});
		await expect(again).resolves.toEqual({ projectId: "p1", existing: true });

		const bare = addProject("/repos/bare.git");
		dispatch({
			type: "add_project_result",
			id: lastCommandId(),
			ok: false,
			error: "bare repository: add a checkout instead",
		});
		await expect(bare).rejects.toThrow("bare repository: add a checkout instead");
	});

	test("addProject never arms the session picker gate", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const added = addProject("/repos/a");
		expect(state.pendingSessionPicker).toBeNull();
		dispatch({
			type: "add_project_result",
			id: lastCommandId(),
			ok: true,
			projectId: "p1",
			existing: false,
		});
		await added;
		expect(state.pendingSessionPicker).toBeNull();
	});

	test("sendRemoveProject posts remove_project", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		sendRemoveProject("p1");
		expect(posted).toEqual([{ type: "remove_project", id: expect.any(String), projectId: "p1" }]);
	});

	test("createWorktree posts create_worktree (start:true) and resolves with the daemonId from workspace_create_result", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const created = createWorktree("p1", { name: "feature-x", baseRef: "main" });
		expect(posted).toEqual([
			{
				type: "create_worktree",
				id: expect.any(String),
				projectId: "p1",
				name: "feature-x",
				baseRef: "main",
				start: true,
			},
		]);
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d7" });
		await expect(created).resolves.toEqual({ daemonId: "d7" });
	});

	test("createWorktree with an existing branch posts existingBranch; a refusal rejects with the fleet's message", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const existing = createWorktree("p1", { name: "feat", existingBranch: "feat" });
		expect(posted).toEqual([
			{
				type: "create_worktree",
				id: expect.any(String),
				projectId: "p1",
				name: "feat",
				existingBranch: "feat",
				start: true,
			},
		]);
		dispatch({
			type: "workspace_create_result",
			id: lastCommandId(),
			ok: false,
			error: "branch feat is already checked out",
		});
		await expect(existing).rejects.toThrow("branch feat is already checked out");
	});

	test("createClone posts create_clone (start:true) with the remote source and resolves from workspace_create_result", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const cloned = createClone("p1", {
			name: "clone-x",
			profileId: "prof",
			source: { remoteName: "upstream" },
			branch: "main",
		});
		expect(posted).toEqual([
			{
				type: "create_clone",
				id: expect.any(String),
				projectId: "p1",
				name: "clone-x",
				profileId: "prof",
				source: { remoteName: "upstream" },
				branch: "main",
				start: true,
			},
		]);
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d8" });
		await expect(cloned).resolves.toEqual({ daemonId: "d8" });
	});

	test("resetPendingProjects (stream teardown) rejects in-flight add and create waiters with Disconnected", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const added = addProject("/repos/a");
		const created = createWorktree("p1", { name: "feat" });
		resetPendingProjects();
		await expect(added).rejects.toThrow("Disconnected");
		await expect(created).rejects.toThrow("Disconnected");
	});

	test("syncProjects posts sync_projects and coalesces calls within 5s", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const base = Date.now() + 100_000;
		const now = vi.spyOn(Date, "now").mockReturnValue(base);
		try {
			syncProjects();
			syncProjects();
			expect(posted.map((c) => c.type)).toEqual(["sync_projects"]);
			now.mockReturnValue(base + 5000);
			syncProjects();
			expect(posted.map((c) => c.type)).toEqual(["sync_projects", "sync_projects"]);
		} finally {
			now.mockRestore();
		}
	});

	test("sendDeleteWorktree posts delete_worktree (deleteBranch is the branch name, optional)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		sendDeleteWorktree("d1", { deleteBranch: "feat" });
		expect(posted).toEqual([
			{ type: "delete_worktree", id: expect.any(String), daemonId: "d1", deleteBranch: "feat" },
		]);

		posted.length = 0;
		sendDeleteWorktree("d1");
		expect(posted).toEqual([{ type: "delete_worktree", id: expect.any(String), daemonId: "d1" }]);
	});

	test("sendWorktreeDeleteInfo posts worktree_delete_info for the daemon", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		sendWorktreeDeleteInfo("d1");
		expect(posted).toEqual([
			{ type: "worktree_delete_info", id: expect.any(String), daemonId: "d1" },
		]);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: post-attach session-picker gate. A start:true onboarding sender
// arms the gate (daemonId unknown at send time); the onboarding attach stamps
// the real daemonId; attach_result for that daemon asks list_sessions; the
// sessions answer decides new-vs-resume and clears the gate.
// ---------------------------------------------------------------------------
describe("Phase 5: post-attach session-picker gate", () => {
	function sessionEntry(id: string, cwd: string): SessionListEntry {
		return { path: cwd, id, cwd, name: id, messageCount: 0, modifiedAt: 0 };
	}

	/** The attach command posted by the most recent attachSession() call. */
	function lastAttachCmd(): Extract<ClientCommand, { type: "attach" }> {
		const cmd = posted
			.filter((c): c is Extract<ClientCommand, { type: "attach" }> => c.type === "attach")
			.at(-1);
		if (!cmd) throw new Error("expected an attach command");
		return cmd;
	}

	/** Commands of one type as posted, oldest first. */
	function postedOf<T extends ClientCommand["type"]>(
		type: T,
	): Array<Extract<ClientCommand, { type: T }>> {
		return posted.filter((c): c is Extract<ClientCommand, { type: T }> => c.type === type);
	}

	test("armed gate: attach_result asks list_sessions; non-empty answer opens the picker with the daemon context", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		// The sender arms the gate (it cannot know the spawned daemon's id).
		const created = createWorktree("p1", { name: "feat" });
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d1" });
		await expect(created).resolves.toEqual({ daemonId: "d1" });
		expect(state.pendingSessionPicker).not.toBeNull();

		// The onboarding attach stamps the REAL daemonId.
		const attach = attachSession("d1");
		expect(state.pendingSessionPicker).toBe("d1");

		dispatch({ type: "attach_result", id: lastAttachCmd().id, ok: true, sessionId: "d1" });
		await expect(attach).resolves.toBe("d1");
		// The gate asked for sessions; the flag stays set until the answer.
		expect(postedOf("list_sessions")).toHaveLength(1);
		expect(state.pendingSessionPicker).toBe("d1");

		// Non-empty answer: open the picker with the pending daemon context.
		dispatch({ type: "sessions", sessions: [sessionEntry("s1", "/repos/a")] });
		expect(state.pendingSessionPicker).toBeNull();
		expect(state.sessionPickerGate).toEqual({ daemonId: "d1" });
		expect(state.modal).toBe("sessions");
	});

	test("armed gate: empty sessions answer starts a new session and clears the gate (no picker)", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const created = createWorktree("p1", { name: "feat" });
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d2" });
		await created;
		const attach = attachSession("d2");
		expect(state.pendingSessionPicker).toBe("d2");
		dispatch({ type: "attach_result", id: lastAttachCmd().id, ok: true, sessionId: "d2" });
		await expect(attach).resolves.toBe("d2");
		expect(postedOf("list_sessions")).toHaveLength(1);

		dispatch({ type: "sessions", sessions: [] });
		expect(state.pendingSessionPicker).toBeNull();
		expect(state.sessionPickerGate).toBeNull();
		expect(state.modal).toBeNull();
		// The daemon got the same new-session RPC /new uses.
		const newSessionCalls = postedOf("call").filter((c) => c.method === "newSession");
		expect(newSessionCalls).toHaveLength(1);
	});

	test("an attach failure disarms the gate", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const created = createWorktree("p1", { name: "feat", existingBranch: "feat" });
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d3" });
		await created;
		const attach = attachSession("d3");
		expect(state.pendingSessionPicker).toBe("d3");
		dispatch({
			type: "attach_result",
			id: lastAttachCmd().id,
			ok: false,
			error: "unknown daemon: d3",
		});
		await expect(attach).rejects.toThrow("unknown daemon: d3");
		expect(state.pendingSessionPicker).toBeNull();
		expect(postedOf("list_sessions")).toHaveLength(0);
	});

	test("a refused create disarms the gate before any attach", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const created = createWorktree("p1", { name: "feat" });
		expect(state.pendingSessionPicker).not.toBeNull();
		dispatch({
			type: "workspace_create_result",
			id: lastCommandId(),
			ok: false,
			error: "disk full",
		});
		await expect(created).rejects.toThrow("disk full");
		expect(state.pendingSessionPicker).toBeNull();
	});

	test("a superseding attach re-points the gate to the latest daemon (latest-wins)", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const created = createClone("p1", { name: "clone-x", profileId: "prof" });
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d0" });
		await created;
		attachSession("d1");
		expect(state.pendingSessionPicker).toBe("d1");
		// A newer attach supersedes it before the first settles; the gate
		// follows the LATEST attach (it gates whichever daemon onboarding
		// ended up on).
		attachSession("d9");
		expect(state.pendingSessionPicker).toBe("d9");

		// The superseded attach's keyed result is ignored (id mismatch) and
		// the gate stays pointed at d9.
		const firstCmd = postedOf("attach")[0];
		dispatch({ type: "attach_result", id: firstCmd.id, ok: true, sessionId: "d1" });
		expect(state.pendingSessionPicker).toBe("d9");
		expect(postedOf("list_sessions")).toHaveLength(0);

		// The current attach settles → the gate fires for d9.
		const attach = attachSession("d9");
		dispatch({
			type: "attach_result",
			id: postedOf("attach").at(-1)!.id,
			ok: true,
			sessionId: "d9",
		});
		await expect(attach).resolves.toBe("d9");
		expect(postedOf("list_sessions")).toHaveLength(1);
		expect(state.pendingSessionPicker).toBe("d9"); // armed until the answer

		dispatch({ type: "sessions", sessions: [sessionEntry("s1", "/repos/a")] });
		expect(state.sessionPickerGate).toEqual({ daemonId: "d9" });
		expect(state.modal).toBe("sessions");
	});

	test("spawn_resume never arms the gate (routine asleep-row wake)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		expect(state.pendingSessionPicker).toBeNull();
		spawnResume("d9");
		expect(posted).toEqual([{ type: "spawn_resume", id: expect.any(String), daemonId: "d9" }]);
		expect(state.pendingSessionPicker).toBeNull();
	});

	test("no armed gate: attach + sessions answer open nothing", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const attach = attachSession("d4");
		dispatch({ type: "attach_result", id: lastAttachCmd().id, ok: true, sessionId: "d4" });
		await expect(attach).resolves.toBe("d4");
		expect(postedOf("list_sessions")).toHaveLength(0);

		// A sessions broadcast (e.g. the picker's own listSessions) with no
		// gate must never open the picker on its own.
		dispatch({ type: "sessions", sessions: [sessionEntry("s1", "/repos/a")] });
		expect(state.modal).toBeNull();
		expect(state.sessionPickerGate).toBeNull();
	});

	test("a switch to a different daemon disarms the gate; the onboarding daemon's own switch keeps it", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a")); // already attached elsewhere

		// Onboarding flow: armed, then attached to the new daemon.
		const created = createWorktree("p1", { name: "feat" });
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, daemonId: "d1" });
		await created;
		attachSession("d1");
		expect(state.pendingSessionPicker).toBe("d1");

		// The proxied attached frame for the gate's own daemon (a switch from
		// daemon-a) must NOT disarm; the sessions answer still has to land.
		dispatch(attached("d1"));
		expect(state.pendingSessionPicker).toBe("d1");

		// A switch to yet another daemon disarms it.
		dispatch(attached("daemon-c"));
		expect(state.pendingSessionPicker).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// worktree_removed: poll-detected on-disk worktree removal (the fleet evicted
// the daemon and broadcasts). One toast per eviction + an aria-live announce;
// fleet-edge-only like registered_projects, so no session guard is applied.
// ---------------------------------------------------------------------------
describe("worktree_removed (on-disk removal toast)", () => {
	/** A fully primed stream: attached + empty history. */
	function prime(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
	}

	test("a worktree_removed frame appends one toast (name + path) and announces it", () => {
		prime();
		dispatch({
			type: "worktree_removed",
			daemonId: "d1",
			name: "feat-x",
			path: "/repos/proj/worktrees/feat-x",
		} as ServerFrame);
		const expected = "Worktree removed on disk: feat-x (/repos/proj/worktrees/feat-x)";
		expect(state.toasts).toHaveLength(1);
		expect(state.toasts[0].text).toBe(expected);
		expect(state.announcement).toBe(expected);
	});

	test("a second eviction appends a second toast (one toast per eviction)", () => {
		prime();
		dispatch({
			type: "worktree_removed",
			daemonId: "d1",
			name: "feat-x",
			path: "/repos/proj/worktrees/feat-x",
		} as ServerFrame);
		dispatch({
			type: "worktree_removed",
			daemonId: "d2",
			name: "feat-y",
			path: "/repos/proj/worktrees/feat-y",
		} as ServerFrame);
		expect(state.toasts.map((t) => t.text)).toEqual([
			"Worktree removed on disk: feat-x (/repos/proj/worktrees/feat-x)",
			"Worktree removed on disk: feat-y (/repos/proj/worktrees/feat-y)",
		]);
	});

	test("a long path is truncated from the left with an ellipsis (text stays under 120 chars)", () => {
		prime();
		const longPath = `/repos/proj/worktrees/feat-${"segment/".repeat(20)}tail`;
		dispatch({
			type: "worktree_removed",
			daemonId: "d1",
			name: "feat",
			path: longPath,
		} as ServerFrame);
		const text = state.toasts[0].text;
		expect(text.length).toBeLessThanOrEqual(120);
		expect(text.startsWith("Worktree removed on disk: feat (")).toBe(true);
		expect(text.endsWith(")")).toBe(true);
		expect(text).toContain("…");
		expect(text).toContain("tail"); // the informative basename tail survives
	});
});

// ---------------------------------------------------------------------------
// Roster truth vs. the attached chat column: a roster/daemon_status frame
// marking the attached daemon dead (asleep/error) or removing it clears the
// session view, but MUST NOT fire while that daemon's attach is in flight
// (a freshly waking daemon reads as "asleep" in lagging roster frames).
// ---------------------------------------------------------------------------
describe("attached session reconciliation against roster truth", () => {
	/** Minimal roster entry; status/extra fields ride along. */
	function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			labels: [],
			status: "ready",
			...extra,
		};
	}

	test("a re-dialing attached daemon reaches the strip only after the grace window", () => {
		vi.useFakeTimers();
		try {
			attachAndPrime();
			dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "reconnecting" })] });
			expect(connectionState()).toBe("connected");
			vi.advanceTimersByTime(1_600);
			expect(connectionState()).toBe("reconnecting");
			dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "ready" })] });
			expect(connectionState()).toBe("connected");
		} finally {
			vi.useRealTimers();
		}
	});

	/** Connect + attach to a daemon with an empty-transcript prime in place. */
	function attachAndPrime(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a"));
		dispatchSeq({ type: "history", messages: [userMsg("q"), assistantMsg("a")] } as ServerFrame, 3);
		setState("readyAt", 123);
	}

	test("a roster frame marking the attached daemon asleep clears the session view (roster survives)", () => {
		attachAndPrime();
		expect(state.currentSessionId).toBe("daemon-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });

		expect(state.currentSessionId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		// Fleet-scoped roster data survives the session clear.
		expect(state.daemonRoster.map((d) => d.daemonId)).toEqual(["daemon-a"]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a roster_delta marking the attached daemon asleep clears the session view (roster survives)", () => {
		attachAndPrime();
		expect(state.currentSessionId).toBe("daemon-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });

		dispatch({
			type: "roster_delta",
			upserted: [daemon("daemon-a", { status: "asleep" })],
			removed: [],
		});

		expect(state.currentSessionId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		// Fleet-scoped roster data survives the session clear.
		expect(state.daemonRoster.map((d) => d.daemonId)).toEqual(["daemon-a"]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a roster frame keeping the attached daemon ready does NOT clear", () => {
		attachAndPrime();

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "ready" })] });

		expect(state.currentSessionId).toBe("daemon-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);
	});

	test("removing the attached entry from the roster clears the session view", () => {
		attachAndPrime();

		dispatch({ type: "roster", daemons: [] });

		expect(state.currentSessionId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a daemon_status asleep frame for the attached daemon clears the session view", () => {
		attachAndPrime();
		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "ready" })] });

		dispatch({ type: "daemon_status", daemonId: "daemon-a", status: "asleep" });

		expect(state.currentSessionId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
	});

	test("RACE: a lagging 'asleep' roster frame does not clear while the attach is in flight", async () => {
		attachAndPrime();
		// The proxied attached frame already set currentSessionId, but the
		// id-keyed attach_result has not settled yet (finding #28: priming
		// rides the daemon pipe, which may be mid-redial); the wake-attach
		// is still in flight, so the lagging roster must not clear.
		const attach = attachSession("daemon-a");
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });
		expect(state.currentSessionId).toBe("daemon-a");
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);

		// Once the attach settles, the same asleep roster frame IS truth.
		dispatch({ type: "attach_result", id: cmd.id, ok: true, sessionId: "daemon-a" });
		await expect(attach).resolves.toBe("daemon-a");
		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });
		expect(state.currentSessionId).toBe("");
		expect(hasLiveSession()).toBe(false);
	});

	test("the in-flight guard only protects the attach target (a different dead daemon clears)", async () => {
		attachAndPrime();
		// Attaching to daemon-b must not shield a daemon-a that died.
		const attach = attachSession("daemon-b");
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });
		expect(state.currentSessionId).toBe("");

		dispatch({ type: "attach_result", id: cmd.id, ok: true, sessionId: "daemon-b" });
		await expect(attach).resolves.toBe("daemon-b");
	});

	test("hasLiveSession: transitional wake statuses stay live, terminal-dead statuses gate the pane", () => {
		attachAndPrime();
		// A transitional wake status is never dead.
		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "connecting" })] });
		expect(state.currentSessionId).toBe("daemon-a");
		expect(hasLiveSession()).toBe(true);

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "error" })] });
		expect(state.currentSessionId).toBe("");
		expect(hasLiveSession()).toBe(false);
	});

	test("a user stop keeps the attached transcript behind the stopped strip; restart clears the mark", () => {
		attachAndPrime();
		stopDaemonById("daemon-a");
		expect(isUserStopped("daemon-a")).toBe(true);

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });

		expect(state.currentSessionId).toBe("daemon-a");
		expect(state.readyAt).toBeUndefined();
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);

		restartDaemonById("daemon-a");
		expect(isUserStopped("daemon-a")).toBe(false);
	});

	test("restarting a ready process waits for the roster to show it asleep before waking", () => {
		attachAndPrime();
		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "ready" })] });
		restartDaemonById("daemon-a");
		expect(isUserStopped("daemon-a")).toBe(true);

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "ready" })] });
		expect(isUserStopped("daemon-a")).toBe(true);

		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });
		expect(isUserStopped("daemon-a")).toBe(false);
	});

	test("a user-stopped attached daemon removed from the roster clears the view and its mark", () => {
		attachAndPrime();
		stopDaemonById("daemon-a");

		dispatch({ type: "roster", daemons: [] });

		expect(state.currentSessionId).toBe("");
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
		expect(isUserStopped("daemon-a")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// roster_delta: the edge sends the full roster once on open and then only the
// rows each registry mutation changed. A delta patches state.daemonRoster in
// place (by daemonId), appends new rows, and drops removed ids.
// ---------------------------------------------------------------------------
describe("roster_delta frames", () => {
	/** Minimal roster entry; status/extra fields ride along. */
	function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			labels: [],
			status: "ready",
			...extra,
		};
	}

	const rosterIds = (): string[] => state.daemonRoster.map((d) => d.daemonId);

	/** Open the stream and seed the roster with daemons A and B. */
	function seedAB(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch({ type: "roster", daemons: [daemon("a"), daemon("b")] });
		expect(rosterIds()).toEqual(["a", "b"]);
	}

	test("an upserted row patches its entry in place and keeps the order and the other rows", () => {
		seedAB();

		dispatch({
			type: "roster_delta",
			upserted: [daemon("a", { status: "asleep" })],
			removed: [],
		});

		expect(rosterIds()).toEqual(["a", "b"]);
		expect(state.daemonRoster[0]?.status).toBe("asleep");
		expect(state.daemonRoster[1]?.status).toBe("ready");
	});

	test("an upserted row with a new id is appended after the existing rows", () => {
		seedAB();

		dispatch({ type: "roster_delta", upserted: [daemon("c")], removed: [] });

		expect(rosterIds()).toEqual(["a", "b", "c"]);
	});

	test("a removed id drops its row and leaves the others", () => {
		seedAB();

		dispatch({ type: "roster_delta", upserted: [], removed: ["b"] });

		expect(rosterIds()).toEqual(["a"]);
		expect(state.daemonRoster[0]?.status).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// Session-switch supersession (FLEET-02): a switch superseded by a newer one
// must not surface as an error toast; real failures still do.
// ---------------------------------------------------------------------------
describe("reportError", () => {
	test("a superseded session switch stays silent; a real failure surfaces", () => {
		setState("error", null);

		reportError(new Error("session switched"));
		expect(state.error).toBeNull();

		reportError(new Error("boom"));
		expect(state.error).toBe("boom");
	});

	test("a failed queue action surfaces the bare error text; a superseded one stays silent", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		// Queue actions act on an attached session.
		dispatch(attached("d1"));
		const chip = { kind: "steer" as const, text: "hi" };
		const lastCallId = () => (posted.at(-1) as Extract<ClientCommand, { type: "call" }>).id;

		setState("error", null);
		const failed = deleteQueuedMessage(chip);
		dispatch({ type: "call_result", id: lastCallId(), ok: false, error: "queue busy" });
		await failed;
		expect(state.error).toBe("queue busy");

		setState("error", null);
		const superseded = deleteQueuedMessage(chip);
		dispatch({ type: "call_result", id: lastCallId(), ok: false, error: "session switched" });
		await superseded;
		expect(state.error).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Unread-dot tracking: a session abandoned mid-stream (its turn's end will
// never be observed on this tab) is marked unread at switch-away time; the
// row is cleared on attach; dead roster entries are pruned. All client-side.
// ---------------------------------------------------------------------------
describe("unread-dot tracking", () => {
	/** Minimal roster entry (mirrors the reconciliation describe). */
	function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			labels: [],
			status: "ready",
			...extra,
		};
	}

	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });

	beforeEach(() => {
		// Module-level unread state must not leak between tests.
		pruneUnread(new Set());
	});

	test("switching away mid-stream marks the abandoned session unread", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a"));
		dispatchSeq(agentStart(), 1024); // driver state.streaming → true
		expect(state.streaming).toBe(true);

		dispatch(attached("daemon-b"));

		expect(unreadIds().has("daemon-a")).toBe(true);
		expect(unreadIds().has("daemon-b")).toBe(false);
	});

	test("switching away while NOT streaming leaves the session read", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a"));

		dispatch(attached("daemon-b"));

		expect(unreadIds().has("daemon-a")).toBe(false);
		expect(unreadIds().has("daemon-b")).toBe(false);
	});

	test("attaching to a marked session clears its unread dot", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a"));
		dispatchSeq(agentStart(), 1024);
		dispatch(attached("daemon-b"));
		expect(unreadIds().has("daemon-a")).toBe(true);

		dispatch(attached("daemon-a"));

		expect(unreadIds().has("daemon-a")).toBe(false);
	});

	test("a roster frame prunes unread ids for daemons that left", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("daemon-a"));
		dispatchSeq(agentStart(), 1024);
		dispatch(attached("daemon-b"));
		expect(unreadIds().has("daemon-a")).toBe(true);

		dispatch({ type: "roster", daemons: [daemon("daemon-b")] });

		expect(unreadIds().has("daemon-a")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// daemon_activity: the fleet edge's realtime per-daemon stream (streaming /
// blocked) for EVERY ready daemon, delivered as additive fleet-scoped frames.
// It carries no sessionId, so it passes the stale-frame guard untouched. Fed
// into state.daemonActivity and pruned on roster frames like unread; a
// detached daemon's observed streaming flip true→false marks it unread.
// ---------------------------------------------------------------------------
describe("daemon_activity frames", () => {
	/** Minimal roster entry (mirrors the unread/reconciliation describes). */
	function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			labels: [],
			status: "ready",
			...extra,
		};
	}

	beforeEach(() => {
		// Module-level unread state must not leak between tests.
		pruneUnread(new Set());
	});

	test("stores per-daemon activity; an identical repeat is idempotent", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		expect(state.daemonActivity["d2"]).toEqual({ streaming: true, blocked: false });

		// Same values again → no change.
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		expect(state.daemonActivity["d2"]).toEqual({ streaming: true, blocked: false });

		// A later frame for the same daemon updates both fields.
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: true });
		expect(state.daemonActivity["d2"]).toEqual({ streaming: false, blocked: true });
	});

	test("a detached daemon's streaming flip true→false marks it unread", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		expect(unreadIds().has("d2")).toBe(false);

		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: false });
		expect(unreadIds().has("d2")).toBe(true);
	});

	test("the ATTACHED daemon's turn end is NOT marked unread", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("d2")); // currentSessionId = d2

		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: false, blocked: false });

		expect(unreadIds().has("d2")).toBe(false);
	});

	test("a roster frame without d2 prunes its daemonActivity entry", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch({ type: "daemon_activity", daemonId: "d2", streaming: true, blocked: false });

		dispatch({ type: "roster", daemons: [daemon("d1")] });

		expect(state.daemonActivity["d2"]).toBeUndefined();

		// An id still on the roster survives a later roster frame (no flush).
		dispatch({ type: "daemon_activity", daemonId: "d1", streaming: true, blocked: false });
		dispatch({ type: "roster", daemons: [daemon("d1")] });
		expect(state.daemonActivity["d1"]).toEqual({ streaming: true, blocked: false });
	});
});

describe("roster session dropdown", () => {
	/** Minimal roster entry with a worktree cwd. */
	function rosterDaemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
		return {
			daemonId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: "x",
			labels: [],
			status: "ready",
			...extra,
		};
	}

	/** Commands of one type as posted, oldest first. */
	function postedOf<T extends ClientCommand["type"]>(
		type: T,
	): Array<Extract<ClientCommand, { type: T }>> {
		return posted.filter((c): c is Extract<ClientCommand, { type: T }> => c.type === type);
	}

	/** newSession calls as posted, oldest first. */
	const newSessionCalls = () => postedOf("call").filter((c) => c.method === "newSession");

	const se = (id: string): SessionListEntry => ({
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/repos/d9",
		name: id,
		messageCount: 1,
		modifiedAt: 1,
	});

	test("daemon_sessions frame settles the per-daemon dropdown request", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		const pending = requestDaemonSessions("d9");
		expect(postedOf("list_daemon_sessions")).toEqual([
			{ type: "list_daemon_sessions", id: expect.any(String), daemonId: "d9" },
		]);

		// A frame for a DIFFERENT daemon must not settle it.
		dispatch({ type: "daemon_sessions", daemonId: "other", sessions: [se("x")] });
		dispatch({ type: "daemon_sessions", daemonId: "d9", sessions: [se("a"), se("b")] });
		await expect(pending).resolves.toEqual([se("a"), se("b")]);
	});

	test("resumeDaemonSession wakes an asleep daemon with the chosen session then attaches", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("daemonRoster", [
			rosterDaemon("d9", {
				status: "asleep",
				lastSessionFile: "/sessions/current.jsonl",
			}),
		]);

		resumeDaemonSession("d9", "/sessions/picked.jsonl");
		expect(postedOf("spawn_resume")).toEqual([
			{
				type: "spawn_resume",
				id: expect.any(String),
				daemonId: "d9",
				sessionFile: "/sessions/picked.jsonl",
			},
		]);
		expect(postedOf("attach")).toHaveLength(1);
	});

	test("resumeDaemonSession retries a switch swept by its own attach's supersession, never banners", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		// Attached to d1; resume a session on a DIFFERENT ready daemon (d9).
		// the switch lands in-flight while the d9 attach's `attached` frame
		// sweeps pending calls with "session switched".
		setState("currentSessionId", "d1");
		setState("daemonRoster", [
			rosterDaemon("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeDaemonSession("d9", "/sessions/picked.jsonl");
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, sessionId: "d9" });
		await Promise.resolve();
		await Promise.resolve();
		// The first switchSession is in flight when the proxied attached frame
		// switches the session → rejectPendingCalls sweeps it.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(1);
		dispatch(attached("d9"));
		await Promise.resolve();
		await Promise.resolve();
		// The superseded switch retries ONCE against the now-current daemon.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(2);
		expect(state.error).toBeNull(); // the supersession is never a banner
	});

	test("attachForPanel opens Open review when the attach lands, or a superseded attach left this daemon current", async () => {
		setBrowserGlobal(
			"fetch",
			(async () =>
				({
					ok: true,
					status: 202,
					json: async () => ({}),
					text: async () => "",
				}) as unknown as Response) as unknown as typeof fetch,
		);
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("currentSessionId", "d1");
		const opened = attachForPanel("d9");
		setState("currentSessionId", "d9");
		rejectPendingAttach(new Error("session switched"));
		await expect(opened).resolves.toBe(true);
		expect(state.error).toBeNull();
	});

	test("attachForPanel never banners a superseded attach and stays closed once the user moved on", async () => {
		setBrowserGlobal(
			"fetch",
			(async () =>
				({
					ok: true,
					status: 202,
					json: async () => ({}),
					text: async () => "",
				}) as unknown as Response) as unknown as typeof fetch,
		);
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("currentSessionId", "d1");
		const opened = attachForPanel("d9");
		setState("currentSessionId", "d2");
		rejectPendingAttach(new Error("session switched"));
		await expect(opened).resolves.toBe(false);
		expect(state.error).toBeNull();
	});

	test("resumeDaemonSession on a ready detached daemon attaches first, then switches to the picked session", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("daemonRoster", [
			rosterDaemon("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeDaemonSession("d9", "/sessions/picked.jsonl");
		expect(postedOf("attach")).toHaveLength(1);
		// The switch is issued only AFTER the attach settles.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(0);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, sessionId: "d9" });
		await Promise.resolve();
		await Promise.resolve();
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toEqual([
			{
				type: "call",
				id: expect.any(String),
				method: "switchSession",
				args: ["/sessions/picked.jsonl"],
			},
		]);
		expect(state.error).toBeNull();
	});

	test("resumeDaemonSession to the already-current session on a ready daemon only attaches", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("daemonRoster", [
			rosterDaemon("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeDaemonSession("d9", "/sessions/current.jsonl");
		expect(postedOf("attach")).toHaveLength(1);
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(0);
	});

	test("startDaemonNewSession wakes an asleep daemon, attaches, then starts a new session", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("daemonRoster", [
			rosterDaemon("d9", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		const started = startDaemonNewSession("d9");
		// Wakes on its last session (no explicit file), then attaches.
		expect(postedOf("spawn_resume")).toEqual([
			{ type: "spawn_resume", id: expect.any(String), daemonId: "d9" },
		]);
		expect(postedOf("attach")).toHaveLength(1);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, sessionId: "d9" });
		await flushMicrotasks();
		// The proxied attached frame trails attach_result and would sweep a call
		// posted now after the daemon ran it: newSession waits for the frame.
		expect(newSessionCalls()).toHaveLength(0);
		dispatch(attached("d9"));
		await flushMicrotasks();
		expect(newSessionCalls()).toHaveLength(1);
		dispatch({ type: "call_result", id: newSessionCalls()[0].id, ok: true, data: null });
		await started;
		expect(newSessionCalls()).toHaveLength(1);
		expect(state.error).toBeNull();
	});

	test("startDaemonNewSession drops the new session when another session gets attached first", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("currentSessionId", "d1");
		setState("daemonRoster", [rosterDaemon("d9", { status: "ready" })]);

		const started = startDaemonNewSession("d9");
		expect(postedOf("spawn_resume")).toHaveLength(0);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, sessionId: "d9" });
		await flushMicrotasks();
		// The user picked d2 before d9's attached frame landed.
		dispatch(attached("d2"));
		await started;
		// Never a new session on the daemon the user switched to, never a banner.
		expect(newSessionCalls()).toHaveLength(0);
		expect(state.error).toBeNull();
	});

	test("startDaemonNewSession on the attached ready daemon starts at once", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("currentSessionId", "d9");
		setState("daemonRoster", [rosterDaemon("d9", { status: "ready" })]);

		void startDaemonNewSession("d9");
		await flushMicrotasks();
		expect(postedOf("attach")).toHaveLength(0);
		expect(newSessionCalls()).toHaveLength(1);
	});
});

describe("call delivery: a lost answer is recovered by re-POSTing the command", () => {
	/**
	 * Fake daemon over the stubbed fetch + FakeEventSource. It EXECUTES each
	 * command id once and records the answer, but the first answer never rides
	 * the downlink: call_result is a non-ringed unicast, so a frame dropped on
	 * the daemon pipe (backpressure drop-and-resume, a redial, a lost accept)
	 * is gone for good. A re-POST of the SAME id is deduped, no second
	 * execution, and REPLAYS the recorded answer, exactly like the daemon's
	 * command dedup.
	 */
	function startLostAnswerDaemon(answerFor: (id: string) => ServerFrame): {
		executed: string[];
		posts: string[];
	} {
		const executed: string[] = [];
		const posts: string[] = [];
		const answers = new Map<string, ServerFrame>();
		setBrowserGlobal("fetch", (async (_input: unknown, init?: RequestInit) => {
			const cmd = JSON.parse(String(init?.body)) as ClientCommand;
			if (cmd.type === "call") {
				posts.push(cmd.id);
				const recorded = answers.get(cmd.id);
				if (recorded === undefined) {
					executed.push(cmd.id);
					answers.set(cmd.id, answerFor(cmd.id));
				} else {
					dispatch(recorded); // the deduped re-POST's replayed answer
				}
			}
			return { ok: true, status: 202 } as Response;
		}) as unknown as typeof fetch);
		return { executed, posts };
	}

	test("prompt: the replayed answer settles the pending call once and the prompt ran once", async () => {
		vi.useFakeTimers();
		try {
			connect();
			FakeEventSource.instances.at(-1)!.onopen?.(); // connected = true
			const daemon = startLostAnswerDaemon((id) => ({
				type: "call_result",
				id,
				ok: true,
				data: { ran: id },
			}));

			const outcomes: string[] = [];
			const pending = call("prompt", ["hello"]).then(
				() => outcomes.push("resolved"),
				(err) => outcomes.push(`rejected: ${String(err)}`),
			);
			await flushMicrotasks();
			expect(daemon.posts).toHaveLength(1);
			expect(daemon.executed).toHaveLength(1);

			// The answer was lost: the call is still pending, so the replay
			// re-POSTs the SAME command (same id, the dedup key).
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks();
			expect(daemon.posts).toHaveLength(2);
			expect(daemon.posts[0]).toBe(daemon.posts[1]);

			// The replayed answer settles it exactly once, and the daemon never
			// executed the prompt a second time.
			await pending;
			expect(outcomes).toEqual(["resolved"]);
			expect(daemon.executed).toHaveLength(1);
			expect(daemon.posts).toHaveLength(2); // settled: the replay cadence stops
		} finally {
			vi.useRealTimers();
		}
	});

	test("prompt: a replayed failure answer rejects with the daemon's real error, never a fake success", async () => {
		vi.useFakeTimers();
		try {
			connect();
			FakeEventSource.instances.at(-1)!.onopen?.();
			const daemon = startLostAnswerDaemon((id) => ({
				type: "call_result",
				id,
				ok: false,
				error: "not_ready",
			}));

			const outcomes: string[] = [];
			const pending = call("prompt", ["hello"]).then(
				() => outcomes.push("resolved"),
				(err) => outcomes.push(String(err)),
			);
			await flushMicrotasks();
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks();
			expect(daemon.posts).toHaveLength(2); // the lost answer was re-POSTed

			await pending;
			expect(outcomes).toEqual(["Error: not_ready"]);
			expect(daemon.executed).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
