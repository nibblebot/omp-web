import { createMemo, Match, Show, Switch, type Component } from "solid-js";
import {
	daemonsSummary,
	jobsSummary,
	subagentsSummary,
	todosSummary,
} from "../../activities/summary";
import { createFocusRequest, createListScrollMemory } from "../../activities/focus";
import { state } from "../../state";
import { closeItemDetail } from "../../store/activities";
import { ArrowLeftIcon } from "../ui/icons";
import { ActivityJobDetail } from "./ActivityJobDetail";
import { DaemonsSection } from "./DaemonsSection";
import { JobsSection } from "./JobsSection";
import { SubagentDetail } from "./SubagentDetail";
import { SubagentsSection } from "./SubagentsSection";
import { TodosSection } from "./TodosSection";

/**
 * The Activities dock panel: sections in a fixed order (Subagents, Jobs, Daemons, Todo), each
 * present only while it has items, in one scroller. Detail mode swaps the list for one item
 * under a Back strip; Back returns to the list at the scroll offset it left. The dock supplies
 * the shell, the title and the view toggle.
 */
export const ActivitiesPanel: Component = () => {
	let list: HTMLDivElement | undefined;
	// The element is only the live list while it is attached; the detail view unmounts it.
	const liveList = () => (list?.isConnected ? list : undefined);
	const detail = createMemo(() =>
		state.activities.mode === "detail" ? state.activities.detail : undefined,
	);
	const onScroll = createListScrollMemory(liveList, () => detail());
	createFocusRequest(liveList);
	const anyItems = () =>
		subagentsSummary().total + jobsSummary().total + daemonsSummary().total + todosSummary().total >
		0;

	return (
		<div class="activities-panel" data-mode={state.activities.mode}>
			<Show
				when={detail()}
				fallback={
					<div class="activities-list" ref={(el) => (list = el)} onScroll={onScroll}>
						<Show when={subagentsSummary().total > 0}>
							<SubagentsSection />
						</Show>
						<Show when={jobsSummary().total > 0}>
							<JobsSection />
						</Show>
						<Show when={daemonsSummary().total > 0}>
							<DaemonsSection />
						</Show>
						<Show when={todosSummary().total > 0}>
							<TodosSection />
						</Show>
						<Show when={!anyItems()}>
							<p class="activities-empty">
								Nothing here yet. Subagents, jobs, daemons and todos appear when the session has
								them.
							</p>
						</Show>
					</div>
				}
			>
				{(item) => (
					<div class="activity-detail">
						<div class="activity-detail-bar">
							<button type="button" class="activity-detail-back" onClick={closeItemDetail}>
								<ArrowLeftIcon />
								Back to list
							</button>
						</div>
						<Show when={`${item().section}:${item().id}`} keyed>
							{(key) => (
								<div class="activity-detail-body" data-activity-detail={key}>
									<Switch>
										<Match when={item().section === "subagents"}>
											<SubagentDetail id={item().id} />
										</Match>
										<Match when={item().section === "jobs"}>
											<ActivityJobDetail id={item().id} standalone />
										</Match>
									</Switch>
								</div>
							)}
						</Show>
					</div>
				)}
			</Show>
		</div>
	);
};
