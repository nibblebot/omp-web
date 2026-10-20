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
				"Roots, children, and a grandchild with a repeated name, with a pending and a parked agent. Arrow keys move through the tree.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame">
					<SubagentTree nodes={subagentForest()} label="Agents" onOpen={() => {}} />
				</div>
			),
		},
		{
			name: "Narrow, 420px",
			description:
				"The same forest at the narrowest dock width: rows truncate and never scroll sideways.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div class="ds-frame" style={{ width: "420px", border: "1px dashed var(--border)" }}>
					<SubagentTree nodes={subagentForest()} label="Agents" onOpen={() => {}} />
				</div>
			),
		},
		{
			name: "Live preview off",
			description: "Without the live preview setting, running rows have three lines.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame">
					<SubagentTree nodes={subagentForest()} label="Agents" onOpen={() => {}} />
				</div>
			),
		},
	],
});
