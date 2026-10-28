import type { JSX } from "solid-js";
import { setState } from "../../../../web/state";
import { AskToolCard } from "../../../../web/components/chat/tools/AskToolCard";
import { BashToolCard } from "../../../../web/components/chat/tools/BashToolCard";
import {
	CollapsibleOutput,
	ToolCardShell,
} from "../../../../web/components/chat/tools/ToolCardShell";
import { EvalToolCard } from "../../../../web/components/chat/tools/EvalToolCard";
import { GenericToolCard } from "../../../../web/components/chat/tools/GenericToolCard";
import { LspToolCard } from "../../../../web/components/chat/tools/LspToolCard";
import { ReadToolCard } from "../../../../web/components/chat/tools/ReadToolCard";
import { SearchToolCard } from "../../../../web/components/chat/tools/SearchToolCard";
import { TaskToolCard } from "../../../../web/components/chat/tools/TaskToolCard";
import { TodoToolCard } from "../../../../web/components/chat/tools/TodoToolCard";
import { WaitToolCard } from "../../../../web/components/chat/tools/WaitToolCard";
import { WebSearchToolCard } from "../../../../web/components/chat/tools/WebSearchToolCard";
import { ToolCard } from "../../../../web/components/chat/tools/ToolCard";
import { HighlightedLine } from "../../../../web/components/chat/tools/HighlightedLine";
import { HighlightedText } from "../../../../web/components/chat/tools/HighlightedText";
import { ShellCommand } from "../../../../web/components/chat/tools/ShellCommand";
import {
	editToolItem,
	askCustomTool,
	askDoneTool,
	askErrorTool,
	askMultiTool,
	askRunningTool,
	bashDoneTool,
	bashErrorTool,
	bashHeredocTool,
	bashInterruptedTool,
	bashLongCommandTool,
	bashLongTool,
	bashMultilineTool,
	bashRunningTool,
	evalDoneTool,
	evalErrorTool,
	evalImageTool,
	evalRunningTool,
	evalStatusDoneTool,
	evalStatusRunningTool,
	evalViewsTool,
	genericDoneTool,
	genericErrorTool,
	genericInterruptedTool,
	genericImageTool,
	genericLongTool,
	genericMcpProgressTool,
	genericRunningTool,
	globDoneTool,
	grepDoneTool,
	grepSingleFileTool,
	grepErrorTool,
	grepLongTool,
	grepRunningTool,
	lspDefinitionTool,
	lspDiagnosticsTool,
	lspReferencesTool,
	lspRunningTool,
	readDoneTool,
	readPlainTool,
	readPythonTool,
	readErrorTool,
	readLongTool,
	readRunningTool,
	taskDoneTool,
	taskErrorTool,
	taskPendingTool,
	taskRunningTool,
	taskStageSubagentMap,
	taskStageTool,
	taskSubagentMap,
	todoArgsTool,
	todoEmptyTool,
	todoItemsTool,
	todoSnapshotTool,
	waitSettledTool,
	webSearchDoneTool,
	webSearchErrorTool,
	webSearchNoLinksTool,
	webSearchRunningTool,
} from "../../../fixtures/tools";
import {
	bashBackgroundCancelledTool,
	bashBackgroundCompletedTool,
	bashBackgroundFailedTool,
	bashBackgroundRunningTool,
	evalBackgroundCompletedTool,
	evalBackgroundFailedTool,
	evalBackgroundRunningTool,
	taskBackgroundCompletedTool,
	taskBackgroundFailedTool,
	taskBackgroundRunningTool,
} from "../../../fixtures/background-tools";
import { agentSettingsModel } from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";
import type { Story } from "../../../registry";

/** One tool card per status, side by side: running, done, error, interrupted. */
const statusRow = (cards: JSX.Element[]): JSX.Element => <div class="ds-status-grid">{cards}</div>;

/** ShellCommand: 40 one-line commands, past the 30-row cap. */
const fortyRows = Array.from({ length: 40 }, (_, i) => `echo "row ${i + 1}"`).join("\n");

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
					<ToolCardShell name="bash" arg="bun run lint" status="done" class="bash-tool">
						<pre>{"$ bun run lint\nFound 0 warnings and 0 errors."}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Running, header meta",
				render: () => (
					<ToolCardShell
						name="eval"
						arg="(python)"
						status="running"
						meta={<span class="tool-meta">cell 2</span>}
					>
						<pre>{"apps/web/components/app/NoActiveSessionPane.tsx 612\n"}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Collapsible, closed by default",
				render: () => (
					<ToolCardShell
						name="mcp__linear_list_issues"
						arg='{"team":"OMP","limit":3}'
						status="done"
						collapsible
					>
						<pre>{'[{ "id": "OMP-412", "assignee": "joshua" }]'}</pre>
					</ToolCardShell>
				),
			},
			{
				name: "Collapsed mode, header-only",
				description:
					"Tool cards Collapsed: a card with a body that is normally always open becomes a header closed until clicked. Running cards stay open.",
				seed: () => setState("display", { toolCards: "collapsed" }),
				render: () => (
					<>
						<ToolCardShell name="bash" arg="bun run lint" status="done" class="bash-tool">
							<pre>{"$ bun run lint\nFound 0 warnings and 0 errors."}</pre>
						</ToolCardShell>
						<ToolCardShell name="bash" arg="bun run check:types" status="running" class="bash-tool">
							<pre>{"checking apps/web ..."}</pre>
						</ToolCardShell>
					</>
				),
			},
			{
				name: "Error status, no body",
				render: () => <ToolCardShell name="read" arg="apps/web/missing.ts" status="error" />,
			},
			{
				name: "Interrupted status, no body",
				render: () => <ToolCardShell name="bash" arg="sleep 600" status="interrupted" />,
			},
			{
				name: "Running in the background",
				description: "A badge with the job's run time sits before the status slot.",
				render: () => (
					<ToolCardShell
						name="bash"
						arg="bun run dev"
						status="running"
						background={bashBackgroundRunningTool.background}
					/>
				),
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
					"Settled card with 44 lines of output; a Show hidden lines button appears under the body (Ctrl+O also shows everything).",
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} />,
			},
			{
				name: "Expanded (Ctrl+O)",
				seed: { toolsExpanded: true },
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} />,
			},
			{
				name: "Rows: 10",
				description: "The Appearance sheet's Rows choice sets how many lines show before the note.",
				seed: () => setState("display", { toolRows: "10" }),
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} />,
			},
			{
				name: "Rows: 10, tail",
				description: "Terminal output keeps its last rows.",
				seed: () => setState("display", { toolRows: "10" }),
				render: () => <CollapsibleOutput item={bashLongTool} output={bashLongTool.output} tail />,
			},
			{
				name: "Rows: All",
				description: "No cap, so no hidden-lines note.",
				seed: () => setState("display", { toolRows: "all" }),
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
			{
				name: "Multi-line command",
				description: "The header grows to show every line of the command.",
				render: () => <BashToolCard item={bashMultilineTool} />,
			},
			{
				name: "Very long command",
				description: "One long line soft-wraps across header rows instead of an ellipsis.",
				render: () => <BashToolCard item={bashLongCommandTool} />,
			},
			{
				name: "Command past the row cap",
				description:
					"A 63-line heredoc clamps to its first 30 rows behind Show full command; Ctrl+O lifts the cap.",
				render: () => <BashToolCard item={bashHeredocTool} />,
			},
			{
				name: "Background, running",
				description:
					"The call returned while its job keeps running: the badge counts the job's run time, the spinner stays and the job's output fills the card.",
				render: () => <BashToolCard item={bashBackgroundRunningTool} />,
			},
			{
				name: "Background, completed",
				description: "The job finished: a done card with the job's result and its run time.",
				render: () => <BashToolCard item={bashBackgroundCompletedTool} />,
			},
			{
				name: "Background, failed",
				description: "The job failed: an error card, the badge names the exit code.",
				render: () => <BashToolCard item={bashBackgroundFailedTool} />,
			},
			{
				name: "Background, cancelled",
				description: "The job was cancelled: an interrupted card that keeps the output it got to.",
				render: () => <BashToolCard item={bashBackgroundCancelledTool} />,
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
			{
				name: "Printed DataFrame, dict and Markdown",
				description:
					"The cell printed a DataFrame, a dict and a Markdown object: a table, a collapsible JSON tree and rendered Markdown take the place of their text.",
				render: () => <EvalToolCard item={evalViewsTool} />,
			},
			{
				name: "Running, live status events",
				description:
					"Helpers' status events and an MCP progress line list under the output, newest last, behind an earlier count.",
				render: () => <EvalToolCard item={evalStatusRunningTool} />,
			},
			{
				name: "Done, status log and notice",
				description:
					"The settled call's status log (a helper's preview text is left out) and the backend notice.",
				render: () => <EvalToolCard item={evalStatusDoneTool} />,
			},
			{
				name: "Background, running",
				description:
					"The cell returned while its job runs: the badge counts its run time and its output keeps filling the card.",
				render: () => <EvalToolCard item={evalBackgroundRunningTool} />,
			},
			{
				name: "Background, completed",
				render: () => <EvalToolCard item={evalBackgroundCompletedTool} />,
			},
			{
				name: "Background, failed",
				render: () => <EvalToolCard item={evalBackgroundFailedTool} />,
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
			{
				name: "MCP call in flight, progress line",
				description:
					"While an MCP call runs its output is the server's progress (message and count), shown as a status line.",
				render: () => <GenericToolCard item={genericMcpProgressTool} />,
			},
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
			{
				name: "Excerpt with line numbers",
				description:
					"Hashline output: the [path#TAG] header is dropped, content is highlighted by file extension.",
				render: () => <ReadToolCard item={readDoneTool} />,
			},
			{
				name: "Python, multi-line docstring",
				description: "Highlighted as one block, so the docstring colors across its rows.",
				render: () => <ReadToolCard item={readPythonTool} />,
			},
			{
				name: "Plain output, no line numbers",
				description:
					"Bare terminal body with a block comment spanning rows; the SDK notice stays plain.",
				render: () => <ReadToolCard item={readPlainTool} />,
			},
			{ name: "Running", render: () => <ReadToolCard item={readRunningTool} /> },
			{
				name: "Long file, offset 40",
				description: "26 lines, starting mid-file; numbers follow the tool's offset.",
				render: () => <ReadToolCard item={readLongTool} />,
			},
			{
				name: "Rows: 10",
				description: "Reads keep the head of the file; the Rows choice sets how many rows show.",
				seed: () => setState("display", { toolRows: "10" }),
				render: () => <ReadToolCard item={readLongTool} />,
			},
			{
				name: "Rows: All",
				seed: () => setState("display", { toolRows: "all" }),
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
			{
				name: "grep, grouped by file",
				description: "SDK grouped output: file headers copy the path, line numbers copy path:line.",
				render: () => <SearchToolCard item={grepDoneTool} />,
			},
			{
				name: "grep, single file (plain mode)",
				description: "No file header; rows use the search path from the call's arguments.",
				render: () => <SearchToolCard item={grepSingleFileTool} />,
			},
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
			{
				name: "Running, agents report their stage",
				description:
					"Each running row leads with the agent's own current step (from its periodic completion probe), then the tool in flight; needs the live preview display setting.",
				seed: { subagents: taskStageSubagentMap, settingsModel: agentSettingsModel },
				render: () => <TaskToolCard item={taskStageTool} />,
			},
			{
				name: "Background, running",
				description:
					"The spawn call returned while its agents run: the badge counts the job's run time and the card stays running until every agent settled.",
				render: () => <TaskToolCard item={taskBackgroundRunningTool} />,
			},
			{
				name: "Background, completed",
				render: () => <TaskToolCard item={taskBackgroundCompletedTool} />,
			},
			{
				name: "Background, failed",
				render: () => <TaskToolCard item={taskBackgroundFailedTool} />,
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
	defineStory({
		id: "chat-tools-statuses",
		title: "Tool card statuses and categories",
		component: { file: "apps/web/components/chat/tools/ToolCard.tsx", export: "ToolCard" },
		variants: [
			{
				name: "All four statuses (bash)",
				description:
					"Running spins, done leaves the slot empty with a green border, error shows the warning icon on a red border, interrupted the stop icon on an amber border.",
				render: () =>
					statusRow([
						<BashToolCard item={bashRunningTool} />,
						<BashToolCard item={bashDoneTool} />,
						<BashToolCard item={bashErrorTool} />,
						<BashToolCard item={bashInterruptedTool} />,
					]),
			},
			{
				name: "All four statuses (collapsible summary header)",
				description: "Same status slot in the <summary> header of a collapsible card.",
				render: () =>
					statusRow([
						<GenericToolCard item={genericRunningTool} />,
						<GenericToolCard item={genericDoneTool} />,
						<GenericToolCard item={genericErrorTool} />,
						<GenericToolCard item={genericInterruptedTool} />,
					]),
			},
			{
				name: "Every tool category",
				description:
					"Shell, read, write, search, agents, and other (MCP) each get their own icon and color.",
				render: () =>
					statusRow([
						<ToolCard item={bashDoneTool} />,
						<ToolCard item={evalDoneTool} />,
						<ToolCard item={readDoneTool} />,
						<ToolCard item={editToolItem} />,
						<ToolCard item={grepDoneTool} />,
						<ToolCard item={webSearchDoneTool} />,
						<ToolCard item={lspDefinitionTool} />,
						<ToolCard item={taskPendingTool} />,
						<WaitToolCard calls={[waitSettledTool]} />,
						<ToolCard item={askDoneTool} />,
						<ToolCard item={todoArgsTool} />,
						<ToolCard item={genericDoneTool} />,
						<ToolCard item={genericImageTool} />,
					]),
			},
		],
	}),
	defineStory({
		id: "chat-tools-shell-command",
		title: "ShellCommand",
		component: { file: "apps/web/components/chat/tools/ShellCommand.tsx", export: "ShellCommand" },
		variants: [
			{ name: "Bash", render: () => <ShellCommand command="git status --short" lang="bash" /> },
			{
				name: "Python",
				render: () => <ShellCommand command={'print("hello")'} lang="python" />,
			},
			{
				name: "Past the row cap",
				description: "Clamps to its first 30 rows behind Show full command.",
				render: () => <ShellCommand command={fortyRows} lang="bash" />,
			},
			{
				name: "Past the row cap, expanded (Ctrl+O)",
				description: "Ctrl+O shows the whole command with no toggle.",
				seed: { toolsExpanded: true },
				render: () => <ShellCommand command={fortyRows} lang="bash" />,
			},
		],
	}),
	defineStory({
		id: "chat-tools-highlighted-text",
		title: "HighlightedText",
		component: {
			file: "apps/web/components/chat/tools/HighlightedText.tsx",
			export: "HighlightedText",
		},
		variants: [
			{
				name: "Bash",
				render: () => (
					<pre class="terminal tool-code">
						<HighlightedText code={'for f in *.ts; do echo "$f"; done # list'} lang="bash" />
					</pre>
				),
			},
			{
				name: "JSON",
				render: () => (
					<pre class="terminal tool-code">
						<HighlightedText
							code={'{\n  "team": "OMP",\n  "limit": 3,\n  "open": true\n}'}
							lang="json"
						/>
					</pre>
				),
			},
			{
				name: "Unknown language (plain)",
				render: () => (
					<pre class="terminal tool-code">
						<HighlightedText code="SELECT-ish text with <tags> stays escaped" lang="cobol" />
					</pre>
				),
			},
		],
	}),
	defineStory({
		id: "chat-tools-highlighted-line",
		title: "HighlightedLine",
		component: {
			file: "apps/web/components/chat/tools/HighlightedLine.tsx",
			export: "HighlightedLine",
		},
		variants: [
			{
				name: "Highlighted HTML",
				description: "One row of highlightLines output: hljs spans, balanced within the row.",
				render: () => (
					<pre class="terminal tool-code">
						<HighlightedLine
							html={
								'<span class="hljs-keyword">const</span> limit = <span class="hljs-number">3</span>; <span class="hljs-comment">// cap</span>'
							}
							text="const limit = 3; // cap"
						/>
					</pre>
				),
			},
			{
				name: "No grammar (plain text)",
				render: () => (
					<pre class="terminal tool-code">
						<HighlightedLine html={null} text="const limit = <3>; stays escaped" />
					</pre>
				),
			},
		],
	}),
];

export default stories;
