import { SubagentConversation } from "../../../web/components/subagents/SubagentConversation";
import { DockFrame, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const conversation = (id: string) => (
	<DockFrame title="Agent" width={520} flush>
		<SubagentConversation id={id} />
	</DockFrame>
);

export default defineStory({
	id: "subagents-conversation",
	title: "SubagentConversation",
	component: {
		file: "apps/web/components/subagents/SubagentConversation.tsx",
		export: "SubagentConversation",
	},
	variants: [
		{
			name: "Running agent",
			description:
				"Transcript, status bar and the steer composer with Stop, with no header: the pane and the accordion row supply that.",
			seed: () => seedAgentTree({ display: true }),
			render: () => conversation("FixtureBuilder"),
		},
		{
			name: "Parked agent",
			description: "A Parked strip with Revive replaces the composer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => conversation("DocsSweep"),
		},
		{
			name: "Pending agent",
			description: "A queued agent: empty transcript and a Starting strip with Abort agent.",
			seed: () => seedAgentTree({ display: true }),
			render: () => conversation("FixtureBuilder.LintPass"),
		},
		{
			name: "Finished agent",
			description: "A Finished strip closes the transcript.",
			seed: () => seedAgentTree({ display: true }),
			render: () => conversation("FixtureBuilder.ChatMap"),
		},
	],
});
