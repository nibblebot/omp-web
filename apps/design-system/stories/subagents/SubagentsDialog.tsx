import { SubagentsDialog } from "../../../web/components/subagents/SubagentsDialog";
import {
	SESSION_ID,
	seedSubagents,
	subagentInfos,
	subagentMapOf,
	subagentWorkers,
	workersStateOf,
} from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-subagents-dialog",
	title: "SubagentsDialog",
	component: {
		file: "apps/web/components/subagents/SubagentsDialog.tsx",
		export: "SubagentsDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Populated roster",
			seed: () =>
				seedSubagents(
					{},
					{
						currentSessionId: SESSION_ID,
						workers: workersStateOf(subagentWorkers),
						subagents: subagentMapOf(subagentInfos),
					},
				),
			render: (ctx) => <SubagentsDialog onClose={ctx.close} />,
		},
		{
			name: "Empty roster",
			seed: () =>
				seedSubagents(
					{ workerList: () => [] },
					{ currentSessionId: SESSION_ID, subagents: subagentMapOf([]) },
				),
			render: (ctx) => <SubagentsDialog onClose={ctx.close} />,
		},
		{
			name: "Roster unavailable",
			description: "The daemon fails workerList; the panel reports it instead of listing workers.",
			seed: () =>
				seedSubagents(
					{
						workerList: () => {
							throw new Error("daemon unreachable: workerList timed out");
						},
					},
					{ currentSessionId: SESSION_ID },
				),
			render: (ctx) => <SubagentsDialog onClose={ctx.close} />,
		},
		{
			name: "No attached session",
			seed: () => seedSubagents({ workerList: () => [] }, { currentSessionId: "" }),
			render: (ctx) => <SubagentsDialog onClose={ctx.close} />,
		},
	],
});
