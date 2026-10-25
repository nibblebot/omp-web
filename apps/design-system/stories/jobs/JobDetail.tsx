import type { JobDto } from "#lib/wire/protocol";
import { JobDetail } from "../../../web/components/jobs/JobDetail";
import { JOB_IDS, jobDetails, jobTreeFixture } from "../../fixtures/jobs";
import { defineStory } from "../../registry";

// A fixed clock keeps the running jobs' run time still.
const NOW = Date.parse("2026-10-09T12:00:00Z");
const jobOf = (id: string): JobDto => {
	const found = jobTreeFixture(NOW).rows.find((row) => row.kind === "job" && row.job.id === id);
	if (found?.kind !== "job") throw new Error(`fixture has no job ${id}`);
	return found.job;
};

export default defineStory({
	id: "jobs-job-detail",
	title: "JobDetail",
	component: { file: "apps/web/components/jobs/JobDetail.tsx", export: "JobDetail" },
	variants: [
		{
			name: "Running command",
			description:
				"The job's whole widget (every block of a spec-driven benchmark), then facts, the full command, live pids and the output so far.",
			render: () => (
				<JobDetail
					job={jobOf(JOB_IDS.devServer)}
					detail={jobDetails[JOB_IDS.devServer]}
					now={NOW}
				/>
			),
		},
		{
			name: "Own running job with Cancel",
			description:
				"The detail view of the Activities panel passes onCancel: this session's own running job gets Cancel (two clicks) in the header, right-aligned. A job it does not own, or a settled one, has none.",
			render: () => (
				<JobDetail
					job={jobOf(JOB_IDS.devServer)}
					detail={jobDetails[JOB_IDS.devServer]}
					now={NOW}
					onCancel={() => undefined}
				/>
			),
		},
		{
			name: "Widget still being authored",
			description: "The basic widget shows while the model writes the spec.",
			render: () => (
				<JobDetail
					job={jobOf(JOB_IDS.nestedTests)}
					detail={jobDetails[JOB_IDS.nestedTests]}
					now={NOW}
				/>
			),
		},
		{
			name: "Finished with a cut result",
			description:
				"Exit code, the result tail, a note that the output was cut, and the artifact id.",
			render: () => (
				<JobDetail job={jobOf(JOB_IDS.tests)} detail={jobDetails[JOB_IDS.tests]} now={NOW} />
			),
		},
		{
			name: "Failed command",
			render: () => (
				<JobDetail job={jobOf(JOB_IDS.build)} detail={jobDetails[JOB_IDS.build]} now={NOW} />
			),
		},
		{
			name: "Subagent task job",
			description: "A task job has no command: facts and the subagent's progress text.",
			render: () => (
				<JobDetail job={jobOf(JOB_IDS.explore)} detail={jobDetails[JOB_IDS.explore]} now={NOW} />
			),
		},
		{
			name: "Loading",
			render: () => <JobDetail job={jobOf(JOB_IDS.devServer)} detail={undefined} now={NOW} />,
		},
		{
			name: "No longer listed",
			description: "The session process evicted the job after its retention window.",
			render: () => <JobDetail job={jobOf(JOB_IDS.tests)} detail={null} now={NOW} />,
		},
	],
});
