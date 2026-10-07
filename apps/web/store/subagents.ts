import { call } from "./transport";

/**
 * Subagents domain (Phase 3 store facade split). The subagent mirror itself
 * (state.subagents) is maintained by the connect() mux in state.ts; this
 * module owns the mid-task steering/abort actions.
 */

/** Steer a running subagent mid-task; rejects for unknown/idle/parked agents. */
export function steerSubagent(agentId: string, text: string): Promise<unknown> {
	return call("subagentSteer", [agentId, text]);
}

/** Abort one running subagent; Main and siblings are unaffected. */
export function abortSubagent(agentId: string): Promise<unknown> {
	return call("subagentAbort", [agentId]);
}
