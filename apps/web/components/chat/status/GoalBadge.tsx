import { Show } from "solid-js";
import { setState, state } from "../../../state";
import { StatusSegment } from "./StatusSegment";

/** Main-header goal badge (goals feature slot); click opens the goal popover. */
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
