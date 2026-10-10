import { GoalModal } from "../../../../web/components/chat/controls/GoalModal";
import {
	goalActive,
	goalBudgetLimited,
	goalCompleted,
	goalPaused,
} from "../../../fixtures/dialogs";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-controls-goal-modal",
	title: "GoalModal",
	component: { file: "apps/web/components/chat/controls/GoalModal.tsx", export: "GoalModal" },
	tabs: true,
	variants: [
		{
			name: "No goal set",
			render: () => <GoalModal onClose={() => {}} />,
		},
		{
			name: "Active with token budget",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalActive } },
			render: () => <GoalModal onClose={() => {}} />,
		},
		{
			name: "Paused",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalPaused } },
			render: () => <GoalModal onClose={() => {}} />,
		},
		{
			name: "Budget limited",
			seed: { goalModeState: { enabled: true, mode: "active", goal: goalBudgetLimited } },
			render: () => <GoalModal onClose={() => {}} />,
		},
		{
			name: "Completed, exiting goal mode",
			seed: {
				goalModeState: { enabled: true, mode: "exiting", reason: "completed", goal: goalCompleted },
			},
			render: () => <GoalModal onClose={() => {}} />,
		},
	],
});
