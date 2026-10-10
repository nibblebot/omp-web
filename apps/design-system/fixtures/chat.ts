import type { AcItem } from "../../web/components/chat/composer/AutocompletePopup";
import type { Run } from "../../web/chat/tool-runs";
import type { UsageLike } from "../../web/usage/usage";
import type {
	AdvisorItem,
	BashItem,
	Block,
	ChatItem,
	CompactionItem,
	PromptInsert,
	ToolItem,
} from "../../web/state";
import type { ImageArg } from "#lib/wire/protocol";
import { terminalScreenshot } from "./tools";

/** 1x1 PNG, enough for an image chip without shipping real pixels. */
const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const usage: UsageLike = {
	input: 18_432,
	output: 1_206,
	cacheRead: 15_872,
	cacheWrite: 2_048,
	totalTokens: 37_558,
};

const screenshot: ImageArg = { type: "image", data: PIXEL_PNG, mimeType: "image/png" };

// ---------------------------------------------------------------------------
// Tool items. Shared between the transcript and the run fixtures so that a
// Run's `tools` are the same objects the transcript renders.
// ---------------------------------------------------------------------------

/** ToolCard (read): completed file read with a line-numbered excerpt. */
export const chatReadTool: ToolItem = {
	kind: "tool",
	id: 3,
	toolCallId: "call_read_3",
	name: "read",
	args: { path: "apps/web/components/ui/CopyButton.tsx", offset: 1, limit: 24 },
	status: "done",
	output: [
		'1→import { createSignal } from "solid-js";',
		"2→",
		"3→export const COPY_FEEDBACK_MS = 1200;",
		"4→",
		"5→export const CopyButton = (props) => {",
		"6→\t\tconst [copied, setCopied] = createSignal(false);",
	].join("\n"),
};

/** ToolCard (grep): search hits with a match count footer. */
export const chatGrepTool: ToolItem = {
	kind: "tool",
	id: 4,
	toolCallId: "call_grep_4",
	name: "grep",
	args: { pattern: "language-", path: "apps/web/components", glob: "*.tsx" },
	status: "done",
	output: [
		"apps/web/components/chat/Markdown.tsx:88:\t<code class={`language-${lang}`}>",
		"apps/web/components/chat/CodeBlock.tsx:41:\tconst cls = () => `language-${props.lang}`;",
		"2 matches",
	].join("\n"),
};

/** ToolCard (bash): running build check, streamed output only so far. */
export const chatRunningBashTool: ToolItem = {
	kind: "tool",
	id: 7,
	toolCallId: "call_bash_7",
	name: "bash",
	args: { command: "bun run check:types", timeout: 120 },
	status: "running",
	output: "$ tsc --noEmit -p apps/web\n",
};

/** ToolCard (edit): applied single-hunk edit with an error status variant below. */
export const chatEditTool: ToolItem = {
	kind: "tool",
	id: 6,
	toolCallId: "call_edit_6",
	name: "edit",
	args: {
		path: "apps/web/components/ui/CopyButton.tsx",
		edits: [
			{
				oldText: '\tconst label = copied() ? "copied" : "copy";',
				newText: '\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";',
			},
		],
	},
	status: "done",
	output: "Applied 1 edit to apps/web/components/ui/CopyButton.tsx",
};

/** ToolCard (bash, error): failing test run with a non-zero exit in the output. */
export const chatFailedBashTool: ToolItem = {
	kind: "tool",
	id: 11,
	toolCallId: "call_bash_11",
	name: "bash",
	args: { command: "bun test apps/web/store/review.test.ts" },
	status: "error",
	output: [
		"review.test.ts:\n FAIL  groups annotations by anchor kind",
		"  expected 3 groups, received 2",
		"Ran 14 tests across 1 file. 1 failed.",
	].join("\n"),
};

/** ToolCard (task): delegated subagent call; the child transcript lives in subagents.ts. */
export const chatTaskTool: ToolItem = {
	kind: "tool",
	id: 14,
	toolCallId: "call_task_14",
	name: "task",
	args: {
		agent: "explore",
		description: "Map the chat transcript rendering path",
	},
	status: "done",
	output: "Subagent 0-ChatMap finished: 6 files read, 2 call sites found.",
};

// ---------------------------------------------------------------------------
// Assistant blocks and live streaming text.
// ---------------------------------------------------------------------------

/** ThinkingBlock / AssistantCard: reasoning block folded into the next run. */
export const chatThinking: Block = {
	kind: "thinking",
	text: "The fence renderer lives in Markdown.tsx. Copy must not change the highlight path, so I'll add the button on the wrapper.",
};

/** StreamingBlock (StreamingText): partial text while the turn is still streaming. */
export const chatStreamingBlock: Block = {
	kind: "text",
	text: "Wiring the copy button into `CodeBlock.tsx` so the highlight path stays untouched. The wrapper gets",
};

// ---------------------------------------------------------------------------
// Transcript items: a realistic turn in order.
// ---------------------------------------------------------------------------

/** Transcript / UserCard / AssistantCard / ToolCard / UserCommandCard / CompactionCard / NoticeCard / AdvisorCard: one settled turn. */
export const chatTranscriptItems: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Add a copy-to-clipboard button to the fenced code blocks in the chat transcript.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			chatThinking,
			{
				kind: "text",
				text: "I'll read the existing copy helper and the markdown fence renderer before touching anything.",
			},
		],
		usage,
		ttft: 812,
		duration: 6400,
	},
	chatReadTool,
	chatGrepTool,
	{
		kind: "assistant",
		id: 5,
		blocks: [
			{
				kind: "text",
				text: "`CopyButton` already exists. I'll extend it with a failed state and mount it on the code block wrapper.",
			},
		],
		usage: { input: 9_144, output: 388, cacheRead: 8_960, cacheWrite: 0, totalTokens: 9_532 },
		ttft: 640,
		duration: 3180,
	},
	chatEditTool,
	chatRunningBashTool,
	{
		kind: "notice",
		id: 8,
		level: "info",
		message: "Auto-compaction scheduled at 85% of context window.",
	},
	chatFailedBashTool,
	{
		kind: "user",
		id: 12,
		text: "The failing case is the mixed-anchor group. Fix it without changing the public shape.",
		images: [screenshot],
	},
	chatTaskTool,
];

/** Consolidated tool runs for ToolRunRow (ToolRunRow.tsx:20). Run.key is the id of the first tool in the run. */
export const chatRuns: Run[] = [
	{
		key: 3,
		tools: [chatReadTool, chatGrepTool],
		thinking: [chatThinking],
		consumedAssistantIds: [2],
		turnCount: 1,
		requestCount: 2,
		errorCount: 0,
		durationMs: 6400,
		running: false,
	},
	{
		key: 6,
		tools: [chatEditTool, chatRunningBashTool],
		thinking: [],
		consumedAssistantIds: [5],
		turnCount: 1,
		requestCount: 2,
		errorCount: 0,
		durationMs: 3180,
		running: true,
	},
	{
		key: 11,
		tools: [chatFailedBashTool],
		thinking: [],
		consumedAssistantIds: [],
		turnCount: 0,
		requestCount: 1,
		errorCount: 1,
		durationMs: 0,
		running: false,
	},
];

// ---------------------------------------------------------------------------
// Bash (! and $ shell) cards.
// ---------------------------------------------------------------------------

/** UserCommandCard: completed `!` shell command with exit 0. */
const bashDone: BashItem = {
	kind: "bash",
	id: 20,
	command: "git status --short",
	dimmed: false,
	lang: "bash",
	status: "done",
	output: " M apps/design-system/fixtures/session.ts\n?? apps/design-system/fixtures/chat.ts\n",
	exitCode: 0,
	truncated: false,
};

/** UserCommandCard: running shell command, output still streaming. */
const bashRunning: BashItem = {
	kind: "bash",
	id: 21,
	command: "bun run lint",
	dimmed: false,
	lang: "bash",
	status: "running",
	output: "biome check apps/design-system/fixtures\n",
	exitCode: null,
	truncated: false,
};

/** UserCommandCard: `$$` python item, dimmed because it ran outside the current turn. */
const bashPythonDimmed: BashItem = {
	kind: "bash",
	id: 22,
	command:
		"import json, pathlib; print(len(json.loads(pathlib.Path('package.json').read_text())['dependencies']))",
	dimmed: true,
	lang: "python",
	status: "done",
	output: "14\n",
	exitCode: 0,
	truncated: false,
};

/** UserCommandCard: non-zero exit with output truncated at the viewer cap. */
const bashTruncated: BashItem = {
	kind: "bash",
	id: 23,
	command: "bun test apps/web",
	dimmed: false,
	lang: "bash",
	status: "done",
	output: "... 2,184 lines elided ...\n 1 failed, 1,206 passed",
	exitCode: 1,
	truncated: true,
};

/** UserCommandCard fixtures covering running, done, python, dimmed, and truncated states. */
export const chatBashItems: BashItem[] = [bashDone, bashRunning, bashPythonDimmed, bashTruncated];

// ---------------------------------------------------------------------------
// Compaction cards.
// ---------------------------------------------------------------------------

/** CompactionCard: finished compaction with a summary and token delta. */
const compactDone: CompactionItem = {
	kind: "compaction",
	id: 30,
	action: "compact",
	summary:
		"Kept the CopyButton refactor plan, the failing review test, and the open question about fence languages.",
	tokensBefore: 171_204,
	skipped: false,
	aborted: false,
	willRetry: false,
};

/** CompactionCard: aborted run that will retry on the next turn. */
const compactRetrying: CompactionItem = {
	kind: "compaction",
	id: 31,
	action: "compact",
	skipped: false,
	aborted: true,
	willRetry: true,
	errorMessage: "Provider returned 529 overloaded; retrying in 8s",
};

/** CompactionCard fixtures: completed summary and an aborted retry. */
export const chatCompactionItems: CompactionItem[] = [compactDone, compactRetrying];

// ---------------------------------------------------------------------------
// Advisor, notices, prompt, and autocomplete.
// ---------------------------------------------------------------------------

/** AdvisorCard: batched advisor notes of mixed severity, one from a named advisor. */
export const chatAdvisorItem: AdvisorItem = {
	kind: "advisor",
	id: 40,
	notes: [
		{
			note: "The copy handler writes to the clipboard before checking permission; guard the write.",
			severity: "concern",
			turn: 4,
			turnsAgo: 1,
		},
		{
			note: "Test name says 'groups' but asserts counts; rename or assert the grouping keys.",
			severity: "nit",
			advisor: "reviewer",
			turn: 5,
		},
	],
};

/** NoticeCard: one notice per level, since level is an open string. */
export const chatNoticeItems: Extract<ChatItem, { kind: "notice" }>[] = [
	{ kind: "notice", id: 50, level: "info", message: "Session resumed from 2026-10-08T17:12Z." },
	{ kind: "notice", id: 51, level: "warning", message: "Context is at 84% of the 200k window." },
	{ kind: "notice", id: 52, level: "error", message: "MCP server 'linear' disconnected." },
];

/** PromptBox / QueueBar: text plus a pasted image chip for a queued follow-up. */
export const chatPromptInsert: PromptInsert = {
	text: "Also add a unit test for the failed state.",
	images: [screenshot],
};

/** AutocompletePopup: slash-command suggestions above the prompt textarea. */
export const chatAutocompleteItems: AcItem[] = [
	{ label: "/resume", detail: "Resume a previous session", apply: "/resume " },
	{ label: "/compact", detail: "Summarize and shrink context", apply: "/compact " },
	{ label: "/model", detail: "Switch the active model", apply: "/model " },
	{ label: "/review", detail: "Open the review panel", apply: "/review " },
];

/** PromptHistoryPicker / PromptBox: a recent prompt history with an entry that has no detail. */
export const chatPromptHistory: string[] = [
	"Add a copy-to-clipboard button to the fenced code blocks in the chat transcript.",
	"Run the design-system fixtures check after the rename.",
	"Summarize the open review annotations",
];

/** ChatItem fixtures for a streaming turn: the list a live Transcript renders while the last block is still open. */
export const chatStreamingItems: ChatItem[] = [
	{
		kind: "assistant",
		id: 60,
		blocks: [
			{ kind: "text", text: "Copying the fence to the clipboard uses " },
			chatStreamingBlock,
		],
	},
];

// ---------------------------------------------------------------------------
// Standalone cards: user prompts, assistant answers, advisor blockers.
// ---------------------------------------------------------------------------

/** UserCard: plain prompt typed in the composer. */
export const chatUserItem: Extract<ChatItem, { kind: "user" }> = {
	kind: "user",
	id: 501,
	text: "The queued follow-up never shows the retry badge. Check the queue bar and the review store, then fix it.",
};

/** UserCard: prompt with a pasted type-check screenshot and a 1x1 image chip. */
export const chatUserImagesItem: Extract<ChatItem, { kind: "user" }> = {
	kind: "user",
	id: 502,
	text: "Here is the type error from the review store. Fix the anchor type and keep the public API unchanged.",
	images: [terminalScreenshot, screenshot],
};

/** AssistantCard: settled answer with markdown, a code fence and a table. */
export const chatAssistantItem: Extract<ChatItem, { kind: "assistant" }> = {
	kind: "assistant",
	id: 503,
	blocks: [
		{
			kind: "text",
			text: [
				"The queue bar reads `state.queuedMessageCount`, so the retry badge only checks the active turn. Two changes fix it:",
				"",
				"1. Read the badge from the queued items in `apps/web/components/chat/QueueBar.tsx`.",
				"2. Add a case to `apps/web/test/queue-bar.test.ts` for a retried follow-up.",
				"",
				"```ts",
				"const retrying = state.queue.filter((m) => m.retryable && m.attempts > 0);",
				"```",
				"",
				"| File | Change |",
				"| --- | --- |",
				"| `QueueBar.tsx` | badge reads the queue |",
				"| `queue-bar.test.ts` | new retry case |",
			].join("\n"),
		},
	],
	usage,
	ttft: 820,
	duration: 6400,
};

/** AssistantCard: reasoning block followed by the answer, after a settled turn. */
export const chatAssistantThinkingItem: Extract<ChatItem, { kind: "assistant" }> = {
	kind: "assistant",
	id: 504,
	blocks: [
		{
			kind: "thinking",
			text: "The badge is computed from the active turn only. The queue lives in state.queue, so the fix belongs in the queue bar selector, not the turn store.",
		},
		{
			kind: "text",
			text: "The selector is the right place. I will move the count into `queueRetryCount()`.",
		},
	],
	usage,
	ttft: 1450,
	duration: 3900,
};

/** AssistantCard: answer still streaming (no usage or duration yet). */
export const chatAssistantStreamingItem: Extract<ChatItem, { kind: "assistant" }> = {
	kind: "assistant",
	id: 505,
	blocks: [
		{
			kind: "text",
			text: "Reading the queue bar now. The retry badge is rendered from `queueRetryCount()`, which only counts items whose `attempts` field is greater than zero, so",
		},
	],
};

/** AdvisorCard: a single blocker from a named advisor, one turn after it was emitted. */
export const chatAdvisorBlockerItem: AdvisorItem = {
	kind: "advisor",
	id: 506,
	notes: [
		{
			note: "The migration drops the review_anchor index before the backfill runs. Reorder the steps or the backfill will scan the whole table.",
			severity: "blocker",
			advisor: "migrations",
			turn: 14,
			turnsAgo: 1,
		},
	],
};

/** ToolCard list mixing read, running bash and task renderers in one transcript. */
export const chatToolMixItems: ToolItem[] = [chatReadTool, chatRunningBashTool, chatTaskTool];
