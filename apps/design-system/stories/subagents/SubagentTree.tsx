import { createSignal } from "solid-js";
import { SubagentConversation } from "../../../web/components/subagents/SubagentConversation";
import { SubagentTree } from "../../../web/components/subagents/SubagentTree";
import { subagentForest } from "../../../web/store/subagents";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

/** Accordion tree with local expansion: click a row to expand it, again to collapse; any number stay open. */
const AccordionTree = (props: { initial?: readonly string[] }) => {
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set(props.initial));
	return (
		<div class="ds-frame ds-frame-tall">
			<SubagentTree
				nodes={subagentForest()}
				label="Agents"
				onOpen={(id) =>
					setExpanded((prev) => {
						const next = new Set(prev);
						if (!next.delete(id)) next.add(id);
						return next;
					})
				}
				accordion={{
					get expanded() {
						return expanded();
					},
					body: (id) => <SubagentConversation id={id} />,
				}}
			/>
		</div>
	);
};

/** Tree whose collapsed set is controlled by the caller, as the dock keeps it per workspace. */
const ControlledTree = () => {
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set(["FixtureBuilder"]));
	return (
		<div class="ds-frame">
			<SubagentTree
				nodes={subagentForest()}
				label="Agents"
				onOpen={() => {}}
				collapsed={collapsed()}
				onToggleCollapsed={(id) =>
					setCollapsed((prev) => {
						const next = new Set(prev);
						if (!next.delete(id)) next.add(id);
						return next;
					})
				}
			/>
		</div>
	);
};

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
			name: "Controlled collapse",
			description:
				"The caller owns the collapsed set (here FixtureBuilder starts collapsed); the chevrons and Left/Right keys call onToggleCollapsed.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <ControlledTree />,
		},
		{
			name: "Accordion, nothing expanded",
			description:
				"Accordion mode: every treeitem has aria-selected false and the kebabs offer Park or Revive. Click a row to expand it under itself.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <AccordionTree />,
		},
		{
			name: "Accordion, one expanded",
			description:
				"The expanded row is highlighted with aria-selected true and aria-controls on its region; the region sits under the row inside the same tree item, and only this agent mounts a transcript.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <AccordionTree initial={["FixtureBuilder"]} />,
		},
		{
			name: "Accordion, several expanded",
			description:
				"Any number of rows can be expanded at once; the tree is aria-multiselectable and each body mounts its own transcript.",
			seed: () => seedAgentTree({ display: true }),
			render: () => <AccordionTree initial={["FixtureBuilder", "DocsSweep"]} />,
		},
		{
			name: "Live preview off",
			description:
				"Without the live preview setting, running rows have no live line beside the metrics.",
			seed: () => seedAgentTree(),
			render: () => (
				<div class="ds-frame">
					<SubagentTree nodes={subagentForest()} label="Agents" onOpen={() => {}} />
				</div>
			),
		},
	],
});
