import type { JobTreeRowDto } from "#lib/wire/protocol";
import { JobRow } from "../../../web/components/jobs/JobRow";
import { JOB_IDS, jobTreeFixture } from "../../fixtures/jobs";
import { defineStory } from "../../registry";

// A fixed clock keeps the running jobs' run time still.
const NOW = Date.parse("2026-10-09T12:00:00Z");
const rows = jobTreeFixture(NOW).rows;
const rowOf = (id: string): JobTreeRowDto => {
	const found = rows.find((row) => row.kind === "job" && row.job.id === id);
	if (found === undefined) throw new Error(`fixture has no job ${id}`);
	return found;
};
const agentHeader = rows.find((row) => row.kind === "agent") as JobTreeRowDto;

export default defineStory({
	id: "jobs-job-row",
	title: "JobRow",
	component: { file: "apps/web/components/jobs/JobRow.tsx", export: "JobRow" },
	variants: [
		{
			name: "Own running job",
			description:
				"A top-level job this session owns: status, label, run time, and Cancel (two clicks).",
			render: () => <JobRow row={rowOf(JOB_IDS.devServer)} now={NOW} onCancel={() => undefined} />,
		},
		{
			name: "Settled jobs",
			description: "Done, failed, and cancelled jobs show their frozen run time and no Cancel.",
			render: () => (
				<>
					<JobRow row={rowOf(JOB_IDS.tests)} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.build)} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.tail)} now={NOW} />
				</>
			),
		},
		{
			name: "Task job heading a subagent",
			description: "A task job names the subagent it runs; its nested jobs hang off its rails.",
			render: () => (
				<>
					<JobRow row={rowOf(JOB_IDS.explore)} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.reader)} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.readerSearch)} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.nestedTests)} now={NOW} />
				</>
			),
		},
		{
			name: "Subagent's job",
			description:
				"The owner is named and there is no Cancel: only this session's own jobs can be stopped.",
			render: () => <JobRow row={rowOf(JOB_IDS.nestedTests)} now={NOW} />,
		},
		{
			name: "Subagent header",
			description: "A subagent whose task job is no longer listed gets a header over its jobs.",
			render: () => (
				<>
					<JobRow row={agentHeader} now={NOW} />
					<JobRow row={rowOf(JOB_IDS.reviewDiff)} now={NOW} />
				</>
			),
		},
		{
			name: "Selected",
			render: () => <JobRow row={rowOf(JOB_IDS.devServer)} now={NOW} selected />,
		},
		{
			name: "Cancelling",
			description: "The cancel request is in flight, so Cancel is disabled.",
			render: () => <JobRow row={rowOf(JOB_IDS.devServer)} now={NOW} cancelling />,
		},
		{
			name: "Widget glance slot",
			description:
				"The slot under the label that a job widget glance will fill; the sheet leaves it empty today.",
			render: () => (
				<JobRow
					row={rowOf(JOB_IDS.devServer)}
					now={NOW}
					glance={<span class="tool-collapsed-note">widget glance goes here</span>}
				/>
			),
		},
	],
});
