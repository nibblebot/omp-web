import { GoalDialog } from "../../../../web/components/chat/controls/GoalDialog";
import {
	goalActive,
	goalBudgetLimited,
	goalCompleted,
	goalPaused,
} from "../../../fixtures/dialogs";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-controls-goal-dialog",
	title: "GoalDialog",
	component: { file: "apps/web/components/chat/controls/GoalDialog.tsx", export: "GoalDialog" },
	tabs: true,
	variants: [
		{
			name: "No goal set",
			render: () => <GoalDialog onClose={() => {}} />,
		},
		{
			name: "Active with token budget",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalActive } },
			render: () => <GoalDialog onClose={() => {}} />,
		},
		{
			name: "Paused",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalPaused } },
			render: () => <GoalDialog onClose={() => {}} />,
		},
		{
			name: "Budget limited",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalBudgetLimited } },
			render: () => <GoalDialog onClose={() => {}} />,
		},
		{
			name: "Completed, exiting goal mode",
			seed: {
				goalModeState: { enabled: true, mode: "exiting", reason: "completed", goal: goalCompleted },
			},
			render: () => <GoalDialog onClose={() => {}} />,
		},
	],
});
