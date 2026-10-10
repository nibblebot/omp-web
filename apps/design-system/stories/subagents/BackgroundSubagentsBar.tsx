import { BackgroundSubagentsBar } from "../../../web/components/subagents/BackgroundSubagentsBar";
import { infosFor, seedSubagents, subagentMapOf } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-background-subagents-bar",
	title: "BackgroundSubagentsBar",
	component: {
		file: "apps/web/components/subagents/BackgroundSubagentsBar.tsx",
		export: "BackgroundSubagentsBar",
	},
	variants: [
		{
			name: "One worker running",
			seed: () => seedSubagents({}, { subagents: subagentMapOf(infosFor("1-FixtureBuilder")) }),
			render: () => (
				<div class="ds-frame">
					<BackgroundSubagentsBar />
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
					<BackgroundSubagentsBar />
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
					<BackgroundSubagentsBar />
				</div>
			),
		},
	],
});
