import { DiffToolCard } from "../../../../web/components/chat/tools/DiffToolCard";
import {
	editToolItem,
	longWriteToolItem,
	malformedEditToolItem,
	multiEditToolItem,
	runningEditToolItem,
	writeToolItem,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-diff-tool-card",
	title: "DiffToolCard",
	component: { file: "apps/web/components/chat/tools/DiffToolCard.tsx", export: "DiffToolCard" },
	variants: [
		{ name: "Edit (inline diff)", render: () => <DiffToolCard item={editToolItem} /> },
		{ name: "Write (new file)", render: () => <DiffToolCard item={writeToolItem} /> },
		{ name: "Running", render: () => <DiffToolCard item={runningEditToolItem} /> },
		{
			name: "Malformed args (generic fallback)",
			render: () => <DiffToolCard item={malformedEditToolItem} />,
		},
		{ name: "Two hunks in one call", render: () => <DiffToolCard item={multiEditToolItem} /> },
		{ name: "Write, 60 lines", render: () => <DiffToolCard item={longWriteToolItem} /> },
	],
});
