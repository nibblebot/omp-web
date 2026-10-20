import { SubagentStatusBar } from "../../../web/components/subagents/SubagentStatusBar";
import { agentNode, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-status-bar",
	title: "SubagentStatusBar",
	component: {
		file: "apps/web/components/subagents/SubagentStatusBar.tsx",
		export: "SubagentStatusBar",
	},
	variants: [
		{
			name: "Running with children",
			description:
				"Model, thinking level, context, tokens, cost and a ticking elapsed time, plus the subtree total because this agent spawned others.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <SubagentStatusBar node={agentNode("FixtureBuilder")} />,
		},
		{
			name: "Finished leaf",
			description: "A completed scout: fixed elapsed time and no subtree segment.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <SubagentStatusBar node={agentNode("FixtureBuilder.ChatMap")} />,
		},
		{
			name: "Parked, model unknown",
			description:
				"A parked agent has no live progress, so the model and thinking segments are omitted.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <SubagentStatusBar node={agentNode("DocsSweep")} />,
		},
		{
			name: "Pending",
			description: "A queued agent: no elapsed time and no context percentage yet.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <SubagentStatusBar node={agentNode("FixtureBuilder.LintPass")} />,
		},
		{
			name: "Narrow, 420px",
			description: "The strip at the narrowest dock width.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div style={{ width: "420px", border: "1px dashed var(--border)" }}>
					<SubagentStatusBar node={agentNode("FixtureBuilder")} />
				</div>
			),
		},
	],
});
