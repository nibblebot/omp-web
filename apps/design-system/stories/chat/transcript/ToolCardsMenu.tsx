import { ToolCardsMenu } from "../../../../web/components/chat/transcript/ToolCardsMenu";
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
			description: "Header kebab: the global expand-all toggle for tool cards (Ctrl+O).",
			seed: { toolsExpanded: false },
			render: () => <ToolCardsMenu />,
		},
		{
			name: "Tool cards expanded",
			seed: { toolsExpanded: true },
			render: () => <ToolCardsMenu />,
		},
	],
});
