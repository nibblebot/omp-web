import { JobsSheet } from "../../../web/components/jobs/JobsSheet";
import { openJobsSheet, selectJob } from "../../../web/store/jobs";
import { answerCalls } from "../../daemon";
import { JOB_IDS, jobCalls } from "../../fixtures/jobs";
import { defineStory } from "../../registry";

// ModalHost renders this sheet as a core modal when state.modal is "jobs".
export default defineStory({
	id: "jobs-jobs-sheet",
	title: "JobsSheet",
	component: { file: "apps/web/components/jobs/JobsSheet.tsx", export: "JobsSheet" },
	tabs: true,
	variants: [
		{
			name: "Nested tree",
			description:
				"This session's jobs and its subagents' as a tree, busiest branch first. Explorer's task job heads its own jobs and the Reader subagent's; Reviewer is a header because its task job is no longer listed. Only this session's own running jobs offer Cancel (two clicks: Cancel, then Confirm); the sheet polls every 2s.",
			seed: () => answerCalls(jobCalls()),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Subagent job selected",
			description:
				"A job a subagent runs is selected: its detail shows the full command, directory, live pids and output, and the row has no Cancel because the session does not own it.",
			seed: () => {
				answerCalls(jobCalls());
				selectJob(JOB_IDS.nestedTests);
			},
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Opened on a job",
			description:
				"A card elsewhere (the wait card, a backgrounded tool) opens the sheet on one job through openJobsSheet: the detail loads at once and the dev server row is selected once the tree arrives.",
			seed: () => {
				answerCalls(jobCalls());
				openJobsSheet(JOB_IDS.devServer);
			},
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Settled job selected",
			description:
				"A finished command: exit code, the result text, and the artifact holding the full output.",
			seed: () => {
				answerCalls(jobCalls());
				selectJob(JOB_IDS.tests);
			},
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Cancel refused",
			description:
				"The daemon answers the cancel with an error: Cancel then Confirm on the dev server row shows it under the header, and the tree stays as it was.",
			seed: () =>
				answerCalls(jobCalls({ cancelError: "Cancel failed: the job runner is shutting down" })),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "No jobs",
			seed: () => answerCalls(jobCalls({ tree: { rootId: "Main", rows: [] } })),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Unavailable",
			description: "The session runs no async job manager, so the daemon answers null.",
			seed: () => answerCalls(jobCalls({ unavailable: true })),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Loading",
			seed: () => answerCalls(jobCalls({ pending: true })),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
		{
			name: "Load error",
			seed: () =>
				answerCalls(jobCalls({ loadError: "daemon restarted while reading the job tree" })),
			render: (ctx) => <JobsSheet onClose={ctx.close} />,
		},
	],
});
