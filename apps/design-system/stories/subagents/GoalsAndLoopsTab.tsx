import { GoalsAndLoopsTab } from "../../../web/components/subagents/GoalLoopPanel";
import {
	ClickOnMount,
	goalActive,
	goalBudgetLimited,
	loopPolicyRunning,
	loopPolicyStopped,
	seedSubagents,
} from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-goals-and-loops-tab",
	title: "GoalsAndLoopsTab",
	component: {
		file: "apps/web/components/subagents/GoalLoopPanel.tsx",
		export: "GoalsAndLoopsTab",
	},
	variants: [
		{
			name: "Goal active, loop running",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyRunning }, { goalModeState: goalActive }),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh scheduler"]}>
						<GoalsAndLoopsTab />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "No goal, scheduler idle",
			seed: () => seedSubagents({}, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh scheduler"]}>
						<GoalsAndLoopsTab />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Budget exhausted, loop stopped",
			seed: () =>
				seedSubagents(
					{ loopPolicy: () => loopPolicyStopped },
					{ goalModeState: goalBudgetLimited },
				),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh scheduler"]}>
						<GoalsAndLoopsTab />
					</ClickOnMount>
				</div>
			),
		},
	],
});
