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
			name: "Populated",
			description: "A finished builder's transcript, loaded from the session file.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentTranscript id="1-FixtureBuilder" />
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
				<div class="ds-frame ds-frame-tall">
					<SubagentTranscript id="1-FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Empty",
			description: "The session file has no entries for this agent yet.",
			seed: () =>
				seedSubagents({
					getSubagentMessages: () => ({
						sessionFile: "",
						fromByte: 0,
						nextByte: 0,
						reset: false,
						entries: [],
					}),
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentTranscript id="6-LintPass" />
				</div>
			),
		},
		{
			name: "Load failed",
			description: "The transcript request fails, so the panel shows the error in an alert.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentTranscript id="2-ReviewPass" />
				</div>
			),
		},
	],
});
