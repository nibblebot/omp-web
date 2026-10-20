import { SubagentTranscript } from "../../../web/components/subagents/SubagentTranscript";
import { seedAgentTree, seedSubagents } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-transcript",
	title: "SubagentTranscript",
	component: {
		file: "apps/web/components/subagents/SubagentTranscript.tsx",
		export: "SubagentTranscript",
	},
	variants: [
		{
			name: "Running agent",
			description:
				"The builder's transcript as the chat cards draw it: a folded assignment with Show all, grep/read/edit/bash cards paired with their results (one failed), and a last edit call still without a result, which shows as running.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<SubagentTranscript id="FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Finished agent",
			description: "A completed scout's transcript, loaded from the start until caught up.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<SubagentTranscript id="FixtureBuilder.ChatMap" />
				</div>
			),
		},
		{
			name: "Loading",
			description: "The transcript request is in flight, so the panel shows its loading line.",
			seed: () =>
				seedSubagents({
					// Never settles: holds the panel in its loading state.
					getSubagentMessages: () => Promise.withResolvers<never>().promise,
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<SubagentTranscript id="FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Empty",
			description: "The session file has no entries for this agent yet.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<SubagentTranscript id="FixtureBuilder.LintPass" />
				</div>
			),
		},
		{
			name: "Load failed",
			description: "The transcript request fails, so the panel shows the error in an alert.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<SubagentTranscript id="FixtureBuilder.ReviewPass" />
				</div>
			),
		},
	],
});
