import { SubagentDetail } from "../../../web/components/activities/SubagentDetail";
import { DockFrame, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const detail = (id: string, width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<SubagentDetail id={id} />
		</div>
	</DockFrame>
);

export default defineStory({
	id: "activities-subagent-detail",
	title: "SubagentDetail",
	component: {
		file: "apps/web/components/activities/SubagentDetail.tsx",
		export: "SubagentDetail",
	},
	tabs: true,
	variants: [
		{
			name: "Running agent",
			description:
				"A running builder: header with its title, the assignment folded with Show all, paired tool cards (one call still without a result), the status strip, and the steer composer with a Stop button.",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("FixtureBuilder"),
		},
		{
			name: "Running agent, narrow dock",
			description: "The same pane at 420px: the status strip and composer keep to one row each.",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("FixtureBuilder", 420),
		},
		{
			name: "Parked agent",
			description:
				"A parked docs sweep: its transcript stays readable, the status strip has no model, and a Parked strip offers Revive in place of the composer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("DocsSweep"),
		},
		{
			name: "Finished agent",
			description:
				"A completed scout: the transcript ends with its answer and a Finished strip replaces the composer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("FixtureBuilder.ChatMap"),
		},
		{
			name: "Finished, transcript missing",
			description:
				"A failed review whose session file is gone: the transcript request fails and the pane shows the error in an alert above the Finished strip.",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("FixtureBuilder.ReviewPass"),
		},
		{
			name: "Pending agent",
			description:
				"A queued lint pass that has not started: an empty transcript and a Starting strip with Abort agent (inline confirm).",
			seed: () => seedAgentTree({ display: true }),
			render: () => detail("FixtureBuilder.LintPass"),
		},
		{
			name: "Agent no longer in session",
			description: "The id is not in the session forest, so the detail says the agent is gone.",
			seed: () => seedAgentTree(),
			render: () => detail("missing-agent"),
		},
	],
});
