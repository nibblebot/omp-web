import { GoalBadge } from "../../../../web/components/chat/status/GoalBadge";
import { goalActive, goalPaused, seedSubagents } from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-goal-badge",
	title: "GoalBadge",
	component: { file: "apps/web/components/chat/status/GoalBadge.tsx", export: "GoalBadge" },
	variants: [
		{
			name: "Active goal with budget",
			description:
				"Shows the full objective (CSS ellipsis) and the token budget. Clicking opens the Goal dialog.",
			seed: () =>
				seedSubagents(
					{},
					{
						goalModeState: goalActive,
					},
				),
			render: () => <GoalBadge />,
		},
		{
			name: "Paused goal",
			description: "Adds a paused marker next to the objective.",
			seed: () =>
				seedSubagents(
					{},
					{
						goalModeState: goalPaused,
					},
				),
			render: () => <GoalBadge />,
		},
		{
			name: "No goal",
			description: "Renders nothing until a goal is set.",
			seed: () => seedSubagents({}, { goalModeState: undefined }),
			render: () => <GoalBadge />,
		},
		{
			name: "Narrow (390px): long objective",
			description:
				"Below 768px the objective and budget hide and the badge keeps only its label, so a long goal never pushes the header title. The full objective stays in the tooltip and the Goal dialog. Below 360px the badge hides entirely.",
			seed: () =>
				seedSubagents(
					{},
					{
						goalModeState: goalActive,
					},
				),
			render: () => <GoalBadge />,
		},
	],
});
