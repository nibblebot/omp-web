import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEvent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AvailableSlashCommandSource } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools";
import type { Capability } from "./browser-ui-contract";

// ---------------------------------------------------------------------------
// Local copies of the RPC wire types (structurally verbatim from the
// @oh-my-pi/pi-coding-agent@17.1.8 RPC mode's protocol type definitions).
// The server no longer spawns the RPC child, so the protocol owns these.
// ---------------------------------------------------------------------------

/** Pick of Model the model picker consumes (was the RPC client's ModelInfo). */
export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

/**
 * Why a model-browser row is unusable: no credentials for its provider, or the
 * provider is disabled. The web derives the sentence (`lockMessage`); the code
 * keeps every row small enough for one callback envelope on a full registry.
 */
export type ModelLockReason = "credentials" | "disabled";

/** A model-browser row: every registry model, with the reason it cannot be used when it cannot. */
export type ModelBrowserEntry = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning"> & {
	/** Absent = usable. */
	locked?: ModelLockReason;
};

/** Where a role assignment persists: global config.yml or project .omp/config.yml. */
export type ModelRoleStorage = "global" | "project";

/** One row of the roles picker catalog: every known role (built-in + custom), assigned or not. */
export interface ModelRoleCatalogEntry {
	role: string;
	/** Display name from getRoleInfo (built-in name or configured modelTags override). */
	name: string;
	/**
	 * TUI-parity tag from getRoleInfo (e.g. SMOL, PLAN); absent for custom
	 * roles, so render `tag ?? name`.
	 */
	tag?: string;
	/** Hidden roles stay functional but are filtered from picker view (modelTags.<role>.hidden). */
	hidden: boolean;
	/** Effective assigned model; absent when unassigned (auto-selection applies). */
	provider?: string;
	id?: string;
	/** Explicit thinking selector baked into the role value (`provider/model:level`); absent = inherit. */
	thinkingLevel?: string;
	/** Persisted layer owning the effective assignment. */
	source: "project" | "global" | "default";
}

export interface WebSessionState {
	sessionScope?: SessionScope;
	capabilities?: ServerCapabilities;
	model?: Model;
	/** Resolved model-role assignments (role -> provider/id) in canonical role order; undefined when nothing resolves. */
	modelRoles?: Array<{ role: string; provider: string; id: string }>;
	/** Full role catalog for the roles picker; undefined when the catalog cannot be built (no models). */
	modelRoleCatalog?: ModelRoleCatalogEntry[];
	/** Configured persistence scope for role edits (settings `modelRoleStorage`). */
	modelRoleStorage?: ModelRoleStorage;
	thinkingLevel: ThinkingLevel | undefined;
	/** True when the configured selector is `auto`; `thinkingLevel` then holds the provisional or per-turn resolved effort. */
	autoThinking?: boolean;
	/** `session.getAvailableEffortSelectors()` for the active model, in SDK order. Empty or absent = no thinking dial. */
	thinkingSelectors?: string[];
	/** Saved model presets; absent when none exist. `active` names the preset matching the live roles. */
	modelPresets?: { names: string[]; active?: string };
	/** Effective Task subagent model `provider/id`; absent when Task inherits the session model. */
	taskModel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	/**
	 * True once the SDK has materialized `sessionFile` on disk. The SDK writes the
	 * transcript lazily (first assistant message), so a fresh session's recorded
	 * path may lead nowhere; the fleet uses this to tell a never-prompted session
	 * (relaunch adopts the unwritten path) from a persisted one (relaunch is strict).
	 */
	sessionPersisted?: true;
	sessionId: string;
	/** Set once the omp-session readiness gate clears (R8): SDK session live + provider/model/auth resolved. */
	readyAt?: number;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	/** New with the in-process SDK: real value instead of the client-side hack. */
	autoRetryEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	/** Messages a Stop withdrew from the queue and holds until Resume queue. */
	pausedQueueCount?: number;
	todoPhases: TodoPhase[];
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	// --- Phase 9: modes & usage parity (cheap sync getters, refreshed every broadcast) ---
	/** Goal mode state (getGoalModeState()); undefined when no goal session is active. */
	goalModeState: GoalModeState | undefined;
	/** Plan mode presence (getPlanModeState()?.enabled). */
	planModeEnabled: boolean;
	/** A plan review awaits an operator decision (newest persisted review is waiting). */
	planReviewPending?: boolean;
	/** Priority-service flag for the active model family (isFastModeEnabled()). */
	fastModeEnabled: boolean;
	/** Whether computer use is enabled for the session (settings.get("computer.enabled")). */
	computerToolEnabled: boolean;
}

/** One tool of the live session as `getToolSchemas` answers it (never part of `state`). */
export interface ToolSchemaInfo {
	name: string;
	description: string;
	parameters: unknown;
	examples?: readonly ToolExample[];
}

export interface AvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface SubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	/** True when more transcript bytes follow `nextByte` (page-forward cursor). */
	hasMore?: boolean;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

/** Image payload accepted by prompt/steer/followUp (structurally compatible with pi-ai's ImageContent). */
export type ImageArg = { type: "image"; data: string; mimeType: string; detail?: string };

/** Kind of a user-authored queued message: a steer (delivered at the next model call) or a follow-up (after the turn). */
export type QueuedMessageKind = "steer" | "follow-up";
/** A queued message a Stop withdrew from the live queues; held until the queue is resumed. */
export interface PausedQueuedMessage {
	kind: QueuedMessageKind;
	text: string;
	/** How many images the held message carries; the bytes come back only from take/pop. */
	imageCount: number;
}
/** Queue snapshot for the composer queue bar. The first `liveSteered` entries of `steering` were already delivered into the running turn and cannot be removed. */
export interface QueuedMessagesSnapshot {
	steering: string[];
	followUp: string[];
	liveSteered: number;
	paused: PausedQueuedMessage[];
	/** Image count for each live steer, index-aligned with `steering` (0 when it has none). */
	steeringImageCounts?: number[];
	/** Image count for each live follow-up, index-aligned with `followUp`. */
	followUpImageCounts?: number[];
	/** Slash commands the SDK rejects while a turn runs; they run in this order at turn end, after the follow-ups. */
	commands?: string[];
	/** Image count for each queued command, index-aligned with `commands`. */
	commandImageCounts?: number[];
	/** True after a Stop: queued commands wait for Resume queue instead of running at turn end. */
	commandsPaused?: boolean;
}
/** Identifies one queue chip. `paused` is the index into the held list (omitted for live items); `text` verifies identity. */
export interface QueuedMessageRef {
	kind: QueuedMessageKind;
	text: string;
	paused?: number;
}
/** Identifies one queued slash command chip by its position in the command queue; `text` verifies identity. */
export interface QueuedCommandRef {
	index: number;
	text: string;
}

// ---------------------------------------------------------------------------
// Settings panel (TUI /settings parity). The server builds the model from the
// shared settings-schema metadata; the client renders it verbatim.
// ---------------------------------------------------------------------------

export interface SettingsOption {
	value: string;
	label: string;
	description?: string;
}

export type SettingsItemType =
	| "boolean"
	| "enum"
	| "submenu"
	| "text"
	| "multiselect"
	| "providerLimits"
	| "record"
	| "list";

export interface SettingsItem {
	view?: SettingView;
	path: string;
	label: string;
	description: string;
	/** Risk note from the SDK (amber callout on the row); absent when the setting carries none. */
	warning?: string;
	type: SettingsItemType;
	/** Raw current value (JSON-safe). */
	value: unknown;
	/** True when the value differs from the schema default (arrays elementwise). */
	changed: boolean;
	/** text type only */
	secret?: boolean;
	/** multiselect only */
	ordered?: boolean;
	/** enum type only */
	values?: string[];
	/** submenu + multiselect */
	options?: SettingsOption[];
	/** providerLimits only */
	providers?: string[];
}

export interface SettingsGroup {
	name: string;
	items: SettingsItem[];
}

export interface SettingsTab {
	id: string;
	label: string;
	groups: SettingsGroup[];
}

export interface SettingsModel {
	revision?: number;
	target?: "current-session" | "future-sessions";
	tabs: SettingsTab[];
}

/**
 * setSetting/unsetSetting answer when the caller passes the "revision" reply
 * option as the trailing argument. The full model then travels once, on the
 * settings_changed broadcast. Callers that omit the option keep receiving the
 * full SettingsModel.
 */
export interface SettingsRevisionAck {
	revision: number;
}

// ---------------------------------------------------------------------------
// Installed plugins (Settings > Installed). Backed by the SDK plugin manager
// (~/.omp/plugins/omp-plugins.lock.json): session RPCs when a session is
// attached, /ctl/plugins/* on the fleet otherwise. A secret setting never
// carries its value or default: only `set` says whether one is stored.
// ---------------------------------------------------------------------------

export type PluginSource = "npm" | "link";

export interface PluginSummary {
	name: string;
	/** Absent when the package declares no version; never rendered as "undefined". */
	version?: string;
	source: PluginSource;
	enabled: boolean;
	description?: string;
}

export interface PluginFeatureRow {
	name: string;
	description?: string;
	/** Effective state: explicit selection when one is stored, else the manifest default. */
	enabled: boolean;
	default: boolean;
}

export type PluginSettingValue = string | number | boolean;

export interface PluginSettingRow {
	key: string;
	type: "string" | "number" | "boolean" | "enum";
	description?: string;
	secret: boolean;
	/** Environment variable the plugin falls back to when no value is stored. */
	env?: string;
	/** enum only */
	values?: string[];
	/** number only */
	min?: number;
	max?: number;
	step?: number;
	/** Omitted for secrets. */
	default?: PluginSettingValue;
	/** Stored value; omitted for secrets and when nothing is stored. */
	value?: PluginSettingValue;
	/** A value is stored in the lock file (the only signal a secret exposes). */
	set: boolean;
}

export interface PluginDetail extends PluginSummary {
	features: PluginFeatureRow[];
	/** True when an explicit feature selection overrides the manifest defaults. */
	featuresCustomized: boolean;
	settings: PluginSettingRow[];
}

// Integrations sheet (MCP servers, skills). Secret values (env, header values,
// tokens) never leave the session: summaries carry key names only.

export type McpScope = "project" | "user";
export type McpTransport = "stdio" | "http" | "sse";
/** `disabled`: configured but switched off. The rest is live manager state. */
export type McpConnectionState = "connected" | "connecting" | "disconnected" | "disabled";

export interface McpServerSummary {
	name: string;
	transport: McpTransport;
	status: McpConnectionState;
	enabled: boolean;
	/** `discovered`: from a third-party config (Claude, Cursor, a plugin) that the web cannot write. */
	scope: McpScope | "discovered";
	/** True when mcpUpdate / mcpRemove can change it (declared in the user or project mcp.json). */
	writable: boolean;
	/** Discovered servers: provider label and file. */
	source?: string;
	command?: string;
	args?: string[];
	/** Names only. */
	envKeys?: string[];
	/** http/sse: origin plus path; query and userinfo stripped. */
	url?: string;
	/** Names only. */
	headerNames?: string[];
	auth: "none" | "oauth" | "token";
	toolCount?: number;
	/** Last connection failure. */
	error?: string;
}

export interface McpState {
	servers: McpServerSummary[];
	paths: { user: string; project: string };
	/** `mcp.enableProjectConfig`; false means project servers are not started. */
	projectConfigEnabled: boolean;
}

/**
 * mcpAdd / mcpUpdate payload. On mcpUpdate, a `null` value inside `env` or
 * `headers` keeps that key's stored value; a key omitted from the object is removed.
 */
export interface McpServerInput {
	name: string;
	scope: McpScope;
	transport: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string | null>;
	url?: string;
	headers?: Record<string, string | null>;
	/** http/sse bearer token; when set, it replaces the Authorization header with `Bearer <token>`. */
	token?: string;
}

export interface McpActionResult {
	ok: boolean;
	detail: string;
}

export interface McpTestResult extends McpActionResult {
	tools: string[];
}

export interface McpInspection {
	tools: Array<{ name: string; description?: string }>;
	resources: Array<{ uri: string; name?: string; description?: string }>;
	prompts: Array<{ name: string; description?: string }>;
}

export interface SkillSummary {
	name: string;
	description: string;
	/** Provider label, e.g. "Agents (user)" or "OMP (project)". */
	source: string;
	path: string;
	enabled: boolean;
	/** Loaded and invocable but left out of the system prompt listing. */
	hidden: boolean;
}

export interface SkillsState {
	skills: SkillSummary[];
	warnings: string[];
}

// ---------------------------------------------------------------------------
// omp-session / omp-fleet contract (README.md). OMP_PROTO gates
// fleet↔omp-session drift (the collab COLLAB_PROTO pattern); bump on any
// breaking change to the transport or frame shapes.
//
// Transport (OMP_PROTO 2): no WebSockets on the agent-driving path. Client →
// server commands are POST /command bodies (one ClientCommand per request,
// answered 202); server → client frames are SSE events on GET /events
// (event: frame, id: <seq>, data: <JSON ServerFrame>). Auth is HTTP-level
// (R14): loopback exempt, off-loopback bearer via Authorization header or
// ?token=; a wrong credential is a 401, not a close code. hello_ok is the
// FIRST event on every stream open (daemon identity), followed by the attach
// priming (attached → history → state → collab_status → available_commands →
// ready).
// ---------------------------------------------------------------------------

/** Bump on any breaking frame change.
 *  3: project/worktree redesign (remote enrollment, `DaemonEntry.mode`,
 *  `list_projects`/`projects`, `add_worktree` removed).
 *  4: infra remediation (kata kfg5): streaming, state, and command-size
 *  changes from the fleet/session/wire audit; see CHANGELOG.md
 *  "Infra remediation". */
export const OMP_PROTO = 4;

// --- SSE framing constants (shared by the daemon and the fleet) ---

/** SSE event field carrying every ServerFrame. */
export const SSE_EVENT_NAME = "frame";
/** Keepalive ping event (see SSE_PING_BLOCK in sse.ts) interval written to every open stream. */
export const SSE_KEEPALIVE_MS = 15_000;
/**
 * Consumers treat this much total silence (no event, no comment) as a dead
 * peer → abort + reconnect. Generous vs SSE_KEEPALIVE_MS so one delayed
 * comment never trips it.
 */
export const SSE_SILENCE_DEADLINE_MS = 30_000;
/** Bounded replay ring of recent deltas, per daemon / per browser stream. */
export const SSE_RING_CAP = 10_000;
/**
 * Byte budget for one replay ring (finding #5): a ring must be bounded in
 * BYTES, not only in entries. Multi-megabyte deltas (large bash chunks,
 * base64 image payloads) across thousands of entries would otherwise
 * balloon memory.
 * Sized at 2× SSE_BACKPRESSURE_BYTES so the ring comfortably holds the
 * post-drop replay window of a stream that was buffered up to the cap. The
 * entry cap (SSE_RING_CAP) remains a secondary bound for many-small-delta
 * bursts.
 */
export const SSE_RING_BYTES = 8 * 1024 * 1024;
/**
 * First seq assigned to post-priming deltas (a daemon-global counter).
 * Priming frames carry seqs 1..k (k < SSE_DELTA_SEQ_START) per stream, so a
 * Last-Event-ID below this value means "stale/empty client: priming already
 * carries full current state". The daemon replays ring deltas with
 * seq > max(lastEventId, snapshotSeq-1). The snapshot mark (the next delta
 * seq captured before the priming snapshot is built) bounds the overlap, so
 * a resume never re-delivers deltas whose effects are inside the fresh
 * priming (finding #2: no duplicated items after a resume).
 */
export const SSE_DELTA_SEQ_START = 1024;
/** Per-stream enqueue cap: beyond it the stream is terminated (drop-and-resume). */
export const SSE_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
/**
 * POST /command idempotency: how long an id is remembered, how many recorded
 * ANSWERS stay replayable, and the flood backstop on remembered ids.
 * Remembering an id is what makes a re-POST safe (it is re-accepted, never
 * re-dispatched), and a browser recovering a lost answer re-POSTs every 5s for
 * the whole window, so id memory has to cover a window of real traffic rather
 * than a handful of commands: evicting a live id early would let the replay
 * execute the command twice. Recorded answers are kept under a count cap AND a
 * byte budget: a browser re-POSTs after 5s, so an answer must survive that
 * replay window at the burst rate (a settings write answers with the whole
 * model, so a count alone evicts the answers the replays are waiting for). An
 * evicted answer degrades a replay to "accepted, no answer" (the caller's
 * deadline settles it) and never to a re-execution.
 */
export const COMMAND_DEDUP_WINDOW_MS = 60_000;
export const COMMAND_DEDUP_ANSWER_CAP = 256;
export const COMMAND_DEDUP_ANSWER_BYTES = 32 * 1024 * 1024;
export const COMMAND_DEDUP_ID_CAP = 4_096;

/** Prefix of the `OMP_SESSION|` stdout contract lines (R6b). */
export const OMP_SESSION_PREFIX = "OMP_SESSION|";

/**
 * omp-session exit code when its session file is locked by another live
 * omp-session (e.g. the same session open in a second fleet). Deterministic:
 * a spawner must not retry it; the daemon's last stderr line names the file
 * and the holder. Same value as the fleet's own state-lock conflict exit.
 */
export const OMP_SESSION_EXIT_SESSION_LOCKED = 77;

/**
 * omp-session exit code when `--resume <file>` names a durable session the
 * daemon cannot restore (file missing, unreadable, or recorded under another
 * cwd). Deterministic: a spawner must not retry it, and the daemon never boots
 * a fresh session in its place; the last stderr line names the file and the
 * reason.
 */
export const OMP_SESSION_EXIT_RESUME_FAILED = 78;

/**
 * The `OMP_SESSION|` stdout contract lines (R6b). omp-session prints
 * `listening` immediately after bind, before session creation; a remote
 * wrapper MAY print `endpoint` when the reachable address differs from the
 * bind. The line is informational for whoever launched the daemon (the
 * terminal, a supervisor, or the session log); the fleet does not parse it.
 *
 * NOTE: the advertised `url` is ws-shaped (`ws://host:port`) for legacy
 * reasons; OMP_PROTO 2 is plain HTTP SSE. Consumers must never treat it as a
 * WebSocket endpoint.
 */
export type StdoutContractLine =
	| { event: "listening"; bind: string; port: number; url: string; advertise?: string }
	| { event: "endpoint"; url: string };

/** Daemon lifecycle as surfaced by omp-fleet (daemon_status frame). */
export type DaemonStatus =
	| "spawning"
	| "connecting"
	| "session"
	| "resolving"
	| "ready"
	| "asleep"
	| "reconnecting"
	| "error";

// --- Clone workspace identity: workspace/daemon lifecycle facts the fleet
// edge surfaces on the roster (optional DaemonEntry fields).

/** How a workspace's checkout was produced (clone-contracts ledger). */
export type WorkspaceKind = "worktree" | "clone" | "direct";

/** Fleet-side desired state of a workspace (clone-contracts ledger). */
export type DesiredState = "running" | "stopped";

/** Provider-managed workspace lifecycle: preparation → runtime → callback → ready; failed is terminal. */
export type LifecycleStage = "preparation" | "runtime" | "callback" | "ready" | "failed";

/**
 * Secret-free capability view of a fleet provider profile (frozen contract,
 * docs/clone-contracts.md "Browser and CLI workspace creation"). Safe to
 * cross trust boundaries: never carries the executable, image/namespace
 * details, or secret reference VALUES, only their names. Lifted from
 * fleet/provider-profile.ts (which re-exports this type) so browser/CLI
 * consumers import the single wire source from lib/wire/protocol.ts.
 */
export interface PublicProviderProfile {
	/** Profile id (the config map key). */
	id: string;
	provider: "bwrap" | "kubernetes";
	/** Declared resource limits, when any. */
	resources?: { cpu?: string; memory?: string };
	/** Sandbox network mode (bwrap): "host" | "isolated"; absent = isolated default. */
	network?: "host" | "isolated";
	/** Declared storage class name, when any. */
	storageClassName?: string;
	/** Secret reference names only; values never appear here. */
	secretRefNames?: string[];
}

/** One daemon in the omp-fleet roster (roster frame). */
export interface DaemonEntry {
	daemonId: string;
	name: string;
	cwd: string;
	project: string;
	worktreeOf?: string;
	/**
	 * The registered project this daemon belongs to (source: fleet edge
	 * roster). Absent only for a CLI spawn outside every registered project;
	 * the web sidebar does not show such rows.
	 */
	projectId?: string;
	/** Current git branch of the session cwd (source: fleet edge roster); absent when detached or unprobed. */
	branch?: string;
	/** Short commit of a detached HEAD (source: fleet edge roster); present only when detached. */
	detachedAt?: string;
	/** True when `git worktree lock` holds this linked worktree (source: fleet sync). */
	worktreeLocked?: boolean;
	/** git dirty-state file counts (source: fleet edge roster; older edges omit them). */
	git?: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
	labels: string[];
	status: DaemonStatus;
	lastSessionFile?: string;
	/** Title of the daemon's last session file (source: fleet edge roster, probed from the
	 *  lastSessionFile JSONL title slot). */
	sessionTitle?: string;
	/** True when the daemon's current/last session file has no messages (a new/empty
	 *  session); fleet-probed like sessionTitle. */
	sessionEmpty?: boolean;
	readyAt?: number;
	uptime?: number;
	pid?: number;
	error?: string;
	// --- Clone workspace identity (P1, additive; older edges omit these) ---
	/** How the daemon's checkout was produced (source: fleet edge roster; absent for legacy entries). */
	workspaceKind?: WorkspaceKind;
	/** Fleet-side desired state of the daemon's workspace (source: fleet edge roster; absent = legacy). */
	desiredState?: DesiredState;
	/** Provider profile the daemon's workspace runs under (source: fleet edge roster; absent = unmanaged/legacy). */
	providerProfileId?: string;
	/** Provider lifecycle stage of the daemon's workspace (source: fleet edge roster; absent = legacy/local daemon). */
	lifecycleStage?: LifecycleStage;
	/** Last workspace lifecycle failure detail (source: fleet edge roster; present only after a failed stage). */
	lifecycleError?: string;
}

/** One local branch of a registered project, or one branch of a project remote (project_branches frame). */
export interface ProjectBranch {
	/** Short branch name (refs/heads/ stripped, or the remote's head name). */
	name: string;
	/** True when checked out in some local worktree; git refuses a second checkout. Always false for remote listings. */
	checkedOut: boolean;
	/** Where it is checked out (main checkout or linked worktree), when checkedOut. */
	worktreePath?: string;
}

/**
 * One first-class project registered with the fleet (registered_projects
 * frame). Projects are realpath-keyed, deduped on registration, and persist
 * in the fleet state file; `path` is always the realpath of the main
 * checkout and `name` its basename. Local daemons carry the matching
 * `projectId` on the roster.
 */
export interface RegisteredProject {
	projectId: string;
	/** Realpath of the main checkout. */
	path: string;
	/** Basename of the realpath (display name). */
	name: string;
	/** Epoch ms of registration. */
	addedAt: number;
	/** True when the main checkout no longer exists or is no longer a git repo (fleet sync). Its rows cannot start. */
	missing?: boolean;
}

/**
 * Allowlist of session methods reachable from the browser. The server owns a
 * dispatch table keyed by these names; adding a capability = one row there.
 */
export type WebMethodName =
	| "prompt"
	| "steer"
	| "followUp"
	| "getQueuedMessages"
	| "resumeQueue"
	| "takeQueued"
	| "runQueuedNow"
	| "queueCommand"
	| "takeQueuedCommand"
	| "runQueuedCommandNow"
	| "popLastQueuedMessage"
	| "clearQueue"
	| "abort"
	| "abortAndPrompt"
	| "newSession"
	| "retry"
	| "fork"
	| "freshSession"
	| "handoff"
	| "setSessionName"
	// Phase 9 (17.1.8): goal/plan modes are NOT ACP-intercepted; /goal and
	// /plan fall through to the model. Control relays via these SDK rows.
	| "setPlanModeState"
	| "goalCreate"
	| "goalPause"
	| "goalResume"
	| "goalDrop"
	| "formatSessionAsText"
	| "setModelRole"
	| "clearModelRole"
	| "setModelRoleHidden"
	| "setThinkingLevel"
	| "setAutoCompaction"
	| "setAutoRetry"
	| "setFastMode"
	| "getContextBreakdown"
	| "getToolSchemas"
	| "bash"
	| "abortBash"
	| "python"
	| "abortEval"
	// Composer ghost text: spelling.autocomplete word suffix and its feedback,
	// composer.predictions next-message prediction (SDK controller, same gates).
	| "predictWord"
	| "predictWordFeedback"
	| "predictNextMessage"
	| "getSessionStats"
	// Settings panel (TUI /settings parity)
	| "getSettings"
	| "setSetting"
	| "exportHtml"
	| "switchSession"
	| "branch"
	| "getBranchMessages"
	| "getLoginProviders"
	| "login"
	| "getSubagents"
	| "getSubagentMessages"
	| "subagentSteer"
	| "subagentAbort"
	| "materializeSession"
	| "clearSession"
	| "deleteSession"
	| "unsetSetting"
	| "getSessionGraph"
	| "navigateTree"
	| "resumeAfterAskReanswer"
	| "getMcpState"
	| "mcpAdd"
	| "mcpUpdate"
	| "mcpRemove"
	| "mcpTest"
	| "mcpReconnect"
	| "mcpEnable"
	| "mcpDisable"
	| "mcpOAuthRevoke"
	| "mcpInspect"
	| "getSkillsState"
	| "setSkillEnabled"
	| "listPlugins"
	| "getPluginConfig"
	| "setPluginEnabled"
	| "setPluginFeatures"
	| "setPluginSetting"
	| "reloadIntegrations"
	| "gitStatus"
	| "gitStage"
	| "gitUnstage"
	| "gitStageHunks"
	| "gitCommit"
	| "gitFileDiff"
	| "gitUnstagedPatch"
	| "annotationList"
	| "annotationCreate"
	| "annotationUpdate"
	| "annotationRemove"
	| "annotationReanchor"
	| "annotationCompose"
	| "planGet"
	| "planDecide"
	| "planReopen"
	| "todoGet"
	| "todoApply"
	| "todoImport"
	| "todoExport"
	| "compactEx"
	| "compactionSnapshot"
	| "shake"
	| "dropImages"
	| "abortCompaction"
	| "handoffPreview"
	| "switchModel"
	| "getModelBrowser"
	| "setTaskModel"
	| "getModelPresets"
	| "getModelMentions"
	| "saveModelPreset"
	| "applyModelPreset"
	| "deleteModelPreset"
	| "getResumeCapabilities"
	| "resumeResolve"
	| "resumeList"
	| "resumePinToggle"
	| "resumeRename"
	| "resumeDelete"
	| "foreignList"
	| "foreignPreview"
	| "foreignImport"
	| "foreignUploadStage"
	| "foreignUploadCancel"
	| "lineageResume"
	| "btwList"
	| "btwSearch"
	| "btwPage"
	| "btwStart"
	| "btwFollowUp"
	| "btwCancel"
	| "btwCopy"
	| "btwPromotePreview"
	| "btwPromote"
	| "workerList"
	| "workerPark"
	| "workerRevive"
	| "advisorGetStatus"
	| "advisorConfigure"
	| "advisorTranscript"
	| "goalReplace"
	| "goalBudget"
	| "loopPreview"
	| "loopPolicy"
	| "loopStart"
	| "loopPause"
	| "loopCancel"
	| "loopResume"
	| "vibeStatus"
	| "vibeSetMode"
	| "vibeSpawn"
	| "vibeSend"
	| "vibeWait"
	| "vibeKill"
	| "vibeKillAll"
	| "vibeRehydrate"
	| "downloadManifest"
	| "dumpSessionArchive"
	| "exportDownload";

// Client → server (POST /command bodies; one command per request, 202 accept).
// Routing is by STREAM ATTACHMENT: on omp-session an /events stream is attached
// to the single live session from open (connect = attached), so call/
// login_code/ui_response implicitly target it. `attach` exists only at the
// fleet edge, where it selects the daemon to proxy.
// Every command carries a client-supplied `id` for POST idempotency: the
// server dedups within a window (COMMAND_DEDUP_WINDOW_MS), remembering ids up
// to COMMAND_DEDUP_ID_CAP and replayable answers up to COMMAND_DEDUP_ANSWER_CAP,
// and re-accepts duplicates with 202; answers ride the /events stream.
export type ClientCommand =
	| {
			type: "call";
			id: string;
			method: WebMethodName;
			args?: unknown[];
			streamId?: number;
			scope?: SessionScope;
	  }
	| { type: "login_code"; id: string; requestId: string; code: string }
	// Answer to a server "ui_request" frame (ExtensionUIContext dialogs).
	| { type: "ui_response"; id: string; result?: unknown; error?: string }
	| { type: "list_sessions"; id: string }
	| { type: "list_files"; id: string; query: string; limit?: number }
	// Fleet edge only: attach this stream to the daemon with this id
	// (the edge proxies it through; a bare omp-session never receives attach).
	| { type: "attach"; id: string; sessionId: string }
	// Collab: start/stop the collab room for the stream's ATTACHED session.
	// relayUrl overrides collab.relayUrl for this room only (ShareSheet's explicit relay choice).
	| { type: "collab_start"; id: string; relayUrl?: string; access?: "view" | "control" }
	| { type: "collab_stop"; id: string }
	// Daemon web exposure: per-daemon logs/stop/restart, answered by unicast
	// daemon_logs_result / daemon_control_result frames.
	| {
			type: "daemon_logs";
			id: string;
			projectDir: string;
			name: string;
			lines: number;
			head?: boolean;
			grep?: string;
	  }
	| { type: "daemon_stop"; id: string; projectDir: string; name: string; timeoutMs?: number }
	| { type: "daemon_restart"; id: string; projectDir: string; name: string }
	// --- Fleet edge (browser → omp-fleet only; a bare omp-session rejects these) ---
	| { type: "spawn"; id: string; cwd: string; template?: string; labels?: string[] }
	// Resume this exact session file instead of the daemon's lastSessionFile;
	// omitted = resume the last session (today's behavior). The fleet edge
	// validates it against the daemon's worktree session listing.
	| { type: "spawn_resume"; id: string; daemonId: string; sessionFile?: string }
	| { type: "stop"; id: string; daemonId: string }
	// Fleet edge only: list sessions in a daemon's worktree (fleet-edge handled,
	// answered with a unicast `daemon_sessions` frame; a bare omp-session
	// rejects it like the other fleet-only commands).
	| { type: "list_daemon_sessions"; id: string; daemonId: string }
	// Stop the daemon AND evict it from the roster (registry removal).
	| { type: "remove"; id: string; daemonId: string }
	// Register a project. `path` may be the main checkout, a linked worktree,
	// or a subdirectory: the fleet registers the main checkout (bare repos
	// and non-git paths are refused). Registration never spawns; the fleet
	// sync adds one asleep row per checkout. Answered by add_project_result.
	| { type: "add_project"; id: string; path: string }
	// Deregister a project and drop all of its rows (running sessions are
	// stopped, transcripts kept, disk untouched). Refused while a clone
	// workspace still belongs to it.
	| { type: "remove_project"; id: string; projectId: string }
	// Worktree creation (projectId from the registered_projects frame):
	// a new branch from baseRef, or an existing local branch. start:true also
	// spawns a daemon on the worktree; progress rides the roster/daemon_status
	// broadcasts. Answered by workspace_create_result.
	| {
			type: "create_worktree";
			id: string;
			projectId: string;
			name: string;
			baseRef?: string;
			existingBranch?: string;
			start?: boolean;
	  }
	// Clone workspace creation: an independent provider-managed clone of a
	// registered project. `source` carries at most one of local (fleet-host
	// path), remote (URL), or remoteName (a git remote of the project,
	// resolved fleet-side so URLs never reach the browser); omitted = the
	// project's own path for host-side providers, its `origin` URL for
	// kubernetes. `revision` is the clone pin vocabulary (worktrees keep
	// `baseRef`); the resolved commit persists as pinnedRevision. Answered
	// by workspace_create_result.
	| {
			type: "create_clone";
			id: string;
			projectId: string;
			name: string;
			profileId: string;
			source?: { local?: string; remote?: string; remoteName?: string };
			revision?: string;
			branch?: string;
			start?: boolean;
	  }
	// Stop the daemon, evict it from the roster, and remove the linked
	// worktree (clean only). deleteBranch names the branch to `git branch -d`;
	// it is deleted only when it is still the worktree's checked-out branch
	// and not protected (default/base branch, main checkout's branch).
	| { type: "delete_worktree"; id: string; daemonId: string; deleteBranch?: string }
	// Guard evidence for the delete confirmation (linked/dirty/branch state);
	// answered by the unicast worktree_delete_info frame.
	| { type: "worktree_delete_info"; id: string; daemonId: string }
	// Branch picker for the New workspace popover: local branches of a
	// registered project (remote omitted), or the branches of one of its git
	// remotes via `git ls-remote` (falls back to cached refs). Answered by
	// the unicast project_branches frame.
	| { type: "list_project_branches"; id: string; projectId: string; remote?: string }
	// Run one worktree/project sync pass now (tab focus, group expand).
	// Fire-and-forget; results ride the roster/registered_projects broadcasts.
	| { type: "sync_projects"; id: string };

// ---------------------------------------------------------------------------
// Collab (TUI-mux): per-session collab host status, pushed to attached
// sockets as collab_status frames (also sent during the attach priming).
// ---------------------------------------------------------------------------

/** Wire-safe participant roster entry (structurally identical to pi-wire's Participant). */
export type CollabParticipantInfo = { name: string; role: "host" | "guest"; readOnly?: boolean };

/** Collab host status as broadcast to web clients. */
export type CollabWireStatus =
	| { state: "off" }
	| { state: "starting" }
	| {
			state: "live";
			link: string;
			viewLink: string;
			access: "view" | "control";
			browserLink?: string;
			browserViewLink?: string;
			relayUrl: string;
			roomId: string;
			participants: CollabParticipantInfo[];
			maxGuests: number;
	  }
	| { state: "error"; error: string };

/** The most recent finished tool call of a subagent (replaces the SDK's `recentTools` bulk). */
export interface SubagentLastTool {
	tool: string;
	args?: string;
	intent?: string;
	isError?: boolean;
}

/**
 * The slice of the SDK's `AgentProgress` that rides the wire: status, the
 * current/last tool, per-agent metrics (U04 renders these), and the resolved
 * model. The SDK's bulk `recentOutput` / `recentTools` arrays never leave the
 * daemon; `lastTool` is the one entry the web reads.
 */
export interface SubagentProgressFields {
	id: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolIntent?: string;
	currentToolStartMs?: number;
	lastTool?: SubagentLastTool;
	/** Run time so far, ms. */
	durationMs?: number;
	toolCount?: number;
	requests?: number;
	/** Cumulative input + output + cacheWrite tokens (the SDK's definition; excludes cacheRead). */
	tokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Cumulative cost in USD. */
	cost?: number;
	completionPercent?: number;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: string;
	resolvedModelIsFallback?: boolean;
	advisor?: boolean;
}

/**
 * Cumulative usage of one subagent, read from its stored transcript. Rides the
 * `workerList` roster row of an agent that has no live progress snapshot (a finished
 * agent, or any agent after the session restarted); absent when the transcript carries
 * no usage. `tokens` uses the same definition as `SubagentProgressFields.tokens`.
 */
export interface SubagentUsageFields {
	tokens: number;
	requests: number;
	cost: number;
}

/**
 * `subagent_progress` payload. The daemon sends at most one per agent per
 * second. The first frame of an agent is full (`task`/`assignment` included);
 * every later frame has `delta: true` and `progress` carries `id` plus only the
 * fields that changed since the previous frame. An absent field is unchanged;
 * `null` means the field was cleared. A client merges deltas over the last
 * state it holds. The `getSubagents` rows carry the merged state as a baseline
 * for a client that attached mid-run.
 */
export type SubagentProgressDelta = { id: string } & {
	[K in Exclude<keyof SubagentProgressFields, "id">]?: SubagentProgressFields[K] | null;
};

export interface SubagentProgressFrame {
	index: number;
	agent: string;
	task?: string;
	assignment?: string;
	parentToolCallId?: string;
	sessionFile?: string;
	delta?: true;
	progress: SubagentProgressDelta;
}

/**
 * Streaming sub-event of a wire `message_update`: an append keyed by content
 * block. A text/thinking delta carries only its block index and the appended
 * text; every other sub-event (block start/end, tool-call progress, done,
 * error) is a bare marker. The cumulative `partial` message, the settled block
 * text and the tool call payload never ride a per-token frame: the committed
 * message arrives once, on `message_end` (and in history for late joiners).
 */
export type WireAssistantMessageEvent =
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: Exclude<
				AssistantMessageEvent["type"],
				"text_delta" | "thinking_delta" | WireTurnMarker
			>;
			contentIndex: number;
	  }
	| { type: WireTurnMarker };

/** Sub-events that belong to the whole message, not a content block. */
type WireTurnMarker = "start" | "done" | "error";

/** `message_update` as it crosses the wire (assistant messages only). */
export interface WireMessageUpdate {
	type: "message_update";
	assistantMessageEvent: WireAssistantMessageEvent;
}

/** SDK session event as shipped in an `event` frame: `message_update` slimmed to a delta. */
export type WireSessionEvent =
	| Exclude<AgentSessionEvent, { type: "message_update" }>
	| WireMessageUpdate;

/**
 * Session-scoped frames as the server composes them, before broadcastTo
 * stamps the session handle. On the wire they always carry sessionId.
 */
export type SessionScopedFrame =
	// History: a small transcript ships as ONE frame with no `final` field (the
	// original shape); a transcript over the SSE backpressure cap ships as
	// byte-bounded sequential frames (`final: false` … `final: true`) that the
	// client accumulates until the `final` chunk completes the series.
	| { type: "history"; messages: AgentMessage[]; final?: boolean }
	| { type: "state"; state: WebSessionState; stats?: SessionStats }
	| { type: "event"; event: WireSessionEvent }
	// Live output of an in-flight bash/python call (streamId = the client's
	// bash-item id); broadcast session-scoped so every tab stays consistent.
	| { type: "bash_chunk"; id: number; text: string }
	| { type: "python_chunk"; id: number; text: string }
	// Phase 11: live output of an in-flight /btw side question (id = the
	// client's btw streamId); broadcast session-scoped like bash_chunk.
	| { type: "ephemeral_delta"; id: number; text: string }
	// A queued slash command starts running: its typed text is echoed into the transcript.
	| { type: "command_echo"; text: string }
	// Unicast answer to a "call" command.
	| { type: "call_result"; id: string; ok: boolean; data?: unknown; error?: string }
	| { type: "available_commands"; commands: AvailableSlashCommand[] }
	// Settings panel: fresh model after a setSetting mutation (TUI /settings parity).
	| { type: "settings_changed"; model: SettingsModel }
	| { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event"; payload: unknown }
	// Server-driven ExtensionUIContext dialog; the client answers with ui_response.
	| { type: "ui_request"; id: string; method: string; params: unknown }
	// The dialog above settled (answered via ui_response, or rejected when its
	// last target stream closed / the session closed). Ringed like ui_request
	// so a resuming stream replays the end AFTER the stale request (finding
	// #16) and every other live tab dismisses the dialog. Mirrors the collab
	// host's ui-request-end. `answeredBy` names the collab participant whose
	// answer settled the dialog elsewhere (the host or a writable guest).
	| { type: "ui_request_end"; id: string; answeredBy?: string }
	// Collab host status for the attached session (start/stop/live/error/off).
	| { type: "collab_status"; status: CollabWireStatus };

// Server → browser. Session-scoped frames on a bare omp-session carry NO
// sessionId (one live session; connect = attached). The fleet edge STAMPS the
// daemonId as sessionId when proxying, so clients proxied through the edge
// can guard daemon switches. The rest are global broadcasts or unicast
// answers (noted per variant).
export type ServerFrame =
	| (SessionScopedFrame & { sessionId?: string })
	// Unicast answer to list_sessions.
	| { type: "sessions"; sessions: SessionListEntry[] }
	// Unicast answer to list_daemon_sessions (the fleet edge answers it directly;
	// NOT ringed; lost answers are re-POSTed like projects).
	| { type: "daemon_sessions"; daemonId: string; sessions: SessionListEntry[] }
	// Unicast answer to list_files.
	| { type: "files"; files: string[] }
	// Unicast: OAuth URL to open (during a login call).
	| { type: "login_url"; url: string; launchUrl?: string; instructions?: string }
	// Unicast: provider needs a pasted code to finish login.
	| { type: "login_code_request"; requestId: string; title: string; placeholder?: string }
	// Unicast: socket is now attached to this handle; history, state and
	// available_commands follow immediately (in that order). The fleet
	// sidebar's state is signaled by the fleet edge's roster frame, never by
	// attached (the edge proxies the daemon's frame through unchanged).
	| { type: "attached"; sessionId: string }
	// Project-wide daemon broker roster (hub launch processes); global broadcast.
	| { type: "daemons"; daemons: DaemonInfo[] }
	// Unicast answer to daemon_logs.
	| {
			type: "daemon_logs_result";
			id: string;
			ok: boolean;
			text?: string;
			cursor?: number;
			state?: string;
			error?: string;
	  }
	// Unicast answer to daemon_stop / daemon_restart.
	| { type: "daemon_control_result"; id: string; ok: boolean; daemon?: DaemonInfo; error?: string }
	// Unicast answer to attach (fleet edge): settles the client's pending
	// attach by command id. Success carries the daemonId as sessionId;
	// failure carries the error. Added OMP_PROTO 2 additively; an older edge
	// that ignores the attach id never sends this frame, and the client's
	// pending-map timeout backstops it.
	| { type: "attach_result"; id: string; ok: boolean; sessionId?: string; error?: string }
	// --- omp-session readiness (R8) ---
	// Broadcast once the SDK session is live AND provider/model/auth has
	// resolved. Before it, prompt-family calls fail with a not_ready error.
	| { type: "ready"; readyAt: number }
	// --- Daemon identity (omp-session → any /events consumer) ---
	// FIRST event on every /events stream open (HTTP-level auth replaced the
	// hello handshake); the attach priming follows immediately.
	| {
			type: "hello_ok";
			proto: number;
			name: string;
			cwd: string;
			pid: number;
			version: string;
			sessionFile?: string;
	  }
	// --- Stream lifecycle (omp-session → the one stream being dropped) ---
	// Sent immediately before the stream ends when the SSE buffer exceeded
	// the backpressure cap: the daemon is ALIVE and the drop is recoverable
	// (resume via Last-Event-ID), so consumers must NOT treat the following
	// clean close as a dormant daemon. Per-stream only, never ringed.
	| { type: "stream_reset"; reason: string }
	// --- Fleet edge (omp-fleet → browser; a bare omp-session never sends these) ---
	// Global broadcast + unicast answer; the fleet sidebar's source.
	| { type: "roster"; daemons: DaemonEntry[] }
	| { type: "daemon_status"; daemonId: string; status: DaemonStatus; error?: string }
	// Edge-generated, fleet-scoped realtime activity for a ready daemon
	// (streaming / dialog-blocked). Derived by the fleet edge from the tapped
	// daemon frame stream and broadcast ONLY on change; primed once per known
	// daemon when a browser stream opens. Never carries a sessionId (it is
	// per-daemon, not per-attachment), never persisted, and never carries
	// tokens/endpoints; daemons never send it, so the edge's pipe forwarder
	// strips it like `daemons` broker rosters.
	| {
			type: "daemon_activity";
			daemonId: string;
			streaming: boolean;
			blocked: boolean;
	  }
	// Global broadcast: first-class registered projects. Sent when the
	// registry's project set changes (same trigger as the roster broadcast)
	// AND during new-stream priming (near the roster frame), so project
	// groups with zero daemons still render. Never carries tokens/endpoints.
	// `configPath` (additive, Phase 4) is the resolved fleet config path,
	// null when no config file exists (defaults apply); the roster's
	// first-run signal. Older edges omit it; clients treat it as null.
	| {
			type: "registered_projects";
			projects: RegisteredProject[];
			configPath?: string | null;
			/**
			 * Boot-static secret-free provider-profile catalog (frozen
			 * contract, additive). Absent from older fleets; clients treat
			 * it as an empty catalog. Never carries secret values or
			 * executable internals.
			 */
			providerProfiles?: PublicProviderProfile[];
	  }
	// Global broadcast: a poll-detected, on-disk worktree removal (the
	// daemon's cwd vanished between git-state poll ticks). Ringed so a
	// Last-Event-ID resume within the reclaim window still delivers the
	// toast once (client-side ring dedup guards the replay). Fleet-edge-only
	// (a bare omp-session never sends it) and never carries tokens/endpoints,
	// just daemonId + display name + the vanished path. Never sent for
	// UI-initiated delete_worktree/remove.
	| { type: "worktree_removed"; daemonId: string; name: string; path: string }
	// Unicast answer to add_project. `existing`: the resolved main checkout
	// was already registered (nothing changed).
	| {
			type: "add_project_result";
			id: string;
			ok: boolean;
			projectId?: string;
			existing?: boolean;
			error?: string;
	  }
	// Unicast answer to create_worktree / create_clone: the new row's id, or
	// the failure. Runtime progress rides the roster/daemon_status broadcasts.
	| { type: "workspace_create_result"; id: string; ok: boolean; daemonId?: string; error?: string }
	// Unicast answer to list_project_branches. `remotes` lists the project's
	// git remote names (origin first). `defaultBase` is the base a new branch
	// starts from (local: resolveBaseRef; remote: the remote's HEAD branch).
	// `cached`: ls-remote failed and the list comes from refs/remotes.
	| {
			type: "project_branches";
			projectId: string;
			remote?: string;
			branches: ProjectBranch[];
			remotes: string[];
			defaultBase?: string;
			cached?: boolean;
	  }
	// Unicast answer to worktree_delete_info: guard evidence for the delete
	// confirmation (linked identity, dirty counts, branch merge/push state).
	// Never carries tokens/endpoints. A failed git probe rides as
	// probeFailed (additive): the state is unproven, so deletion is refused.
	| {
			type: "worktree_delete_info";
			daemonId: string;
			linked: boolean;
			dirty: boolean;
			probeFailed?: boolean;
			git?: {
				added: number;
				modified: number;
				deleted: number;
				untracked: number;
				linesAdded?: number;
				linesDeleted?: number;
			};
			branch?: string;
			merged?: boolean;
			unpushed?: boolean;
			hasUpstream?: boolean;
			/** Why branch deletion is unavailable (protected or detached); absent when allowed. */
			branchDeleteRefused?: string;
			files?: string[];
			reason?: string;
	  }
	| { type: "error"; error: string };

/** One supervised long-running process (hub launch / daemon broker), wire-safe. */
export type DaemonInfo = {
	name: string;
	id: string;
	projectDir: string;
	state: string;
	pid?: number;
	createdAt: number;
	startedAt: number;
	readyAt?: number;
	readyPort?: number;
	readyHost?: string;
	exitedAt?: number;
	exitCode?: number;
	exitReason?: string;
	restartCount: number;
	outputBytes: number;
	owner?: string;
	persist: boolean;
	detached: boolean;
};

/**
 * The daemon roster merge key: `${projectDir}${DAEMON_KEY_SEP}${name}`.
 * Daemon names are unique per projectDir and several omp-sessions can share
 * a projectDir, so the server's broker poll (refreshDaemons), the fleet
 * edge's aggregator (daemons-aggregator.ts) and the client (state.ts /
 * BackgroundDaemonsBar) all key daemon entries by this composite. Single-sourced
 * here so the three layers cannot drift; the NUL separator cannot appear in
 * paths, which keeps the prefix-cleanup check in refreshDaemons unambiguous.
 */
export const DAEMON_KEY_SEP = "\u0000";
export function daemonsKey(info: { projectDir: string; name: string }): string {
	return `${info.projectDir}${DAEMON_KEY_SEP}${info.name}`;
}

export type SessionListEntry = {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	messageCount: number;
	/** First user prompt, capped at 500 chars (picker subtitle). Absent on older daemons. */
	firstMessage?: string;
	/** Session outcome for the picker status dot. Absent on older daemons. */
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
};
// ---------------------------------------------------------------------------
// Shared additive contracts (OMP_PROTO 2 frozen).
// Everything below is additive: optional fields, new method names gated by
// server-advertised Capability, new frames. No required shape, enum, ID, or
// seq semantics above changes. Consumers MUST gate on Capability.availability
// (never on version) and MUST treat absent fields as unavailable.
// ---------------------------------------------------------------------------

/**
 * C03: stable scope binding every mutation to a workspace/session/attachment
 * generation. IDs are opaque server strings; the browser never uses message
 * text, list index, or filename display strings as identity.
 */
export interface SessionScope {
	workspaceId: string;
	sessionId: string;
	generation: string;
}

/** C03: stable anchor to one transcript entry at a content revision. */
export interface EntryAnchor {
	sessionId: string;
	entryId: string;
	revision: string;
}

/** C03: stable key for one live worker agent inside a session. */
export interface WorkerKey {
	sessionId: string;
	agentId: string;
}

/**
 * C04: cursor/revision paging contract for graph/transcript children. Opaque
 * cursor; the server rejects stale scope/revision instead of serving overlap.
 */
export interface PageCursor {
	cursor?: string | null;
	revision: string;
}

/**
 * C05: which durable draft owns an unsent composer buffer. Main is preserved
 * across focus changes; the server owns durable agent state, the store owns
 * normalized mirrors, components own transient presentation only.
 */
export type DraftScope =
	| { kind: "main"; sessionId: string; branchId?: string }
	| { kind: "worker"; sessionId: string; agentId: string }
	| { kind: "side"; sessionId: string; sideSessionId: string };

/**
 * Settings effective-value provenance. `layer` is the owning store layer;
 * `origin` names the source kind. Never carries environment credential values.
 */
export type SettingOrigin = "default" | "global" | "project" | "runtime" | "cli" | "env";

/** One setting's effective value plus provenance, unset eligibility, warnings, and effect timing. */
export interface SettingView {
	path: string;
	effective: unknown;
	source: SettingOrigin;
	explicit?: { value: unknown; layer: string };
	canUnset: boolean;
	warnings: string[];
	effect: "live" | "next-session" | "restart";
}

/**
 * Durable review anchor discriminated union. Diff/file anchors carry commit
 * base/head plus side/range plus a contentHash so drift marks them stale
 * instead of silently moving them. Never posts to GitHub implicitly.
 */
export type ReviewAnchor =
	| { kind: "entry"; anchor: EntryAnchor }
	| {
			kind: "diff";
			repositoryId: string;
			base: string;
			head: string;
			path: string;
			side: "old" | "new";
			start: number;
			end: number;
			contentHash: string;
	  }
	| { kind: "file"; path: string; start: number; end: number; contentHash: string }
	| { kind: "text"; text: string; contentHash: string };

/**
 * C02: server-advertised capability map carried on the attach priming and state
 * frames. Only verdicts the daemon computes at runtime appear here. Absent map or
 * absent key means unavailable (never guess from version); unknown keys are ignored.
 */
export interface ServerCapabilities {
	git?: Capability;
}

// ---------------------------------------------------------------------------
// P3 review-surface DTOs (G02/Git, G05/plan, G06/annotations, G16/todos).
// Additive vocabulary for sibling-lane domain modules; server rows land with
// the P3 service factories and gate behind the keys above. Absent = unavailable.
// ---------------------------------------------------------------------------

/** One changed path in the daemon-bound repository adapter snapshot (G02). */
export interface GitPathEntry {
	path: string;
	origPath?: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
	additions?: number;
	deletions?: number;
}

/** Narrow repo snapshot: fingerprints gate every mutation against drift (G02). */
export interface GitStatusDto {
	available: boolean;
	reason?: string;
	cwd: string;
	branch: string | null;
	clean: boolean;
	indexFingerprint: string;
	worktreeFingerprint: string;
	eligible: { stage: boolean; commit: boolean; reason?: string };
	unstaged: GitPathEntry[];
	staged: GitPathEntry[];
	head: {
		sha: string;
		shortSha: string;
		subject: string;
		authorName: string;
		authorEmail: string;
		authorDate: string;
	} | null;
}

/** Versioned plan under review; stale version refuses, disconnect never approves (G05). */
export interface PlanReviewDto {
	reviewId: string;
	planFilePath: string;
	/** Plan markdown under review, so the sheet renders it without reading the file. */
	content?: string;
	title: string;
	contentHash: string;
	version: number;
	status: "waiting" | "approved" | "changes_requested" | "dismissed";
	annotations?: ReviewAnnotationDto[];
}

/** One durable anchored-feedback annotation; drift marks stale/orphaned, never moves silently (G06). */
export interface ReviewAnnotationDto {
	id: string;
	author: "operator" | "agent";
	source: "diff" | "file" | "message" | "reply" | "text" | "plan";
	anchor: ReviewAnchor;
	note: string;
	revision: number;
	status: "current" | "stale" | "orphaned";
	createdAt: number;
}

/** Todo board mirror: SDK TodoPhase verbatim plus a revision fingerprint (G16). */
export interface TodoBoardDto {
	phases: TodoPhase[];
	revision: string;
	selected?: { phase: number; task: number };
}

/** omp CLI, provider-auth, and default-model probe (GET /ctl/omp-setup). */
export interface OmpSetupStatus {
	/** The omp CLI is on PATH or at the standard ~/.bun/bin location. */
	ompInstalled: boolean;
	/** Providers with usable auth (SDK view: storage, config keys, env). */
	providers: string[];
	/** The default-role model selector from settings, or null. */
	defaultModel: string | null;
	/** Probe failure detail (missing SDK, unreadable config), else null. */
	error: string | null;
}
