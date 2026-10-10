import { GoalLoopPanel } from "../../../web/components/subagents/GoalLoopPanel";
import {
	ClickOnMount,
	goalActive,
	goalBudgetLimited,
	goalPaused,
	loopPolicyPaused,
	loopPolicyRunning,
	loopPolicyStopped,
	seedSubagents,
	vibeEnabled,
} from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-goal-loop-panel",
	title: "GoalLoopPanel",
	component: { file: "apps/web/components/subagents/GoalLoopPanel.tsx", export: "GoalLoopPanel" },
	variants: [
		{
			name: "Goal active, loop running, vibe on",
			seed: () =>
				seedSubagents(
					{ loopPolicy: () => loopPolicyRunning, vibeStatus: () => vibeEnabled },
					{ goalModeState: goalActive },
				),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<ClickOnMount labels={["refresh", "refresh scheduler"]}>
						<GoalLoopPanel />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "No goal, scheduler idle, vibe off",
			seed: () => seedSubagents({}, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<ClickOnMount labels={["refresh", "refresh scheduler"]}>
						<GoalLoopPanel />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Goal paused, loop paused",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyPaused }, { goalModeState: goalPaused }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<ClickOnMount labels={["refresh", "refresh scheduler"]}>
						<GoalLoopPanel />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Budget exhausted, loop stopped",
			seed: () =>
				seedSubagents(
					{ loopPolicy: () => loopPolicyStopped, vibeStatus: () => vibeEnabled },
					{ goalModeState: goalBudgetLimited },
				),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<ClickOnMount labels={["refresh", "refresh scheduler"]}>
						<GoalLoopPanel />
					</ClickOnMount>
				</div>
			),
		},
	],
});
