import { SubagentActionsMenu } from "../../../web/components/subagents/SubagentActionsMenu";
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
				"A parked agent's menu offers Revive. Park and Revive hide when they do not apply.",
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
			name: "Nothing applies",
			description: "No lifecycle action: the menu renders nothing.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentActionsMenu id="FixtureBuilder" label="More actions for FixtureBuilder" />
				</div>
			),
		},
	],
});
