import { SubagentTreeRow } from "../../../web/components/subagents/SubagentTreeRow";
import { subagentRegionDomId } from "../../../web/subagents/tree";
import {
	agentEntry,
	authoringEntry,
	benchEntry,
	seedJobWidgets,
	WIDGET_AGENT_ID,
} from "../../fixtures/job-widget-entries";
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
				"Three rows in two columns: short name and agent type beside the status; the description beside the model with its thinking level; and the live line (the agent's stage, then the tool in flight) beside the metrics. A running agent that has estimated its progress leads the metrics with a completion ring and its percent in the accent; hover for the stage.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Live line after a failed tool",
			description:
				"With no tool in flight the live line shows the last finished tool and its intent, in the error color when that call failed. This agent has no stage yet, but its early estimate (12%) already shows.",
			seed: () => seedAgentTree({ display: true }),
			render: () => row("FixtureBuilder.AdvisorA", 1),
		},
		{
			name: "Running with a job widget, headline and meter",
			description:
				"The agent's task job shares its id, so the session process's job widget for it shows as a glance row under the metrics: the headline figure with the agent's own progress.",
			seed: () => {
				seedAgentTree({ display: true });
				seedJobWidgets(0, [agentEntry()]);
			},
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Running with a job widget, mini chart",
			description:
				"A widget with a time series draws its newest values as a mini chart before the figure and its trend.",
			seed: () => {
				seedAgentTree({ display: true });
				seedJobWidgets(0, [{ ...benchEntry(), id: WIDGET_AGENT_ID, type: "task" }]);
			},
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Running, widget being written",
			description:
				"No figure yet while the widget model writes its spec: the glance says so instead of staying blank.",
			seed: () => {
				seedAgentTree({ display: true });
				seedJobWidgets(0, [{ ...authoringEntry(), id: WIDGET_AGENT_ID, type: "task" }]);
			},
			render: () => row("FixtureBuilder", 0),
		},
		{
			name: "Narrow with a job widget, 420px",
			description: "At the narrowest dock width the glance truncates inside its row.",
			seed: () => {
				seedAgentTree({ display: true });
				seedJobWidgets(0, [{ ...benchEntry(), id: WIDGET_AGENT_ID, type: "task" }]);
			},
			render: () => (
				<div style={{ width: "420px", border: "1px dashed var(--border)" }}>
					{row("FixtureBuilder", 0)}
				</div>
			),
		},
		{
			name: "Settled agent with a stale widget",
			description:
				"A finished agent shows no glance even when the store still holds an entry for its id.",
			seed: () => {
				seedAgentTree({ display: true });
				seedJobWidgets(0, [{ ...agentEntry(), id: "FixtureBuilder.ChatMap" }]);
			},
			render: () => row("FixtureBuilder.ChatMap", 1),
		},
		{
			name: "Live preview off",
			description:
				"With `display.subagentLivePreview` off a running row has no live line; the completion ring and percent stay, because they are not part of the preview.",
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
				"A parked agent has no live progress, so the model is absent and the right column holds only the status and the metrics.",
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
			name: "Selected, accordion row",
			description:
				"The expanded agent's row in the accordion: hover background, accent card outline (in the Activities panel), aria-selected true, and aria-controls naming its region.",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("FixtureBuilder")}
					level={1}
					expanded={false}
					onToggle={noop}
					onOpen={noop}
					selected
					controlsId={subagentRegionDomId("FixtureBuilder")}
					menu={false}
				/>
			),
		},
		{
			name: "Not selected, accordion row",
			description:
				"Another row of the accordion: aria-selected false, and no kebab (the Activities panel turns row menus off).",
			seed: () => seedAgentTree({ display: true }),
			render: () => (
				<SubagentTreeRow
					node={agentNode("DocsSweep")}
					level={1}
					expanded={false}
					onToggle={noop}
					onOpen={noop}
					selected={false}
					menu={false}
				/>
			),
		},
	],
});
