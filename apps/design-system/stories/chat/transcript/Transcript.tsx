import { Transcript } from "../../../../web/components/chat/transcript/Transcript";
import {
	SCREEN_WORKSPACE_ID,
	screenItems,
	screenLiveBlocks,
	screenSessionSeed,
	screenStreamingItems,
	screenWorkingIntent,
} from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

const idleLive = { active: false, blocks: [] };

/** The settled turn repeated, with ids and tool call ids kept unique. */
const longItems = Array.from({ length: 12 }, (_, copy) =>
	screenItems.map((item) => ({
		...item,
		id: item.id + copy * 1000,
		...(item.kind === "tool" ? { toolCallId: `${item.toolCallId}_${copy}` } : {}),
	})),
).flat();

const frame = () => (
	<div class="ds-frame ds-frame-tall app-main">
		<Transcript />
	</div>
);

export default defineStory({
	id: "chat-transcript-transcript",
	title: "Transcript",
	component: { file: "apps/web/components/chat/transcript/Transcript.tsx", export: "Transcript" },
	seed: {
		...screenSessionSeed,
		items: screenItems,
		live: idleLive,
		streaming: false,
		transcriptPhase: "loaded",
	},
	variants: [
		{
			name: "Settled transcript",
			description:
				"A finished turn with reasoning, tool cards, a failed then passing check, and a compaction.",
			render: frame,
		},
		{
			name: "Streaming reply",
			description: "A running type check and an assistant reply still arriving.",
			seed: {
				items: screenStreamingItems,
				live: { active: true, blocks: screenLiveBlocks },
				streaming: true,
				workingIntent: screenWorkingIntent,
			},
			render: frame,
		},
		{
			name: "Loaded: empty session",
			description: "A loaded session with no messages: EmptyTranscript orients the user.",
			seed: { items: [], live: idleLive, modelSynced: true },
			render: frame,
		},
		{
			name: "Loaded: empty, waiting for the model",
			description: "Before the state frame lands only the model label is withheld.",
			seed: { items: [], live: idleLive, modelSynced: false },
			render: frame,
		},
		{
			name: "Loaded: long transcript",
			description:
				"Twelve copies of the settled turn: items far off-screen skip layout and paint (content-visibility).",
			seed: { items: longItems },
			render: frame,
		},
		{
			name: "Waking: skeleton",
			description:
				"An asleep session is being woken for a switch: the old content has faded out and, after 250ms, the skeleton shows with 'Waking <name>…'.",
			seed: { items: [], transcriptPhase: "waking", transcriptTarget: SCREEN_WORKSPACE_ID },
			render: frame,
		},
		{
			name: "Attaching: skeleton",
			description:
				"The session process is attached and its history is loading: 'Loading history…'.",
			seed: { items: [], transcriptPhase: "attaching", transcriptTarget: SCREEN_WORKSPACE_ID },
			render: frame,
		},
		{
			name: "Failed: Retry",
			description:
				"The switch did not land: the reason and a Retry that runs the switch again; focus is on Retry.",
			seed: {
				items: [],
				transcriptPhase: "failed",
				transcriptTarget: SCREEN_WORKSPACE_ID,
				transcriptError: "attach failed: session exited with code 78",
			},
			render: frame,
		},
	],
});
