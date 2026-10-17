import { GoalDialog } from "../../../../web/components/chat/controls/GoalDialog";
import { goalCompleted } from "../../../fixtures/dialogs";
import {
	ClickOnMount,
	goalActive,
	goalBudgetLimited,
	goalPaused,
	loopPolicyRunning,
	seedSubagents,
	vibeEnabled,
} from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-controls-goal-dialog",
	title: "GoalDialog",
	component: { file: "apps/web/components/chat/controls/GoalDialog.tsx", export: "GoalDialog" },
	tabs: true,
	variants: [
		{
			name: "No goal set",
			seed: () => seedSubagents({}, { goalModeState: undefined }),
			render: (ctx) => <GoalDialog onClose={ctx.close} />,
		},
		{
			name: "Active with token budget",
			seed: () => seedSubagents({}, { goalModeState: goalActive }),
			render: (ctx) => <GoalDialog onClose={ctx.close} />,
		},
		{
			name: "Paused",
			seed: () => seedSubagents({}, { goalModeState: goalPaused }),
			render: (ctx) => <GoalDialog onClose={ctx.close} />,
		},
		{
			name: "Budget limited",
			seed: () => seedSubagents({}, { goalModeState: goalBudgetLimited }),
			render: (ctx) => <GoalDialog onClose={ctx.close} />,
		},
		{
			name: "Completed, exiting goal mode",
			seed: () =>
				seedSubagents(
					{},
					{
						goalModeState: {
							enabled: true,
							mode: "exiting",
							reason: "completed",
							goal: goalCompleted,
						},
					},
				),
			render: (ctx) => <GoalDialog onClose={ctx.close} />,
		},
		{
			name: "Loops tab, loop running",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyRunning }, { goalModeState: goalActive }),
			render: (ctx) => (
				<ClickOnMount labels={["Loops"]}>
					<GoalDialog onClose={ctx.close} />
				</ClickOnMount>
			),
		},
		{
			name: "Vibe tab, workers running",
			seed: () => seedSubagents({ vibeStatus: () => vibeEnabled }, { goalModeState: goalActive }),
			render: (ctx) => (
				<ClickOnMount labels={["Vibe"]}>
					<GoalDialog onClose={ctx.close} />
				</ClickOnMount>
			),
		},
	],
});
