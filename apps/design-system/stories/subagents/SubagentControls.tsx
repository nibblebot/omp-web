import { SubagentControls } from "../../../web/components/subagents/SubagentControls";
import { seedSubagents, subagentById } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-subagent-controls",
	title: "SubagentControls",
	component: {
		file: "apps/web/components/subagents/SubagentControls.tsx",
		export: "SubagentControls",
	},
	variants: [
		{
			name: "Running builder",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame">
					<SubagentControls sub={subagentById("1-FixtureBuilder")} />
				</div>
			),
		},
		{
			name: "Running advisor (read-only steer)",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame">
					<SubagentControls sub={subagentById("3-AdvisorA")} />
				</div>
			),
		},
		{
			name: "Parked docs sweep, revivable",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame">
					<SubagentControls sub={subagentById("4-DocsSweep")} />
				</div>
			),
		},
		{
			name: "Failed reviewer",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame">
					<SubagentControls sub={subagentById("2-ReviewPass")} />
				</div>
			),
		},
	],
});
