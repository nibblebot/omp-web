import { SubagentTreeRow } from "../../../web/components/subagents/SubagentTreeRow";
import { agentNode, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const noop = () => {};

export default defineStory({
	id: "subagents-tree-row",
	title: "SubagentTreeRow",
	component: {
		file: "apps/web/components/subagents/SubagentTreeRow.tsx",
		export: "SubagentTreeRow",
	},
	variants: [
		{
			name: "Root row",
			description: "A top-level running agent, collapsed, with its children hidden.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("1-FixtureBuilder")}
					level={0}
					expanded={false}
					onToggle={noop}
					onOpen={noop}
				/>
			),
		},
		{
			name: "Nested with agent type",
			description: "A child agent one level down, showing its agent type and finished metrics.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("0-ChatMap")}
					level={1}
					expanded={false}
					onToggle={noop}
					onOpen={noop}
				/>
			),
		},
		{
			name: "Live tool",
			description:
				"A running advisor showing the tool it is using now, with the resolved-model badge. The live preview is on.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("3-AdvisorA")}
					level={1}
					expanded={false}
					onToggle={noop}
					onOpen={noop}
				/>
			),
		},
		{
			name: "Expanded with subtree metrics",
			description:
				"A failed review with its aborted typecheck child. The row is expanded and its subtree totals are shown.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("2-ReviewPass")}
					level={1}
					expanded={true}
					onToggle={noop}
					onOpen={noop}
				/>
			),
		},
	],
});
