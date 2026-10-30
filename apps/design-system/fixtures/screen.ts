import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AvailableSlashCommand, ImageArg, QueuedMessagesSnapshot } from "#lib/wire/protocol";
import type {
	BashItem,
	Block,
	ChatItem,
	CompactionItem,
	SubagentInfo,
	ToolItem,
	state,
} from "../../web/state";
import type { UsageLike } from "../../web/usage/usage";
import type { AdvisorItem } from "../../web/store/slices/advisor";
import { FIXTURE_NOW } from "./session";
import { rosterAppEntries, rosterProjects } from "./roster";
import { sessionModel } from "./overlays";
import { fenceListScreenshot } from "./screenshot";
import type { AppSessionView } from "./app-sessions";
import {
	editToolItem,
	evalImageTool,
	globDoneTool,
	grepDoneTool,
	lspReferencesTool,
	readDoneTool,
	todoArgsTool,
	webSearchDoneTool,
	writeToolItem,
} from "./tools";

/** Screen fixtures: one coherent coding-agent session on this repo (the CopyButton work). */

// ---------------------------------------------------------------------------
// Session identity: the attached session is `dmn_a002` (design-fixtures, ready) from roster.ts.
// ---------------------------------------------------------------------------

/** Roster id of the session the screen is attached to (the ready, attached row). */
export const SCREEN_WORKSPACE_ID = "dmn_a002";

const MIN = 60_000;

/**
 * The Claude model the screen session runs on; reused by the other App view sessions. It is the
 * catalog's default-role model (overlays.ts), so the model picker, roles and status bar agree.
 */
export const claude: Model = sessionModel;

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

/** The live todo board of the screen session: the change, its test and the checks (the transcript's todo call carries the same plan). */
export const screenTodoPhases: typeof state.todoPhases = [
	{
		name: "Copy button",
		tasks: [
			{ content: "Give CopyButton a title prop", status: "completed" },
			{ content: "Wrap fences and mount the button", status: "in_progress" },
		],
	},
	{
		name: "Checks",
		tasks: [
			{ content: "Tests for the copied feedback and fence text", status: "pending" },
			{ content: "Types check", status: "pending" },
		],
	},
];

/** Per-session store fields of the screen session: restored when the App view attaches to `dmn_a002`. */
export const screenSessionView: AppSessionView = {
	readyAt: FIXTURE_NOW - 22 * MIN,
	sessionId: "sess_09a41c",
	sessionName: "DEMO: Add copy button to code fences",
	sessionFile: screenStats.sessionFile,
	model: claude,
	thinkingLevel: "high" as Effort,
	contextUsage: { tokens: 118_400, contextWindow: 200_000, percent: 59.2 },
	stats: screenStats,
	messageCount: 39,
	todoPhases: screenTodoPhases,
};

/** Store patch describing a ready, attached session with model, context and stats. */
export const screenSessionSeed: Partial<typeof state> = {
	connected: true,
	currentWorkspaceId: SCREEN_WORKSPACE_ID,
	...screenSessionView,
	availableCommands: screenSlashCommands,
	sessionRoster: rosterAppEntries,
	// Only projects with a row in the App roster: the plain-directory projects have none here.
	registeredProjects: rosterProjects.filter((project) =>
		rosterAppEntries.some((entry) => entry.projectId === project.projectId),
	),
	authStatus: "disabled",
};

// ---------------------------------------------------------------------------
// Helpers for the transcript.
// ---------------------------------------------------------------------------

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

/** UsageLike for one assistant turn; totalTokens covers input, output and cache reads. */
export const turnUsage = (input: number, output: number, cacheRead: number): UsageLike => ({
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
		id: "FenceCallers",
		index: 0,
		agent: "scout",
		description: "Find every caller of renderMarkdown",
		status: "done",
		lastUpdate: FIXTURE_NOW - 14 * MIN,
		startedAt: FIXTURE_NOW - 16 * MIN,
		endedAt: FIXTURE_NOW - 14 * MIN - 56_000,
		parentToolCallId: taskTool.toolCallId,
	},
	{
		id: "PreStyles",
		index: 1,
		agent: "scout",
		description: "List CSS rules that style pre blocks",
		status: "done",
		lastUpdate: FIXTURE_NOW - 13 * MIN,
		startedAt: FIXTURE_NOW - 16 * MIN,
		endedAt: FIXTURE_NOW - 14 * MIN + 2_000,
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
				"- `CopyButton` copies whatever its `text` prop holds, so each fence only has to pass its own text",
				"",
				"Plan: wrap each fence in a positioned container (fences nested in lists too), mount `CopyButton` there with the fence text, and give it a `title`.",
			].join("\n"),
		},
	],
	usage: turnUsage(11_870, 388, 11_200),
	ttft: 640,
	duration: 3_180,
};

/** The plan as a todo board: the change, its test and the checks. */
const todoPlan: ToolItem = {
	...todoArgsTool,
	id: 7,
	toolCallId: "call_todo_7",
	args: { phases: screenTodoPhases },
	output: "Updated 2 phases.",
};

/** CopyButton gains a `title` and a shared label helper for the fences. */
const copyButtonEdit: ToolItem = {
	...editToolItem,
	id: 8,
	toolCallId: "call_edit_8",
	args: {
		path: "apps/web/components/ui/CopyButton.tsx",
		old_string: [
			"export const COPY_FEEDBACK_MS = 1200;",
			"",
			"export const CopyButton = (props) => {",
			'\tconst label = copied() ? "copied" : "copy";',
			"\treturn <button>{label}</button>;",
			"};",
		].join("\n"),
		new_string: [
			"export const COPY_FEEDBACK_MS = 1200;",
			"",
			'export const copyLabel = (copied: boolean): string => (copied ? "copied" : "copy");',
			"",
			"export const CopyButton = (props) => {",
			"\tconst label = copyLabel(copied());",
			"\treturn <button title={props.title}>{label}</button>;",
			"};",
		].join("\n"),
	},
	output: "Applied 1 edit to apps/web/components/ui/CopyButton.tsx",
};

/** Who else renders `CopyButton` before its props change. */
const copyButtonRefs: ToolItem = {
	...lspReferencesTool,
	id: 9,
	toolCallId: "call_lsp_9",
	args: {
		action: "references",
		file: "apps/web/components/ui/CopyButton.tsx",
		symbol: "CopyButton",
	},
	output: [
		"apps/web/components/chat/transcript/AssistantCard.tsx:41:6",
		"apps/web/components/chat/transcript/UserCard.tsx:58:7",
		"apps/web/components/chat/tools/ToolCardShell.tsx:112:9",
		"apps/web/components/review/DiffHunk.tsx:77:8",
		"apps/web/components/ui/Markdown.tsx:14:10",
	].join("\n"),
};

const fenceEdit: ToolItem = {
	...editToolItem,
	id: 10,
	toolCallId: "call_edit_10",
	args: {
		path: "apps/web/components/ui/Markdown.tsx",
		old_string: [
			"\tconst html = renderMarkdown(props.text);",
			'\treturn <div class="md" innerHTML={html} />;',
		].join("\n"),
		new_string: [
			"\tconst html = renderMarkdown(props.text);",
			"\tlet host!: HTMLDivElement;",
			'\tcreateEffect(() => host.querySelectorAll("pre").forEach(wrapFence));',
			'\treturn <div ref={host} class="md" innerHTML={html} />;',
		].join("\n"),
	},
	output: "Applied 1 edit to apps/web/components/ui/Markdown.tsx",
};

const testWrite: ToolItem = {
	...writeToolItem,
	id: 11,
	toolCallId: "call_write_11",
	args: {
		path: "apps/web/test/copy-button.test.ts",
		content: [
			'import { describe, expect, test } from "bun:test";',
			'import { COPY_FEEDBACK_MS, copyLabel } from "../components/ui/CopyButton";',
			'import { fenceText } from "../components/ui/Markdown";',
			"",
			'describe("CopyButton", () => {',
			'\ttest("shows copied feedback for 1200ms", () => {',
			"\t\texpect(COPY_FEEDBACK_MS).toBe(1200);",
			'\t\texpect(copyLabel(true)).toBe("copied");',
			"\t});",
			'\ttest("copies the fence text", () => {',
			'\t\tconst pre = document.createElement("pre");',
			'\t\tpre.textContent = "bun run check:types";',
			'\t\texpect(fenceText(pre)).toBe("bun run check:types");',
			"\t});",
			'\ttest("restores the label after the timeout", () => {',
			'\t\texpect(copyLabel(false)).toBe("copy");',
			"\t});",
			"});",
		].join("\n"),
	},
	output: "Wrote 19 lines to apps/web/test/copy-button.test.ts",
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
		"(pass) copies the fence text",
		"(pass) restores the label after the timeout",
		"",
		" 3 pass",
		" 0 fail",
		"Ran 3 tests across 1 file. [164.00ms]",
	].join("\n"),
);

/** Where the copy button sits in a fence whose code scrolls sideways. */
const fenceCornerSearch: ToolItem = {
	...webSearchDoneTool,
	id: 16,
	toolCallId: "call_web_search_16",
	args: { query: "css pin button to corner of horizontally scrolling pre element" },
	output: [
		"position - CSS: https://developer.mozilla.org/en-US/docs/Web/CSS/position",
		"overflow - CSS: https://developer.mozilla.org/en-US/docs/Web/CSS/overflow",
		"Clipboard: writeText() method: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText",
	].join("\n"),
};

/** Bar chart the eval cell prints: where code fences sit in this repo's recorded sessions. */
const fenceParentsChart: ImageArg = {
	type: "image",
	mimeType: "image/svg+xml",
	data: btoa(
		[
			'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240" viewBox="0 0 420 240">',
			'<rect width="420" height="240" fill="#ffffff"/>',
			'<g font-family="sans-serif" font-size="12" fill="#222">',
			'<text x="122" y="26" font-size="14">Code fences by parent element</text>',
			'<rect x="90" y="56" width="280" height="26" fill="#4c78a8"/><text x="10" y="74">top level</text><text x="376" y="74">412</text>',
			'<rect x="90" y="100" width="65" height="26" fill="#4c78a8"/><text x="10" y="118">list item</text><text x="161" y="118">96</text>',
			'<rect x="90" y="144" width="12" height="26" fill="#4c78a8"/><text x="10" y="162">blockquote</text><text x="108" y="162">18</text>',
			'<rect x="90" y="188" width="3" height="26" fill="#4c78a8"/><text x="10" y="206">table cell</text><text x="99" y="206">4</text>',
			"</g></svg>",
		].join(""),
	),
};

/** Counts where fences nest in past sessions, so the wrapper covers more than top-level `<pre>`. */
const fenceParents: ToolItem = {
	...evalImageTool,
	id: 18,
	toolCallId: "call_eval_18",
	args: {
		language: "python",
		code: [
			"import matplotlib.pyplot as plt",
			"from fence_scan import fence_parents  # walks assistant markdown in session logs",
			"counts = fence_parents('~/.omp/sessions/omp-web')",
			"print(counts)",
			"plt.barh(list(counts), list(counts.values()))",
			"plt.title('Code fences by parent element')",
			"plt.show()",
		].join("\n"),
	},
	output: [
		"{'top level': 412, 'list item': 96, 'blockquote': 18, 'table cell': 4}",
		"<Figure size 420x240 with 1 Axes>",
	].join("\n"),
	images: [fenceParentsChart],
};

const summaryNote: ChatItem = {
	kind: "assistant",
	id: 21,
	blocks: [
		{
			kind: "text",
			text: [
				"## Summary",
				"",
				"Code fences now carry a copy button, fences nested in list items included, and each copy confirms with `copied`.",
				"",
				"| File | Change |",
				"| --- | --- |",
				"| `components/ui/CopyButton.tsx` | `copyLabel` helper, `title` prop |",
				"| `components/ui/Markdown.tsx` | wraps each fence in `.code-fence` and mounts the button |",
				"| `styles/chat.css` | pins the button to the fence corner while the code scrolls |",
				"",
				"The wrapper is applied after `DOMPurify.sanitize`, so model HTML stays untrusted:",
				"",
				"```tsx",
				'const fenceText = (pre: HTMLElement): string => pre.textContent ?? "";',
				"",
				"const wrapFence = (pre: HTMLElement): void => {",
				'\tconst host = document.createElement("div");',
				'\thost.className = "code-fence";',
				"\tpre.replaceWith(host);",
				"\thost.append(pre);",
				'\trender(() => <CopyButton text={fenceText(pre)} title="Copy code" />, host);',
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
	images: [fenceListScreenshot],
};

const advisor: AdvisorItem = {
	kind: "advisor",
	id: 26,
	notes: [
		{
			note: "The wrapper re-renders on every markdown update; key it by the fence's text to avoid remounting the copy button mid-stream.",
			severity: "concern",
			advisor: "architect",
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

/** A full settled conversation: prompts, markdown, thinking, every common tool kind, a todo board, subagents, compaction, a notice, bash, advisor. */
export const screenItems: ChatItem[] = [
	userAsk,
	planNote,
	reid(globDoneTool, 3),
	reid(grepDoneTool, 4),
	reid(readDoneTool, 5),
	findingsNote,
	todoPlan,
	copyButtonEdit,
	copyButtonRefs,
	fenceEdit,
	testWrite,
	typeCheckPassed,
	testRun,
	{
		kind: "notice",
		id: 15,
		level: "info",
		message: "Auto-compaction scheduled at 85% of context window.",
	},
	fenceCornerSearch,
	taskTool,
	fenceParents,
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
	copyButtonEdit,
	streamingTypeCheck,
];

/** Open live blocks: reasoning that has finished, then answer text still arriving. */
export const screenLiveBlocks: Block[] = [
	{
		kind: "thinking",
		text: "The check is still running. While it finishes I can draft the test: render a numbered list with two fences and assert each one gets its own copy button that shows `copied` after a click.",
	},
	{
		kind: "text",
		text: "While the type check runs, I'll prepare the test for fences nested in list items. It renders a numbered list with two fences, clicks each button, and expects the label to read `cop",
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
	liveSteered: 0,
	paused: [],
} satisfies QueuedMessagesSnapshot;

/** Queue after a Stop: one steer and one follow-up held, waiting for Resume queue. */
export const screenPausedQueue = {
	steering: [],
	followUp: [],
	liveSteered: 0,
	paused: [
		{
			kind: "steer",
			text: "Use the existing COPY_FEEDBACK_MS constant instead of a new timer",
			imageCount: 0,
		},
		{
			kind: "follow-up",
			text: "Then add a regression test for fences nested inside list items",
			imageCount: 0,
		},
	],
} satisfies {
	steering: string[];
	followUp: string[];
	liveSteered: number;
	paused: Array<{ kind: "steer" | "follow-up"; text: string; imageCount: number }>;
};

/** A long paste of grep hits that trips the composer's fold threshold. */
export const screenLongPaste = Array.from(
	{ length: 24 },
	(_, i) => `apps/web/components/ui/Markdown.tsx:${40 + i}: wrapFence(pre) // candidate ${i + 1}`,
).join("\n");

/** Draft shown in a composer with a pending multi-line message. */
export const screenDraft =
	"Add a regression test for fences nested in list items.\nIt should assert one CopyButton per <pre>, and that each one shows copied after a click.";

/** The pasted screenshot used for the composer's image chip. */
export const screenImage: ImageArg = fenceListScreenshot;
