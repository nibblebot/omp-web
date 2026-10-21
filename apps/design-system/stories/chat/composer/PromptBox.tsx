import { PromptBox } from "../../../../web/components/chat/composer/PromptBox";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-composer-prompt-box",
	title: "PromptBox",
	component: { file: "apps/web/components/chat/composer/PromptBox.tsx", export: "PromptBox" },
	seed: screenSessionSeed,
	variants: [
		{
			name: "Ready",
			description: "Idle session with the daemon ready for the next prompt.",
			render: () => (
				<div class="ds-frame">
					<PromptBox />
				</div>
			),
		},
		{
			name: "Agent busy",
			description: "A turn is running, so Enter queues the message as a follow-up.",
			seed: { streaming: true, workingIntent: "Running the types check" },
			render: () => (
				<div class="ds-frame">
					<PromptBox />
				</div>
			),
		},
		{
			name: "Starting up",
			description: "Connected, but the daemon has not reported ready yet; sending is gated.",
			seed: { readyAt: undefined },
			render: () => (
				<div class="ds-frame">
					<PromptBox />
				</div>
			),
		},
		{
			name: "Disconnected",
			seed: { connected: false },
			render: () => (
				<div class="ds-frame">
					<PromptBox />
				</div>
			),
		},
		{
			name: "Switching session",
			description:
				"A session switch is loading (or failed): the composer is disabled, the old session may still be attached underneath.",
			seed: { transcriptPhase: "attaching", transcriptTarget: "dmn_a002" },
			render: () => (
				<div class="ds-frame">
					<PromptBox />
				</div>
			),
		},
	],
});
