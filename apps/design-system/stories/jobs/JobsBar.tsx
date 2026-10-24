import { JobsBar } from "../../../web/components/jobs/JobsBar";
import { authoringEntry, agentEntry, benchEntry, seedJobWidgets } from "../../fixtures/job-bars";
import { defineStory } from "../../registry";

// The Jobs feature is in development, so the app cannot mount this bar; the stories render it directly.
// Clicking it sets state.modal to "jobs", which ModalHost renders through the feature registry.
const NEWER = benchEntry().view.updatedAt + 5_000;

export default defineStory({
	id: "jobs-jobs-bar",
	title: "JobsBar",
	component: { file: "apps/web/components/jobs/JobsBar.tsx", export: "JobsBar" },
	variants: [
		{
			name: "Latest widget",
			description:
				"Three background jobs run. The bar names how many and glances the live widget that saw data last: the benchmark's mini chart, headline and trend. The subagent's widget is older, so it stays out of the bar.",
			seed: () => seedJobWidgets(3, [agentEntry(), benchEntry(NEWER), authoringEntry()]),
			render: () => <JobsBar />,
		},
		{
			name: "One job",
			description: "The count is singular for one job.",
			seed: () => seedJobWidgets(1, [benchEntry()]),
			render: () => <JobsBar />,
		},
		{
			name: "Count only, widget being written",
			description:
				"A widget the model is still writing is not live yet, so the bar shows only the count. It reads the same with `async.widgets` off, or for a job that has no widget.",
			seed: () => seedJobWidgets(2, [authoringEntry()]),
			render: () => <JobsBar />,
		},
		{
			name: "Narrow, 420px",
			description:
				"The bar stays inside its column; a longer figure truncates before it overflows.",
			seed: () => seedJobWidgets(3, [benchEntry()]),
			render: () => (
				<div style={{ width: "420px", border: "1px dashed var(--border)" }}>
					<JobsBar />
				</div>
			),
		},
	],
});
