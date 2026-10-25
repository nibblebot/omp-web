import { ToolCardsMenu } from "../../../../web/components/chat/transcript/ToolCardsMenu";
import { liveCollabStatus } from "../../../fixtures/collab";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-transcript-tool-cards-menu",
	title: "ToolCardsMenu",
	component: {
		file: "apps/web/components/chat/transcript/ToolCardsMenu.tsx",
		export: "ToolCardsMenu",
	},
	variants: [
		{
			name: "Tool cards collapsed",
			description: "Header kebab: the global expand-all toggle for tool cards (Ctrl+O) and Share.",
			seed: { toolsExpanded: false },
			render: () => <ToolCardsMenu />,
		},
		{
			name: "Tool cards expanded",
			seed: { toolsExpanded: true },
			render: () => <ToolCardsMenu />,
		},
		{
			name: "Shared live",
			description: "While the session is shared, the Share item shows the guest count.",
			seed: { collabStatus: liveCollabStatus },
			render: () => <ToolCardsMenu />,
		},
	],
});
