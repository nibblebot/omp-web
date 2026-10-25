import { TranscriptStream } from "../../../../web/components/chat/transcript/TranscriptStream";
import { state, type ChatItem } from "../../../../web/state";
import { assistantBlocks } from "../../../../web/store/chat";
import { answerCalls } from "../../../daemon";
import { screenItems, screenSessionSeed } from "../../../fixtures/screen";
import { subagentTranscriptItems } from "../../../fixtures/subagents";
import { waitJobDetail, waitRunItems } from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

const idleLive = { active: false, blocks: [], rev: 0 };

/** Built through the store's mapping so the story exercises it: one reasoning block, one narration block. */
const narrationItems: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Rename `fetchUser` to `loadUser` across the app.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: assistantBlocks([
			{
				type: "thinking",
				thinking: "A rename touches every caller. I should list them before editing.",
				thinkingSignature: "sig-reasoning",
			},
			{
				type: "thinking",
				thinking: "Found 4 callers in `apps/web`. Renaming the export first, then each import.",
				thinkingSignature: "sig-narration",
				narration: true,
			},
			{ type: "text", text: "Renamed `fetchUser` to `loadUser` in all 4 callers." },
		]),
	},
];

export default defineStory({
	id: "chat-transcript-transcript-stream",
	title: "TranscriptStream",
	component: {
		file: "apps/web/components/chat/transcript/TranscriptStream.tsx",
		export: "TranscriptStream",
	},
	variants: [
		{
			name: "Agent: running",
			description:
				"`variant` agent over a subagent's items: the first user message (the assignment) folds behind Show all, calls pair with their results, and a call without a result shows as running. No branch-from-here.",
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream
						items={subagentTranscriptItems("FixtureBuilder")}
						variant="agent"
						class="subagent-transcript"
					/>
				</div>
			),
		},
		{
			name: "Agent: short assignment",
			description: "An assignment that fits in a few lines is not folded, so there is no Show all.",
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream
						items={subagentTranscriptItems("FixtureBuilder.ChatMap")}
						variant="agent"
						class="subagent-transcript"
					/>
				</div>
			),
		},
		{
			name: "Session",
			description:
				"`variant` session over the main transcript: branch-from-here on user cards, nothing folded, and the live turn and working shimmer when streaming.",
			seed: { ...screenSessionSeed, items: screenItems, live: idleLive, streaming: false },
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: narration",
			description:
				"An assistant message whose second thinking block carries `narration: true` (Anthropic prose between tool calls). Blocks come from the store's `assistantBlocks`: the reasoning block folds under thinking, the narration reads as reply text, as in the TUI.",
			seed: {
				...screenSessionSeed,
				items: narrationItems,
				live: idleLive,
				streaming: false,
			},
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: folded wait run",
			description:
				"The turn starts a build in the background and then waits four times, with assistant turns that draw nothing between the waits. The four calls fold into one wait card at the first (the build row's arrow jumps to the bash card that started it); the closing message ends the run.",
			seed: () => answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={waitRunItems} variant="session" />
				</div>
			),
		},
	],
});
