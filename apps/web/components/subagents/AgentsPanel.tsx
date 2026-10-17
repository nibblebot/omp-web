import { createSignal, Show, type Component } from "solid-js";
import { openDock } from "../../store/dock";
import { subagentForest } from "../../store/subagents";
import {
	filterSubagentTree,
	flattenSubagentTree,
	summarizeSubagentTree,
} from "../../subagents/tree";
import { SubagentFanoutFooter } from "./SubagentFanoutFooter";
import { SubagentTree } from "./SubagentTree";

/** Search appears only once the forest is large enough to need it. */
const SEARCH_THRESHOLD = 8;

/** The whole forest of the attached session as one tree (Alt+A). */
export const AgentsPanel: Component = () => {
	const [query, setQuery] = createSignal("");
	const forest = () => subagentForest();
	const total = () => flattenSubagentTree(forest()).length;
	const visible = () => filterSubagentTree(forest(), query());
	return (
		<div class="agents-panel">
			<Show when={total() > SEARCH_THRESHOLD}>
				<input
					type="search"
					class="agents-panel-search"
					aria-label="Search agents"
					placeholder="Search agents"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
				/>
			</Show>
			<Show
				when={total() > 0}
				fallback={
					<p class="agents-panel-empty">
						No agents in this session yet. Subagents appear here when a Task runs.
					</p>
				}
			>
				<Show
					when={visible().length > 0}
					fallback={<p class="agents-panel-empty">No agents match “{query()}”.</p>}
				>
					<SubagentTree nodes={visible()} label="Agents" onOpen={(id) => openDock("agent", id)} />
				</Show>
				<SubagentFanoutFooter totals={summarizeSubagentTree(forest())} />
			</Show>
		</div>
	);
};
