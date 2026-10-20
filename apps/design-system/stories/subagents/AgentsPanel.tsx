import { AgentsPanel } from "../../../web/components/subagents/AgentsPanel";
import { DockFrame, seedAgentTree } from "../../fixtures/subagents";
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
				<DockFrame title="Agents" width={520}>
					<AgentsPanel />
				</DockFrame>
			),
		},
		{
			name: "Narrow dock, 420px",
			description: "The dock at its narrowest: all four row lines fit without horizontal overflow.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<DockFrame title="Agents" width={420}>
					<AgentsPanel />
				</DockFrame>
			),
		},
		{
			name: "Empty session",
			description: "No agents yet: the panel explains that agents appear when a Task runs.",
			seed: () => seedAgentTree({ empty: true }),
			render: () => (
				<DockFrame title="Agents" width={520}>
					<AgentsPanel />
				</DockFrame>
			),
		},
	],
});
