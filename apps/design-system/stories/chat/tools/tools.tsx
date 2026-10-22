import { AskToolCard } from "../../../../web/components/chat/tools/AskToolCard";
import { BashToolCard } from "../../../../web/components/chat/tools/BashToolCard";
import {
	CollapsibleOutput,
	ToolCardShell,
} from "../../../../web/components/chat/tools/ToolCardShell";
import { EvalToolCard } from "../../../../web/components/chat/tools/EvalToolCard";
import { GenericToolCard } from "../../../../web/components/chat/tools/GenericToolCard";
import { HubToolCard } from "../../../../web/components/chat/tools/HubToolCard";
import { LspToolCard } from "../../../../web/components/chat/tools/LspToolCard";
import { ReadToolCard } from "../../../../web/components/chat/tools/ReadToolCard";
import { SearchToolCard } from "../../../../web/components/chat/tools/SearchToolCard";
import { TaskToolCard } from "../../../../web/components/chat/tools/TaskToolCard";
import { TodoToolCard } from "../../../../web/components/chat/tools/TodoToolCard";
import { WebSearchToolCard } from "../../../../web/components/chat/tools/WebSearchToolCard";
import {
	askCustomTool,
	askDoneTool,
	askErrorTool,
	askMultiTool,
	askRunningTool,
	bashDoneTool,
	bashErrorTool,
	bashLongTool,
	bashRunningTool,
	evalDoneTool,
	evalErrorTool,
	evalImageTool,
	evalRunningTool,
	genericDoneTool,
	genericErrorTool,
	genericImageTool,
	genericLongTool,
	genericRunningTool,
	globDoneTool,
	grepDoneTool,
	grepErrorTool,
	grepLongTool,
	grepRunningTool,
	hubErrorTool,
	hubPollTool,
	hubSendTool,
	hubWaitTool,
	lspDefinitionTool,
	lspDiagnosticsTool,
	lspReferencesTool,
	lspRunningTool,
	readDoneTool,
	readErrorTool,
	readLongTool,
	readRunningTool,
	taskDoneTool,
	taskErrorTool,
	taskPendingTool,
	taskRunningTool,
	taskSubagentMap,
	todoArgsTool,
	todoEmptyTool,
	todoItemsTool,
	todoSnapshotTool,
	webSearchDoneTool,
	webSearchErrorTool,
	webSearchNoLinksTool,
	webSearchRunningTool,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";
import type { Story } from "../../../registry";

const stories: Story[] = [
	defineStory({
		id: "chat-tools-tool-card-shell",
		title: "ToolCardShell",
		component: {
			file: "apps/web/components/chat/tools/ToolCardShell.tsx",
			export: "ToolCardShell",
		},
		variants: [
			{
				name: "Settled, with body",
				render: () => (
					<ToolCardShell name="bash" status="done" class="bash-tool">
						<pre>{"$ bun run lint\nFound 0 warnings and 0 errors."}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Running, header meta",
				render: () => (
					<ToolCardShell
						name="eval"
						status="running"
						meta={<span class="tool-meta">python · cell 2</span>}
					>
						<pre>{"apps/web/components/app/NoActiveSessionPane.tsx 612\n"}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Collapsible, closed by default",
				render: () => (
					<ToolCardShell name="mcp_linear_list_issues" status="done" collapsible>
						<pre>{'[{ "id": "OMP-412", "assignee": "joshua" }]'}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Error status, no body",
				render: () => <ToolCardShell name="read" status="error" />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-collapsible-output",
		title: "CollapsibleOutput",
		component: {
			file: "apps/web/components/chat/tools/ToolCardShell.tsx",
			export: "CollapsibleOutput",
		},
		variants: [
			{
				name: "Collapsed, first 20 lines",
				description:
					"Settled card with 44 lines of output; the Ctrl+O note appears under the body.",
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} />,
			},
			{
				name: "Expanded (Ctrl+O)",
				seed: { toolsExpanded: true },
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} />,
			},
			{
				name: "Tail mode, last 8 lines",
				render: () => (
					<CollapsibleOutput item={bashLongTool} output={bashLongTool.output} maxLines={8} tail />
				),
			},
			{
				name: "Numbered gutter, from line 40",
				render: () => (
					<CollapsibleOutput
						item={bashLongTool}
						output={bashLongTool.output}
						numbered
						startNo={40}
					/>
				),
			},
		],
	}),
	defineStory({
		id: "chat-tools-bash-tool-card",
		title: "BashToolCard",
		component: { file: "apps/web/components/chat/tools/BashToolCard.tsx", export: "BashToolCard" },
		variants: [
			{ name: "Running (streaming)", render: () => <BashToolCard item={bashRunningTool} /> },
			{ name: "Done, short output", render: () => <BashToolCard item={bashDoneTool} /> },
			{ name: "Error, failing test run", render: () => <BashToolCard item={bashErrorTool} /> },
			{
				name: "Long output, collapsed tail",
				description: "Settled card past the 20-line cap; toggle Ctrl+O from the header to expand.",
				render: () => <BashToolCard item={bashLongTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-ask-tool-card",
		title: "AskToolCard",
		component: { file: "apps/web/components/chat/tools/AskToolCard.tsx", export: "AskToolCard" },
		variants: [
			{ name: "Waiting for an answer", render: () => <AskToolCard item={askRunningTool} /> },
			{ name: "Answered with an option", render: () => <AskToolCard item={askDoneTool} /> },
			{
				name: "Answered with a custom response",
				description:
					"No option picked: every offered option stays unmarked and the typed response and note show below.",
				render: () => <AskToolCard item={askCustomTool} />,
			},
			{
				name: "Two questions, multi-select",
				render: () => <AskToolCard item={askMultiTool} />,
			},
			{ name: "Dismissed", render: () => <AskToolCard item={askErrorTool} /> },
		],
	}),
	defineStory({
		id: "chat-tools-eval-tool-card",
		title: "EvalToolCard",
		component: { file: "apps/web/components/chat/tools/EvalToolCard.tsx", export: "EvalToolCard" },
		variants: [
			{ name: "Running (partial output)", render: () => <EvalToolCard item={evalRunningTool} /> },
			{ name: "Done (python)", render: () => <EvalToolCard item={evalDoneTool} /> },
			{ name: "Error (js)", render: () => <EvalToolCard item={evalErrorTool} /> },
			{
				name: "With display image",
				description: "Click the chart thumbnail to open the full-size overlay.",
				render: () => <EvalToolCard item={evalImageTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-generic-tool-card",
		title: "GenericToolCard",
		component: {
			file: "apps/web/components/chat/tools/GenericToolCard.tsx",
			export: "GenericToolCard",
		},
		variants: [
			{
				name: "Collapsed by default",
				description: "Done calls start closed: only the header and args summary show.",
				render: () => <GenericToolCard item={genericDoneTool} />,
			},
			{
				name: "Expanded JSON result",
				seed: { toolsExpanded: true },
				render: () => <GenericToolCard item={genericDoneTool} />,
			},
			{
				name: "Running, no output yet",
				description: "Running calls open automatically; the body fills in as output streams.",
				render: () => <GenericToolCard item={genericRunningTool} />,
			},
			{
				name: "Timed-out call",
				seed: { toolsExpanded: true },
				render: () => <GenericToolCard item={genericErrorTool} />,
			},
			{
				name: "Long output, 60 rows",
				description: "All 60 rows render inside the open body; no line cap on this generic card.",
				seed: { toolsExpanded: true },
				render: () => <GenericToolCard item={genericLongTool} />,
			},
			{
				name: "Expanded with screenshot",
				seed: { toolsExpanded: true },
				render: () => <GenericToolCard item={genericImageTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-hub-tool-card",
		title: "HubToolCard",
		component: { file: "apps/web/components/chat/tools/HubToolCard.tsx", export: "HubToolCard" },
		variants: [
			{ name: "Send to a peer", render: () => <HubToolCard item={hubSendTool} /> },
			{ name: "Waiting for a reply", render: () => <HubToolCard item={hubWaitTool} /> },
			{ name: "Poll with reply", render: () => <HubToolCard item={hubPollTool} /> },
			{ name: "Peer not registered", render: () => <HubToolCard item={hubErrorTool} /> },
		],
	}),
	defineStory({
		id: "chat-tools-lsp-tool-card",
		title: "LspToolCard",
		component: { file: "apps/web/components/chat/tools/LspToolCard.tsx", export: "LspToolCard" },
		variants: [
			{ name: "Definition", render: () => <LspToolCard item={lspDefinitionTool} /> },
			{ name: "Running", render: () => <LspToolCard item={lspRunningTool} /> },
			{
				name: "References (capped list)",
				render: () => <LspToolCard item={lspReferencesTool} />,
			},
			{ name: "Diagnostics with errors", render: () => <LspToolCard item={lspDiagnosticsTool} /> },
		],
	}),
	defineStory({
		id: "chat-tools-read-tool-card",
		title: "ReadToolCard",
		component: { file: "apps/web/components/chat/tools/ReadToolCard.tsx", export: "ReadToolCard" },
		variants: [
			{ name: "Excerpt with line numbers", render: () => <ReadToolCard item={readDoneTool} /> },
			{ name: "Running", render: () => <ReadToolCard item={readRunningTool} /> },
			{
				name: "Long file, offset 40",
				description: "26 lines, starting mid-file; numbers follow the tool's offset.",
				render: () => <ReadToolCard item={readLongTool} />,
			},
			{ name: "File not found", render: () => <ReadToolCard item={readErrorTool} /> },
		],
	}),
	defineStory({
		id: "chat-tools-search-tool-card",
		title: "SearchToolCard",
		component: {
			file: "apps/web/components/chat/tools/SearchToolCard.tsx",
			export: "SearchToolCard",
		},
		variants: [
			{ name: "grep with path:line hits", render: () => <SearchToolCard item={grepDoneTool} /> },
			{ name: "glob listing", render: () => <SearchToolCard item={globDoneTool} /> },
			{ name: "Running", render: () => <SearchToolCard item={grepRunningTool} /> },
			{ name: "Invalid pattern", render: () => <SearchToolCard item={grepErrorTool} /> },
			{
				name: "40 hits, scrolling",
				render: () => <SearchToolCard item={grepLongTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-task-tool-card",
		title: "TaskToolCard",
		component: { file: "apps/web/components/chat/tools/TaskToolCard.tsx", export: "TaskToolCard" },
		seed: { subagents: taskSubagentMap },
		variants: [
			{
				name: "Running, three subagents",
				description: "Two still running, one already completed.",
				render: () => <TaskToolCard item={taskRunningTool} />,
			},
			{ name: "Finished, two subagents", render: () => <TaskToolCard item={taskDoneTool} /> },
			{ name: "Subagent failed", render: () => <TaskToolCard item={taskErrorTool} /> },
			{
				name: "No subagent yet",
				description: "Spawn call with no tracked subagents: the call's own description only.",
				render: () => <TaskToolCard item={taskPendingTool} />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-todo-tool-card",
		title: "TodoToolCard",
		component: { file: "apps/web/components/chat/tools/TodoToolCard.tsx", export: "TodoToolCard" },
		variants: [
			{ name: "Phases from call args", render: () => <TodoToolCard item={todoArgsTool} /> },
			{ name: "Flat items from call args", render: () => <TodoToolCard item={todoItemsTool} /> },
			{
				name: "Settled snapshot overrides args",
				description:
					"The result details hold the board the call settled with; the live board is never shown.",
				render: () => <TodoToolCard item={todoSnapshotTool} />,
			},
			{ name: "No recognised args", render: () => <TodoToolCard item={todoEmptyTool} /> },
		],
	}),
	defineStory({
		id: "chat-tools-web-search-tool-card",
		title: "WebSearchToolCard",
		component: {
			file: "apps/web/components/chat/tools/WebSearchToolCard.tsx",
			export: "WebSearchToolCard",
		},
		variants: [
			{ name: "Running", render: () => <WebSearchToolCard item={webSearchRunningTool} /> },
			{ name: "Result with links", render: () => <WebSearchToolCard item={webSearchDoneTool} /> },
			{
				name: "No links (generic fallback)",
				render: () => <WebSearchToolCard item={webSearchNoLinksTool} />,
			},
			{
				name: "Provider rate limit",
				render: () => <WebSearchToolCard item={webSearchErrorTool} />,
			},
		],
	}),
];

export default stories;
