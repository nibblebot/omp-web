import { ActivitiesModeToggle } from "../../../web/components/activities/ActivitiesModeToggle";
import { ActivitiesPanel } from "../../../web/components/activities/ActivitiesPanel";
import {
	openActivities,
	openItemDetail,
	setActivityFilter,
	toggleItemExpanded,
	toggleSectionCollapsed,
} from "../../../web/store/activities";
import { agentEntry, benchEntry, seedJobWidgets } from "../../fixtures/job-widget-entries";
import { JOB_IDS, seedJobs } from "../../fixtures/jobs";
import { DockFrame, seedActivities, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

/** The panel in a flush dock frame, with the view toggle DockHost puts beside the close button. */
const dock = (width: number) => (
	<DockFrame title="Activities" width={width} flush actions={<ActivitiesModeToggle />}>
		<ActivitiesPanel />
	</DockFrame>
);

export default defineStory({
	id: "activities-activities-panel",
	title: "ActivitiesPanel",
	component: {
		file: "apps/web/components/activities/ActivitiesPanel.tsx",
		export: "ActivitiesPanel",
	},
	variants: [
		{
			name: "Accordion, all collapsed",
			description:
				"The accordion view with nothing expanded: the Subagents section lists the session's agent forest, with its totals below. Only sections with items render; every row reports aria-selected false.",
			seed: () => seedActivities("accordion"),
			render: () => dock(520),
		},
		{
			name: "Accordion, running agent expanded",
			description:
				"One row expanded under its highlighted header: the transcript fills about 60% of the panel, followed by the status bar and the steer composer. The row scrolled to the top of the list.",
			seed: () => seedActivities("accordion", "FixtureBuilder"),
			render: () => dock(520),
		},
		{
			name: "Accordion, two agents expanded",
			description:
				"Any number of rows stay expanded at once; each body keeps its own cap and scrolls inside.",
			seed: () => {
				seedActivities("accordion", "FixtureBuilder");
				toggleItemExpanded({ section: "subagents", id: "DocsSweep" });
			},
			render: () => dock(520),
		},
		{
			name: "Accordion, parked agent expanded",
			description:
				"A parked agent: the Parked strip offers Revive in place of the composer, and the body's menu offers Revive too.",
			seed: () => seedActivities("accordion", "DocsSweep"),
			render: () => dock(520),
		},
		{
			name: "Accordion, finished child expanded",
			description:
				"A nested finished agent expanded under its row; its parent stays in the tree above it.",
			seed: () => seedActivities("accordion", "FixtureBuilder.ChatMap"),
			render: () => dock(520),
		},
		{
			name: "Accordion, narrow dock, 420px",
			description: "The expanded body at the narrowest dock width: no horizontal overflow.",
			seed: () => seedActivities("accordion", "FixtureBuilder"),
			render: () => dock(420),
		},
		{
			name: "Running filter",
			description:
				"Only running and pending agents, plus the ancestors that keep them in context (shown with their own status). The section count and the totals keep the whole forest.",
			seed: () => {
				seedActivities("accordion");
				setActivityFilter("subagents", "running");
			},
			render: () => dock(520),
		},
		{
			name: "Running filter, finished agent expanded",
			description:
				"An expanded agent that has finished stays in the filtered list, so it does not vanish from under the reader.",
			seed: () => {
				seedActivities("accordion", "FixtureBuilder.ChatMap");
				setActivityFilter("subagents", "running");
			},
			render: () => dock(520),
		},
		{
			name: "Running filter, nothing running",
			description: "Every agent is finished or parked: the section says no subagents are running.",
			seed: () => {
				seedActivities("accordion");
				seedAgentTree({ display: true, settled: true });
				setActivityFilter("subagents", "running");
			},
			render: () => dock(520),
		},
		{
			name: "Section collapsed",
			description:
				"The Subagents header folds its body away; the chevron points right and the count stays.",
			seed: () => {
				seedActivities("accordion");
				toggleSectionCollapsed("subagents");
			},
			render: () => dock(520),
		},
		{
			name: "Running agent with a job widget",
			description:
				"The running FixtureBuilder agent's task job reports a widget (its job id is the agent id), so its row gains a glance line. Rows of agents with no widget, and every settled row, stay as they were.",
			seed: () => {
				seedActivities("accordion");
				seedJobWidgets(0, [agentEntry(), { ...benchEntry(), id: "unrelated-job" }]);
			},
			render: () => dock(520),
		},
		{
			name: "Detail mode, list",
			description:
				"The detail view with nothing open: the same list, but a row opens that agent in the panel instead of expanding.",
			seed: () => seedActivities("detail"),
			render: () => dock(520),
		},
		{
			name: "Detail mode, agent open",
			description:
				"One agent fills the panel body: name, type, status, actions menu and title over its conversation, under a Back strip. Back returns to the list at the scroll position it left.",
			seed: () => seedActivities("detail", "FixtureBuilder"),
			render: () => dock(520),
		},
		{
			name: "Detail mode, narrow dock, 420px",
			description: "The detail at the narrowest dock width: the Back strip and header wrap.",
			seed: () => {
				seedActivities("detail");
				openItemDetail({ section: "subagents", id: "DocsSweep" });
			},
			render: () => dock(420),
		},
		{
			name: "Accordion, subagents and jobs",
			description:
				"Subagents above Jobs, each with its own header, count and filter, in the one scroller. The Jobs section appears once the shared job poll answers with jobs that are not subagents' task jobs.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
			},
			render: () => dock(520),
		},
		{
			name: "Accordion, job expanded",
			description:
				"A job opened from elsewhere (a wait card's Open in Activities) scrolls to the top of the list with its detail under the row.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				openActivities({ section: "jobs", item: { section: "jobs", id: JOB_IDS.devServer } });
			},
			render: () => dock(520),
		},
		{
			name: "Detail mode, job open",
			description:
				"One job fills the panel body under a Back strip: widget, facts, command and output, with Cancel on this session's own running job. Back returns to the list at the scroll position it left.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
				openItemDetail({ section: "jobs", id: JOB_IDS.devServer });
			},
			render: () => dock(520),
		},
		{
			name: "Jobs filtered to running",
			description: "The Jobs filter is independent of the Subagents one.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				setActivityFilter("jobs", "running");
			},
			render: () => dock(520),
		},
		{
			name: "Empty session",
			description:
				"No agents, jobs, daemons or todos: no section renders, and the panel explains that they appear when the session has them.",
			seed: () => {
				seedActivities("accordion");
				seedAgentTree({ empty: true });
			},
			render: () => dock(520),
		},
	],
});
