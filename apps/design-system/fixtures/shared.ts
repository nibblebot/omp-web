import type { ImageArg } from "#lib/wire/protocol";
import type { SubagentInfo } from "../../web/state";
import { FIXTURE_NOW } from "./session";

const TERMINAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#14171c"/>
<rect width="640" height="30" fill="#222730"/>
<circle cx="16" cy="15" r="5" fill="#ff5f56"/>
<circle cx="34" cy="15" r="5" fill="#ffbd2e"/>
<circle cx="52" cy="15" r="5" fill="#27c93f"/>
<text x="20" y="58" font-family="monospace" font-size="14" fill="#9aa4b2">$ bun run check:types</text>
<text x="20" y="80" font-family="monospace" font-size="14" fill="#9aa4b2">$ tsc --noEmit -p apps/web</text>
<text x="20" y="108" font-family="monospace" font-size="14" fill="#e6edf3">apps/web/components/review/ReviewPanel.tsx(88,21): error TS2322</text>
<text x="20" y="128" font-family="monospace" font-size="14" fill="#e6edf3">  Type 'string | undefined' is not assignable to 'string'.</text>
<text x="20" y="156" font-family="monospace" font-size="14" fill="#7ee787">src/lib/wire/protocol.ts: ok</text>
<text x="20" y="176" font-family="monospace" font-size="14" fill="#ff7b72">Found 1 error in 1 file.</text>
<text x="20" y="212" font-family="monospace" font-size="14" fill="#9aa4b2">$ _</text>
</svg>`;

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#ffffff"/>
<text x="32" y="36" font-family="sans-serif" font-size="16" fill="#1f2328">Tokens per session, last 7 days</text>
<line x1="48" y1="300" x2="612" y2="300" stroke="#8c959f"/>
<rect x="84" y="176" width="48" height="124" fill="#4c7bd9"/>
<rect x="168" y="144" width="48" height="156" fill="#4c7bd9"/>
<rect x="252" y="200" width="48" height="100" fill="#4c7bd9"/>
<rect x="336" y="92" width="48" height="208" fill="#4c7bd9"/>
<rect x="420" y="120" width="48" height="180" fill="#4c7bd9"/>
<rect x="504" y="72" width="48" height="228" fill="#4c7bd9"/>
<rect x="588" y="104" width="24" height="196" fill="#4c7bd9"/>
<text x="84" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 3</text>
<text x="168" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 4</text>
<text x="252" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 5</text>
<text x="336" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 6</text>
<text x="420" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 7</text>
<text x="504" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 8</text>
<text x="588" y="324" font-family="sans-serif" font-size="12" fill="#57606a">Oct 9</text>
</svg>`;

/** Terminal screenshot attached to a tool result: a failing type check. */
export const terminalScreenshot: ImageArg = {
	type: "image",
	data: btoa(TERMINAL_SVG),
	mimeType: "image/svg+xml",
};

/** Chart screenshot attached to a stats message: tokens per session across a week. */
export const chartScreenshot: ImageArg = {
	type: "image",
	data: btoa(CHART_SVG),
	mimeType: "image/svg+xml",
};

/** Assistant answer with headings, a list, a fenced block, and a link. */
export const markdownAnswer = `## Plan for the tool-card fix

The \`ToolCard\` collapses long output, but the expand toggle loses focus after a re-render. Two changes fix it:

1. Keep a stable \`key\` on the output block so Solid reuses the node.
2. Restore focus to the toggle after \`setExpanded(true)\`.

\`\`\`ts
const [expanded, setExpanded] = createSignal(false);
\`\`\`

Run \`bun run check:types\` once the edit lands. The component lives in \`apps/web/components/tool-card/ToolCard.tsx\`:

- collapsed by default for output over **40 lines**
- \`Ctrl+Enter\` expands from the keyboard
- background notes: [tool-card notes](https://example.dev/notes/tool-card)
`;

/** Assistant answer built around a table, as the agent summarises a comparison. */
export const markdownTableAnswer = `## Which refresh paths still write after unmount

Three store actions start a request in \`onMount\` and write the answer into a shared signal, whether or not the panel is still open. Only the composer insert is guarded today:

| Action | Writes after unmount | Guarded | Fix |
| --- | :---: | :---: | --- |
| \`refreshGit\` | yes | no | add the generation check |
| \`refreshPlan\` | yes | no | add the generation check |
| \`refreshTodos\` | yes | no | add the generation check |
| \`composeForComposer\` | no | yes | none needed |

The guard is three lines per action:

\`\`\`ts
const generation = ++refreshGeneration;
const result = await call("getGit");
if (generation === refreshGeneration) setState("git", result);
\`\`\`

Run \`bun run test\` after the change; a test that unmounts before the answer lands covers all three.
`;

/** Closed fences in several languages, an unlabelled fence, an unknown language, and one still streaming (no closing fence). */
export const markdownCodeFences = `Closed fences are highlighted once the closing fence arrives.

\`\`\`ts
export function greet(name: string): string {
	// say hello
	return \`hello \${name}\` + 42;
}
\`\`\`

\`\`\`bash
for f in *.ts; do echo "$f" | grep -c "import"; done
\`\`\`

\`\`\`json
{ "name": "omp-web", "private": true, "workers": 4, "tags": ["a", null] }
\`\`\`

\`\`\`diff
- const old = 1;
+ const next = 2;
\`\`\`

An unlabelled fence and an unknown language stay plain:

\`\`\`
no language here
\`\`\`

\`\`\`klingon
qapla'
\`\`\`

This fence is still streaming, so it renders plain:

\`\`\`python
def streaming():
    return "no closing fence yet"
`;

/** Untrusted markdown: raw HTML, a script URL, and an image handler that must not run. */
export const markdownUntrusted = `Here is the summary you asked for.

<script>alert("pwned")</script>

<img src="x" onerror="alert('pwned')">

[Open the docs](javascript:alert('pwned')) and [the repo](https://github.com/example/omp-web).

| Field | Value |
| --- | --- |
| author | <b>operator</b> |
`;

/** Long markdown: several sections, a long fenced block, and a wide table, to test scrolling and wrapping. */
export const markdownLong = `# Review of the transport retry path

The retry loop in \`apps/web/store/transport.ts\` replays a command on an interval until the session process answers. This review covers the three places where that loop can leave stale state behind, and the fix for each.

## 1. Replayed commands after reconnect

A reconnect re-sends every pending command with the same id. The session process answers each id once, so a replay after a successful answer is harmless, but a replay that races a reconnect can deliver the answer to a handler that was already cleared. The current guard checks the id against the pending map, which is correct, but the map is cleared on \`disconnect\` before the new socket opens.

Suggested change: keep the pending map across a reconnect and clear entries only when the matching \`call_result\` arrives or the caller's timeout fires.

## 2. Timeout accounting

Each call sets a timer for \`timeoutMs\` (30 seconds by default). The timer is not cleared when the answer arrives first, so a late timeout can reject a promise that already resolved. Promise settlement ignores the second call, so the bug is silent, but the timer keeps the event loop busy for up to 30 seconds after a short session ends.

\`\`\`ts
export function call(method: WebMethodName, args: unknown[] = [], timeoutMs = 30_000) {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = nextCommandId();
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(\`\${method} timed out after \${timeoutMs}ms\`));
  }, timeoutMs);
  pending.set(id, { resolve, reject, timer });
  void sendCommand({ type: "call", id, method, args });
  return promise;
}
\`\`\`

Clearing the timer in the settle path removes the leak. A test that resolves the call first and advances fake timers would catch a regression.

## 3. Stale answers after a panel unmounts

\`ReviewPanel\` and \`TodoPanel\` both start a refresh in \`onMount\`. If the user leaves the panel before the answer arrives, the store still writes the result into the shared signal. The store already tracks a generation counter for composer inserts; the same counter should guard the refresh path.

| Path | Writes after unmount | Guarded today |
| --- | --- | --- |
| refreshGit | yes | no |
| refreshPlan | yes | no |
| refreshTodos | yes | no |
| composeForComposer | no | yes (generation) |

## Next steps

1. Move the timer clear into the settle path.
2. Add the generation guard to the three refresh actions.
3. Cover both with a test that unmounts before the answer.
`;

/** Picker entry: one model in the model picker. */
export interface PickerEntry {
	id: string;
	label: string;
	meta: string;
	chip?: string;
	detail?: string;
}

/** Model picker rows: a default, a fast model, a long-context model, and a gateway model. */
export const pickerModels: PickerEntry[] = [
	{
		id: "anthropic/claude-opus-5-5",
		label: "claude-opus-5-5",
		meta: "anthropic, 200k ctx",
		chip: "default",
		detail: "Deep planning and review",
	},
	{
		id: "anthropic/claude-sonnet-5-5",
		label: "claude-sonnet-5-5",
		meta: "anthropic, 200k ctx",
		chip: "smart",
	},
	{
		id: "opencode-go/deepseek-v4-flash",
		label: "deepseek-v4-flash",
		meta: "opencode-go, 128k ctx",
		chip: "fast",
		detail: "Quick edits and search",
	},
	{
		id: "minimax/minimax-m2",
		label: "minimax-m2",
		meta: "minimax, 192k ctx",
	},
	{
		id: "moonshot/kimi-k2",
		label: "kimi-k2",
		meta: "moonshot, 128k ctx",
	},
];

/** Subagent rows: one per lifecycle status; `Anna.Bob` is nested and renders as `Anna>Bob`. */
export const subagentRows: SubagentInfo[] = [
	{
		id: "Anna",
		index: 1,
		agent: "scout",
		description: "Map the tool-card components",
		status: "running",
		lastUpdate: FIXTURE_NOW - 4_000,
		parentToolCallId: "call_task_31",
	},
	{
		id: "Bora",
		index: 2,
		agent: "task",
		description: "Audit settings persistence",
		status: "pending",
		lastUpdate: FIXTURE_NOW - 60_000,
		parentToolCallId: "call_task_32",
	},
	{
		id: "Cyrus",
		index: 3,
		agent: "reviewer",
		description: "Review the transport retry path",
		status: "completed",
		lastUpdate: FIXTURE_NOW - 900_000,
		parentToolCallId: "call_task_30",
	},
	{
		id: "Dara",
		index: 4,
		agent: "task",
		description: "Check Bun lockfile drift",
		status: "failed",
		lastUpdate: FIXTURE_NOW - 1_500_000,
		parentToolCallId: "call_task_29",
	},
	{
		id: "Eli",
		index: 5,
		agent: "task",
		description: "Draft the changelog entry",
		status: "aborted",
		lastUpdate: FIXTURE_NOW - 2_400_000,
		parentToolCallId: "call_task_28",
	},
	{
		id: "Fern",
		index: 6,
		agent: "scout",
		description: "Summarize the CI failures",
		status: "parked",
		lastUpdate: FIXTURE_NOW - 3_600_000,
		parentToolCallId: "call_task_27",
	},
	{
		id: "Anna.Bob",
		index: 7,
		agent: "scout",
		description: "Trace the bash tool result path",
		status: "idle",
		lastUpdate: FIXTURE_NOW - 7_200_000,
		parentToolCallId: "call_task_26",
	},
	{
		id: "Gus",
		index: 8,
		agent: "task",
		description: "Verify the stats rollup",
		status: "started",
		lastUpdate: FIXTURE_NOW - 1_000,
		parentToolCallId: "call_task_33",
	},
];
