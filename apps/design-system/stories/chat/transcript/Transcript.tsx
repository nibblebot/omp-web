import { Transcript } from "../../../../web/components/chat/transcript/Transcript";
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
	id: "chat-transcript-transcript",
	title: "Transcript",
	component: { file: "apps/web/components/chat/transcript/Transcript.tsx", export: "Transcript" },
	seed: { ...screenSessionSeed, items: screenItems, live: idleLive, streaming: false },
	variants: [
		{
			name: "Settled transcript",
			description:
				"A finished turn with reasoning, tool cards, a failed then passing check, and a compaction.",
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<Transcript />
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
					<Transcript />
				</div>
			),
		},
		{
			name: "Tool cards collapsed",
			seed: { toolCardsView: "collapsed" },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<Transcript />
				</div>
			),
		},
		{
			name: "Tool cards consolidated",
			seed: { toolCardsView: "consolidated" },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<Transcript />
				</div>
			),
		},
		{
			name: "Empty: model synced",
			description: "A fresh session: the model's character greets the user.",
			seed: { items: [], live: idleLive, modelSynced: true },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<Transcript />
				</div>
			),
		},
		{
			name: "Empty: waiting for the model",
			description:
				"Before the state frame lands the pane stays blank, so no wrong character flashes.",
			seed: { items: [], live: idleLive, modelSynced: false },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<Transcript />
				</div>
			),
		},
	],
});
