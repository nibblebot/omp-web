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
						goal: { objective: "Ship the subagent design-system stories" },
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
						goal: { objective: "Migrate the roster filters to the shared picker" },
						goalModeState: goalPaused,
					},
				),
			render: () => <GoalBadge />,
		},
		{
			name: "No goal",
			description: "Renders nothing until a goal is set.",
			seed: () => seedSubagents({}, { goal: null, goalModeState: undefined }),
			render: () => <GoalBadge />,
		},
	],
});
