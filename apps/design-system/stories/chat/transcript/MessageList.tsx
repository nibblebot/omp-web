import { MessageList } from "../../../../web/components/chat/transcript/MessageList";
import {
	screenItems,
	screenLiveBlocks,
	screenSessionSeed,
	screenStreamingItems,
	screenWorkingIntent,
} from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

const idleLive = { active: false, blocks: [], rev: 0 };

export default defineStory({
	id: "chat-transcript-message-list",
	title: "MessageList",
	component: { file: "apps/web/components/chat/transcript/MessageList.tsx", export: "MessageList" },
	seed: { ...screenSessionSeed, items: screenItems, live: idleLive, streaming: false },
	variants: [
		{
			name: "Settled transcript",
			description:
				"A finished turn with reasoning, tool cards, a failed then passing check, and a compaction.",
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<MessageList />
				</div>
			),
		},
		{
			name: "Streaming reply",
			description: "A running type check and an assistant reply still arriving.",
			seed: {
				items: screenStreamingItems,
				live: { active: true, blocks: screenLiveBlocks, rev: 1 },
				streaming: true,
				workingIntent: screenWorkingIntent,
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<MessageList />
				</div>
			),
		},
		{
			name: "Tool cards collapsed",
			seed: { toolCardsView: "collapsed" },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<MessageList />
				</div>
			),
		},
		{
			name: "Tool cards consolidated",
			seed: { toolCardsView: "consolidated" },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<MessageList />
				</div>
			),
		},
	],
});
