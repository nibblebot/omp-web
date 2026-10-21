import { readDockWidth } from "./prefs/dock";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AdvisorItem } from "./store/slices/advisor";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { TextAttachment } from "./prompt/attachments";
import { batch } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { OMP_PROTO, SSE_EVENT_NAME, SSE_SILENCE_DEADLINE_MS, daemonsKey } from "#lib/wire/protocol";
import type {
	AvailableSlashCommand,
	DaemonEntry,
	DaemonInfo,
	DaemonStatus,
	ImageArg,
	ModelBrowserEntry,
	PublicProviderProfile,
	RegisteredProject,
	ServerFrame,
	SettingsModel,
	WebSessionState,
} from "#lib/wire/protocol";
import { SSE_PING_EVENT } from "#lib/wire/sse";
import { featurePreferences } from "./features/preferences";
import { clearUnread, markUnread, pruneUnread } from "./fleet-ui/unread";
import type { UsageLike } from "./usage/usage";
import { createHistoryBuilder } from "./chat/history-items";
import { noticeAdvisorNotesWhileOff } from "./store/advisor-notice";
import { COLLAB_OFF } from "./store/slices/collab";
import {
	announce,
	appendBashChunk,
	applyEvent,
	clearPendingDeltas,
	nextChatId,
	pendingEphemeral,
	resetChatIds,
	settleRunningTools,
	scheduleFlush,
	notifyDesktop,
	pushNotice,
	startNewSession,
} from "./store/chat";
import { cancelUiRequest } from "./store/modals";
import {
	resetPendingProjects,
	deletePendingIds,
	resumeRestartedDaemons,
	settleAddProject,
	settleProjectBranches,
	settleWorkspaceCreate,
} from "./store/projects";
import { reportError } from "./store/toasts";
import { clearUserStopped, isUserStopped, reconcileUserStopped } from "./store/user-stopped";
import { checkSession, subscribeAuth, type AuthStatus, type AuthSnapshot } from "./store/auth";
import { applySettingsModel, refreshSettings } from "./store/settings";
import {
	resetPendingSessionsFiles,
	settleDaemonSessions,
	settleFiles,
	settleProjectWakes,
	settleSessions,
	switchToDaemon,
} from "./store/roster";
import { dismissToast, pushToast, type ToastAction } from "./store/toasts";
import { parseRoute } from "./store/route";
import {
	attachSession,
	call,
	clientId,
	pendingAttachTarget,
	pendingDaemonControl,
	pendingDaemonLogs,
	pushDebug,
	rejectPendingAttach,
	rejectPendingCalls,
	rejectPendingDaemons,
	resumeParkedMutations,
	retryNotAttachedCalls,
	settleAttachedFrame,
	setConnected,
	setTransportToken,
	settleAttachResult,
	settleAttachmentState,
	settleCallResult,
} from "./store/transport";
import { createReviewState, resetReviewState } from "./store/slices/review";
import { applyBtwEphemeralDelta, createBtwState } from "./store/slices/btw";
import { createGoalState } from "./store/slices/goals";
import { createIntegrationState } from "./store/slices/integrations";
import { createResumeState } from "./store/resume";
import { createCompactionState } from "./store/compaction";
import { createWorkersState, requestRosterRefresh } from "./store/subagents";
import { applyLifecycleFrame, applyProgressFrame } from "./store/subagent-frames";
import {
	createBrowserUiState,
	endBrowserUiRequest,
	receiveBrowserUiRequest,
	resetBrowserUiRequests,
} from "./store/browser-ui";

// ---------------------------------------------------------------------------
// Shared model vocabulary (types stay here so the store init and every
// caller keep importing them from "../state"). The ~50 exported ACTIONS live
// in apps/web/store/<domain>.ts and are re-exported at the bottom of this file, so
// call sites are byte-identical.
// ---------------------------------------------------------------------------
export type Block = { kind: "text" | "thinking"; text: string };
/** What the transcript pane shows for a session switch (see `state.transcriptPhase`). */
export type TranscriptPhase = "idle" | "waking" | "attaching" | "loaded" | "failed";
export type ToolStatus = "running" | "done" | "error";
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
	tokensAfter?: number;
	method?: string;
	warning?: string;
	timestamp?: number;
	skipped: boolean;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
};
export type ChatItem =
	| { kind: "user"; id: number; text: string; images?: ImageArg[]; timestamp?: number }
	| {
			kind: "assistant";
			id: number;
			blocks: Block[];
			usage?: UsageLike;
			ttft?: number;
			duration?: number;
			/** Epoch ms the session stamped at message_end; anchors display.showTurnTime. */
			completedAt?: number;
			/** Stop aborted this turn; the card shows an Interrupted footer. */
			interrupted?: boolean;
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
			/** Settled result details (edit diff, todo phase snapshot, file counts), so the card shows the call as it was; absent until settled. */
			details?: unknown;
	  }
	| BashItem
	| CompactionItem
	| AdvisorItem
	| { kind: "guestPrompt"; id: number; from: string; text: string }
	| { kind: "notice"; id: number; level: string; message: string; command?: string };

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
	/** Raw SDK AgentProgress record, merged across delta frames (U02 coalescing). */
	progress?: Record<string, unknown>;
	startedAt?: number;
	endedAt?: number;
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
	| "hotkeys"
	| "model"
	| "thinking"
	| "stats"
	| "settings"
	| "sessions"
	| "advisor"
	| "login"
	| "goal"
	| "usage"
	| "debug"
	// Phase 5: project onboarding. Opens the Add project folder chooser.
	| "add-project"
	// Browser-auth sign-in surface (opened by the auth subscription on
	// signedOut, exactly like the store/modals contract wires it).
	| "sign-in"
	| "integrations"
	| "plan-review"
	| "annotations"
	| "todos"
	| "compaction"
	| "btw"
	| "share"
	| "palette";

/** Unicast answer to sendWorktreeDeleteInfo: guard evidence for the
 *  delete-worktree confirm dialog (linked identity, dirty counts, branch state). */
export type WorktreeDeleteInfo = Extract<ServerFrame, { type: "worktree_delete_info" }>;

/** localStorage key for the roster sidebar visibility toggle (docked viewports only). */
export const SIDEBAR_KEY = "omp.sidebarVisible";

/** localStorage key for the Phase 11 desktop-notifications toggle. */
const NOTIFY_KEY = "omp.notifyEnabled";

/** localStorage key for the Phase 12 roster-sidebar usage widget toggle. */
const USAGE_SIDEBAR_KEY = "omp.sidebarUsage";

/** localStorage key for the persisted Chat/Analysis top-level view. */
const VIEW_KEY = "omp.view";

/** localStorage key for the transcripts (Analysis) sidebar visibility toggle (docked viewports only). */
export const TX_SIDEBAR_KEY = "omp.txSidebarVisible";

/**
 * Resolve the initial Chat/Analysis view (exported pure helper, unit-tested
 * in apps/web/test/state.test.ts). A #/s/<file> hash deep-links into Analysis at that
 * transcript regardless of the persisted value; otherwise the persisted
 * value migrates silently to the current vocabulary (legacy "work" maps to
 * "chat", legacy "transcripts" maps to "analysis"), with anything unknown or
 * absent defaulting to Chat. When the analysis feature is disabled, every
 * route into Analysis (deep link, persisted value, legacy value) falls back
 * to Chat.
 */
export function initialView(
	persisted: string | null,
	hash: string,
	analysisEnabled: boolean,
): "chat" | "analysis" {
	if (!analysisEnabled) return "chat";
	// Analysis deep links (#/s/<file>, #/stored/<workspaceId>/<sessionId>) boot
	// into Analysis; session routes (#/d/<daemonId>[/s/<sessionId>]) boot into
	// Chat. Both override the persisted Chat/Analysis choice.
	const route = parseRoute(hash);
	if (route.kind === "analysis") return "analysis";
	if (route.kind !== "none") return "chat";
	if (persisted === "analysis" || persisted === "transcripts") return "analysis";
	return "chat";
}

/** Below 1024px both sidebars are slide-out drawers; at 1024px and up they dock. shell.css mirrors this breakpoint. */
const drawerMedia = typeof matchMedia !== "undefined" ? matchMedia("(max-width: 1023px)") : null;
const drawerViewport = drawerMedia?.matches ?? false;

/** Visibility restored for a viewport: drawers always start closed; docked columns keep the persisted choice, open by default. */
function restoredVisibility(key: string, drawer: boolean): boolean {
	if (drawer) return false;
	return typeof localStorage === "undefined" || localStorage.getItem(key) !== "false";
}

export const [state, setState] = createStore({
	review: createReviewState(),
	integrations: createIntegrationState(),
	resume: createResumeState(),
	compaction: createCompactionState(),
	workers: createWorkersState(),
	browserUi: createBrowserUiState(),
	items: [] as ChatItem[],
	// rev: monotonic content version of live.blocks, bumped on every live
	// mutation so scroll/pin effects subscribe to "content changed" without
	// scanning block text lengths on every flush (see Transcript's pinning
	// effect; it used to allocate a lengths array per flush).
	live: { active: false, blocks: [] as Block[], rev: 0 },
	// --- WebSessionState mirror (verbatim; see protocol state frames) ---
	streaming: false,
	// Transcript scroll pin, mirrored from useStickyScroll: true while the
	// viewport sits at the live edge. Read at turn end to decide
	// answerUnviewed. Defaults true (a fresh attach lands pinned at the
	// bottom); the hook keeps it in sync from its pin mutations.
	chatPinned: true,
	// A turn ENDED while the transcript was scrolled away from the live edge
	// (agent_end, apps/web/store/chat.ts). The finished answer sits below the
	// viewport, unviewed. Cleared when the user re-pins (scrolls to the
	// bottom / jump button), when a new turn starts, or on session switch
	// (all in useStickyScroll / applyEvent). Feeds the attached roster row's
	// yellow "unreviewed" dot (apps/web/fleet-ui/session-activity.ts).
	answerUnviewed: false,
	// TUI-parity dynamic working label (interactive-mode's setWorkingMessage):
	// the latest tool-call intent ("Reading config files…"), undefined = the
	// default phrase. Session-scoped; cleared on turn end and transcript resets.
	workingIntent: undefined as string | undefined,
	compacting: false,
	model: undefined as WebSessionState["model"],
	modelRoles: undefined as WebSessionState["modelRoles"],
	modelRoleCatalog: undefined as WebSessionState["modelRoleCatalog"],
	modelRoleStorage: undefined as WebSessionState["modelRoleStorage"],
	// True once a state frame has landed for the transcript currently loaded.
	// Every history load (priming, newSession/switchSession resync) is followed
	// by a state frame carrying that session's model; until it arrives
	// state.model still belongs to the previous session (or is undefined on
	// first attach), so the empty-state character must not render from it.
	modelSynced: false,
	thinkingLevel: undefined as WebSessionState["thinkingLevel"],
	autoThinking: false,
	/** Quick model picker rows (`getModelBrowser`); `modelPickerTask` opens it in Task-model mode. */
	modelBrowser: [] as ModelBrowserEntry[],
	modelPickerTask: false,
	/** Server-owned thinking selectors the active model supports (no silent clamping). */
	thinkingSelectors: undefined as WebSessionState["thinkingSelectors"],
	modelPresets: undefined as WebSessionState["modelPresets"],
	taskModel: undefined as WebSessionState["taskModel"],
	sessionName: undefined as string | undefined,
	sessionId: "",
	sessionScope: undefined as WebSessionState["sessionScope"],
	capabilities: {} as NonNullable<WebSessionState["capabilities"]>,
	// R8 omp-session readiness: set by the `ready` broadcast (or a stamped state
	// frame) once the SDK session is live and provider/model/auth resolved.
	readyAt: undefined as WebSessionState["readyAt"],
	// Phase 2: server-assigned handle of the live session this tab is attached
	// to (distinct from sessionId above, the agent's own id, which changes on
	// switchSession). Session-scoped frames for any other handle are dropped.
	currentSessionId: "",
	// What the transcript pane is doing for a session switch (C3). `waking` /
	// `attaching` / `failed` are written only by the switch in store/roster.ts
	// (switchToDaemon and the paths that share it), `loaded` only by loadHistory,
	// `idle` when no session is selected. The boot session is always "" (a
	// remembered route attaches through the switch once the roster lands).
	transcriptPhase: "idle" as TranscriptPhase,
	// Why the switch failed; null unless `transcriptPhase` is `failed`.
	transcriptError: null as string | null,
	// The daemon the in-flight (or failed) switch targets; null when the pane is
	// loaded/idle, and for a re-attach of the attached daemon (no transition).
	transcriptTarget: null as string | null,
	sessionFile: undefined as string | undefined,
	contextUsage: undefined as WebSessionState["contextUsage"],
	queuedMessageCount: 0,
	pausedQueueCount: 0,
	messageCount: 0,
	todoPhases: [] as WebSessionState["todoPhases"],
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	// --- Phase 9: modes & usage parity (WebSessionState mirror) ---
	...createGoalState(),
	planModeEnabled: false,
	planReviewPending: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
	// Live auto-retry countdown (auto_retry_start/auto_retry_end events).
	retryInfo: null as {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		until: number;
	} | null,
	// --- Server-pushed extras ---
	availableCommands: [] as AvailableSlashCommand[],
	stats: null as SessionStats | null,
	subagents: new Map<string, SubagentInfo>(),
	connected: false,
	// Browser-auth state: mirrored from apps/web/store/auth.ts by
	// subscribeAuth. "unknown" until the first session probe; "disabled"
	// (fleet/daemon without browser auth) behaves exactly as before this
	// integration. signedOut opens the sign-in modal.
	authStatus: "unknown" as "unknown" | "signedOut" | "signedIn" | "disabled",
	authExpiresAt: undefined as number | undefined,
	modal: null as ModalName | null,
	// Right-hand dock (U18): which panel is open, null when closed. Written only
	// through store/dock.ts (openDock/closeDock); the route mirrors it.
	dock: null as { kind: string; id?: string } | null,
	dockWidth: readDockWidth(),
	// Project whose New workspace popover is open (anchored to its group "+").
	// Set by openNewWorkspace/closeNewWorkspace; the palette uses the same calls.
	newWorkspaceProjectId: null as string | null,
	// Project group the sidebar scrolls to and flashes after an add; cleared
	// by ProjectGroups when the flash animation ends.
	highlightProjectId: null as string | null,
	// Folder the Add-project dialog opens prefilled with (an unowned session's
	// folder); null when opened from elsewhere. Cleared when the dialog closes.
	addProjectPath: null as string | null,
	// Search text the Settings sheet opens with (`/settings <query>`); set
	// alongside modal "settings" on every open, so a bare open passes "".
	settingsQuery: "" as string,
	// daemonId the delete-workspace confirm dialog targets (worktree guard
	// evidence or clone verified-delete).
	deleteWorkspaceTarget: null as string | null,
	// projectId the remove-project confirm targets.
	removeProjectTarget: null as string | null,
	// daemonId whose details dialog is open (fleet-scoped: survives session
	// switches; the dialog closes itself when the roster entry disappears).
	daemonDetailsId: null as string | null,
	// Image shown in the full-size lightbox (session content, so
	// resetSessionView clears it).
	lightboxImage: null as ImageArg | null,
	toolsExpanded: false,
	// Daemon broker roster (hub/launch long-running processes); project-scoped,
	// so resetSessionView must NOT clear it.
	daemons: new Map<string, DaemonInfo>(),
	// Settings model (getSettings/setSetting + settings_changed frames).
	settingsModel: null as SettingsModel | null,
	settingsLoading: false,
	// Settings tab the next settings sheet opens on (set by "Configure providers");
	// the sheet clears it on mount. Null = the default tab.
	settingsTab: null as string | null,
	// Fleet edge roster (roster frame). Patched in place by
	// daemon_status frames; NOT cleared by resetSessionView (it is
	// fleet-scoped, not session-scoped). Entries carry projectId
	// (Phase 5: project-first grouping + linked-worktree eligibility).
	daemonRoster: [] as DaemonEntry[],
	// True once the first roster frame landed (never reset: it survives session
	// resets and reconnects); lets the sidebar tell boot priming from a new row.
	rosterLoaded: false as boolean,
	// Per-daemon realtime activity (streaming / blocked) fed by the edge's
	// additive fleet-scoped `daemon_activity` frames (derived from each ready
	// daemon's tapped stream). Survives resetSessionView / session switches
	// like daemonRoster; pruned on roster frames for ids that left the fleet.
	daemonActivity: {} as Record<string, { streaming: boolean; blocked: boolean }>,
	// Phase 5: first-class registered projects (registered_projects frame;
	// fleet-scoped like daemonRoster; it survives session resets, and
	// zero-daemon projects still render).
	registeredProjects: [] as RegisteredProject[],
	// Secret-free provider profile catalog (optional
	// registered_projects.providerProfiles; older fleets omit it →
	// []). Fleet-scoped like registeredProjects and boot-static; a fleet
	// restart/reload re-sends it, so a session reset must not clear it.
	providerProfiles: [] as PublicProviderProfile[],
	// Phase 4: resolved fleet config path from the registered_projects frame
	// (null = defaults, no config file). Fleet-scoped like the projects
	// above; it survives session resets.
	fleetConfigPath: null as string | null,
	// Phase 5: delete-worktree guard evidence (worktree_delete_info unicast),
	// keyed by daemonId.
	worktreeDeleteInfo: {} as Record<string, WorktreeDeleteInfo>,
	// Phase 5: post-attach session-picker gate. Holds the daemonId
	// awaiting the new-vs-resume decision (armed by start:true onboarding
	// senders (add project / create worktree / create clone), stamped with
	// the real daemonId when the attach fires, cleared by the sessions
	// answer / attach failure / daemon switch). Fleet-scoped.
	pendingSessionPicker: null as string | null,
	// Phase 5: SessionPicker context when opened from the onboarding gate.
	// Non-null makes the picker render its "New session" top item (Esc =
	// new session). Cleared by the picker on close/new-session.
	sessionPickerGate: null as { daemonId: string } | null,
	// Drawer/docked split (see drawerMedia above); drives drawer-only rules in the store.
	drawerViewport,
	sidebarVisible: restoredVisibility(SIDEBAR_KEY, drawerViewport),
	// Per-mode sidebar collapse for Analysis (the transcripts sidebar): same
	// rule as the roster toggle, separate key.
	txSidebarVisible: restoredVisibility(TX_SIDEBAR_KEY, drawerViewport),
	// Top-level view: "chat" (roster sidebar + live conversation) or
	// "analysis" (transcript sidebar + historical transcripts browser).
	// Persisted in omp.view with silent migration; a boot-time #/s/<file> hash
	// deep-links into Analysis (initialView above).
	view: initialView(
		typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null,
		typeof location !== "undefined" ? location.hash : "",
		featurePreferences().analysis,
	),
	// Chat-button activity dot: a turn ENDED while the tab was in Analysis
	// (agent_end in apps/web/store/chat.ts for the attached session, detached
	// daemon_activity flips in the /events handler below). Ephemeral like
	// answerUnviewed; cleared only by setView("chat").
	chatUnviewed: false,
	// Phase 6: in-flight OAuth login prompts (unicast frames).
	loginUrl: null as { url: string; launchUrl?: string; instructions?: string } | null,
	loginCodeRequest: null as { requestId: string; title: string; placeholder?: string } | null,
	// Phase 3: pending server-pushed ExtensionUIContext dialog (ui_request
	// frame); answered via sendUiResponse/cancelUiRequest.
	uiRequest: null as { id: string; method: string; params: unknown } | null,
	// Display toggle (SettingsPanel checkbox): soften fades the fresh tail.
	// Paced reveal is display.smoothStreaming, read via chat/display-prefs.
	soften: false,
	error: null as string | null,
	collabStatus: COLLAB_OFF,
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
	// The attached daemon id whose session process stopped or crashed (asleep/error:
	// the view was cleared by reconcileAttachedSession and Restart makes sense);
	// "" when nothing is down. A daemon REMOVED from the roster never sets it: the
	// view moves to a neighbouring session instead (see switchAwayFromRemoved).
	sessionDownId: "",
	// True once the attached daemon has stayed "reconnecting" past the grace
	// window: a routine renewal or brief re-dial never shows the strip.
	attachedReconnecting: false,
	// Phase 11: desktop notifications on turn completion while hidden
	// (persisted toggle; firing is gated on Notification support + permission).
	notifyEnabled:
		typeof localStorage !== "undefined" && typeof Notification !== "undefined"
			? localStorage.getItem(NOTIFY_KEY) === "true"
			: false,
	// Phase 12: condensed usage panel pinned above the roster footer buttons
	// (persisted toggle; data comes from the fleet GET /ctl/usage via refreshUsageReports).
	sidebarUsage:
		typeof localStorage !== "undefined"
			? localStorage.getItem(USAGE_SIDEBAR_KEY) !== "false"
			: true,
	// Phase 12: GET /ctl/usage mirror; null means never fetched, [] means
	// fetched but no reporting. Single-flight via usageLoading (refreshUsageReports).
	usageReports: null as UsageReport[] | null,
	usageLoading: false as boolean,
	usageError: null as string | null,
	// Phase 11: /btw side-panel session. streamId routes ephemeral_delta
	// frames to this panel; the panel never appears in the transcript.
	btw: createBtwState(),
	// finding #P1: aria-live announcement text, rendered into the always-mounted
	// role="status" region in App.tsx. announce() dedupes identical consecutive
	// text so a burst of the same transition doesn't re-announce.
	announcement: "",
	// Fleet/app-scoped ephemeral notifications (worktree_removed on-disk
	// eviction toasts); survives session resets like daemonRoster.
	toasts: [] as { id: number; text: string; action?: ToastAction }[],
});

// A viewport crossing re-derives sidebar visibility: drawers close, docked
// columns restore their persisted choice.
drawerMedia?.addEventListener("change", (event) => {
	setState({
		drawerViewport: event.matches,
		sidebarVisible: restoredVisibility(SIDEBAR_KEY, event.matches),
		txSidebarVisible: restoredVisibility(TX_SIDEBAR_KEY, event.matches),
	});
});

/** Payload delivered into the PromptBox textarea (and image tray) by QueueBar/HistorySearch. */
export interface PromptInsert {
	text: string;
	images?: ImageArg[];
	files?: TextAttachment[];
	selection?: { start: number; end: number };
}

/** Result of requestDaemonLogs: tail/head text plus the broker log cursor. */
export type DaemonLogsResult = { text: string; cursor: number; state: string };

// Dev-only inspection handle (tests drive the UI through it).
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ompState = state;

/** finding #P1: announce a daemon's transition to a terminal rung (ready/error).
 *  First sighting (boot priming) and repeated identical statuses are silent.
 *  Deliberately NOT gated on session readiness; the roster is fleet-scoped,
 *  so a tab with no attached session still hears its daemons come
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
 * second copy must be dropped (finding #2; without the guard, a resume or a
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
	// Build the transcript as a plain array and commit it with ONE store write.
	// Appending per message (`[...items, item]`) copied the array and made the
	// store re-walk every prior item on each push: quadratic, ~400ms of main
	// thread on a 2 MB transcript before the chat could paint.
	const built = createHistoryBuilder(nextChatId).append(messages);
	const items = built.items;
	noticeAdvisorNotesWhileOff(built.advisorNotes);
	setState({
		items,
		live: { active: false, blocks: [], rev: 0 },
		retryInfo: null,
		workingIntent: undefined,
		modelSynced: false,
		// A history frame of the OLD session landing while a switch to another
		// daemon is pending must not end that switch's wait.
		...(state.transcriptTarget === null || state.transcriptTarget === state.currentSessionId
			? { transcriptPhase: "loaded" as const, transcriptError: null, transcriptTarget: null }
			: {}),
	});
}

function applyState(s: WebSessionState, stats?: SessionStats): void {
	// Open the review sheet only on the false→true edge, so a re-broadcast does not reopen a dismissed sheet.
	const reviewOpened = s.planReviewPending === true && !state.planReviewPending;
	setState({
		sessionScope: s.sessionScope,
		capabilities: s.capabilities ?? {},
		model: s.model,
		modelSynced: true,
		modelRoles: s.modelRoles,
		modelRoleCatalog: s.modelRoleCatalog,
		modelRoleStorage: s.modelRoleStorage,
		thinkingLevel: s.thinkingLevel,
		autoThinking: s.autoThinking ?? false,
		thinkingSelectors: s.thinkingSelectors,
		modelPresets: s.modelPresets,
		taskModel: s.taskModel,
		streaming: s.isStreaming,
		compacting: s.isCompacting,
		sessionFile: s.sessionFile,
		sessionId: s.sessionId,
		sessionName: s.sessionName,
		autoCompactionEnabled: s.autoCompactionEnabled,
		autoRetryEnabled: s.autoRetryEnabled,
		messageCount: s.messageCount,
		queuedMessageCount: s.queuedMessageCount,
		pausedQueueCount: s.pausedQueueCount ?? 0,
		todoPhases: s.todoPhases,
		contextUsage: s.contextUsage,
		goalModeState: s.goalModeState,
		planModeEnabled: s.planModeEnabled,
		planReviewPending: s.planReviewPending === true,
		fastModeEnabled: s.fastModeEnabled,
		computerToolEnabled: s.computerToolEnabled,
		// R8: state snapshots carry readyAt once the gate clears. Only apply it
		// when present so a pre-gate snapshot can't clobber a `ready` broadcast.
		...(s.readyAt !== undefined ? { readyAt: s.readyAt } : {}),
		// A snapshot taken while idle means any intent from a pre-reconnect turn
		// is stale; an in-flight turn keeps it (the next tool_execution_start or
		// agent_end will refresh/clear).
		...(s.isStreaming ? {} : { workingIntent: undefined }),
		...(stats !== undefined ? { stats } : {}),
	});
	// No tool is in flight once the turn is idle: settle what a replayed transcript left running.
	if (!s.isStreaming) settleRunningTools();
	if (reviewOpened) setState("modal", "plan-review");
}

// ---------------------------------------------------------------------------
// /events stream teardown. The EventSource itself and the reconnect ladder
// live in connect() below; the teardown (terminal CLOSED or silence deadline)
// is shared with transport.ts's silence watcher. Pending slots across every
// domain are settled through the domain modules' exported resets.
// ---------------------------------------------------------------------------

let events: EventSource | null = null;

/** Silence deadline for the /events stream: any frame or ping re-arms it; a
 *  fire means the peer is dead. The socket is open but nothing is flowing
 *  (e.g. a hung middlebox), so tear down and reconnect. The daemon emits a
 *  named `ping` event every SSE_KEEPALIVE_MS precisely so this browser-side
 *  consumer can observe liveness. */
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

/** (Re)arm the silence deadline from any downlink activity. */
function armSilenceTimer(): void {
	if (silenceTimer !== null) clearTimeout(silenceTimer);
	silenceTimer = setTimeout(() => {
		silenceTimer = null;
		if (!events) return; // already torn down / no live stream
		const dead = events;
		pushDebug("warn", "transport", "silence deadline hit, forcing reconnect");
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
 *  drop readiness and reject pendings. Does NOT schedule the reconnect;
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
	// Phase 5: a dead stream cannot complete the onboarding flow, so disarm
	// the picker gate and drop any picker context.
	rejectPendingAttach(new Error("Disconnected"));
	setState("pendingSessionPicker", null);
	setState("sessionPickerGate", null);
	rejectPendingDaemons(new Error("Disconnected"));
}

/** The fleet roster with no daemon attached yet: settings go through the
 *  roster's /ctl relay until an attach lands. Once attached, settings go
 *  through the session RPC for per-session option lists and live side
 *  effects. */
export function fleetSettingsActive(): boolean {
	return state.currentSessionId === "";
}

// ---------------------------------------------------------------------------
// Project-first sidebar grouping. Registered projects render in registry
// order (including zero-row projects). Each project's rows are ordered: the
// main checkout first, then worktrees by branch name, then clones (roster
// order breaks ties). Rows without a registered projectId are not shown.
// ---------------------------------------------------------------------------

/** The roster after one row-level delta: removed rows dropped, upserted rows replacing their id's row or appended in arrival order. */
function mergeRosterDelta(delta: { upserted: DaemonEntry[]; removed: string[] }): DaemonEntry[] {
	const removed = new Set(delta.removed);
	const next = unwrap(state.daemonRoster).filter((d) => !removed.has(d.daemonId));
	for (const row of delta.upserted) {
		const at = next.findIndex((d) => d.daemonId === row.daemonId);
		if (at === -1) next.push(row);
		else next[at] = row;
	}
	return next;
}

/** Whether two row fields hold the same value; the only nested fields (`labels`, `git`) are small and flat, so a JSON compare is exact. */
function sameRosterField(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields of `prev` that `row` changes, absent ones as `undefined` (a store set of `undefined` deletes the key); undefined when nothing differs. */
function rosterRowPatch(prev: DaemonEntry, row: DaemonEntry): Partial<DaemonEntry> | undefined {
	const patch: Record<string, unknown> = {};
	let changed = false;
	const before = prev as unknown as Record<string, unknown>;
	const after = row as unknown as Record<string, unknown>;
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (sameRosterField(before[key], after[key])) continue;
		patch[key] = after[key];
		changed = true;
	}
	return changed ? (patch as Partial<DaemonEntry>) : undefined;
}

/**
 * Replace the roster with `next` while every surviving daemonId keeps its
 * store object (same proxy, only changed fields notify), so keyed <For>
 * consumers (sidebar rows) stay mounted across roster frames. Rows with new
 * ids adopt the frame's object into the store; removed ids drop out; the
 * array is only replaced when membership or order changed.
 *
 * Hand-rolled instead of solid's `reconcile`: the SSR store build the tests
 * run on implements `reconcile` as an index-wise merge (no keying, holes on
 * shrink), so identity could neither be guaranteed nor tested there.
 */
function applyRoster(next: readonly DaemonEntry[]): void {
	const current = unwrap(state.daemonRoster);
	const before = new Map(current.map((d) => [d.daemonId, d]));
	batch(() => {
		const rows = next.map((row) => {
			const prev = before.get(row.daemonId);
			if (prev === undefined || prev === row) return row;
			const patch = rosterRowPatch(prev, row);
			if (patch !== undefined) {
				setState("daemonRoster", (d) => d.daemonId === row.daemonId, patch);
			}
			return prev;
		});
		if (rows.length !== current.length || rows.some((r, i) => r !== current[i])) {
			setState("daemonRoster", rows);
		}
	});
}

/** Sort rank of a checkout row: main checkout, worktree, then clone. */
function checkoutRank(d: DaemonEntry): number {
	if (d.workspaceKind === "clone") return 2;
	if (d.workspaceKind === "worktree" || d.worktreeOf !== undefined) return 1;
	return 0;
}

export function daemonsByProject(): { project: RegisteredProject; daemons: DaemonEntry[] }[] {
	const groups = state.registeredProjects.map((project) => ({
		project,
		daemons: [] as DaemonEntry[],
	}));
	const byProjectId = new Map(state.registeredProjects.map((p, i) => [p.projectId, i]));
	for (const d of state.daemonRoster) {
		const index = d.projectId !== undefined ? byProjectId.get(d.projectId) : undefined;
		if (index !== undefined) groups[index].daemons.push(d);
	}
	for (const g of groups) {
		g.daemons.sort((a, b) => {
			const rank = checkoutRank(a) - checkoutRank(b);
			if (rank !== 0) return rank;
			if (checkoutRank(a) === 1) return (a.branch ?? "").localeCompare(b.branch ?? "");
			return 0;
		});
	}
	return groups;
}

/** Roster statuses that mean the daemon is definitively not serving a
 *  session: the attached chat column must yield to the empty pane. */
const DEAD_DAEMON_STATUSES = new Set<DaemonStatus>(["asleep", "error"]);

/** True when the roster entry is missing or its status is terminal-dead.
 *  Transitional statuses ("connecting"/"session"/"resolving") and "ready"
 *  are NEVER dead; a waking daemon passes through them. */
export function isDaemonDead(entry: DaemonEntry | undefined): boolean {
	return entry === undefined || DEAD_DAEMON_STATUSES.has(entry.status);
}

/** Transport state for the header strip and the session-bound action gate:
 *  the /events stream is up (connected); the stream is retrying, or the
 *  attached daemon is re-dialing (reconnecting); the attached session process
 *  is gone (offline). Session-bound actions run only when connected. */
export type ConnectionState = "connected" | "reconnecting" | "offline";

export function connectionState(): ConnectionState {
	if (!state.connected) return "reconnecting";
	if (state.sessionDownId !== "") return "offline";
	if (state.attachedReconnecting) return "reconnecting";
	return "connected";
}

/** Re-dials shorter than this never reach the strip: a renewal is routine. */
const RECONNECT_GRACE_MS = 1500;
let reconnectGraceTimer: ReturnType<typeof setTimeout> | undefined;

/** Track the attached daemon's "reconnecting" status through the grace window. */
function syncAttachedReconnecting(): void {
	const current = state.daemonRoster.find((d) => d.daemonId === state.currentSessionId);
	if (current?.status !== "reconnecting") {
		clearTimeout(reconnectGraceTimer);
		reconnectGraceTimer = undefined;
		if (state.attachedReconnecting) setState("attachedReconnecting", false);
		return;
	}
	if (state.attachedReconnecting || reconnectGraceTimer !== undefined) return;
	reconnectGraceTimer = setTimeout(() => {
		reconnectGraceTimer = undefined;
		const still = state.daemonRoster.find((d) => d.daemonId === state.currentSessionId);
		if (still?.status === "reconnecting") setState("attachedReconnecting", true);
	}, RECONNECT_GRACE_MS);
}

/** True when this tab has a live attached session to render. The attached
 *  roster entry must exist and not be dead; a daemon with an attach in
 *  flight counts as live (the roster lags a wake). */
export function hasLiveSession(): boolean {
	if (state.currentSessionId === "") return false;
	const entry = state.daemonRoster.find((d) => d.daemonId === state.currentSessionId);
	if (!isDaemonDead(entry)) return true;
	// A user stop keeps the transcript behind the stopped strip (App.tsx); a removed entry still clears.
	if (entry !== undefined && isUserStopped(state.currentSessionId)) return true;
	return pendingAttachTarget() === state.currentSessionId;
}

/** True while the transcript is waking, attaching or showing a failed switch: the
 *  old session may still be attached underneath, so nothing may be sent to it. */
export function isSwitching(): boolean {
	const phase = state.transcriptPhase;
	return phase === "waking" || phase === "attaching" || phase === "failed";
}

/** Apply one `roster` / `roster_delta` frame to the fleet roster and reconcile the attached session against it. */
export function applyRosterFrame(
	frame: Extract<ServerFrame, { type: "roster" | "roster_delta" }>,
): void {
	// A delta patches the current roster; the reconciliation below runs on
	// the full list either way, so both frames settle identically. The
	// store applies it with a keyed reconcile (below), so rows keep identity.
	const daemons = frame.type === "roster" ? frame.daemons : mergeRosterDelta(frame);
	// finding #P1: diff the replacement roster against what we had.
	// First sighting is boot priming (silent); later transitions to
	// ready/error announce.
	const rosterBefore = state.daemonRoster;
	for (const entry of daemons) {
		announceDaemonStatus(
			rosterBefore.find((d) => d.daemonId === entry.daemonId),
			entry.name,
			entry.status,
		);
	}
	// The fleet edge's daemon roster (sidebar swaps to the session
	// list).
	// Phase 5: entries carry projectId (project-first grouping and
	// linked-worktree eligibility). DaemonEntry owns those fields, so they
	// flow through wholesale with the list.
	// Surviving daemonIds keep their store object (fields patched, absent
	// ones deleted), so keyed rows stay mounted across roster frames.
	switchAwayFromRemoved(daemons);
	idleBeforeSessionDies(daemons.find((d) => d.daemonId === state.currentSessionId));
	applyRoster(daemons);
	if (!state.rosterLoaded) setState("rosterLoaded", true);
	settleProjectWakes();
	resumeRestartedDaemons(daemons);
	// Removed daemons never reuse ids, but don't let the set grow unbounded.
	pruneUnread(new Set(daemons.map((d) => d.daemonId)));
	// Same for daemonActivity: drop entries whose id left the roster.
	// setState MERGES plain-object values, so a shrunken record would
	// never delete keys. Reconcile diffs to the pruned record instead.
	// Skip it when nothing dropped (no useless store notification).
	{
		const kept = new Set(daemons.map((d) => d.daemonId));
		const current = state.daemonActivity;
		let dropped = false;
		const next: Record<string, { streaming: boolean; blocked: boolean }> = {};
		for (const id of Object.keys(current)) {
			if (kept.has(id)) next[id] = current[id]!;
			else dropped = true;
		}
		if (dropped) setState("daemonActivity", reconcile(next));
	}
	// Persisted user-stop marks are confirmed (or dropped) against the roster first.
	reconcileUserStopped(daemons);
	// Roster truth wins over the attached chat: if the daemon we were
	// attached to vanished or went asleep, drop the session view (the
	// roster itself is fleet-scoped and survives).
	reconcileAttachedSession();
	pushDebug(
		"info",
		"roster",
		`roster frame: ${daemons.length} session process${daemons.length === 1 ? "" : "es"}`,
	);
}

/** Per-session UI state dropped when attaching to a different session. */
function resetSessionView(): void {
	setState("review", resetReviewState(state.review));
	resetBrowserUiRequests();
	setState({
		// Unknown until the new daemon's state frame lands; deep-link URL sync relies on it.
		sessionId: "",
		sessionScope: undefined,
		capabilities: {},
		integrations: createIntegrationState(),
		resume: createResumeState(),
		compaction: createCompactionState(),
		workers: createWorkersState(),
		browserUi: createBrowserUiState(),
	});
	clearPendingDeltas();
	// Same rationale as loadHistory: ids must not collide across transcripts.
	resetChatIds();
	setState({
		modelSynced: false,
		items: [],
		live: { active: false, blocks: [], rev: 0 },
		subagents: new Map<string, SubagentInfo>(),
		stats: null,
		...createGoalState(),
		retryInfo: null,
		workingIntent: undefined,
		modal: null,
		// Phase 5: picker context dies with the modal it belongs to; the
		// component also clears it on close/new-session.
		sessionPickerGate: null,
		loginUrl: null,
		loginCodeRequest: null,
		uiRequest: null,
		btw: createBtwState(),
		lightboxImage: null,
	});
}

/** Roster truth wins over the attached chat column: after a roster or
 *  daemon_status update, if the daemon we are attached to is missing or
 *  terminal-dead (asleep/error), drop the session view. Only asleep/error mark the
 *  session down (`sessionDownId`, the offline strip with Restart); a removed entry
 *  just clears the view to the no-session pane, after switchAwayFromRemoved had its
 *  chance to move to a neighbour. The roster itself is fleet-scoped and survives. Race guard: the clear MUST NOT fire while
 *  an attach to that daemon is in flight, since a freshly waking daemon reads
 *  as "asleep" in lagging roster frames right after wake-attach; the entry and
 *  in-flight state are re-checked against the POST-frame roster here. */
function reconcileAttachedSession(): void {
	syncAttachedReconnecting();
	const downId = state.sessionDownId;
	if (downId !== "" && !isDaemonDead(state.daemonRoster.find((d) => d.daemonId === downId)))
		setState("sessionDownId", "");
	const id = state.currentSessionId;
	if (id === "") return;
	if (pendingAttachTarget() === id) return;
	const entry = state.daemonRoster.find((d) => d.daemonId === id);
	if (!isDaemonDead(entry)) return;
	// A removed entry is not a stop: drop its mark; the view clears without going offline.
	if (entry === undefined) clearUserStopped(id);
	// A user stop keeps the transcript behind the stopped strip; only readiness drops.
	else if (isUserStopped(id)) {
		setState("readyAt", undefined);
		return;
	}
	// Phase first: the transcript view is still mounted and reads it to fade
	// the session out before the writes below empty it. A switch in flight to
	// another daemon owns the phase (and still hides the old content).
	if (state.transcriptTarget === null)
		setState({ transcriptPhase: "idle", transcriptError: null, transcriptTarget: null });
	if (entry !== undefined) setState("sessionDownId", id);
	setState("currentSessionId", "");
	setState("readyAt", undefined);
	resetSessionView();
	pushDebug(
		"info",
		"roster",
		`attached session process ${id.slice(0, 8)} is gone or asleep; session cleared`,
	);
}

let backoff = 1000;

/** Wire the browser-auth module into the store: mirror snapshots into the
 *  state fields and open the sign-in modal on signedOut. The module's own
 *  statuses ('unknown' | 'signedOut' | 'signedIn') map 1:1; the 'disabled'
 *  state is the STATE layer's addition (the auth module has no server-side
 *  auth to probe when /auth/session answers 404; see bootAuth). */
export function initAuth(): () => void {
	const unsubscribe = subscribeAuth((snap: AuthSnapshot) => {
		setState("authStatus", snap.status);
		setState("authExpiresAt", snap.expiresAt);
		if (snap.status === "signedOut") setState("modal", "sign-in");
	});
	return unsubscribe;
}

/** Boot-time probe. checkSession() answers 401 → the server HAS auth and the
 *  module moves to signedOut (modal opens); a 404 (no /auth/session route on
 *  the server) → auth is disabled: the state layer marks 'disabled' and every
 *  existing path keeps behaving exactly as before. */
export function bootAuth(): void {
	void checkSession().catch((err: unknown) => {
		const status = (err as { status?: number })?.status ?? 0;
		if (status === 404) {
			setState("authStatus", "disabled");
		} else {
			pushDebug(
				"error",
				"transport",
				`auth session probe failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}
/** The roster frame `next` is about to remove the attached daemon: open the nearest
 *  ACTIVE session before it in the sidebar order (`daemonsByProject`: groups, then
 *  rows), else the nearest after it. Active = `ready` or `reconnecting` (a live pair
 *  re-dialing) in `next`, so opening it is a plain attach: a session is never woken
 *  here. Skipped: asleep, error and transitional rows, rows of a missing project
 *  (WorkspaceRow `blocked`: the row cannot be opened), rows pending delete (they may
 *  be the next to vanish), and rows that vanish in this very frame (absent from
 *  `next`). With none, the view clears to the no-session state with no offline strip
 *  (reconcileAttachedSession). Must run BEFORE the roster write: the order is read
 *  from the pre-removal roster, and the switch's phase write keeps the transcript
 *  pane mounted so the removed session fades out. A user switch already in flight
 *  (phase target or pending attach) wins. */
function switchAwayFromRemoved(next: readonly DaemonEntry[]): void {
	const id = state.currentSessionId;
	if (id === "" || next.some((d) => d.daemonId === id)) return;
	if (state.transcriptTarget !== null || pendingAttachTarget() !== null) return;
	const rows = daemonsByProject().flatMap((g) =>
		g.daemons.map((d) => ({ id: d.daemonId, projectMissing: g.project.missing === true })),
	);
	const at = rows.findIndex((r) => r.id === id);
	if (at === -1) return;
	const byId = new Map(next.map((d) => [d.daemonId, d]));
	const active = (r: { id: string; projectMissing: boolean }): boolean => {
		const status = byId.get(r.id)?.status;
		return (
			(status === "ready" || status === "reconnecting") &&
			!r.projectMissing &&
			!deletePendingIds().has(r.id)
		);
	};
	const target = rows.slice(0, at).reverse().find(active) ?? rows.slice(at + 1).find(active);
	if (target !== undefined) void switchToDaemon(target.id);
}

/** The roster is about to say the attached daemon is gone or dead (`next` is its entry
 *  after the frame): the chat pane unmounts as soon as hasLiveSession() flips, i.e. with
 *  the roster write itself, so the phase must already be idle by then for the
 *  transcript to fade the session out. reconcileAttachedSession clears the session
 *  right after. A switch in flight owns the phase and is left alone. */
function idleBeforeSessionDies(next: DaemonEntry | undefined): void {
	const id = state.currentSessionId;
	if (id === "" || state.transcriptTarget !== null || pendingAttachTarget() === id) return;
	if (!isDaemonDead(next) || (next !== undefined && isUserStopped(id))) return;
	setState({ transcriptPhase: "idle", transcriptError: null, transcriptTarget: null });
}

export function connect(): void {
	// Browser-only transport: without EventSource there is nothing to dial.
	// (A bun test worker has neither EventSource nor location; a silence
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
		// No boot-time calls: the fleet edge answers every call with "not
		// attached" until the browser picks a daemon. The attached handler
		// pulls getSubagents. On a RECONNECT the edge has no attach
		// memory, so re-attach to the daemon we were viewing.
		if (state.currentSessionId) void attachSession(state.currentSessionId).catch(() => {});
		else refreshSettings(); // boot with no session: the fleet /ctl model backs the panel
	};
	source.addEventListener(SSE_EVENT_NAME, (ev) => {
		armSilenceTimer(); // any downlink activity means the peer is alive
		setState("lastFrameAt", Date.now());
		const frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame;
		if (frame.type === "attached") {
			pushDebug("info", "transport", `attached ${frame.sessionId}`);
			const switched = state.currentSessionId !== "" && state.currentSessionId !== frame.sessionId;
			// Capture the previous session BEFORE the switch overwrites the id:
			// state.streaming still reflects the prior session here (it is only
			// overwritten by the next state frame; resetSessionView never touches
			// it). Switching away MID-STREAM means the abandoned turn's end will
			// never be observed on this tab (the edge streams live frames only for
			// the attached daemon), so mark it unread. Attaching the target renders
			// it read.
			const prevSessionId = state.currentSessionId;
			const prevStreaming = state.streaming;
			setState("currentSessionId", frame.sessionId);
			setState("sessionDownId", "");
			if (prevSessionId !== "" && prevSessionId !== frame.sessionId && prevStreaming)
				markUnread(prevSessionId);
			clearUnread(frame.sessionId);
			// Every attach re-primes history from scratch: drop any in-flight
			// chunked-series accumulation from the previous attach/session.
			pendingHistory = null;
			// A fresh priming series starts; the replay-dedup window resets
			// (seqs restart per connection, see seenFrameSeqs).
			seenFrameSeqs.clear();
			// Every attach starts a new attachment generation on the session side,
			// even a re-attach of the SAME daemon (wake after a UI stop keeps the
			// view, so it is not a switch). The scope of the previous generation
			// would make the on-attach calls below fail the session's stale-scope
			// check; drop it so they go out unscoped (the session accepts calls
			// without a scope) until the attachment's first `state` frame
			// re-stamps it via applyState.
			setState("sessionScope", undefined);
			// Finding #28: the attach waiter settles from the edge's id-keyed
			// attach_result, never from this PROXIED frame; the priming rides
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
				// (the onboarding attach to the gate's own daemon is a switch too,
				// but that one is kept so the sessions answer can still open the
				// picker, per the attach_result → list_sessions → sessions order).
				if (state.pendingSessionPicker !== null && state.pendingSessionPicker !== frame.sessionId) {
					setState("pendingSessionPicker", null);
				}
			}
			// Subagent mirror is per-session; pull on EVERY attach (first attach,
			// switch, roster re-attach after reconnect). Calls are answered only
			// once attached, so this is the earliest safe point.
			// Calls parked on "not attached" while the tab was detached go out again
			// now, under their own ids (see retryNotAttachedCalls in store/transport).
			retryNotAttachedCalls();
			void call("getSubagents")
				.then((subs) => {
					const next = new Map<string, SubagentInfo>();
					for (const s of subs as SubagentInfo[]) if (s.id) next.set(s.id, s);
					setState("subagents", next);
				})
				.catch(() => {});
			// The worker roster is a separate read model: pull it on attach too, so
			// parked and idle workers reappear without waiting for a lifecycle frame.
			requestRosterRefresh();
			refreshSettings();
			// Watchers for this attachment (watchAttachment) wait for its first `state` frame.
			settleAttachedFrame(frame.sessionId);
			return;
		}
		// Stale-frame guard: session-scoped frames for a handle this tab no
		// longer views (in flight during a switch) are dropped. Frames WITHOUT
		// a sessionId (fleet-scoped roster and daemon frames; a daemon with one
		// live session stamps everything it sends) always pass; there is
		// nothing to mismatch. attach_result is a unicast
		// answer whose sessionId is the ATTACHED daemonId (finding #28) and must
		// pass too, since id-matching against pendingAttach handles staleness.
		if (
			frame.type !== "attach_result" &&
			"sessionId" in frame &&
			frame.sessionId !== state.currentSessionId
		)
			return;
		// Replay-dedup guard (finding #2): a delta live-delivered during the
		// paced prime is re-sent verbatim by the ring replay. Its seq was seen
		// on this connection already, so the second copy is the replay; drop
		// it (see seenFrameSeqs; native EventSource exposes the SSE id as
		// MessageEvent.lastEventId, absent for ping/undecorated frames).
		const frameSeq = Number((ev as MessageEvent).lastEventId);
		if (Number.isFinite(frameSeq) && frameSeq > 0 && seenFrameSeqs.has(frameSeq)) return;
		switch (frame.type) {
			case "history": {
				// A transcript over the SSE backpressure cap primes as
				// sequential frames (final: false … final: true); a frame
				// WITHOUT `final` (the original single-frame shape) is complete
				// on its own. Reassemble before loadHistory; it rebuilds items
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
				// The attachment's scope is set: decide the parked mutations.
				resumeParkedMutations(state.sessionScope);
				// Watchers whose `attached` frame landed post after the scope is set.
				settleAttachmentState();
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
			case "command_echo":
				pushNotice("echo", frame.text);
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
				applyBtwEphemeralDelta(state.btw, frame, pendingEphemeral, scheduleFlush);
				break;
			}
			case "call_result":
				settleCallResult(frame);
				break;
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
				// Phase 5: post-attach picker gate; the answer to the gate's
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
						void startNewSession().catch(reportError);
					}
				}
				break;
			case "daemon_sessions":
				// Unicast answer to the roster dropdown's list_daemon_sessions
				// (fleet-scoped: settle keyed by daemonId, no session guards).
				settleDaemonSessions(frame.daemonId, frame.sessions);
				break;
			case "daemons":
				setState(
					"daemons",
					new Map(
						((frame.daemons as DaemonInfo[] | undefined) ?? []).map((d) => [daemonsKey(d), d]),
					),
				);
				break;
			case "roster":
			case "roster_delta":
				applyRosterFrame(frame);
				break;
			case "daemon_activity": {
				// Edge-generated, fleet-scoped realtime activity for ANY ready daemon.
				// It carries no sessionId, so it sails past the stale-frame guard above
				// untouched (per-daemon, not per-attachment) and applies regardless of
				// which daemon this tab is attached to.
				// Snapshot the boolean BEFORE setState: state.daemonActivity[...] is a
				// live store proxy, so reading prev.streaming after the set would see
				// the NEW value and the completion edge would never fire.
				const wasStreaming = state.daemonActivity[frame.daemonId]?.streaming === true;
				setState("daemonActivity", frame.daemonId, {
					streaming: frame.streaming,
					blocked: frame.blocked,
				});
				// Unread-on-completion: a detached turn's END is now observable in
				// realtime. This is the original unread semantic (in_progress → idle
				// while unfocused) that the old switch-away-only mark could not cover.
				// Skip the attached daemon (its live signals are on-screen anyway). The
				// switch-away-mid-stream mark in the `attached` handler stays as
				// belt-and-suspenders for edges/old fleets that never send this frame;
				// the precedence in session-activity hides it while the daemon still
				// streams (remote live truth beats the unread latch).
				if (wasStreaming && !frame.streaming && frame.daemonId !== state.currentSessionId) {
					markUnread(frame.daemonId);
					// Chat-dot: the turn ended while this tab sits in Analysis;
					// setView("chat") clears it.
					if (state.view === "analysis") setState("chatUnviewed", true);
				}
				break;
			}
			case "daemon_status": {
				// finding #P1: announce the transition to a terminal rung
				// (ready/error) before patching the entry.
				const daemonBefore = state.daemonRoster.find((d) => d.daemonId === frame.daemonId);
				announceDaemonStatus(daemonBefore, daemonBefore?.name ?? frame.daemonId, frame.status);
				if (frame.daemonId === state.currentSessionId)
					idleBeforeSessionDies(daemonBefore && { ...daemonBefore, status: frame.status });
				// Path-patch only the matching entry: its store object keeps identity and
				// only status/error notify. Setting `error: undefined` deletes the field,
				// so it clears unless the frame carries a fresh one.
				setState("daemonRoster", (d) => d.daemonId === frame.daemonId, {
					status: frame.status,
					error: frame.error,
				});
				settleProjectWakes();
				pushDebug(
					frame.status === "error" || frame.error !== undefined ? "error" : "info",
					"roster",
					`session process ${frame.daemonId.slice(0, 8)} → ${frame.status}${frame.error !== undefined ? `: ${frame.error}` : ""}`,
				);
				// Same reconcile as the roster frame: the attached daemon just
				// went asleep/error, so clear the session view (race-guarded).
				reconcileAttachedSession();
				break;
			}
			case "add_project_result":
				settleAddProject(frame);
				break;
			case "workspace_create_result":
				settleWorkspaceCreate(frame);
				break;
			case "project_branches":
				// Unicast answer to list_project_branches. Settled latest-wins by
				// projectId and remote (the frame carries no command id).
				settleProjectBranches(frame);
				break;
			case "registered_projects":
				// Phase 5: first-class project registry broadcast (fleet-scoped
				// like the roster; it survives session resets, and zero-daemon
				// projects still render via daemonsByProject).
				setState("registeredProjects", frame.projects);
				// Secret-free provider profile catalog rides the same
				// frame (additive; older edges omit it, so missing = []).
				setState("providerProfiles", frame.providerProfiles ?? []);
				// Phase 4: the resolved fleet config path rides the same frame
				// (additive; older edges omit it, so missing = null). Also
				// fleet-scoped: resetSessionView must not wipe it.
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
				// evicted its daemon, so each eviction yields one toast plus an
				// aria-live announcement (same text, reusing the finding #P1
				// announce helper). Broadcast, fleet-edge-only like
				// registered_projects: no session guard (a bare omp-session
				// never sends it), and UI-initiated delete_worktree/remove never
				// produce this frame.
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
					pending.reject(new Error(frame.error ?? "session process logs failed"));
				}
				break;
			}
			case "daemon_control_result": {
				const pending = pendingDaemonControl.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingDaemonControl.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok && frame.daemon) pending.resolve(frame.daemon);
				else pending.reject(new Error(frame.error ?? "session process control failed"));
				break;
			}
			case "files":
				settleFiles(frame.files);
				break;
			case "subagent_lifecycle": {
				const payload = frame.payload;
				setState("subagents", (prev) => applyLifecycleFrame(prev, payload, Date.now()));
				// Parked and revivable state lives in the daemon roster: refetch it on lifecycle edges (SUB-10).
				requestRosterRefresh();
				break;
			}
			case "subagent_progress": {
				const payload = frame.payload;
				setState("subagents", (prev) => applyProgressFrame(prev, payload, Date.now()));
				break;
			}
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
				if (frame.method === "browser_ui") receiveBrowserUiRequest(frame);
				else {
					if (state.uiRequest) {
						console.warn(`ui_request ${frame.id} superseding unanswered ${state.uiRequest.id}`);
						cancelUiRequest(state.uiRequest.id);
					}
					setState("uiRequest", { id: frame.id, method: frame.method, params: frame.params });
					// Ask-tool dialogs notify where the SDK does (tools/ask.ts #sendAskNotification).
					if (frame.method === "askDialog") notifyDesktop("ask", "omp", "Waiting for input");
				}
				break;
			case "ui_request_end":
				// Finding #16: the dialog settled (answered/rejected). Dismiss
				// it if it's the one shown; the ring replay delivers this
				// AFTER a stale ui_request on resume, so an answered dialog
				// never reappears as a hanging modal. The frame carries no
				// method field, so browser_ui contributions always dismiss here
				// alongside the ask dialog.
				endBrowserUiRequest(frame.id);
				if (state.uiRequest?.id === frame.id) {
					if (frame.answeredBy) pushNotice("info", `Question answered by ${frame.answeredBy}`);
					setState("uiRequest", null);
				}
				break;
			case "settings_changed": {
				// Session-scoped broadcast: a fresh model after any setSetting,
				// so every attached tab's panel stays in sync.
				const model = (frame as { model: SettingsModel }).model;
				applySettingsModel(model);
				break;
			}
			case "collab_status":
				setState("collabStatus", frame.status);
				break;
			case "error":
				// Finding #28: an error frame is a GLOBAL uncorrelated broadcast
				// (fire-and-forget spawn failures, a lost pipe for ANOTHER
				// daemon, "not attached" answers). It must never settle an
				// in-flight attach. Attach failures arrive as id-keyed
				// attach_result frames; global errors only display.
				setState("error", frame.error);
				pushDebug("error", "transport", `error frame: ${frame.error}`);
				break;
			case "hello_ok":
				// Finding #61: the browser enforces OMP_PROTO too. A bare
				// session daemon leads its priming with hello_ok; the fleet edge
				// forwards the (pipe-gated) hello_ok. A mismatch is terminal;
				// fail closed: surface the
				// error, tear the stream down, and do NOT schedule the
				// reconnect (the backoff loop in onerror would otherwise hot-loop
				// against an undrivable daemon).
				if (frame.proto !== OMP_PROTO) {
					setState(
						"error",
						`proto mismatch: session process speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
					);
					pushDebug(
						"error",
						"transport",
						`proto mismatch: session process speaks ${String(frame.proto)}, expected ${OMP_PROTO}`,
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
		// with the same 1s→8s backoff, since auth failures must not hot-loop.
		if (source.readyState !== EventSource.CLOSED) {
			pushDebug("info", "transport", "transient blip, native auto-reconnect");
			return; // transient blip: native auto-reconnect resumes with Last-Event-ID
		}
		teardownStream(source); // no-op if a newer connect() superseded this stream
		const delay = backoff;
		backoff = Math.min(backoff * 2, 8000);
		setState("reconnectDelay", delay);
		pushDebug("warn", "transport", `connection lost, retrying in ${delay}ms`);
		setTimeout(connect, delay);
	};
}

// ---------------------------------------------------------------------------
// Facade (Phase 3 store facade split): every action the original state.ts
// exported is re-exported here so call sites (components, tests) keep
// importing from "../state" byte-identical. Types and the store stay defined
// above; the actions live in apps/web/store/<domain>.ts.
// ---------------------------------------------------------------------------
export { isReady, isSessionChanging } from "./store/session";
export {
	argsSummary,
	truncateHead,
	setNotifyEnabled,
	toggleToolsExpanded,
	pushNotice,
	pushCompaction,
	addBashItem,
	resolveBashItem,
	dequeueLastQueued,
	stopTurn,
	resumeQueuedMessages,
	editQueuedMessage,
	deleteQueuedMessage,
	runQueuedMessageNow,
	deleteQueuedCommand,
	runQueuedCommandNow,
	promptInsert,
	setPromptInsert,
	promptFocusRequest,
	setPromptFocusRequest,
	startNewSession,
} from "./store/chat";
export {
	listSessions,
	listFiles,
	requestDaemonSessions,
	resumeDaemonSession,
	setSidebarVisible,
	closeDrawers,
	startDaemonNewSession,
	switchToDaemon,
	wakeAndAttach,
	setTxSidebarVisible,
	setView,
	toggleSidebar,
} from "./store/roster";
export {
	listProjectBranches,
	restartDaemonById,
	spawnResume,
	stopDaemonById,
	removeDaemonById,
	addProject,
	sendRemoveProject,
	createWorktree,
	createClone,
	syncProjects,
	openNewWorkspace,
	closeNewWorkspace,
	highlightProject,
	sendDeleteWorktree,
	sendWorktreeDeleteInfo,
	fetchCloneIntoProject,
} from "./store/projects";
export {
	closeDaemonDetails,
	closeLightbox,
	openDaemonDetails,
	openLightbox,
	sendLoginCode,
	sendUiResponse,
} from "./store/modals";
export { checkSession, signIn, signOut } from "./store/auth";
export { isUserStopped } from "./store/user-stopped";
export { refreshSettings, updateSetting } from "./store/settings";
export { refreshUsageReports, setSidebarUsage } from "./store/usage";
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
export { dismissToast, pushToast } from "./store/toasts";
export { announce, appendBashChunk, applyEvent, cancelUiRequest, attachSession, call, clientId };
