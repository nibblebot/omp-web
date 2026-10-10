import { BtwHistoryModal } from "../../../web/components/sessions/BtwHistoryModal";
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
	id: "sessions-btw-history-modal",
	title: "BtwHistoryModal",
	component: {
		file: "apps/web/components/sessions/BtwHistoryModal.tsx",
		export: "BtwHistoryModal",
	},
	tabs: true,
	variants: [
		{
			name: "Recent side questions",
			seed: () => answerHistory(btwHistoryRecords),
			render: () => <BtwHistoryModal onClose={() => {}} />,
		},
		{
			name: "Record selected",
			seed: () => {
				answerHistory(btwHistoryRecords);
				refreshBtwHistory();
				selectBtwRecord("btw_41");
			},
			render: () => <BtwHistoryModal onClose={() => {}} />,
		},
		{
			name: "Empty history",
			seed: () => answerHistory([]),
			render: () => <BtwHistoryModal onClose={() => {}} />,
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
			render: () => <BtwHistoryModal onClose={() => {}} />,
		},
	],
});
