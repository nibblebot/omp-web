import { PromptHistoryPicker } from "../../../../web/components/chat/composer/PromptHistoryPicker";
import { promptHistoryEntries, promptHistoryLong } from "../../../fixtures/dialogs";
import { defineStory } from "../../../registry";

const HISTORY_KEY = "omp-web:history";

/** Writes the stored prompt ring (oldest first), the same shape PromptHistory reads back. */
const seedHistory = (entries: string[]): void => {
	localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
};

export default defineStory({
	id: "chat-composer-prompt-history-picker",
	title: "PromptHistoryPicker",
	component: {
		file: "apps/web/components/chat/composer/PromptHistoryPicker.tsx",
		export: "PromptHistoryPicker",
	},
	tabs: true,
	variants: [
		{
			name: "Recent prompts",
			seed: () => seedHistory(promptHistoryEntries),
			render: () => <PromptHistoryPicker onClose={() => {}} />,
		},
		{
			name: "Long and multi-line prompts",
			seed: () => seedHistory([...promptHistoryEntries.slice(0, 2), ...promptHistoryLong]),
			render: () => <PromptHistoryPicker onClose={() => {}} />,
		},
		{
			name: "Empty",
			seed: () => localStorage.removeItem(HISTORY_KEY),
			render: () => <PromptHistoryPicker onClose={() => {}} />,
		},
	],
});
