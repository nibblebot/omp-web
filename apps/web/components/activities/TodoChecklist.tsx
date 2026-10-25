import { For, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { state } from "../../state";
import { todoIcon } from "./todo-icons";

type TodoPhase = (typeof state.todoPhases)[number];

/**
 * The session's todo list as a read-only phased checklist: each phase's name over its tasks with a
 * status icon. Reads the live board (`state.todoPhases`) unless given `phases` (a capped copy), so it
 * follows the agent as it works.
 */
export const TodoChecklist: Component<{ phases?: readonly TodoPhase[] }> = (props) => (
	<div class="todo-checklist">
		<For each={props.phases ?? state.todoPhases}>
			{(phase) => (
				<div class="todo-phase">
					<div class="todo-phase-name">{phase.name}</div>
					<For each={phase.tasks}>
						{(task) => (
							<div class="todo-item" data-status={task.status}>
								<span class="todo-glyph">
									<Dynamic component={todoIcon(task.status)} />
								</span>
								<span class="todo-text">{task.content}</span>
							</div>
						)}
					</For>
				</div>
			)}
		</For>
	</div>
);
