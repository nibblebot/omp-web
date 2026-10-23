import { SubagentPanel } from "../../../web/components/subagents/SubagentPanel";
import { DockFrame, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-panel",
	title: "SubagentPanel",
	component: {
		file: "apps/web/components/subagents/SubagentPanel.tsx",
		export: "SubagentPanel",
	},
	tabs: true,
	variants: [
		{
			name: "Running agent",
			description:
				"A running builder: header with its title, the assignment folded with Show all, paired tool cards (one call still without a result), the status strip, and the steer composer with a Stop button.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="FixtureBuilder" />
				</DockFrame>
			),
		},
		{
			name: "Running agent, narrow dock",
			description: "The same pane at 420px: the status strip and composer keep to one row each.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={420} flush>
					<SubagentPanel id="FixtureBuilder" />
				</DockFrame>
			),
		},
		{
			name: "Parked agent",
			description:
				"A parked docs sweep: its transcript stays readable, the status strip has no model, and a Parked strip offers Revive in place of the composer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="DocsSweep" />
				</DockFrame>
			),
		},
		{
			name: "Finished agent",
			description:
				"A completed scout: the transcript ends with its answer and a Finished strip replaces the composer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="FixtureBuilder.ChatMap" />
				</DockFrame>
			),
		},
		{
			name: "Finished, transcript missing",
			description:
				"A failed review whose session file is gone: the transcript request fails and the pane shows the error in an alert above the Finished strip.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="FixtureBuilder.ReviewPass" />
				</DockFrame>
			),
		},
		{
			name: "Pending agent",
			description:
				"A queued lint pass that has not started: an empty transcript and a Starting strip with Abort agent (inline confirm).",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="FixtureBuilder.LintPass" />
				</DockFrame>
			),
		},
		{
			name: "Agent no longer in session",
			description: "The id is not in the session forest, so the panel says the agent is gone.",
			seed: () => seedAgentTree(),
			render: () => (
				<DockFrame title="Agent" width={520} flush>
					<SubagentPanel id="missing-agent" />
				</DockFrame>
			),
		},
	],
});
