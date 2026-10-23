import { createSignal } from "solid-js";
import { pushNotice } from "../store/chat";
import {
	abortSubagent,
	agentPaneActions,
	parkSubagent,
	reviveSubagent,
	steerSubagent,
	subagentCapabilities,
	type AgentPaneAction,
} from "../store/subagents";
import { reportError } from "../store/toasts";

/** Agent ids with a lifecycle action in flight. Shared, so an agent's row and its open body gate each other. */
const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set());

function setPending(id: string, on: boolean): void {
	setPendingIds((prev) => {
		const next = new Set(prev);
		if (on) next.add(id);
		else next.delete(id);
		return next;
	});
}

/** Lifecycle verbs for one agent: capability checks plus the pending gate and failure toast shared by every surface. */
export interface SubagentLifecycle {
	/** Whether the agent's current status offers this action (hidden, never disabled, when it does not). */
	offers: (action: AgentPaneAction) => boolean;
	/** A lifecycle action is in flight for this agent. */
	pending: () => boolean;
	/** Resolves true when the steer was delivered. */
	steer: (text: string) => Promise<boolean>;
	park: () => Promise<boolean>;
	revive: () => Promise<boolean>;
	abort: () => Promise<boolean>;
}

/** Lifecycle runner for the agent `id()` names. Failures surface as a toast and resolve false. */
export function createSubagentLifecycle(id: () => string): SubagentLifecycle {
	const run = async (agentId: string, action: () => Promise<unknown>): Promise<boolean> => {
		setPending(agentId, true);
		try {
			await action();
			return true;
		} catch (e) {
			reportError(e);
			return false;
		} finally {
			setPending(agentId, false);
		}
	};
	return {
		offers: (action) => agentPaneActions(subagentCapabilities(id())).includes(action),
		pending: () => pendingIds().has(id()),
		steer: (text) => {
			const agentId = id();
			return run(agentId, async () => {
				await steerSubagent(agentId, text);
				pushNotice("info", "Steer sent");
			});
		},
		park: () => {
			const agentId = id();
			return run(agentId, () => parkSubagent(agentId));
		},
		revive: () => {
			const agentId = id();
			return run(agentId, () => reviveSubagent(agentId));
		},
		abort: () => {
			const agentId = id();
			return run(agentId, () => abortSubagent(agentId));
		},
	};
}
