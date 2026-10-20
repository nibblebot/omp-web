import { TranscriptStream } from "../../../../web/components/chat/transcript/TranscriptStream";
import { state } from "../../../../web/state";
import { screenItems, screenSessionSeed } from "../../../fixtures/screen";
import { subagentTranscriptItems } from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

const idleLive = { active: false, blocks: [], rev: 0 };

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
	],
});
