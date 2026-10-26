import { createSignal, Show } from "solid-js";
import { AdvisorCard } from "../../../web/components/chat/transcript/cards/AdvisorCard";
import { AssistantCard } from "../../../web/components/chat/transcript/cards/AssistantCard";
import { CompactionCard } from "../../../web/components/chat/transcript/cards/CompactionCard";
import { NoticeCard } from "../../../web/components/chat/transcript/cards/NoticeCard";
import { UserCard } from "../../../web/components/chat/transcript/cards/UserCard";
import { UserCommandCard } from "../../../web/components/chat/transcript/cards/UserCommandCard";
import { ToolCard } from "../../../web/components/chat/tools/ToolCard";
import { ToolRunRow } from "../../../web/components/chat/transcript/cards/ToolRunRow";
import { groupToolRuns } from "../../../web/chat/tool-runs";
import { StreamingBlock } from "../../../web/components/chat/transcript/StreamingBlock";
import { StatusSegment } from "../../../web/components/chat/status/StatusSegment";
import type { ImageArg } from "#lib/wire/protocol";
import { setState } from "../../../web/state";
import type { ChatItem } from "../../../web/state";
import {
	chatAdvisorBlockerItem,
	chatAdvisorItem,
	chatAssistantItem,
	chatAssistantStampedItem,
	chatAssistantStreamingItem,
	chatAssistantThinkingItem,
	chatBashItems,
	chatCompactionItems,
	chatFailedBashTool,
	chatEditTool,
	chatNoticeItems,
	chatReadTool,
	chatRunningBashTool,
	chatStreamingBlock,
	chatThinking,
	chatUserImagesItem,
	chatUserItem,
	chatUserLongItem,
	chatTokenUsageSettingsModel,
} from "../../fixtures/chat";
import { genericDoneTool } from "../../fixtures/tools";
import { defineStory } from "../../registry";
import type { Story } from "../../registry";

/**
 * Host for UserCard: the real card reports thumbnail clicks through onZoom, so
 * this shows what the transcript host receives for the clicked attachment.
 */
const UserWithZoom = (props: {
	user: Extract<ChatItem, { kind: "user" }>;
	branchable?: boolean;
	fold?: boolean;
}) => {
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	return (
		<>
			<UserCard
				user={props.user}
				onZoom={setZoomed}
				branchable={props.branchable}
				fold={props.fold}
			/>
			<Show when={zoomed()}>
				{(img) => <div class="msg-notice">Zoom requested: {img().mimeType}</div>}
			</Show>
		</>
	);
};

const settledRun = groupToolRuns([
	chatAssistantThinkingItem,
	chatReadTool,
	chatEditTool,
	chatFailedBashTool,
])[0]!;
const runningRun = groupToolRuns([chatReadTool, chatRunningBashTool])[0]!;
const noWaitRuns = new Map();

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
			{
				name: "Long brief, folded",
				description:
					"The agent view's assignment: `fold` clamps the text to about eight lines behind a Show all toggle. Branch-from-here is hidden (`branchable` false), since a subagent transcript is not a branchable session.",
				render: () => <UserWithZoom user={chatUserLongItem} fold branchable={false} />,
			},
			{
				name: "Long brief, not folded",
				description:
					"The main session's card: the same text in full, with branch-from-here on hover.",
				render: () => <UserWithZoom user={chatUserLongItem} />,
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
			{
				name: "Interrupted by Stop",
				description: "A turn the user stopped ends with an Interrupted footer.",
				render: () => (
					<AssistantCard assistant={{ ...chatAssistantItem, interrupted: true }} thinking={false} />
				),
			},
			{
				name: "Per-turn usage row",
				description:
					"With Show Token Usage on, the row under the answer leads with the turn's completion date and time, then turn time and usage.",
				seed: { settingsModel: chatTokenUsageSettingsModel },
				render: () => (
					<AssistantCard
						assistant={chatAssistantStampedItem}
						thinking={false}
						meta={{ turnMs: 9200 }}
					/>
				),
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
		variants: [
			...chatNoticeItems.map((item) => ({
				name: `Level ${item.level}`,
				render: () => <NoticeCard item={item} />,
			})),
			{
				name: "Forwarded command reply",
				description: "The reply is headed by the command it answers, so it reads as its result.",
				render: () => (
					<NoticeCard
						item={{
							kind: "notice",
							id: 54,
							level: "info",
							command: "/add-dir",
							message: "Added /home/joshua/shared to the workspace.",
						}}
					/>
				),
			},
			{
				name: "Long forwarded reply collapses",
				description:
					"A reply over 6 lines or 400 characters collapses behind its first line; the command header stays visible.",
				render: () => (
					<NoticeCard
						item={{
							kind: "notice",
							id: 55,
							level: "info",
							command: "/security",
							message: Array.from(
								{ length: 9 },
								(_, n) => `Scan ${n + 1}: 0 findings in apps/web/module-${n + 1}.ts`,
							).join("\n"),
						}}
					/>
				),
			},
		],
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
				name: "Expanded, mixed severity",
				description: "Expanded (the default): every note shows under the header.",
				seed: () => setState("display", "advisor", "expanded"),
				render: () => <AdvisorCard item={chatAdvisorItem} />,
			},
			{
				name: "Expanded, blocker from a named advisor",
				seed: () => setState("display", "advisor", "expanded"),
				render: () => <AdvisorCard item={chatAdvisorBlockerItem} />,
			},
			{
				name: "Collapsed, mixed severity",
				description:
					"Collapsed: the one-line header alone. Click it to open this card; the card closes again with another click, and a preference change resets it.",
				seed: () => setState("display", "advisor", "collapsed"),
				render: () => <AdvisorCard item={chatAdvisorItem} />,
			},
			{
				name: "Collapsed, blocker count in the header",
				description: "Ctrl+O (tool output expanded) does not open an advisor card.",
				seed: () => {
					setState("toolsExpanded", true);
					setState("display", "advisor", "collapsed");
				},
				render: () => <AdvisorCard item={chatAdvisorBlockerItem} />,
			},
		],
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
				name: "Collapsed mode (read)",
				description:
					"Tool cards Collapsed: even the dedicated renderers draw header-only and open on click.",
				seed: () => setState("display", { toolCards: "collapsed" }),
				render: () => <ToolCard item={chatReadTool} />,
			},
			{
				name: "Collapsed mode (bash running)",
				description: "A running call stays open.",
				seed: () => setState("display", { toolCards: "collapsed" }),
				render: () => <ToolCard item={chatRunningBashTool} />,
			},
			{
				name: "Unknown tool (generic fallback)",
				render: () => <ToolCard item={genericDoneTool} />,
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
		variants: [
			{
				name: "Closed",
				description:
					"Consolidated tool cards: one row per run, counted by tool, with the thinking folded from the message before it and the err/req/duration/turns meta.",
				render: () => <ToolRunRow run={settledRun} waitRuns={noWaitRuns} transcript={[]} />,
			},
			{
				name: "Running call under a closed run",
				description:
					"A call that is still running shows open under its row, and folds back in when it finishes.",
				render: () => <ToolRunRow run={runningRun} waitRuns={noWaitRuns} transcript={[]} />,
			},
			{
				name: "Open (Ctrl+O)",
				description:
					"Show-everything opens the run (a click on the row does too): the folded thinking, then the run's calls as header-only cards that each open on their own click. Ctrl+O opens those as well.",
				seed: { toolsExpanded: true },
				render: () => <ToolRunRow run={settledRun} waitRuns={noWaitRuns} transcript={[]} />,
			},
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
