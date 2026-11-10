import { For, type Component } from "solid-js";
import { state } from "../../state";
import { setActivityFilter } from "../../store/activities";
import { subagentScopeCounts } from "../../store/subagents";
import { SUBAGENT_SCOPES } from "../../subagents/scope";

/**
 * The Subagents section's status scopes (All, Running, Done, Parked), as in the agent hub:
 * each button carries its live count over the whole forest and narrows the tree to its agents.
 * A scope with no agents stays listed and selectable, showing 0. Toggle buttons with
 * aria-pressed in a labelled group, one Tab stop each; the choice persists with the dock layout.
 */
export const SubagentScopeToggle: Component = () => {
	const current = () => state.activities.filters.subagents;
	return (
		<div class="subagent-scope-toggle" role="group" aria-label="Show subagents">
			<For each={SUBAGENT_SCOPES}>
				{(scope) => (
					<button
						type="button"
						class="segment segment-button"
						classList={{ active: current() === scope.id }}
						aria-pressed={current() === scope.id}
						onClick={() => setActivityFilter("subagents", scope.id)}
					>
						{scope.label}
						<span class="subagent-scope-count">{subagentScopeCounts()[scope.id]}</span>
					</button>
				)}
			</For>
		</div>
	);
};
