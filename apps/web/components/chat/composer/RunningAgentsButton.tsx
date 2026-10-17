import { Show, type Component } from "solid-js";
import { openDock } from "../../../store/dock";
import { runningSubagentCount } from "../../../store/subagents";

/** Composer counter for running agents; opens the agents dock. Hidden when none run. */
export const RunningAgentsButton: Component = () => (
	<Show when={runningSubagentCount() > 0}>
		<button
			type="button"
			class="running-agents-button"
			aria-keyshortcuts="Alt+A"
			title="Open agents (Alt+A)"
			onClick={() => openDock("agents")}
		>
			<span class="running-agents-count">{runningSubagentCount()}</span> running
		</button>
	</Show>
);
