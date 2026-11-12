import { AgentMessageCard } from "../../../../../web/components/chat/transcript/cards/AgentMessageCard";
import { chatAgentMessageItem, chatAgentMessageReplyItem } from "../../../../fixtures/chat";
import { defineStory } from "../../../../registry";

export default defineStory({
	id: "chat-transcript-cards-agent-message-card",
	title: "AgentMessageCard",
	component: {
		file: "apps/web/components/chat/transcript/cards/AgentMessageCard.tsx",
		export: "AgentMessageCard",
	},
	variants: [
		{
			name: "Subagent finding",
			description:
				"A message a subagent sent the main agent mid-run, labeled with the sender. It shows as it is delivered and after reload.",
			render: () => (
				<div class="ds-frame">
					<AgentMessageCard item={chatAgentMessageItem} />
				</div>
			),
		},
		{
			name: "Multi-line reply",
			description: "A peer's answer keeps its line breaks.",
			render: () => (
				<div class="ds-frame">
					<AgentMessageCard item={chatAgentMessageReplyItem} />
				</div>
			),
		},
	],
});
