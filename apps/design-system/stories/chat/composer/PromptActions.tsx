import { PromptActions } from "../../../../web/components/chat/composer/PromptActions";
import { setState } from "../../../../web/state";
import { screenImage, screenSessionSeed } from "../../../fixtures/screen";
import { seedAgentTree } from "../../../fixtures/subagents";
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
			description: "Send is enabled; the session process is ready and the composer has text.",
			render: () => (
				<PromptActions message={() => draft} images={() => []} files={() => []} submit={() => {}} />
			),
		},
		{
			name: "Empty composer",
			description: "Send stays disabled until there is something to send.",
			render: () => (
				<PromptActions message={() => ""} images={() => []} files={() => []} submit={() => {}} />
			),
		},
		{
			name: "Agent busy",
			description:
				"While streaming, Stop and Steer sit beside the composer; Steer queues a follow-up.",
			seed: { streaming: true },
			render: () => (
				<PromptActions
					message={() => "Also cover the empty-language fence case"}
					images={() => []}
					files={() => []}
					submit={() => {}}
				/>
			),
		},
		{
			name: "Streaming with subagents",
			description: "Running subagents add the bot counter ahead of Stop and Steer.",
			seed: () => {
				seedAgentTree();
				setState("streaming", true);
			},
			render: () => (
				<PromptActions
					message={() => "Also cover the empty-language fence case"}
					images={() => []}
					files={() => []}
					submit={() => {}}
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
					files={() => []}
					submit={() => {}}
				/>
			),
		},
		{
			name: "Disconnected",
			description: "No live connection to the session process, so sending is blocked.",
			seed: { connected: false },
			render: () => (
				<PromptActions message={() => draft} images={() => []} files={() => []} submit={() => {}} />
			),
		},
	],
});
