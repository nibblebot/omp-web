import { Show } from "solid-js";
import { setState, state } from "../../../state";
import { StatusSegment } from "./StatusSegment";

/** Status-bar goal badge; click opens the goal popover. */
export const GoalBadge = () => (
	<Show when={state.goal}>
		{(g) => (
			<StatusSegment
				class="badge goal-badge"
				title={g().objective}
				onClick={() => setState("modal", "goal")}
			>
				goal: {g().objective.slice(0, 20)}
			</StatusSegment>
		)}
	</Show>
);
