import type { ImageArg, JobDetailDto, WireWaitJob } from "#lib/wire/protocol";
import type { ChatItem, SubagentInfo, ToolItem, state } from "../../web/state";
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
			"export const CopyButton = (props) => {",
			'\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";',
			"\treturn <button title={props.title}>{label}</button>;",
			"};",
		].join("\n"),
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

/** Malformed args: no diff preview, so the card shows the error output text. */
export const malformedEditToolItem: ToolItem = {
	...base,
	id: 4,
	toolCallId: "call_edit_3",
	name: "edit",
	args: { path: 42 },
	status: "error",
	output: "edit failed: path must be a string",
};

/** Hashline edit: args carry only the anchored input; the diff comes from details.diff. */
export const hashlineEditToolItem: ToolItem = {
	...base,
	id: 5,
	toolCallId: "call_edit_hashline_5",
	name: "edit",
	args: { path: "apps/web/store/toasts.ts", input: "12ab|export const TOAST_DISMISS_MS = 4000;" },
	details: {
		diff: "-12|export const TOAST_DISMISS_MS = 4000;\n+12|export const TOAST_DISMISS_MS = 5000;",
	},
	output: "Applied 1 edit to apps/web/store/toasts.ts",
};

/** Apply-patch edit: the patch text lives in args; the diff comes from details.diff. */
export const applyPatchToolItem: ToolItem = {
	...base,
	id: 6,
	toolCallId: "call_apply_patch_6",
	name: "apply_patch",
	args: {
		input:
			"*** Begin Patch\n*** Update File: apps/web/store/toasts.ts\n@@\n-export const TOAST_DISMISS_MS = 4000;\n+export const TOAST_DISMISS_MS = 5000;\n*** End Patch",
	},
	details: {
		diff: "-12|export const TOAST_DISMISS_MS = 4000;\n+12|export const TOAST_DISMISS_MS = 5000;",
	},
	output: "Patched apps/web/store/toasts.ts",
};

/** Streaming edit: args still arriving, so the card shows the pending placeholder. */
export const streamingEditToolItem: ToolItem = {
	...base,
	id: 7,
	toolCallId: "call_edit_streaming_7",
	name: "edit",
	args: { path: "apps/web/components/ui/CopyButton.tsx" },
	status: "running",
	output: "",
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

/** ImageArg: bar chart rendered by an eval cell (matplotlib figure printed by the cell). */
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

// ask, question shape: calls logged before SDK 18.18.3 (args `questions`); `details` mirror that
// SDK's AskToolDetails for each answer shape. The form-shape fixtures follow the dismissed one.
const askArgs = {
	questions: [
		{
			id: "retry-scope",
			question: "Should the retry badge also appear on queued follow-up messages?",
			options: [
				{ label: "Only the active turn", description: "Queued messages stay unbadged." },
				{ label: "Active turn and queue" },
			],
		},
	],
};
/** AskToolCard: question posed, waiting for the user's answer. */
export const askRunningTool: ToolItem = tool("ask", "running", askArgs, "");
/** AskToolCard: answered by picking an offered option. */
export const askDoneTool: ToolItem = {
	...tool("ask", "done", askArgs, "User selected: Active turn and queue"),
	details: {
		question: askArgs.questions[0]?.question,
		options: ["Only the active turn", "Active turn and queue"],
		multi: false,
		selectedOptions: ["Active turn and queue"],
	},
};
/** AskToolCard: answered with a typed custom response and a note instead of an option. */
export const askCustomTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askArgs,
		"User provided custom input: Only when the queue has more than one message\nUser note: keep it subtle",
	),
	details: {
		question: askArgs.questions[0]?.question,
		options: ["Only the active turn", "Active turn and queue"],
		multi: false,
		selectedOptions: [],
		customInput: "Only when the queue has more than one message",
		note: "keep it subtle",
	},
};
/** AskToolCard: an option picked with a note attached to that option. */
export const askNoteOptionTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askArgs,
		"User selected: Active turn and queue\nUser added note on Active turn and queue: only after the queue drains",
	),
	details: {
		question: askArgs.questions[0]?.question,
		options: ["Only the active turn", "Active turn and queue"],
		multi: false,
		selectedOptions: ["Active turn and queue"],
		note: "only after the queue drains",
		noteOption: "Active turn and queue",
	},
};
const askMultiArgs = {
	questions: [
		{
			id: "targets",
			question: "Which platforms should the release build?",
			multi: true,
			options: [{ label: "linux-x64" }, { label: "linux-arm64" }, { label: "darwin-arm64" }],
		},
		{
			id: "channel",
			question: "Publish to which channel?",
			options: [{ label: "stable" }, { label: "beta" }],
		},
	],
};
/** AskToolCard: two questions, one multi-select, answered in one dialog. */
export const askMultiTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askMultiArgs,
		"User answers:\ntargets: [linux-x64, darwin-arm64]\nchannel: beta",
	),
	details: {
		results: [
			{
				id: "targets",
				question: "Which platforms should the release build?",
				options: ["linux-x64", "linux-arm64", "darwin-arm64"],
				multi: true,
				selectedOptions: ["linux-x64", "darwin-arm64"],
			},
			{
				id: "channel",
				question: "Publish to which channel?",
				options: ["stable", "beta"],
				multi: false,
				selectedOptions: ["beta"],
			},
		],
	},
};
/** AskToolCard: dismissed question. */
export const askErrorTool: ToolItem = tool(
	"ask",
	"error",
	askArgs,
	"Ask tool was cancelled by the user",
);

/** The form a current (SDK 18.18.3+) `ask` call carries as its `html` arg. */
const askFormArgs = {
	html: `<form>
  <fieldset>
    <legend>Which database should the outbox use?</legend>
    <label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="db" value="postgres"> PostgreSQL</label>
  </fieldset>
  <fieldset>
    <legend>Which checks should run before the commit?</legend>
    <label><input type="checkbox" name="checks" value="types" checked> Type check</label>
    <label><input type="checkbox" name="checks" value="lint"> Lint</label>
    <label><input type="checkbox" name="checks" value="tests" checked> Unit tests</label>
  </fieldset>
  <label>Retry limit <input type="number" name="retries" min="0" max="10" value="3"></label>
  <label>Notes for the reviewer <textarea name="notes"></textarea></label>
</form>`,
};
/** AskToolCard: a form posed, waiting for the user's answers (the questions are read from its HTML). */
export const askFormRunningTool: ToolItem = tool("ask", "running", askFormArgs, "");
/** AskToolCard: form answered: a radio, a checkbox group (answer text lists the labels), a number and free text. */
export const askFormDoneTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askFormArgs,
		'User answers:\n{"db":"postgres","checks":["types","tests"],"retries":5,"notes":"Bench the outbox before merging."}',
	),
	details: {
		answers: [
			{ name: "db", question: "Which database should the outbox use?", answer: "PostgreSQL" },
			{
				name: "checks",
				question: "Which checks should run before the commit?",
				answer: "Type check, Unit tests",
			},
			{ name: "retries", question: "Retry limit", answer: "5" },
			{
				name: "notes",
				question: "Notes for the reviewer",
				answer: "Bench the outbox before merging.\nSkip the lint pass for now.",
			},
		],
	},
};
/** AskToolCard: form answered with notes on chosen options (SDK 18.18.8+), each under its answer. */
export const askFormNotesTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askFormArgs,
		[
			"User answers:",
			'{"db":"postgres","checks":["types","tests"],"retries":3,"notes":""}',
			"Option notes:",
			'- Which database should the outbox use?: PostgreSQL [db="postgres"] — Use the existing cluster, not a new one.',
			'- Which checks should run before the commit?: Unit tests [checks="tests"] — Only the outbox package.',
		].join("\n"),
	),
	details: {
		answers: [
			{ name: "db", question: "Which database should the outbox use?", answer: "PostgreSQL" },
			{
				name: "checks",
				question: "Which checks should run before the commit?",
				answer: "Type check, Unit tests",
			},
			{ name: "retries", question: "Retry limit", answer: "3" },
			{ name: "notes", question: "Notes for the reviewer", answer: "" },
		],
		notes: [
			{
				name: "db",
				question: "Which database should the outbox use?",
				option: "PostgreSQL",
				value: "postgres",
				text: "Use the existing cluster, not a new one.",
			},
			{
				name: "checks",
				question: "Which checks should run before the commit?",
				option: "Unit tests",
				value: "tests",
				text: "Only the outbox package.",
			},
		],
	},
};
/** AskToolCard: the deadline passed, so the form's preselected values were submitted. */
export const askFormTimedOutTool: ToolItem = {
	...tool(
		"ask",
		"done",
		askFormArgs,
		'No answer before the timeout; submitted the form\'s current values:\n{"db":"sqlite","checks":["types","tests"],"retries":3,"notes":""}',
	),
	details: {
		timedOut: true,
		answers: [
			{ name: "db", question: "Which database should the outbox use?", answer: "SQLite" },
			{
				name: "checks",
				question: "Which checks should run before the commit?",
				answer: "Type check, Unit tests",
			},
			{ name: "retries", question: "Retry limit", answer: "3" },
			{ name: "notes", question: "Notes for the reviewer", answer: "" },
		],
	},
};
/** AskToolCard: form dismissed: no answers, so the questions are read from the call's HTML. */
export const askFormErrorTool: ToolItem = tool(
	"ask",
	"error",
	askFormArgs,
	"Ask tool was cancelled by the user",
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
/** BashToolCard: command cut short by a user interrupt (synthetic result). */
export const bashInterruptedTool: ToolItem = tool(
	"bash",
	"interrupted",
	{ command: "bun run build && bun run test" },
	lines("$ bun run build", "building apps/web ...", "Aborted: operation interrupted"),
);
/** BashToolCard: multi-line command, wrapped in full in the header. */
export const bashMultilineTool: ToolItem = tool(
	"bash",
	"done",
	{
		command: lines(
			"for f in apps/web/components/chat/tools/*ToolCard.tsx; do",
			'  echo "== $f" # per-card line count',
			'  wc -l < "$f"',
			"done | tee /tmp/tool-cards.txt",
		),
	},
	lines(
		"== apps/web/components/chat/tools/AskToolCard.tsx",
		"101",
		"== apps/web/components/chat/tools/BashToolCard.tsx",
		"28",
	),
);
/** BashToolCard: one very long line, soft-wrapped in the header. */
export const bashLongCommandTool: ToolItem = tool(
	"bash",
	"done",
	{
		command:
			'git log --since="2 weeks ago" --author="joshua" --pretty=format:"%h %ad %s" --date=short -- apps/web/components/chat/tools apps/web/styles apps/design-system | grep -v "Merge" | head -n 40',
	},
	lines("a1b2c3d 2026-10-20 Tool card header redesign", "9f8e7d6 2026-10-18 Add highlight module"),
);
/** BashToolCard: a heredoc past the 30-row cap, so the header clamps behind "Show full command". */
export const bashHeredocTool: ToolItem = tool(
	"bash",
	"done",
	{
		command: lines(
			"cat > /tmp/tool-cards.md <<'EOF'",
			...Array.from({ length: 60 }, (_, i) => `- card ${i + 1}: header, status slot, body`),
			"EOF",
			"wc -l /tmp/tool-cards.md",
		),
	},
	lines("62 /tmp/tool-cards.md"),
);
/** BashToolCard: the output minimizer rewrote a git log; the card names the filter and the bytes before and after. */
export const bashMinimizedTool: ToolItem = {
	...tool(
		"bash",
		"done",
		{ command: "git log --stat -n 40" },
		lines(
			"commit 87016421 chore(sdk): upgrade to 18.16.0",
			"commit b4b02c23 feat(sdk): out:// replies on bash, eval and write cards",
			"commit 01e07c16 feat(sdk): queued compaction",
			"... 37 more commits (minimized)",
		),
	),
	details: {
		meta: {
			minimized: { filter: "git", inputBytes: 123_300, outputBytes: 3_277, artifactId: "7" },
		},
	},
};
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

/** The reply a bash call wrote to `out://`: the model's words to the user while the command keeps running. */
const bashReplyArgs = {
	command: [
		"bun scripts/test.ts apps/web/test/review.test.ts",
		"printf '%s\\n' 'Review tests **pass**. Now checking the anchor resolver against stale pins.' > out://progress.md",
	].join("\n"),
};
/** ToolCard: a running bash call whose command already wrote one `out://` reply; it draws as prose after the card. */
export const bashRepliesRunningTool: ToolItem = {
	...tool(
		"bash",
		"running",
		bashReplyArgs,
		lines("$ bun scripts/test.ts apps/web/test/review.test.ts", "14 pass"),
	),
	replies: ["Review tests **pass**. Now checking the anchor resolver against stale pins."],
};
/** ToolCard: a settled bash call with two `out://` replies (`details.replies`), the second Markdown with a list and code. */
export const bashRepliesDoneTool: ToolItem = {
	...tool(
		"bash",
		"done",
		bashReplyArgs,
		lines("$ bun scripts/test.ts apps/web/test/review.test.ts", "14 pass", "0 fail"),
	),
	details: {
		replies: [
			"Review tests **pass**. Now checking the anchor resolver against stale pins.",
			lines(
				"Two things to know before I go on:",
				"",
				"- `resolveAnchor` falls back to the last known line when the text is gone.",
				"- Old sessions keep their line pins, so nothing there needs migrating.",
			),
		],
	},
};

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
/** EvalToolCard: cell that prints a chart image next to its text output. */
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

const evalJsCode = lines(
	"const dir = 'apps/web/components/chat/tools';",
	"const files = (await ls(dir)).filter((f) => f.endsWith('ToolCard.tsx'));",
	"const rows = [];",
	"for (const f of files) {",
	"  const text = await read(`${dir}/${f}`);",
	"  rows.push({ card: f.replace('.tsx', ''), lines: text.split('\\n').length });",
	"}",
	"rows.sort((a, b) => b.lines - a.lines);",
	"console.table(rows.slice(0, 4));",
);
const evalJsTableText = lines(
	"┌───┬──────────────┬───────┐",
	"│   │ card         │ lines │",
	"├───┼──────────────┼───────┤",
	"│ 0 │ EvalToolCard │   212 │",
	"│ 1 │ BashToolCard │   168 │",
	"│ 2 │ TaskToolCard │   131 │",
	"│ 3 │ ReadToolCard │    96 │",
	"└───┴──────────────┴───────┘",
);
/** EvalToolCard: settled JavaScript cell that read files through helpers and printed a table; the helpers' status log lists below. */
export const evalJsDoneTool: ToolItem = {
	...tool(
		"eval",
		"done",
		{ language: "js", code: evalJsCode },
		lines(evalJsTableText, "4 of 9 cards shown"),
	),
	details: {
		language: "js",
		languages: ["js"],
		cells: [
			{
				index: 0,
				code: evalJsCode,
				language: "js",
				status: "complete",
				output: lines(evalJsTableText, "4 of 9 cards shown"),
				views: [
					{
						text: evalJsTableText,
						view: {
							kind: "table",
							columns: [
								{ head: "", numeric: false },
								{ head: "card", numeric: false },
								{ head: "lines", numeric: true },
							],
							rows: [
								["0", "EvalToolCard", "212"],
								["1", "BashToolCard", "168"],
								["2", "TaskToolCard", "131"],
								["3", "ReadToolCard", "96"],
							],
						},
					},
				],
			},
		],
		statusEvents: [
			{ op: "ls", path: "apps/web/components/chat/tools", count: 24 },
			{ op: "read", path: "apps/web/components/chat/tools/EvalToolCard.tsx", chars: 8120 },
			{ op: "read", path: "apps/web/components/chat/tools/BashToolCard.tsx", chars: 6432 },
		],
	},
};

const evalReplyCode = lines(
	"import json",
	"report = json.load(open('build/size-report.json'))",
	"tool.write('out://size.md', f\"Bundle is **{report['total_kb']} KB**, {report['over_budget']} chunks over budget.\")",
	"print(len(report['chunks']), 'chunks')",
);
/** ToolCard: a running eval cell whose `tool.write` to `out://` already reached the user. */
export const evalRepliesRunningTool: ToolItem = {
	...tool("eval", "running", { language: "python", code: evalReplyCode }, ""),
	replies: ["Bundle is **812 KB**, 2 chunks over budget."],
};
/** ToolCard: a settled eval cell that replied through `tool.write('out://...')`; the reply follows the card as prose. */
export const evalRepliesDoneTool: ToolItem = {
	...tool("eval", "done", { language: "python", code: evalReplyCode }, "37 chunks"),
	details: {
		language: "python",
		languages: ["python"],
		cells: [
			{
				index: 0,
				code: evalReplyCode,
				language: "python",
				status: "complete",
				output: "37 chunks",
			},
		],
		replies: ["Bundle is **812 KB**, 2 chunks over budget."],
	},
};

// write to out:// (a reply, not a file)
const replyWriteContent = lines(
	"## Where the retry badge stands",
	"",
	"The badge now shows on the **active turn** only. Queued follow-ups stay unbadged, as you asked.",
	"",
	"- `RetryBadge` reads `retryInfo.attempt` and `maxAttempts`.",
	"- The countdown comes from `retryInfo.until`.",
);
/** ToolCard: a `write` to `out://` draws as assistant prose, not a Write card with line numbers. */
export const replyWriteTool: ToolItem = tool(
	"write",
	"done",
	{ path: "out://status.md", content: replyWriteContent },
	"Wrote 6 lines to out://status.md",
);
/** ToolCard: a `write` to `out://` in a session where replies are off; the refusal shows under the text. */
export const replyWriteErrorTool: ToolItem = tool(
	"write",
	"error",
	{ path: "out://status.md", content: "The retry badge shows on the active turn only." },
	"out:// is off in this session (`out.enabled`); reply in your final message instead.",
);

// generic (no dedicated renderer)
const issueArgs = { team: "OMP", state: "In Progress", limit: 3 };
/** GenericToolCard: finished MCP tool call with JSON output. */
export const genericDoneTool: ToolItem = tool(
	"mcp__linear_list_issues",
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
	"mcp__linear_list_issues",
	"running",
	issueArgs,
	"",
);
/** GenericToolCard: call that failed. */
export const genericErrorTool: ToolItem = tool(
	"mcp__linear_list_issues",
	"error",
	issueArgs,
	"MCP error -32001: request timed out after 30000ms (server 'linear' is reconnecting)",
);
/** GenericToolCard: call cut short by a user interrupt (synthetic result). */
export const genericInterruptedTool: ToolItem = tool(
	"mcp__linear_list_issues",
	"interrupted",
	issueArgs,
	"Aborted: operation interrupted",
);
/** GenericToolCard: 60 lines of output in one pre. */
export const genericLongTool: ToolItem = tool(
	"mcp__linear_list_issues",
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

// eval details: printed views and status events
const evalViewsCode = lines(
	"import json, pandas as pd",
	"df = pd.DataFrame(rows, columns=['component', 'lines', 'tests'])",
	"print(df)",
	"print(json.loads(Path('package.json').read_text())['scripts'])",
	"print(Markdown(summary))",
);
const evalDataFrameText = lines(
	"       component  lines  tests",
	"0      ToolCard    212      4",
	"1  TaskToolCard     48      2",
	"2   EvalToolCard    131      6",
);
const evalScriptsText =
	"{'dev': 'bun scripts/dev.ts', 'test': 'bun scripts/test.ts', 'lint': 'bun scripts/lint.ts'}";
const evalMarkdownText = "Summary: 3 cards, 12 tests";
/** EvalToolCard: a cell that printed a DataFrame, a dict and a Markdown object; each shows as a view in place of its text. */
export const evalViewsTool: ToolItem = {
	...tool(
		"eval",
		"done",
		{ language: "python", code: evalViewsCode },
		lines(evalDataFrameText, evalScriptsText, evalMarkdownText),
	),
	details: {
		language: "python",
		languages: ["python"],
		cells: [
			{
				index: 0,
				code: evalViewsCode,
				language: "python",
				status: "complete",
				output: lines(evalDataFrameText, evalScriptsText, evalMarkdownText),
				views: [
					{
						text: evalDataFrameText,
						view: {
							kind: "table",
							columns: [
								{ head: "", numeric: false },
								{ head: "component", numeric: false },
								{ head: "lines", numeric: true },
								{ head: "tests", numeric: true },
							],
							rows: [
								["0", "ToolCard", "212", "4"],
								["1", "TaskToolCard", "48", "2"],
								["2", "EvalToolCard", "131", "6"],
							],
						},
					},
					{
						text: evalScriptsText,
						view: {
							kind: "json",
							value: {
								dev: "bun scripts/dev.ts",
								test: "bun scripts/test.ts",
								lint: "bun scripts/lint.ts",
								nested: { workers: [1, 2, 3], retry: { max: 3, backoffMs: 250 } },
							},
						},
					},
					{
						text: evalMarkdownText,
						view: {
							kind: "markdown",
							text: "### Summary\n\n- **3** cards\n- **12** tests\n\n`bun scripts/test.ts` passes.",
						},
					},
				],
			},
		],
	},
};
/** EvalToolCard: running cell; helpers logged status events and an MCP call reports progress (frame `live`). */
export const evalStatusRunningTool: ToolItem = {
	...tool(
		"eval",
		"running",
		{
			language: "python",
			code: lines(
				"issues = tool.linear_list_issues(team='OMP', limit=100)",
				"log(f'fetched {len(issues)} issues')",
			),
		},
		"scanning issues\n",
	),
	live: {
		kind: "eval",
		elided: 14,
		status: [
			{ op: "log", message: "scanning issues" },
			{ op: "read", path: "package.json", chars: 1832 },
			{ op: "agent", id: "Triage-1", status: "running", toolCount: 4 },
			{
				op: "mcp_progress",
				id: "call-1",
				tool: "linear/list_issues",
				progress: 30,
				total: 100,
				message: "Fetching page 3",
			},
		],
		at: Date.now(),
	},
};
/** EvalToolCard: settled cell with its full status log; a helper's `preview` text never joins the line. */
export const evalStatusDoneTool: ToolItem = {
	...tool(
		"eval",
		"done",
		{
			language: "js",
			code: "log('start');\nconst files = await ls('apps/web');\nlog(`${files.length} entries`);",
		},
		"12 entries",
	),
	details: {
		languages: ["js"],
		cells: [{ index: 0, code: "", language: "js", status: "complete", output: "12 entries" }],
		statusEventsElided: 3,
		statusEvents: [
			{ op: "log", message: "start" },
			{ op: "ls", path: "apps/web", count: 12 },
			{ op: "read", path: "apps/web/state.ts", chars: 5120, preview: "export interface…" },
			{ op: "log", message: "12 entries" },
		],
		notice: "Python is unavailable in this session; ran in the JavaScript backend.",
	},
};

// generic: MCP progress while the call runs
/** GenericToolCard: MCP call in flight; the output is the server's progress line. */
export const genericMcpProgressTool: ToolItem = tool(
	"mcp__linear_list_issues",
	"running",
	issueArgs,
	"Fetching issues (3/10)",
);

// wait
const waitJobs = [
	{
		id: "TraceRetry",
		type: "task",
		status: "running",
		label: "Trace the retry path through the outbox",
		durationMs: 94_000,
		stage: "Reading the outbox resend logic",
		completionPercent: 62,
	},
	{
		id: "bg_2",
		type: "bash",
		status: "running",
		label: "bun run test --watch apps/web",
		durationMs: 41_000,
	},
	{
		id: "bg_1",
		type: "eval",
		status: "running",
		label: "fetch and cache the issue list",
		durationMs: 12_000,
	},
] as const;
/** WaitToolCard: call in flight; live rows for a subagent (stage and completion ring), a bash job and an eval job. */
export const waitRunningTool: ToolItem = {
	...tool("wait", "running", {}, ""),
	live: { kind: "wait", jobs: waitJobs.map((job) => ({ ...job })), at: Date.now() },
};
const waitSettledJobs = [
	{ id: "bg_3", type: "bash", status: "completed", label: "bun run build:web", durationMs: 38_000 },
	{
		id: "bg_4",
		type: "bash",
		status: "failed",
		label: "bun scripts/test.ts apps/web/test/store",
		durationMs: 21_000,
		exitCode: 1,
	},
	{
		id: "SweepCss",
		type: "task",
		status: "cancelled",
		label: "Audit CSS for unused selectors",
		durationMs: 7_000,
	},
	{
		id: "TraceRetry",
		type: "task",
		status: "running",
		label: "Trace the retry path through the outbox",
		durationMs: 130_000,
		stage: "Writing the failing test",
		completionPercent: 80,
	},
] as const;
/** WaitToolCard: settled call; the jobs as the wait left them, plus a subagent with no job row. */
export const waitSettledTool: ToolItem = {
	...tool(
		"wait",
		"done",
		{},
		"## Completed (3)\n\n### bg_3 [bash] - completed\nLabel: bun run build:web",
	),
	details: {
		op: "wait",
		jobs: waitSettledJobs.map((job) => ({ ...job, resultText: "(output kept by the model)" })),
		agents: [
			{
				id: "PeerWoken",
				parentId: "TraceRetry",
				activity: "Replying to a question",
				ageMs: 52_000,
				live: true,
			},
			{ id: "Revived", ageMs: 311_000, live: false },
		],
	},
};
/** WaitToolCard: call that found nothing to wait for; the result text shows. */
export const waitIdleTool: ToolItem = {
	...tool(
		"wait",
		"done",
		{},
		"Nothing to wait for: no background job or service you started is running, and no agent you messaged this run owes a reply.",
	),
	details: { op: "wait", jobs: [] },
};
/** WaitToolCard: eleven watched jobs; eight rows show and the rest are counted. */
export const waitManyTool: ToolItem = {
	...tool("wait", "done", {}, ""),
	details: {
		op: "wait",
		jobs: Array.from({ length: 11 }, (_, i) => ({
			id: `bg_${i + 10}`,
			type: "bash",
			status: i < 8 ? "completed" : "running",
			label: `bun scripts/shard.ts --index ${i}`,
			durationMs: 9_000 + i * 1_300,
		})),
	},
};
/** WaitToolCard: no job, but two running agents (a peer-woken and a revived subagent). */
export const waitAgentsTool: ToolItem = {
	...tool("wait", "done", {}, ""),
	details: {
		op: "wait",
		jobs: [],
		agents: [
			{
				id: "PeerWoken",
				parentId: "TraceRetry",
				activity: "Replying to a question",
				ageMs: 52_000,
				live: true,
			},
			{ id: "Revived", ageMs: 311_000, live: false },
		],
	},
};
/** A fixed wait start, so the timing text of the fixture below never drifts. */
const WAIT_STARTED_AT = 1_780_000_000_000;
/**
 * WaitToolCard: a settled wait on SDK 18.18.6, whose jobs carry `settledAtMs`. The build finished
 * while the wait ran; the lint had already finished 2m05s before the call (a result the wait
 * recovered rather than waited for).
 */
export const waitTimingTool: ToolItem = {
	...tool("wait", "done", {}, ""),
	startedAt: WAIT_STARTED_AT,
	details: {
		op: "wait",
		jobs: [
			{
				id: "bg_build",
				type: "bash",
				status: "completed",
				label: "bun run build:web",
				durationMs: 38_000,
				settledAtMs: WAIT_STARTED_AT + 12_000,
			},
			{
				id: "bg_lint",
				type: "bash",
				status: "completed",
				label: "bunx oxlint apps/web",
				durationMs: 9_000,
				settledAtMs: WAIT_STARTED_AT - 125_000,
			},
		],
	},
};
const runJob = (
	id: string,
	type: WireWaitJob["type"],
	status: WireWaitJob["status"],
	label: string,
	durationMs: number,
	extra: Partial<WireWaitJob> = {},
): WireWaitJob => ({ id, type, status, label, durationMs, ...extra });
const buildJob = (status: "running" | "completed", durationMs: number) =>
	runJob("bg_build", "bash", status, "bun run build:web", durationMs);
const testJob = (status: "running" | "failed", durationMs: number) =>
	runJob("bg_test", "bash", status, "bun scripts/test.ts apps/web/test/chat", durationMs, {
		...(status === "failed" ? { exitCode: 1 } : {}),
	});
const lintJob = (status: "running" | "completed", durationMs: number) =>
	runJob("bg_lint", "bash", status, "bunx oxlint apps/web", durationMs);
const traceJob = (
	status: "running" | "completed",
	durationMs: number,
	stage: string,
	completionPercent: number,
) =>
	runJob("TraceRetry", "task", status, "Trace the retry path through the outbox", durationMs, {
		stage,
		...(status === "running" ? { completionPercent } : {}),
	});
/** One wait call of a run: `details` as the SDK leaves them. */
const waitCall = (details: Record<string, unknown>): ToolItem => ({
	...tool("wait", "done", {}, ""),
	details: { op: "wait", ...details },
});
/**
 * WaitToolCard: four settled waits of one run. The build settles first; the second wait is cut
 * short by a message; the tests fail in the third (exit 1) while the lint passes; the subagent is
 * the last to finish.
 */
export const waitRunTools: ToolItem[] = [
	waitCall({
		jobs: [
			buildJob("completed", 38_000),
			testJob("running", 21_000),
			traceJob("running", 94_000, "Reading the outbox resend logic", 40),
			lintJob("running", 9_000),
		],
	}),
	waitCall({
		interrupted: true,
		jobs: [
			testJob("running", 45_000),
			traceJob("running", 118_000, "Writing the failing test", 62),
			lintJob("running", 33_000),
		],
	}),
	waitCall({
		jobs: [
			testJob("failed", 61_000),
			traceJob("running", 160_000, "Fixing the resend ordering", 80),
			lintJob("completed", 47_000),
		],
	}),
	waitCall({ jobs: [traceJob("completed", 211_000, "Done", 100)] }),
];
/**
 * WaitToolCard: a run still going. The first wait settled with the build done; the last is in
 * flight with a live frame, so its jobs run and the build keeps its earlier outcome.
 */
export const waitLiveRunTools: ToolItem[] = [
	waitRunTools[0]!,
	{
		...tool("wait", "running", {}, ""),
		live: {
			kind: "wait",
			jobs: [
				testJob("running", 54_000),
				traceJob("running", 127_000, "Writing the failing test", 62),
				lintJob("running", 42_000),
			],
			at: Date.now(),
		},
	},
];
/**
 * TranscriptStream: a session turn that starts background jobs and then waits four times
 * (assistant turns between the waits draw nothing), so the four waits fold into one card at the
 * first. The bash call that started the build is the card the build row jumps to.
 */
export const waitRunItems: ChatItem[] = [
	{
		kind: "user",
		id: 9200,
		text: "Build the web app, run the chat tests and lint it in the background, and have an agent trace the retry bug.",
	},
	{
		kind: "assistant",
		id: 9201,
		blocks: [
			{ kind: "text", text: "Starting the build, the tests and the lint, and the tracing agent." },
		],
	},
	{
		kind: "tool",
		id: 9202,
		toolCallId: "call_bash_build",
		name: "bash",
		args: { command: "bun run build:web", async: true },
		status: "done",
		output: "Started background job bg_build.",
		details: { async: { state: "running", jobId: "bg_build", type: "bash" } },
	},
	{ kind: "assistant", id: 9203, blocks: [] },
	waitRunTools[0]!,
	{ kind: "assistant", id: 9204, blocks: [] },
	waitRunTools[1]!,
	{ kind: "assistant", id: 9205, blocks: [] },
	waitRunTools[2]!,
	waitRunTools[3]!,
	{
		kind: "assistant",
		id: 9206,
		blocks: [
			{
				kind: "text",
				text: "The build and the lint passed and the agent finished the trace; `bg_test` failed with exit 1.",
			},
		],
	},
];
/** WaitJobRow and WaitToolCard: what `getJobDetail` answers for an opened row (a failed test run's output tail). */
export const waitJobDetail: JobDetailDto = {
	command: "bun scripts/test.ts apps/web/test/chat",
	cwd: "/home/joshua/Repos/omp-web",
	pids: [],
	exitCode: 1,
	output: [
		"apps/web/test/chat/wait-runs.test.ts:",
		"(pass) boundaries > a user item ends the run [0.4ms]",
		"(pass) boundaries > an empty assistant does not [0.2ms]",
		"(fail) merge > a running last wait overrides from its live frame [1.9ms]",
		"  error: expect(received).toBe(expected)",
		"  Expected: 4",
		"  Received: 3",
		"",
		" 2 pass",
		" 1 fail",
	].join("\n"),
};

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
/** LspToolCard: a handful of reference hits, all shown. */
export const lspReferencesShortTool: ToolItem = tool(
	"lsp",
	"done",
	{ action: "references", file: "apps/web/state.ts", symbol: "pushNotice" },
	lines(
		"apps/web/store/toasts.ts:41:17",
		"apps/web/store/roster.ts:212:9",
		"apps/web/store/transport.ts:88:5",
		"apps/web/components/fleet/sidebar/WorkspaceRow.tsx:57:13",
		"apps/web/components/chat/composer/Composer.tsx:164:7",
		"apps/web/prompt/commands.ts:93:11",
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
// Tabs become two spaces before output reaches the card (store/chat.ts tabsToSpaces).
const copyButtonSource = [
	'import { createSignal, type Component } from "solid-js";',
	'import { copyText } from "../../text/clipboard";',
	'import { CheckIcon, CopyIcon } from "./icons";',
	"",
	"export const COPY_FEEDBACK_MS = 1200;",
	"",
	"interface CopyButtonProps {",
	"  text: () => string;",
	"  class?: string;",
	"  title?: string;",
	"}",
	"",
	"/** Icon button that copies text and flashes a check mark. */",
	"export const CopyButton: Component<CopyButtonProps> = (props) => {",
	"  const [copied, setCopied] = createSignal(false);",
	"  const onClick = async () => {",
	"    await copyText(props.text());",
	"    setCopied(true);",
	"    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);",
	"  };",
	"  return (",
	"    <button class={props.class} title={props.title} onClick={onClick}>",
	"      {copied() ? <CheckIcon /> : <CopyIcon />}",
	"    </button>",
	"  );",
	"};",
];
const copyButtonPath = "apps/web/components/ui/CopyButton.tsx";
/** Hashline read output: `[path#TAG]` header, then `N:text` rows (SDK read-format.ts). */
const numbered = (path: string, rows: string[], from: number): string =>
	[`[${path}#7k2m]`, ...rows.map((row, i) => `${from + i}:${row}`)].join("\n");
/** ReadToolCard: short excerpt with the tool's own line numbers. */
export const readDoneTool: ToolItem = tool(
	"read",
	"done",
	{ path: copyButtonPath, offset: 1, limit: 12 },
	`${numbered(copyButtonPath, copyButtonSource.slice(0, 12), 1)}\n\n[14 more lines in file. Use ${copyButtonPath}:13 to continue]`,
);
const retrySource = [
	'import { sleep } from "./sleep";',
	"",
	"export interface RetryOptions {",
	"  attempts: number;",
	"  baseMs: number;",
	"}",
	"",
	"/** Run `fn`, retrying with exponential backoff. */",
	"export async function retry<T>(",
	"  fn: () => Promise<T>,",
	"  opts: RetryOptions,",
	"): Promise<T> {",
	"  let delay = opts.baseMs;",
];
/** ReadToolCard: a 13-line excerpt whose continuation note fits a narrow card. */
export const readExcerptTool: ToolItem = tool(
	"read",
	"done",
	{ path: "lib/retry.ts", offset: 1, limit: 13 },
	`${numbered("lib/retry.ts", retrySource, 1)}\n\n[9 more lines in file. Use lib/retry.ts:14 to continue]`,
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
	{ path: copyButtonPath, offset: 40 },
	numbered(copyButtonPath, copyButtonSource, 40),
);
/** ReadToolCard: Python file whose module docstring and block string span lines. */
export const readPythonTool: ToolItem = tool(
	"read",
	"done",
	{ path: "scripts/check_boundaries.py" },
	numbered(
		"scripts/check_boundaries.py",
		[
			'"""Fail when a web component imports from another feature.',
			"",
			"Run from the repo root; exits 1 on the first violation.",
			'"""',
			"import pathlib",
			"import sys",
			"",
			"ALLOWED = {'shared', 'ui'}",
			"",
			"def violations(root: pathlib.Path) -> list[str]:",
			"    found = []",
			"    for f in root.rglob('*.tsx'):",
			"        for n, line in enumerate(f.read_text().splitlines(), 1):",
			"            if 'from \"../../' in line:  # crosses a feature folder",
			"                found.append(f'{f}:{n}')",
			"    return found",
			"",
			"if __name__ == '__main__':",
			"    sys.exit(1 if violations(pathlib.Path('apps/web')) else 0)",
		],
		1,
	),
);
/** ReadToolCard: plain output without SDK line numbers (readLineNumbers off), a block comment spanning rows. */
export const readPlainTool: ToolItem = tool(
	"read",
	"done",
	{ path: "apps/web/chat/tool-kinds.ts", limit: 12 },
	lines(
		"/**",
		" * Tool name -> display category and icon. Unknown names fall back to",
		" * `other`; MCP tools arrive as `mcp__server__tool`.",
		" */",
		'export type ToolCategory = "shell" | "read" | "write" | "search" | "agent" | "other";',
		"",
		"export const TOOL_KINDS: Record<string, { category: ToolCategory; icon: ToolIconKey }> = {",
		'  bash: { category: "shell", icon: "terminal" },',
		'  read: { category: "read", icon: "file-text" },',
		'  grep: { category: "search", icon: "search" },',
		"};",
		"",
		"[8 more lines in file. Use apps/web/chat/tool-kinds.ts:13 to continue]",
	),
);
/** ReadToolCard: missing file. */
export const readErrorTool: ToolItem = tool(
	"read",
	"error",
	{ path: "apps/web/components/ui/CopyBtn.tsx" },
	"ENOENT: no such file or directory, open 'apps/web/components/ui/CopyBtn.tsx'",
);

// grep / glob
/** SearchToolCard: grouped grep (SDK grouped-file-output.ts): folded dir header, nested files with #TAG, `*N:` hits, ` N:` context, `...` gap. */
export const grepDoneTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "COPY_FEEDBACK_MS", path: "apps/web" },
	lines(
		"# apps/web/components/",
		"## tx/",
		"### TxMessage.tsx#c3d4",
		'*14:import { COPY_FEEDBACK_MS } from "../ui/CopyButton";',
		" 15:",
		" 16:/** Copy affordance shown on hover. */",
		"",
		"## ui/",
		"### CopyButton.tsx#e5f6",
		"*5:export const COPY_FEEDBACK_MS = 1200;",
		" 6:",
		" 7:interface CopyButtonProps {",
		"...",
		" 18:    setCopied(true);",
		"*19:    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);",
		" 20:  };",
	),
);
/** SearchToolCard: a symbol's hits across three files, short rows that fit a narrow card. */
export const grepSymbolTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "pushNotice", path: "apps/web" },
	lines(
		"# apps/web/",
		"## store/",
		"### toasts.ts#b7c1",
		"*41:export function pushNotice(text: string) {",
		" 42:  pushToast(text, { durationMs: 4_000 });",
		" 43:}",
		"",
		"## prompt/",
		"### commands.ts#d902",
		'*93:    pushNotice("Unknown command");',
		"...",
		'*118:    pushNotice("Command not available");',
		"",
		"## components/chat/composer/",
		"### Composer.tsx#4e5f",
		'*164:  pushNotice("Message queued");',
	),
);
/** SearchToolCard: single-file grep in plain mode (`*N|text`, no header; the card falls back to args.path). */
export const grepSingleFileTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "violations", path: "scripts/check_boundaries.py" },
	lines(
		' 1|"""Fail when a web component imports from another feature.',
		" 2|",
		" 3|Run from the repo root; exits 1 on the first violation.",
		' 4|"""',
		"...",
		"*10|def violations(root: pathlib.Path) -> list[str]:",
		" 11|    found = []",
		"...",
		"*19|    sys.exit(1 if violations(pathlib.Path('apps/web')) else 0)",
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
		"apps/web/components/chat/tools/LspToolCard.tsx",
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
/** SearchToolCard: 40 hits across four files so the result body scrolls, with the SDK's file-limit note. */
export const grepLongTool: ToolItem = tool(
	"grep",
	"done",
	{ pattern: "state\\.", path: "apps/web/components", glob: "*.tsx" },
	lines(
		"# apps/web/components/",
		...[
			["chat/SessionConfigBar.tsx", "aa11"],
			["chat/Transcript.tsx", "bb22"],
			["fleet-ui/FleetSidebar.tsx", "cc33"],
			["overlays/SessionStatsDialog.tsx", "dd44"],
		].flatMap(([file, tag], f) => [
			...(f > 0 ? [""] : []),
			`## ${file}#${tag}`,
			...Array.from(
				{ length: 10 },
				(_, i) => `*${12 + i * 7}:  const value = () => state.field${f * 10 + i}();`,
			),
		]),
		"",
		"Showing files 1-4 of 4+. Use skip=4 for the next page, or narrow paths/pattern.",
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
/** TaskToolCard: `task.file` call, labelled by its `taskFile` path (no `task`/`description`). */
export const taskFileTool: ToolItem = tool(
	"task",
	"running",
	{ taskFile: "local://tasks/audit-css.md" },
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
	sub(taskDoneTool, 0, "Dara", "scout", "Find Transcript call sites", "completed", 120_000),
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
/** Phases as one todo call settled them; the card renders these from the result details. */
export const settledTodoPhases: typeof state.todoPhases = [
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

/** TodoToolCard: the call's result details carry the board it settled with (REV-06). */
export const todoSnapshotTool: ToolItem = {
	...todoArgsTool,
	details: { op: "done", phases: settledTodoPhases },
};

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
/** WebSearchToolCard: a fallback provider answered; the note's failure reason quotes a URL that is not a result. */
export const webSearchFallbackNoteTool: ToolItem = tool(
	"web_search",
	"done",
	searchArgs,
	lines(
		"Note: answered by Exa after Brave failed (Brave search request failed: 429 https://api.search.brave.com/res/v1/web/search)",
		"Solid store reconcile: https://docs.solidjs.com/reference/store-utilities/reconcile",
		"Keyed lists and For: https://docs.solidjs.com/reference/components/for",
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
/** WebSearchToolCard: two providers failed (one with an HTTP status, one without) before a third answered. */
export const webSearchFailuresTool: ToolItem = {
	...tool(
		"web_search",
		"done",
		searchArgs,
		lines(
			"Note: answered by Exa after Brave failed (Brave search request failed: 429) and Tavily failed (request timed out after 60s)",
			"Solid store reconcile: https://docs.solidjs.com/reference/store-utilities/reconcile",
			"Keyed lists and For: https://docs.solidjs.com/reference/components/for",
		),
	),
	details: {
		response: { provider: "exa", sources: [] },
		failures: [
			{
				provider: "brave",
				label: "Brave",
				reason: "Brave search request failed: 429",
				status: 429,
			},
			{ provider: "tavily", label: "Tavily", reason: "request timed out after 60s" },
		],
	},
};
/** WebSearchToolCard: every provider failed; the card keeps the error text and lists each failure. */
export const webSearchAllFailedTool: ToolItem = {
	...tool(
		"web_search",
		"error",
		searchArgs,
		"Error: All web search providers failed: brave: Brave search request failed: 401; tavily: no API key configured",
	),
	details: {
		response: { provider: "brave", sources: [] },
		error: "All web search providers failed",
		failures: [
			{
				provider: "brave",
				label: "Brave",
				reason: "Brave search request failed: 401",
				status: 401,
			},
			{ provider: "tavily", label: "Tavily", reason: "no API key configured" },
		],
	},
};

// diff extras
/** DiffToolCard: edit with two hunks in one call. */
export const multiEditToolItem: ToolItem = tool(
	"edit",
	"done",
	{
		path: "apps/web/store/toasts.ts",
		edits: [
			{
				old_string: "export const TOAST_DISMISS_MS = 4000;",
				new_string: "export const TOAST_DISMISS_MS = 5000;",
			},
			{
				old_string: lines(
					"export function dismissToast(id: number) {",
					'\tsetState("toasts", (t) => t.filter((x) => x.id !== id));',
					"}",
				),
				new_string: lines(
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
/** DiffToolCard: write of a 60-line file; collapsed, it reads as +60 -0. */
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
/** DiffToolCard: an edit inside a block comment, so the colored comment spans context and added rows. */
export const commentEditToolItem: ToolItem = tool(
	"edit",
	"done",
	{
		path: "apps/web/store/toasts.ts",
		old_string: lines(
			"/*",
			" * Toasts auto-dismiss after TOAST_DISMISS_MS.",
			" */",
			"export const TOAST_DISMISS_MS = 4000;",
		),
		new_string: lines(
			"/*",
			" * Toasts auto-dismiss after TOAST_DISMISS_MS.",
			" * Hovering a toast pauses the timer.",
			" */",
			"export const TOAST_DISMISS_MS = 5000;",
		),
	},
	"Applied 1 edit to apps/web/store/toasts.ts",
);
/** DiffToolCard: apply_patch across two files, each section highlighted by its own language. */
export const multiFilePatchToolItem: ToolItem = {
	...tool(
		"apply_patch",
		"done",
		{ input: "*** Begin Patch\n*** Update File: apps/web/store/toasts.ts\n*** End Patch" },
		"Patched 2 files",
	),
	details: {
		diff: lines(
			"-12|export const TOAST_DISMISS_MS = 4000;",
			"+12|export const TOAST_DISMISS_MS = 5000;",
			" 40|def retry(attempts):",
			"-41|    return attempts < 3",
			'+41|    return attempts < 5  # "max"',
		),
		perFileResults: [
			{
				path: "apps/web/store/toasts.ts",
				diff: lines(
					"-12|export const TOAST_DISMISS_MS = 4000;",
					"+12|export const TOAST_DISMISS_MS = 5000;",
				),
			},
			{
				path: "scripts/retry.py",
				diff: lines(
					" 40|def retry(attempts):",
					"-41|    return attempts < 3",
					'+41|    return attempts < 5  # "max"',
				),
			},
		],
	},
};

// task: subagents reporting their current step
/** TaskToolCard: delegated call whose running agents report a stage (from their completion probe). */
export const taskStageTool: ToolItem = tool(
	"task",
	"running",
	{ description: "Trace the retry path through the outbox" },
	"",
);

const stageSub = (
	index: number,
	id: string,
	description: string,
	progress: NonNullable<SubagentInfo["progress"]>,
): SubagentInfo => ({
	id,
	index,
	agent: "task",
	description,
	status: "running",
	lastUpdate: FIXTURE_NOW - 3_000,
	parentToolCallId: taskStageTool.toolCallId,
	progress: { status: "running", ...progress },
});

/** state.subagents patch for the stage variant: a stage with a tool in flight, and a stage alone, each with its completion estimate. */
export const taskStageSubagentMap: typeof state.subagents = new Map(
	[
		stageSub(0, "TraceRetry", "Trace the retry path", {
			stage: "Reading the outbox resend logic",
			currentTool: "grep",
			currentToolIntent: "Find callers of resend",
			durationMs: 94_000,
			completionPercent: 62,
		}),
		stageSub(1, "SweepCss", "Audit CSS for unused selectors", {
			stage: "Cross-checking selectors against the stories",
			durationMs: 61_000,
			completionPercent: 12,
		}),
	].map((info) => [info.id, info]),
);

/** TaskToolCard: one call that fanned out to three agents, all finished; every agent carries tokens, cost and run time. */
export const taskStatsTool: ToolItem = tool(
	"task",
	"done",
	{ description: "Map the chat transcript rendering path" },
	"3 agents finished.",
);

const statsSub = (
	index: number,
	id: string,
	agent: string,
	description: string,
	progress: { tokens: number; cost: number; durationMs: number },
): SubagentInfo => {
	const startedAt = FIXTURE_NOW - 6 * 60_000;
	return {
		id,
		index,
		agent,
		description,
		status: "completed",
		lastUpdate: startedAt + progress.durationMs,
		parentToolCallId: taskStatsTool.toolCallId,
		startedAt,
		endedAt: startedAt + progress.durationMs,
		progress: { status: "completed", ...progress },
	};
};

/** state.subagents patch for the stats variant. */
export const taskStatsSubagentMap: typeof state.subagents = new Map(
	[
		statsSub(0, "FindCallers", "scout", "Find Transcript call sites", {
			tokens: 4_100,
			cost: 0.019,
			durationMs: 64_000,
		}),
		statsSub(1, "ReadStore", "scout", "Read the chat store", {
			tokens: 3_800,
			cost: 0.016,
			durationMs: 122_000,
		}),
		statsSub(2, "TraceRender", "task", "Trace the render path", {
			tokens: 9_400,
			cost: 0.052,
			durationMs: 94_000,
		}),
	].map((info) => [info.id, info]),
);
