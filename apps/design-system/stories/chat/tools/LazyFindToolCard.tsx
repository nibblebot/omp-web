import { LazyFindToolCard } from "../../../../web/components/chat/tools/LazyFindToolCard";
import { findDoneTool, findRunningTool, findUnknownShapeTool } from "../../../fixtures/find-tool";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-lazy-find-tool-card",
	title: "LazyFindToolCard",
	component: {
		file: "apps/web/components/chat/tools/LazyFindToolCard.tsx",
		export: "LazyFindToolCard",
	},
	variants: [
		{
			name: "Hits",
			description:
				"find's renderer in the transcript: a generic card until the find card's chunk arrives, then the real card.",
			render: () => <LazyFindToolCard item={findDoneTool} />,
		},
		{
			name: "Running",
			render: () => <LazyFindToolCard item={findRunningTool} />,
		},
		{
			name: "Unknown details shape",
			render: () => <LazyFindToolCard item={findUnknownShapeTool} />,
		},
	],
});
