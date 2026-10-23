import { CompactionBar } from "../../../../web/components/chat/composer/CompactionBar";
import { PromptBox } from "../../../../web/components/chat/composer/PromptBox";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-composer-compaction-bar",
	title: "CompactionBar",
	component: {
		file: "apps/web/components/chat/composer/CompactionBar.tsx",
		export: "CompactionBar",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Compacting",
			description:
				"A /compact, Compact…, or /handoff run: the strip sits above the composer until the session clears its compacting flag.",
			seed: { compacting: true },
			render: () => (
				<div class="ds-frame">
					<CompactionBar />
					<PromptBox />
				</div>
			),
		},
		{
			name: "Idle",
			description: "Nothing compacting; the strip stays hidden.",
			seed: { compacting: false },
			render: () => (
				<div class="ds-frame">
					<CompactionBar />
					<PromptBox />
				</div>
			),
		},
	],
});
