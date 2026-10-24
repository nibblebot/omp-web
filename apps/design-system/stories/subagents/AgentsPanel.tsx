import { AgentsPanel } from "../../../web/components/subagents/AgentsPanel";
import { setAgentsFilter } from "../../../web/store/dock";
import { agentEntry, benchEntry, seedJobWidgets } from "../../fixtures/job-bars";
import { DockFrame, seedAgentsDock, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

/** The panel in a flush dock frame (the agents dock kind is flush). The mode toggle lives in DockHost's header. */
const dock = (width: number) => (
	<DockFrame title="Agents" width={width} flush>
		<AgentsPanel />
	</DockFrame>
);

export default defineStory({
	id: "subagents-agents-panel",
	title: "AgentsPanel",
	component: {
		file: "apps/web/components/subagents/AgentsPanel.tsx",
		export: "AgentsPanel",
	},
	variants: [
		{
			name: "Single mode, forest present",
			description:
				"The session's agent forest with its totals footer pinned below, in the single agent view: a row opens that agent's own pane.",
			seed: () => seedAgentsDock("single"),
			render: () => dock(520),
		},
		{
			name: "Single mode, narrow dock, 420px",
			description: "The dock at its narrowest: all four row lines fit without horizontal overflow.",
			seed: () => seedAgentsDock("single"),
			render: () => dock(420),
		},
		{
			name: "Running agent with a job widget",
			description:
				"The running FixtureBuilder agent's task job reports a widget (its job id is the agent id), so its row gains a glance line: the plan's headline figure. Rows of agents with no widget, and every settled row, stay as they were.",
			seed: () => {
				seedAgentsDock("single");
				seedJobWidgets(0, [agentEntry(), { ...benchEntry(), id: "unrelated-job" }]);
			},
			render: () => dock(520),
		},
		{
			name: "Single mode, empty session",
			description: "No agents yet: the panel explains that agents appear when a Task runs.",
			seed: () => {
				seedAgentTree({ empty: true });
			},
			render: () => dock(520),
		},
		{
			name: "Running filter",
			description:
				"Only running and pending agents, plus the ancestors that keep them in context (shown with their own status). Finished, failed, aborted and parked agents are hidden, and the footer keeps the whole forest's totals.",
			seed: () => {
				seedAgentsDock("single");
				setAgentsFilter("running");
			},
			render: () => dock(520),
		},
		{
			name: "Running filter, finished agent open",
			description:
				"In the accordion, an expanded agent that has finished stays in the filtered list, so it does not vanish from under the reader.",
			seed: () => {
				seedAgentsDock("accordion", "FixtureBuilder.ChatMap");
				setAgentsFilter("running");
			},
			render: () => dock(520),
		},
		{
			name: "Running filter, nothing running",
			description: "Every agent is finished or parked: the list says no agents are running.",
			seed: () => {
				seedAgentTree({ display: true, settled: true });
				setAgentsFilter("running");
			},
			render: () => dock(520),
		},
		{
			name: "Accordion, all collapsed",
			description:
				"The accordion view with nothing expanded: it looks like the list, and every row reports aria-selected false.",
			seed: () => seedAgentsDock("accordion"),
			render: () => dock(520),
		},
		{
			name: "Accordion, running agent expanded",
			description:
				"One row expanded under its highlighted header: the transcript fills about 60% of the dock, followed by the status bar and the steer composer. The row scrolled to the top of the list.",
			seed: () => seedAgentsDock("accordion", "FixtureBuilder"),
			render: () => dock(520),
		},
		{
			name: "Accordion, parked agent expanded",
			description:
				"A parked agent: the Parked strip offers Revive in place of the composer, and the row's menu offers Revive too.",
			seed: () => seedAgentsDock("accordion", "DocsSweep"),
			render: () => dock(520),
		},
		{
			name: "Accordion, finished child expanded",
			description:
				"A nested finished agent expanded under its row; its parent stays in the tree above it.",
			seed: () => seedAgentsDock("accordion", "FixtureBuilder.ChatMap"),
			render: () => dock(520),
		},
		{
			name: "Accordion, narrow dock, 420px",
			description: "The expanded body at the narrowest dock width: no horizontal overflow.",
			seed: () => seedAgentsDock("accordion", "FixtureBuilder"),
			render: () => dock(420),
		},
	],
});
