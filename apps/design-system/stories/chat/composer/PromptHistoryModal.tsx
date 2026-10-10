import { PromptHistoryModal } from "../../../../web/components/chat/composer/PromptHistoryModal";
import { promptHistoryEntries, promptHistoryLong } from "../../../fixtures/dialogs";
import { defineStory } from "../../../registry";

const HISTORY_KEY = "omp-web:history";

/** Writes the stored prompt ring (oldest first), the same shape PromptHistory reads back. */
const seedHistory = (entries: string[]): void => {
	localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
};

export default defineStory({
	id: "chat-composer-prompt-history-modal",
	title: "PromptHistoryModal",
	component: {
		file: "apps/web/components/chat/composer/PromptHistoryModal.tsx",
		export: "PromptHistoryModal",
	},
	tabs: true,
	variants: [
		{
			name: "Recent prompts",
			seed: () => seedHistory(promptHistoryEntries),
			render: () => <PromptHistoryModal onClose={() => {}} />,
		},
		{
			name: "Long and multi-line prompts",
			seed: () => seedHistory([...promptHistoryEntries.slice(0, 2), ...promptHistoryLong]),
			render: () => <PromptHistoryModal onClose={() => {}} />,
		},
		{
			name: "Empty",
			seed: () => localStorage.removeItem(HISTORY_KEY),
			render: () => <PromptHistoryModal onClose={() => {}} />,
		},
	],
});
