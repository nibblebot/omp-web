import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";

export type ClientCommand = { type: "prompt"; message: string } | { type: "abort" } | { type: "new_session" };

export type ServerFrame =
	| { type: "history"; messages: AgentMessage[] }
	| { type: "state"; state: RpcSessionState }
	| { type: "event"; event: AgentSessionEvent }
	| { type: "error"; error: string };
