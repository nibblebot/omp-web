import { DiffToolCard } from "../../../../web/components/chat/tools/DiffToolCard";
import {
	applyPatchToolItem,
	editToolItem,
	hashlineEditToolItem,
	longWriteToolItem,
	malformedEditToolItem,
	multiEditToolItem,
	runningEditToolItem,
	streamingEditToolItem,
	writeToolItem,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-diff-tool-card",
	title: "DiffToolCard",
	component: { file: "apps/web/components/chat/tools/DiffToolCard.tsx", export: "DiffToolCard" },
	variants: [
		{ name: "Edit, collapsed (+n -m summary)", render: () => <DiffToolCard item={editToolItem} /> },
		{
			name: "Edit, expanded (Ctrl+O)",
			seed: { toolsExpanded: true },
			render: () => <DiffToolCard item={editToolItem} />,
		},
		{
			name: "Edit, running with diff",
			render: () => <DiffToolCard item={runningEditToolItem} />,
		},
		{
			name: "Edit, streaming (args incomplete)",
			render: () => <DiffToolCard item={streamingEditToolItem} />,
		},
		{
			name: "Hashline edit (diff from details)",
			render: () => <DiffToolCard item={hashlineEditToolItem} />,
		},
		{
			name: "apply_patch (diff from details)",
			render: () => <DiffToolCard item={applyPatchToolItem} />,
		},
		{
			name: "Error: malformed args (output text, no diff)",
			render: () => <DiffToolCard item={malformedEditToolItem} />,
		},
		{ name: "Two hunks in one call", render: () => <DiffToolCard item={multiEditToolItem} /> },
		{ name: "Write, new file", render: () => <DiffToolCard item={writeToolItem} /> },
		{ name: "Write, 60 lines", render: () => <DiffToolCard item={longWriteToolItem} /> },
	],
});
