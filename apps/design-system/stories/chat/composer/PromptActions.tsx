import { PromptActions } from "../../../../web/components/chat/composer/PromptActions";
import { screenImage, screenSessionSeed, screenSubagentMap } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

const draft = "Add a regression test for the copy button on unclosed code fences";

export default defineStory({
	id: "chat-composer-prompt-actions",
	title: "PromptActions",
	component: {
		file: "apps/web/components/chat/composer/PromptActions.tsx",
		export: "PromptActions",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Ready with draft",
			description: "Send is enabled; the daemon is ready and the composer has text.",
			render: () => (
				<PromptActions
					message={() => draft}
					images={() => []}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
		{
			name: "Empty composer",
			description: "Send stays disabled until there is something to send.",
			render: () => (
				<PromptActions
					message={() => ""}
					images={() => []}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
		{
			name: "Agent busy",
			description: "While streaming, the composer queues a follow-up instead of sending now.",
			seed: { streaming: true },
			render: () => (
				<PromptActions
					message={() => "Also cover the empty-language fence case"}
					images={() => []}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
		{
			name: "Stop with subagents running",
			description: "A turn with active subagents offers Stop, keep subagents beside Stop.",
			seed: { streaming: true, subagents: screenSubagentMap },
			render: () => (
				<PromptActions
					message={() => "Also cover the empty-language fence case"}
					images={() => []}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
		{
			name: "With image attachment",
			description: "A pasted screenshot rides along with the text.",
			render: () => (
				<PromptActions
					message={() => "Compare this copy button against the mock"}
					images={() => [screenImage]}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
		{
			name: "Disconnected",
			description: "No live connection to the daemon, so sending is blocked.",
			seed: { connected: false },
			render: () => (
				<PromptActions
					message={() => draft}
					images={() => []}
					submit={() => {}}
					onDiscard={() => {}}
				/>
			),
		},
	],
});
