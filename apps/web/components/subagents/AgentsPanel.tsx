import { createEffect, createMemo, createSignal, on, Show, type Component } from "solid-js";
import {
	agentsFilter,
	agentsMode,
	agentTreeCollapsed,
	expandedAgentId,
	openAgent,
	toggleAgentExpanded,
	toggleAgentTreeCollapsed,
} from "../../store/dock";
import { subagentForest } from "../../store/subagents";
import {
	filterActiveSubagentTree,
	filterSubagentTree,
	flattenSubagentTree,
	subagentRowDomId,
	summarizeSubagentTree,
} from "../../subagents/tree";
import { SubagentConversation } from "./SubagentConversation";
import { SubagentFanoutTotals } from "./SubagentFanoutTotals";
import { SubagentTree } from "./SubagentTree";

/** Search appears only once the forest is large enough to need it. */
const SEARCH_THRESHOLD = 8;

/**
 * The whole forest of the attached session as one tree (Alt+A), a flush dock
 * column: search pinned on top, the tree as the one scroller, the totals
 * footer pinned below. Single mode opens a row in the agent pane; accordion
 * mode expands it inline, one at a time.
 */
export const AgentsPanel: Component = () => {
	const [query, setQuery] = createSignal("");
	let list: HTMLDivElement | undefined;
	const forest = () => subagentForest();
	const total = () => flattenSubagentTree(forest()).length;
	// The running filter comes first, so search narrows what it leaves. The open agent stays even once it finishes.
	const shown = () =>
		agentsFilter() === "running" ? filterActiveSubagentTree(forest(), expandedAgentId()) : forest();
	const visible = () => filterSubagentTree(shown(), query());
	const accordion = createMemo(() =>
		agentsMode() === "accordion"
			? {
					get expandedId() {
						return expandedAgentId();
					},
					body: (id: string) => <SubagentConversation id={id} menu />,
				}
			: undefined,
	);

	// Scroll the expanded row to the top of the list (also when the dock reopens on a remembered agent).
	createEffect(
		on(expandedAgentId, (id) => {
			if (id === undefined || list === undefined) return;
			const row = list.querySelector<HTMLElement>(`#${CSS.escape(subagentRowDomId(id))}`);
			if (!row) return;
			const item = row.closest<HTMLElement>(".subagent-tree-item") ?? row;
			list.scrollTop += item.getBoundingClientRect().top - list.getBoundingClientRect().top;
		}),
	);

	return (
		<div class="agents-panel" data-mode={agentsMode()}>
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
			<div class="agents-panel-list" ref={list}>
				<Show
					when={total() > 0}
					fallback={
						<p class="agents-panel-empty">
							No agents in this session yet. Subagents appear here when a Task runs.
						</p>
					}
				>
					<Show
						when={shown().length > 0}
						fallback={<p class="agents-panel-empty">No agents are running.</p>}
					>
						<Show
							when={visible().length > 0}
							fallback={<p class="agents-panel-empty">No agents match “{query()}”.</p>}
						>
							<SubagentTree
								nodes={visible()}
								label="Agents"
								onOpen={accordion() ? toggleAgentExpanded : openAgent}
								collapsed={agentTreeCollapsed()}
								onToggleCollapsed={toggleAgentTreeCollapsed}
								accordion={accordion()}
								rowMenu={false}
							/>
						</Show>
					</Show>
				</Show>
			</div>
			<Show when={total() > 0}>
				<SubagentFanoutTotals totals={summarizeSubagentTree(forest())} placement="footer" />
			</Show>
		</div>
	);
};
