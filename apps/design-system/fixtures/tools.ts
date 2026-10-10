import type { ImageArg } from "#lib/wire/protocol";
import type { SubagentInfo, ToolItem, state } from "../../web/state";
import { FIXTURE_NOW } from "./session";

/** Tool item defaults; every fixture overrides what it needs. */
const base = { kind: "tool", status: "done", output: "" } as const;

/** Single-edit diff: the replacement path DiffToolCard renders through buildDiffRows. */
export const editToolItem: ToolItem = {
	...base,
	id: 1,
	toolCallId: "call_edit_1",
	name: "edit",
	args: {
		path: "apps/web/components/ui/CopyButton.tsx",
		edits: [
			{
				oldText: [
					"export const COPY_FEEDBACK_MS = 1200;",
					"",
					"export const CopyButton = (props) => {",
					'\tconst label = copied() ? "copied" : "copy";',
					"\treturn <button>{label}</button>;",
					"};",
				].join("\n"),
				newText: [
					"export const COPY_FEEDBACK_MS = 1200;",
					"",
					"export const CopyButton = (props) => {",
					'\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";',
					"\treturn <button title={props.title}>{label}</button>;",
					"};",
				].join("\n"),
			},
		],
	},
	output: "Applied 1 edit to apps/web/components/ui/CopyButton.tsx",
};

/** New-file write: numbered content preview with the collapse affordance. */
export const writeToolItem: ToolItem = {
	...base,
	id: 2,
	toolCallId: "call_write_1",
	name: "write",
	args: {
		path: "docs/notes/retry-policy.md",
		content: [
			"# Retry policy",
			"",
			"Transient provider errors retry with exponential backoff.",
			"",
			"- attempt 1: 2s",
			"- attempt 2: 4s",
			"- attempt 3: 8s",
		].join("\n"),
	},
	output: "Wrote 7 lines to docs/notes/retry-policy.md",
};

/** In-flight edit, so the card renders its running status. */
export const runningEditToolItem: ToolItem = {
	...editToolItem,
	id: 3,
	toolCallId: "call_edit_2",
	status: "running",
	output: "",
};

/** Malformed args: DiffToolCard falls back to the generic card. */
export const malformedEditToolItem: ToolItem = {
	...base,
	id: 4,
	toolCallId: "call_edit_3",
	name: "edit",
	args: { path: 42 },
	status: "error",
	output: "edit failed: path must be a string",
};

// ---------------------------------------------------------------------------
// Images. Real, self-contained SVG payloads so thumbnails and the full-size
// overlay show something meaningful without shipping binary assets.
// ---------------------------------------------------------------------------

const svgImage = (svg: string): ImageArg => ({
	type: "image",
	data: btoa(svg),
	mimeType: "image/svg+xml",
});

/** ImageArg: terminal screenshot of a passing type check, as a user would paste it. */
export const terminalScreenshot: ImageArg = svgImage(
	[
		'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">',
		'<rect width="480" height="270" rx="8" fill="#14161b"/>',
		'<circle cx="20" cy="20" r="6" fill="#ff5f56"/><circle cx="40" cy="20" r="6" fill="#ffbd2e"/><circle cx="60" cy="20" r="6" fill="#27c93f"/>',
		'<g font-family="monospace" font-size="14" fill="#c9d1d9">',
		'<text x="20" y="62">$ bun run check:types</text>',
		'<text x="20" y="88" fill="#8b949e">tsgo --noEmit -p tsconfig.json</text>',
		'<text x="20" y="130" fill="#f85149">apps/web/store/review.ts(212,9): error TS2322</text>',
		'<text x="20" y="152" fill="#8b949e">  Type &apos;string | undefined&apos; is not assignable</text>',
		'<text x="20" y="174" fill="#8b949e">  to type &apos;string&apos;.</text>',
		'<text x="20" y="216" fill="#f85149">Found 1 error in 1 file.</text>',
		"</g></svg>",
	].join(""),
);

/** ImageArg: bar chart rendered by an eval cell (matplotlib-style display output). */
export const chartImage: ImageArg = svgImage(
	[
		'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240" viewBox="0 0 420 240">',
		'<rect width="420" height="240" fill="#ffffff"/>',
		'<g font-family="sans-serif" font-size="12" fill="#222">',
		'<text x="150" y="22" font-size="14">Components per directory</text>',
		'<rect x="40" y="60" width="150" height="24" fill="#4c78a8"/><text x="196" y="77">chat 17</text>',
		'<rect x="40" y="94" width="120" height="24" fill="#4c78a8"/><text x="166" y="111">overlays 14</text>',
		'<rect x="40" y="128" width="96" height="24" fill="#4c78a8"/><text x="142" y="145">shared 11</text>',
		'<rect x="40" y="162" width="72" height="24" fill="#4c78a8"/><text x="118" y="179">tx 8</text>',
		'<rect x="40" y="196" width="48" height="24" fill="#4c78a8"/><text x="94" y="213">fleet-ui 5</text>',
		"</g></svg>",
	].join(""),
);

// ---------------------------------------------------------------------------
// Per-card fixtures. ids start at 100 so they never collide with the diff
// fixtures above or the transcript fixtures in chat.ts.
// ---------------------------------------------------------------------------

let nextId = 100;

/** Typed ToolItem factory; ids and call ids are assigned in declaration order. */
function tool(
	name: string,
	status: ToolItem["status"],
	args: unknown,
	output: string,
	images?: ImageArg[],
): ToolItem {
	const id = nextId++;
	return {
		kind: "tool",
		id,
		toolCallId: `call_${name}_${id}`,
		name,
		args,
		status,
		output,
		...(images ? { images } : {}),
	};
}

/** Joins lines the way a tool result carries them. */
const lines = (...rows: string[]): string => rows.join("\n");

// ask
const askArgs = {
	questions: [
		{
			id: "retry-scope",
			question: "Should the retry badge also appear on queued follow-up messages?",
			options: [{ label: "Only the active turn" }, { label: "Active turn and queue" }],
		},
	],
};
/** AskToolCard: question posed, waiting for the user's answer. */
export const askRunningTool: ToolItem = tool("ask", "running", askArgs, "");
/** AskToolCard: answered question. */
export const askDoneTool: ToolItem = tool(
	"ask",
	"done",
	askArgs,
	"Selected: Active turn and queue",
);
/** AskToolCard: dismissed question. */
export const askErrorTool: ToolItem = tool(
	"ask",
	"error",
	askArgs,
	"Question dismissed without an answer.",
);

// bash
/** BashToolCard: type check still compiling. */
export const bashRunningTool: ToolItem = tool(
	"bash",
	"running",
	{ command: "bun run check:types", timeout: 120 },
	lines("$ tsgo --noEmit -p tsconfig.json", "checking apps/web ..."),
);
/** BashToolCard: short successful command. */
export const bashDoneTool: ToolItem = tool(
	"bash",
	"done",
	{ command: "git status --short" },
	lines(
		" M apps/web/components/ui/CopyButton.tsx",
		" M apps/web/styles/chat.css",
		"?? apps/design-system/stories/copy-button.tsx",
	),
);
/** BashToolCard: failing test run. */
export const bashErrorTool: ToolItem = tool(
	"bash",
	"error",
	{ command: "bun scripts/test.ts apps/web/test/review.test.ts" },
	lines(
		"apps/web/test/review.test.ts:",
		"(pass) groups annotations by file",
		"(fail) groups annotations by anchor kind",
		"  error: expect(received).toHaveLength(expected)",
		"  Expected length: 3",
		"  Received length: 2",
		"      at <anonymous> (apps/web/test/review.test.ts:88:34)",
		"",
		" 13 pass",
		" 1 fail",
		"Ran 14 tests across 1 file. [212.00ms]",
		"exit code 1",
	),
);
/** BashToolCard: 46 lines of lint output, so the tail collapse note shows. */
export const bashLongTool: ToolItem = tool(
	"bash",
	"done",
	{ command: "bun run lint" },
	lines(
		"$ bun scripts/check-boundaries.ts && oxlint",
		...Array.from(
			{ length: 44 },
			(_, i) =>
				`checked apps/web/components/${["chat", "overlays", "shared", "fleet-ui"][i % 4]}/File${i + 1}.tsx`,
		),
		"Found 0 warnings and 0 errors.",
	),
);

// eval
/** EvalToolCard: python cell running with partial output. */
export const evalRunningTool: ToolItem = tool(
	"eval",
	"running",
	{
		language: "python",
		code: lines(
			"import pathlib",
			"files = sorted(pathlib.Path('apps/web/components').rglob('*.tsx'))",
			"for f in files[:3]:",
			"    print(f, f.stat().st_size)",
		),
	},
	"apps/web/components/app/NoActiveSessionPane.tsx 612\n",
);
/** EvalToolCard: completed python cell. */
export const evalDoneTool: ToolItem = tool(
	"eval",
	"done",
	{
		language: "python",
		code: lines(
			"import json",
			"pkg = json.load(open('package.json'))",
			"print(len(pkg['dependencies']), 'dependencies')",
		),
	},
	"14 dependencies",
);
/** EvalToolCard: JavaScript cell that throws. */
export const evalErrorTool: ToolItem = tool(
	"eval",
	"error",
	{
		language: "js",
		code: lines(
			"const pkg = JSON.parse(await Bun.file('package.jsn').text());",
			"console.log(Object.keys(pkg.dependencies).length);",
		),
	},
	lines(
		"ENOENT: no such file or directory, open 'package.jsn'",
		"    at readFile (node:fs/promises:603:18)",
		"    at <eval> (cell-1:1:28)",
	),
);
/** EvalToolCard: cell that displays a chart image next to its text output. */
export const evalImageTool: ToolItem = tool(
	"eval",
	"done",
	{
		language: "python",
		code: lines(
			"import matplotlib.pyplot as plt",
			"plt.barh(names, counts)",
			"plt.title('Components per directory')",
			"plt.show()",
		),
	},
	"<Figure size 420x240 with 1 Axes>",
	[chartImage],
);

// generic (no dedicated renderer)
const issueArgs = { team: "OMP", state: "In Progress", limit: 3 };
/** GenericToolCard: finished MCP tool call with JSON output. */
export const genericDoneTool: ToolItem = tool(
	"mcp_linear_list_issues",
	"done",
	issueArgs,
	lines(
		"[",
		'  { "id": "OMP-412", "title": "Retry badge for queued follow-ups", "assignee": "joshua" },',
		'  { "id": "OMP-409", "title": "Fleet sidebar loses focus on reconnect", "assignee": "mira" },',
		'  { "id": "OMP-401", "title": "Stats modal overflows at 720px", "assignee": null }',
		"]",
	),
);
/** GenericToolCard: call in flight (details stay open while running). */
export const genericRunningTool: ToolItem = tool(
	"mcp_linear_list_issues",
	"running",
	issueArgs,
	"",
);
/** GenericToolCard: call that failed. */
export const genericErrorTool: ToolItem = tool(
	"mcp_linear_list_issues",
	"error",
	issueArgs,
	"MCP error -32001: request timed out after 30000ms (server 'linear' is reconnecting)",
);
/** GenericToolCard: 60 lines of output in one pre. */
export const genericLongTool: ToolItem = tool(
	"mcp_linear_list_issues",
	"done",
	{ ...issueArgs, limit: 60 },
	lines(
		...Array.from(
			{ length: 60 },
			(_, i) => `OMP-${400 + i}\t${["Todo", "In Progress", "Done"][i % 3]}\tPolish pass ${i + 1}`,
		),
	),
);
/** GenericToolCard: a result that carries a screenshot. */
export const genericImageTool: ToolItem = tool(
	"screenshot",
	"done",
	{ target: "window", display: 0 },
	"Captured 480x270 screenshot",
	[terminalScreenshot],
);

// hub
/** HubToolCard: message sent to a peer. */
export const hubSendTool: ToolItem = tool(
	"hub",
	"done",
	{
		op: "send",
		to: "ChatScreenStories",
		message:
			"fixtures/chat.ts now exports chatBashItems; rebase before editing the transcript story.",
	},
	"Delivered to ChatScreenStories",
);
/** HubToolCard: waiting for a peer reply. */
export const hubWaitTool: ToolItem = tool(
	"hub",
	"running",
	{ op: "wait", from: "RosterSubagentStories", timeout: 60 },
	"",
);
/** HubToolCard: poll that returned a reply. */
export const hubPollTool: ToolItem = tool(
	"hub",
	"done",
	{ op: "poll", name: "SharedStories" },
	lines("From SharedStories:", "Modal stories need tabs: true."),
);
/** HubToolCard: send to a peer that is gone. */
export const hubErrorTool: ToolItem = tool(
	"hub",
	"error",
	{ op: "send", to: "TxStories", message: "Is routes.ts free to edit?" },
	"Peer 'TxStories' is not registered.",
);

// lsp
/** LspToolCard: definition lookup. */
export const lspDefinitionTool: ToolItem = tool(
	"lsp",
	"done",
	{
		action: "definition",
		file: "apps/web/components/chat/transcript/cards/UserCard.tsx",
		symbol: "branchFromCard",
	},
	"apps/web/store/graph.ts:281:14  export async function branchFromCard(args: BranchCardArgs)",
);
/** LspToolCard: in-flight reference search. */
export const lspRunningTool: ToolItem = tool(
	"lsp",
	"running",
	{ action: "references", file: "apps/web/state.ts", symbol: "pushNotice" },
	"",
);
/** LspToolCard: 30 reference hits so the capped body shows its note. */
export const lspReferencesTool: ToolItem = tool(
	"lsp",
	"done",
	{ action: "references", file: "apps/web/state.ts", symbol: "pushNotice" },
	lines(
		...Array.from({ length: 30 }, (_, i) => {
			const dir = ["chat", "overlays", "fleet-ui"][i % 3];
			return `apps/web/components/${dir}/Component${i + 1}.tsx:${20 + i * 3}:9`;
		}),
	),
);
/** LspToolCard: diagnostics with errors. */
export const lspDiagnosticsTool: ToolItem = tool(
	"lsp",
	"error",
	{ action: "diagnostics", file: "apps/web/store/review.ts" },
	lines(
		"apps/web/store/review.ts:212:9 error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
		"apps/web/store/review.ts:240:5 error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
	),
);

// read
const copyButtonSource = [
	'import { createSignal, type Component } from "solid-js";',
	'import { copyText } from "../../text/clipboard";',
	'import { CheckIcon, CopyIcon } from "./icons";',
	"",
	"export const COPY_FEEDBACK_MS = 1200;",
	"",
	"interface CopyButtonProps {",
	"\ttext: () => string;",
	"\tclass?: string;",
	"\ttitle?: string;",
	"}",
	"",
	"/** Icon button that copies text and flashes a check mark. */",
	"export const CopyButton: Component<CopyButtonProps> = (props) => {",
	"\tconst [copied, setCopied] = createSignal(false);",
	"\tconst onClick = async () => {",
	"\t\tawait copyText(props.text());",
	"\t\tsetCopied(true);",
	"\t\tsetTimeout(() => setCopied(false), COPY_FEEDBACK_MS);",
	"\t};",
	"\treturn (",
	"\t\t<button class={props.class} title={props.title} onClick={onClick}>",
	"\t\t\t{copied() ? <CheckIcon /> : <CopyIcon />}",
	"\t\t</button>",
	"\t);",
	"};",
];
const numbered = (rows: string[], from: number): string =>
	rows.map((row, i) => `${from + i}→${row}`).join("\n");
/** ReadToolCard: short excerpt with the tool's own line numbers. */
export const readDoneTool: ToolItem = tool(
	"read",
	"done",
	{ path: "apps/web/components/ui/CopyButton.tsx", offset: 1, limit: 12 },
	numbered(copyButtonSource.slice(0, 12), 1),
);
/** ReadToolCard: read still in flight, so no body yet. */
export const readRunningTool: ToolItem = tool(
	"read",
	"running",
	{ path: "apps/web/components/ui/CopyButton.tsx" },
	"",
);
/** ReadToolCard: whole 26-line file starting mid-file, collapsed past 20 lines. */
export const readLongTool: ToolItem = tool(
	"read",
	"done",
	{ path: "apps/web/components/ui/CopyButton.tsx", offset: 40 },
	numbered(copyButtonSource, 40),
);
/** ReadToolCard: missing file. */
export const readErrorTool: ToolItem = tool(
	"read",
	"error",
	{ path: "apps/web/components/ui/CopyBtn.tsx" },
	"ENOENT: no such file or directory, open 'apps/web/components/ui/CopyBtn.tsx'",
);

// grep / glob
/** SearchToolCard: grep with path:line hits. */
export const grepDoneTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "COPY_FEEDBACK_MS", path: "apps/web" },
	lines(
		"apps/web/components/ui/CopyButton.tsx:5:export const COPY_FEEDBACK_MS = 1200;",
		"apps/web/components/ui/CopyButton.tsx:20:\t\tsetTimeout(() => setCopied(false), COPY_FEEDBACK_MS);",
		'apps/web/components/tx/TxMessage.tsx:14:import { COPY_FEEDBACK_MS } from "../shared/CopyButton";',
	),
);
/** SearchToolCard: glob listing plain paths. */
export const globDoneTool: ToolItem = tool(
	"glob",
	"done",
	{ glob: "apps/web/components/chat/tools/*.tsx" },
	lines(
		"apps/web/components/chat/tools/AskToolCard.tsx",
		"apps/web/components/chat/tools/BashToolCard.tsx",
		"apps/web/components/chat/tools/DiffToolCard.tsx",
		"apps/web/components/chat/tools/EvalToolCard.tsx",
		"apps/web/components/chat/tools/GenericToolCard.tsx",
		"apps/web/components/chat/tools/HubToolCard.tsx",
	),
);
/** SearchToolCard: search in flight with no results yet. */
export const grepRunningTool: ToolItem = tool(
	"grep",
	"running",
	{ pattern: "createStore", path: "apps/web" },
	"",
);
/** SearchToolCard: invalid pattern. */
export const grepErrorTool: ToolItem = tool(
	"grep",
	"error",
	{ pattern: "(unclosed", path: "apps/web" },
	"regex parse error: unclosed group",
);
/** SearchToolCard: 40 hits so the result body scrolls. */
export const grepLongTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "state\\.", path: "apps/web/components", glob: "*.tsx" },
	lines(
		...Array.from({ length: 40 }, (_, i) => {
			const file = [
				"chat/SessionConfigBar",
				"chat/MessageList",
				"overlays/SessionStatsDialog",
				"fleet-ui/FleetSidebar",
			][i % 4];
			return `apps/web/components/${file}.tsx:${12 + i * 7}:\tconst value = () => state.field${i}();`;
		}),
	),
);

// task
/** TaskToolCard: delegated call with three subagents, one running. */
export const taskRunningTool: ToolItem = tool(
	"task",
	"running",
	{ description: "Write stories for the tool cards" },
	"",
);
/** TaskToolCard: finished call. */
export const taskDoneTool: ToolItem = tool(
	"task",
	"done",
	{ description: "Map the chat transcript rendering path" },
	"2 agents finished.",
);
/** TaskToolCard: call whose subagent failed. */
export const taskErrorTool: ToolItem = tool(
	"task",
	"error",
	{ description: "Migrate the review store to the new anchors" },
	"Subagent Ines failed: tests did not pass.",
);
/** TaskToolCard: call that has not yet spawned a subagent. */
export const taskPendingTool: ToolItem = tool(
	"task",
	"running",
	{ description: "Audit CSS for unused selectors" },
	"",
);

const sub = (
	parent: ToolItem,
	index: number,
	id: string,
	agent: string,
	description: string,
	status: string,
	agoMs: number,
): SubagentInfo => ({
	id,
	index,
	agent,
	description,
	status,
	lastUpdate: FIXTURE_NOW - agoMs,
	parentToolCallId: parent.toolCallId,
});

/** SubagentInfo list keyed by parent tool call: running, done and failed spawns. */
export const taskSubagents: SubagentInfo[] = [
	sub(
		taskRunningTool,
		0,
		"Anna",
		"task",
		"Stories for AskToolCard, BashToolCard, EvalToolCard",
		"running",
		4_000,
	),
	sub(taskRunningTool, 1, "Bram", "task", "Stories for chat cards", "running", 9_000),
	sub(taskRunningTool, 2, "Cleo", "scout", "Map component props", "completed", 62_000),
	sub(taskDoneTool, 0, "Dara", "scout", "Find MessageList call sites", "completed", 120_000),
	sub(taskDoneTool, 1, "Eli", "scout", "Read the chat store", "completed", 118_000),
	sub(taskErrorTool, 0, "Ines", "task", "Move annotations to anchor groups", "failed", 30_000),
];

/** state.subagents patch: the Map TaskToolCard filters by parentToolCallId. */
export const taskSubagentMap: typeof state.subagents = new Map(
	taskSubagents.map((info) => [info.id, info]),
);

// todo
/** TodoToolCard: args carry phases; used when the live board is empty. */
export const todoArgsTool: ToolItem = tool(
	"todo",
	"done",
	{
		phases: [
			{
				name: "Fixtures",
				tasks: [
					{ content: "Add typed ToolItem factory", status: "completed" },
					{ content: "Write long-output fixtures", status: "in_progress" },
				],
			},
			{
				name: "Stories",
				tasks: [
					{ content: "Tool card stories", status: "pending" },
					{ content: "Chat card stories", status: "pending" },
					{ content: "Retired streaming demo", status: "abandoned" },
				],
			},
		],
	},
	"Updated 2 phases.",
);
/** TodoToolCard: flat items form of the args. */
export const todoItemsTool: ToolItem = tool(
	"todo",
	"done",
	{
		items: [
			{ content: "Reproduce the failing review test", status: "completed" },
			{ content: "Fix anchor grouping", status: "in_progress" },
			{ content: "Wait for design review", status: "blocked" },
		],
	},
	"Updated todos.",
);
/** TodoToolCard: args with no recognised shape and no live board. */
export const todoEmptyTool: ToolItem = tool("todo", "done", {}, "");
/** state.todoPhases patch: the live board wins over the call's own args. */
export const liveTodoPhases: typeof state.todoPhases = [
	{
		name: "Design system",
		tasks: [
			{ content: "Inventory components", status: "completed" },
			{
				content: "Write story fixtures",
				status: "in_progress",
				notes: ["tools.ts and chat.ts first"],
			},
			{ content: "Verify in the browser", status: "pending" },
			{ content: "Wire the coverage page", status: "blocked", blocker: "waiting on SharedStories" },
		],
	},
];

// web_search
const searchArgs = { query: "solid-js createStore reconcile keyed arrays" };
/** WebSearchToolCard: search in flight. */
export const webSearchRunningTool: ToolItem = tool("web_search", "running", searchArgs, "");
/** WebSearchToolCard: result with a link list. */
export const webSearchDoneTool: ToolItem = tool(
	"web_search",
	"done",
	searchArgs,
	lines(
		"Solid store reconcile: https://docs.solidjs.com/reference/store-utilities/reconcile",
		"Fine-grained reactivity in stores: https://docs.solidjs.com/concepts/stores",
		"Keyed lists and For: https://docs.solidjs.com/reference/components/for",
		"Duplicate of the first hit: https://docs.solidjs.com/reference/store-utilities/reconcile",
	),
);
/** WebSearchToolCard: finished with no URLs, so the generic card takes over. */
export const webSearchNoLinksTool: ToolItem = tool(
	"web_search",
	"done",
	{ query: "omp-web wire protocol version" },
	"No results found.",
);
/** WebSearchToolCard: search backend failure, rendered by the generic fallback. */
export const webSearchErrorTool: ToolItem = tool(
	"web_search",
	"error",
	searchArgs,
	"Search provider returned 429 Too Many Requests.",
);

// diff extras
/** DiffToolCard: edit with two hunks in one call. */
export const multiEditToolItem: ToolItem = tool(
	"edit",
	"done",
	{
		path: "apps/web/store/toasts.ts",
		edits: [
			{
				oldText: "export const TOAST_DISMISS_MS = 4000;",
				newText: "export const TOAST_DISMISS_MS = 5000;",
			},
			{
				oldText: lines(
					"export function dismissToast(id: number) {",
					'\tsetState("toasts", (t) => t.filter((x) => x.id !== id));',
					"}",
				),
				newText: lines(
					"export function dismissToast(id: number) {",
					"\tif (!state.toasts.some((x) => x.id === id)) return;",
					'\tsetState("toasts", (t) => t.filter((x) => x.id !== id));',
					"}",
				),
			},
		],
	},
	"Applied 2 edits to apps/web/store/toasts.ts",
);
/** DiffToolCard: write of a 60-line file, long enough to show the numbered preview scroll. */
export const longWriteToolItem: ToolItem = tool(
	"write",
	"done",
	{
		path: "apps/design-system/fixtures/numbers.ts",
		content: lines(
			"export const numbers = [",
			...Array.from({ length: 58 }, (_, i) => `\t${i + 1},`),
			"];",
		),
	},
	"Wrote 60 lines to apps/design-system/fixtures/numbers.ts",
);
