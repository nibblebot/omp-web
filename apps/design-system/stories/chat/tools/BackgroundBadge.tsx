import { BackgroundBadge } from "../../../../web/components/chat/tools/BackgroundBadge";
import {
	bashBackgroundCancelledTool,
	bashBackgroundCompletedTool,
	bashBackgroundFailedTool,
	bashBackgroundRunningTool,
} from "../../../fixtures/background-tools";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-background-badge",
	title: "BackgroundBadge",
	component: {
		file: "apps/web/components/chat/tools/BackgroundBadge.tsx",
		export: "BackgroundBadge",
	},
	variants: [
		{
			name: "Running",
			description: "Counts the job's run time up while it runs.",
			render: () => <BackgroundBadge job={bashBackgroundRunningTool.background!} />,
		},
		{
			name: "Completed",
			description: "Frozen at the run time the job reported.",
			render: () => <BackgroundBadge job={bashBackgroundCompletedTool.background!} />,
		},
		{
			name: "Failed, with exit code",
			render: () => <BackgroundBadge job={bashBackgroundFailedTool.background!} />,
		},
		{
			name: "Cancelled",
			render: () => <BackgroundBadge job={bashBackgroundCancelledTool.background!} />,
		},
	],
});
