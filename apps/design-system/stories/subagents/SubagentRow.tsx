import { For } from "solid-js";
import { SubagentRow } from "../../../web/components/subagents/SubagentRow";
import { subagentRows } from "../../fixtures/shared";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-subagent-row",
	title: "SubagentRow",
	component: { file: "apps/web/components/subagents/SubagentRow.tsx", export: "SubagentRow" },
	variants: [
		{
			name: "Running",
			description: "A running scout, shown with the default compact row.",
			render: () => <SubagentRow sub={subagentRows[0]} />,
		},
		{
			name: "All statuses",
			description: "One row per lifecycle status, with the meta columns (model and last activity).",
			render: () => (
				<div>
					<For each={subagentRows}>
						{(sub) => <SubagentRow sub={sub} showMeta model="anthropic/claude-sonnet-4-5" />}
					</For>
				</div>
			),
		},
		{
			name: "Unread",
			description: "unread shows the activity dot for output the operator has not seen yet.",
			render: () => (
				<SubagentRow sub={subagentRows[2]} showMeta unread model="anthropic/claude-opus-4-1" />
			),
		},
		{
			name: "Nested child",
			description:
				"A dotted id renders as a nested name, Anna>Bob, with the agent type shown beside it.",
			render: () => <SubagentRow sub={subagentRows[6]} showMeta />,
		},
	],
});
