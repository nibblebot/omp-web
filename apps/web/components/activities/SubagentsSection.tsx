import { createMemo, createSignal, Show, type Component } from "solid-js";
import { subagentsSummary } from "../../activities/summary";
import { state } from "../../state";
import { openItemDetail, toggleItemExpanded, toggleSubagentTreeRow } from "../../store/activities";
import { subagentForest } from "../../store/subagents";
import {
	filterActiveSubagentTree,
	filterSubagentTree,
	summarizeSubagentTree,
} from "../../subagents/tree";
import { SubagentConversation } from "../subagents/SubagentConversation";
import { SubagentFanoutTotals } from "../subagents/SubagentFanoutTotals";
import { SubagentTree } from "../subagents/SubagentTree";
import { ActivityFilterToggle } from "./ActivityFilterToggle";
import { ActivitySection } from "./ActivitySection";

/** Search appears only once the forest is large enough to need it. */
const SEARCH_THRESHOLD = 8;

/**
 * The Subagents section: the session's whole agent forest as one tree, the Running / All
 * filter in its header, totals below. Accordion mode expands a row inline (any number at
 * once); detail mode opens it in the panel.
 */
export const SubagentsSection: Component = () => {
	const [query, setQuery] = createSignal("");
	const summary = createMemo(subagentsSummary);
	const expanded = () => state.activities.expanded.subagents;
	const inline = () => state.activities.mode === "accordion";
	// The running filter comes first, so search narrows what it leaves. Expanded agents stay once they finish.
	const shown = () =>
		state.activities.filters.subagents === "running"
			? filterActiveSubagentTree(subagentForest(), inline() ? expanded() : undefined)
			: subagentForest();
	const visible = () => filterSubagentTree(shown(), query());
	const accordion = createMemo(() =>
		inline()
			? {
					get expanded() {
						return expanded();
					},
					body: (id: string) => <SubagentConversation id={id} menu />,
				}
			: undefined,
	);
	const onOpen = (id: string) => {
		const ref = { section: "subagents", id } as const;
		if (inline()) toggleItemExpanded(ref);
		else openItemDetail(ref);
	};

	return (
		<ActivitySection
			id="subagents"
			title="Subagents"
			count={{ active: summary().active, total: summary().total }}
			actions={<ActivityFilterToggle section="subagents" label="Show subagents" />}
		>
			<Show when={summary().total > SEARCH_THRESHOLD}>
				<input
					type="search"
					class="activity-search"
					aria-label="Search subagents"
					placeholder="Search subagents"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
				/>
			</Show>
			<Show
				when={shown().length > 0}
				fallback={<p class="activity-empty">No subagents are running.</p>}
			>
				<Show
					when={visible().length > 0}
					fallback={<p class="activity-empty">No subagents match “{query()}”.</p>}
				>
					<SubagentTree
						nodes={visible()}
						label="Subagents"
						onOpen={onOpen}
						collapsed={state.activities.treeCollapsed}
						onToggleCollapsed={toggleSubagentTreeRow}
						accordion={accordion()}
						rowMenu={false}
					/>
				</Show>
			</Show>
			<SubagentFanoutTotals totals={summarizeSubagentTree(subagentForest())} placement="footer" />
		</ActivitySection>
	);
};
