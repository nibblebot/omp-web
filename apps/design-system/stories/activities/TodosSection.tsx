import { TodosSection } from "../../../web/components/activities/TodosSection";
import { toggleSectionCollapsed } from "../../../web/store/activities";
import { advanceTodos, seedTodos, todoPhasesDone } from "../../fixtures/activities";
import { DockFrame } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const section = (width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<div class="activities-list">
				<TodosSection />
			</div>
		</div>
	</DockFrame>
);

export default defineStory({
	id: "activities-todos-section",
	title: "TodosSection",
	component: {
		file: "apps/web/components/activities/TodosSection.tsx",
		export: "TodosSection",
	},
	variants: [
		{
			name: "Phased checklist",
			description:
				"The agent's board under the Todo header with the done count (completed and abandoned). Rows are static: nothing opens or expands.",
			seed: () => seedTodos(),
			render: () => section(),
		},
		{
			name: "Follows the live board",
			description:
				"The board is the live todoPhases: Advance completes the underway task and starts the next, and the checklist and the done count follow.",
			seed: () => seedTodos(),
			render: () => (
				<>
					{section()}
					<button type="button" onClick={advanceTodos}>
						Advance the board
					</button>
				</>
			),
		},
		{
			name: "All done",
			description: "Every task finished: the count reads total/total.",
			seed: () => seedTodos(todoPhasesDone),
			render: () => section(),
		},
		{
			name: "Collapsed",
			description: "The header folds the whole section; the count stays.",
			seed: () => {
				seedTodos();
				toggleSectionCollapsed("todos");
			},
			render: () => section(),
		},
		{
			name: "Narrow dock, 420px",
			description: "Long task text wraps instead of overflowing.",
			seed: () => seedTodos(),
			render: () => section(420),
		},
	],
});
