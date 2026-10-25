import { JobErrors } from "../../../web/components/activities/JobErrors";
import { cancelOwnJob } from "../../../web/store/jobs";
import { JOB_IDS, seedJobs } from "../../fixtures/jobs";
import { seedActivities } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-job-errors",
	title: "JobErrors",
	component: { file: "apps/web/components/activities/JobErrors.tsx", export: "JobErrors" },
	variants: [
		{
			name: "Load error",
			description:
				"The shared job poll failed (the session process restarted mid-call): the alert names why. It clears with the next good answer.",
			seed: () => {
				seedActivities("accordion");
				seedJobs({ loadError: "session process restarted while reading the job tree" });
			},
			render: () => (
				<div class="ds-frame">
					<JobErrors />
				</div>
			),
		},
		{
			name: "Cancel refused",
			description: "The session refused the last Cancel; the alert stays until the next Cancel.",
			seed: () => {
				seedActivities("accordion");
				seedJobs({ cancelError: "Cancel failed: the job runner is shutting down" });
				void cancelOwnJob(JOB_IDS.devServer);
			},
			render: () => (
				<div class="ds-frame">
					<JobErrors />
				</div>
			),
		},
		{
			name: "No errors",
			description: "Nothing renders while both the poll and the last Cancel are fine.",
			seed: () => {
				seedActivities("accordion");
				seedJobs();
			},
			render: () => (
				<div class="ds-frame">
					<JobErrors />
				</div>
			),
		},
	],
});
