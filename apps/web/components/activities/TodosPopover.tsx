import { createMemo, type Component } from "solid-js";
import { capTodoTasks } from "../../activities/bar";
import { state } from "../../state";
import { ActivityPopover } from "./ActivityPopover";
import { TodoChecklist } from "./TodoChecklist";

/** Read-only phased checklist above the bar's Todo button, capped to its first tasks; rows are inert. */
export const TodosPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (props) => {
	const capped = createMemo(() => capTodoTasks(state.todoPhases));
	return (
		<ActivityPopover
			section="todos"
			title="Todo"
			anchor={props.anchor}
			onClose={props.onClose}
			more={capped().more}
		>
			<TodoChecklist phases={capped().shown} />
		</ActivityPopover>
	);
};
