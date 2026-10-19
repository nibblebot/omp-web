import { TodoPanel } from "../../../web/components/review/TodoPanel";
import { todoCalls } from "../../fixtures/review";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "review-todo-panel",
	title: "TodoPanel",
	component: { file: "apps/web/components/review/TodoPanel.tsx", export: "TodoPanel" },
	variants: [
		{
			name: "Board",
			description: "Phased tasks with a blocked item, a dropped item, and one selected task.",
			seed: () => answerCalls(todoCalls()),
			render: () => (
				<div class="ds-frame-tall">
					<TodoPanel />
				</div>
			),
		},
		{
			name: "Revision conflict",
			description:
				"Applying an edit raced a newer revision, so the board refreshes and shows the conflict.",
			seed: () => answerCalls(todoCalls({ conflict: true })),
			render: () => (
				<div class="ds-frame-tall">
					<TodoPanel />
				</div>
			),
		},
		{
			name: "Loading",
			description: "The board request is still in flight.",
			seed: () => answerCalls(todoCalls({ pending: true })),
			render: () => (
				<div class="ds-frame-tall">
					<TodoPanel />
				</div>
			),
		},
		{
			name: "Load error",
			description: "The todo store could not be read for this session.",
			seed: () => answerCalls(todoCalls({ loadError: "todo store for sess_09a41c is corrupt" })),
			render: () => (
				<div class="ds-frame-tall">
					<TodoPanel />
				</div>
			),
		},
	],
});
