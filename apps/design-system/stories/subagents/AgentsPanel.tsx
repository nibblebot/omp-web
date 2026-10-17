import { AgentsPanel } from "../../../web/components/subagents/AgentsPanel";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-agents-panel",
	title: "AgentsPanel",
	component: {
		file: "apps/web/components/subagents/AgentsPanel.tsx",
		export: "AgentsPanel",
	},
	variants: [
		{
			name: "Forest present",
			description: "The session's agent forest with its totals footer.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AgentsPanel />
				</div>
			),
		},
		{
			name: "Empty session",
			description: "No agents yet: the panel explains that agents appear when a Task runs.",
			seed: () => seedAgentTree({ empty: true }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AgentsPanel />
				</div>
			),
		},
	],
});
