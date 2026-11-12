import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AvailableSlashCommandSource } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools";
import type { Capability } from "./browser-ui-contract";
import type { ProviderKind } from "#lib/runtime/provider-protocol";

// ---------------------------------------------------------------------------
// Local copies of the RPC wire types (structurally verbatim from the
// @oh-my-pi/pi-coding-agent@17.1.8 RPC mode's protocol type definitions).
// The server no longer spawns the RPC child, so the protocol owns these.
// ---------------------------------------------------------------------------

/**
 * Why a model-browser row is unusable: no credentials for its provider, or the
 * provider is disabled. The web derives the sentence (`lockMessage`); the code
 * keeps every row small enough for one callback envelope on a full registry.
 */
export type ModelLockReason = "credentials" | "disabled";

/** A model-browser row: every registry model, with the reason it cannot be used when it cannot. */
export type ModelBrowserEntry = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning"> & {
	/** SDK `modelKind(model)`: "chat" for session-switchable models; others (search, tts, ...) only fill roles. */
	kind: ModelKind;
	/** Absent = usable. */
	locked?: ModelLockReason;
	/** Concrete thinking efforts the model supports, SDK order; absent when the model does not reason. */
	thinkingEfforts?: string[];
	/** Present (true) only when the session has a model scope and this row is in it; the `^` completion follows the scope. */
	scoped?: true;
};

/** Settings layer that owns a model preset's effective definition. */
export type ModelPresetSource = "global" | "project" | "overlay" | "runtime";

/** One saved model preset with its contents, as listed by `getModelPresets`. */
export interface ModelPresetDetail {
	name: string;
	/** Layer owning the effective preset; only "global" can be deleted or overwritten from the web. */
	source: ModelPresetSource;
	/** role -> "provider/id" or "provider/id:level"; {} when invalid. */
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
	/** Parse error for a malformed hand-edited preset; absent when valid. */
	invalid?: string;
}

/** `getModelPresets` answer: sorted names, the active (matching) preset, and per-preset details. */
export interface ModelPresetsAnswer {
	names: string[];
	active?: string;
	presets: ModelPresetDetail[];
}

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
	/** Role value exactly as configured (what a preset stores and matches against); present
	 * whenever the role is configured, even when it resolves to no available model. */
	value?: string;
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
	/**
	 * Ids of the ui_requests pending on the session that wait on the user (the
	 * `id` carried by the `ui_request`/`ui_request_end` frames; `browser_ui`
	 * display contributions are left out, as they never block). Lets the fleet
	 * edge rebuild a session's blocked state from any state frame, notably the one
	 * published at every pair-up, which the delta-only control mirror cannot replay.
	 */
	pendingUiRequestIds?: string[];
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

/** Description characters `getToolSchemas` keeps per tool when asked for a brief list. */
export const TOOL_BRIEF_DESCRIPTION_CHARS = 120;

/** One tool as `getToolSchemas` answers `[{ brief: true }]`: name and a description cut to `TOOL_BRIEF_DESCRIPTION_CHARS`. */
export type ToolBriefInfo = Pick<ToolSchemaInfo, "name" | "description">;

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

/**
 * Serialized-size ceiling of a `getSubagentImage` answer. A call answer must fit one callback envelope
 * (ENVELOPE_MAX_BYTES, 1 MiB) with the call_result wrapper around it; an image whose base64 answer would
 * pass this is reported as `too_large` instead of failing the send.
 */
export const SUBAGENT_IMAGE_MAX_ANSWER_BYTES = 900 * 1024;

/**
 * Answer of `getSubagentImage({ subagentId, hash })`: one image a subagent transcript references as
 * `blob:sha256:<hash>`. `missing` means the transcript references the hash but the session's blob store no
 * longer holds it. A hash the transcript does not reference, or one that is not a sha256 hex digest, is an error.
 */
export type SubagentImageResult =
	| { status: "ok"; data: string; mimeType: string }
	| { status: "too_large"; bytes: number }
	| { status: "missing" };

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
	/** Slash commands waiting for turn end, in run order: commands the SDK rejects while a turn runs, a `/compact` queued with the follow-up key, and the follow-ups held behind it (plain text). */
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
/** Args of `queueCompaction`: the parsed `/compact [soft|remote|snapcompact] [focus]`, as `compactEx` takes it. */
export interface QueueCompactionArgs {
	mode?: string;
	instructions?: string;
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

/**
 * getSettings answers this instead of the full model when the caller passes
 * `{ paths }` as its first argument (and `GET /ctl/settings?paths=a,b` does
 * the same on the fleet): just the effective value of each known path, so a
 * page can read the few settings it needs at attach without the whole model.
 * Unknown paths are omitted. An older session or control plane ignores the
 * option and answers the full SettingsModel, which carries the same values.
 */
export interface SettingValues {
	revision: number;
	target: "current-session" | "future-sessions";
	values: Record<string, unknown>;
}

/** Most paths one `getSettings({ paths })` call may name. */
export const MAX_SETTING_VALUE_PATHS = 128;

// ---------------------------------------------------------------------------
// Installed plugins (Integrations > Plugins). Backed by the SDK plugin manager
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
	/** File mcpEnable / mcpDisable write: the config declaring the server, or the user mcp.json denylist. Absent from older sessions. */
	toggleFile?: string;
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

export interface McpToolParameter {
	name: string;
	/** JSON Schema type, e.g. "string" or "array". */
	type?: string;
	required: boolean;
	description?: string;
}

export interface McpInspection {
	/** Implementation the server reported at initialize. */
	server?: { name: string; version?: string };
	/** `parameters` is absent from older sessions. */
	tools: Array<{
		name: string;
		title?: string;
		description?: string;
		parameters?: McpToolParameter[];
	}>;
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

/** getSkillDetail answer: the summary plus what the TUI inspector shows. */
export interface SkillDetail extends SkillSummary {
	/** SKILL.md body, frontmatter stripped. Untrusted markdown. */
	body: string;
	alwaysApply: boolean;
	globs: string[];
}

// ---------------------------------------------------------------------------
// omp-session / omp-fleet contract (docs/src/content/docs/running.md). OMP_PROTO gates
// fleet↔omp-session drift (the collab COLLAB_PROTO pattern); bump on any
// breaking change to the transport or frame shapes.
//
// Transport: every client connection (a browser to the fleet edge, a direct
// client to a standalone omp-session) is ONE WebSocket on GET /ws, the browser socket
// (lib/wire/browser-socket.ts is the wire). Client → server commands are
// `{"cmd": ClientCommand}` messages, acked or nacked in band; server → client
// frames are `{"seq": N, "frame": ServerFrame}` messages. Auth is judged at
// the upgrade (R14): loopback exempt, off-loopback bearer via the Authorization
// header or the `token` query; a refusal is an upgrade followed by a typed
// close code (4401/4403/4426), not an HTTP status. hello_ok is the
// FIRST frame on every socket open (session identity), followed by the attach
// priming (attached → history → state → collab_status → available_commands →
// ready).
// ---------------------------------------------------------------------------

/** Bump on any breaking frame change.
 *  3: project/worktree redesign (remote enrollment, `RosterEntry.mode`,
 *  `list_projects`/`projects`, `add_worktree` removed).
 *  4: infra remediation (kata kfg5). Adds per-block streaming deltas,
 *  `roster_delta`, `getToolSchemas`, and a 32 MiB command cap. Removes the
 *  system prompt, tool schemas, and steering/follow-up/interrupt/inspect-image
 *  modes from `state`, the `subagent_event` frame, and uncalled methods
 *  (A27, `annotationUpdate`, `annotationReanchor`). Session events are
 *  slimmed (kata ns60, same unreleased 4): `tool_execution_update` carries the
 *  appended output (`WireToolExecutionUpdate`), `turn_end` is a bare marker,
 *  `agent_end` carries `lastAssistant` instead of `messages`, and tool-result
 *  `message_start`/`message_end` are not sent; see CHANGELOG.md
 *  "Infra remediation" and "Performance and efficiency".
 *  5: every client connection (browser to fleet, direct client to a
 *  standalone session) is one WebSocket on `GET /ws` (lib/wire/browser-socket.ts)
 *  instead of `GET /events` SSE + `POST /command`. Same unreleased 5: workspace
 *  labels are removed (`RosterEntry.labels`, `spawn.labels`).
 *  6: sense-A "daemon" renamed: process ids are workspaceId (attach, attach_result, fleet frames and commands), the edge's per-frame attachment stamp on session-scoped frames is `scope` (also `attached.scope`), DaemonEntry->RosterEntry, DaemonStatus->SessionStatus (never-produced "session" and "resolving" literals removed), daemon_status->session_status, daemon_activity->session_activity, daemon_sessions->workspace_sessions, list_daemon_sessions->list_workspace_sessions, roster.daemons->roster.entries, stream_reset reason session_resync. */
export const OMP_PROTO = 6;

// --- Client connection constants (browser socket, shared by the session and the fleet) ---

/** Keepalive interval: a server sends a ping on every idle client connection this often. */
export const CLIENT_KEEPALIVE_MS = 15_000;
/**
 * Clients treat this much total silence (no frame, no ping) as a dead
 * peer → close + reconnect. Generous vs CLIENT_KEEPALIVE_MS so one delayed
 * ping never trips it.
 */
export const CLIENT_SILENCE_DEADLINE_MS = 30_000;
/** Bounded replay ring of recent deltas, per session / per browser client. */
export const CLIENT_RING_CAP = 10_000;
/**
 * Byte budget for one replay ring (finding #5): a ring must be bounded in
 * BYTES, not only in entries. Multi-megabyte deltas (large bash chunks,
 * base64 image payloads) across thousands of entries would otherwise
 * balloon memory.
 * Sized at 2× CLIENT_BACKPRESSURE_BYTES so the ring comfortably holds the
 * post-drop replay window of a stream that was buffered up to the cap. The
 * entry cap (CLIENT_RING_CAP) remains a secondary bound for many-small-delta
 * bursts.
 */
export const CLIENT_RING_BYTES = 8 * 1024 * 1024;
/**
 * First seq assigned to post-priming deltas (a session-global counter).
 * Priming frames carry seqs 1..k (k < DELTA_SEQ_START) per connection, so a
 * resume point (`after`) below this value means "stale/empty client: priming
 * already carries full current state". The session replays ring deltas with
 * seq > max(after, snapshotSeq-1). The snapshot mark (the next delta
 * seq captured before the priming snapshot is built) bounds the overlap, so
 * a resume never re-delivers deltas whose effects are inside the fresh
 * priming (finding #2: no duplicated items after a resume).
 */
export const DELTA_SEQ_START = 1024;
/** Per-client send-buffer cap: beyond it the connection is closed (drop-and-resume). */
export const CLIENT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
/**
 * A client socket whose send buffer holds unread bytes and has not drained for
 * this long has stopped reading and is closed 4503 (resume via `after`).
 * Servers check it on their keepalive sweep.
 */
export const CLIENT_STALL_MS = 30_000;
/**
 * Command idempotency: how long an id is remembered, how many recorded
 * ANSWERS stay replayable, and the flood backstop on remembered ids.
 * Remembering an id is what makes a re-send safe (it is re-acked, never
 * re-dispatched), and a browser recovering a lost answer re-sends every 5s for
 * the whole window, so id memory has to cover a window of real traffic rather
 * than a handful of commands: evicting a live id early would let the replay
 * execute the command twice. Recorded answers are kept under a count cap AND a
 * byte budget: a browser re-sends after 5s, so an answer must survive that
 * replay window at the burst rate (a settings write answers with the whole
 * model, so a count alone evicts the answers the replays are waiting for). An
 * evicted answer degrades a replay to "acked, no answer" (the caller's
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
 * a spawner must not retry it; the session's last stderr line names the file
 * and the holder. Same value as the fleet's own state-lock conflict exit.
 */
export const OMP_SESSION_EXIT_SESSION_LOCKED = 77;

/**
 * omp-session exit code when `--resume <file>` names a durable session the
 * session cannot restore (file missing, unreadable, or recorded under another
 * cwd). Deterministic: a spawner must not retry it, and the session never boots
 * a fresh session in its place; the last stderr line names the file and the
 * reason.
 */
export const OMP_SESSION_EXIT_RESUME_FAILED = 78;

/**
 * The `OMP_SESSION|` stdout contract line (R6b). A session that binds its
 * direct listener prints `listening` immediately after bind, before session
 * creation. A fleet-managed session (started with `--fleet-stdin`) binds no
 * listener and prints no listening line. The line is informational for whoever
 * launched the session (the terminal, a supervisor, or the session log); the
 * fleet does not parse it.
 */
export type StdoutContractLine = { event: "listening"; bind: string; port: number };

/** Session lifecycle as surfaced by omp-fleet (session_status frame). */
export type SessionStatus =
	| "spawning"
	| "connecting"
	| "ready"
	| "asleep"
	| "reconnecting"
	| "error";

// --- Clone workspace identity: workspace/session lifecycle facts the fleet
// edge surfaces on the roster (optional RosterEntry fields).

/** How a workspace's checkout was produced. */
export type WorkspaceKind = "worktree" | "clone" | "direct";

/** Fleet-side desired state of a workspace. */
export type DesiredState = "running" | "stopped";

/** Provider-managed workspace lifecycle: preparation → runtime → callback → ready; failed is terminal. */
export type LifecycleStage = "preparation" | "runtime" | "callback" | "ready" | "failed";

/**
 * Secret-free capability view of a fleet provider profile (frozen contract).
 * Safe to
 * cross trust boundaries: never carries the executable, image/namespace
 * details, or secret reference VALUES, only their names. Lifted from
 * apps/fleet/provider-profile.ts (which re-exports this type) so browser/CLI
 * consumers import the single wire source from lib/wire/protocol.ts.
 */
export interface PublicProviderProfile {
	/** Profile id (the config map key). */
	id: string;
	provider: ProviderKind;
	/**
	 * Who prepares a new clone's volume (the kind's `PROVIDER_CAPABILITIES`
	 * entry): `"fleet"` clones from a local path or a remote, `"provider"`
	 * prepares in place from a remote only, so the UI offers no local source.
	 */
	preparation: "fleet" | "provider";
	/** Declared resource limits, when any. */
	resources?: { cpu?: string; memory?: string };
	/** Sandbox network mode (bwrap): "host" | "isolated"; absent = isolated default. */
	network?: "host" | "isolated";
	/** Declared storage class name, when any. */
	storageClassName?: string;
	/** Secret reference names only; values never appear here. */
	secretRefNames?: string[];
}

/** One session in the omp-fleet roster (roster frame). */
export interface RosterEntry {
	workspaceId: string;
	name: string;
	cwd: string;
	project: string;
	worktreeOf?: string;
	/**
	 * The registered project this session belongs to (source: fleet edge
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
	status: SessionStatus;
	lastSessionFile?: string;
	/** Title of the session's last session file (source: fleet edge roster, probed from the
	 *  lastSessionFile JSONL title slot). */
	sessionTitle?: string;
	/** True when the session's current/last session file has no messages (a new/empty
	 *  session); fleet-probed like sessionTitle. */
	sessionEmpty?: boolean;
	readyAt?: number;
	uptime?: number;
	pid?: number;
	error?: string;
	// --- Clone workspace identity (additive; older edges omit these) ---
	/** How the session's checkout was produced (source: fleet edge roster; absent for legacy entries). */
	workspaceKind?: WorkspaceKind;
	/** Fleet-side desired state of the session's workspace (source: fleet edge roster; absent = legacy). */
	desiredState?: DesiredState;
	/** Provider profile the session's workspace runs under (source: fleet edge roster; absent = unmanaged/legacy). */
	providerProfileId?: string;
	/** Provider lifecycle stage of the session's workspace (source: fleet edge roster; absent = legacy/local session). */
	lifecycleStage?: LifecycleStage;
	/** Last workspace lifecycle failure detail (source: fleet edge roster; present only after a failed stage). */
	lifecycleError?: string;
	/**
	 * True for a clone whose source is a path on the fleet host (source: fleet edge roster;
	 * absent for remote-source clones and every non-clone row). Gates the "Fetch into project"
	 * row action: only a clone whose volume the fleet can read has a branch to fetch.
	 */
	localSource?: true;
}

/** POST /ctl/clones/:workspaceId/fetch-into-project answer: the clone's branch now in the project's main repo. */
export interface CloneFetchResult {
	workspaceId: string;
	/** Short branch name fetched (the clone's own branch). */
	branch: string;
	/** Main checkout the branch was fetched into. */
	projectPath: string;
	/** created: the project had no such branch; updated: fast-forwarded; up-to-date: already the same commit. */
	outcome: "created" | "updated" | "up-to-date";
	/** The project branch's commit after the fetch. */
	commit: string;
	/** The project branch's commit before an `updated` fetch. */
	previousCommit?: string;
}

/** `predictNextMessage` answer: the predicted next messages of one billed request. */
export interface PredictNextMessageReply {
	/** The most likely message; null when none is ready (off, no model, streaming, compacting, skipped, superseded, timed out). */
	text: string | null;
	/**
	 * Every alternative, most likely first (`text` is the first). Present only when the request
	 * returned two or more, i.e. with `composer.predictionAlternatives` on; older clients read `text`.
	 */
	choices?: string[];
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
 * in the fleet state file. A project is a git repo's main checkout (a picked
 * subdirectory or linked worktree resolves to it) or a plain directory with no
 * git repo above it; `path` is its realpath and `name` its basename. Local
 * sessions carry the matching `projectId` on the roster.
 */
export interface RegisteredProject {
	projectId: string;
	/** Realpath of the project directory (a git repo's main checkout, or a plain directory). */
	path: string;
	/** Basename of the realpath (display name). */
	name: string;
	/** Epoch ms of registration. */
	addedAt: number;
	/** True when the project directory is gone, or a git project's main checkout is bare or unreadable (fleet sync). Its rows cannot start. */
	missing?: boolean;
	/** `false` when the directory has no `.git` (fleet watcher, never persisted): no branch, stats, worktrees, or clones. Absent means a git repo. */
	git?: false;
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
	| "queueCompaction"
	| "takeQueuedCommand"
	| "runQueuedCommandNow"
	| "popLastQueuedMessage"
	| "clearQueue"
	| "abort"
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
	// composer.predictions next-message prediction (SDK controller, same gates); answers a
	// PredictNextMessageReply.
	| "predictWord"
	| "predictWordFeedback"
	| "predictNextMessage"
	| "predictionShown"
	| "predictionAccepted"
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
	| "getSubagentImage"
	| "subagentSteer"
	| "subagentAbort"
	| "materializeSession"
	| "clearSession"
	| "deleteSession"
	| "unsetSetting"
	| "getSessionGraph"
	| "navigateTree"
	| "reanswerAsk"
	| "resumeAfterAskReanswer"
	| "rewindTurn"
	| "findTurnEntry"
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
	| "getSkillDetail"
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
	| "annotationRemove"
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
	| "resumeRename"
	| "resumeDelete"
	| "btwList"
	| "btwSearch"
	| "btwPage"
	| "btwStart"
	| "btwFollowUp"
	| "btwCancel"
	| "btwInject"
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
	| "exportDownload"
	| "getJobTree"
	| "getJobDetail"
	| "getPromptCacheStatus"
	| "cancelJob"
	| "getShellVisualization";

/**
 * Methods that change no session state. The session skips the post-mutation
 * state broadcast for them, and the browser re-posts a parked one without its
 * attachment scope (a read wants the answer for the session attached now).
 * Everything else is a mutation and keeps the scope it was issued under.
 */
export const READ_ONLY_METHODS: Readonly<Partial<Record<WebMethodName, true>>> = {
	getSessionStats: true,
	getModelBrowser: true,
	getModelPresets: true,
	getSettings: true,
	getSkillsState: true,
	getSkillDetail: true,
	getMcpState: true,
	mcpTest: true,
	mcpInspect: true,
	listPlugins: true,
	getPluginConfig: true,
	getQueuedMessages: true,
	getLoginProviders: true,
	getSubagents: true,
	getSubagentMessages: true,
	getSubagentImage: true,
	formatSessionAsText: true,
	getContextBreakdown: true,
	annotationList: true,
	todoGet: true,
	todoExport: true,
	getSessionGraph: true,
	findTurnEntry: true,
	getModelMentions: true,
	compactionSnapshot: true,
	btwList: true,
	btwSearch: true,
	btwPage: true,
	btwCopy: true,
	btwPromotePreview: true,
	advisorGetStatus: true,
	advisorTranscript: true,
	loopPreview: true,
	loopPolicy: true,
	vibeStatus: true,
	downloadManifest: true,
	getResumeCapabilities: true,
	getJobTree: true,
	getJobDetail: true,
	getPromptCacheStatus: true,
	// Args `[{ toolCallId, subagentId?, cursor? }]`; answers `ShellVizDto` (an explicit `available: false` for an unknown call or one with no trace, never an error).
	getShellVisualization: true,
	resumeResolve: true,
	// Args `{ query?, limit?, allProjects?, phase?: "preliminary" | "complete" }` (additive `phase`; absent =
	// "complete", the full scan). "preliminary" answers at once with the rows history.db titles
	// (candidates with `partial: true`: id, sessionFile, title, createdMs, modifiedMs, size, pinned,
	// scope; no cwd, firstMessage, messageCount or status) and `complete: false`, while the scan keeps
	// running; the "complete" call that follows takes it over. Answers add `complete: boolean`
	// (absent from a session started before the field existed: the list is complete).
	resumeList: true,
	gitStatus: true,
	gitFileDiff: true,
	getToolSchemas: true,
	predictWord: true,
	predictWordFeedback: true,
	// Prediction metrics feedback for the live `predictNextMessage` prediction; neither changes session
	// state, so neither broadcasts one. `predictionShown` takes no args (the composer painted the ghost or
	// the `⇥ N more` hint for the first time); `predictionAccepted` takes `[rank]`, a non-negative integer,
	// the alternative Tab, Right or the list inserted. Both answer `{}` and do nothing without a live
	// prediction; the prediction retires when the next turn or compaction starts, the session changes,
	// or a new `predictNextMessage` asks.
	predictionShown: true,
	predictionAccepted: true,
};

/**
 * Methods that replace the attached session's identity (a new session id and
 * transcript). The SDK mints the new id partway through the call, so until the
 * call's answer lands the session's identity runs ahead of the `sessionScope`
 * every client last received: a call sent in that gap carries the old scope.
 * The server answers these only after the history and state resync; clients
 * hold their own sends while one is pending.
 */
export const SESSION_REPLACING_METHODS = [
	"newSession",
	"switchSession",
	"branch",
	"fork",
	"handoff",
	"clearSession",
	"deleteSession",
] as const satisfies readonly WebMethodName[];

// Client → server (`{"cmd": ...}` messages on the browser socket; one command per message, acked).
// Routing is by STREAM ATTACHMENT: on omp-session a /ws socket is attached
// to the single live session from open (connect = attached), so call/
// login_code/ui_response implicitly target it. `attach` exists only at the
// fleet edge, where it selects the session to proxy.
// Every command carries a client-supplied `id` for idempotency: the
// server dedups within a window (COMMAND_DEDUP_WINDOW_MS), remembering ids up
// to COMMAND_DEDUP_ID_CAP and replayable answers up to COMMAND_DEDUP_ANSWER_CAP,
// and acks duplicates again; answers ride the socket as frames.
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
	// Fleet edge only: attach this stream to the session with this id
	// (the edge proxies it through; a bare omp-session never receives attach).
	// `resume` (additive): the reconnect's re-attach to the session this client
	// was viewing. When the edge still holds the dropped socket's session channel
	// and its replay ring covers the dial's `after`, it answers `resumed` and
	// sends no priming; otherwise the attach is an ordinary one.
	| { type: "attach"; id: string; workspaceId: string; resume?: true }
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
	| { type: "spawn"; id: string; cwd: string; template?: string }
	// Resume this exact session file instead of the session's lastSessionFile;
	// omitted = resume the last session (today's behavior). The fleet edge
	// validates it against the session's worktree session listing.
	| { type: "spawn_resume"; id: string; workspaceId: string; sessionFile?: string }
	| { type: "stop"; id: string; workspaceId: string }
	// Fleet edge only: list sessions in a session's worktree (fleet-edge handled,
	// answered with a unicast `workspace_sessions` frame; a bare omp-session
	// rejects it like the other fleet-only commands). `limit` (integer) is the
	// row count: omitted = WORKSPACE_SESSIONS_DEFAULT_LIMIT, clamped to 1..WORKSPACE_SESSIONS_MAX_LIMIT.
	| { type: "list_workspace_sessions"; id: string; workspaceId: string; limit?: number }
	// Stop the session AND evict it from the roster (registry removal).
	| { type: "remove"; id: string; workspaceId: string }
	// Register a project. `path` may be a repo's main checkout, a linked
	// worktree, or a subdirectory: the fleet registers the main checkout. A
	// path with no `.git` at or above it registers as itself, a plain folder
	// (`git: false` on its registered_projects entry); bare repos are refused.
	// Registration never spawns; the fleet sync adds one asleep row per
	// checkout (one default row for a plain folder). Answered by
	// add_project_result.
	| { type: "add_project"; id: string; path: string }
	// Deregister a project and drop all of its rows (running sessions are
	// stopped, transcripts kept, disk untouched). Refused while a clone
	// workspace still belongs to it.
	| { type: "remove_project"; id: string; projectId: string }
	// Worktree creation (projectId from the registered_projects frame):
	// a new branch from baseRef, or an existing local branch. start:true also
	// spawns a session on the worktree; progress rides the roster/session_status
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
	// Stop the session, evict it from the roster, and remove the linked
	// worktree (clean only). deleteBranch names the branch to `git branch -d`;
	// it is deleted only when it is still the worktree's checked-out branch
	// and not protected (default/base branch, main checkout's branch).
	| { type: "delete_worktree"; id: string; workspaceId: string; deleteBranch?: string }
	// Guard evidence for the delete confirmation (linked/dirty/branch state);
	// answered by the unicast worktree_delete_info frame.
	| { type: "worktree_delete_info"; id: string; workspaceId: string }
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
 * session; `lastTool` is the one entry the web reads.
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
	/** The agent's current step in its own words (one line), from its periodic completion probe. */
	stage?: string;
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
 * `subagent_progress` payload. The session sends at most one per agent per
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

/**
 * One eval status event on the wire (`EvalStatusEvent` slimmed): its scalar
 * fields only, strings clipped, never the helper's `preview` text. See `slimEvalLive`
 * (lib/wire/tool-live.ts).
 */
export type WireEvalStatusEvent = { op: string } & Record<string, string | number | boolean>;

/**
 * Live status of a running eval call: the newest status events (a `log()` loop,
 * `mcp_progress`, `agent()` snapshots) and how many older ones the card leaves
 * behind. Re-sent whole when it changes; settled calls carry the full log in
 * the result details instead.
 */
export interface WireEvalLive {
	kind: "eval";
	status: WireEvalStatusEvent[];
	/** Events older than `status`, dropped by the SDK's bounded log or by the newest-N cut. */
	elided?: number;
}

/** One watched job of a running `wait` call (the SDK's `JobSnapshot` without results or widget). */
export interface WireWaitJob {
	id: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	/** What the model said the job is for (SDK 18.17.0 `JobSnapshot.intent`); rows show it in place of the label. */
	intent?: string;
	/** Run time when this frame was cut; a running job's clock is advanced by the receiver. */
	durationMs: number;
	/**
	 * Epoch ms the job settled (SDK 18.18.6 `JobSnapshot.settledAtMs`); absent while it runs
	 * and on sessions before 18.18.6. Compared with the wait call's start, it tells a job that
	 * finished during the wait from one that had already finished before it.
	 */
	settledAtMs?: number;
	exitCode?: number;
	/** A task agent's current step in its own words. */
	stage?: string;
	/** A task agent's self-estimated completion, 0-100. */
	completionPercent?: number;
}

/** Live job tiles of a running `wait` call; re-sent when a job's status, label, stage or completion changes (not on every clock tick). */
export interface WireWaitLive {
	kind: "wait";
	jobs: WireWaitJob[];
}

/** The part of a running tool's partial `details` the card renders live; the settled `details` ride `tool_execution_end`. */
export type WireToolLive = WireEvalLive | WireWaitLive;

/** A background job's state as the SDK reports it in a backgrounded call's frames (`details.async.state`). */
export type WireAsyncState = "running" | "completed" | "failed" | "cancelled";

/**
 * The job frame of a backgrounded bash, eval or task call: a call that returned
 * with `details.async.state === "running"` keeps receiving updates as its job
 * runs, the last one carrying the job's terminal state. The partial `details`
 * never ship whole, so this is the only part of them the card needs.
 */
export interface WireAsyncFrame {
	state: WireAsyncState;
	/** Exit code of a failed command (`details.exitCode`), when the SDK reports one. */
	exitCode?: number;
}

/**
 * `tool_execution_update` as it crosses the wire: what a running tool's card
 * shows, not the SDK's partial result. The SDK repeats the whole accumulated
 * output (and the call's args and details) in every update; here a growing
 * output rides as the appended text only, and an update that changes nothing
 * the card shows is not sent. The settled output arrives on `tool_execution_end`;
 * a late joiner is primed with the accumulated output of every running call.
 */
export interface WireToolExecutionUpdate {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	/**
	 * The partial's output text (`extractText` of the SDK partial result). With
	 * `append` it is only the text added after the call's previous update.
	 */
	output: string;
	/** `output` continues the card's text instead of replacing it. */
	append?: true;
	/** Images of the partial result, replacing the card's; omitted while unchanged. */
	images?: ImageArg[];
	/**
	 * Live status of an eval or wait call, replacing the card's; omitted while
	 * unchanged (an update whose only news is `live` carries `output: ""` with
	 * `append`). A late joiner is primed with the last one sent.
	 */
	live?: WireToolLive;
	/**
	 * The job frame of a call that returned while its background job keeps running
	 * (see `WireAsyncFrame`); omitted while unchanged. An update whose only news is
	 * the job's state carries `output: ""` with `append`. A late joiner is primed with the last one sent.
	 */
	async?: WireAsyncFrame;
	/**
	 * The `out://` replies of a bash or eval call so far (`details.replies`, oldest first):
	 * text the call wrote to the user, shown as prose after its card. Always the whole list,
	 * replacing the card's; omitted while unchanged. An update whose only news is a new reply
	 * carries `output: ""` with `append`. A late joiner is primed with the last one sent.
	 */
	replies?: string[];
}

/** `turn_end` as it crosses the wire: a bare marker (the assistant message and tool results already went out as their own events). */
export interface WireTurnEnd {
	type: "turn_end";
}

/**
 * The part of a turn's last assistant message the browser reads at `agent_end`
 * (desktop completion and error notifications).
 */
export type WireTurnOutcome = Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>;

/**
 * `agent_end` as it crosses the wire: the run's messages (every message and
 * tool result of the turn, each already sent as its own event) are replaced by
 * the last assistant message's outcome.
 */
export type WireAgentEnd = Omit<Extract<AgentSessionEvent, { type: "agent_end" }>, "messages"> & {
	/** Absent when the run produced no assistant message. */
	lastAssistant?: WireTurnOutcome;
};

/**
 * SDK session event as shipped in an `event` frame: `message_update` slimmed to
 * a delta, `tool_execution_update` to the card's appended text, `turn_end` and
 * `agent_end` without their repeated messages. Tool-result `message_start` /
 * `message_end` events are not shipped (`tool_execution_end` carries the result).
 */
export type WireSessionEvent =
	| Exclude<
			AgentSessionEvent,
			{ type: "message_update" | "tool_execution_update" | "turn_end" | "agent_end" }
	  >
	| WireMessageUpdate
	| WireToolExecutionUpdate
	| WireTurnEnd
	| WireAgentEnd;

/** One remembered-approval choice of an `approve` ui_request (mirrors the SDK's ExtensionApprovalGrant). */
export interface UiApprovalGrant {
	/** `folder`: the directory around the call; `target`: the exact file or URL. */
	scope: "folder" | "target";
	/** Label of the choice remembered for this session. */
	label: string;
	/** Label of the same choice remembered across sessions. */
	alwaysLabel: string;
}

/**
 * Params of the `approve` ui_request method (a tool-approval prompt). `full` is the
 * whole multi-line prompt, a title line then details with whitespace preserved.
 * `session` is the label of the approve-for-this-session choice, absent when the call
 * must be approved each time; `grants` are the always-ask-cached choices in display order.
 */
export interface UiApprovalParams {
	full: string;
	session?: string;
	grants?: UiApprovalGrant[];
}

/**
 * The ui_response `result` for an `approve` ui_request (mirrors the SDK's
 * ExtensionApprovalAnswer). A response without a result is a cancel, read as `deny`.
 */
export type UiApprovalAnswer =
	| "once"
	| "session"
	| "deny"
	| { grant: UiApprovalGrant["scope"]; always: boolean };

/**
 * Session-scoped frames as the server composes them, before broadcastTo
 * stamps the session handle. A bare omp-session sends them unstamped; the
 * fleet edge adds the roster workspace id as `scope` when proxying.
 */
export type SessionScopedFrame =
	// History: a small transcript ships as ONE frame with no `final` field (the
	// original shape); a transcript over the client backpressure cap ships as
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
	// Skills panel: fresh skill inventory after `disabledExtensions` changed (web, TUI, or file edit).
	| { type: "skills_changed"; state: SkillsState }
	| { type: "subagent_lifecycle" | "subagent_progress"; payload: unknown }
	// Server-driven ExtensionUIContext dialog; the client answers with ui_response.
	// `method: "approve"` (UiApprovalParams / UiApprovalAnswer) is a tool-approval prompt.
	| { type: "ui_request"; id: string; method: string; params: unknown }
	// The dialog above settled (answered via ui_response, or rejected when its
	// last target stream closed / the session closed). Ringed like ui_request
	// so a resuming stream replays the end AFTER the stale request (finding
	// #16) and every other live tab dismisses the dialog. Mirrors the collab
	// host's ui-request-end. `answeredBy` names the collab participant whose
	// answer settled the dialog elsewhere (the host or a writable guest).
	| { type: "ui_request_end"; id: string; answeredBy?: string }
	// Collab host status for the attached session (start/stop/live/error/off).
	| { type: "collab_status"; status: CollabWireStatus }
	// The session's running background jobs, live: how many run (a subagent's task job counts with the
	// agents, not here) and the glances of their widgets (the SDK's job widgets), the whole current set as
	// an absolute snapshot, so applying one is idempotent and a later frame replaces an earlier one. Each
	// view is cut to glance size (`glanceJobWidgetView`, its stage to 80 characters); a job that settled drops out of
	// the next frame, and `running: 0` with no entries clears. Sent at most once a second, only on change
	// and only while a client is attached; ringed like `state`, and primed on attach while any job runs.
	| { type: "job_widgets"; running: number; entries: WireJobWidgetEntry[] };

/**
 * Session-scoped frame types (SessionScopedFrame's `type` values). The fleet
 * edge stamps `scope` (the attached roster workspace id) on exactly these (plus
 * `attached`, whose `scope` is REQUIRED), and a client's stale-frame guard
 * reads that stamp only on these types. Fleet-scoped frames (`session_status`,
 * `session_activity`, `workspace_sessions`, `worktree_removed`, ...) carry
 * `workspaceId` as PAYLOAD naming the row they describe; the stamp is a
 * different key precisely so it can never clobber that payload.
 */
export const SESSION_SCOPED_FRAME_LIST = [
	"history",
	"state",
	"event",
	"bash_chunk",
	"python_chunk",
	"ephemeral_delta",
	"command_echo",
	"call_result",
	"available_commands",
	"settings_changed",
	"skills_changed",
	"subagent_lifecycle",
	"subagent_progress",
	"ui_request",
	// Finding #16: the dialog's settle marker rides the session scope like the
	// request, so a session switch guard applies the same way.
	"ui_request_end",
	"collab_status",
	"job_widgets",
] as const satisfies readonly SessionScopedFrame["type"][];
// Exhaustiveness pin (finding #63): addition-direction guard; a session-scoped
// frame added to the union without a row above would otherwise be forwarded
// UNSTAMPED (no scope), which the client's stale-frame guard would let
// through on a session switch.
const _sessionScopedFrameListExhaustive: Record<
	Exclude<SessionScopedFrame["type"], (typeof SESSION_SCOPED_FRAME_LIST)[number]>,
	never
> = {};
void _sessionScopedFrameListExhaustive;
const SESSION_SCOPED_FRAME_TYPES: Record<string, true> = Object.fromEntries(
	SESSION_SCOPED_FRAME_LIST.map((type) => [type, true]),
);
/** Whether a frame `type` is session-scoped (the edge stamps it; the client guards on the stamp). */
export function isSessionScopedFrameType(type: string): boolean {
	return SESSION_SCOPED_FRAME_TYPES[type] === true;
}

/**
 * Frame types the replay rings keep (the session's per-stream ring and the
 * fleet edge's per-client ring): deltas a resume must re-deliver. Everything
 * else is priming (hello_ok, attached, history, available_commands), a
 * unicast answer (call_result) or per-stream lifecycle (stream_reset): it
 * consumes a seq but is re-derivable by re-attach priming or a re-sent
 * command, so a ring replay has deliberate gaps there. One table for both
 * rings, so they cannot drift; the web client records dedup seqs only for
 * these types, since only they are ever replayed.
 */
const RINGED_FRAME_TYPES: Record<string, true> = {
	state: true,
	event: true,
	bash_chunk: true,
	python_chunk: true,
	ephemeral_delta: true,
	command_echo: true,
	settings_changed: true,
	skills_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	ui_request: true,
	// Finding #16: a settled dialog must invalidate the ringed ui_request it
	// answers, so a resume replays request → end (dismissed), never a stale
	// dialog whose ui_response would silently no-op.
	ui_request_end: true,
	collab_status: true,
	// Absolute snapshot of the running jobs' widget glances: a resumed or late client gets the latest one.
	job_widgets: true,
	ready: true,
	daemons: true,
	error: true,
};

/** Whether a frame `type` is a ringed delta (see RINGED_FRAME_TYPES). */
export function isRingedFrameType(type: string): boolean {
	return RINGED_FRAME_TYPES[type] === true;
}

// Server → browser. Session-scoped frames on a bare omp-session carry NO
// `scope` (one live session; connect = attached). The fleet edge STAMPS
// `scope` (the roster workspace id) on them when proxying
// (SESSION_SCOPED_FRAME_LIST plus `attached`), so clients proxied through the
// edge can guard session switches. The stamp is ONLY meaningful on those
// types: fleet frames (`session_status`, `workspace_sessions`,
// `worktree_removed`, ...) carry `workspaceId` as payload naming the row they
// describe and are never stamp-guarded. The rest are global broadcasts or
// unicast answers (noted per variant).
export type ServerFrame =
	| (SessionScopedFrame & { scope?: string })
	// Unicast answer to list_sessions; `id` echoes the command's, so a late answer
	// to a superseded request never settles the newer one. Absent from sessions
	// started before it was added (the client then settles its latest request).
	| { type: "sessions"; id?: string; sessions: SessionListEntry[] }
	// Unicast answer to list_workspace_sessions (the fleet edge answers it directly;
	// NOT ringed; lost answers are re-sent like projects). `limit` echoes the
	// effective (clamped) row count so the client can route the answer to the
	// request that asked for that size.
	| { type: "workspace_sessions"; workspaceId: string; limit: number; sessions: SessionListEntry[] }
	// Unicast answer to list_files; `id` echoes the command's (see "sessions").
	| { type: "files"; id?: string; files: string[] }
	// Unicast: OAuth URL to open (during a login call).
	| { type: "login_url"; url: string; launchUrl?: string; instructions?: string }
	// Unicast: provider needs a pasted code to finish login.
	| { type: "login_code_request"; requestId: string; title: string; placeholder?: string }
	// Unicast: socket is now attached to this scope; history, state and
	// available_commands follow immediately (in that order). Through the fleet
	// edge `scope` is the attached roster workspace id; a standalone session
	// sends its BOOT_HANDLE, an opaque attachment token. The fleet
	// sidebar's state is signaled by the fleet edge's roster frame, never by
	// attached (the edge proxies the session's frame through unchanged).
	| { type: "attached"; scope: string }
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
	// attach by command id. Success carries the workspaceId;
	// failure carries the error. Added additively; an older edge
	// that ignores the attach id never sends this frame, and the client's
	// pending-map timeout backstops it. `resumed` (additive, only on ok): the
	// attach continued the client's previous attachment from the ring replay of
	// the dial's `after`: no hello_ok, attached, history or state follow, and the
	// client keeps its transcript, scope and readiness. Older edges never set it.
	| {
			type: "attach_result";
			id: string;
			ok: boolean;
			workspaceId?: string;
			resumed?: true;
			error?: string;
	  }
	// --- omp-session readiness (R8) ---
	// Broadcast once the SDK session is live AND provider/model/auth has
	// resolved. Before it, prompt-family calls fail with a not_ready error.
	| { type: "ready"; readyAt: number }
	// --- Session identity (omp-session → any /ws consumer) ---
	// FIRST frame on every /ws socket open (upgrade-time auth replaced the
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
	// --- Stream lifecycle (fleet edge → the one stream being re-primed) ---
	// Sent when a session's own outbound buffer dropped frames and the edge
	// mirrors its resync (`session_resync`): the stream is ALIVE and a fresh
	// snapshot follows, so consumers re-prime instead of treating a gap as a
	// dormant session. A browser socket that is itself too slow is closed with
	// the typed 4503 instead (resume via `after`). Per-stream only, never ringed.
	| { type: "stream_reset"; reason: string }
	// --- Fleet edge (omp-fleet → browser; a bare omp-session never sends these) ---
	// Global broadcast + unicast answer; the fleet sidebar's source.
	| { type: "roster"; entries: RosterEntry[] }
	// Row-level roster change from one registry mutation: changed rows (appended
	// when new, replaced in place otherwise) and removed workspaceIds. Ringed like
	// `roster`; the full roster still rides each stream's priming frame.
	| { type: "roster_delta"; upserted: RosterEntry[]; removed: string[] }
	| { type: "session_status"; workspaceId: string; status: SessionStatus; error?: string }
	// Edge-generated, fleet-scoped realtime activity for a ready session
	// (streaming / dialog-blocked). Derived by the fleet edge from the tapped
	// session frame stream and broadcast ONLY on change; primed once per known
	// session when a browser stream opens. Never carries the edge's attachment stamp (it is
	// per-session, not per-attachment), never persisted, and never carries
	// tokens/endpoints; sessions never send it, so the edge's pipe forwarder
	// strips it like `daemons` broker rosters.
	| {
			type: "session_activity";
			workspaceId: string;
			streaming: boolean;
			blocked: boolean;
			/**
			 * Additive: the outcome of the turn whose end flipped `streaming` to
			 * false, from the session's last yielded `agent_end` (`lastAssistant`;
			 * an empty object when the run produced no assistant message). Present
			 * only on that live broadcast; never primed, so a newly opened stream
			 * never re-reports an old turn. Absent on older edges and on flips not
			 * caused by an observed turn end (runtime gone, pair-up resync).
			 */
			endedTurn?: WireTurnOutcome;
	  }
	// Global broadcast: first-class registered projects. Sent when the
	// registry's project set changes (same trigger as the roster broadcast)
	// AND during new-stream priming (near the roster frame), so project
	// groups with zero sessions still render. Never carries tokens/endpoints.
	// `configPath` (additive, Phase 4) is the resolved fleet config path,
	// null when no config file exists (defaults apply); the roster's
	// first-run signal. Older edges omit it; clients treat it as null.
	| {
			type: "registered_projects";
			projects: RegisteredProject[];
			configPath?: string | null;
			/**
			 * Boot-static secret-free provider-profile catalog. Absent when
			 * the fleet has no profiles configured; clients treat that as an
			 * empty catalog. Never carries secret values or executable
			 * internals.
			 */
			providerProfiles?: PublicProviderProfile[];
	  }
	// Global broadcast: a poll-detected, on-disk worktree removal (the
	// session's cwd vanished between git-state poll ticks). Ringed so an
	// `after` resume within the reclaim window still delivers the
	// toast once (client-side ring dedup guards the replay). Fleet-edge-only
	// (a bare omp-session never sends it) and never carries tokens/endpoints,
	// just workspaceId + display name + the vanished path. Never sent for
	// UI-initiated delete_worktree/remove.
	| { type: "worktree_removed"; workspaceId: string; name: string; path: string }
	// Unicast answer to add_project. `existing`: the resolved project
	// directory was already registered (nothing changed).
	| {
			type: "add_project_result";
			id: string;
			ok: boolean;
			projectId?: string;
			existing?: boolean;
			error?: string;
	  }
	// Unicast answer to create_worktree / create_clone: the new row's id, or
	// the failure. Runtime progress rides the roster/session_status broadcasts.
	| {
			type: "workspace_create_result";
			id: string;
			ok: boolean;
			workspaceId?: string;
			error?: string;
	  }
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
			workspaceId: string;
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
	restartCount: number;
	owner?: string;
	persist: boolean;
	detached: boolean;
	/**
	 * Fleet workspace ids whose session broker listed this process, stamped by the
	 * fleet edge's merge (daemons-aggregator.ts); a session's own roster frame
	 * omits it. The Activities Daemons section shows only entries the attached session reported.
	 */
	reportedBy?: string[];
};

/**
 * The daemon roster merge key: `${projectDir}${DAEMON_KEY_SEP}${name}`.
 * Daemon names are unique per projectDir and several omp-sessions can share
 * a projectDir, so the server's broker poll (refreshDaemons), the fleet
 * edge's aggregator (daemons-aggregator.ts) and the client (state.ts /
 * the Activities Daemons section) all key daemon entries by this composite. Single-sourced
 * here so the three layers cannot drift; the NUL separator cannot appear in
 * paths, which keeps the prefix-cleanup check in refreshDaemons unambiguous.
 */
export const DAEMON_KEY_SEP = "\u0000";
export function daemonsKey(info: { projectDir: string; name: string }): string {
	return `${info.projectDir}${DAEMON_KEY_SEP}${info.name}`;
}

/** `list_workspace_sessions` row count when the command carries no `limit`. */
export const WORKSPACE_SESSIONS_DEFAULT_LIMIT = 10;
/** Largest `list_workspace_sessions` row count; larger requests clamp to it. */
export const WORKSPACE_SESSIONS_MAX_LIMIT = 200;
/** The effective `list_workspace_sessions` row count for an optional requested `limit`. */
export function workspaceSessionsLimit(limit: number | undefined): number {
	if (limit === undefined) return WORKSPACE_SESSIONS_DEFAULT_LIMIT;
	return Math.min(WORKSPACE_SESSIONS_MAX_LIMIT, Math.max(1, limit));
}

export type SessionListEntry = {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	messageCount: number;
	/** First user prompt, capped at 500 chars (picker subtitle). Absent on older sessions. */
	firstMessage?: string;
	/** Session outcome for the picker status dot. Absent on older sessions. */
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
};
// ---------------------------------------------------------------------------
// Shared additive contracts.
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
	/**
	 * When an edit applies: `live` to the running session, `next-session` only to
	 * sessions started afterwards. `restart` is no longer produced; an older
	 * session may still send it, and clients treat it as `live`.
	 */
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
 * frames. Only verdicts the session computes at runtime appear here. Absent map or
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

/** One changed path in the session-bound repository adapter snapshot (G02). */
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

/** Lifecycle of an async background job (SDK `AsyncJob.status`). */
export type JobStatus = "running" | "completed" | "failed" | "cancelled";

/** Where a job widget's view stands (pi-tui `JobWidgetState`). */
export type WireJobWidgetState =
	/** The cheap model is writing the spec; the view holds the model-free fallback meanwhile. */
	| "authoring"
	/** The spec's rules drive the view. */
	| "live"
	/** No spec: the last line and rates only. */
	| "fallback";

/** pi-wire `TspTone`: the color family of a figure, bar, mark or cell. */
export type WireJobWidgetTone =
	| "neutral"
	| "accent"
	| "info"
	| "success"
	| "warning"
	| "error"
	| "pending"
	| "muted"
	| "user";

/** A formatted number with the direction it moved (`▲ 15%`); `success` is toward better, `error` away from it. */
export interface WireJobWidgetTrend {
	text: string;
	tone: "success" | "error" | "muted";
}

/** The one number a glance takes away (`186 tok/s`). */
export interface WireJobWidgetHeadline {
	/** Formatted value with its unit. */
	text: string;
	/** What the value is, when the title does not say it (`decode`, `p50`). */
	label?: string;
	trend?: WireJobWidgetTrend;
}

/** A time series, newest right, with optional reference lines. */
export interface WireJobWidgetSparkBlock {
	kind: "spark";
	label: string;
	/** Oldest first, at most 48. */
	values: number[];
	/** Domain of the chart. */
	min: number;
	max: number;
	/** Horizontal reference lines in value units (a target, a baseline). */
	marks?: { value: number; label: string; tone?: WireJobWidgetTone }[];
	/** Latest value, formatted (`186 tok/s`). */
	last: string;
	/** Per-point tooltip text, same length as `values`. */
	tips?: string[];
	tone?: WireJobWidgetTone;
}

/** One bar per key: a value against a common maximum. */
export interface WireJobWidgetBarsBlock {
	kind: "bars";
	label: string;
	items: { label: string; value: number; text: string; tone?: WireJobWidgetTone }[];
	/** The value a full bar stands for. */
	max: number;
}

/** Progress of a countable whole (`7/9 trials`). */
export interface WireJobWidgetMeterBlock {
	kind: "meter";
	label: string;
	/** 0 to 1. */
	value: number;
	text: string;
	tone?: WireJobWidgetTone;
}

/** A few labelled numbers on one line (`p50 41 ms · p99 212 ms`). */
export interface WireJobWidgetStatBlock {
	kind: "stat";
	items: {
		label: string;
		text: string;
		tone?: WireJobWidgetTone;
		trend?: WireJobWidgetTrend;
	}[];
}

/** One cell per key with its latest state (CI jobs, shards, workers). */
export interface WireJobWidgetGridBlock {
	kind: "grid";
	label: string;
	items: { label: string; text: string; tone: WireJobWidgetTone }[];
}

/** The latest line a rule captured (the test now running, the current phase). */
export interface WireJobWidgetTextBlock {
	kind: "text";
	text: string;
}

export type WireJobWidgetBlock =
	| WireJobWidgetSparkBlock
	| WireJobWidgetBarsBlock
	| WireJobWidgetMeterBlock
	| WireJobWidgetStatBlock
	| WireJobWidgetGridBlock
	| WireJobWidgetTextBlock;

/**
 * One job's widget as the SDK's `JobWidgetView` (pi-tui tools/job-widget.ts)
 * crosses the wire: plain JSON, a structural mirror the browser draws without
 * the SDK. Every text is one clean line (`parseJobWidgetView`, lib/wire/job-widget.ts,
 * cuts and sanitizes a view before it ships).
 */
export interface WireJobWidgetView {
	/** Short name of what is being watched (`verb-bench · 3 models`). */
	title: string;
	headline?: WireJobWidgetHeadline;
	/** What the job is doing now: a subagent's stage, or the last line of output. */
	stage?: string;
	/** Top to bottom; the first block is the primary one, and compact views show only it. */
	blocks: WireJobWidgetBlock[];
	state: WireJobWidgetState;
	/** Epoch ms of the newest data the view reflects. */
	updatedAt: number;
}

/** A running job's widget, as a list of live widgets names its job (pi-tui `JobWidgetEntry`). */
export interface WireJobWidgetEntry {
	id: string;
	/** SDK job kind ("bash", "task", "eval"). */
	type: string;
	view: WireJobWidgetView;
}

/** A subagent that owns listed jobs, or an ancestor linking one to the viewing agent. */
export interface JobAgentDto {
	id: string;
	parentId?: string;
}

/**
 * One background job of `getJobTree`: the SDK's snapshot item without the full
 * command line (`getJobDetail` carries it, so every poll stays small).
 */
export interface JobDto {
	id: string;
	/** SDK job kind ("bash", "task", "eval"); an unknown kind renders as a generic job. */
	type: string;
	status: JobStatus;
	/** Short description, cut to 120 characters by the SDK. */
	label: string;
	/** Why the model started the job (a bash or eval call's purpose); the Jobs surfaces name the job by it when present. */
	intent?: string;
	/** One line on what a long command does and when it ends, written by the `widget` model role; present only while `async.widgets` is on. */
	caption?: string;
	/** Epoch ms. */
	startTime: number;
	/** Epoch ms; set once the job settled. */
	endTime?: number;
	/** The subagent a task job runs. */
	agentId?: string;
	/** Registry id of the agent that registered the job. */
	ownerId?: string;
	/** This session registered the job itself, so `cancelJob` may stop it; a subagent's job is watch-only. */
	own: boolean;
}

/** Where a `getJobTree` row sits (SDK `JobTreePlace`). */
export interface JobTreePlaceDto {
	/** 0 for the top level. */
	depth: number;
	/** Per enclosing level below the top, whether that level's rail continues past this row. */
	rails: boolean[];
	/** The row is the last of its siblings. */
	last: boolean;
	/** Rows nest under this one. */
	parent: boolean;
}

/**
 * A job row (a task job also heads its subagent), or a header for a subagent whose task job is no longer listed.
 * A running job's row carries its widget cut to a glance (`glanceJobWidgetView`): the headline, stage and state
 * plus the primary spark and meter, so a poll stays small; `getJobDetail` carries the whole view.
 */
export type JobTreeRowDto = JobTreePlaceDto &
	(
		| { kind: "job"; job: JobDto; agent?: JobAgentDto; widget?: WireJobWidgetView }
		| { kind: "agent"; agent: JobAgentDto }
	);

/**
 * `getJobTree`: the viewing agent's background jobs and every subagent's below
 * it, as rows in SDK display order (busiest branches first, depth first). The
 * method answers null when the session has no async job manager.
 */
export interface JobTreeDto {
	/** The agent the tree is for; its own jobs sit at the top level. */
	rootId?: string;
	rows: JobTreeRowDto[];
}

/** `getJobDetail`: what the Activities job detail shows about one job beyond its row (SDK `AsyncJobInspection`; its widget view rides whole, absent while `async.widgets` is off or the job has none). */
export interface JobDetailDto {
	/** Full command line of a job that runs a process. */
	command?: string;
	/** Directory that command started in. */
	cwd?: string;
	/** Live pids the job's command spawned. */
	pids: number[];
	exitCode?: number;
	/** Output tail while running, the final result or error text once settled; cut to its last characters. */
	output?: string;
	/** `output` was cut from the front. */
	outputTruncated?: boolean;
	/** Artifact holding the full output when the SDK cut it. */
	artifactId?: string;
	/** The job's whole widget (SDK `AsyncJobInspection.widget`). */
	widget?: WireJobWidgetView;
}

/** `cancelJob` answer: false when the job settled before the cancel landed. */
export interface JobCancelResultDto {
	cancelled: boolean;
}

/** Why a cold prompt cache will be rewritten (SDK `PromptCacheColdReason`). */
export type PromptCacheColdReasonDto =
	| { kind: "expired"; at: number }
	| { kind: "refresh-missed" }
	| { kind: "model"; from: string; to: string }
	| { kind: "thinking"; from: string; to: string }
	| { kind: "tools" }
	| { kind: "system-prompt" }
	| { kind: "retention" }
	| { kind: "compaction" };

/** omp's cache warmer as it concerns the entry (SDK `PromptCacheWarming`). */
export interface PromptCacheWarmingDto {
	state: "scheduled" | "refreshing" | "inactive";
	/** Epoch ms the armed refresh decides. */
	nextWarmAt?: number;
	/** Epoch ms warming gives up. */
	stopsAt?: number;
	reason?: string;
}

/** What the next request finds in the prompt cache (SDK `PromptCacheStatus`, JSON-safe: absent fields are omitted). */
export interface PromptCacheStatusDto {
	state: "warm" | "cold";
	reason?: PromptCacheColdReasonDto;
	/** Read off a reopened session's transcript, not a response the process saw. */
	inferred: boolean;
	tier: "short" | "long";
	/** Epoch ms of the last request that read or wrote the entry. */
	touchedAt: number;
	/** Lifetime after the last touch; absent when the provider never expires the entry. */
	ttlMs?: number;
	cachedTokens: number;
	nextTokens: number;
	warming?: PromptCacheWarmingDto;
}

/** One `label: value` row of the SDK's prompt-cache details; `warning` marks a cold state or its reason. */
export interface PromptCacheDetailRowDto {
	label: string;
	value: string;
	tone?: "warning";
}

/**
 * `getPromptCacheStatus` (read-only, no args): the attached session's prompt-cache state. `status` is null when
 * the session has nothing to report (no cache warmer, or no cached reply). `brief` (the hover card's two lines)
 * and `details` (the `/session` Prompt Cache rows) are the SDK helpers' text computed at answer time, so the
 * browser carries no copy of their wording; both are absent when `status` is null.
 */
export interface PromptCacheStatusReply {
	status: PromptCacheStatusDto | null;
	brief?: [string, string];
	details?: PromptCacheDetailRowDto[];
}

/** Tone of a visualized shell token (the SDK's shell-viz style tokens mapped onto the TUI renderer's palette); a token with no tone is plain text. */
export type ShellVizTone =
	| "comment"
	| "keyword"
	| "variable"
	| "string"
	| "number"
	| "operator"
	| "command"
	| "accent";

/** One styled run of a visualized row. */
export interface ShellVizSegmentDto {
	text: string;
	tone?: ShellVizTone;
	/** The run is the first of its failed command in the row: a failure mark precedes it. */
	failed?: true;
	/** Not executing, or skipped: drawn faint. */
	dim?: true;
}

/** The latest value of a variable the row's statement last set. */
export interface ShellVizVariableDto {
	name: string;
	value: string;
	/** `value` is shorter than the variable's real value. */
	cut?: true;
}

/** One physical row of the Pseudo or Raw rendering (SDK `ShellVizRow`, without ANSI or node identity). */
export interface ShellVizRowDto {
	depth: number;
	segments: ShellVizSegmentDto[];
	/** `fail`: a failed statement the segments carry no mark for; `active`: the row is executing now. */
	gutter?: "fail" | "active";
	/** The row is not executing while the run is live: draw it faint. */
	dim?: true;
	/** The row's command failed: its `meta` reads as an error. */
	failed?: true;
	/** Effect glyphs (network, write, destructive, ...). */
	effects?: string;
	/** Runtime note, e.g. "exit 1 · 23ms". */
	meta?: string;
	variables?: ShellVizVariableDto[];
}

/** `getShellVisualization` answer reasons when no visualization is available. */
export type ShellVizUnavailableReason =
	/** No bash call with that id in the session or the named subagent's transcript. */
	| "unknown_call"
	/** The call carries no shell trace (a session from before SDK 18.17.0, or a run that did not use the embedded shell). */
	| "no_trace"
	/** The trace failed validation or the SDK's presentation engine could not render it. */
	| "invalid_trace";

/**
 * `getShellVisualization`: the SDK's own presentation of one bash call's shell trace, computed in the session
 * and cut to an answer that fits the callback envelope; the browser never receives the raw trace. A settled bash
 * result's `details.shellTrace === true` (in `tool_execution_end`, history frames and subagent transcript pages) says
 * the call has one to ask for; a running call's updates carry no `details`, so a running bash call may always be asked.
 * Args `[{ toolCallId, subagentId?, cursor? }]`: `subagentId` names a subagent (absent: this session's own call),
 * `cursor` replays the first N retained history records (0..`timeline.length`; absent: the end).
 */
export type ShellVizDto =
	| { available: false; reason: ShellVizUnavailableReason }
	| {
			available: true;
			/** The call is still running: the answer is its latest snapshot. */
			running: boolean;
			/** Exit status of the run; absent while it runs. */
			status?: number;
			/** Python-like rendering. */
			pseudo: ShellVizRowDto[];
			/** The script as written, with the same marks. */
			raw: ShellVizRowDto[];
			/** Replay clock: retained history records, the cursor applied, and run time in ns. */
			timeline: { length: number; cursor: number; elapsedNs: number; durationNs: number };
			/** The SDK dropped replay history or output beyond its retention limits. */
			historyTrimmed?: true;
			/** The SDK's note on the presentation, when it has one. */
			message?: string;
			/** Rows left out to fit the answer, per rendering; present only when some were. */
			omittedRows?: { pseudo: number; raw: number };
	  };

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
