import { ActiveSubagents } from "../../../web/components/subagents/ActiveSubagents";
import { infosFor, seedSubagents, subagentMapOf } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-active-subagents",
	title: "ActiveSubagents",
	component: {
		file: "apps/web/components/subagents/ActiveSubagents.tsx",
		export: "ActiveSubagents",
	},
	variants: [
		{
			name: "One worker running",
			seed: () => seedSubagents({}, { subagents: subagentMapOf(infosFor("1-FixtureBuilder")) }),
			render: () => (
				<div class="ds-frame">
					<ActiveSubagents />
				</div>
			),
		},
		{
			name: "Three in flight",
			seed: () =>
				seedSubagents(
					{},
					{ subagents: subagentMapOf(infosFor("1-FixtureBuilder", "3-AdvisorA", "5-TypesCheck")) },
				),
			render: () => (
				<div class="ds-frame">
					<ActiveSubagents />
				</div>
			),
		},
		{
			name: "Nothing in flight",
			description: "Completed, failed and parked workers are not listed here.",
			seed: () =>
				seedSubagents(
					{},
					{ subagents: subagentMapOf(infosFor("0-ChatMap", "2-ReviewPass", "4-DocsSweep")) },
				),
			render: () => (
				<div class="ds-frame">
					<ActiveSubagents />
				</div>
			),
		},
	],
});
