import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { InspectImageMode } from "@oh-my-pi/pi-coding-agent/utils/inspect-image-mode";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AvailableSlashCommandSource } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";

// ---------------------------------------------------------------------------
// Local copies of the RPC wire types (structurally verbatim from the
// @oh-my-pi/pi-coding-agent@17.1.8 RPC mode's protocol type definitions).
// The server no longer spawns the RPC child, so the protocol owns these.
// ---------------------------------------------------------------------------

/** Pick of Model the model picker consumes (was the RPC client's ModelInfo). */
export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export interface WebSessionState {
	model?: Model;
	/** Resolved model-role assignments (role -> provider/id) in canonical role order; undefined when nothing resolves. */
	modelRoles?: Array<{ role: string; provider: string; id: string }>;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	/** Set once the omp-session readiness gate clears (R8): SDK session live + provider/model/auth resolved. */
	readyAt?: number;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	/** New with the in-process SDK: real value instead of the client-side hack. */
	autoRetryEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	// --- Phase 9: modes & usage parity (cheap sync getters, refreshed every broadcast) ---
	/** Goal mode state (getGoalModeState()); undefined when no goal session is active. */
	goalModeState: GoalModeState | undefined;
	/** Plan mode presence (getPlanModeState()?.enabled). */
	planModeEnabled: boolean;
	/** Priority-service flag for the active model family (isFastModeEnabled()). */
	fastModeEnabled: boolean;
	/** Whether the computer tool is exposed (getActiveToolNames().includes("computer")). */
	computerToolEnabled: boolean;
	/** Effective inspect_image mode (inspectImageState().mode). */
	inspectImageMode: InspectImageMode;
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
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

/** Image payload accepted by prompt/steer/followUp (structurally compatible with pi-ai's ImageContent). */
export type ImageArg = { type: "image"; data: string; mimeType: string; detail?: string };

// ---------------------------------------------------------------------------
// Settings panel (TUI /settings parity). The server builds the model from the
// shared settings-schema metadata; the client renders it verbatim.
// ---------------------------------------------------------------------------

export interface SettingsOption {
	value: string;
	label: string;
	description?: string;
}

export type SettingsItemType = "boolean" | "enum" | "submenu" | "text" | "multiselect" | "providerLimits";

export interface SettingsItem {
	path: string;
	label: string;
	description: string;
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
	tabs: SettingsTab[];
}

// ---------------------------------------------------------------------------
// omp-session / omp-fleet contract (README.md). OMP_PROTO gates
// fleet↔omp-session drift (the collab COLLAB_PROTO pattern); bump on any
// breaking change to the hello handshake or frame shapes.
// ---------------------------------------------------------------------------

export const OMP_PROTO = 1;

/** WS close code for a missing/invalid bearer token (R14). */
export const OMP_CLOSE_UNAUTHORIZED = 4001;

/**
 * The `OMP_SESSION|` stdout contract lines (R6b). omp-session prints
 * `listening` immediately after bind, before session creation; a remote
 * wrapper MAY print `endpoint` when the reachable address differs from the
 * bind.
 */
export type StdoutContractLine =
	| { event: "listening"; bind: string; port: number; url: string; advertise?: string }
	| { event: "endpoint"; url: string };

/** Daemon lifecycle as surfaced by omp-fleet (daemon_status frame). */
export type DaemonStatus = "spawning" | "connecting" | "session" | "resolving" | "ready" | "asleep" | "reconnecting" | "error";

/** One daemon in the omp-fleet roster (roster frame). */
export interface DaemonEntry {
	daemonId: string;
	name: string;
	cwd: string;
	project: string;
	worktreeOf?: string;
	labels: string[];
	mode: "spawned" | "attached" | "remote";
	status: DaemonStatus;
	lastSessionFile?: string;
	readyAt?: number;
	uptime?: number;
	pid?: number;
	error?: string;
}

/** One discovered project for the spawn picker (projects frame). */
export interface ProjectEntry {
	name: string;
	path: string;
	isWorktree: boolean;
	worktreeOf?: string;
	branch?: string;
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
	| "popLastQueuedMessage"
	| "clearQueue"
	| "abort"
	| "abortAndPrompt"
	| "newSession"
	| "compact"
	| "retry"
	| "fork"
	| "freshSession"
	| "handoff"
	| "setSessionName"
	| "setInterruptMode"
	// Phase 9 (17.1.8): goal/plan modes are NOT ACP-intercepted — /goal and
	// /plan fall through to the model. Control relays via these SDK rows.
	| "setGoalModeState"
	| "setPlanModeState"
	| "goalCreate"
	| "goalPause"
	| "goalResume"
	| "goalDrop"
	| "formatSessionAsText"
	| "dumpLlmRequestToTmpDir"
	| "setModel"
	| "cycleModel"
	| "getAvailableModels"
	| "setThinkingLevel"
	| "cycleThinkingLevel"
	| "setSteeringMode"
	| "setFollowUpMode"
	| "setAutoCompaction"
	| "setAutoRetry"
	| "abortRetry"
	| "setFastMode"
	| "setComputerToolEnabled"
	| "setInspectImageMode"
	| "fetchUsageReports"
	| "getContextBreakdown"
	| "bash"
	| "abortBash"
	| "python"
	| "abortEval"
	// Phase 11: /btw side-channel Q&A (runEphemeralTurn never touches the
	// transcript); abortEphemeral cancels the in-flight side turn via its signal.
	| "runEphemeralTurn"
	| "abortEphemeral"
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
	| "subagentAbort";

// Client → server
// Routing is by SOCKET ATTACHMENT: on omp-session a socket is attached to the
// single live session from upgrade (connect = attached), so call/login_code/
// ui_response implicitly target it. `attach` exists only at the fleet edge,
// where it selects the daemon to proxy.
export type ClientCommand =
	| { type: "call"; id: string; method: WebMethodName; args?: unknown[]; streamId?: number }
	| { type: "login_code"; requestId: string; code: string }
	// Answer to a server "ui_request" frame (ExtensionUIContext dialogs).
	| { type: "ui_response"; id: string; result?: unknown; error?: string }
	| { type: "list_sessions" }
	| { type: "list_files"; query: string; limit?: number }
	// Fleet edge only: attach this socket to the daemon with this id
	// (the edge proxies it through; a bare omp-session never receives attach).
	| { type: "attach"; sessionId: string }
	// Plain process-stats poll; answered with a process_stats frame.
	| { type: "get_process_stats" }
	// Collab: start/stop the collab room for the socket's ATTACHED session.
	| { type: "collab_start" }
	| { type: "collab_stop" }
	// Daemon web exposure: per-daemon logs/stop/restart, answered by unicast
	// daemon_logs_result / daemon_control_result frames.
	| { type: "daemon_logs"; id: string; projectDir: string; name: string; lines: number; head?: boolean; grep?: string }
	| { type: "daemon_stop"; id: string; projectDir: string; name: string; timeoutMs?: number }
	| { type: "daemon_restart"; id: string; projectDir: string; name: string }
	// --- Fleet control plane (omp-fleet → omp-session) ---
	// First-frame auth fallback when the transport can't set an Authorization
	// header (R14 handshake); answered by hello_ok or close 4001.
	| { type: "hello"; proto: number; token?: string }
	// --- Fleet edge (browser → omp-fleet only; a bare omp-session rejects these) ---
	| { type: "spawn"; cwd: string; template?: string; labels?: string[] }
	| { type: "spawn_resume"; daemonId: string }
	| { type: "stop"; daemonId: string }
	// Stop the daemon AND evict it from the roster (registry removal).
	| { type: "remove"; daemonId: string }
	| { type: "list_projects" };

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
	| { state: "live"; link: string; viewLink: string; relayUrl: string; roomId: string; participants: CollabParticipantInfo[]; maxGuests: number }
	| { state: "error"; error: string };

/**
 * Session-scoped frames as the server composes them, before broadcastTo
 * stamps the session handle. On the wire they always carry sessionId.
 */
export type SessionScopedFrame =
	| { type: "history"; messages: AgentMessage[] }
	| { type: "state"; state: WebSessionState; stats?: SessionStats }
	| { type: "event"; event: AgentSessionEvent }
	// Live output of an in-flight bash/python call (streamId = the client's
	// bash-item id); broadcast session-scoped so every tab stays consistent.
	| { type: "bash_chunk"; id: number; text: string }
	| { type: "python_chunk"; id: number; text: string }
	// Phase 11: live output of an in-flight /btw side question (id = the
	// client's btw streamId); broadcast session-scoped like bash_chunk.
	| { type: "ephemeral_delta"; id: number; text: string }
	// Unicast answer to a "call" command.
	| { type: "call_result"; id: string; ok: boolean; data?: unknown; error?: string }
	| { type: "available_commands"; commands: AvailableSlashCommand[] }
	// Settings panel: fresh model after a setSetting mutation (TUI /settings parity).
	| { type: "settings_changed"; model: SettingsModel }
	| { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event"; payload: unknown }
	// Server-driven ExtensionUIContext dialog; the client answers with ui_response.
	| { type: "ui_request"; id: string; method: string; params: unknown }
	// Collab host status for the attached session (start/stop/live/error/off).
	| { type: "collab_status"; status: CollabWireStatus };

// Server → browser. Session-scoped frames on a bare omp-session carry NO
// sessionId (one live session; connect = attached). The fleet edge STAMPS the
// daemonId as sessionId when proxying, so roster-mode clients can guard
// daemon switches. The rest are global broadcasts or unicast answers (noted
// per variant).
export type ServerFrame =
	| (SessionScopedFrame & { sessionId?: string })
	// Unicast answer to list_sessions.
	| { type: "sessions"; sessions: SessionListEntry[] }
	// Unicast answer to list_files.
	| { type: "files"; files: string[] }
	// Unicast: OAuth URL to open (during a login call).
	| { type: "login_url"; url: string; launchUrl?: string; instructions?: string }
	// Unicast: provider needs a pasted code to finish login.
	| { type: "login_code_request"; requestId: string; title: string; placeholder?: string }
	// Unicast: socket is now attached to this handle; history, state and
	// available_commands follow immediately (in that order). mode "single" is
	// the standalone omp-session UI (no sidebar); roster mode is signaled by
	// the fleet edge's roster frame, never by attached (the edge proxies the
	// daemon's "single" through unchanged).
	| { type: "attached"; sessionId: string; mode?: "single" | "multi" }
	// Project-wide daemon broker roster (hub launch processes); global broadcast.
	| { type: "daemons"; daemons: DaemonInfo[] }
	// Unicast answer to daemon_logs.
	| { type: "daemon_logs_result"; id: string; ok: boolean; text?: string; cursor?: number; state?: string; error?: string }
	// Unicast answer to daemon_stop / daemon_restart.
	| { type: "daemon_control_result"; id: string; ok: boolean; daemon?: DaemonInfo; error?: string }
	// Unicast answer to get_process_stats — the 5s poll carries only process stats.
	| { type: "process_stats"; process: ProcessStats }
	// --- omp-session readiness (R8) ---
	// Broadcast once the SDK session is live AND provider/model/auth has
	// resolved. Before it, prompt-family calls fail with a not_ready error.
	| { type: "ready"; readyAt: number }
	// --- Fleet control plane (omp-session → omp-fleet) ---
	// Unicast answer to the hello handshake (Authorization header or hello frame).
	| { type: "hello_ok"; proto: number; name: string; cwd: string; pid: number; version: string; sessionFile?: string }
	// --- Fleet edge (omp-fleet → browser; a bare omp-session never sends these) ---
	// Global broadcast + unicast answer; the roster-mode sidebar's source.
	| { type: "roster"; daemons: DaemonEntry[] }
	| { type: "daemon_status"; daemonId: string; status: DaemonStatus; error?: string }
	// Unicast answer to list_projects.
	| { type: "projects"; projects: ProjectEntry[] }
	| { type: "error"; error: string };

/** Server process stats, reported by the process_stats frame. */
export type ProcessStats = {
	rssBytes: number;
	uptimeSec: number;
	sessionCount: number;
};

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

export type SessionListEntry = {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	messageCount: number;
};
