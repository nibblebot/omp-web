import { ActivityJobDetail } from "../../../web/components/activities/ActivityJobDetail";
import { JOB_IDS, seedJobs } from "../../fixtures/jobs";
import { DockFrame, seedActivities } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

/** The detail view that fills the panel body under the Back strip. */
const page = (id: string, width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<div class="activity-detail">
				<div class="activity-detail-body">
					<ActivityJobDetail id={id} standalone />
				</div>
			</div>
		</div>
	</DockFrame>
);

export default defineStory({
	id: "activities-activity-job-detail",
	title: "ActivityJobDetail",
	component: {
		file: "apps/web/components/activities/ActivityJobDetail.tsx",
		export: "ActivityJobDetail",
	},
	variants: [
		{
			name: "Detail mode, running own job",
			description:
				"The job fills the panel body: widget, facts, the full command, live pids and the output so far, refreshed with the shared poll. This session's own running job carries Cancel (two clicks) in the header.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => page(JOB_IDS.devServer),
		},
		{
			name: "Detail mode, settled job",
			description:
				"A finished command: exit code, the result text, a note that the output was cut, and the artifact holding the full output. No Cancel.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => page(JOB_IDS.tests),
		},
		{
			name: "Detail mode, subagent's job",
			description:
				"A job a subagent owns: no Cancel, because only this session's own jobs can be cancelled.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => page(JOB_IDS.nestedTests),
		},
		{
			name: "Detail mode, narrow dock, 420px",
			description:
				"The detail at the narrowest dock width: facts truncate, the command and output wrap.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => page(JOB_IDS.devServer, 420),
		},
		{
			name: "Detail mode, cancel refused",
			description:
				"Cancel then Confirm: the session process refuses, and the error shows above the detail.",
			seed: () => {
				seedActivities("detail");
				seedJobs({ cancelError: "Cancel failed: the job runner is shutting down" });
			},
			render: () => page(JOB_IDS.devServer),
		},
		{
			name: "Job no longer listed",
			description:
				"The job left the session's list (evicted after its retention window) while it was open.",
			seed: () => {
				seedActivities("detail");
				seedJobs();
			},
			render: () => page("job_evicted"),
		},
		{
			name: "Inline body",
			description:
				"Without standalone (an accordion body): no Cancel and no error strip, because the row above carries Cancel and the section the errors.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
			},
			render: () => (
				<DockFrame title="Activities" width={520} flush>
					<div class="activities-panel">
						<div class="activities-list">
							<div class="activity-item-body">
								<ActivityJobDetail id={JOB_IDS.devServer} />
							</div>
						</div>
					</div>
				</DockFrame>
			),
		},
	],
});
