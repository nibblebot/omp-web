import { For, type Component } from "solid-js";
import { state } from "../../state";
import { setActivityFilter, type ActivityFilter } from "../../store/activities";

const FILTERS: readonly { filter: ActivityFilter; label: string }[] = [
	{ filter: "all", label: "All" },
	{ filter: "running", label: "Running" },
];

/**
 * Segmented control in a section header (Subagents, Jobs): only the items that are running, or
 * every item. Words, no icons. `label` names the group for assistive tech ("Show subagents").
 */
export const ActivityFilterToggle: Component<{ section: "subagents" | "jobs"; label: string }> = (
	props,
) => {
	const current = () => state.activities.filters[props.section];
	return (
		<div class="activity-filter-toggle" role="group" aria-label={props.label}>
			<For each={FILTERS}>
				{(entry) => (
					<button
						type="button"
						class="segment segment-button"
						classList={{ active: current() === entry.filter }}
						aria-pressed={current() === entry.filter}
						onClick={() => setActivityFilter(props.section, entry.filter)}
					>
						{entry.label}
					</button>
				)}
			</For>
		</div>
	);
};
