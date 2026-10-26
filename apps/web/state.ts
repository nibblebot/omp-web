import type { BackgroundJob } from "./chat/background-job";
import { reconcileBackgroundCards } from "./store/background-cards";
import { type ActivitiesSlice, createActivitiesState } from "./store/slices/activities";
import { restoreDockLayout } from "./store/dock";
import { readDockWidth } from "./prefs/dock";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AdvisorItem } from "./store/slices/advisor";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { TextAttachment } from "./prompt/attachments";
import { batch } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import {
	OMP_PROTO,
	CLIENT_SILENCE_DEADLINE_MS,
	daemonsKey,
	isSessionScopedFrameType,
} from "#lib/wire/protocol";
import type {
	AvailableSlashCommand,
	RosterEntry,
	DaemonInfo,
	SessionStatus,
	ImageArg,
	ModelBrowserEntry,
	PublicProviderProfile,
	RegisteredProject,
	ServerFrame,
	SettingsModel,
	WebSessionState,
	WireToolLive,
} from "#lib/wire/protocol";
import {
	browserCloseFromCode,
	browserSocketUrl,
	parseServerMessage,
	reconnectDelayMs,
} from "#lib/wire/browser-socket";
import { featurePreferences } from "./features/preferences";
import { clearUnread, markUnread, pruneUnread } from "./fleet-ui/unread";
import type { UsageLike } from "./usage/usage";
import { createHistoryBuilder } from "./chat/history-items";
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
} from "./store/chat";
import { cancelUiRequest } from "./store/modals";
import {
	resetPendingProjects,
	deletePendingIds,
	resumeRestartedSessions,
	settleAddProject,
	settleProjectBranches,
	settleWorkspaceCreate,
} from "./store/projects";
import { clearUserStopped, isUserStopped, reconcileUserStopped } from "./store/user-stopped";
import {
	checkSession,
	expireSession,
	subscribeAuth,
	type AuthStatus,
	type AuthSnapshot,
} from "./store/auth";
import { applySettingsModel, refreshSettings } from "./store/settings";
import {
	resetPendingSessionsFiles,
	settleWorkspaceSessions,
	settleFiles,
	settleProjectWakes,
	settleSessions,
	switchToSession,
} from "./store/roster";
import { dismissToast, pushToast, type ToastAction } from "./store/toasts";
import { parseRoute } from "./store/route";
import {
	attachSession,
	call,
	clientId,
	pendingAttachTarget,
	pushDebug,
	rejectPendingAttach,
	rejectPendingCalls,
	rejectPendingDaemons,
	resumeParkedMutations,
	retryNotAttachedCalls,
	settleAttachedFrame,
	setConnected,
	acknowledgeCommand,
	refuseCommand,
	rejectOutbound,
	resendUnsettled,
	resetUplink,
	setUplink,
	settleAttachResult,
	settleDaemonControl,
	settleDaemonLogs,
	settleAttachmentState,
	settleCallResult,
} from "./store/transport";
import { createReviewState, resetReviewState } from "./store/slices/review";
import { applyBtwEphemeralDelta, createBtwState } from "./store/slices/btw";
import { createGoalState } from "./store/slices/goals";
import { createIntegrationState, skillsPatch } from "./store/slices/integrations";
import { createResumeState } from "./store/resume";
import { createCompactionState } from "./store/compaction";
import { createWorkersState, requestRosterRefresh } from "./store/subagents";
import { applyLifecycleFrame, applyProgressFrame } from "./store/subagent-frames";
import { applyJobWidgets, clearJobWidgets } from "./store/job-widgets";
import { createJobWidgetsState } from "./store/slices/job-widgets";
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
export type ToolStatus = "running" | "done" | "error" | "interrupted";
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
			/** Epoch ms the session stamped at message_end; the usage row's turn stamp and display.showTurnTime anchor. */
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
			/** Live status of a running eval/wait call (frame `live`), with the arrival time so clocks can advance; dropped once the call settles. */
			live?: WireToolLive & { at: number };
			/** The background job a returned bash/eval/task call stays parked on (chat/background-job.ts); absent for every other call. */
			background?: BackgroundJob;
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
	// Worktree session list (chevron on a roster row): the
	// session it lists comes from state.worktreeSessionsId.
	| "worktree-sessions"
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

/** localStorage key for the roster-sidebar session-title line count ("1" or "2"). */
export const SIDEBAR_TITLE_LINES_KEY = "omp.sidebarSessionTitleLines";

/** localStorage key for the title-first roster row layout ("true" when on). */
export const SIDEBAR_TITLE_FIRST_KEY = "omp.sidebarTitleFirst";

/** localStorage key for the roster-sidebar "running only" filter ("true" when on). */
export const SIDEBAR_RUNNING_ONLY_KEY = "omp.sidebarRunningOnly";

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
	// into Analysis; session routes (#/w/<workspaceId>[/s/<sessionId>]) boot into
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
	currentWorkspaceId: "",
	// What the transcript pane is doing for a session switch (C3). `waking` /
	// `attaching` / `failed` are written only by the switch in store/roster.ts
	// (switchToSession and the paths that share it), `loaded` only by loadHistory,
	// `idle` when no session is selected. The boot session is always "" (a
	// remembered route attaches through the switch once the roster lands).
	transcriptPhase: "idle" as TranscriptPhase,
	// Why the switch failed; null unless `transcriptPhase` is `failed`.
	transcriptError: null as string | null,
	// The session the in-flight (or failed) switch targets; null when the pane is
	// loaded/idle, and for a re-attach of the attached session (no transition).
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
	// The attached session's running background jobs and their widget glances (`job_widgets` frames); see store/job-widgets.ts.
	jobWidgets: createJobWidgetsState(),
	connected: false,
	// True from page load until the first browser socket opens (or the
	// startup grace in connect() runs out): the strip stays hidden meanwhile,
	// since nothing has dropped yet.
	transportStartup: true,
	// The server speaks another OMP_PROTO (hello_ok or a 4426 close): the socket
	// stays down for good and the strip asks for a reload instead of reconnecting.
	protoMismatch: false,
	// Browser-auth state: mirrored from apps/web/store/auth.ts by
	// subscribeAuth. "unknown" until the first session probe; "disabled"
	// (fleet/session without browser auth) behaves exactly as before this
	// integration. signedOut opens the sign-in modal.
	authStatus: "unknown" as "unknown" | "signedOut" | "signedIn" | "disabled",
	authExpiresAt: undefined as number | undefined,
	modal: null as ModalName | null,
	// Right-hand dock (U18): which panel is open, null when closed. Written only
	// through store/dock.ts (openDock/closeDock) and store/activities.ts; the
	// route mirrors it. `item` is the Activities detail item, mirrored for the URL.
	dock: null as { kind: string; item?: { type: string; id: string } } | null,
	// The attached workspace's Activities panel layout, live here and saved per
	// workspace by store/dock.ts (see store/slices/activities.ts for the shape).
	activities: createActivitiesState() as ActivitiesSlice,
	// True once the attached session's subagent forest is fully pulled (the
	// live mirror and the worker roster); false from every attach until then.
	// A saved agent id is only judged missing once both are in.
	subagentsLoaded: { mirror: false, roster: false },
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
	// workspaceId the delete-workspace confirm dialog targets (worktree guard
	// evidence or clone verified-delete).
	deleteWorkspaceTarget: null as string | null,
	// projectId the remove-project confirm targets.
	removeProjectTarget: null as string | null,
	// workspaceId whose details dialog is open (fleet-scoped: survives session
	// switches; the dialog closes itself when the roster entry disappears).
	sessionDetailsId: null as string | null,
	// workspaceId whose worktree session list dialog is open (state.modal
	// "worktree-sessions"; ModalHost closes it when the roster entry disappears).
	worktreeSessionsId: null as string | null,
	// Image shown in the full-size lightbox (session content, so
	// resetSessionView clears it).
	lightboxImage: null as ImageArg | null,
	toolsExpanded: false,
	// Daemon broker roster (hub/launch long-running processes); project-scoped,
	// so resetSessionView must NOT clear it.
	daemons: new Map<string, DaemonInfo>(),
	// True once a `daemons` frame has been applied on this page, so a consumer never judges a saved
	// daemon key missing against the empty initial roster. Fleet-scoped like `daemons`.
	daemonsLoaded: false,
	// Settings model (getSettings/setSetting + settings_changed frames).
	settingsModel: null as SettingsModel | null,
	settingsLoading: false,
	// Settings tab the next settings sheet opens on (set by "Configure providers");
	// the sheet clears it on mount. Null = the default tab.
	settingsTab: null as string | null,
	// Fleet edge roster (roster frame). Patched in place by
	// session_status frames; NOT cleared by resetSessionView (it is
	// fleet-scoped, not session-scoped). Entries carry projectId
	// (Phase 5: project-first grouping + linked-worktree eligibility).
	sessionRoster: [] as RosterEntry[],
	// True once the first roster frame landed (never reset: it survives session
	// resets and reconnects); lets the sidebar tell boot priming from a new row.
	rosterLoaded: false as boolean,
	// Per-session realtime activity (streaming / blocked) fed by the edge's
	// additive fleet-scoped `session_activity` frames (derived from each
	// session's tapped stream; primed for every known session whatever its
	// status). Survives resetSessionView / session switches
	// like sessionRoster; pruned on roster frames for ids that left the fleet.
	sessionActivity: {} as Record<string, { streaming: boolean; blocked: boolean }>,
	// Phase 5: first-class registered projects (registered_projects frame;
	// fleet-scoped like sessionRoster; it survives session resets, and
	// zero-session projects still render).
	registeredProjects: [] as RegisteredProject[],
	// Secret-free provider profile catalog (optional
	// registered_projects.providerProfiles; omitted when the fleet has none
	// → []). Fleet-scoped like registeredProjects and boot-static; a fleet
	// restart/reload re-sends it, so a session reset must not clear it.
	providerProfiles: [] as PublicProviderProfile[],
	// Phase 4: resolved fleet config path from the registered_projects frame
	// (null = defaults, no config file). Fleet-scoped like the projects
	// above; it survives session resets.
	fleetConfigPath: null as string | null,
	// Phase 5: delete-worktree guard evidence (worktree_delete_info unicast),
	// keyed by workspaceId.
	worktreeDeleteInfo: {} as Record<string, WorktreeDeleteInfo>,
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
	// Last browser socket downlink activity (any message) in ms epoch; 0 = never.
	// Drives the panel's "seconds since last frame" readout.
	lastFrameAt: 0,
	// Delay (ms) of the next scheduled manual reconnect; 0 = stream open (no
	// retry pending). Mirrors the module-level backoff ladder for the panel.
	reconnectDelay: 0,
	// The attached workspace id whose session process stopped or crashed (asleep/error:
	// the view was cleared by reconcileAttachedSession and Restart makes sense);
	// "" when nothing is down. A session REMOVED from the roster never sets it: the
	// view moves to a neighbouring session instead (see switchAwayFromRemoved).
	sessionDownId: "",
	// True once the attached session has stayed "reconnecting" past the grace
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
	// Roster rows clamp the last-session title to this many lines (persisted;
	// anything but a saved "2" reads as the one-line default).
	sidebarSessionTitleLines: (typeof localStorage !== "undefined" &&
	localStorage.getItem(SIDEBAR_TITLE_LINES_KEY) === "2"
		? 2
		: 1) as 1 | 2,
	// Roster-sidebar "running only" filter (persisted toggle): hides asleep rows.
	sidebarRunningOnly:
		typeof localStorage !== "undefined" &&
		localStorage.getItem(SIDEBAR_RUNNING_ONLY_KEY) === "true",
	// Title-first roster rows: the last session title is the primary line and
	// the branch moves down beside the diffstat (persisted; default off).
	sidebarTitleFirst:
		typeof localStorage !== "undefined" && localStorage.getItem(SIDEBAR_TITLE_FIRST_KEY) === "true",
	// Phase 12: GET /ctl/usage mirror; null means never fetched, [] means
	// fetched but no reporting. Single-flight via usageLoading (refreshUsageReports).
	usageReports: null as UsageReport[] | null,
	usageLoading: false as boolean,
	usageError: null as string | null,
	// Epoch ms the last /ctl/usage fetch settled (success or failure); null
	// before the first. Anchors the sidebar widget's auto-refresh countdown.
	usageRefreshedAt: null as number | null,
	// Phase 11: /btw side-panel session. streamId routes ephemeral_delta
	// frames to this panel; the panel never appears in the transcript.
	btw: createBtwState(),
	// finding #P1: aria-live announcement text, rendered into the always-mounted
	// role="status" region in App.tsx. announce() dedupes identical consecutive
	// text so a burst of the same transition doesn't re-announce.
	announcement: "",
	// Fleet/app-scoped ephemeral notifications (worktree_removed on-disk
	// eviction toasts); survives session resets like sessionRoster.
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

/** finding #P1: announce a session's transition to a terminal rung (ready/error).
 *  First sighting (boot priming) and repeated identical statuses are silent.
 *  Deliberately NOT gated on session readiness; the roster is fleet-scoped,
 *  so a tab with no attached session still hears its sessions come
 *  up or fall over. */
function announceSessionStatus(
	prev: RosterEntry | undefined,
	name: string,
	status: SessionStatus,
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
	setState({
		items,
		live: { active: false, blocks: [], rev: 0 },
		retryInfo: null,
		workingIntent: undefined,
		modelSynced: false,
		// A history frame of the OLD session landing while a switch to another
		// session is pending must not end that switch's wait.
		...(state.transcriptTarget === null || state.transcriptTarget === state.currentWorkspaceId
			? { transcriptPhase: "loaded" as const, transcriptError: null, transcriptTarget: null }
			: {}),
	});
	// Calls still parked on a running job learn their outcome from the session's job list.
	void reconcileBackgroundCards();
}

function applyState(s: WebSessionState, stats?: SessionStats): void {
	// Open the review sheet only on the false→true edge, so a re-broadcast does not reopen a dismissed sheet.
	// Only while the plan feature is on: its sheet is not mounted otherwise, so opening it would leave an empty modal layer.
	const reviewOpened =
		s.planReviewPending === true && !state.planReviewPending && featurePreferences().plan;
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
// Browser socket lifecycle. The dial, the open/message/close handlers and the
// frame mux live in connect() below; the teardown (any close, the silence
// deadline, a malformed message, a proto mismatch) and the reconnect ladder
// are shared here. Pending slots across every domain are settled through the
// domain modules' exported resets.
// ---------------------------------------------------------------------------

/** The one browser socket this tab holds; null while down or between dials. */
let socket: WebSocket | null = null;

/**
 * Seq of the last sequenced frame received: the next dial's `after` (null =
 * fresh priming). The last one, not the highest: a restarted server numbers
 * from scratch, and a stale high mark would skip every delta of its new epoch.
 */
let lastSeq: number | null = null;

/** Consecutive failed dials, the reconnectDelayMs attempt; a socket's first message resets it. */
let reconnectAttempt = 0;

/** Messages the current socket has delivered (0 until its first). */
let socketMessages = 0;

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** A 4401 close holds the reconnect until the sign-in succeeds (initAuth releases it). */
let awaitingSignIn = false;

/** What follows a teardown: dial at once, dial after the backoff delay, wait for a later connect(), or stop for good. */
type ReconnectPlan = "now" | "backoff" | "hold" | "never";

/** Silence deadline for the socket: any message re-arms it; a fire means the
 *  peer is dead. The socket is open but nothing is flowing (e.g. a hung
 *  middlebox), so tear down and reconnect. The server pings every
 *  CLIENT_KEEPALIVE_MS idle precisely so this browser-side consumer can
 *  observe liveness. */
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

/** (Re)arm the silence deadline from any downlink activity. */
function armSilenceTimer(): void {
	if (silenceTimer !== null) clearTimeout(silenceTimer);
	silenceTimer = setTimeout(() => {
		silenceTimer = null;
		if (socket === null) return; // already torn down / no live socket
		pushDebug("warn", "transport", "silence deadline hit, forcing reconnect");
		// Reconnect immediately (no backoff delay): the server may be
		// perfectly healthy behind a hung middlebox. If the reconnect itself
		// fails, the backoff ladder takes over.
		teardownSocket(socket, "now", 1000, "silence deadline");
	}, CLIENT_SILENCE_DEADLINE_MS);
}

function clearSilenceTimer(): void {
	if (silenceTimer !== null) {
		clearTimeout(silenceTimer);
		silenceTimer = null;
	}
}

/** Open the socket, or schedule the retry when the browser refuses the dial outright (bad URL, mixed content). */
function dialSocket(url: string): WebSocket | null {
	try {
		return new WebSocket(url);
	} catch (err) {
		pushDebug("error", "transport", `socket dial failed: ${String(err)}`);
		scheduleReconnect();
		return null;
	}
}

/** Dial again after the jittered backoff delay. */
function scheduleReconnect(): void {
	const delay = reconnectDelayMs(reconnectAttempt++);
	setState("reconnectDelay", delay);
	pushDebug("warn", "transport", `connection lost, retrying in ${delay}ms`);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
}

/**
 * Teardown for a dead socket (a close, the silence deadline, a malformed
 * message): drop readiness, close it, and settle the pending slots that cannot
 * outlive it, then follow `plan`. Calls and unacked commands survive a drop
 * that will reconnect: they are re-sent under their own ids after the next
 * open (resendUnsettled). Only a drop with no reconnect to come ("never")
 * rejects them.
 */
function teardownSocket(ws: WebSocket, plan: ReconnectPlan, code?: number, reason?: string): void {
	if (socket !== ws) return; // a newer connect() already superseded this socket
	pushDebug("info", "transport", "stream closed");
	clearSilenceTimer();
	setConnected(false);
	setUplink(null);
	socket = null;
	ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; // a late event of this socket is stale
	try {
		ws.close(code, reason);
	} catch {
		// Already closing or closed.
	}
	setState("connected", false);
	// Readiness is per-connection: the reconnecting socket's boot session
	// must clear its own gate before the composer un-gates again.
	setState("readyAt", undefined);
	if (plan === "never") {
		rejectPendingCalls(new Error("Disconnected"));
		rejectOutbound(new Error("Disconnected"));
	}
	resetPendingSessionsFiles();
	resetPendingProjects();
	rejectPendingAttach(new Error("Disconnected"));
	rejectPendingDaemons(new Error("Disconnected"));
	if (plan === "now") connect();
	else if (plan === "backoff") scheduleReconnect();
}

/** The server speaks another OMP_PROTO (a hello_ok naming it, or a 4426 close): terminal, a reload picks up the matching build. */
function failProtoMismatch(ws: WebSocket, speaks: string): void {
	const message = `proto mismatch: ${speaks}, expected ${OMP_PROTO}`;
	setState("error", message);
	setState("protoMismatch", true);
	pushDebug("error", "transport", message);
	teardownSocket(ws, "never");
}

/**
 * Close the socket and forget every resume detail: the dial history, the last
 * seq, the reconnect and startup-grace timers, the sign-in hold. The test seam
 * that gives each test a fresh page's socket state (see web.testkit.ts).
 */
export function resetBrowserSocket(): void {
	clearTimeout(reconnectTimer);
	reconnectTimer = undefined;
	clearTimeout(startupGraceTimer);
	startupGraceTimer = undefined;
	clearSilenceTimer();
	if (socket !== null) {
		const ws = socket;
		socket = null;
		ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
		try {
			ws.close();
		} catch {
			// Already closing or closed.
		}
	}
	resetUplink();
	setConnected(false);
	lastSeq = null;
	reconnectAttempt = 0;
	socketMessages = 0;
	awaitingSignIn = false;
	setState("protoMismatch", false);
}

/** The fleet roster with no session attached yet: settings go through the
 *  roster's /ctl relay until an attach lands. Once attached, settings go
 *  through the session RPC for per-session option lists and live side
 *  effects. */
export function fleetSettingsActive(): boolean {
	return state.currentWorkspaceId === "";
}

// ---------------------------------------------------------------------------
// Project-first sidebar grouping. Registered projects render in registry
// order (including zero-row projects). Each project's rows are ordered: the
// main checkout first, then worktrees by branch name, then clones (roster
// order breaks ties). Rows without a registered projectId are not shown.
// ---------------------------------------------------------------------------

/** The roster after one row-level delta: removed rows dropped, upserted rows replacing their id's row or appended in arrival order. */
function mergeRosterDelta(delta: { upserted: RosterEntry[]; removed: string[] }): RosterEntry[] {
	const removed = new Set(delta.removed);
	const next = unwrap(state.sessionRoster).filter((d) => !removed.has(d.workspaceId));
	for (const row of delta.upserted) {
		const at = next.findIndex((d) => d.workspaceId === row.workspaceId);
		if (at === -1) next.push(row);
		else next[at] = row;
	}
	return next;
}

/** Whether two row fields hold the same value; the only nested field (`git`) is small and flat, so a JSON compare is exact. */
function sameRosterField(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields of `prev` that `row` changes, absent ones as `undefined` (a store set of `undefined` deletes the key); undefined when nothing differs. */
function rosterRowPatch(prev: RosterEntry, row: RosterEntry): Partial<RosterEntry> | undefined {
	const patch: Record<string, unknown> = {};
	let changed = false;
	const before = prev as unknown as Record<string, unknown>;
	const after = row as unknown as Record<string, unknown>;
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (sameRosterField(before[key], after[key])) continue;
		patch[key] = after[key];
		changed = true;
	}
	return changed ? (patch as Partial<RosterEntry>) : undefined;
}

/**
 * Replace the roster with `next` while every surviving workspaceId keeps its
 * store object (same proxy, only changed fields notify), so keyed <For>
 * consumers (sidebar rows) stay mounted across roster frames. Rows with new
 * ids adopt the frame's object into the store; removed ids drop out; the
 * array is only replaced when membership or order changed.
 *
 * Hand-rolled instead of solid's `reconcile`: the SSR store build the tests
 * run on implements `reconcile` as an index-wise merge (no keying, holes on
 * shrink), so identity could neither be guaranteed nor tested there.
 */
function applyRoster(next: readonly RosterEntry[]): void {
	const current = unwrap(state.sessionRoster);
	const before = new Map(current.map((d) => [d.workspaceId, d]));
	batch(() => {
		const rows = next.map((row) => {
			const prev = before.get(row.workspaceId);
			if (prev === undefined || prev === row) return row;
			const patch = rosterRowPatch(prev, row);
			if (patch !== undefined) {
				setState("sessionRoster", (d) => d.workspaceId === row.workspaceId, patch);
			}
			return prev;
		});
		if (rows.length !== current.length || rows.some((r, i) => r !== current[i])) {
			setState("sessionRoster", rows);
		}
	});
}

/** Sort rank of a checkout row: main checkout, worktree, then clone. */
function checkoutRank(d: RosterEntry): number {
	if (d.workspaceKind === "clone") return 2;
	if (d.workspaceKind === "worktree" || d.worktreeOf !== undefined) return 1;
	return 0;
}

export function sessionsByProject(): { project: RegisteredProject; sessions: RosterEntry[] }[] {
	const groups = state.registeredProjects.map((project) => ({
		project,
		sessions: [] as RosterEntry[],
	}));
	const byProjectId = new Map(state.registeredProjects.map((p, i) => [p.projectId, i]));
	for (const d of state.sessionRoster) {
		const index = d.projectId !== undefined ? byProjectId.get(d.projectId) : undefined;
		if (index !== undefined) groups[index].sessions.push(d);
	}
	for (const g of groups) {
		g.sessions.sort((a, b) => {
			const rank = checkoutRank(a) - checkoutRank(b);
			if (rank !== 0) return rank;
			if (checkoutRank(a) === 1) return (a.branch ?? "").localeCompare(b.branch ?? "");
			return 0;
		});
	}
	return groups;
}

/** Roster statuses that mean the session is definitively not serving a
 *  session: the attached chat column must yield to the empty pane. */
const DEAD_SESSION_STATUSES = new Set<SessionStatus>(["asleep", "error"]);

/** True when the roster entry is missing or its status is terminal-dead.
 *  Transitional statuses ("spawning"/"connecting") and "ready"
 *  are NEVER dead; a waking session passes through them. */
export function isSessionDead(entry: RosterEntry | undefined): boolean {
	return entry === undefined || DEAD_SESSION_STATUSES.has(entry.status);
}

/** Transport state for the header strip and the session-bound action gate:
 *  the browser socket is up (connected); the stream is retrying, or the
 *  attached session is re-dialing (reconnecting); the attached session process
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

/** Track the attached session's "reconnecting" status through the grace window. */
function syncAttachedReconnecting(): void {
	const current = state.sessionRoster.find((d) => d.workspaceId === state.currentWorkspaceId);
	if (current?.status !== "reconnecting") {
		clearTimeout(reconnectGraceTimer);
		reconnectGraceTimer = undefined;
		if (state.attachedReconnecting) setState("attachedReconnecting", false);
		return;
	}
	if (state.attachedReconnecting || reconnectGraceTimer !== undefined) return;
	reconnectGraceTimer = setTimeout(() => {
		reconnectGraceTimer = undefined;
		const still = state.sessionRoster.find((d) => d.workspaceId === state.currentWorkspaceId);
		if (still?.status === "reconnecting") setState("attachedReconnecting", true);
	}, RECONNECT_GRACE_MS);
}

/** True when this tab has a live attached session to render. The attached
 *  roster entry must exist and not be dead; a session with an attach in
 *  flight counts as live (the roster lags a wake). */
export function hasLiveSession(): boolean {
	if (state.currentWorkspaceId === "") return false;
	const entry = state.sessionRoster.find((d) => d.workspaceId === state.currentWorkspaceId);
	if (!isSessionDead(entry)) return true;
	// A user stop keeps the transcript behind the stopped strip (App.tsx); a removed entry still clears.
	if (entry !== undefined && isUserStopped(state.currentWorkspaceId)) return true;
	return pendingAttachTarget() === state.currentWorkspaceId;
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
	const sessions = frame.type === "roster" ? frame.entries : mergeRosterDelta(frame);
	// finding #P1: diff the replacement roster against what we had.
	// First sighting is boot priming (silent); later transitions to
	// ready/error announce.
	const rosterBefore = state.sessionRoster;
	for (const entry of sessions) {
		announceSessionStatus(
			rosterBefore.find((d) => d.workspaceId === entry.workspaceId),
			entry.name,
			entry.status,
		);
	}
	// The fleet edge's session roster (sidebar swaps to the session
	// list).
	// Phase 5: entries carry projectId (project-first grouping and
	// linked-worktree eligibility). RosterEntry owns those fields, so they
	// flow through wholesale with the list.
	// Surviving workspaceIds keep their store object (fields patched, absent
	// ones deleted), so keyed rows stay mounted across roster frames.
	switchAwayFromRemoved(sessions);
	idleBeforeSessionDies(sessions.find((d) => d.workspaceId === state.currentWorkspaceId));
	applyRoster(sessions);
	if (!state.rosterLoaded) setState("rosterLoaded", true);
	settleProjectWakes();
	resumeRestartedSessions(sessions);
	// Removed sessions never reuse ids, but don't let the set grow unbounded.
	pruneUnread(new Set(sessions.map((d) => d.workspaceId)));
	// Same for sessionActivity: drop entries whose id left the roster.
	// setState MERGES plain-object values, so a shrunken record would
	// never delete keys. Reconcile diffs to the pruned record instead.
	// Skip it when nothing dropped (no useless store notification).
	{
		const kept = new Set(sessions.map((d) => d.workspaceId));
		const current = state.sessionActivity;
		let dropped = false;
		const next: Record<string, { streaming: boolean; blocked: boolean }> = {};
		for (const id of Object.keys(current)) {
			if (kept.has(id)) next[id] = current[id]!;
			else dropped = true;
		}
		if (dropped) setState("sessionActivity", reconcile(next));
	}
	// Persisted user-stop marks are confirmed (or dropped) against the roster first.
	reconcileUserStopped(sessions);
	// Roster truth wins over the attached chat: if the session we were
	// attached to vanished or went asleep, drop the session view (the
	// roster itself is fleet-scoped and survives).
	reconcileAttachedSession();
	pushDebug(
		"info",
		"roster",
		`roster frame: ${sessions.length} session process${sessions.length === 1 ? "" : "es"}`,
	);
}

/** Per-session UI state dropped when attaching to a different session. */
function resetSessionView(): void {
	setState("review", resetReviewState(state.review));
	resetBrowserUiRequests();
	setState({
		// Unknown until the new session's state frame lands; deep-link URL sync relies on it.
		sessionId: "",
		subagentsLoaded: { mirror: false, roster: false },
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
		jobWidgets: createJobWidgetsState(),
		stats: null,
		...createGoalState(),
		retryInfo: null,
		// The last state frame's flag belongs to the old process; the next frame re-reads it.
		compacting: false,
		workingIntent: undefined,
		modal: null,
		loginUrl: null,
		loginCodeRequest: null,
		uiRequest: null,
		btw: createBtwState(),
		lightboxImage: null,
	});
}

/** Roster truth wins over the attached chat column: after a roster or
 *  session_status update, if the session we are attached to is missing or
 *  terminal-dead (asleep/error), drop the session view. Only asleep/error mark the
 *  session down (`sessionDownId`, the offline strip with Restart); a removed entry
 *  just clears the view to the no-session pane, after switchAwayFromRemoved had its
 *  chance to move to a neighbour. The roster itself is fleet-scoped and survives. Race guard: the clear MUST NOT fire while
 *  an attach to that session is in flight, since a freshly waking session reads
 *  as "asleep" in lagging roster frames right after wake-attach; the entry and
 *  in-flight state are re-checked against the POST-frame roster here. */
function reconcileAttachedSession(): void {
	syncAttachedReconnecting();
	const downId = state.sessionDownId;
	if (downId !== "" && !isSessionDead(state.sessionRoster.find((d) => d.workspaceId === downId)))
		setState("sessionDownId", "");
	const id = state.currentWorkspaceId;
	if (id === "") return;
	if (pendingAttachTarget() === id) return;
	const entry = state.sessionRoster.find((d) => d.workspaceId === id);
	if (!isSessionDead(entry)) return;
	// A removed entry is not a stop: drop its mark; the view clears without going offline.
	if (entry === undefined) clearUserStopped(id);
	// A user stop keeps the transcript behind the stopped strip; readiness drops,
	// and so does a compacting flag the dead process can no longer clear.
	else if (isUserStopped(id)) {
		setState({ readyAt: undefined, compacting: false });
		return;
	}
	// Phase first: the transcript view is still mounted and reads it to fade
	// the session out before the writes below empty it. A switch in flight to
	// another session owns the phase (and still hides the old content).
	if (state.transcriptTarget === null)
		setState({ transcriptPhase: "idle", transcriptError: null, transcriptTarget: null });
	if (entry !== undefined) setState("sessionDownId", id);
	setState("currentWorkspaceId", "");
	setState("readyAt", undefined);
	resetSessionView();
	pushDebug(
		"info",
		"roster",
		`attached session process ${id.slice(0, 8)} is gone or asleep; session cleared`,
	);
}

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
		// A 4401 close held the reconnect: the sign-in that just succeeded releases it.
		if (snap.status === "signedIn" && awaitingSignIn) connect();
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
/** The roster frame `next` is about to remove the attached session: open the nearest
 *  ACTIVE session before it in the sidebar order (`sessionsByProject`: groups, then
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
function switchAwayFromRemoved(next: readonly RosterEntry[]): void {
	const id = state.currentWorkspaceId;
	if (id === "" || next.some((d) => d.workspaceId === id)) return;
	if (state.transcriptTarget !== null || pendingAttachTarget() !== null) return;
	const rows = sessionsByProject().flatMap((g) =>
		g.sessions.map((d) => ({ id: d.workspaceId, projectMissing: g.project.missing === true })),
	);
	const at = rows.findIndex((r) => r.id === id);
	if (at === -1) return;
	const byId = new Map(next.map((d) => [d.workspaceId, d]));
	const active = (r: { id: string; projectMissing: boolean }): boolean => {
		const status = byId.get(r.id)?.status;
		return (
			(status === "ready" || status === "reconnecting") &&
			!r.projectMissing &&
			!deletePendingIds().has(r.id)
		);
	};
	const target = rows.slice(0, at).reverse().find(active) ?? rows.slice(at + 1).find(active);
	if (target !== undefined) void switchToSession(target.id);
}

/** The roster is about to say the attached session is gone or dead (`next` is its entry
 *  after the frame): the chat pane unmounts as soon as hasLiveSession() flips, i.e. with
 *  the roster write itself, so the phase must already be idle by then for the
 *  transcript to fade the session out. reconcileAttachedSession clears the session
 *  right after. A switch in flight owns the phase and is left alone. */
function idleBeforeSessionDies(next: RosterEntry | undefined): void {
	const id = state.currentWorkspaceId;
	if (id === "" || state.transcriptTarget !== null || pendingAttachTarget() === id) return;
	if (!isSessionDead(next) || (next !== undefined && isUserStopped(id))) return;
	setState({ transcriptPhase: "idle", transcriptError: null, transcriptTarget: null });
}

/** A first connection still pending after this long shows the strip after all (the fleet is not answering). */
const STARTUP_CONNECT_GRACE_MS = 10_000;
let startupGraceTimer: ReturnType<typeof setTimeout> | undefined;

function armStartupGrace(): void {
	if (!state.transportStartup || startupGraceTimer !== undefined) return;
	startupGraceTimer = setTimeout(
		() => setState("transportStartup", false),
		STARTUP_CONNECT_GRACE_MS,
	);
}

export function connect(): void {
	// Browser-only transport: without WebSocket and location there is nothing
	// to dial. (A bun test worker has no location; a timer armed by an earlier
	// suite in the same worker must no-op here, not crash on location.search.)
	if (typeof WebSocket === "undefined" || typeof location === "undefined") return;
	clearTimeout(reconnectTimer);
	reconnectTimer = undefined;
	awaitingSignIn = false;
	// A new connect() supersedes any live socket.
	if (socket !== null) teardownSocket(socket, "hold", 1000, "superseded");
	pushDebug("info", "transport", "connecting /ws");
	clearSilenceTimer(); // a new connect() supersedes any prior socket's deadline
	// One WebSocket per tab, same origin. It cannot carry headers, so the
	// off-loopback bearer token rides the query string when the page URL
	// carries one; loopback dev needs none. `after` resumes the server's ring
	// replay from the last seq this page received.
	const token = new URLSearchParams(location.search).get("token");
	const url = browserSocketUrl(location.origin, {
		clientId,
		after: lastSeq,
		proto: OMP_PROTO,
		token,
	});
	const ws = dialSocket(url);
	if (ws === null) return;
	socket = ws;
	armSilenceTimer();
	armStartupGrace();
	// The frame mux: one decoded server frame; `frameSeq` is its ring/priming
	// seq, null when the server sent it unsequenced.
	const handleFrame = (frame: ServerFrame, frameSeq: number | null): void => {
		if (frame.type === "attached") {
			pushDebug("info", "transport", `attached ${frame.scope}`);
			const switched = state.currentWorkspaceId !== "" && state.currentWorkspaceId !== frame.scope;
			// One batch: the incoming workspace's saved dock lands together with
			// its id, so no effect ever sees the previous workspace's dock under the new id.
			batch(() => {
				if (state.currentWorkspaceId !== frame.scope) restoreDockLayout(frame.scope);
				setState("currentWorkspaceId", frame.scope);
			});
			// The subagent forest is pulled afresh on every attach below.
			setState("subagentsLoaded", { mirror: false, roster: false });
			// The attach priming re-sends the running jobs' widgets (nothing when none run): drop the last attachment's.
			clearJobWidgets();
			setState("sessionDownId", "");
			clearUnread(frame.scope);
			// Every attach re-primes history from scratch: drop any in-flight
			// chunked-series accumulation from the previous attach/session.
			pendingHistory = null;
			// A fresh priming series starts; the replay-dedup window resets
			// (seqs restart per connection, see seenFrameSeqs).
			seenFrameSeqs.clear();
			// Every attach starts a new attachment generation on the session side,
			// even a re-attach of the SAME session (wake after a UI stop keeps the
			// view, so it is not a switch). The scope of the previous generation
			// would make the on-attach calls below fail the session's stale-scope
			// check; drop it so they go out unscoped (the session accepts calls
			// without a scope) until the attachment's first `state` frame
			// re-stamps it via applyState.
			setState("sessionScope", undefined);
			// Finding #28: the attach waiter settles from the edge's id-keyed
			// attach_result, never from this PROXIED frame; the priming rides
			// the session pipe, which may be mid-redial when the attach lands.
			if (switched) {
				// In-flight calls belonged to the previous session; their results
				// are stale now and would be filtered out below. Clean up BEFORE
				// the getSubagents pull below, or rejectPendingCalls would kill the
				// fresh call too (and resetSessionView wipes its populated result).
				rejectPendingCalls(new Error("session switched"));
				resetSessionView();
				// Phase 3 session switch: drop readiness too. The edge only pipes
				// sessions that passed waitReady, so the proxied priming re-delivers
				// `ready` immediately; until then the composer stays gated and the
				// roster hint shows the session's status.
				setState("readyAt", undefined);
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
					batch(() => {
						setState("subagents", next);
						setState("subagentsLoaded", "mirror", true);
					});
				})
				.catch(() => {});
			// The worker roster is a separate read model: pull it on attach too, so
			// parked and idle workers reappear without waiting for a lifecycle frame.
			requestRosterRefresh();
			refreshSettings();
			// Watchers for this attachment (watchAttachment) wait for its first `state` frame.
			settleAttachedFrame(frame.scope);
			return;
		}
		// Stale-frame guard: session-scoped frames for a workspace this tab no
		// longer views (in flight during a switch) are dropped. The edge stamps
		// `scope` on session-scoped types only (isSessionScopedFrameType; the type
		// check stays as a belt). Fleet-scoped frames (session_status,
		// workspace_sessions, worktree_removed, ...) carry `workspaceId` as
		// PAYLOAD naming another row, a different key from the stamp, and always
		// pass. A session-scoped frame WITHOUT a stamp (a bare session) passes
		// too; there is nothing to mismatch. attach_result is a unicast answer
		// (not session-scoped) whose workspaceId is the ATTACHED workspaceId
		// (finding #28); id-matching against pendingAttach handles its staleness.
		if (
			isSessionScopedFrameType(frame.type) &&
			"scope" in frame &&
			frame.scope !== state.currentWorkspaceId
		)
			return;
		// Replay-dedup guard (finding #2): a delta live-delivered during the
		// paced prime is re-sent verbatim by the ring replay. Its seq was seen
		// on this connection already, so the second copy is the replay; drop
		// it (see seenFrameSeqs; unsequenced messages carry no seq).
		if (frameSeq !== null && frameSeq > 0 && seenFrameSeqs.has(frameSeq)) return;
		switch (frame.type) {
			case "history": {
				// A transcript over the client backpressure cap primes as
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
				break;
			case "workspace_sessions":
				// Unicast answer to list_workspace_sessions (fleet-scoped: settle keyed
				// by workspaceId + effective limit, no session guards).
				settleWorkspaceSessions(frame.workspaceId, frame.sessions, frame.limit);
				break;
			case "daemons":
				setState({
					daemons: new Map(
						((frame.daemons as DaemonInfo[] | undefined) ?? []).map((d) => [daemonsKey(d), d]),
					),
					daemonsLoaded: true,
				});
				break;
			case "roster":
			case "roster_delta":
				applyRosterFrame(frame);
				break;
			case "session_activity": {
				// Edge-generated, fleet-scoped realtime activity for any managed session.
				// It names the row in its payload `workspaceId`, but it is not a session-scoped frame
				// type (not in SESSION_SCOPED_FRAME_LIST) and never carries the edge's `scope` stamp, so
				// the stale-frame guard above lets it through (per-session, not per-attachment) and it
				// applies regardless of which session this tab is attached to.
				// Snapshot the boolean BEFORE setState: state.sessionActivity[...] is a
				// live store proxy, so reading prev.streaming after the set would see
				// the NEW value and the completion edge would never fire.
				const wasStreaming = state.sessionActivity[frame.workspaceId]?.streaming === true;
				setState("sessionActivity", frame.workspaceId, {
					streaming: frame.streaming,
					blocked: frame.blocked,
				});
				// Unread-on-completion: a detached turn's END is observable in
				// realtime (in_progress → idle while unfocused). Skip the attached
				// session (its live signals are on-screen anyway); the precedence in
				// session-activity hides an unread latch while the session still
				// streams (remote live truth beats the unread latch).
				if (wasStreaming && !frame.streaming && frame.workspaceId !== state.currentWorkspaceId) {
					markUnread(frame.workspaceId);
				}
				break;
			}
			case "session_status": {
				// finding #P1: announce the transition to a terminal rung
				// (ready/error) before patching the entry.
				const sessionBefore = state.sessionRoster.find((d) => d.workspaceId === frame.workspaceId);
				announceSessionStatus(
					sessionBefore,
					sessionBefore?.name ?? frame.workspaceId,
					frame.status,
				);
				if (frame.workspaceId === state.currentWorkspaceId)
					idleBeforeSessionDies(sessionBefore && { ...sessionBefore, status: frame.status });
				// Path-patch only the matching entry: its store object keeps identity and
				// only status/error notify. Setting `error: undefined` deletes the field,
				// so it clears unless the frame carries a fresh one.
				setState("sessionRoster", (d) => d.workspaceId === frame.workspaceId, {
					status: frame.status,
					error: frame.error,
				});
				settleProjectWakes();
				pushDebug(
					frame.status === "error" || frame.error !== undefined ? "error" : "info",
					"roster",
					`session process ${frame.workspaceId.slice(0, 8)} → ${frame.status}${frame.error !== undefined ? `: ${frame.error}` : ""}`,
				);
				// Same reconcile as the roster frame: the attached session just
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
				// like the roster; it survives session resets, and zero-session
				// projects still render via sessionsByProject).
				setState("registeredProjects", frame.projects);
				// Secret-free provider profile catalog rides the same
				// frame (optional; missing = no catalog).
				setState("providerProfiles", frame.providerProfiles ?? []);
				// Phase 4: the resolved fleet config path rides the same frame
				// (optional; missing = no config file). Also fleet-scoped:
				// resetSessionView must not wipe it.
				setState("fleetConfigPath", frame.configPath ?? null);
				break;
			case "worktree_delete_info":
				// Phase 5: unicast guard evidence for the delete-worktree
				// confirm, keyed by workspaceId (latest-wins like the frames
				// above; fleet-scoped).
				setState("worktreeDeleteInfo", (prev) => ({ ...prev, [frame.workspaceId]: frame }));
				break;
			case "worktree_removed": {
				// The fleet detected a worktree's directory vanished on disk and
				// evicted its session, so each eviction yields one toast plus an
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
			case "daemon_logs_result":
				settleDaemonLogs(frame);
				break;
			case "daemon_control_result":
				settleDaemonControl(frame);
				break;
			case "files":
				settleFiles(frame.files);
				break;
			case "subagent_lifecycle": {
				const payload = frame.payload;
				setState("subagents", (prev) => applyLifecycleFrame(prev, payload, Date.now()));
				// Parked and revivable state lives in the session roster: refetch it on lifecycle edges (SUB-10).
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
					if (frame.method === "approve") notifyDesktop("ask", "omp", "Waiting for approval");
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
			case "skills_changed":
				// Effective disabledExtensions changed (web, TUI, or a settings file edit):
				// a fresh skill inventory, applied like a getSkillsState reply.
				setState("integrations", skillsPatch(state.integrations, frame.state));
				break;
			case "collab_status":
				setState("collabStatus", frame.status);
				break;
			case "job_widgets":
				applyJobWidgets(frame);
				break;
			case "error":
				// Finding #28: an error frame is a GLOBAL uncorrelated broadcast
				// (fire-and-forget spawn failures, a lost pipe for ANOTHER
				// session, "not attached" answers). It must never settle an
				// in-flight attach. Attach failures arrive as id-keyed
				// attach_result frames; global errors only display.
				setState("error", frame.error);
				pushDebug("error", "transport", `error frame: ${frame.error}`);
				break;
			case "hello_ok":
				// Finding #61: the browser enforces OMP_PROTO too. A bare
				// session leads its priming with hello_ok; the fleet edge
				// forwards the (pipe-gated) hello_ok. A mismatch is terminal;
				// fail closed: surface the error, tear the socket down, and do
				// NOT reconnect (the backoff loop would otherwise hot-loop
				// against an undrivable session).
				if (frame.proto !== OMP_PROTO) {
					failProtoMismatch(ws, `session process speaks OMP_PROTO ${String(frame.proto)}`);
					return;
				}
				break;
			default:
				// Anything else unknown is tolerated and ignored, never thrown.
				console.debug(`[omp-session] ignoring ${frame.type} frame`);
				break;
		}
		if (frameSeq !== null && frameSeq > 0) seenFrameSeqs.add(frameSeq);
	};
	ws.onopen = () => {
		if (socket !== ws) return;
		// Seqs restart with every connection's priming: only the overlap within
		// one connection is deduped (see seenFrameSeqs).
		seenFrameSeqs.clear();
		socketMessages = 0;
		setConnected(true);
		setUplink(ws);
		setState({ connected: true, transportStartup: false });
		setState("reconnectDelay", 0);
		pushDebug("info", "transport", "stream open");
		// No boot-time calls: the fleet edge answers every call with "not
		// attached" until the browser picks a session. The attached handler
		// pulls getSubagents. On a RECONNECT the edge has no attach
		// memory, so re-attach to the session we were viewing.
		if (state.currentWorkspaceId) void attachSession(state.currentWorkspaceId).catch(() => {});
		else refreshSettings(); // boot with no session: the fleet /ctl model backs the panel
		// After the re-attach request, so a re-sent command that needs the
		// attachment follows it on the wire.
		resendUnsettled();
	};
	ws.onmessage = (ev) => {
		if (socket !== ws) return;
		const message = parseServerMessage(ev.data);
		if (message === null) {
			pushDebug("error", "transport", "malformed server message, reconnecting");
			teardownSocket(ws, "backoff", 4400, "malformed server message");
			return;
		}
		if (socketMessages++ === 0) reconnectAttempt = 0; // the socket proved itself
		armSilenceTimer(); // any downlink activity (frame, ping, ack) means the peer is alive
		setState("lastFrameAt", Date.now());
		switch (message.kind) {
			case "ping":
				// Keepalive tick: nothing to apply, the deadline re-arm above is the point.
				break;
			case "ack":
				acknowledgeCommand(message.id);
				break;
			case "nack":
				refuseCommand(message.id, message.status, message.error);
				break;
			case "frame":
				if (message.seq !== null) lastSeq = message.seq;
				handleFrame(message.frame, message.seq);
				break;
		}
	};
	ws.onclose = (ev) => {
		if (socket !== ws) return; // superseded or already torn down
		const typed = browserCloseFromCode(ev.code, ev.reason);
		pushDebug("info", "transport", `socket closed ${ev.code} ${ev.reason}`.trimEnd());
		switch (typed?.kind) {
			case "unauthorized":
				// Signed out or expired: no reconnect until the sign-in succeeds
				// (initAuth dials again on signedIn). Calls and unacked commands wait.
				awaitingSignIn = true;
				teardownSocket(ws, "hold");
				expireSession();
				break;
			case "forbidden":
				// Origin refused: retrying cannot succeed.
				setState("error", `connection refused: ${typed.message}`);
				pushDebug("error", "transport", `connection refused: ${typed.message}`);
				teardownSocket(ws, "never");
				break;
			case "proto_mismatch":
				failProtoMismatch(ws, `server refused this client (${typed.message})`);
				break;
			case "slow_consumer":
				// Drop-and-resume: the server dropped a slow reader and the ring
				// closes the gap. A socket that was delivering resumes at once.
				teardownSocket(ws, socketMessages > 0 ? "now" : "backoff");
				break;
			default:
				teardownSocket(ws, "backoff");
				break;
		}
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
	requestWorkspaceSessions,
	resumeSession,
	setSidebarVisible,
	setSidebarRunningOnly,
	setSidebarSessionTitleLines,
	setSidebarTitleFirst,
	closeDrawers,
	startWorkspaceNewSession,
	switchToSession,
	wakeAndAttach,
	setTxSidebarVisible,
	setView,
	toggleSidebar,
} from "./store/roster";
export {
	listProjectBranches,
	restartSessionById,
	spawnResume,
	stopSessionById,
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
	closeSessionDetails,
	closeWorktreeSessions,
	closeLightbox,
	openSessionDetails,
	openWorktreeSessions,
	openLightbox,
	sendLoginCode,
	sendUiResponse,
} from "./store/modals";
export { checkSession, signIn, signOut } from "./store/auth";
export { isUserStopped } from "./store/user-stopped";
export { refreshSettings, updateSetting } from "./store/settings";
export { refreshUsageReports, setSidebarUsage, USAGE_AUTO_REFRESH_MS } from "./store/usage";
export {
	DEBUG_RING_CAP,
	fetchCtlDebug,
	fetchCtlTemplates,
	fetchSessionStderr,
	requestDaemonLogs,
	stopDaemon,
	restartDaemon,
} from "./store/transport";
export { steerSubagent, abortSubagent } from "./store/subagents";
export { dismissToast, pushToast } from "./store/toasts";
export { announce, appendBashChunk, applyEvent, cancelUiRequest, attachSession, call, clientId };
