import { SubagentTree } from "../../../web/components/subagents/SubagentTree";
import { subagentForest } from "../../../web/store/subagents";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-tree",
	title: "SubagentTree",
	component: {
		file: "apps/web/components/subagents/SubagentTree.tsx",
		export: "SubagentTree",
	},
	variants: [
		{
			name: "Multi-level forest",
			description:
				"Roots, children, and a grandchild, with a pending and a parked agent. Arrow keys move through the tree.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentTree nodes={subagentForest()} label="Agents" onOpen={() => {}} />
				</div>
			),
		},
	],
});
