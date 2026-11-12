import { TodoChecklist } from "../../../web/components/activities/TodoChecklist";
import { seedTodos, todoPhasesMidRun } from "../../fixtures/activities";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-todo-checklist",
	title: "TodoChecklist",
	component: {
		file: "apps/web/components/activities/TodoChecklist.tsx",
		export: "TodoChecklist",
	},
	variants: [
		{
			name: "Live board",
			description:
				"Phase names over their tasks; completed and abandoned are struck through, the underway task spins.",
			seed: () => seedTodos(),
			render: () => (
				<div class="ds-frame">
					<TodoChecklist />
				</div>
			),
		},
		{
			name: "Given phases",
			description: "A capped copy passed in place of the live board (the activity bar popover).",
			seed: () => seedTodos([]),
			render: () => (
				<div class="ds-frame">
					<TodoChecklist phases={todoPhasesMidRun.slice(1, 2)} />
				</div>
			),
		},
		{
			name: "Empty board",
			description: "No phases: nothing renders (the panel hides the section).",
			seed: () => seedTodos([]),
			render: () => (
				<div class="ds-frame">
					<TodoChecklist />
				</div>
			),
		},
	],
});
