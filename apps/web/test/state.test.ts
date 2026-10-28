import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { OMP_PROTO } from "#lib/wire/protocol";
import type {
	ClientCommand,
	RosterEntry,
	RegisteredProject,
	ServerFrame,
	SessionListEntry,
	SettingsModel,
	WebSessionState,
} from "#lib/wire/protocol";
import { pruneUnread, unreadIds } from "../fleet-ui/unread";
import { rejectPendingAttach, rejectPendingCalls } from "../store/transport";
import { attachForPanel } from "../store/roster";
import { runPaletteItem } from "../store/palette";
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
	sessionsByProject,
	deleteQueuedMessage,
	hasLiveSession,
	initialView,
	isUserStopped,
	listProjectBranches,
	pushNotice,
	refreshSettings,
	restartSessionById,
	sendDeleteWorktree,
	sendRemoveProject,
	sendWorktreeDeleteInfo,
	syncProjects,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	isSwitching,
	setView,
	stopSessionById,
	state,
	updateSetting,
	requestWorkspaceSessions,
	resumeSession,
	startWorkspaceNewSession,
	switchToSession,
	type SubagentInfo,
} from "../state";
import { clearAllDeletePending, resetPendingProjects } from "../store/projects";
import { COLLAB_OFF } from "../store/slices/collab";
import { activatingIds, resumeWorktreeSession } from "../store/worktree-sessions";
import { BOOT_SETTING_PATHS, holdSettingsModel, settingValue } from "../store/settings";
import { subagentTranscript, syncSubagentTranscript } from "../store/subagents";
import { reportError } from "../store/toasts";
import {
	FakeWebSocket,
	attached,
	assistantMsg,
	callResult,
	dispatch,
	dispatchSeq,
	flushMicrotasks,
	holdCommands,
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

let baselineToasts: typeof state.toasts;
let baselinePlanModeEnabled: typeof state.planModeEnabled;
let baselineTodoPhases: typeof state.todoPhases;

beforeAll(() => {
	baselineToasts = [...state.toasts];
	baselinePlanModeEnabled = state.planModeEnabled;
	baselineTodoPhases = state.todoPhases;
});

afterAll(() => {
	setState("toasts", baselineToasts);
	setState("planModeEnabled", baselinePlanModeEnabled);
	setState("todoPhases", baselineTodoPhases);
	setState("collabStatus", COLLAB_OFF);
});

beforeEach(() => {
	installTransportStubs();
	setState({
		currentWorkspaceId: "",
		sessionScope: undefined,
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
		// (roster frames otherwise leak into each other).
		sessionRoster: [],
		sessionActivity: {},
		registeredProjects: [],
		providerProfiles: [],
		fleetConfigPath: null,
		worktreeDeleteInfo: {},
		newWorkspaceProjectId: null,
		highlightProjectId: null,
		deleteWorkspaceTarget: null,
		removeProjectTarget: null,
		lightboxImage: null,
		sessionDetailsId: null,
		modal: null,
		// Top-level view mode + its UI flags (setView / setTxSidebarVisible);
		// reset for isolation.
		view: "chat",
		txSidebarVisible: true,
		modelSynced: false,
		transcriptPhase: "idle",
		transcriptError: null,
		collabStatus: COLLAB_OFF,
		todoPhases: [],
		transcriptTarget: null,
	});
});

// Browser doubles are process-global (see web.testkit.ts) and would otherwise
// leak into sibling test files run in the same process. Restore them after each
// test, including test-specific overrides. Unanswered calls (e.g. the boot and
// attach settings loads) are settled first so their replay timers never fire
// after `window` is gone.
afterEach(() => {
	rejectPendingCalls(new Error("test teardown"));
	// An attach a test left in flight would otherwise gate the next test's roster reconciliation.
	rejectPendingAttach(new Error("test teardown"));
	restoreBrowserGlobals();
});

describe("attached-frame handling", () => {
	test("session switch rejects the old session's calls but the fresh getSubagents pull survives", async () => {
		connect();
		const es = FakeWebSocket.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.(); // connected = true; without this call() fails fast

		// A previous-session call is in flight when the switch lands.
		const oldCall = call("getSettings");
		expect(posted.map((c) => (c.type === "call" ? c.method : c.type))).toEqual(["getSettings"]);

		// First attach: no switch, so the pull is issued and nothing is rejected.
		dispatch(attached("session-a"));
		expect(
			posted.map((c) => (c.type === "call" ? c.method : c.type)).filter((m) => m !== "getJobTree"),
		).toEqual([
			"getSettings",
			"getSubagents",
			"getSettings", // attach reads the boot settings values (settingsAttached)
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
		// The shared job poll asks `getJobTree` on attach by design; this test guards the settings/subagents calls.
		const calls = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method !== "getJobTree",
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
		expect(state.currentWorkspaceId).toBe("session-b");
	});

	test("a session switch drops the transcripts the previous session's panes loaded", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
		setState(
			"subagents",
			new Map([
				["owl", { id: "owl", index: 0, agent: "task", status: "completed", lastUpdate: 1 }],
			]),
		);
		syncSubagentTranscript("owl");
		const read = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "getSubagentMessages",
		);
		expect(read).toBeDefined();
		const message = { role: "user", content: "go", timestamp: 1 };
		dispatch(
			callResult(read!.id, {
				sessionFile: "/s/a.jsonl",
				fromByte: 0,
				nextByte: 10,
				reset: false,
				hasMore: false,
				entries: [{ type: "message", id: "m1", parentId: null, timestamp: "t", message }],
				messages: [message],
			}),
		);
		await flushMicrotasks();
		expect(subagentTranscript("owl").items).toHaveLength(1);

		dispatch(attached("session-b"));
		// Transcripts are keyed by session: look at session-a's key again.
		setState("currentWorkspaceId", "session-a");
		expect(subagentTranscript("owl").items).toHaveLength(0);
	});

	test("a re-attach of the same session drops the previous generation's scope before the on-attach calls", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d9"));
		dispatch({
			type: "state",
			state: {
				sessionId: "d9",
				sessionScope: { workspaceId: "w1", sessionId: "d9", generation: "1" },
			} as WebSessionState,
		});
		expect(state.sessionScope?.generation).toBe("1");

		// A UI stop keeps the view; waking the row re-attaches the SAME session
		// (generation 2 on the session side), so this is not a switched attach.
		posted.length = 0;
		dispatch(attached("d9"));
		const calls = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call",
		);
		expect(calls.map((c) => c.method)).toEqual(["getSubagents", "getSettings"]);
		for (const c of calls) expect(c.scope).toBeUndefined();
		expect(state.sessionScope).toBeUndefined();

		// The new attachment's first state frame re-stamps the scope.
		dispatch({
			type: "state",
			state: {
				sessionId: "d9",
				sessionScope: { workspaceId: "w1", sessionId: "d9", generation: "2" },
			} as WebSessionState,
		});
		expect(state.sessionScope?.generation).toBe("2");
	});
});

describe("replay dedup (finding #2: resume must not double-apply deltas)", () => {
	function primeAndStream(): void {
		connect();
		const es = FakeWebSocket.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("a delta live-delivered during priming is not double-applied by the ring replay", async () => {
		primeAndStream();
		// A fresh prime with an empty transcript; a NEW turn streams live while
		// the paced prime is still in flight (delta seqs >= DELTA_SEQ_START).
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
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

	test("a dangling tool call in an idle transcript settles to interrupted", () => {
		primeAttached();
		dispatch({ type: "history", messages: pendingAskHistory() } as ServerFrame);
		dispatch({ type: "state", state: { isStreaming: false } as unknown as WebSessionState });
		expect(state.items.find((it) => it.kind === "tool")).toMatchObject({ status: "interrupted" });
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
		FakeWebSocket.instances.at(-1)!.onopen?.(); // connected = true

		const attach = attachSession("workspace-a");
		const { id } = lastAttach();

		// A global error (e.g. ANOTHER session's pipe lost, or a spawn failure)
		// while this attach is in flight must not reject it; global errors are
		// uncorrelated broadcasts; only the id-keyed attach_result settles it.
		dispatch({ type: "error", error: "session connection lost" });
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

		dispatch({ type: "attach_result", id, ok: true, workspaceId: "workspace-a" });
		await expect(attach).resolves.toBe("workspace-a");
	});

	test("a keyed attach_result failure rejects the attach", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		const attach = attachSession("workspace-b");
		const { id } = lastAttach();

		dispatch({ type: "attach_result", id, ok: false, error: "unknown session: d9" });
		await expect(attach).rejects.toThrow("unknown session: d9");
	});

	test("a stale attach_result for a superseded attach never settles the new waiter", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		// Latest-wins: the second attach supersedes the first (which resolves
		// immediately with whatever session is current, still "" here).
		const first = attachSession("workspace-a");
		const firstCmd = lastAttach();
		const second = attachSession("workspace-b");
		const secondCmd = lastAttach();
		expect(firstCmd.id).not.toBe(secondCmd.id);
		await expect(first).resolves.toBe("");

		// The superseded attach's keyed result must not settle the second waiter.
		dispatch({ type: "attach_result", id: firstCmd.id, ok: true, workspaceId: "workspace-a" });
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

		dispatch({ type: "attach_result", id: secondCmd.id, ok: true, workspaceId: "workspace-b" });
		await expect(second).resolves.toBe("workspace-b");
	});
});

describe("ui_request_end dismissal (finding #16)", () => {
	test("a settled dialog's ui_request_end dismisses it; ends for other ids leave it open", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
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
		const es = FakeWebSocket.instances.at(-1)!;
		es.onopen?.();
		expect(state.connected).toBe(true);
		dispatch({ type: "hello_ok", proto: 1, name: "old", cwd: "/x", pid: 1, version: "0.0.0" });
		expect(state.error).toContain("proto mismatch");
		expect(state.error).toContain(`expected ${OMP_PROTO}`);
		expect(state.connected).toBe(false);
		// Fail-closed: the socket is torn down and NO reconnect is scheduled
		// (a retry would show a backoff delay and dial a second FakeWebSocket).
		expect(state.reconnectDelay).toBe(0);
		expect(FakeWebSocket.instances.length).toBe(1);
	});

	test("hello_ok with the current proto is accepted", () => {
		connect();
		const es = FakeWebSocket.instances.at(-1)!;
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

	test("connect/open/teardown write ring entries; a socket close schedules the jittered backoff retry", () => {
		vi.useFakeTimers();
		try {
			connect();
			expect(state.debugLog.at(-1)?.message).toBe("connecting /ws");
			const ws = FakeWebSocket.instances.at(-1)!;
			ws.onopen?.();
			expect(state.debugLog.at(-1)?.message).toBe("stream open");
			expect(state.reconnectDelay).toBe(0);

			ws.serverClose(1006);
			expect(state.connected).toBe(false);
			// reconnectDelayMs(0): uniform in [MIN/2, MIN] (RECONNECT_BACKOFF_MIN_MS = 1000).
			const delay = state.reconnectDelay;
			expect(delay).toBeGreaterThanOrEqual(500);
			expect(delay).toBeLessThanOrEqual(1000);
			const messages = state.debugLog.map((e) => e.message).join("\n");
			expect(messages).toContain("stream closed");
			expect(messages).toContain(`connection lost, retrying in ${delay}ms`);

			// The scheduled retry dials a fresh socket once the backoff elapses.
			vi.advanceTimersByTime(delay);
			expect(FakeWebSocket.instances.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the ring is capped at 300 entries, oldest dropped", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		// session_status frames land one ring entry each; distinct workspace ids
		// make the cap's drop boundary observable in the messages.
		for (let i = 0; i < 320; i++) {
			dispatch({ type: "session_status", workspaceId: `d${i}`, status: "ready" });
		}
		expect(state.debugLog.length).toBe(300);
		expect(state.debugLog[0].message).toContain("d20");
		expect(state.debugLog[299].message).toContain("d319");
	});

	test("attach/attach_result and error frames land ring entries", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch(attached("workspace-a"));
		expect(state.debugLog.at(-1)?.message).toBe("attached workspace-a");

		dispatch({ type: "error", error: "session connection lost" });
		expect(state.debugLog.at(-1)?.message).toBe("error frame: session connection lost");
		expect(state.debugLog.at(-1)?.level).toBe("error");

		const attach = attachSession("workspace-a");
		dispatch({ type: "attach_result", id: lastAttachId(), ok: true, workspaceId: "workspace-a" });
		expect(state.debugLog.at(-1)?.message).toBe("attach ok: workspace-a");
		await expect(attach).resolves.toBe("workspace-a");

		// A failed attach writes a warn entry and rejects the caller.
		const bad = attachSession("workspace-b");
		dispatch({
			type: "attach_result",
			id: lastAttachId(),
			ok: false,
			error: "unknown session: d9",
		});
		expect(state.debugLog.at(-1)?.message).toBe("attach failed: unknown session: d9");
		expect(state.debugLog.at(-1)?.level).toBe("warn");
		await expect(bad).rejects.toThrow("unknown session: d9");
	});
});

describe("fleet settings fallback (no session attached)", () => {
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

	test("refreshSettings GETs /ctl/settings and stores the model (nothing sent in band)", async () => {
		setState({
			currentWorkspaceId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch(() => ({ status: 200, body: model }));

		refreshSettings();
		await settle();

		expect(requests).toEqual([{ url: "/ctl/settings", method: "GET", body: undefined }]);
		expect(posted).toEqual([]); // nothing went over the browser socket
		expect(state.settingsModel).toBe(model);
		expect(state.settingsLoading).toBe(false);
		expect(state.error).toBeNull();
	});

	test("updateSetting POSTs /ctl/settings/set with {path, value} and stores the response model", async () => {
		setState({
			currentWorkspaceId: "",
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
			currentWorkspaceId: "",
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
			currentWorkspaceId: "",
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
			currentWorkspaceId: "",
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

	test("with a session attached, updateSetting stays on the in-band call path (no /ctl fetch)", async () => {
		setState({
			currentWorkspaceId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		const requests = stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.(); // connected = true so call() posts
		// Flip to an attached state AFTER the stream opens. onopen's boot refresh
		// is a GET /ctl/settings, which the assertion below excludes.
		setState({ currentWorkspaceId: "workspace-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();

		expect(requests.filter((r) => r.url.startsWith("/ctl") && r.method !== "GET")).toEqual([]); // no /ctl write while attached
		// The browser socket carries the RPC (recorded in `posted`).
		const calls = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "setSetting",
		);
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
		setState({ currentWorkspaceId: "", settingsModel: null, settingsLoading: false, error: null });
		stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();
		const write = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "setSetting",
		)!;
		expect(write.args).toEqual(["agent.model", "gpt-5", null, null, "revision"]);

		const next: SettingsModel = { tabs: [], revision: 12 };
		dispatch({ type: "settings_changed", model: next });
		dispatch(callResult(write.id, { revision: 12 }));
		await settle();
		expect(state.settingsModel).toEqual(next);
		const reads = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "getSettings",
		);
		expect(reads).toEqual([]);
	});

	test("a revision reply ahead of the pushed model refetches the full model", async () => {
		setState({ currentWorkspaceId: "", settingsModel: null, settingsLoading: false, error: null });
		stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });

		updateSetting("agent.model", "gpt-5");
		await settle();
		const write = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "setSetting",
		)!;
		dispatch(callResult(write.id, { revision: 13 }));
		await settle();
		const read = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "getSettings",
		);
		expect(read).toBeDefined();
		dispatch(callResult(read!.id, { tabs: [], revision: 13 }));
		await settle();
		expect(state.settingsModel?.revision).toBe(13);
	});

	/** The getSettings calls posted so far, in order. */
	function settingsReads(): Array<Extract<ClientCommand, { type: "call" }>> {
		return posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "getSettings",
		);
	}

	test("an attach reads only the boot paths' values; the full model waits for a surface that shows it", async () => {
		setState({
			currentWorkspaceId: "",
			settingsModel: null,
			settingValues: {},
			settingsLoading: false,
			error: null,
		});
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });
		posted.length = 0;
		dispatch(attached("workspace-a"));

		const [read, ...rest] = settingsReads();
		expect(rest).toEqual([]);
		expect(read!.args).toEqual([{ paths: BOOT_SETTING_PATHS }]);
		dispatch(
			callResult(read!.id, {
				revision: 3,
				target: "current-session",
				values: { emojiAutocomplete: false },
			}),
		);
		await settle();
		expect(settingValue<boolean>("emojiAutocomplete")).toBe(false);
		expect(state.settingsModel).toBeNull();
		expect(state.settingsLoading).toBe(false);
	});

	test("an older session that answers a paths read with the full model still fills the boot values", async () => {
		setState({
			currentWorkspaceId: "workspace-a",
			settingsModel: null,
			settingValues: {},
			settingsLoading: false,
			error: null,
		});
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });
		posted.length = 0;
		dispatch(attached("workspace-a"));
		const full: SettingsModel = {
			revision: 4,
			target: "current-session",
			tabs: [
				{
					id: "tools",
					label: "Tools",
					groups: [
						{
							name: "",
							items: [
								{
									path: "emojiAutocomplete",
									label: "Emoji",
									description: "",
									type: "boolean",
									value: false,
									changed: true,
								},
							],
						},
					],
				},
			],
		};
		dispatch(callResult(settingsReads()[0]!.id, full));
		await settle();
		expect(settingValue<boolean>("emojiAutocomplete")).toBe(false);
		expect(state.settingsModel?.revision).toBe(4);
	});

	test("a surface holding the model loads it once per attachment and only revalidates a current one", async () => {
		setState({
			currentWorkspaceId: "workspace-a",
			settingsModel: null,
			settingValues: {},
			settingsLoading: false,
			error: null,
		});
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });
		dispatch(attached("workspace-a"));
		posted.length = 0;

		const release = holdSettingsModel();
		expect(settingsReads().map((c) => c.args)).toEqual([[]]);
		dispatch(
			callResult(settingsReads()[0]!.id, { tabs: [], revision: 5, target: "current-session" }),
		);
		await settle();
		release();

		// Reopened in the same attachment: a revision check, not a second 160 KB model.
		posted.length = 0;
		const again = holdSettingsModel();
		expect(settingsReads().map((c) => c.args)).toEqual([[{ paths: BOOT_SETTING_PATHS }]]);
		// Another writer moved the revision: the held model is refetched while the surface is open.
		dispatch(
			callResult(settingsReads()[0]!.id, { revision: 6, target: "current-session", values: {} }),
		);
		await settle();
		expect(settingsReads().map((c) => c.args)).toEqual([[{ paths: BOOT_SETTING_PATHS }], []]);
		again();
	});

	test("queued writes run one at a time, each sending the revision the previous response produced", async () => {
		setState({
			currentWorkspaceId: "",
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
			currentWorkspaceId: "",
			settingsModel: null,
			settingsLoading: false,
			error: null,
		});
		stubFetch(() => ({ status: 200, body: model }));
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState({ currentWorkspaceId: "workspace-a" });

		updateSetting("display.hideToolActivity", true, 3);
		await settle();
		const sent = posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call",
		);
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
		setState({ currentWorkspaceId: "workspace-a", settingsModel: null });
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		setState({ currentWorkspaceId: "workspace-a", settingsModel: null });
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

	test("a waiting plan review is mirrored but does not open the sheet while Plan Mode is in development", () => {
		connect();
		dispatch(stateFrame({ planReviewPending: true }));
		expect(state.planReviewPending).toBe(true);
		expect(state.modal).toBeNull();
		dispatch(stateFrame({ planReviewPending: false }));
		expect(state.planReviewPending).toBe(false);
	});

	test("a frame without role state clears the prior mirror (session-scoped, unlike the session roster)", () => {
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
		dispatch(attached("workspace-a"));
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

		// A session switch drops the sync before the new session's priming.
		dispatch(attached("workspace-b"));
		expect(state.modelSynced).toBe(false);
	});
});

describe("answerUnviewed (turn ended below the viewport)", () => {
	/** A fully primed stream: attached, empty history, readiness gate cleared. */
	function primeReady(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}
	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end" },
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
				event: { type: "agent_end", isTerminal: false, yielded: false },
			},
			1025,
		);
		expect(state.streaming).toBe(true);
		expect(state.live.active).toBe(false);
		expect(state.workingIntent).toBeUndefined();
		expect(state.answerUnviewed).toBe(false);
		expect(state.announcement).toBe("agent started");
	});

	test("a yielded turn awaiting background work still signals a completed answer", () => {
		primeReady();
		setState({ chatPinned: false });
		dispatchSeq(agentStart(), 1024);
		dispatchSeq(
			{
				type: "event",
				event: {
					type: "agent_end",
					isTerminal: false,
					yielded: true,
					awaitingAsyncWork: true,
				},
			},
			1025,
		);
		expect(state.streaming).toBe(false);
		expect(state.answerUnviewed).toBe(true);
		expect(state.announcement).toBe("agent finished");
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

	test("entering chat clears the hash via history.replaceState", () => {
		installLocalStorageShim();
		setBrowserGlobal("history", {
			replaceState: vi.fn(),
		} as unknown as typeof history);
		setBrowserGlobal("location", { hash: "#/s/x", pathname: "/app", search: "?a=1" } as Location);
		setView("analysis");
		setView("chat");
		expect(history.replaceState).toHaveBeenCalledWith(null, "", "/app?a=1");
	});

	test("entering analysis keeps the hash untouched", () => {
		installLocalStorageShim();
		const replaceState = vi.fn();
		setBrowserGlobal("history", { replaceState } as unknown as typeof history);
		setBrowserGlobal("location", { hash: "", pathname: "/app", search: "" } as Location);
		setView("analysis");
		expect(replaceState).not.toHaveBeenCalled();
	});

	test("defaults: txSidebarVisible true, view chat", () => {
		installLocalStorageShim();
		expect(state.txSidebarVisible).toBe(true);
		expect(state.view).toBe("chat");
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

	test("a #/stored/<workspaceId>/<sessionId> hash deep-links into analysis", () => {
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

	test("a session route (#/w/<workspaceId>[/s/<sessionId>]) boots into chat, even over a persisted analysis", () => {
		expect(initialView("analysis", "#/w/d7", true)).toBe("chat");
		expect(initialView("analysis", "#/w/d7/s/sess-1", true)).toBe("chat");
	});
});

describe("aria-live announcements (finding #P1)", () => {
	/** A fully primed stream: attached, empty history, readiness gate cleared. */
	function primeReady(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}

	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end" },
	});

	test("an agent turn starting announces only after the session is ready", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
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

	test("a tool run that ends on an interrupt marker announces interrupted", () => {
		primeReady();
		const event = (e: unknown, seq: number) =>
			dispatchSeq({ type: "event", event: e } as ServerFrame, seq);
		event({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: {} }, 1024);
		event(
			{
				type: "tool_execution_end",
				toolCallId: "t9",
				toolName: "bash",
				isError: true,
				result: { output: "", details: { __synthetic: true, source: "orphan" } },
			},
			1025,
		);
		expect(state.announcement).toBe("bash interrupted");
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
		dispatchSeq({ type: "history", messages: [] }, 3);
		dispatch({ type: "ready", readyAt: 123 });
	}
	const agentStart = (): ServerFrame => ({ type: "event", event: { type: "agent_start" } });
	const agentEnd = (): ServerFrame => ({
		type: "event",
		event: { type: "agent_end" },
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
		// Reconnect primed against an idle session: the state frame says the turn
		// is over, so the last intent must not linger under the shimmer.
		dispatch({ type: "state", state: { isStreaming: false } as unknown as WebSessionState });
		expect(state.workingIntent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Phase 5: project-first sidebar state: registered_projects frame handling
// (fleet-scoped, survives session resets) + sessionsByProject grouping.
// ---------------------------------------------------------------------------
describe("Phase 5: registered projects and project-first grouping", () => {
	const p1: RegisteredProject = { projectId: "p1", path: "/repos/a", name: "a", addedAt: 1 };
	const p2: RegisteredProject = { projectId: "p2", path: "/repos/b", name: "b", addedAt: 2 };
	const p3: RegisteredProject = { projectId: "p3", path: "/repos/c", name: "c", addedAt: 3 };

	/** Minimal roster entry; extra fields (projectId/worktreeOf/…) ride along. */
	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	test("registered_projects populates the store and survives a session reset (fleet-scoped)", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({ type: "registered_projects", projects: [p1, p2, p3] });
		expect(state.registeredProjects).toEqual([p1, p2, p3]);

		// A session switch runs resetSessionView (session-scoped cleanup); the
		// project registry is fleet-scoped and must come through intact.
		dispatch(attached("workspace-a"));
		dispatch(attached("workspace-b")); // switch → resetSessionView
		expect(state.currentWorkspaceId).toBe("workspace-b");
		expect(state.registeredProjects).toEqual([p1, p2, p3]);
	});

	test("a later registered_projects broadcast replaces the collection wholesale", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({ type: "registered_projects", projects: [p1, p2] });
		dispatch({ type: "registered_projects", projects: [p2] }); // p1 deregistered
		expect(state.registeredProjects).toEqual([p2]);
	});

	test("registered_projects carries the fleet config path (additive; missing = null, fleet-scoped)", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		// A frame without configPath means no config file: the store reads null.
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
		dispatch(attached("workspace-a"));
		dispatch(attached("workspace-b")); // switch → resetSessionView
		expect(state.currentWorkspaceId).toBe("workspace-b");
		expect(state.registeredProjects).toEqual([p1]);
		expect(state.fleetConfigPath).toBe("/home/u/.omp-web/config.json");
	});

	test("sessionsByProject: registry order, zero-session projects present, main-checkout rows first", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		// Registry order deliberately differs from roster order.
		dispatch({ type: "registered_projects", projects: [p2, p1, p3] });
		dispatch({
			type: "roster",
			entries: [
				session("b-main", { projectId: "p2" }),
				session("a-wt", { projectId: "p1", worktreeOf: "a" }),
				session("a-main", { projectId: "p1" }),
			],
		});

		const groups = sessionsByProject();
		expect(groups.map((g) => g.project.projectId)).toEqual(["p2", "p1", "p3"]);
		expect(groups[0].sessions.map((d) => d.workspaceId)).toEqual(["b-main"]);
		// Main-checkout row first, then worktrees, regardless of roster order.
		expect(groups[1].sessions.map((d) => d.workspaceId)).toEqual(["a-main", "a-wt"]);
		expect(groups[2].sessions).toEqual([]); // zero-session project still renders
	});

	test("sessionsByProject drops entries without a projectId and orders each group main, worktrees by branch, clones", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch({ type: "registered_projects", projects: [p1] });
		dispatch({
			type: "roster",
			entries: [
				// Unregistered: no projectId, so no group shows it.
				session("zeta-main", { project: "zeta" }),
				session("clone-b", { projectId: "p1", workspaceKind: "clone", name: "clone-b" }),
				session("wt-zed", { projectId: "p1", worktreeOf: "a", branch: "zed" }),
				session("wt-alpha", { projectId: "p1", worktreeOf: "a", branch: "alpha" }),
				session("a-main", { projectId: "p1", workspaceKind: "direct" }),
				session("clone-a", { projectId: "p1", workspaceKind: "clone", name: "clone-a" }),
			],
		});

		const groups = sessionsByProject();
		expect(groups.map((g) => g.project.projectId)).toEqual(["p1"]);
		expect(groups[0].sessions.map((d) => d.workspaceId)).toEqual([
			"a-main",
			"wt-alpha",
			"wt-zed",
			"clone-b",
			"clone-a",
		]);
	});

	test("worktree_delete_info answers populate the workspaceId-keyed evidence map (fleet-scoped)", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({
			type: "worktree_delete_info",
			workspaceId: "d1",
			linked: true,
			dirty: true,
			git: { added: 1, modified: 0, deleted: 0, untracked: 2 },
			branch: "feat",
			merged: false,
			unpushed: true,
		});
		dispatch({
			type: "worktree_delete_info",
			workspaceId: "d1",
			linked: true,
			dirty: false,
			branch: "feat",
			merged: true,
			unpushed: false,
		});
		dispatch({
			type: "worktree_delete_info",
			workspaceId: "d2",
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

		// Fleet-scoped: survives the reset of a session switch.
		dispatch(attached("workspace-a"));
		dispatch(attached("workspace-b"));
		expect(state.worktreeDeleteInfo["d2"]).toMatchObject({
			linked: false,
			dirty: false,
			reason: "not a linked worktree",
		});
	});

	test("listProjectBranches resolves via a matching project_branches frame; other projects or remotes do not settle it", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.(); // connected = true

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
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		FakeWebSocket.instances.at(-1)!.onopen?.();

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

	test("sendRemoveProject posts remove_project", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		sendRemoveProject("p1");
		expect(posted).toEqual([{ type: "remove_project", id: expect.any(String), projectId: "p1" }]);
	});

	test("createWorktree posts create_worktree (start:true) and resolves with the workspaceId from workspace_create_result", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, workspaceId: "d7" });
		await expect(created).resolves.toEqual({ workspaceId: "d7" });
	});

	test("createWorktree with an existing branch posts existingBranch; a refusal rejects with the fleet's message", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		dispatch({ type: "workspace_create_result", id: lastCommandId(), ok: true, workspaceId: "d8" });
		await expect(cloned).resolves.toEqual({ workspaceId: "d8" });
	});

	test("resetPendingProjects (stream teardown) rejects in-flight add and create waiters with Disconnected", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		const added = addProject("/repos/a");
		const created = createWorktree("p1", { name: "feat" });
		resetPendingProjects();
		await expect(added).rejects.toThrow("Disconnected");
		await expect(created).rejects.toThrow("Disconnected");
	});

	test("syncProjects posts sync_projects and coalesces calls within 5s", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

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
		FakeWebSocket.instances.at(-1)!.onopen?.();

		sendDeleteWorktree("d1", { deleteBranch: "feat" });
		expect(posted).toEqual([
			{ type: "delete_worktree", id: expect.any(String), workspaceId: "d1", deleteBranch: "feat" },
		]);

		posted.length = 0;
		sendDeleteWorktree("d1");
		expect(posted).toEqual([
			{ type: "delete_worktree", id: expect.any(String), workspaceId: "d1" },
		]);
	});

	test("sendWorktreeDeleteInfo posts worktree_delete_info for the session", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		sendWorktreeDeleteInfo("d1");
		expect(posted).toEqual([
			{ type: "worktree_delete_info", id: expect.any(String), workspaceId: "d1" },
		]);
	});
});

// ---------------------------------------------------------------------------
// worktree_removed: poll-detected on-disk worktree removal (the fleet evicted
// the session and broadcasts). One toast per eviction + an aria-live announce;
// fleet-edge-only like registered_projects, so no session guard is applied.
// ---------------------------------------------------------------------------
describe("worktree_removed (on-disk removal toast)", () => {
	/** A fully primed stream: attached + empty history. */
	function prime(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("s1"));
	}

	test("a worktree_removed frame appends one toast (name + path) and announces it", () => {
		prime();
		dispatch({
			type: "worktree_removed",
			workspaceId: "d1",
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
			workspaceId: "d1",
			name: "feat-x",
			path: "/repos/proj/worktrees/feat-x",
		} as ServerFrame);
		dispatch({
			type: "worktree_removed",
			workspaceId: "d2",
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
			workspaceId: "d1",
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
// Roster truth vs. the attached chat column: a roster/session_status frame
// marking the attached session dead (asleep/error) or removing it clears the
// session view, but MUST NOT fire while that session's attach is in flight
// (a freshly waking session reads as "asleep" in lagging roster frames).
// ---------------------------------------------------------------------------
describe("attached session reconciliation against roster truth", () => {
	/** Minimal roster entry; status/extra fields ride along. */
	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	test("a re-dialing attached session reaches the strip only after the grace window", () => {
		vi.useFakeTimers();
		try {
			attachAndPrime();
			dispatch({ type: "roster", entries: [session("workspace-a", { status: "reconnecting" })] });
			expect(connectionState()).toBe("connected");
			vi.advanceTimersByTime(1_600);
			expect(connectionState()).toBe("reconnecting");
			dispatch({ type: "roster", entries: [session("workspace-a", { status: "ready" })] });
			expect(connectionState()).toBe("connected");
		} finally {
			vi.useRealTimers();
		}
	});

	/** Connect + attach to a session with an empty-transcript prime in place. */
	function attachAndPrime(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("workspace-a"));
		dispatchSeq({ type: "history", messages: [userMsg("q"), assistantMsg("a")] } as ServerFrame, 3);
		setState("readyAt", 123);
	}

	test("a roster frame marking the attached session asleep clears the session view (roster survives)", () => {
		attachAndPrime();
		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });

		expect(state.currentWorkspaceId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		// Fleet-scoped roster data survives the session clear.
		expect(state.sessionRoster.map((d) => d.workspaceId)).toEqual(["workspace-a"]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a roster_delta marking the attached session asleep clears the session view (roster survives)", () => {
		attachAndPrime();
		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });

		dispatch({
			type: "roster_delta",
			upserted: [session("workspace-a", { status: "asleep" })],
			removed: [],
		});

		expect(state.currentWorkspaceId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		// Fleet-scoped roster data survives the session clear.
		expect(state.sessionRoster.map((d) => d.workspaceId)).toEqual(["workspace-a"]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a roster frame keeping the attached session ready does NOT clear", () => {
		attachAndPrime();

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "ready" })] });

		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(state.readyAt).toBe(123);
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);
	});

	test("removing the attached entry from the roster clears the session view", () => {
		attachAndPrime();

		dispatch({ type: "roster", entries: [] });

		expect(state.currentWorkspaceId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
	});

	test("a session_status asleep frame for the attached session clears the session view", () => {
		attachAndPrime();
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "ready" })] });

		dispatch({ type: "session_status", workspaceId: "workspace-a", status: "asleep" });

		expect(state.currentWorkspaceId).toBe("");
		expect(state.readyAt).toBeUndefined();
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
	});

	test("RACE: a lagging 'asleep' roster frame does not clear while the attach is in flight", async () => {
		attachAndPrime();
		// The proxied attached frame already set currentWorkspaceId, but the
		// id-keyed attach_result has not settled yet (finding #28: priming
		// rides the session pipe, which may be mid-redial); the wake-attach
		// is still in flight, so the lagging roster must not clear.
		const attach = attachSession("workspace-a");
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);

		// Once the attach settles, the same asleep roster frame IS truth.
		dispatch({ type: "attach_result", id: cmd.id, ok: true, workspaceId: "workspace-a" });
		await expect(attach).resolves.toBe("workspace-a");
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(state.currentWorkspaceId).toBe("");
		expect(hasLiveSession()).toBe(false);
	});

	test("the in-flight guard only protects the attach target (a different dead session clears)", async () => {
		attachAndPrime();
		// Attaching to workspace-b must not shield a workspace-a that died.
		const attach = attachSession("workspace-b");
		const cmd = posted.at(-1);
		if (!cmd || cmd.type !== "attach") throw new Error("expected an attach command");

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(state.currentWorkspaceId).toBe("");

		dispatch({ type: "attach_result", id: cmd.id, ok: true, workspaceId: "workspace-b" });
		await expect(attach).resolves.toBe("workspace-b");
	});

	test("hasLiveSession: transitional wake statuses stay live, terminal-dead statuses gate the pane", () => {
		attachAndPrime();
		// A transitional wake status is never dead.
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "connecting" })] });
		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(hasLiveSession()).toBe(true);

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "error" })] });
		expect(state.currentWorkspaceId).toBe("");
		expect(hasLiveSession()).toBe(false);
	});

	test("a user stop keeps the attached transcript behind the stopped strip; restart clears the mark", () => {
		attachAndPrime();
		stopSessionById("workspace-a");
		expect(isUserStopped("workspace-a")).toBe(true);

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });

		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(state.readyAt).toBeUndefined();
		expect(itemCounts()).toEqual({ user: 1, assistant: 1 });
		expect(hasLiveSession()).toBe(true);

		restartSessionById("workspace-a");
		expect(isUserStopped("workspace-a")).toBe(false);
	});

	test("an attached session that goes asleep mid-compaction drops the compacting badge", () => {
		// The last state frame said compacting; the dead process never sends the frame that clears it.
		attachAndPrime();
		setState("compacting", true);
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(state.currentWorkspaceId).toBe("");
		expect(state.compacting).toBe(false);
	});

	test("a user stop mid-compaction keeps the transcript but drops the compacting badge", () => {
		attachAndPrime();
		setState("compacting", true);
		stopSessionById("workspace-a");
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(state.currentWorkspaceId).toBe("workspace-a");
		expect(state.compacting).toBe(false);
		restartSessionById("workspace-a");
	});

	test("restarting a ready process waits for the roster to show it asleep before waking", () => {
		attachAndPrime();
		dispatch({ type: "roster", entries: [session("workspace-a", { status: "ready" })] });
		restartSessionById("workspace-a");
		expect(isUserStopped("workspace-a")).toBe(true);

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "ready" })] });
		expect(isUserStopped("workspace-a")).toBe(true);

		dispatch({ type: "roster", entries: [session("workspace-a", { status: "asleep" })] });
		expect(isUserStopped("workspace-a")).toBe(false);
	});

	test("a user-stopped attached session removed from the roster clears the view and its mark", () => {
		attachAndPrime();
		stopSessionById("workspace-a");

		dispatch({ type: "roster", entries: [] });

		expect(state.currentWorkspaceId).toBe("");
		expect(state.items).toEqual([]);
		expect(hasLiveSession()).toBe(false);
		expect(isUserStopped("workspace-a")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// roster_delta: the edge sends the full roster once on open and then only the
// rows each registry mutation changed. A delta patches state.sessionRoster in
// place (by workspaceId), appends new rows, and drops removed ids.
// ---------------------------------------------------------------------------
describe("roster_delta frames", () => {
	/** Minimal roster entry; status/extra fields ride along. */
	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	const rosterIds = (): string[] => state.sessionRoster.map((d) => d.workspaceId);

	/** Open the stream and seed the roster with sessions A and B. */
	function seedAB(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch({ type: "roster", entries: [session("a"), session("b")] });
		expect(rosterIds()).toEqual(["a", "b"]);
	}

	test("an upserted row patches its entry in place and keeps the order and the other rows", () => {
		seedAB();

		dispatch({
			type: "roster_delta",
			upserted: [session("a", { status: "asleep" })],
			removed: [],
		});

		expect(rosterIds()).toEqual(["a", "b"]);
		expect(state.sessionRoster[0]?.status).toBe("asleep");
		expect(state.sessionRoster[1]?.status).toBe("ready");
	});

	test("an upserted row with a new id is appended after the existing rows", () => {
		seedAB();

		dispatch({ type: "roster_delta", upserted: [session("c")], removed: [] });

		expect(rosterIds()).toEqual(["a", "b", "c"]);
	});

	test("a removed id drops its row and leaves the others", () => {
		seedAB();

		dispatch({ type: "roster_delta", upserted: [], removed: ["b"] });

		expect(rosterIds()).toEqual(["a"]);
		expect(state.sessionRoster[0]?.status).toBe("ready");
	});

	test("a full roster frame with identical ids keeps every row's store object", () => {
		seedAB();
		const [a, b] = [state.sessionRoster[0]!, state.sessionRoster[1]!];

		dispatch({
			type: "roster",
			entries: [session("a", { name: "renamed" }), session("b")],
		});

		expect(state.sessionRoster[0]).toBe(a);
		expect(state.sessionRoster[1]).toBe(b);
		expect(a.name).toBe("renamed");
	});

	test("a full roster frame drops absent ids and deletes fields the frame no longer carries", () => {
		seedAB();
		dispatch({ type: "roster", entries: [session("a", { error: "boom" }), session("b")] });
		const a = state.sessionRoster[0]!;
		expect(a.error).toBe("boom");

		dispatch({ type: "roster", entries: [session("a")] });

		expect(rosterIds()).toEqual(["a"]);
		expect(state.sessionRoster[0]).toBe(a);
		expect("error" in a).toBe(false);
	});

	test("a roster_delta upsert keeps the row's store object and updates the changed field", () => {
		seedAB();
		const [a, b] = [state.sessionRoster[0]!, state.sessionRoster[1]!];

		dispatch({
			type: "roster_delta",
			upserted: [session("a", { status: "asleep" })],
			removed: [],
		});

		expect(state.sessionRoster[0]).toBe(a);
		expect(state.sessionRoster[1]).toBe(b);
		expect(a.status).toBe("asleep");
		expect(b.status).toBe("ready");
	});

	test("a roster_delta removal keeps the surviving rows' store objects", () => {
		seedAB();
		dispatch({ type: "roster_delta", upserted: [session("c")], removed: [] });
		const [a, c] = [state.sessionRoster[0]!, state.sessionRoster[2]!];

		dispatch({ type: "roster_delta", upserted: [], removed: ["b"] });

		expect(rosterIds()).toEqual(["a", "c"]);
		expect(state.sessionRoster[0]).toBe(a);
		expect(state.sessionRoster[1]).toBe(c);
	});

	test("a session_status frame patches status and error without replacing the row", () => {
		seedAB();
		const [a, b] = [state.sessionRoster[0]!, state.sessionRoster[1]!];

		dispatch({ type: "session_status", workspaceId: "a", status: "error", error: "spawn failed" });

		expect(state.sessionRoster[0]).toBe(a);
		expect(state.sessionRoster[1]).toBe(b);
		expect(a.status).toBe("error");
		expect(a.error).toBe("spawn failed");
		expect(b.status).toBe("ready");

		// No error on the next frame clears the field (deleted, not left stale).
		dispatch({ type: "session_status", workspaceId: "a", status: "ready" });

		expect(state.sessionRoster[0]).toBe(a);
		expect(a.status).toBe("ready");
		expect("error" in a).toBe(false);
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
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
// Unread-dot tracking: a detached session's session_activity flip true→false
// marks it unread; the row is cleared on attach; dead roster entries are
// pruned. All client-side.
// ---------------------------------------------------------------------------
describe("unread-dot tracking", () => {
	/** Minimal roster entry (mirrors the reconciliation describe). */
	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	/** A turn ending on a detached session: the edge observed streaming → idle. */
	function detachedTurnEnd(id: string): void {
		dispatch({ type: "session_activity", workspaceId: id, streaming: true, blocked: false });
		dispatch({ type: "session_activity", workspaceId: id, streaming: false, blocked: false });
	}

	beforeEach(() => {
		// Module-level unread state must not leak between tests.
		pruneUnread(new Set());
	});

	test("attaching to a marked session clears its unread dot", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("workspace-b")); // workspace-a is detached
		detachedTurnEnd("workspace-a");
		expect(unreadIds().has("workspace-a")).toBe(true);

		dispatch(attached("workspace-a"));

		expect(unreadIds().has("workspace-a")).toBe(false);
	});

	test("a roster frame prunes unread ids for sessions that left", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("workspace-b"));
		detachedTurnEnd("workspace-a");
		expect(unreadIds().has("workspace-a")).toBe(true);

		dispatch({ type: "roster", entries: [session("workspace-b")] });

		expect(unreadIds().has("workspace-a")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// session_activity: the fleet edge's realtime per-session stream (streaming /
// blocked) for EVERY ready session, delivered as additive fleet-scoped frames.
// It carries a workspaceId as payload (not the `scope` stamp), so it passes the stale-frame guard untouched. Fed
// into state.sessionActivity and pruned on roster frames like unread; a
// detached session's observed streaming flip true→false marks it unread.
// ---------------------------------------------------------------------------
describe("session_activity frames", () => {
	/** Minimal roster entry (mirrors the unread/reconciliation describes). */
	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	beforeEach(() => {
		// Module-level unread state must not leak between tests.
		pruneUnread(new Set());
	});

	test("stores per-session activity; an identical repeat is idempotent", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });
		expect(state.sessionActivity["d2"]).toEqual({ streaming: true, blocked: false });

		// Same values again → no change.
		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });
		expect(state.sessionActivity["d2"]).toEqual({ streaming: true, blocked: false });

		// A later frame for the same session updates both fields.
		dispatch({ type: "session_activity", workspaceId: "d2", streaming: false, blocked: true });
		expect(state.sessionActivity["d2"]).toEqual({ streaming: false, blocked: true });
	});

	test("a detached session's streaming flip true→false marks it unread", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });
		expect(unreadIds().has("d2")).toBe(false);

		dispatch({ type: "session_activity", workspaceId: "d2", streaming: false, blocked: false });
		expect(unreadIds().has("d2")).toBe(true);
	});

	test("the ATTACHED session's turn end is NOT marked unread", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d2")); // currentWorkspaceId = d2

		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });
		dispatch({ type: "session_activity", workspaceId: "d2", streaming: false, blocked: false });

		expect(unreadIds().has("d2")).toBe(false);
	});

	test("a roster frame without d2 prunes its sessionActivity entry", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });

		dispatch({ type: "roster", entries: [session("d1")] });

		expect(state.sessionActivity["d2"]).toBeUndefined();

		// An id still on the roster survives a later roster frame (no flush).
		dispatch({ type: "session_activity", workspaceId: "d1", streaming: true, blocked: false });
		dispatch({ type: "roster", entries: [session("d1")] });
		expect(state.sessionActivity["d1"]).toEqual({ streaming: true, blocked: false });
	});
});

// ---------------------------------------------------------------------------
// Browser notifications: only sessions other than the attached one notify, on
// the session_activity edge (turn end carries `endedTurn`; blocked false→true
// is an ask). Delivery needs the toggle, a granted permission, and the SDK
// setting for the event kind.
// ---------------------------------------------------------------------------
describe("session_activity notifications (sessions other than the attached one)", () => {
	/** Records every constructed notification, with its options and handlers. */
	class FakeNotification {
		static permission = "granted";
		static instances: FakeNotification[] = [];
		onclick: (() => void) | null = null;
		closed = 0;
		constructor(
			readonly title: string,
			readonly options?: NotificationOptions,
		) {
			FakeNotification.instances.push(this);
		}
		close(): void {
			this.closed++;
		}
	}

	const hadNotification = Reflect.has(globalThis, "Notification");
	const originalNotification: unknown = Reflect.get(globalThis, "Notification");
	let baselineNotifyEnabled: boolean;

	function session(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: id,
			status: "ready",
			...extra,
		};
	}

	/** Seed the SDK notify settings the way the settings model delivers them. */
	function seedNotifySettings(values: Record<string, "on" | "off">): void {
		const items = Object.entries(values).map(([path, value]) => ({ path, value }));
		setState("settingsModel", { tabs: [{ id: "notifications", groups: [{ items }] }] } as never);
	}

	/** Attached to d1; d2 is a detached session named "Fix parser". */
	function attachD1(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d1"));
		setState("sessionRoster", [session("d1"), session("d2", { name: "Fix parser" })]);
	}

	function activity(
		id: string,
		streaming: boolean,
		blocked = false,
		endedTurn?: Extract<ServerFrame, { type: "session_activity" }>["endedTurn"],
	): void {
		dispatch({
			type: "session_activity",
			workspaceId: id,
			streaming,
			blocked,
			...(endedTurn === undefined ? {} : { endedTurn }),
		});
	}

	beforeAll(() => {
		baselineNotifyEnabled = state.notifyEnabled;
	});

	afterAll(() => {
		setState("notifyEnabled", baselineNotifyEnabled);
		setState("settingsModel", null as never);
		if (hadNotification) Reflect.set(globalThis, "Notification", originalNotification);
		else Reflect.deleteProperty(globalThis, "Notification");
	});

	beforeEach(() => {
		pruneUnread(new Set());
		FakeNotification.instances = [];
		FakeNotification.permission = "granted";
		Reflect.set(globalThis, "Notification", FakeNotification);
		setState("notifyEnabled", true);
		setState("settingsModel", null as never);
		// Unknown activity per test: the first frame for a session is priming, not an edge.
		setState("sessionActivity", { d1: undefined, d2: undefined } as never);
	});

	test("a detached turn end notifies once, titled with the session name", () => {
		attachD1();
		activity("d2", true);
		expect(FakeNotification.instances).toHaveLength(0);

		activity("d2", false, false, { stopReason: "stop" });

		expect(FakeNotification.instances).toHaveLength(1);
		const [n] = FakeNotification.instances;
		expect(n!.title).toBe("Fix parser");
		expect(n!.options).toEqual({ body: "Complete", tag: "omp-session-d2" });
		expect(unreadIds().has("d2")).toBe(true);
	});

	test("an aborted turn notifies as Aborted under the completion setting", () => {
		attachD1();
		activity("d2", true);
		activity("d2", false, false, { stopReason: "aborted" });
		expect(FakeNotification.instances.map((n) => n.options?.body)).toEqual(["Aborted"]);

		FakeNotification.instances = [];
		seedNotifySettings({ "completion.notify": "off" });
		activity("d2", true);
		activity("d2", false, false, { stopReason: "aborted" });
		expect(FakeNotification.instances).toHaveLength(0);
	});

	test("the attached session never notifies, on a turn end or when it blocks", () => {
		attachD1();
		activity("d1", true);
		activity("d1", false, false, { stopReason: "stop" });
		activity("d1", false, true);
		expect(FakeNotification.instances).toHaveLength(0);
	});

	test("a streaming flip without endedTurn does not notify but still marks unread", () => {
		attachD1();
		activity("d2", true);
		activity("d2", false);
		expect(FakeNotification.instances).toHaveLength(0);
		expect(unreadIds().has("d2")).toBe(true);
	});

	test("an errored turn is silent by default and notifies when error.notify is on", () => {
		attachD1();
		const failed = { stopReason: "error", errorMessage: "rate limited" } as const;
		activity("d2", true);
		activity("d2", false, false, failed);
		expect(FakeNotification.instances).toHaveLength(0);

		seedNotifySettings({ "error.notify": "on" });
		activity("d2", true);
		activity("d2", false, false, failed);
		expect(FakeNotification.instances).toHaveLength(1);
		expect(FakeNotification.instances[0]!.options).toEqual({
			body: "Stopped with error: rate limited",
			tag: "omp-session-d2",
		});
	});

	test("a detached session blocking notifies Waiting for input, once per edge", () => {
		attachD1();
		activity("d2", false, false);
		activity("d2", false, true);
		expect(FakeNotification.instances.map((n) => n.options?.body)).toEqual(["Waiting for input"]);

		activity("d2", false, true);
		expect(FakeNotification.instances).toHaveLength(1);

		seedNotifySettings({ "ask.notify": "off" });
		activity("d2", false, false);
		activity("d2", false, true);
		expect(FakeNotification.instances).toHaveLength(1);
	});

	test("a session already waiting when its activity is first seen does not notify", () => {
		attachD1();
		activity("d2", false, true);
		expect(FakeNotification.instances).toHaveLength(0);
	});

	test("nothing is delivered with the toggle off, permission not granted, or no Notification API", () => {
		attachD1();
		const end = () => {
			activity("d2", true);
			activity("d2", false, false, { stopReason: "stop" });
		};

		setState("notifyEnabled", false);
		end();
		setState("notifyEnabled", true);
		FakeNotification.permission = "denied";
		end();
		FakeNotification.permission = "granted";
		Reflect.deleteProperty(globalThis, "Notification");
		end();

		expect(FakeNotification.instances).toHaveLength(0);
	});

	test("clicking focuses the window, switches to the session and closes the notification", () => {
		attachD1();
		let focused = 0;
		Reflect.set(window, "focus", () => {
			focused++;
		});
		activity("d2", true);
		activity("d2", false, false, { stopReason: "stop" });
		const n = FakeNotification.instances[0]!;
		expect(n.onclick).not.toBeNull();

		n.onclick!();

		expect(focused).toBe(1);
		expect(n.closed).toBe(1);
		expect(state.transcriptTarget).toBe("d2");
	});
});

// ---------------------------------------------------------------------------
// Stale-frame guard scope. The edge stamps `scope` only on session-scoped
// frames (isSessionScopedFrameType) and on `attached`; fleet-scoped frames carry
// a workspaceId as PAYLOAD naming a row other than the attached one, and must
// never be dropped by the guard.
// ---------------------------------------------------------------------------
describe("stale-frame guard scope", () => {
	test("a fleet-scoped frame carrying another workspace's workspaceId is applied; a session-scoped frame stamped with another scope is dropped", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d1"));
		setState("sessionRoster", [
			{ workspaceId: "d1", name: "d1", cwd: "/repos/d1", project: "d1", status: "ready" },
			{ workspaceId: "d2", name: "d2", cwd: "/repos/d2", project: "d2", status: "ready" },
		]);
		setState("collabStatus", { state: "off" });

		// Fleet-scoped: describes d2 while the tab views d1; every one applies.
		dispatch({ type: "session_status", workspaceId: "d2", status: "error", error: "boom" });
		expect(state.sessionRoster[1]).toMatchObject({ status: "error", error: "boom" });
		dispatch({ type: "session_activity", workspaceId: "d2", streaming: true, blocked: false });
		expect(state.sessionActivity["d2"]).toEqual({ streaming: true, blocked: false });
		dispatch({
			type: "worktree_delete_info",
			workspaceId: "d2",
			linked: false,
			dirty: false,
			reason: "not a linked worktree",
		});
		expect(state.worktreeDeleteInfo["d2"]).toMatchObject({ linked: false });

		// Session-scoped and stamped for d2 while viewing d1: a stale in-flight frame.
		dispatch({
			type: "collab_status",
			scope: "d2",
			status: { state: "starting" },
		});
		expect(state.collabStatus).toEqual({ state: "off" });

		// The same frame stamped for the viewed workspace applies.
		dispatch({
			type: "collab_status",
			scope: "d1",
			status: { state: "starting" },
		});
		expect(state.collabStatus).toEqual({ state: "starting" });
	});
});

describe("roster session dropdown", () => {
	/** Minimal roster entry with a worktree cwd. */
	function rosterEntry(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: "x",
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

	/** Yield until an acked spawn_resume has released its attach (a few microtask hops). */
	async function flushWake(): Promise<void> {
		for (let i = 0; i < 4; i++) await flushMicrotasks();
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

	test("workspace_sessions frame settles the per-session dropdown request", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		const pending = requestWorkspaceSessions("d9");
		expect(postedOf("list_workspace_sessions")).toEqual([
			{ type: "list_workspace_sessions", id: expect.any(String), workspaceId: "d9" },
		]);

		// A frame for a DIFFERENT session must not settle it.
		dispatch({ type: "workspace_sessions", workspaceId: "other", limit: 10, sessions: [se("x")] });
		dispatch({
			type: "workspace_sessions",
			workspaceId: "d9",
			limit: 10,
			sessions: [se("a"), se("b")],
		});
		await expect(pending).resolves.toEqual([se("a"), se("b")]);
	});

	test("requestWorkspaceSessions sends the limit and keys waiters by session + effective limit", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		// A 200-row request and a default (10-row) request for one session coexist.
		const dialog = requestWorkspaceSessions("d9", 200);
		const dropdown = requestWorkspaceSessions("d9");
		expect(postedOf("list_workspace_sessions")).toEqual([
			{ type: "list_workspace_sessions", id: expect.any(String), workspaceId: "d9", limit: 200 },
			{ type: "list_workspace_sessions", id: expect.any(String), workspaceId: "d9" },
		]);

		// Each answer settles only the request of its echoed size.
		dispatch({ type: "workspace_sessions", workspaceId: "d9", limit: 10, sessions: [se("a")] });
		await expect(dropdown).resolves.toEqual([se("a")]);
		dispatch({
			type: "workspace_sessions",
			workspaceId: "d9",
			limit: 200,
			sessions: [se("a"), se("b")],
		});
		await expect(dialog).resolves.toEqual([se("a"), se("b")]);

		// A same-size request still supersedes (resolves empty) the older one.
		const first = requestWorkspaceSessions("d9", 200);
		const second = requestWorkspaceSessions("d9", 200);
		await expect(first).resolves.toEqual([]);
		dispatch({ type: "workspace_sessions", workspaceId: "d9", limit: 200, sessions: [se("c")] });
		await expect(second).resolves.toEqual([se("c")]);

		// An explicit limit equal to the default shares the default's slot (the
		// answer echoes the effective limit), and out-of-range limits clamp to
		// the echoed one.
		const ten = requestWorkspaceSessions("d9", 10);
		dispatch({ type: "workspace_sessions", workspaceId: "d9", limit: 10, sessions: [se("d")] });
		await expect(ten).resolves.toEqual([se("d")]);
		const huge = requestWorkspaceSessions("d9", 9999);
		dispatch({ type: "workspace_sessions", workspaceId: "d9", limit: 200, sessions: [se("e")] });
		await expect(huge).resolves.toEqual([se("e")]);
	});

	test("resumeSession wakes an asleep session with the chosen session then attaches", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", {
				status: "asleep",
				lastSessionFile: "/sessions/current.jsonl",
			}),
		]);

		resumeSession("d9", "/sessions/picked.jsonl");
		expect(postedOf("spawn_resume")).toEqual([
			{
				type: "spawn_resume",
				id: expect.any(String),
				workspaceId: "d9",
				sessionFile: "/sessions/picked.jsonl",
			},
		]);
		// The attach waits for the spawn_resume ack.
		expect(postedOf("attach")).toHaveLength(0);
		await flushWake();
		expect(postedOf("attach")).toHaveLength(1);
	});

	test("resumeWorktreeSession pulses an asleep row until its attach settles", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeWorktreeSession("d9", "/sessions/picked.jsonl");
		expect(activatingIds().has("d9")).toBe(true);
		expect(postedOf("spawn_resume")).toHaveLength(1);
		await flushWake();
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
		await flushWake();
		expect(activatingIds().has("d9")).toBe(false);
	});

	test("resumeWorktreeSession leaves a ready row's pulse alone", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeWorktreeSession("d9", "/sessions/picked.jsonl");
		expect(activatingIds().has("d9")).toBe(false);
	});

	test("resumeSession re-attaches the session the view is already on when its row is asleep (after a UI stop)", async () => {
		// A UI stop keeps currentWorkspaceId on the stopped session (the edge closed
		// its pipe); a dropdown pick wakes it on the picked file and must attach
		// again, or the page sits on "No active session".
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d1", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);
		setState("currentWorkspaceId", "d1");

		const resumed = resumeSession("d1", "/sessions/picked.jsonl");
		expect(postedOf("spawn_resume")).toEqual([
			{
				type: "spawn_resume",
				id: expect.any(String),
				workspaceId: "d1",
				sessionFile: "/sessions/picked.jsonl",
			},
		]);
		expect(postedOf("attach")).toHaveLength(0);
		await flushWake();
		expect(postedOf("attach")).toEqual([
			{ type: "attach", id: expect.any(String), workspaceId: "d1" },
		]);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d1" });
		await resumed;
	});

	test("picking the asleep session the view is already on from the palette wakes and attaches it", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d1", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);
		setState("currentWorkspaceId", "d1");

		runPaletteItem({
			id: "session:d:d1",
			group: "Sessions",
			label: "d1",
			keywords: [],
			action: { kind: "workspace-session", workspaceId: "d1" },
		});
		await flushWake();
		expect(postedOf("spawn_resume")).toHaveLength(1);
		expect(postedOf("attach")).toEqual([
			{ type: "attach", id: expect.any(String), workspaceId: "d1" },
		]);
	});

	test("resumeSession sends the attach only after the spawn_resume is acked, and none when it is refused", async () => {
		// The edge registers its pending resume before acking the spawn_resume,
		// so an attach sent after that ack can never overtake the pick.
		const held = holdCommands("spawn_resume");
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
			rosterEntry("d8", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		const resumed = resumeSession("d9", "/sessions/picked.jsonl");
		await flushMicrotasks();
		expect(postedOf("spawn_resume")).toHaveLength(1);
		expect(postedOf("attach")).toHaveLength(0);

		held[0]!.settle(true);
		await flushWake();
		expect(postedOf("attach")).toEqual([
			{ type: "attach", id: expect.any(String), workspaceId: "d9" },
		]);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
		await resumed;

		// A refused spawn_resume never sends its attach; the failure toasts.
		const failed = resumeSession("d8", "/sessions/picked.jsonl");
		await flushMicrotasks();
		held[1]!.settle(false);
		await failed;
		await flushMicrotasks();
		expect(postedOf("attach")).toHaveLength(1);
		expect(state.toasts.some((t) => t.text.includes("spawn_resume"))).toBe(true);
	});

	test("an attach requested while a wake's spawn_resume is in flight supersedes that wake's attach", async () => {
		// Click asleep d9, then ready d7 before d9's spawn_resume is accepted: the
		// user's last choice (d7) wins, d9's attach is never sent.
		const held = holdCommands("spawn_resume");
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
			rosterEntry("d7", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		const woken = resumeSession("d9", "/sessions/picked.jsonl");
		await flushMicrotasks();
		const other = attachSession("d7");
		expect(postedOf("attach")).toEqual([
			{ type: "attach", id: expect.any(String), workspaceId: "d7" },
		]);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d7" });
		await other;

		held[0]!.settle(true);
		await flushWake();
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["d7"]);
		// Superseded, the wake settles without an attach of its own.
		await woken;
	});

	test("resumeSession retries a switch swept by its own attach's supersession, never banners", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		// Attached to d1; resume a session on a DIFFERENT ready session (d9).
		// the switch lands in-flight while the d9 attach's `attached` frame
		// sweeps pending calls with "session switched".
		setState("currentWorkspaceId", "d1");
		setState("sessionRoster", [
			rosterEntry("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeSession("d9", "/sessions/picked.jsonl");
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
		await Promise.resolve();
		await Promise.resolve();
		// The first switchSession is in flight when the proxied attached frame
		// switches the session → rejectPendingCalls sweeps it.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(1);
		dispatch(attached("d9"));
		await Promise.resolve();
		await Promise.resolve();
		// The superseded switch retries ONCE against the now-current session.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(2);
		expect(state.error).toBeNull(); // the supersession is never a banner
	});

	test("attachForPanel opens Open review when the attach lands, or a superseded attach left this session current", async () => {
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("currentWorkspaceId", "d1");
		const opened = attachForPanel("d9");
		setState("currentWorkspaceId", "d9");
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("currentWorkspaceId", "d1");
		const opened = attachForPanel("d9");
		setState("currentWorkspaceId", "d2");
		rejectPendingAttach(new Error("session switched"));
		await expect(opened).resolves.toBe(false);
		expect(state.error).toBeNull();
	});

	test("resumeSession on a ready detached session attaches first, then switches to the picked session", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeSession("d9", "/sessions/picked.jsonl");
		expect(postedOf("attach")).toHaveLength(1);
		// The switch is issued only AFTER the attach settles.
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(0);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
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

	test("resumeSession to the already-current session on a ready session only attaches", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "ready", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		resumeSession("d9", "/sessions/current.jsonl");
		expect(postedOf("attach")).toHaveLength(1);
		expect(postedOf("call").filter((c) => c.method === "switchSession")).toHaveLength(0);
	});

	/** A state frame stamping `workspaceId`'s attachment scope for `generation`. */
	const stateFrame = (workspaceId: string, generation: string): ServerFrame => ({
		type: "state",
		state: {
			sessionId: workspaceId,
			sessionScope: { workspaceId: "w1", sessionId: workspaceId, generation },
		} as WebSessionState,
	});

	test("startWorkspaceNewSession wakes an asleep session, attaches, then starts a new session", async () => {
		// The extra ticks the wake POST adds let the settings pull's fetch resolve;
		// the default stub has no body reader for it.
		setBrowserGlobal(
			"fetch",
			(async () =>
				({
					ok: true,
					status: 202,
					json: async () => ({}),
					text: async () => "",
				}) as Response) as unknown as typeof fetch,
		);
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d9", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);

		const started = startWorkspaceNewSession("d9");
		// Wakes on its last session (no explicit file), then attaches.
		expect(postedOf("spawn_resume")).toEqual([
			{ type: "spawn_resume", id: expect.any(String), workspaceId: "d9" },
		]);
		expect(postedOf("attach")).toHaveLength(0);
		await flushWake();
		expect(postedOf("attach")).toHaveLength(1);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
		await flushMicrotasks();
		// The proxied attached frame trails attach_result and would sweep a call
		// posted now after the session ran it: newSession waits for the frame and
		// the attachment's first state frame.
		expect(newSessionCalls()).toHaveLength(0);
		dispatch(attached("d9"));
		await flushMicrotasks();
		expect(newSessionCalls()).toHaveLength(0);
		dispatch(stateFrame("d9", "1"));
		await flushMicrotasks();
		expect(newSessionCalls()).toHaveLength(1);
		dispatch({ type: "call_result", id: newSessionCalls()[0].id, ok: true, data: null });
		await started;
		expect(newSessionCalls()).toHaveLength(1);
		expect(state.error).toBeNull();
	});

	test("startWorkspaceNewSession on a stopped current row posts newSession only under the new attachment's scope", async () => {
		// A UI stop keeps currentWorkspaceId and the old generation's scope on the
		// stopped session. attach_result lands before the proxied attached/state
		// frames; a newSession posted in that gap carries the old scope and the
		// session rejects it as stale.
		setBrowserGlobal(
			"fetch",
			(async () =>
				({
					ok: true,
					status: 202,
					json: async () => ({}),
					text: async () => "",
				}) as Response) as unknown as typeof fetch,
		);
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("sessionRoster", [
			rosterEntry("d1", { status: "asleep", lastSessionFile: "/sessions/current.jsonl" }),
		]);
		dispatch(attached("d1"));
		dispatch(stateFrame("d1", "1"));
		expect(state.sessionScope?.generation).toBe("1");
		posted.length = 0;

		const started = startWorkspaceNewSession("d1");
		await flushWake();
		expect(postedOf("attach")).toHaveLength(1);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d1" });
		await flushMicrotasks();
		// currentWorkspaceId is already d1 and the scope is still generation 1.
		expect(newSessionCalls()).toHaveLength(0);
		dispatch(attached("d1"));
		await flushMicrotasks();
		// The new attachment has no scope until its first state frame.
		expect(newSessionCalls()).toHaveLength(0);
		dispatch(stateFrame("d1", "2"));
		await flushMicrotasks();
		expect(newSessionCalls()).toHaveLength(1);
		expect(newSessionCalls()[0].scope).toEqual({
			workspaceId: "w1",
			sessionId: "d1",
			generation: "2",
		});
		dispatch({ type: "call_result", id: newSessionCalls()[0].id, ok: true, data: null });
		await started;
		expect(newSessionCalls()).toHaveLength(1);
		expect(state.error).toBeNull();
	});

	test("startWorkspaceNewSession drops the new session when another session gets attached first", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("currentWorkspaceId", "d1");
		setState("sessionRoster", [rosterEntry("d9", { status: "ready" })]);

		const started = startWorkspaceNewSession("d9");
		expect(postedOf("spawn_resume")).toHaveLength(0);
		dispatch({ type: "attach_result", id: postedOf("attach")[0].id, ok: true, workspaceId: "d9" });
		await flushMicrotasks();
		// The user picked d2 before d9's attached frame landed.
		dispatch(attached("d2"));
		await started;
		// Never a new session on the session the user switched to, never a banner.
		expect(newSessionCalls()).toHaveLength(0);
		expect(state.error).toBeNull();
	});

	test("startWorkspaceNewSession on the attached ready session starts at once", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		setState("currentWorkspaceId", "d9");
		setState("sessionRoster", [rosterEntry("d9", { status: "ready" })]);

		void startWorkspaceNewSession("d9");
		await flushMicrotasks();
		expect(postedOf("attach")).toHaveLength(0);
		expect(newSessionCalls()).toHaveLength(1);
	});
});

describe("call delivery: a lost answer is recovered by re-sending the command", () => {
	/**
	 * Fake session over FakeWebSocket. It EXECUTES each command id once and
	 * records the answer, but the first answer never rides the downlink:
	 * call_result is a non-ringed unicast, so a frame dropped on the session
	 * pipe (a redial, backpressure drop-and-resume) is gone for good. A re-send
	 * of the SAME id is acked again, deduped (no second execution), and REPLAYS
	 * the recorded answer, exactly like the session's command dedup.
	 */
	function startLostAnswerSession(answerFor: (id: string) => ServerFrame): {
		executed: string[];
		posts: string[];
	} {
		const executed: string[] = [];
		const posts: string[] = [];
		const answers = new Map<string, ServerFrame>();
		FakeWebSocket.reply = (cmd, ws) => {
			ws.ack(cmd.id);
			if (cmd.type !== "call") return;
			posts.push(cmd.id);
			const recorded = answers.get(cmd.id);
			if (recorded === undefined) {
				executed.push(cmd.id);
				answers.set(cmd.id, answerFor(cmd.id));
			} else {
				dispatch(recorded); // the deduped re-send's replayed answer
			}
		};
		return { executed, posts };
	}

	test("prompt: the replayed answer settles the pending call once and the prompt ran once", async () => {
		vi.useFakeTimers();
		try {
			connect();
			FakeWebSocket.instances.at(-1)!.onopen?.(); // connected = true
			const session = startLostAnswerSession((id) => ({
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
			expect(session.posts).toHaveLength(1);
			expect(session.executed).toHaveLength(1);

			// The answer was lost: the call is still pending, so the replay
			// re-sends the SAME command (same id, the dedup key).
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks();
			expect(session.posts).toHaveLength(2);
			expect(session.posts[0]).toBe(session.posts[1]);

			// The replayed answer settles it exactly once, and the session never
			// executed the prompt a second time.
			await pending;
			expect(outcomes).toEqual(["resolved"]);
			expect(session.executed).toHaveLength(1);
			expect(session.posts).toHaveLength(2); // settled: the replay cadence stops
		} finally {
			vi.useRealTimers();
		}
	});

	test("prompt: a replayed failure answer rejects with the session's real error, never a fake success", async () => {
		vi.useFakeTimers();
		try {
			connect();
			FakeWebSocket.instances.at(-1)!.onopen?.();
			const session = startLostAnswerSession((id) => ({
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
			expect(session.posts).toHaveLength(2); // the lost answer was re-sent

			await pending;
			expect(outcomes).toEqual(["Error: not_ready"]);
			expect(session.executed).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("transcript phase (session switch)", () => {
	function rosterEntry(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: "x",
			status: "ready",
			...extra,
		};
	}

	function postedOf<T extends ClientCommand["type"]>(
		type: T,
	): Array<Extract<ClientCommand, { type: T }>> {
		return posted.filter((c): c is Extract<ClientCommand, { type: T }> => c.type === type);
	}

	async function flushWake(): Promise<void> {
		for (let i = 0; i < 4; i++) await flushMicrotasks();
	}

	const phase = () => ({
		phase: state.transcriptPhase,
		target: state.transcriptTarget,
		error: state.transcriptError,
	});

	/** Connected, attached to d1 with its (empty) history loaded, d2 ready in the roster. */
	function onD1(): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch({ type: "roster", entries: [rosterEntry("d1"), rosterEntry("d2")] });
		dispatch(attached("d1"));
		dispatch({ type: "history", messages: [] });
		posted.length = 0;
	}

	test("starts idle, and an attach alone never marks it loaded", () => {
		expect(phase()).toEqual({ phase: "idle", target: null, error: null });
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("d1"));
		expect(state.transcriptPhase).toBe("idle");
	});

	test("a switch goes attaching, stays attaching through attach_result and attached, and loads on the history frame (empty included)", async () => {
		onD1();
		expect(state.transcriptPhase).toBe("loaded");

		const switched = switchToSession("d2");
		// Written synchronously: the row highlight reads it on click.
		expect(phase()).toEqual({ phase: "attaching", target: "d2", error: null });
		dispatch({ type: "attach_result", id: postedOf("attach")[0]!.id, ok: true, workspaceId: "d2" });
		await switched;
		expect(state.transcriptPhase).toBe("attaching");

		dispatch(attached("d2"));
		expect(state.transcriptPhase).toBe("attaching");
		dispatch({ type: "history", messages: [] });
		expect(phase()).toEqual({ phase: "loaded", target: null, error: null });
	});

	test("the final chunk of a multi-frame history loads, the partial ones do not", () => {
		onD1();
		void switchToSession("d2");
		dispatch(attached("d2"));
		dispatch({ type: "history", messages: [userMsg("a")], final: false } as ServerFrame);
		expect(state.transcriptPhase).toBe("attaching");
		dispatch({ type: "history", messages: [userMsg("b")], final: true } as ServerFrame);
		expect(state.transcriptPhase).toBe("loaded");
	});

	test("an asleep session wakes first (waking), then attaches (attaching), then loads", async () => {
		onD1();
		setState("sessionRoster", [rosterEntry("d1"), rosterEntry("d2", { status: "asleep" })]);

		const switched = switchToSession("d2");
		expect(phase()).toEqual({ phase: "waking", target: "d2", error: null });
		expect(postedOf("spawn_resume")).toHaveLength(1);
		await flushWake();
		expect(postedOf("attach")).toHaveLength(1);
		expect(state.transcriptPhase).toBe("waking");
		dispatch({ type: "attach_result", id: postedOf("attach")[0]!.id, ok: true, workspaceId: "d2" });
		await switched;
		expect(state.transcriptPhase).toBe("attaching");
		dispatch(attached("d2"));
		dispatch({ type: "history", messages: [userMsg("hi")] });
		expect(state.transcriptPhase).toBe("loaded");
	});

	test("a failed attach lands in failed with the reason; the promise still resolves", async () => {
		onD1();
		const switched = switchToSession("d2");
		dispatch({
			type: "attach_result",
			id: postedOf("attach")[0]!.id,
			ok: false,
			error: "session exited with code 78",
		});
		await expect(switched).resolves.toBeUndefined();
		expect(phase()).toEqual({
			phase: "failed",
			target: "d2",
			error: "session exited with code 78",
		});
		// The old session is still attached underneath, so the composer gate holds.
		expect(state.currentWorkspaceId).toBe("d1");
		expect(isSwitching()).toBe(true);
	});

	test("a refused wake lands in failed", async () => {
		onD1();
		setState("sessionRoster", [rosterEntry("d1"), rosterEntry("d2", { status: "asleep" })]);
		FakeWebSocket.reply = (cmd, ws) =>
			cmd.type === "spawn_resume" ? ws.nack(cmd.id, 500, "refused") : ws.ack(cmd.id);

		await switchToSession("d2");
		expect(state.transcriptPhase).toBe("failed");
		expect(state.transcriptTarget).toBe("d2");
		expect(postedOf("attach")).toHaveLength(0);
	});

	test("a superseded switch never writes the phase of the one that replaced it", async () => {
		onD1();
		dispatch({
			type: "roster",
			entries: [rosterEntry("d1"), rosterEntry("d2"), rosterEntry("d3")],
		});
		const a = switchToSession("d2");
		const attachA = postedOf("attach")[0]!;
		const b = switchToSession("d3");
		expect(phase()).toEqual({ phase: "attaching", target: "d3", error: null });
		// A's attach settled as superseded (it resolves with the current session).
		await a;
		expect(phase()).toEqual({ phase: "attaching", target: "d3", error: null });
		// A late answer for A's attach id is ignored by the transport and the phase.
		dispatch({ type: "attach_result", id: attachA.id, ok: false, error: "attach superseded" });
		expect(phase()).toEqual({ phase: "attaching", target: "d3", error: null });
		// B's own failure does land.
		dispatch({ type: "attach_result", id: postedOf("attach")[1]!.id, ok: false, error: "gone" });
		await b;
		expect(phase()).toEqual({ phase: "failed", target: "d3", error: "gone" });
	});

	test("a wake superseded by a later click never flips that click's phase", async () => {
		const held = holdCommands("spawn_resume");
		onD1();
		setState("sessionRoster", [
			rosterEntry("d1"),
			rosterEntry("d2", { status: "asleep" }),
			rosterEntry("d3"),
		]);

		const a = switchToSession("d2");
		expect(state.transcriptPhase).toBe("waking");
		const b = switchToSession("d3");
		expect(phase()).toEqual({ phase: "attaching", target: "d3", error: null });
		// A's wake is refused AFTER B took over: A must stay silent.
		held[0]!.settle(false);
		await a;
		expect(phase()).toEqual({ phase: "attaching", target: "d3", error: null });
		dispatch({ type: "attach_result", id: postedOf("attach")[0]!.id, ok: true, workspaceId: "d3" });
		await b;
		expect(state.transcriptPhase).toBe("attaching");
	});

	test("a history frame of the old session during a switch does not end its wait", () => {
		onD1();
		void switchToSession("d2");
		dispatch({ type: "history", messages: [userMsg("old")] });
		expect(phase()).toEqual({ phase: "attaching", target: "d2", error: null });
	});

	test("a reconnect re-attach of the same session keeps it loaded", () => {
		onD1();
		FakeWebSocket.instances.at(-1)!.onopen?.(); // the stream came back
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["d1"]);
		expect(state.transcriptPhase).toBe("loaded");
		dispatch(attached("d1"));
		expect(state.transcriptPhase).toBe("loaded");
		dispatch({ type: "history", messages: [userMsg("again")] });
		expect(phase()).toEqual({ phase: "loaded", target: null, error: null });
	});

	test("re-attaching the attached session is no transition; clicking it clears a failed attempt elsewhere", async () => {
		onD1();
		await switchToSession("d1");
		expect(postedOf("attach")).toHaveLength(0);
		expect(state.transcriptPhase).toBe("loaded");

		setState({ transcriptPhase: "failed", transcriptTarget: "d2", transcriptError: "boom" });
		await switchToSession("d1");
		expect(phase()).toEqual({ phase: "loaded", target: null, error: null });
		expect(postedOf("attach")).toHaveLength(0);
	});

	test("waking the stopped session the view is on is quiet (no transition)", async () => {
		onD1();
		setState("sessionRoster", [rosterEntry("d1", { status: "asleep" }), rosterEntry("d2")]);
		const switched = switchToSession("d1");
		expect(state.transcriptPhase).toBe("loaded");
		await flushWake();
		dispatch({ type: "attach_result", id: postedOf("attach")[0]!.id, ok: true, workspaceId: "d1" });
		await switched;
		expect(state.transcriptPhase).toBe("loaded");
	});

	test("the session being cleared goes idle (attached session removed from the roster)", () => {
		onD1();
		dispatch({ type: "roster", entries: [rosterEntry("d2")] });
		expect(state.currentWorkspaceId).toBe("");
		expect(phase()).toEqual({ phase: "idle", target: null, error: null });
	});

	test("a cleared session does not clobber a switch already in flight to another session", () => {
		onD1();
		void switchToSession("d2");
		dispatch({ type: "roster", entries: [rosterEntry("d2")] });
		expect(state.currentWorkspaceId).toBe("");
		expect(phase()).toEqual({ phase: "attaching", target: "d2", error: null });
	});

	test("resuming a session on an asleep session runs the same switch machinery", async () => {
		onD1();
		setState("sessionRoster", [rosterEntry("d1"), rosterEntry("d2", { status: "asleep" })]);
		const resumed = resumeSession("d2", "/sessions/picked.jsonl");
		expect(phase()).toEqual({ phase: "waking", target: "d2", error: null });
		await flushWake();
		dispatch({
			type: "attach_result",
			id: postedOf("attach")[0]!.id,
			ok: false,
			error: "wake failed",
		});
		await resumed;
		expect(phase()).toEqual({ phase: "failed", target: "d2", error: "wake failed" });
	});
});

describe("the attached session is removed from the roster", () => {
	const p1: RegisteredProject = { projectId: "p1", path: "/repos/a", name: "a", addedAt: 1 };
	const p2: RegisteredProject = { projectId: "p2", path: "/repos/b", name: "b", addedAt: 2 };

	/** Worktree rows sort by branch after the main checkout, so the ids below read in sidebar order. */
	function row(id: string, projectId: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		const main = id.endsWith("main");
		return {
			workspaceId: id,
			name: id,
			cwd: `/repos/${id}`,
			project: projectId,
			projectId,
			status: "ready",
			...(main ? {} : { worktreeOf: projectId, branch: id }),
			...extra,
		};
	}

	function postedOf<T extends ClientCommand["type"]>(
		type: T,
	): Array<Extract<ClientCommand, { type: T }>> {
		return posted.filter((c): c is Extract<ClientCommand, { type: T }> => c.type === type);
	}

	/** Sidebar order: p1 [a-main, a-wt1, a-wt2], p2 [b-main, b-wt1]; attached to `on` with history loaded. */
	function attachedTo(on: string, rows = defaultRows()): void {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch({ type: "registered_projects", projects: [p1, p2] });
		dispatch({ type: "roster", entries: rows });
		dispatch(attached(on));
		dispatch({ type: "history", messages: [] });
		posted.length = 0;
	}

	function defaultRows(): RosterEntry[] {
		return [
			row("a-main", "p1"),
			row("a-wt1", "p1"),
			row("a-wt2", "p1"),
			row("b-main", "p2"),
			row("b-wt1", "p2"),
		];
	}

	/** The roster frame after the rows with these ids vanish (and `patch` applies). */
	function without(ids: string[], patch: Record<string, Partial<RosterEntry>> = {}): RosterEntry[] {
		return defaultRows()
			.filter((d) => !ids.includes(d.workspaceId))
			.map((d) => ({ ...d, ...patch[d.workspaceId] }));
	}

	afterEach(() => {
		clearAllDeletePending();
		// A switch still waiting on its attach_result would block the next test's auto-switch.
		rejectPendingAttach(new Error("test teardown"));
	});

	test("the middle row switches to the row before it, with no offline state", () => {
		attachedTo("a-wt1");
		dispatch({ type: "roster", entries: without(["a-wt1"]) });

		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
		expect(state.transcriptTarget).toBe("a-main");
		expect(state.transcriptPhase).toBe("attaching");
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
	});

	test("the first row switches to the next row", () => {
		attachedTo("a-main");
		dispatch({ type: "roster", entries: without(["a-main"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-wt1"]);
		expect(state.transcriptTarget).toBe("a-wt1");
		expect(state.sessionDownId).toBe("");
	});

	test("the target attaches and loads like any switch", () => {
		attachedTo("a-wt1");
		dispatch({ type: "roster", entries: without(["a-wt1"]) });
		dispatch({
			type: "attach_result",
			id: postedOf("attach")[0]!.id,
			ok: true,
			workspaceId: "a-main",
		});
		dispatch(attached("a-main"));
		dispatch({ type: "history", messages: [] });
		expect(state.currentWorkspaceId).toBe("a-main");
		expect(state.transcriptPhase).toBe("loaded");
		expect(state.transcriptTarget).toBeNull();
	});

	test("an asleep neighbour is skipped for a farther ready row, and never woken", () => {
		attachedTo("a-wt2");
		dispatch({ type: "roster", entries: without(["a-wt2"], { "a-wt1": { status: "asleep" } }) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
		expect(postedOf("spawn_resume")).toHaveLength(0);
	});

	test("the row before is preferred over the row after", () => {
		attachedTo("a-wt1");
		dispatch({ type: "roster", entries: without(["a-wt1"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
	});

	test("every other row asleep (after a restart): idle, no attach, no wake, no offline strip", () => {
		const asleep = defaultRows().map((d) => ({ ...d, status: "asleep" as const }));
		attachedTo("a-wt1");
		dispatch({ type: "roster", entries: asleep.filter((d) => d.workspaceId !== "a-wt1") });
		expect(postedOf("attach")).toHaveLength(0);
		expect(postedOf("spawn_resume")).toHaveLength(0);
		expect(state.currentWorkspaceId).toBe("");
		expect(state.transcriptPhase).toBe("idle");
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
	});

	test("an error neighbour is skipped for a farther active row", () => {
		attachedTo("a-wt2");
		dispatch({ type: "roster", entries: without(["a-wt2"], { "a-wt1": { status: "error" } }) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
	});

	test("a reconnecting neighbour is chosen and attached without a wake", () => {
		attachedTo("a-wt2");
		dispatch({
			type: "roster",
			entries: without(["a-wt2"], { "a-wt1": { status: "reconnecting" } }),
		});
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-wt1"]);
		expect(postedOf("spawn_resume")).toHaveLength(0);
	});

	test("neighbours of a missing project are skipped", () => {
		attachedTo("b-main");
		dispatch({ type: "registered_projects", projects: [{ ...p1, missing: true }, p2] });
		dispatch({ type: "roster", entries: without(["b-main"]) });
		// Everything before it is p1 (missing), so the next row after it opens.
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-wt1"]);
	});

	test("with nothing active before it, the scan turns around and takes the next one after", () => {
		attachedTo("a-wt2");
		dispatch({
			type: "roster",
			entries: without(["a-wt2"], { "a-wt1": { status: "error" }, "a-main": { status: "error" } }),
		});
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-main"]);
	});

	test("the order runs across project groups", () => {
		// b-main is first of group p2; the row before it is the last of p1 (a-wt2).
		attachedTo("b-main");
		dispatch({ type: "roster", entries: without(["b-main"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-wt2"]);
	});

	test("forward across a group boundary when nothing before is openable", () => {
		attachedTo("a-main");
		dispatch({
			type: "roster",
			entries: without(["a-main"], {
				"a-wt1": { status: "error" },
				"a-wt2": { status: "error" },
			}),
		});
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-main"]);
	});

	test("no active row left clears to the idle no-session state without attaching", () => {
		attachedTo("a-wt1");
		dispatch({
			type: "roster",
			entries: [
				row("a-main", "p1", { status: "asleep" }),
				row("b-main", "p2", { status: "error" }),
				row("b-wt1", "p2", { status: "connecting" }),
			],
		});
		expect(postedOf("attach")).toHaveLength(0);
		expect(state.currentWorkspaceId).toBe("");
		expect(state.transcriptPhase).toBe("idle");
		expect(state.transcriptTarget).toBeNull();
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
	});

	test("a neighbour pending delete is skipped", () => {
		attachedTo("a-wt2");
		sendDeleteWorktree("a-wt1");
		posted.length = 0;
		dispatch({ type: "roster", entries: without(["a-wt2"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
	});

	test("rows vanishing in the same frame are never the target", () => {
		attachedTo("a-wt2");
		dispatch({ type: "roster", entries: without(["a-wt2", "a-wt1"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["a-main"]);
	});

	test("a user switch already in flight is not overridden", () => {
		attachedTo("a-wt1");
		void switchToSession("b-wt1");
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-wt1"]);
		dispatch({ type: "roster", entries: without(["a-wt1"]) });
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-wt1"]);
		expect(state.transcriptTarget).toBe("b-wt1");
		expect(state.sessionDownId).toBe("");
	});

	test("an asleep or errored attached session still goes offline", () => {
		attachedTo("a-wt1");
		dispatch({ type: "roster", entries: without([], { "a-wt1": { status: "asleep" } }) });
		expect(state.sessionDownId).toBe("a-wt1");
		expect(connectionState()).toBe("offline");
		expect(postedOf("attach")).toHaveLength(0);
	});

	test("from the offline state, clicking another asleep row wakes and attaches it", async () => {
		attachedTo("a-wt1");
		dispatch({
			type: "roster",
			entries: without([], { "a-wt1": { status: "asleep" }, "b-main": { status: "asleep" } }),
		});
		expect(state.sessionDownId).toBe("a-wt1");

		const switched = switchToSession("b-main");
		expect(postedOf("spawn_resume").map((c) => c.workspaceId)).toEqual(["b-main"]);
		for (let i = 0; i < 4; i++) await flushMicrotasks();
		expect(postedOf("attach").map((c) => c.workspaceId)).toEqual(["b-main"]);
		dispatch({
			type: "attach_result",
			id: postedOf("attach")[0]!.id,
			ok: true,
			workspaceId: "b-main",
		});
		await switched;
		dispatch(attached("b-main"));
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
	});
});

describe("skills_changed frame", () => {
	const entry = (name: string, enabled: boolean) => ({
		name,
		description: "",
		source: "OMP (user)",
		path: `/skills/${name}/SKILL.md`,
		enabled,
		hidden: false,
	});

	test("applies the broadcast inventory and bumps the revision the open detail reloads on", () => {
		setState({ currentWorkspaceId: "workspace-a" });
		setState("integrations", {
			skills: [entry("pdf", true)],
			skillWarnings: [],
			skillsRevision: 3,
		});
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();

		dispatch({
			type: "skills_changed",
			state: { skills: [entry("pdf", false), entry("changelog", true)], warnings: ["w"] },
		});

		expect(state.integrations.skills.map((s) => [s.name, s.enabled])).toEqual([
			["pdf", false],
			["changelog", true],
		]);
		expect(state.integrations.skillWarnings).toEqual(["w"]);
		expect(state.integrations.skillsRevision).toBe(4);
		setState("integrations", { skills: [], skillWarnings: [], skillsRevision: 0 });
	});
});
