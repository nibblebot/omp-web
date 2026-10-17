import { SubagentStatusChip } from "../../../web/components/subagents/SubagentStatusChip";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-status-chip",
	title: "SubagentStatusChip",
	component: {
		file: "apps/web/components/subagents/SubagentStatusChip.tsx",
		export: "SubagentStatusChip",
	},
	variants: [
		{
			name: "Pending",
			description: "Queued in the roster; not started yet.",
			render: () => <SubagentStatusChip status="pending" />,
		},
		{
			name: "Running",
			description: "Working on its task right now.",
			render: () => <SubagentStatusChip status="running" />,
		},
		{
			name: "Done",
			description: "Finished and reported a result.",
			render: () => <SubagentStatusChip status="done" />,
		},
		{
			name: "Failed",
			description: "Stopped with an error.",
			render: () => <SubagentStatusChip status="failed" />,
		},
		{
			name: "Aborted",
			description: "Cancelled by the operator before it finished.",
			render: () => <SubagentStatusChip status="aborted" />,
		},
		{
			name: "Parked",
			description: "Finished and held for follow-up; can be resumed.",
			render: () => <SubagentStatusChip status="parked" />,
		},
	],
});
