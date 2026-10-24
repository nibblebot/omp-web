import { WaitToolCard } from "../../../../web/components/chat/tools/WaitToolCard";
import {
	waitIdleTool,
	waitManyTool,
	waitRunningTool,
	waitSettledTool,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-wait-tool-card",
	title: "WaitToolCard",
	component: { file: "apps/web/components/chat/tools/WaitToolCard.tsx", export: "WaitToolCard" },
	variants: [
		{
			name: "Running, live tiles",
			description:
				"A subagent with its stage and completion ring, a bash job and an eval job; the dots pulse and the clocks tick.",
			render: () => <WaitToolCard item={waitRunningTool} />,
		},
		{
			name: "Settled, mixed outcomes",
			description:
				"Done, failed (with its exit code) and cancelled jobs sort after the running ones; subagents with no job row list below the tiles.",
			render: () => <WaitToolCard item={waitSettledTool} />,
		},
		{
			name: "Many jobs, nine tiles",
			description: "Eleven watched jobs: nine tiles, the rest counted.",
			render: () => <WaitToolCard item={waitManyTool} />,
		},
		{
			name: "Nothing to wait for",
			description: "No job to show: the result text stands in.",
			render: () => <WaitToolCard item={waitIdleTool} />,
		},
	],
});
