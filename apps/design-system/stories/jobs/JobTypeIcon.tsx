import { JobTypeIcon } from "../../../web/components/jobs/JobTypeIcon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "jobs-job-type-icon",
	title: "JobTypeIcon",
	component: { file: "apps/web/components/jobs/JobTypeIcon.tsx", export: "JobTypeIcon" },
	variants: [
		{
			name: "Known kinds",
			description: "A shell command, a subagent and a script each have their own icon.",
			render: () => (
				<div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
					<JobTypeIcon type="bash" />
					<JobTypeIcon type="task" />
					<JobTypeIcon type="eval" />
				</div>
			),
		},
		{
			name: "Unknown kind",
			description: "A kind this build does not know draws the generic job icon.",
			render: () => <JobTypeIcon type="future-kind" />,
		},
	],
});
