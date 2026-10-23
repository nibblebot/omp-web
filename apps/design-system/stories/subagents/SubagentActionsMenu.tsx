import { SubagentActionsMenu } from "../../../web/components/subagents/SubagentActionsMenu";
import { setFeaturePreference } from "../../../web/features/preferences";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-actions-menu",
	title: "SubagentActionsMenu",
	component: {
		file: "apps/web/components/subagents/SubagentActionsMenu.tsx",
		export: "SubagentActionsMenu",
	},
	variants: [
		{
			name: "Parked agent, lifecycle on",
			description:
				"A parked agent's menu offers Revive. Park, Revive and Analysis hide when they do not apply.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentActionsMenu id="DocsSweep" label="More actions for DocsSweep" lifecycle />
				</div>
			),
		},
		{
			name: "Finished agent, lifecycle on",
			description: "A finished agent can be parked.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentActionsMenu
						id="FixtureBuilder.ChatMap"
						label="More actions for ChatMap"
						lifecycle
					/>
				</div>
			),
		},
		{
			name: "Open in Analysis only",
			description:
				"Without `lifecycle` (the single view's list rows and the Task card tree) only Open in Analysis appears, and only when Analysis is on and the transcript is known.",
			seed: () => {
				setFeaturePreference("analysis", true);
				seedAgentTree({ display: true, analysis: true });
			},
			render: () => (
				<div class="ds-frame">
					<SubagentActionsMenu id="FixtureBuilder" label="More actions for FixtureBuilder" />
				</div>
			),
		},
		{
			name: "Nothing applies",
			description: "No lifecycle action and no Analysis link: the menu renders nothing.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentActionsMenu id="FixtureBuilder" label="More actions for FixtureBuilder" />
				</div>
			),
		},
	],
});
