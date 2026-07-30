import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	RpcAvailableSlashCommand,
	RpcSessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

/** Image payload accepted by prompt/steer/followUp (structurally compatible with pi-ai's ImageContent). */
export type ImageArg = { type: "image"; data: string; mimeType: string; detail?: string };

/**
 * Allowlist of RpcClient methods reachable from the browser. The server owns a
 * dispatch table keyed by these names; adding a capability = one row there.
 */
export type RpcMethodName =
	| "prompt"
	| "steer"
	| "followUp"
	| "abort"
	| "abortAndPrompt"
	| "newSession"
	| "compact"
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
	| "bash"
	| "abortBash"
	| "getSessionStats"
	| "exportHtml"
	| "switchSession"
	| "branch"
	| "getBranchMessages"
	| "getLoginProviders"
	| "setSubagentSubscription"
	| "getSubagents";

// Client → server
export type ClientCommand =
	| { type: "call"; id: string; method: RpcMethodName; args?: unknown[] }
	| { type: "list_sessions" }
	| { type: "list_files"; query: string; limit?: number };

// Server → browser (broadcast unless noted)
export type ServerFrame =
	| { type: "history"; messages: AgentMessage[] }
	| { type: "state"; state: RpcSessionState; stats?: SessionStats }
	| { type: "event"; event: AgentSessionEvent }
	// Unicast answer to a "call" command.
	| { type: "call_result"; id: string; ok: boolean; data?: unknown; error?: string }
	| { type: "available_commands"; commands: RpcAvailableSlashCommand[] }
	| { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event"; payload: unknown }
	// Unicast answer to list_sessions.
	| { type: "sessions"; sessions: SessionListEntry[] }
	// Unicast answer to list_files.
	| { type: "files"; files: string[] }
	| { type: "error"; error: string };

export type SessionListEntry = {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	messageCount: number;
};
