import { createMemo, type Component } from "solid-js";
import { todosSummary } from "../../activities/summary";
import { ActivitySection } from "./ActivitySection";
import { TodoChecklist } from "./TodoChecklist";

/** The Todo section: the agent's todo board, read-only. Folds as a whole; its rows are static. */
export const TodosSection: Component = () => {
	const summary = createMemo(todosSummary);
	return (
		<ActivitySection
			id="todos"
			title="Todo"
			count={{ done: summary().done, total: summary().total }}
		>
			<TodoChecklist />
		</ActivitySection>
	);
};
