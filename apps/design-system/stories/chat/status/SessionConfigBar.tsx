import { SessionConfigBar } from "../../../../web/components/chat/status/SessionConfigBar";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-session-config-bar",
	title: "SessionConfigBar",
	component: {
		file: "apps/web/components/chat/status/SessionConfigBar.tsx",
		export: "SessionConfigBar",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Mid-session",
			description: "Opus with high thinking and a healthy context window.",
			render: () => <SessionConfigBar />,
		},
		{
			name: "Thinking off, fresh context",
			description: "Early in a session with reasoning disabled.",
			seed: {
				thinkingLevel: "off",
				contextUsage: { tokens: 4_200, contextWindow: 200_000, percent: 2.1 },
			},
			render: () => <SessionConfigBar />,
		},
		{
			name: "Auto thinking",
			description: "Auto selector active; the resolved effort shows in the tooltip.",
			seed: { autoThinking: true, thinkingLevel: "high" },
			render: () => <SessionConfigBar />,
		},
		{
			name: "Near context limit",
			description: "92% of the context window is used; compaction is due soon.",
			seed: {
				contextUsage: { tokens: 184_000, contextWindow: 200_000, percent: 92 },
			},
			render: () => <SessionConfigBar />,
		},
	],
});
