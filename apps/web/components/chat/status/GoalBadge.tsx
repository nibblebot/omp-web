import { Show } from "solid-js";
import { formatTokens } from "../../../usage/context";
import { setState, state } from "../../../state";
import { StatusSegment } from "./StatusSegment";

/**
 * Main-header goal badge (goals feature slot). Shows the full objective (CSS
 * ellipsis, never a JS slice), the token budget when one is set, and a paused
 * marker. Click opens the Goal dialog, the single goals surface.
 */
export const GoalBadge = () => (
	<Show when={state.goal}>
		{(g) => (
			<StatusSegment
				class="badge goal-badge"
				title={g().objective}
				onClick={() => setState("modal", "goal")}
			>
				<span class="goal-badge-label">goal:</span>
				<span class="goal-badge-objective">{g().objective}</span>
				<Show when={state.goalModeState?.goal?.status === "paused"}>
					<span class="goal-badge-state">paused</span>
				</Show>
				<Show when={state.goalModeState?.goal?.tokenBudget}>
					{(budget) => (
						<span class="goal-badge-budget">
							{formatTokens(state.goalModeState?.goal?.tokensUsed ?? 0)}/{formatTokens(budget())}
						</span>
					)}
				</Show>
			</StatusSegment>
		)}
	</Show>
);
