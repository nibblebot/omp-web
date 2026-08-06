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
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
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
// Phase 2: routing is by SOCKET ATTACHMENT — each socket is attached to one
// live session handle and call/login_code/ui_response implicitly target it.
// Only the multiplexing commands themselves carry a handle.
export type ClientCommand =
	| { type: "call"; id: string; method: WebMethodName; args?: unknown[]; streamId?: number }
	| { type: "login_code"; requestId: string; code: string }
	// Answer to a server "ui_request" frame (ExtensionUIContext dialogs).
	| { type: "ui_response"; id: string; result?: unknown; error?: string }
	| { type: "list_sessions" }
	| { type: "list_files"; query: string; limit?: number }
	// Create a new live session and attach this socket to it.
	| { type: "create_session"; cwd?: string }
	// Attach this socket to an existing live session handle.
	| { type: "attach"; sessionId: string }
	// Detach: this socket receives no more session-scoped frames.
	| { type: "detach" }
	// Dispose a live session; sockets attached to it are detached.
	| { type: "close_session"; sessionId: string }
	| { type: "list_live_sessions" }
	// The 5s sidebar poll command; answered with a process_stats frame.
	| { type: "get_process_stats" };

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
	| { type: "ui_request"; id: string; method: string; params: unknown };

// Server → browser. Session-scoped frames carry the live-session handle in
// sessionId and reach only sockets attached to it; the rest are global
// broadcasts or unicast answers (noted per variant).
export type ServerFrame =
	| (SessionScopedFrame & { sessionId: string })
	// Unicast answer to list_sessions.
	| { type: "sessions"; sessions: SessionListEntry[] }
	// Unicast answer to list_files.
	| { type: "files"; files: string[] }
	// Unicast: OAuth URL to open (during a login call).
	| { type: "login_url"; url: string; launchUrl?: string; instructions?: string }
	// Unicast: provider needs a pasted code to finish login.
	| { type: "login_code_request"; requestId: string; title: string; placeholder?: string }
	// Unicast: socket is now attached to this handle; history, state and
	// available_commands follow immediately (in that order).
	| { type: "attached"; sessionId: string }
	// Both the unicast answer to list_live_sessions AND a global broadcast the
	// server pushes whenever sidebar-relevant session state changes (create/close,
	// session events, model/thinking/title changes). Clients always apply the
	// snapshot to the sidebar roster and resolve a pending list request if one is
	// in flight.
	| { type: "live_sessions"; sessions: LiveSessionEntry[] }
	// Unicast answer to get_process_stats — the 5s poll carries only process stats.
	| { type: "process_stats"; process: ProcessStats }
	| { type: "error"; error: string };

/** One live in-process session, as reported by the live_sessions frame. */
export type LiveSessionEntry = {
	sessionId: string;
	name?: string;
	cwd: string;
	/** Display string "provider/id"; omitted while the session has no model yet. */
	model?: string;
	thinkingLevel?: string;
	/** Undefined until the session has a usage measurement. */
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	messageCount: number;
	isStreaming: boolean;
};

/** Server process stats, reported by the process_stats frame (the 5s sidebar poll). */
export type ProcessStats = {
	rssBytes: number;
	uptimeSec: number;
	sessionCount: number;
};

export type SessionListEntry = {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	messageCount: number;
};
