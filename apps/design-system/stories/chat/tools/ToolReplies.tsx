import { ToolCard } from "../../../../web/components/chat/tools/ToolCard";
import {
	bashDoneTool,
	bashRepliesDoneTool,
	bashRepliesRunningTool,
	evalRepliesDoneTool,
	evalRepliesRunningTool,
	replyWriteErrorTool,
	replyWriteTool,
	writeToolItem,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "chat-tools-tool-replies",
		title: "ToolReplies",
		component: { file: "apps/web/components/chat/tools/ToolReplies.tsx", export: "ToolReplies" },
		variants: [
			{
				name: "Bash, settled with two replies",
				description:
					"A command that wrote to out://: each reply draws as assistant prose right after the card, Markdown included.",
				render: () => <ToolCard item={bashRepliesDoneTool} />,
			},
			{
				name: "Bash, running with a reply so far",
				description:
					"The reply shows as soon as its frame arrives, while the command keeps running; later replies append below it.",
				render: () => <ToolCard item={bashRepliesRunningTool} />,
			},
			{
				name: "Eval, settled",
				description:
					"A cell whose tool.write to out:// reached the user: the reply follows the eval card.",
				render: () => <ToolCard item={evalRepliesDoneTool} />,
			},
			{
				name: "Eval, running with a reply so far",
				render: () => <ToolCard item={evalRepliesRunningTool} />,
			},
			{
				name: "Without replies, unchanged",
				description: "A call that never wrote to out:// draws only its card.",
				render: () => <ToolCard item={bashDoneTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-reply-write",
		title: "ReplyWrite",
		component: { file: "apps/web/components/chat/tools/ToolReplies.tsx", export: "ReplyWrite" },
		variants: [
			{
				name: "Write to out://",
				description:
					"The content is a message to the user, so it draws as Markdown prose instead of a Write card with line numbers.",
				render: () => <ToolCard item={replyWriteTool} />,
			},
			{
				name: "Refused, with the error",
				description: "Replies are off in this session: the refusal shows under the text.",
				render: () => <ToolCard item={replyWriteErrorTool} />,
			},
			{
				name: "Write to a file, unchanged",
				description: "Any other path still draws the Write card.",
				render: () => <ToolCard item={writeToolItem} />,
			},
		],
	}),
];
