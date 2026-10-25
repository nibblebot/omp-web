import { BtwSheet } from "../../../web/components/requests/BtwSheet";
import { setState } from "../../../web/state";
import { selectBtwRecord } from "../../../web/store/btw-history";
import { answerCalls } from "../../session";
import { answerBtwHistory, btwAnswered, btwFailed, btwStreaming } from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

/**
 * The /btw sheet: saved side questions on the left, the live answer, the
 * selected thread, and its actions on the right, and the ask/follow-up box
 * at the bottom. Each variant seeds the live answer (`state.btw`) and the
 * session answers the sheet reads (list, thread page, promote preview).
 */
export default defineStory({
	id: "requests-btw-sheet",
	title: "BtwSheet",
	component: { file: "apps/web/components/requests/BtwSheet.tsx", export: "BtwSheet" },
	tabs: true,
	variants: [
		{
			name: "Live answer streaming",
			description: "A question in flight: the answer streams with a cursor and Stop is offered.",
			seed: () => {
				answerBtwHistory();
				setState("btw", btwStreaming);
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
		{
			name: "Answered, no thread selected",
			description: "A finished answer shown before it is selected in the list; Dismiss clears it.",
			seed: () => {
				answerBtwHistory();
				setState("btw", btwAnswered);
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
		{
			name: "Answer failed",
			description: "The provider rejected the question: the error shows in the live block.",
			seed: () => {
				answerBtwHistory();
				setState("btw", btwFailed);
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
		{
			name: "Saved thread, promotable",
			description:
				"A single complete question selected: Copy and Promote to transcript are enabled.",
			seed: () => {
				answerBtwHistory();
				selectBtwRecord("btw_41");
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
		{
			name: "Saved thread, promote blocked",
			description:
				"A multi-turn thread selected: Promote stays disabled and the reason is shown under the actions.",
			seed: () => {
				answerBtwHistory();
				selectBtwRecord("btw_42");
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
		{
			name: "No saved questions",
			description: "Empty history: the sheet shows the Ask hint and the composer.",
			seed: () => {
				answerCalls({
					btwList: () => ({ records: [], total: 0 }),
				});
				setState("btw", null);
			},
			render: () => <BtwSheet onClose={() => setState("modal", null)} />,
		},
	],
});
