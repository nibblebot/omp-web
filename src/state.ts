import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { createStore, produce } from "solid-js/store";
import { OMP_PROTO, SSE_EVENT_NAME, SSE_SILENCE_DEADLINE_MS, daemonsKey } from "../shared/protocol";
import type {
	AvailableSlashCommand,
	DaemonEntry,
	DaemonInfo,
	DaemonStatus,
	ImageArg,
	ModelInfo,
	RegisteredProject,
	ServerFrame,
	SettingsModel,
	WebSessionState,
} from "../shared/protocol";
import { SSE_PING_EVENT } from "../shared/sse";
import { scanImages } from "./text/images";
import type { UsageLike } from "./usage/usage";
import {
	announce,
	appendBashChunk,
	applyEvent,
	assistantBlocks,
	capTail,
	clearPendingDeltas,
	extractText,
	findToolIndex,
	nextChatId,
	pendingEphemeral,
	pushItem,
	resetChatIds,
	scheduleFlush,
	tabsToSpaces,
	userText,
} from "./store/chat";
import { cancelUiRequest } from "./store/modals";
import { resetPendingProjects, settleProjectBranches, settleProjects } from "./store/projects";
import { resetPendingSessionsFiles, settleFiles, settleSessions } from "./store/roster";
import { dismissToast, pushToast } from "./store/toasts";
import {
	attachSession,
	call,
	clientId,
	pendingCalls,
	pendingDaemonControl,
	pendingDaemonLogs,
	pushDebug,
	rejectPendingAttach,
	rejectPendingCalls,
	rejectPendingDaemons,
	setConnected,
	setTransportToken,
	settleAttachResult,
} from "./store/transport";

// ---------------------------------------------------------------------------
// Shared model vocabulary (types stay here so the store init and every
// caller keep importing them from "../state"). The ~50 exported ACTIONS live
// in src/store/<domain>.ts and are re-exported at the bottom of this file —
// call sites are byte-identical.
// ---------------------------------------------------------------------------
export type Block = { kind: "text" | "thinking"; text: string };
export type ToolStatus = "running" | "done" | "error";
export type ToolCardsView = "expanded" | "collapsed" | "consolidated";
export type BashItem = {
	kind: "bash";
	id: number;
	command: string;
	dimmed: boolean;
	/** "python" for $/$$ items; the same card/streaming path as bang-shell. */
	lang: "bash" | "python";
	status: "running" | "done";
	output: string;
	exitCode: number | null;
	truncated: boolean;
};
export type CompactionItem = {
	kind: "compaction";
	id: number;
	action: string;
	summary?: string;
	tokensBefore?: number;
	skipped: boolean;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
};
export type ChatItem =
	| { kind: "user"; id: number; text: string; images?: ImageArg[] }
	| {
			kind: "assistant";
			id: number;
			blocks: Block[];
			usage?: UsageLike;
			ttft?: number;
			duration?: number;
	  }
	| {
			kind: "tool";
			id: number;
			toolCallId: string;
			name: string;
			args: unknown;
			status: ToolStatus;
			output: string;
			images?: ImageArg[];
	  }
	| BashItem
	| CompactionItem
	| { kind: "notice"; id: number; level: string; message: string; href?: string };

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface BashResultLike {
	output: string;
	exitCode: number;
	cancelled?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
}

export type DebugLevel = "info" | "warn" | "error";

/** One client-side transport lifecycle event for the Debug panel. */
export interface DebugEntry {
	ts: number;
	level: DebugLevel;
	source: "transport" | "command" | "roster";
	message: string;
}

/** Tracked subagent, maintained from subagent_lifecycle/subagent_progress frames. */
export interface SubagentInfo {
	id: string;
	index: number;
	agent: string;
	description?: string;
	task?: string;
	status: string;
	lastUpdate: number;
	/** toolCallId of the task call that spawned this subagent (SDK payload field). */
	parentToolCallId?: string;
}

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "started", "running"]);

/** True while the subagent is in flight; terminal statuses collapse the strip. */
export function isActiveSubagent(sub: SubagentInfo): boolean {
	return ACTIVE_SUBAGENT_STATUSES.has(sub.status);
}

const LIVE_DAEMON_STATES = new Set(["starting", "running", "ready", "restarting", "stopping"]);

/** Daemon still supervised (not exited/failed); drives the processes strip's visibility. */
export function isLiveDaemon(d: DaemonInfo): boolean {
	return LIVE_DAEMON_STATES.has(d.state);
}

/** Names of the modals the store can summon; components render on match. */
export type ModalName =
	| "help"
	| "model"
	| "thinking"
	| "stats"
	| "settings"
	| "sessions"
	| "branch"
	| "history"
	| "subagents"
	| "login"
	| "goal"
	| "usage"
	| "debug"
	// Phase 5: project/worktree onboarding (add-repo modal + two-tab worktree modal).
	| "add-project"
	| "worktree";

/** Unicast answer to sendWorktreeDeleteInfo: guard evidence for the
 *  delete-worktree confirm dialog (ownership, dirty counts, branch state). */
export type WorktreeDeleteInfo = Extract<ServerFrame, { type: "worktree_delete_info" }>;

/** localStorage key for the roster sidebar visibility toggle. */
const SIDEBAR_KEY = "omp.sidebarVisible";

/** localStorage key for the Phase 11 desktop-notifications toggle. */
const NOTIFY_KEY = "omp.notifyEnabled";

export const [state, setState] = createStore({
	items: [] as ChatItem[],
	// rev: monotonic content version of live.blocks, bumped on every live
	// mutation so scroll/pin effects subscribe to "content changed" without
	// scanning block text lengths on every flush (see MessageList's pinning
	// effect — it used to allocate a lengths array per flush).
	live: { active: false, blocks: [] as Block[], rev: 0 },
	// --- WebSessionState mirror (verbatim; see protocol state frames) ---
	streaming: false,
	// TUI-parity dynamic working label (interactive-mode's setWorkingMessage):
	// the latest tool-call intent ("Reading config files…"), undefined = the
	// default phrase. Session-scoped; cleared on turn end and transcript resets.
	workingIntent: undefined as string | undefined,
	compacting: false,
	model: undefined as WebSessionState["model"],
	modelRoles: undefined as WebSessionState["modelRoles"],
	modelRoleCatalog: undefined as WebSessionState["modelRoleCatalog"],
	modelRoleStorage: undefined as WebSessionState["modelRoleStorage"],
	thinkingLevel: undefined as WebSessionState["thinkingLevel"],
	sessionName: undefined as string | undefined,
	sessionId: "",
	// R8 omp-session readiness: set by the `ready` broadcast (or a stamped state
	// frame) once the SDK session is live and provider/model/auth resolved.
	readyAt: undefined as WebSessionState["readyAt"],
	// Phase 2: server-assigned handle of the live session this tab is attached
	// to (distinct from sessionId above, the agent's own id, which changes on
	// switchSession). Session-scoped frames for any other handle are dropped.
	currentSessionId: "",
	sessionFile: undefined as string | undefined,
	contextUsage: undefined as WebSessionState["contextUsage"],
	queuedMessageCount: 0,
	messageCount: 0,
	todoPhases: [] as WebSessionState["todoPhases"],
	steeringMode: "all" as WebSessionState["steeringMode"],
	followUpMode: "all" as WebSessionState["followUpMode"],
	interruptMode: "immediate" as WebSessionState["interruptMode"],
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	dumpTools: [] as NonNullable<WebSessionState["dumpTools"]>,
	// --- Phase 9: modes & usage parity (WebSessionState mirror) ---
	goalModeState: undefined as WebSessionState["goalModeState"],
	planModeEnabled: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
	inspectImageMode: "auto" as WebSessionState["inspectImageMode"],
	// Live auto-retry countdown (auto_retry_start/auto_retry_end events).
	retryInfo: null as {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		until: number;
	} | null,
	// --- Server-pushed extras ---
	availableCommands: [] as AvailableSlashCommand[],
	availableModels: [] as ModelInfo[],
	stats: null as SessionStats | null,
	goal: null as { objective: string } | null,
	subagents: new Map<string, SubagentInfo>(),
	connected: false,
	modal: null as ModalName | null,
	// Phase 5 modal payloads (components read these; set alongside modal):
	// which project the worktree modal targets (both tabs).
	worktreeModalProjectId: null as string | null,
	// daemonId the delete-worktree confirm dialog targets.
	deleteWorktreeTarget: null as string | null,
	// projectId the remove-project confirm targets.
	removeProjectTarget: null as string | null,
	toolsExpanded: false,
	toolCardsView: "expanded" as ToolCardsView,
	// Daemon broker roster (hub/launch long-running processes); project-scoped,
	// so resetSessionView must NOT clear it.
	daemons: new Map<string, DaemonInfo>(),
	// Settings model (getSettings/setSetting + settings_changed frames).
	settingsModel: null as SettingsModel | null,
	settingsLoading: false,
	// Attach mode: "single" (standalone omp-session — no sidebar) or "roster"
	// (fleet edge — the fleet roster sidebar). "roster" is set by the roster
	// frame and sticky across reconnects; the attached frame carries no mode
	// field and must not clobber it (Phase 6 de-mux).
	sessionMode: "single" as "single" | "roster",
	// Fleet edge roster (roster frame). Patched in place by
	// daemon_status frames; NOT cleared by resetSessionView (it is
	// fleet-scoped, not session-scoped). Entries carry projectId/managed
	// (Phase 5: project-first grouping + managed-worktree eligibility).
	daemonRoster: [] as DaemonEntry[],
	// Phase 5: first-class registered projects (registered_projects frame;
	// fleet-scoped like daemonRoster — survives session resets, and
	// zero-daemon projects still render).
	registeredProjects: [] as RegisteredProject[],
	// Phase 4: resolved fleet config path from the registered_projects frame
	// (null = defaults, no config file). Fleet-scoped like the projects
	// above — survives session resets. Together with an empty project
	// registry and empty daemon roster it is the roster's first-run signal.
	fleetConfigPath: null as string | null,
	// Phase 5: delete-worktree guard evidence (worktree_delete_info unicast),
	// keyed by daemonId.
	worktreeDeleteInfo: {} as Record<string, WorktreeDeleteInfo>,
	// Phase 5: post-attach session-picker gate. Holds the daemonId awaiting
	// the new-vs-resume decision (armed by start:true onboarding senders,
	// stamped with the real daemonId when the attach fires, cleared by the
	// sessions answer / attach failure / daemon switch). Fleet-scoped.
	pendingSessionPicker: null as string | null,
	// Phase 5: SessionPicker context when opened from the onboarding gate —
	// non-null makes the picker render its "New session" top item (Esc =
	// new session). Cleared by the picker on close/new-session.
	sessionPickerGate: null as { daemonId: string } | null,
	sidebarVisible:
		typeof localStorage !== "undefined" ? localStorage.getItem(SIDEBAR_KEY) !== "false" : true,
	// Top-level view: "chat" (live session) or "transcripts" (historical
	// transcripts/stats browser — only meaningful in roster mode, where the
	// /ctl/stats API exists; the StatusBar toggle gates on sessionMode).
	view: "chat" as "chat" | "transcripts",
	// Phase 6: in-flight OAuth login prompts (unicast frames).
	loginUrl: null as { url: string; launchUrl?: string; instructions?: string } | null,
	loginCodeRequest: null as { requestId: string; title: string; placeholder?: string } | null,
	// Phase 3: pending server-pushed ExtensionUIContext dialog (ui_request
	// frame); answered via sendUiResponse/cancelUiRequest.
	uiRequest: null as { id: string; method: string; params: unknown } | null,
	// Display toggles (SettingsPanel checkboxes); reveal paces streamed text
	// (gradual reveal), soften fades the fresh tail. Reveal defaults ON.
	reveal: true,
	soften: false,
	error: null as string | null,
	// Client-side debug ring (Debug panel): one entry per transport lifecycle
	// event, capped at DEBUG_RING_CAP (oldest dropped). Mirror of the fleet's
	// /ctl/debug log for the browser half of the connection loop.
	debugLog: [] as DebugEntry[],
	// Last /events downlink activity (frame or ping) in ms epoch; 0 = never.
	// Drives the panel's "seconds since last frame" readout.
	lastFrameAt: 0,
	// Delay (ms) of the next scheduled manual reconnect; 0 = stream open (no
	// retry pending). Mirrors the module-level backoff ladder for the panel.
	reconnectDelay: 0,
	// Phase 11: desktop notifications on turn completion while hidden
	// (persisted toggle; firing is gated on Notification support + permission).
	notifyEnabled:
		typeof localStorage !== "undefined" && typeof Notification !== "undefined"
			? localStorage.getItem(NOTIFY_KEY) === "true"
			: false,
	// Phase 11: /btw side-panel session. streamId routes ephemeral_delta
	// frames to this panel; the panel never appears in the transcript.
	btw: null as null | {
		question: string;
		reply: string;
		streaming: boolean;
		streamId: number;
		error?: string;
	},
	// finding #P1: aria-live announcement text — rendered into the always-mounted
	// role="status" region in App.tsx. announce() dedupes identical consecutive
	// text so a burst of the same transition doesn't re-announce.
	announcement: "",
	// Fleet/app-scoped ephemeral notifications (worktree_removed on-disk
	// eviction toasts); survives session resets like daemonRoster.
	toasts: [] as { id: number; text: string }[],
});

/** Payload delivered into the PromptBox textarea (and image tray) by QueueBar/HistorySearch. */
export interface PromptInsert {
	text: string;
	images?: ImageArg[];
}

/** Result of requestDaemonLogs: tail/head text plus the broker log cursor. */
export type DaemonLogsResult = { text: string; cursor: number; state: string };

// Dev-only inspection handle (tests drive the UI through it).
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ompState = state;

/** finding #P1: announce a daemon's transition to a terminal rung (ready/error).
 *  First sighting (boot priming) and repeated identical statuses are silent.
 *  Deliberately NOT gated on session readiness — the roster is fleet-scoped,
 *  so a roster-mode tab with no attached session still hears its daemons come
 *  up or fall over. */
function announceDaemonStatus(
	prev: DaemonEntry | undefined,
	name: string,
	status: DaemonStatus,
): void {
	if (!prev || prev.status === status) return;
	if (status === "ready" || status === "error") announce(`${name} ${status}`);
}

/** Toast text for a poll-detected on-disk worktree removal: name + path,
 *  capped near 120 chars with a long path truncated from the left (an
 *  ellipsis keeps the informative basename tail). */
function worktreeRemovedToastText(name: string, path: string): string {
	const MAX_TOAST_TEXT = 120;
	const prefix = `Worktree removed on disk: ${name} (`;
	const maxPathLen = Math.max(1, MAX_TOAST_TEXT - prefix.length - 1); // -1: closing paren
	const shownPath =
		path.length <= maxPathLen ? path : `…${path.slice(-Math.max(0, maxPathLen - 1))}`;
	return `${prefix}${shownPath})`;
}

// ---------------------------------------------------------------------------
// Session mirror (kept here with the mux: applyState/loadHistory/resetSessionView
// are the cross-domain reset surface the tests drive through connect()).
// ---------------------------------------------------------------------------

/**
 * History chunks accumulate here while a chunked history series is in flight
 * (a >4 MiB transcript primes as byte-bounded `history` frames, the last
 * tagged `final: true`). A frame without `final` is a complete transcript on
 * its own and flushes immediately; the accumulator resets on every `attached`
 * (each attach starts a fresh priming series).
 */
let pendingHistory: AgentMessage[] | null = null;

/**
 * Frame seqs already applied on THIS connection's prime window. A delta that
 * is live-delivered while the paced prime is in flight (the consumer attaches
 * before priming completes) is re-sent verbatim by the ring replay, so the
 * second copy must be dropped (finding #2 — without the guard, a resume or a
 * fresh attach during activity double-applies every delta that arrived after
 * the final history chunk). Cleared on every attach and every loadHistory:
 * a frame wiped by the rebuild is legitimately re-applied by the replay, and
 * seqs restart per connection, so only the overlap within one prime is tracked.
 */
const seenFrameSeqs = new Set<number>();

export function loadHistory(messages: AgentMessage[]): void {
	clearPendingDeltas();
	// The rebuild wipes items pushed by any live-delivered delta since the
	// snapshot; the ring replay re-delivers those frames, so forget what was
	// seen before the rebuild (see seenFrameSeqs).
	seenFrameSeqs.clear();
	// Phase 5: reset id sequence so newly-switched sessions don't collide with
	// leftover ids from the prior transcript.
	resetChatIds();
	setState({
		items: [],
		live: { active: false, blocks: [], rev: 0 },
		retryInfo: null,
		workingIntent: undefined,
	});
	for (const msg of messages) {
		if (msg.role === "user") {
			const images = scanImages(msg.content);
			pushItem({
				kind: "user",
				id: nextChatId(),
				text: userText(msg.content),
				...(images.length > 0 ? { images } : {}),
			});
		} else if (msg.role === "assistant") {
			const meta = msg as { usage?: UsageLike; ttft?: number; duration?: number };
			pushItem({
				kind: "assistant",
				id: nextChatId(),
				blocks: assistantBlocks(msg.content),
				usage: meta.usage,
				ttft: meta.ttft,
				duration: meta.duration,
			});
			for (const c of msg.content) {
				if (c.type === "toolCall") {
					pushItem({
						kind: "tool",
						id: nextChatId(),
						toolCallId: c.id,
						name: c.name,
						args: c.arguments ?? {},
						status: "done",
						output: "",
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const index = findToolIndex(msg.toolCallId);
			const output = capTail(tabsToSpaces(extractText(msg)), 8000);
			const status: ToolStatus = msg.isError ? "error" : "done";
			const images = scanImages(msg);
			if (index >= 0) {
				setState(
					"items",
					produce((items) => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.output = output;
							item.status = status;
							if (images.length > 0) item.images = images;
						}
					}),
				);
			} else {
				pushItem({
					kind: "tool",
					id: nextChatId(),
					toolCallId: msg.toolCallId,
					name: msg.toolName,
					args: null,
					status,
					output,
					...(images.length > 0 ? { images } : {}),
				});
			}
		}
		// Any other role (developer, custom messages): skip.
	}
}

function applyState(s: WebSessionState, stats?: SessionStats): void {
	setState({
		model: s.model,
		modelRoles: s.modelRoles,
		modelRoleCatalog: s.modelRoleCatalog,
		modelRoleStorage: s.modelRoleStorage,
		thinkingLevel: s.thinkingLevel,
		streaming: s.isStreaming,
		compacting: s.isCompacting,
		steeringMode: s.steeringMode,
		followUpMode: s.followUpMode,
		interruptMode: s.interruptMode,
		sessionFile: s.sessionFile,
		sessionId: s.sessionId,
		sessionName: s.sessionName,
		autoCompactionEnabled: s.autoCompactionEnabled,
		autoRetryEnabled: s.autoRetryEnabled,
		messageCount: s.messageCount,
		queuedMessageCount: s.queuedMessageCount,
		todoPhases: s.todoPhases,
		contextUsage: s.contextUsage,
		dumpTools: s.dumpTools ?? [],
		goalModeState: s.goalModeState,
		planModeEnabled: s.planModeEnabled,
		fastModeEnabled: s.fastModeEnabled,
		computerToolEnabled: s.computerToolEnabled,
		inspectImageMode: s.inspectImageMode,
		// R8: state snapshots carry readyAt once the gate clears. Only apply it
		// when present so a pre-gate snapshot can't clobber a `ready` broadcast.
		...(s.readyAt !== undefined ? { readyAt: s.readyAt } : {}),
		// A snapshot taken while idle means any intent from a pre-reconnect turn
		// is stale; an in-flight turn keeps it (the next tool_execution_start or
		// agent_end will refresh/clear).
		...(s.isStreaming ? {} : { workingIntent: undefined }),
		...(stats !== undefined ? { stats } : {}),
	});
}

// ---------------------------------------------------------------------------
// /events stream teardown. The EventSource itself and the reconnect ladder
// live in connect() below; the teardown (terminal CLOSED or silence deadline)
// is shared with transport.ts's silence watcher. Pending slots across every
// domain are settled through the domain modules' exported resets.
// ---------------------------------------------------------------------------

let events: EventSource | null = null;

/** Silence deadline for the /events stream: any frame or ping re-arms it; a
 *  fire means the peer is dead — the socket is open but nothing is flowing
 *  (e.g. a hung middlebox) → teardown + reconnect. The daemon emits a named
 *  `ping` event every SSE_KEEPALIVE_MS precisely so this browser-side
 *  consumer can observe liveness. */
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

/** (Re)arm the silence deadline from any downlink activity. */
function armSilenceTimer(): void {
	if (silenceTimer !== null) clearTimeout(silenceTimer);
	silenceTimer = setTimeout(() => {
		silenceTimer = null;
		if (!events) return; // already torn down / no live stream
		const dead = events;
		pushDebug("warn", "transport", "silence deadline hit — forcing reconnect");
		teardownStream(dead);
		// Reconnect immediately (no backoff delay): the server may be
		// perfectly healthy behind a hung middlebox. If the reconnect itself
		// fails, the CLOSED-onerror backoff ladder takes over.
		connect();
	}, SSE_SILENCE_DEADLINE_MS);
}

function clearSilenceTimer(): void {
	if (silenceTimer !== null) {
		clearTimeout(silenceTimer);
		silenceTimer = null;
	}
}

/** Teardown for a dead /events stream (terminal CLOSED or silence deadline):
 *  drop readiness and reject pendings. Does NOT schedule the reconnect —
 *  callers pick the delay (backoff ladder for CLOSED, immediate for silence). */
function teardownStream(source: EventSource): void {
	if (events !== source) return; // a newer connect() already superseded this stream
	pushDebug("info", "transport", "stream closed");
	clearSilenceTimer();
	setConnected(false);
	events = null;
	source.close();
	setState("connected", false);
	// Readiness is per-connection: the reconnecting stream's boot session
	// must clear its own gate before the composer un-gates again.
	setState("readyAt", undefined);
	rejectPendingCalls(new Error("Disconnected"));
	resetPendingSessionsFiles();
	resetPendingProjects();
	// Phase 5: a dead stream cannot complete the onboarding flow — disarm the
	// picker gate and drop any picker context.
	rejectPendingAttach(new Error("Disconnected"));
	setState("pendingSessionPicker", null);
	setState("sessionPickerGate", null);
	rejectPendingDaemons(new Error("Disconnected"));
}

/** Roster mode with no daemon ever attached this tab; once attached, settings
 *  go through the session RPC for per-session option lists and live side
 *  effects. */
export function fleetSettingsActive(): boolean {
	return state.sessionMode === "roster" && state.currentSessionId === "";
}

// ---------------------------------------------------------------------------
// Phase 5: project-first sidebar grouping. Registered projects render in
// registry order (including zero-daemon projects), each followed by its
// daemons (main-checkout rows first, then worktrees; roster order within
// each partition). Entries with no matching registered project (remote /
// unregistered, or a projectId whose registry entry is gone) fall into one
// trailing { project: null } group in today's string-grouping order
// (`worktreeOf ?? project`, localeCompare, main checkouts first).
// ---------------------------------------------------------------------------

export function daemonsByProject(): {
	project: RegisteredProject | null;
	daemons: DaemonEntry[];
}[] {
	const groups: { project: RegisteredProject | null; daemons: DaemonEntry[] }[] =
		state.registeredProjects.map((project) => ({
			project,
			daemons: [],
		}));
	const byProjectId = new Map(state.registeredProjects.map((p, i) => [p.projectId, i]));
	const unregistered: DaemonEntry[] = [];
	for (const d of state.daemonRoster) {
		const index = d.projectId !== undefined ? byProjectId.get(d.projectId) : undefined;
		if (index === undefined) unregistered.push(d);
		else groups[index].daemons.push(d);
	}
	for (const g of groups) {
		const all = g.daemons;
		g.daemons = [
			...all.filter((d) => d.worktreeOf === undefined),
			...all.filter((d) => d.worktreeOf !== undefined),
		];
	}
	// Trailing fallback group: replicate the retired sidebar's string grouping.
	const byRepo = new Map<string, DaemonEntry[]>();
	for (const d of unregistered) {
		const key = d.worktreeOf ?? d.project;
		const list = byRepo.get(key);
		if (list) list.push(d);
		else byRepo.set(key, [d]);
	}
	const fallback: DaemonEntry[] = [];
	for (const key of [...byRepo.keys()].sort((a, b) => a.localeCompare(b))) {
		const all = byRepo.get(key)!;
		fallback.push(
			...all.filter((d) => d.worktreeOf === undefined),
			...all.filter((d) => d.worktreeOf !== undefined),
		);
	}
	if (fallback.length > 0) groups.push({ project: null, daemons: fallback });
	return groups;
}

/** Per-session UI state dropped when attaching to a different session. */
function resetSessionView(): void {
	clearPendingDeltas();
	// Same rationale as loadHistory: ids must not collide across transcripts.
	resetChatIds();
	setState({
		items: [],
		live: { active: false, blocks: [], rev: 0 },
		subagents: new Map<string, SubagentInfo>(),
		stats: null,
		goal: null,
		goalModeState: undefined,
		retryInfo: null,
		workingIntent: undefined,
		modal: null,
		// Phase 5: picker context dies with the modal it belongs to; the
		// component also clears it on close/new-session.
		sessionPickerGate: null,
		loginUrl: null,
		loginCodeRequest: null,
		uiRequest: null,
		btw: null,
	});
}

let backoff = 1000;

export function connect(): void {
	// Browser-only transport: without EventSource there is nothing to dial.
	// (A bun test worker has neither EventSource nor location — a silence
	// timer armed by an earlier suite in the same worker must no-op here,
	// not crash on location.search.)
	if (typeof EventSource === "undefined") return;
	pushDebug("info", "transport", "connecting /events");
	// Same-origin http(s): EventSource for the downlink (native auto-reconnect
	// sends Last-Event-ID for ring replay) + POST /command for the uplink.
	// EventSource can't set headers, so the off-loopback bearer token rides
	// the query string when the page URL carries one; loopback dev needs none.
	clearSilenceTimer(); // a new connect() supersedes any prior stream's deadline
	const token = new URLSearchParams(location.search).get("token") ?? null;
	setTransportToken(token);
	const params = new URLSearchParams({ client: clientId });
	if (token !== null) params.set("token", token);
	const source = new EventSource(`/events?${params}`);
	events = source;
	armSilenceTimer();
	source.onopen = () => {
		backoff = 1000;
		setConnected(true);
		setState("connected", true);
		setState("reconnectDelay", 0);
		pushDebug("info", "transport", "stream open");
		// No boot-time calls: a roster-mode edge answers every call with
		// "not attached" until the browser picks a daemon. The attached handler
		// pulls getSubagents. On a roster-mode RECONNECT the edge has no attach
		// memory — re-attach to the daemon we were viewing.
		if (state.sessionMode === "roster" && state.currentSessionId)
			void attachSession(state.currentSessionId).catch(() => {});
	};
	source.addEventListener(SSE_EVENT_NAME, (ev) => {
		armSilenceTimer(); // any downlink activity means the peer is alive
		setState("lastFrameAt", Date.now());
		const frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame;
		if (frame.type === "attached") {
			pushDebug("info", "transport", `attached ${frame.sessionId}`);
			const switched = state.currentSessionId !== "" && state.currentSessionId !== frame.sessionId;
			setState("currentSessionId", frame.sessionId);
			// Every attach re-primes history from scratch: drop any in-flight
			// chunked-series accumulation from the previous attach/session.
			pendingHistory = null;
			// A fresh priming series starts; the replay-dedup window resets
			// (seqs restart per connection, see seenFrameSeqs).
			seenFrameSeqs.clear();
			// Phase 6: there is no mux to switch to. In roster mode the attached
			// frame is PROXIED from the daemon and must not clobber the roster
			// sidebar; the roster frame owns sessionMode there.
			if (state.sessionMode !== "roster") setState("sessionMode", "single");
			// Finding #28: the attach waiter settles from the edge's id-keyed
			// attach_result, never from this PROXIED frame — the priming rides
			// the daemon pipe, which may be mid-redial when the attach lands.
			if (switched) {
				// In-flight calls belonged to the previous session; their results
				// are stale now and would be filtered out below. Clean up BEFORE
				// the getSubagents pull below, or rejectPendingCalls would kill the
				// fresh call too (and resetSessionView wipes its populated result).
				rejectPendingCalls(new Error("session switched"));
				resetSessionView();
				// Phase 3 daemon switch: drop readiness too. The edge only pipes
				// daemons that passed waitReady, so the proxied priming re-delivers
				// `ready` immediately; until then the composer stays gated and the
				// roster hint shows the session's status.
				setState("readyAt", undefined);
				// Phase 5: a switch to a DIFFERENT daemon disarms the picker gate
				// (the onboarding attach to the gate's own daemon is a switch too —
				// that one is kept so the sessions answer can still open the
				// picker, per the attach_result → list_sessions → sessions order).
				if (state.pendingSessionPicker !== null && state.pendingSessionPicker !== frame.sessionId) {
					setState("pendingSessionPicker", null);
				}
			}
			// Subagent mirror is per-session; pull on EVERY attach (first attach,
			// switch, roster re-attach after reconnect) — calls are answered only
			// once attached, so this is the earliest safe point.
			void call("getSubagents")
				.then((subs) => {
					const next = new Map<string, SubagentInfo>();
					for (const s of subs as SubagentInfo[]) if (s.id) next.set(s.id, s);
					setState("subagents", next);
				})
				.catch(() => {});
			return;
		}
		// Stale-frame guard: session-scoped frames for a handle this tab no
		// longer views (in flight during a switch) are dropped. Frames WITHOUT
		// a sessionId (standalone omp-session: one live session, connect = attached)
		// always pass — there is nothing to mismatch. attach_result is a unicast
		// answer whose sessionId is the ATTACHED daemonId (finding #28) and must
		// pass too — id-matching against pendingAttach handles staleness.
		if (
			frame.type !== "attach_result" &&
			"sessionId" in frame &&
			frame.sessionId !== state.currentSessionId
		)
			return;
		// Replay-dedup guard (finding #2): a delta live-delivered during the
		// paced prime is re-sent verbatim by the ring replay. Its seq was seen
		// on this connection already, so the second copy is the replay — drop
		// it (see seenFrameSeqs; native EventSource exposes the SSE id as
		// MessageEvent.lastEventId, absent for ping/undecorated frames).
		const frameSeq = Number((ev as MessageEvent).lastEventId);
		if (Number.isFinite(frameSeq) && frameSeq > 0 && seenFrameSeqs.has(frameSeq)) return;
		switch (frame.type) {
			case "history": {
				// A transcript over the SSE backpressure cap primes as
				// sequential frames (final: false … final: true); a frame
				// WITHOUT `final` (the original single-frame shape) is complete
				// on its own. Reassemble before loadHistory — it rebuilds items
				// from the whole transcript, so a partial load would lose data.
				if (frame.final === undefined) {
					pendingHistory = null;
					loadHistory(frame.messages);
				} else if (frame.final) {
					const all =
						pendingHistory === null ? frame.messages : pendingHistory.concat(frame.messages);
					pendingHistory = null;
					loadHistory(all);
				} else {
					pendingHistory =
						pendingHistory === null
							? frame.messages.slice()
							: pendingHistory.concat(frame.messages);
				}
				break;
			}
			case "state":
				applyState(frame.state, frame.stats);
				break;
			case "ready":
				// R8: the boot session's readiness gate cleared; the composer
				// un-gates. A stamped state frame may have set readyAt already;
				// this later broadcast wins either way.
				setState("readyAt", frame.readyAt);
				break;
			case "event":
				applyEvent(frame.event);
				break;
			case "bash_chunk":
				appendBashChunk(frame.id, frame.text);
				break;
			case "python_chunk":
				appendBashChunk(frame.id, frame.text);
				break;
			case "ephemeral_delta": {
				// Phase 11: /btw side-panel stream; route by streamId, ignore
				// stale frames from a superseded question. Coalesced into the
				// rAF flush by streamId (frames append); the flush re-checks
				// that this stream is still the panel's live one.
				if (state.btw?.streaming && frame.id === state.btw.streamId) {
					const pending = pendingEphemeral.get(frame.id);
					pendingEphemeral.set(frame.id, pending === undefined ? frame.text : pending + frame.text);
					scheduleFlush();
				}
				break;
			}
			case "call_result": {
				const pending = pendingCalls.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingCalls.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok) pending.resolve(frame.data);
				else pending.reject(new Error(frame.error ?? "call failed"));
				break;
			}
			case "attach_result":
				// Finding #28: the edge answers attach with this id-keyed
				// unicast; unrelated global error frames never settle the
				// waiter. Unknown id = superseded/timed out: ignore.
				settleAttachResult(frame);
				break;
			case "available_commands":
				setState("availableCommands", frame.commands);
				break;
			case "sessions":
				settleSessions(frame.sessions);
				// Phase 5: post-attach picker gate — the answer to the gate's
				// list_sessions decides new-vs-resume for the daemon just
				// attached. History exists → open the picker (its "New session"
				// top item + Esc = new session are component-side); none →
				// start a fresh session on the attached daemon directly.
				if (state.pendingSessionPicker !== null) {
					const daemonId = state.pendingSessionPicker;
					setState("pendingSessionPicker", null);
					if (frame.sessions.length > 0) {
						setState("sessionPickerGate", { daemonId });
						setState("modal", "sessions");
					} else {
						// Same path /new uses to start a new session.
						void call("newSession").catch((err) => setState("error", String(err)));
					}
				}
				break;
			case "daemons":
				setState(
					"daemons",
					new Map(
						((frame.daemons as DaemonInfo[] | undefined) ?? []).map((d) => [daemonsKey(d), d]),
					),
				);
				break;
			case "roster": {
				// finding #P1: diff the replacement roster against what we had —
				// first sighting is boot priming (silent); later transitions to
				// ready/error announce.
				const rosterBefore = state.daemonRoster;
				for (const entry of frame.daemons) {
					announceDaemonStatus(
						rosterBefore.find((d) => d.daemonId === entry.daemonId),
						entry.name,
						entry.status,
					);
				}
				// The fleet edge sent its daemon roster — this tab is in
				// roster mode (sidebar swaps to the session list). The attached
				// frame carries no mode; this frame is the mode signal, and it
				// must not be undone by the proxied attached frames (handled
				// above).
				// Phase 5: entries carry projectId/managed (project-first
				// grouping + managed-worktree eligibility) — DaemonEntry owns
				// those fields, so they flow through wholesale with the array.
				setState("daemonRoster", frame.daemons);
				setState("sessionMode", "roster");
				pushDebug(
					"info",
					"roster",
					`roster frame: ${frame.daemons.length} daemon${frame.daemons.length === 1 ? "" : "s"}`,
				);
				break;
			}
			case "daemon_status": {
				// finding #P1: announce the transition to a terminal rung
				// (ready/error) before patching the entry in place.
				const daemonBefore = state.daemonRoster.find((d) => d.daemonId === frame.daemonId);
				announceDaemonStatus(daemonBefore, daemonBefore?.name ?? frame.daemonId, frame.status);
				// Patch the matching roster entry in place; the error field
				// clears unless the frame carries a fresh one.
				setState("daemonRoster", (roster) =>
					roster.map((d) =>
						d.daemonId === frame.daemonId
							? {
									...d,
									status: frame.status,
									...(frame.error !== undefined ? { error: frame.error } : { error: undefined }),
								}
							: d,
					),
				);
				pushDebug(
					frame.status === "error" || frame.error !== undefined ? "error" : "info",
					"roster",
					`daemon ${frame.daemonId.slice(0, 8)} → ${frame.status}${frame.error !== undefined ? `: ${frame.error}` : ""}`,
				);
				break;
			}
			case "projects":
				settleProjects(frame.projects);
				break;
			case "project_branches":
				// Unicast answer to list_project_branches (fleet-scoped like
				// projects). A frame whose projectId doesn't match the pending
				// request belongs to a superseded one — leave it pending.
				settleProjectBranches(frame.projectId, frame.branches);
				break;
			case "registered_projects":
				// Phase 5: first-class project registry broadcast (fleet-scoped
				// like the roster — survives session resets; zero-daemon
				// projects still render via daemonsByProject).
				setState("registeredProjects", frame.projects);
				// Phase 4: the resolved fleet config path rides the same frame
				// (additive — older edges omit it, so missing = null). Also
				// fleet-scoped: resetSessionView must not wipe it (it is the
				// first-run signal until a config file exists).
				setState("fleetConfigPath", frame.configPath ?? null);
				break;
			case "worktree_delete_info":
				// Phase 5: unicast guard evidence for the delete-worktree
				// confirm, keyed by daemonId (latest-wins like the frames
				// above; fleet-scoped).
				setState("worktreeDeleteInfo", (prev) => ({ ...prev, [frame.daemonId]: frame }));
				break;
			case "worktree_removed": {
				// The fleet detected a worktree's directory vanished on disk and
				// evicted its daemon — one toast per eviction plus an aria-live
				// announcement (same text, reusing the finding #P1 announce
				// helper). Broadcast, fleet-edge-only like registered_projects:
				// no session guard (a bare omp-session never sends it), and
				// UI-initiated delete_worktree/remove never produce this frame.
				const text = worktreeRemovedToastText(frame.name, frame.path);
				pushToast(text);
				announce(text);
				break;
			}
			case "daemon_logs_result": {
				const pending = pendingDaemonLogs.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingDaemonLogs.delete(frame.id);
				clearTimeout(pending.timer);
				if (
					frame.ok &&
					frame.text !== undefined &&
					frame.cursor !== undefined &&
					frame.state !== undefined
				) {
					pending.resolve({ text: frame.text, cursor: frame.cursor, state: frame.state });
				} else {
					pending.reject(new Error(frame.error ?? "daemon logs failed"));
				}
				break;
			}
			case "daemon_control_result": {
				const pending = pendingDaemonControl.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingDaemonControl.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok && frame.daemon) pending.resolve(frame.daemon);
				else pending.reject(new Error(frame.error ?? "daemon control failed"));
				break;
			}
			case "files":
				settleFiles(frame.files);
				break;
			case "subagent_lifecycle": {
				const p = frame.payload as Partial<SubagentInfo> | undefined;
				if (!p?.id) break;
				setState("subagents", (prev) => {
					const next = new Map(prev);
					const existing = next.get(p.id as string);
					// Finding #30: progress frames can arrive BEFORE the lifecycle
					// frame — the progress handler created a `progress-${index}`
					// placeholder. Migrate it into the real-id entry so the strip
					// never shows two rows for one subagent, and keep the data the
					// placeholder accumulated (task, and status when the lifecycle
					// frame omits it) that this frame doesn't carry.
					const placeholder = p.index !== undefined ? next.get(`progress-${p.index}`) : undefined;
					if (placeholder) next.delete(`progress-${p.index}`);
					next.set(p.id as string, {
						id: p.id as string,
						index: p.index ?? existing?.index ?? placeholder?.index ?? -1,
						agent: p.agent ?? existing?.agent ?? placeholder?.agent ?? "agent",
						description: p.description ?? existing?.description,
						task: existing?.task ?? placeholder?.task,
						status: p.status ?? placeholder?.status ?? "started",
						lastUpdate: Date.now(),
						parentToolCallId:
							p.parentToolCallId ?? existing?.parentToolCallId ?? placeholder?.parentToolCallId,
					});
					return next;
				});
				break;
			}
			case "subagent_progress": {
				const p = frame.payload as
					| {
							index?: number;
							agent?: string;
							task?: string;
							progress?: { status?: string };
							parentToolCallId?: string;
					  }
					| undefined;
				if (p?.index === undefined) break;
				setState("subagents", (prev) => {
					const next = new Map(prev);
					let key = [...next.keys()].find((k) => next.get(k)?.index === p.index);
					if (!key) {
						key = `progress-${p.index}`;
						next.set(key, {
							id: key,
							index: p.index as number,
							agent: p.agent ?? "agent",
							status: "started",
							lastUpdate: Date.now(),
							parentToolCallId: p.parentToolCallId,
						});
					}
					const entry = next.get(key);
					if (entry) {
						if (p.task !== undefined) entry.task = p.task;
						if (p.parentToolCallId !== undefined) entry.parentToolCallId = p.parentToolCallId;
						if (p.progress?.status) entry.status = p.progress.status;
						entry.lastUpdate = Date.now();
					}
					return next;
				});
				break;
			}
			case "subagent_event":
				// Raw subagent session events: not subscribed ("progress" level only).
				break;
			case "login_url":
				// No window.open here: async WS frames lack user activation and the
				// popup would be blocked. LoginPanel owns the tab handoff.
				setState("loginUrl", {
					url: frame.url,
					launchUrl: frame.launchUrl,
					instructions: frame.instructions,
				});
				break;
			case "login_code_request":
				setState("loginCodeRequest", {
					requestId: frame.requestId,
					title: frame.title,
					placeholder: frame.placeholder,
				});
				break;
			case "ui_request":
				// Replace-with-warning: a second dialog supersedes the open one.
				// Answer the stale id as cancelled so its server-side pending
				// promise settles instead of hanging until socket close.
				if (state.uiRequest) {
					console.warn(`ui_request ${frame.id} superseding unanswered ${state.uiRequest.id}`);
					cancelUiRequest(state.uiRequest.id);
				}
				setState("uiRequest", { id: frame.id, method: frame.method, params: frame.params });
				break;
			case "ui_request_end":
				// Finding #16: the dialog settled (answered/rejected). Dismiss
				// it if it's the one shown — the ring replay delivers this
				// AFTER a stale ui_request on resume, so an answered dialog
				// never reappears as a hanging modal.
				if (state.uiRequest?.id === frame.id) setState("uiRequest", null);
				break;
			case "settings_changed": {
				// Session-scoped broadcast: a fresh model after any setSetting,
				// so every attached tab's panel stays in sync.
				const model = (frame as { model: SettingsModel }).model;
				setState("settingsModel", model);
				break;
			}
			case "error":
				// Finding #28: an error frame is a GLOBAL uncorrelated broadcast
				// (fire-and-forget spawn failures, a lost pipe for ANOTHER
				// daemon, "not attached" answers) — it must never settle an
				// in-flight attach. Attach failures arrive as id-keyed
				// attach_result frames; global errors only display.
				setState("error", frame.error);
				pushDebug("error", "transport", `error frame: ${frame.error}`);
				break;
			case "hello_ok":
				// Finding #61: the browser enforces OMP_PROTO too. Standalone
				// priming leads with hello_ok; the fleet edge forwards the
				// (pipe-gated) hello_ok in roster mode. A mismatch is terminal
				// — mirror the connector's fail-closed semantics: surface the
				// error, tear the stream down, and do NOT schedule the
				// reconnect (the backoff loop in onerror would otherwise hot-loop
				// against an undrivable daemon).
				if (frame.proto !== OMP_PROTO) {
					setState(
						"error",
						`proto mismatch: daemon speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
					);
					pushDebug(
						"error",
						"transport",
						`proto mismatch: daemon speaks ${String(frame.proto)}, expected ${OMP_PROTO}`,
					);
					teardownStream(source);
					return;
				}
				break;
			default:
				// Anything else unknown is tolerated and ignored, never thrown.
				console.debug(`[omp-session] ignoring ${frame.type} frame`);
				break;
		}
		if (Number.isFinite(frameSeq) && frameSeq > 0) seenFrameSeqs.add(frameSeq);
	});
	source.addEventListener(SSE_PING_EVENT, () => {
		// Keepalive tick: the server is alive (the stream is not silently
		// hung). Re-arm the silence deadline. The wire block carries no id,
		// so this never advances Last-Event-ID / ring replay.
		armSilenceTimer();
		setState("lastFrameAt", Date.now());
	});
	source.onerror = () => {
		// Terminal (401 or fatal): EventSource gives up (readyState CLOSED) and
		// will NOT retry. Teardown like a socket close, then manually reconnect
		// with the same 1s→8s backoff — auth failures must not hot-loop.
		if (source.readyState !== EventSource.CLOSED) {
			pushDebug("info", "transport", "transient blip — native auto-reconnect");
			return; // transient blip: native auto-reconnect resumes with Last-Event-ID
		}
		teardownStream(source); // no-op if a newer connect() superseded this stream
		const delay = backoff;
		backoff = Math.min(backoff * 2, 8000);
		setState("reconnectDelay", delay);
		pushDebug("warn", "transport", `connection lost — retrying in ${delay}ms`);
		setTimeout(connect, delay);
	};
}

// ---------------------------------------------------------------------------
// Facade (Phase 3 store facade split): every action the original state.ts
// exported is re-exported here so call sites (components, tests) keep
// importing from "../state" byte-identical. Types and the store stay defined
// above; the actions live in src/store/<domain>.ts.
// ---------------------------------------------------------------------------
export { isReady } from "./store/session";
export {
	argsSummary,
	truncateHead,
	setNotifyEnabled,
	pushNotice,
	pushCompaction,
	addBashItem,
	resolveBashItem,
	dequeueLastQueued,
	promptInsert,
	setPromptInsert,
} from "./store/chat";
export { listSessions, listFiles, setSidebarVisible, toggleSidebar } from "./store/roster";
export {
	listProjects,
	listProjectBranches,
	spawnDaemon,
	spawnResume,
	stopDaemonById,
	removeDaemonById,
	sendAddProject,
	sendRemoveProject,
	sendCreateWorktree,
	sendAddExistingWorktree,
	sendDeleteWorktree,
	sendWorktreeDeleteInfo,
} from "./store/projects";
export { sendLoginCode, sendUiResponse } from "./store/modals";
export { refreshSettings, updateSetting } from "./store/settings";
export {
	DEBUG_RING_CAP,
	fetchCtlDebug,
	fetchCtlTemplates,
	fetchDaemonStderr,
	requestDaemonLogs,
	stopDaemon,
	restartDaemon,
} from "./store/transport";
export { steerSubagent, abortSubagent } from "./store/subagents";
export { askBtw, closeBtw } from "./store/btw";
export { dismissToast, pushToast } from "./store/toasts";
export { announce, appendBashChunk, applyEvent, cancelUiRequest, attachSession, call, clientId };
