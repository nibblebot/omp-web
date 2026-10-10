import { SubagentHub } from "../../../web/components/subagents/SubagentHub";
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
	id: "subagents-subagent-hub",
	title: "SubagentHub",
	component: { file: "apps/web/components/subagents/SubagentHub.tsx", export: "SubagentHub" },
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
			render: () => <SubagentHub onClose={() => undefined} />,
		},
		{
			name: "Empty roster",
			seed: () =>
				seedSubagents(
					{ workerList: () => [] },
					{ currentSessionId: SESSION_ID, subagents: subagentMapOf([]) },
				),
			render: () => <SubagentHub onClose={() => undefined} />,
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
			render: () => <SubagentHub onClose={() => undefined} />,
		},
		{
			name: "No attached session",
			seed: () => seedSubagents({ workerList: () => [] }, { currentSessionId: "" }),
			render: () => <SubagentHub onClose={() => undefined} />,
		},
	],
});
