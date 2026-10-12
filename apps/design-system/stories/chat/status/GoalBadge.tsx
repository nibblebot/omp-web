import { GoalBadge } from "../../../../web/components/chat/status/GoalBadge";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-goal-badge",
	title: "GoalBadge",
	component: { file: "apps/web/components/chat/status/GoalBadge.tsx", export: "GoalBadge" },
	variants: [
		{
			name: "Active goal",
			description: "Clicking opens the goal popover; the badge shows the first 20 characters.",
			seed: { goal: { objective: "Ship the plugin architecture behind feature toggles" } },
			render: () => <GoalBadge />,
		},
		{
			name: "No goal",
			description: "Renders nothing until a goal is set.",
			seed: { goal: null },
			render: () => <GoalBadge />,
		},
	],
});
