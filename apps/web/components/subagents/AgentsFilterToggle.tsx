import { For, type Component } from "solid-js";
import { agentsFilter, setAgentsFilter, type AgentsFilter } from "../../store/dock";

const FILTERS: readonly { filter: AgentsFilter; label: string }[] = [
	{ filter: "all", label: "All" },
	{ filter: "running", label: "Running" },
];

/** Segmented control in the agents dock header: only the agents that are running, or every agent. Words, no icons. */
export const AgentsFilterToggle: Component = () => (
	<div class="agents-filter-toggle" role="group" aria-label="Show agents">
		<For each={FILTERS}>
			{(entry) => (
				<button
					type="button"
					class="segment segment-button"
					classList={{ active: agentsFilter() === entry.filter }}
					aria-pressed={agentsFilter() === entry.filter}
					onClick={() => setAgentsFilter(entry.filter)}
				>
					{entry.label}
				</button>
			)}
		</For>
	</div>
);
