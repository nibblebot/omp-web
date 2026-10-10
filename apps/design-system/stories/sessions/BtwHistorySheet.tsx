import { BtwHistorySheet } from "../../../web/components/sessions/BtwHistorySheet";
import { refreshBtwHistory, selectBtwRecord } from "../../../web/store/btw-history";
import { answerCalls } from "../../daemon";
import { btwHistoryRecords, btwTranscriptFor } from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

const answerHistory = (records: typeof btwHistoryRecords): void =>
	answerCalls({
		btwList: () => ({ records, total: records.length }),
		btwPage: () => ({ turns: btwTranscriptFor("btw_41") }),
	});

export default defineStory({
	id: "sessions-btw-history-sheet",
	title: "BtwHistorySheet",
	component: {
		file: "apps/web/components/sessions/BtwHistorySheet.tsx",
		export: "BtwHistorySheet",
	},
	tabs: true,
	variants: [
		{
			name: "Recent side questions",
			seed: () => answerHistory(btwHistoryRecords),
			render: () => <BtwHistorySheet onClose={() => {}} />,
		},
		{
			name: "Record selected",
			seed: () => {
				answerHistory(btwHistoryRecords);
				refreshBtwHistory();
				selectBtwRecord("btw_41");
			},
			render: () => <BtwHistorySheet onClose={() => {}} />,
		},
		{
			name: "Empty history",
			seed: () => answerHistory([]),
			render: () => <BtwHistorySheet onClose={() => {}} />,
		},
		{
			name: "History unavailable",
			seed: () => {
				answerCalls({
					btwList: () => {
						throw new Error("btw history store is unavailable after the daemon restarted");
					},
				});
			},
			render: () => <BtwHistorySheet onClose={() => {}} />,
		},
	],
});
