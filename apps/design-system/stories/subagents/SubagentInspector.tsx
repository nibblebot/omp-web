import { SubagentInspector } from "../../../web/components/subagents/SubagentInspector";
import { seedSubagents, subagentById } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-subagent-inspector",
	title: "SubagentInspector",
	component: {
		file: "apps/web/components/subagents/SubagentInspector.tsx",
		export: "SubagentInspector",
	},
	variants: [
		{
			name: "Context: builder",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentInspector sub={subagentById("1-FixtureBuilder")} tab="context" />
				</div>
			),
		},
		{
			name: "Lineage: builder",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentInspector sub={subagentById("1-FixtureBuilder")} tab="lineage" />
				</div>
			),
		},
		{
			name: "Patch: builder",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentInspector sub={subagentById("1-FixtureBuilder")} tab="patch" />
				</div>
			),
		},
		{
			name: "Output: explore completed",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentInspector sub={subagentById("0-ChatMap")} tab="output" />
				</div>
			),
		},
		{
			name: "Output: failed reviewer",
			description: "The reviewer failed before writing an artifact.",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentInspector sub={subagentById("2-ReviewPass")} tab="output" />
				</div>
			),
		},
	],
});
