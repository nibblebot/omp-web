import { SubagentPanel } from "../../../web/components/subagents/SubagentPanel";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";
import { setFeaturePreference } from "../../../web/features/preferences";

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
			description: "A running builder: steer and abort are available, park is not.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentPanel id="1-FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Pending agent",
			description: "A queued lint pass that has not started: abort is available.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentPanel id="6-LintPass" />
				</div>
			),
		},
		{
			name: "Parked agent",
			description: "A parked docs sweep: it is held for follow-up and cannot be steered.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentPanel id="4-DocsSweep" />
				</div>
			),
		},
		{
			name: "Open in Analysis",
			description:
				"Analysis is on and the transcript is known: the header offers Open in Analysis next to the status chip.",
			seed: () => {
				setFeaturePreference("analysis", true);
				seedAgentTree({ display: true, analysis: true });
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentPanel id="1-FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Agent no longer in session",
			description: "The id is not in the session forest, so the panel says the agent is gone.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<SubagentPanel id="missing-agent" />
				</div>
			),
		},
	],
});
