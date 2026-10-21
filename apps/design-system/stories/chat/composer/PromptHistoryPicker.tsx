import { PromptHistoryPicker } from "../../../../web/components/chat/composer/PromptHistoryPicker";
import { promptHistoryEntries, promptHistoryLong } from "../../../fixtures/dialogs";
import { defineStory, type VariantContext } from "../../../registry";

const HISTORY_KEY = "omp-web:history";

/** Writes the stored prompt ring (oldest first), the same shape PromptHistory reads back. */
const seedHistory = (entries: string[]): void => {
	localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
};

/**
 * The popover is absolutely positioned on its `.prompt-input` anchor, the
 * element the composer uses, and grows up from the anchor's top-left corner.
 * The spacer leaves room above the anchor so it stays inside the frame.
 */
const anchored = (ctx: VariantContext) => (
	<div class="ds-frame">
		<div class="prompt-input" style={{ "margin-top": "380px" }}>
			<PromptHistoryPicker onClose={ctx.close} />
			<textarea rows={3} aria-label="Message the agent" placeholder="Message the Agent" />
		</div>
	</div>
);

export default defineStory({
	id: "chat-composer-prompt-history-picker",
	title: "PromptHistoryPicker",
	component: {
		file: "apps/web/components/chat/composer/PromptHistoryPicker.tsx",
		export: "PromptHistoryPicker",
	},
	variants: [
		{
			name: "Recent prompts",
			description: "Up on the composer's top row: newest prompt at the bottom, selected.",
			seed: () => seedHistory(promptHistoryEntries),
			render: anchored,
		},
		{
			name: "Long and multi-line prompts",
			seed: () => seedHistory([...promptHistoryEntries.slice(0, 2), ...promptHistoryLong]),
			render: anchored,
		},
		{
			name: "Empty",
			seed: () => localStorage.removeItem(HISTORY_KEY),
			render: anchored,
		},
	],
});
