import { SessionTitle } from "../../../../web/components/chat/status/SessionTitle";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-session-title",
	title: "SessionTitle",
	component: { file: "apps/web/components/chat/status/SessionTitle.tsx", export: "SessionTitle" },
	seed: screenSessionSeed,
	variants: [
		{
			name: "Named session",
			description: "A session with a title and a long transcript.",
			render: () => <SessionTitle />,
		},
		{
			name: "Untitled new session",
			description: "Just started with no name yet: the header renders nothing.",
			seed: { sessionName: "", messageCount: 0 },
			render: () => <SessionTitle />,
		},
		{
			name: "Long session name",
			description: "A long title that must truncate instead of pushing the header apart.",
			seed: {
				sessionName:
					"Refactor the design-system fixtures so every story owns its own data and renders the real components",
			},
			render: () => <SessionTitle />,
		},
	],
});
