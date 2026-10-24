import { JobsButton } from "../../../web/components/jobs/JobsButton";
import { defineStory } from "../../registry";

export default defineStory({
	id: "jobs-jobs-button",
	title: "JobsButton",
	component: { file: "apps/web/components/jobs/JobsButton.tsx", export: "JobsButton" },
	variants: [
		{
			name: "Default",
			description:
				"The Jobs feature's control in its Settings > Features row; it sets state.modal to jobs, which ModalHost renders through the feature registry.",
			render: () => <JobsButton />,
		},
	],
});
