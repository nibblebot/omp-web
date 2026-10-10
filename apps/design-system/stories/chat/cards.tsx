import { createSignal, Show } from "solid-js";
import { AdvisorCard } from "../../../web/components/chat/transcript/cards/AdvisorCard";
import { AssistantCard } from "../../../web/components/chat/transcript/cards/AssistantCard";
import { CompactionCard } from "../../../web/components/chat/transcript/cards/CompactionCard";
import { NoticeCard } from "../../../web/components/chat/transcript/cards/NoticeCard";
import { ToolRunRow } from "../../../web/components/chat/transcript/cards/ToolRunRow";
import { UserCard } from "../../../web/components/chat/transcript/cards/UserCard";
import { UserCommandCard } from "../../../web/components/chat/transcript/cards/UserCommandCard";
import { ToolCard, ToolChip } from "../../../web/components/chat/tools/ToolCard";
import { StreamingBlock } from "../../../web/components/chat/transcript/StreamingBlock";
import { StatusSegment } from "../../../web/components/chat/status/StatusSegment";
import type { ImageArg } from "#lib/wire/protocol";
import type { ChatItem } from "../../../web/state";
import {
	chatAdvisorBlockerItem,
	chatAdvisorItem,
	chatAssistantItem,
	chatAssistantStreamingItem,
	chatAssistantThinkingItem,
	chatBashItems,
	chatCompactionItems,
	chatFailedBashTool,
	chatEditTool,
	chatNoticeItems,
	chatReadTool,
	chatRuns,
	chatRunningBashTool,
	chatStreamingBlock,
	chatThinking,
	chatUserImagesItem,
	chatUserItem,
} from "../../fixtures/chat";
import { genericDoneTool, genericErrorTool } from "../../fixtures/tools";
import { defineStory } from "../../registry";
import type { Story } from "../../registry";

/**
 * Host for UserCard: the real card reports thumbnail clicks through onZoom, so
 * this shows what the transcript host receives for the clicked attachment.
 */
const UserWithZoom = (props: { user: Extract<ChatItem, { kind: "user" }> }) => {
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	return (
		<>
			<UserCard user={props.user} onZoom={setZoomed} />
			<Show when={zoomed()}>
				{(img) => <div class="msg-notice">Zoom requested: {img().mimeType}</div>}
			</Show>
		</>
	);
};

const stories: Story[] = [
	defineStory({
		id: "chat-transcript-cards-user-card",
		title: "UserCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/UserCard.tsx",
			export: "UserCard",
		},
		variants: [
			{ name: "Text prompt", render: () => <UserWithZoom user={chatUserItem} /> },
			{
				name: "Prompt with two images",
				description: "Click a thumbnail to see the zoom request the host receives.",
				render: () => <UserWithZoom user={chatUserImagesItem} />,
			},
		],
	}),
	defineStory({
		id: "chat-transcript-cards-assistant-card",
		title: "AssistantCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/AssistantCard.tsx",
			export: "AssistantCard",
		},
		variants: [
			{
				name: "Settled answer with markdown",
				render: () => <AssistantCard assistant={chatAssistantItem} thinking={false} />,
			},
			{
				name: "Thinking folded in",
				render: () => <AssistantCard assistant={chatAssistantThinkingItem} thinking={false} />,
			},
			{
				name: "Still streaming",
				render: () => <AssistantCard assistant={chatAssistantStreamingItem} thinking />,
			},
		],
	}),
	defineStory({
		id: "chat-transcript-cards-user-command-card",
		title: "UserCommandCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/UserCommandCard.tsx",
			export: "UserCommandCard",
		},
		variants: [
			{
				name: "Done, exit 0",
				render: () => <UserCommandCard item={chatBashItems[0]!} />,
			},
			{
				name: "Running, output streaming",
				render: () => <UserCommandCard item={chatBashItems[1]!} />,
			},
			{
				name: "Python $$, dimmed",
				render: () => <UserCommandCard item={chatBashItems[2]!} />,
			},
			{
				name: "Non-zero exit, truncated",
				render: () => <UserCommandCard item={chatBashItems[3]!} />,
			},
		],
	}),
	defineStory({
		id: "chat-transcript-cards-compaction-card",
		title: "CompactionCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/CompactionCard.tsx",
			export: "CompactionCard",
		},
		variants: [
			{
				name: "Completed with summary",
				render: () => <CompactionCard item={chatCompactionItems[0]!} />,
			},
			{
				name: "Aborted, will retry",
				render: () => <CompactionCard item={chatCompactionItems[1]!} />,
			},
		],
	}),
	defineStory({
		id: "chat-transcript-cards-notice-card",
		title: "NoticeCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/NoticeCard.tsx",
			export: "NoticeCard",
		},
		variants: chatNoticeItems.map((item) => ({
			name: `Level ${item.level}`,
			render: () => <NoticeCard item={item} />,
		})),
	}),
	defineStory({
		id: "chat-transcript-cards-advisor-card",
		title: "AdvisorCard",
		component: {
			file: "apps/web/components/chat/transcript/cards/AdvisorCard.tsx",
			export: "AdvisorCard",
		},
		variants: [
			{
				name: "Batched notes, mixed severity",
				render: () => <AdvisorCard item={chatAdvisorItem} />,
			},
			{
				name: "Blocker from a named advisor",
				render: () => <AdvisorCard item={chatAdvisorBlockerItem} />,
			},
		],
	}),
	defineStory({
		id: "chat-transcript-cards-tool-run-row",
		title: "ToolRunRow",
		component: {
			file: "apps/web/components/chat/transcript/cards/ToolRunRow.tsx",
			export: "ToolRunRow",
		},
		variants: chatRuns.map((run) => ({
			name: `${run.requestCount} tool calls, ${run.turnCount} turns${run.running ? ", running" : ""}`,
			render: () => <ToolRunRow run={run} />,
		})),
	}),
	defineStory({
		id: "chat-tools-tool-card",
		title: "ToolCard",
		component: { file: "apps/web/components/chat/tools/ToolCard.tsx", export: "ToolCard" },
		variants: [
			{ name: "read (dedicated renderer)", render: () => <ToolCard item={chatReadTool} /> },
			{ name: "bash running", render: () => <ToolCard item={chatRunningBashTool} /> },
			{ name: "edit (diff renderer)", render: () => <ToolCard item={chatEditTool} /> },
			{ name: "bash failed", render: () => <ToolCard item={chatFailedBashTool} /> },
			{
				name: "Unknown tool (generic fallback)",
				render: () => <ToolCard item={genericDoneTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-tool-chip",
		title: "ToolChip",
		component: { file: "apps/web/components/chat/tools/ToolCard.tsx", export: "ToolChip" },
		variants: [
			{ name: "Done", render: () => <ToolChip item={chatReadTool} /> },
			{ name: "Running", render: () => <ToolChip item={chatRunningBashTool} /> },
			{ name: "Failed bash", render: () => <ToolChip item={chatFailedBashTool} /> },
			{ name: "Error from unknown tool", render: () => <ToolChip item={genericErrorTool} /> },
		],
	}),
	defineStory({
		id: "chat-transcript-streaming-block",
		title: "StreamingBlock",
		component: {
			file: "apps/web/components/chat/transcript/StreamingBlock.tsx",
			export: "StreamingBlock",
		},
		variants: [
			{ name: "Streaming answer", render: () => <StreamingBlock block={chatStreamingBlock} /> },
			{ name: "Streaming thinking", render: () => <StreamingBlock block={chatThinking} /> },
		],
	}),
	defineStory({
		id: "chat-status-segment",
		title: "StatusSegment",
		component: {
			file: "apps/web/components/chat/status/StatusSegment.tsx",
			export: "StatusSegment",
		},
		variants: [
			{
				name: "Plain segment",
				render: () => <StatusSegment title="Switch model">claude-opus-4.1</StatusSegment>,
			},
			{
				name: "Active segment",
				render: () => (
					<StatusSegment active title="Queued follow-ups" ariaLabel="Queued follow-ups">
						2 queued
					</StatusSegment>
				),
			},
			{
				name: "Badge variant",
				render: () => (
					<StatusSegment class="badge goal-badge" title="Goal progress">
						goal 2/5
					</StatusSegment>
				),
			},
			{
				name: "Session name",
				render: () => (
					<StatusSegment class="session-name" title="Rename session">
						retry-badge-queue
					</StatusSegment>
				),
			},
		],
	}),
];

export default stories;
