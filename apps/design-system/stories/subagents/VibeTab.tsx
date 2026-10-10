import { VibeTab } from "../../../web/components/subagents/GoalLoopPanel";
import { ClickOnMount, seedSubagents, vibeEnabled } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-vibe-tab",
	title: "VibeTab",
	component: { file: "apps/web/components/subagents/GoalLoopPanel.tsx", export: "VibeTab" },
	variants: [
		{
			name: "Enabled, two workers",
			seed: () => seedSubagents({ vibeStatus: () => vibeEnabled }),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh"]}>
						<VibeTab />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Vibe off",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh"]}>
						<VibeTab />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Status unavailable",
			description: "The daemon rejects vibeStatus; the section shows the error.",
			seed: () =>
				seedSubagents({
					vibeStatus: () => {
						throw new Error("vibe mode is not available on this daemon");
					},
				}),
			render: () => (
				<div class="ds-frame">
					<ClickOnMount labels={["refresh"]}>
						<VibeTab />
					</ClickOnMount>
				</div>
			),
		},
	],
});
