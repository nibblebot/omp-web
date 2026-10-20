import { SubagentTreeRow } from "../../../web/components/subagents/SubagentTreeRow";
import { setFeaturePreference } from "../../../web/features/preferences";
import { agentNode, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const noop = () => {};

const row = (id: string, level: number, expanded = false) => (
	<SubagentTreeRow
		node={agentNode(id)}
		level={level}
		expanded={expanded}
		onToggle={noop}
		onOpen={noop}
	/>
);
// The dock's width range is about 420-520px; the narrow variants must fit without horizontal overflow.

export default defineStory({
	id: "subagents-tree-row",
	title: "SubagentTreeRow",
	component: {
		file: "apps/web/components/subagents/SubagentTreeRow.tsx",
		export: "SubagentTreeRow",
	},
	variants: [
		{
			name: "Running with in-flight tool",
			description:
				"Four lines: short name, agent type and status; the description; the model with its thinking level and the metrics; and the live line, here the tool in flight with its intent.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Live line after a failed tool",
			description:
				"With no tool in flight the live line shows the last finished tool and its intent, in the error color when that call failed.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.AdvisorA", 1),
		},
		{
			name: "Live preview off",
			description:
				"With `display.subagentLivePreview` off a running row has three lines: no live line.",
			seed: () => seedAgentTree(),
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Finished, nested",
			description:
				"A child one level down, showing its agent type and finished metrics. The model has no thinking level.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.ChatMap", 1),
		},
		{
			name: "Title from the assignment",
			description:
				"No description, so the title is the first non-empty line of the assignment. The `-2` suffix marks a repeated name and stays in the short name.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.ReviewPass.TypesCheck-2", 2),
		},
		{
			name: "Parked, model unknown",
			description:
				"A parked agent has no live progress, so the model is absent and line 3 holds only the metrics.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("DocsSweep", 0),
		},
		{
			name: "Pending",
			description: "A queued agent: no elapsed time and no metrics beyond zero tokens.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.LintPass", 1),
		},
		{
			name: "Expanded parent",
			description:
				"A failed review with its aborted and re-run typecheck children. The expander chevron points down; the row carries no subtree total.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.ReviewPass", 1, true),
		},
		{
			name: "Narrow, 420px",
			description: "The narrowest dock width: every line truncates instead of overflowing.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div style={{ width: "420px", border: "1px dashed var(--border)" }}>
					{row("FixtureBuilder", 0)}
				</div>
			),
		},
		{
			name: "Narrow, nested, 420px",
			description:
				"A nested running row at the narrowest width: the indent takes space from the text, not from the status chip.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<div style={{ width: "420px", border: "1px dashed var(--border)" }}>
					{row("FixtureBuilder.AdvisorA", 1)}
				</div>
			),
		},
		{
			name: "Open in Analysis",
			description:
				"Analysis is on and the transcript is known: the kebab offers Open in Analysis. Rows without an Analysis link show no kebab.",
			seed: () => {
				setFeaturePreference("analysis", true);
				seedAgentTree({ display: true, analysis: true });
			},
			render: () => row("FixtureBuilder", 0),
		},
	],
});
