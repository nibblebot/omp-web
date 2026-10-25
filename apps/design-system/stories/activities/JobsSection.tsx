import { JobsSection } from "../../../web/components/activities/JobsSection";
import { openActivities, setActivityFilter } from "../../../web/store/activities";
import { JOB_IDS, seedJobs } from "../../fixtures/jobs";
import { DockFrame, seedActivities } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const section = (width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<div class="activities-list">
				<JobsSection />
			</div>
		</div>
	</DockFrame>
);

/** Expand a job the way a row click does, in the saved mode. */
const open = (id: string) => openActivities({ section: "jobs", item: { section: "jobs", id } });

export default defineStory({
	id: "activities-jobs-section",
	title: "JobsSection",
	component: {
		file: "apps/web/components/activities/JobsSection.tsx",
		export: "JobsSection",
	},
	variants: [
		{
			name: "Accordion, jobs listed",
			description:
				"The session's background jobs under the Jobs header with the All / Running filter, running and settled alike, in poll order. The subagents' task jobs are not listed (those are the Subagents section); a subagent's own command job stays, with its owner named. Only this session's own running jobs offer Cancel (two clicks: Cancel, then Confirm). A row click expands it inline.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
			},
			render: () => section(),
		},
		{
			name: "Accordion, running job expanded",
			description:
				"The dev server's detail under its row: widget, facts, full command, live pids and the output so far, at natural height up to the item cap, scrolling inside when taller.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				open(JOB_IDS.devServer);
			},
			render: () => section(),
		},
		{
			name: "Accordion, two jobs expanded",
			description:
				"Any number of rows stay open at once: a running command and a finished one with its exit code, result tail and artifact id.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				open(JOB_IDS.devServer);
				open(JOB_IDS.tests);
			},
			render: () => section(),
		},
		{
			name: "Accordion, subagent's job expanded",
			description:
				"A job a subagent owns: its detail, and no Cancel anywhere because the session does not own it.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				open(JOB_IDS.nestedTests);
			},
			render: () => section(),
		},
		{
			name: "Accordion, narrow dock, 420px",
			description: "An open row at the narrowest dock width: no horizontal overflow.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				open(JOB_IDS.devServer);
			},
			render: () => section(420),
		},
		{
			name: "Running filter",
			description: "Only the running jobs; the section count keeps the whole list.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				setActivityFilter("jobs", "running");
			},
			render: () => section(),
		},
		{
			name: "Running filter, finished job expanded",
			description:
				"An expanded job that has finished stays in the filtered list, so it does not vanish from under the reader.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
				open(JOB_IDS.tests);
				setActivityFilter("jobs", "running");
			},
			render: () => section(),
		},
		{
			name: "Running filter, nothing running",
			description: "Every job has settled: the section says no jobs are running.",
			seed: () => {
				seedActivities("accordion");
				seedJobs({
					tree: {
						rootId: "Main",
						rows: [
							{
								kind: "job",
								depth: 0,
								rails: [],
								last: true,
								parent: false,
								job: {
									id: "job_done",
									type: "bash",
									status: "completed",
									label: "make build",
									startTime: Date.now() - 120_000,
									endTime: Date.now() - 60_000,
									ownerId: "Main",
									own: true,
								},
							},
						],
					},
				});
				setActivityFilter("jobs", "running");
			},
			render: () => section(),
		},
		{
			name: "Detail mode",
			description:
				"Rows do not expand: a row click opens that job in the panel (see ActivitiesPanel). aria-expanded is absent on the rows.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => section(),
		},
		{
			name: "Cancel refused",
			description:
				"The session process answers the cancel with an error: Cancel then Confirm on the dev server row shows it under the header, and the list stays as it was.",
			seed: () => {
				seedActivities("accordion");
				seedJobs({ cancelError: "Cancel failed: the job runner is shutting down" });
			},
			render: () => section(),
		},
	],
});
