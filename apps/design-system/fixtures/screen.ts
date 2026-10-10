import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AvailableSlashCommand, ImageArg, ModelInfo } from "#lib/wire/protocol";
import type {
	AdvisorItem,
	BashItem,
	Block,
	ChatItem,
	CompactionItem,
	SubagentInfo,
	ToolItem,
	state,
} from "../../web/state";
import type { UsageLike } from "../../web/usage/usage";
import { FIXTURE_NOW } from "./session";
import { rosterDaemons, rosterProjects } from "./roster";
import { sessionModel } from "./overlays";
import {
	editToolItem,
	evalImageTool,
	globDoneTool,
	grepDoneTool,
	lspReferencesTool,
	readDoneTool,
	todoArgsTool,
	webSearchDoneTool,
} from "./tools";

/** Screen fixtures: one coherent coding-agent session on this repo (the CopyButton work). */

// ---------------------------------------------------------------------------
// Session identity: the attached daemon is `dmn_a002` (design-fixtures, ready) from roster.ts.
// ---------------------------------------------------------------------------

/** Roster id of the daemon the screen is attached to (the ready, attached row). */
export const SCREEN_DAEMON_ID = "dmn_a002";

const MIN = 60_000;

const opusThinking: NonNullable<Model["thinking"]> = {
	mode: "anthropic-adaptive",
	efforts: ["low", "medium", "high", "xhigh"] as Effort[],
};

const claude: Model = {
	id: "claude-opus-4",
	name: "Claude Opus 4",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	identity: { class: "claude", family: "opus" },
	thinking: opusThinking,
	compat: sessionModel.compat,
};

/** ModelInfo list for the model picker in the sidebar and SessionConfigBar. */
export const screenModelInfos: ModelInfo[] = [
	{
		provider: "anthropic",
		id: "claude-opus-4",
		contextWindow: 200_000,
		reasoning: true,
		thinking: opusThinking,
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4",
		contextWindow: 200_000,
		reasoning: true,
		thinking: opusThinking,
	},
];

/** AvailableSlashCommand list: remote commands that join the web-local ones in autocomplete. */
export const screenSlashCommands: AvailableSlashCommand[] = [
	{
		name: "review",
		description: "Review the working tree against the active plan",
		source: "builtin",
	},
	{
		name: "skill:frontend-design",
		description: "Design guidance for web components and layouts",
		source: "skill",
	},
	{ name: "init", description: "Write an AGENTS.md for this repository", source: "builtin" },
];

/** Agent SessionStats mirror shown by the SessionConfigBar cost segment (cost, tokens in and out). */
export const screenStats: SessionStats = {
	sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
	sessionId: "sess_09a41c",
	userMessages: 6,
	assistantMessages: 14,
	toolCalls: 19,
	toolResults: 19,
	totalMessages: 39,
	tokens: {
		input: 148_302,
		output: 9_845,
		reasoning: 3_120,
		cacheRead: 1_204_566,
		cacheWrite: 61_440,
		total: 1_424_153,
	},
	premiumRequests: 0,
	cost: 3.42,
};

/** Store patch describing a ready, attached session with model, context and stats. */
export const screenSessionSeed: Partial<typeof state> = {
	connected: true,
	readyAt: FIXTURE_NOW - 22 * MIN,
	sessionId: "sess_09a41c",
	currentSessionId: SCREEN_DAEMON_ID,
	sessionName: "Copy button for code fences",
	sessionFile: screenStats.sessionFile,
	model: claude,
	thinkingLevel: "high" as Effort,
	contextUsage: { tokens: 118_400, contextWindow: 200_000, percent: 59.2 },
	stats: screenStats,
	messageCount: 39,
	availableModels: screenModelInfos,
	availableCommands: screenSlashCommands,
	daemonRoster: rosterDaemons,
	registeredProjects: rosterProjects,
	authStatus: "disabled",
};

// ---------------------------------------------------------------------------
// Helpers for the transcript.
// ---------------------------------------------------------------------------

const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const screenshot: ImageArg = { type: "image", data: PIXEL_PNG, mimeType: "image/png" };

/** Re-identifies a shared tool fixture so every transcript id and call id stays unique. */
const reid = (item: ToolItem, id: number): ToolItem => ({
	...item,
	id,
	toolCallId: `call_${item.name}_${id}`,
});

const bashTool = (
	id: number,
	status: ToolItem["status"],
	command: string,
	output: string,
): ToolItem => ({
	kind: "tool",
	id,
	toolCallId: `call_bash_${id}`,
	name: "bash",
	args: { command },
	status,
	output,
});

const turnUsage = (input: number, output: number, cacheRead: number): UsageLike => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
});

const thinking: Block = {
	kind: "thinking",
	text: "The fence renderer lives in the markdown module. CopyButton already handles clipboard feedback, so the least invasive change is to wrap each <pre> in a positioned container and mount the existing button there instead of adding a second clipboard path.",
};

// ---------------------------------------------------------------------------
// The task tool and its subagents.
// ---------------------------------------------------------------------------

const taskTool: ToolItem = {
	kind: "tool",
	id: 17,
	toolCallId: "call_task_17",
	name: "task",
	args: { description: "Check fence rendering call sites" },
	status: "done",
	output: "2 agents finished.",
};

/** SubagentInfo list for the task tool card, keyed to the task item's toolCallId. */
export const screenSubagents: SubagentInfo[] = [
	{
		id: "sub-fences-1",
		index: 0,
		agent: "scout",
		description: "Find every caller of renderMarkdown",
		status: "done",
		lastUpdate: FIXTURE_NOW - 14 * MIN,
		parentToolCallId: taskTool.toolCallId,
	},
	{
		id: "sub-fences-2",
		index: 1,
		agent: "scout",
		description: "List CSS rules that style pre blocks",
		status: "done",
		lastUpdate: FIXTURE_NOW - 13 * MIN,
		parentToolCallId: taskTool.toolCallId,
	},
];

/** state.subagents patch for the task card. Keys are dynamic subagent ids, so a Map is the store's shape. */
export const screenSubagentMap: typeof state.subagents = new Map<string, SubagentInfo>(
	screenSubagents.map((info): [string, SubagentInfo] => [info.id, info]),
);

// ---------------------------------------------------------------------------
// Transcript pieces.
// ---------------------------------------------------------------------------

const userAsk: ChatItem = {
	kind: "user",
	id: 1,
	text: "Fenced code blocks in the chat transcript need a copy button. Reuse `CopyButton` if it fits, keep the feedback timing the same, and run the types check at the end.",
};

const planNote: ChatItem = {
	kind: "assistant",
	id: 2,
	blocks: [
		thinking,
		{
			kind: "text",
			text: "I'll look for how `CopyButton` is used today and where fences are rendered, then plan the change.",
		},
	],
	usage: turnUsage(9_144, 412, 8_960),
	ttft: 812,
	duration: 6_400,
};

const findingsNote: ChatItem = {
	kind: "assistant",
	id: 6,
	blocks: [
		{
			kind: "text",
			text: [
				"`CopyButton` already exists and is used in the transcript view. Findings:",
				"",
				"- the button owns its own 1200 ms feedback timer (`COPY_FEEDBACK_MS`)",
				"- fences are rendered as bare `<pre><code>` by the markdown pipeline, so nothing wraps them",
				"- there is **no failed state** when the clipboard write is rejected",
				"",
				"Plan: wrap each fence in a positioned container, mount `CopyButton` there, and add a `failed` label.",
			].join("\n"),
		},
	],
	usage: turnUsage(11_870, 388, 11_200),
	ttft: 640,
	duration: 3_180,
};

const typeCheckFailed = bashTool(
	10,
	"error",
	"bun run check:types",
	[
		"$ tsgo --noEmit -p tsconfig.json",
		"apps/web/components/ui/CopyButton.tsx(21,9): error TS2304: Cannot find name 'failed'.",
		"apps/web/components/ui/CopyButton.tsx(21,35): error TS2304: Cannot find name 'setFailed'.",
		"Found 2 errors in 1 file.",
		"exit code 2",
	].join("\n"),
);

const fixNote: ChatItem = {
	kind: "assistant",
	id: 11,
	blocks: [
		{
			kind: "text",
			text: "Two missing declarations: I referenced the `failed` signal before creating it. Adding it next to `copied`.",
		},
	],
	usage: turnUsage(13_042, 214, 12_800),
	ttft: 590,
	duration: 2_240,
};

const typeCheckPassed = bashTool(
	13,
	"done",
	"bun run check:types",
	["$ tsgo --noEmit -p tsconfig.json", "Found 0 errors."].join("\n"),
);

const testRun = bashTool(
	14,
	"done",
	"bun scripts/test.ts apps/web/test/copy-button.test.ts",
	[
		"apps/web/test/copy-button.test.ts:",
		"(pass) shows copied feedback for 1200ms",
		"(pass) shows failed when the clipboard rejects",
		"(pass) restores the label after the timeout",
		"",
		" 3 pass",
		" 0 fail",
		"Ran 3 tests across 1 file. [164.00ms]",
	].join("\n"),
);

const summaryNote: ChatItem = {
	kind: "assistant",
	id: 21,
	blocks: [
		{
			kind: "text",
			text: [
				"## Summary",
				"",
				"Code fences now carry a copy button, and `CopyButton` reports a failed write.",
				"",
				"| File | Change |",
				"| --- | --- |",
				"| `components/ui/CopyButton.tsx` | `failed` state, `title` prop |",
				"| `components/ui/Markdown.tsx` | wraps each fence in `.code-fence` and mounts the button |",
				"| `styles/chat.css` | positions the button in the fence corner |",
				"",
				"The wrapper is applied after `DOMPurify.sanitize`, so model HTML stays untrusted:",
				"",
				"```tsx",
				"const wrapFence = (pre: HTMLElement): void => {",
				'\tconst host = document.createElement("div");',
				'\thost.className = "code-fence";',
				"\tpre.replaceWith(host);",
				"\thost.append(pre);",
				'\trender(() => <CopyButton text={pre.textContent ?? ""} />, host);',
				"};",
				"```",
				"",
				"Types are clean and the three new tests pass. I did not touch the transcript (`tx`) view.",
			].join("\n"),
		},
	],
	usage: turnUsage(16_220, 902, 15_400),
	ttft: 701,
	duration: 9_870,
};

const userBash: BashItem = {
	kind: "bash",
	id: 23,
	command: "git status --short",
	dimmed: false,
	lang: "bash",
	status: "done",
	output: [
		" M apps/web/components/ui/CopyButton.tsx",
		" M apps/web/components/ui/Markdown.tsx",
		" M apps/web/styles/chat.css",
		"?? apps/web/test/copy-button.test.ts",
	].join("\n"),
	exitCode: 0,
	truncated: false,
};

const compaction: CompactionItem = {
	kind: "compaction",
	id: 24,
	action: "compact",
	summary:
		"Kept the CopyButton plan, the fence wrapper approach, the passing type check, and the open question about nested fences in lists.",
	tokensBefore: 171_204,
	skipped: false,
	aborted: false,
	willRetry: false,
};

const followUp: ChatItem = {
	kind: "user",
	id: 25,
	text: "Nice. Does the button show up for fences inside list items too? Here is how it looks for me right now:",
	images: [screenshot],
};

const advisor: AdvisorItem = {
	kind: "advisor",
	id: 26,
	notes: [
		{
			note: "The wrapper re-renders on every markdown update; key it by the fence's text to avoid remounting the copy button mid-stream.",
			severity: "concern",
			turn: 6,
			turnsAgo: 1,
		},
		{
			note: "`title` falls back to the label when unset; consider an aria-label for icon-only layouts.",
			severity: "nit",
			advisor: "reviewer",
			turn: 6,
		},
	],
};

const answerNote: ChatItem = {
	kind: "assistant",
	id: 27,
	blocks: [
		{
			kind: "text",
			text: "Yes: the wrapper runs on every `<pre>` under the sanitized fragment, so fences nested in lists get the button too. I'll add a regression test and take the advisor's keying note.",
		},
	],
	usage: turnUsage(5_110, 176, 4_900),
	ttft: 455,
	duration: 1_980,
};

/** A full settled conversation: prompts, markdown, thinking, every common tool kind, compaction, notice, bash, advisor. */
export const screenItems: ChatItem[] = [
	userAsk,
	planNote,
	reid(globDoneTool, 3),
	reid(grepDoneTool, 4),
	reid(readDoneTool, 5),
	findingsNote,
	reid(todoArgsTool, 7),
	reid(editToolItem, 8),
	reid(lspReferencesTool, 9),
	typeCheckFailed,
	fixNote,
	reid(editToolItem, 12),
	typeCheckPassed,
	testRun,
	{
		kind: "notice",
		id: 15,
		level: "info",
		message: "Auto-compaction scheduled at 85% of context window.",
	},
	reid(webSearchDoneTool, 16),
	taskTool,
	reid(evalImageTool, 18),
	{ kind: "notice", id: 19, level: "warning", message: "Context is at 59% of the 200k window." },
	{ kind: "notice", id: 20, level: "error", message: "MCP server 'linear' disconnected." },
	summaryNote,
	userBash,
	compaction,
	followUp,
	advisor,
	answerNote,
];

// ---------------------------------------------------------------------------
// Streaming turn.
// ---------------------------------------------------------------------------

const streamingTypeCheck: ToolItem = bashTool(
	6,
	"running",
	"bun run check:types",
	["$ tsgo --noEmit -p tsconfig.json", "checking apps/web ..."].join("\n"),
);

/** Transcript before the live block: a prompt, an assistant note and a type check still running. */
export const screenStreamingItems: ChatItem[] = [
	userAsk,
	planNote,
	reid(readDoneTool, 3),
	reid(grepDoneTool, 4),
	{
		kind: "assistant",
		id: 5,
		blocks: [
			{
				kind: "text",
				text: "I'll wrap each fence in a container and mount `CopyButton` there, then run the types check.",
			},
		],
		usage: turnUsage(10_220, 301, 9_600),
		ttft: 598,
		duration: 2_410,
	},
	reid(editToolItem, 8),
	streamingTypeCheck,
];

/** Open live blocks: reasoning that has finished, then answer text still arriving. */
export const screenLiveBlocks: Block[] = [
	{
		kind: "thinking",
		text: "The check is still running. While it finishes I can draft the test: render CopyButton with a rejecting clipboard stub and assert the `failed` label appears.",
	},
	{
		kind: "text",
		text: "While the type check runs, I'll prepare the regression test for the **failed** state. It stubs `navigator.clipboard.writeText` to reject, clicks the button, and expects the label to read `fai",
	},
];

/** Working label that tracks the latest tool intent while a turn streams. */
export const screenWorkingIntent = "Running the types check";

// ---------------------------------------------------------------------------
// Queue and prompt.
// ---------------------------------------------------------------------------

/** Queued messages answered for `getQueuedMessages`: one steer, two follow-ups. */
export const screenQueuedMessages = {
	steering: ["Use the existing COPY_FEEDBACK_MS constant instead of a new timer"],
	followUp: [
		"Then add a regression test for fences nested inside list items",
		"After that, update docs/web-ui.md with the new copy affordance and a screenshot of the fence corner position",
	],
} satisfies { steering: string[]; followUp: string[] };

/** A long paste of grep hits that trips the composer's fold threshold. */
export const screenLongPaste = Array.from(
	{ length: 24 },
	(_, i) => `apps/web/components/ui/Markdown.tsx:${40 + i}: wrapFence(pre) // candidate ${i + 1}`,
).join("\n");

/** Draft shown in a composer with a pending multi-line message. */
export const screenDraft =
	"Add a regression test for fences nested in list items.\nIt should assert one CopyButton per <pre>, and that a rejected clipboard write shows the failed label.";

/** The pasted screenshot used for the composer's image chip. */
export const screenImage: ImageArg = screenshot;
