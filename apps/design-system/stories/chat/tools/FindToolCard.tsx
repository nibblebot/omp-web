import { FindToolCard } from "../../../../web/components/chat/tools/FindToolCard";
import {
	findDoneTool,
	findNoHitsTool,
	findRunningTool,
	findScopedTool,
	findTimedOutTool,
	findUnknownShapeTool,
} from "../../../fixtures/find-tool";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-find-tool-card",
	title: "FindToolCard",
	component: { file: "apps/web/components/chat/tools/FindToolCard.tsx", export: "FindToolCard" },
	variants: [
		{
			name: "Hits",
			description:
				"Ranked strongest first: score gauge, copyable path, the strongest verified ranges with their snippets.",
			render: () => <FindToolCard item={findDoneTool} />,
		},
		{
			name: "Scoped to a path",
			render: () => <FindToolCard item={findScopedTool} />,
		},
		{
			name: "Timed out, partial hits",
			description:
				"The 20 s budget ran out: `details.timeout` marks the header and the body with how many passages were verified.",
			render: () => <FindToolCard item={findTimedOutTool} />,
		},
		{ name: "No hits", render: () => <FindToolCard item={findNoHitsTool} /> },
		{ name: "Running", render: () => <FindToolCard item={findRunningTool} /> },
		{
			name: "Unknown details shape",
			description: "Details that are not a find result: the raw output text shows instead.",
			render: () => <FindToolCard item={findUnknownShapeTool} />,
		},
	],
});
