import type { ToolItem } from "../../web/state";

/** FindToolCard fixtures: `details` mirror the SDK's FindToolDetails (pi-tui tools/find.ts), `output` its text result. */

const stats = {
	listed: 412,
	requests: 6,
	failed: 0,
	unanswered: 0,
	judged: 412,
	filesRead: 9,
	fileBytes: 61_440,
	inputTokens: 18_400,
	outputTokens: 220,
	cost: 0.0142,
	apiMs: 3_900,
	windowsJudged: 21,
	windowsPruned: 4,
	mapCards: 0,
	failures: [] as string[],
};

const hits = [
	{
		rel: "apps/session/retry-policy.ts",
		contentScore: 0.93,
		nameScore: 0.6,
		linesSeen: 184,
		truncated: false,
		ranges: [
			{
				start: 41,
				end: 58,
				p: 0.93,
				snippet: "export function backoffDelay(attempt: number): number {",
			},
			{
				start: 12,
				end: 12,
				p: 0.71,
				snippet: "const MAX_ATTEMPTS = 3;",
			},
		],
	},
	{
		rel: "apps/web/store/retry.ts",
		contentScore: 0.58,
		linesSeen: 96,
		truncated: false,
		ranges: [
			{
				start: 20,
				end: 33,
				p: 0.58,
				snippet: 'if (frame.kind === "retry") setState("retry", { attempt: frame.attempt });',
			},
		],
	},
	{
		rel: "docs/src/content/docs/architecture.md",
		contentScore: 0.31,
		linesSeen: 600,
		truncated: true,
		ranges: [
			{
				start: 233,
				end: 240,
				p: 0.31,
				snippet: "Transient provider errors retry with exponential backoff.",
			},
		],
	},
];

const text = (lines: string[]) => lines.join("\n");

const doneOutput = text([
	'3 hit(s) for "where are provider retries backed off" (τ 0.30), strongest first',
	"",
	"apps/session/retry-policy.ts  0.93  184 lines judged",
	"  apps/session/retry-policy.ts:41-58  0.93  export function backoffDelay(attempt: number): number {",
	"apps/web/store/retry.ts  0.58  96 lines judged",
	"docs/src/content/docs/architecture.md  0.31  600 lines judged, partial",
]);

const base = { kind: "tool", status: "done", output: "" } as const;

/** FindToolCard: three ranked hits, strong to weak. */
export const findDoneTool: ToolItem = {
	...base,
	id: 9101,
	toolCallId: "call_find_9101",
	name: "find",
	args: { query: "where are provider retries backed off", grep_keywords: ["backoff", "retry"] },
	output: doneOutput,
	details: {
		query: "where are provider retries backed off",
		keywords: ["backoff", "retry", "provider"],
		threshold: 0.3,
		hits,
		coverage: "complete",
		stats,
		elapsedMs: 4_200,
		cwd: "/work/omp-web",
	},
};

/** FindToolCard: a path scope narrower than the session cwd. */
export const findScopedTool: ToolItem = {
	...findDoneTool,
	id: 9102,
	toolCallId: "call_find_9102",
	args: { query: "where are provider retries backed off", path: "apps/session" },
	details: {
		...(findDoneTool.details as object),
		hits: hits.slice(0, 1),
		scopePath: "apps/session/",
	},
};

/** FindToolCard: the 20 s budget ran out; the hits verified so far came back partial. */
export const findTimedOutTool: ToolItem = {
	...findDoneTool,
	id: 9103,
	toolCallId: "call_find_9103",
	output: text([
		doneOutput.split("\n")[0]!,
		"partial: timed out after 20s with 12 of 40 passages verified; unverified files may still match. Narrow `path` for a complete search.",
		"",
		"apps/session/retry-policy.ts  0.93  184 lines judged",
		"apps/web/store/retry.ts  0.58  96 lines judged",
	]),
	details: {
		...(findDoneTool.details as object),
		hits: hits.slice(0, 2),
		coverage: "partial",
		timeout: { verified: 12, passages: 40 },
		elapsedMs: 20_010,
		stats: { ...stats, filesRead: 31, inputTokens: 71_300, cost: 0.0561, apiMs: 19_400 },
	},
};

/** FindToolCard: nothing cleared the threshold. */
export const findNoHitsTool: ToolItem = {
	...findDoneTool,
	id: 9104,
	toolCallId: "call_find_9104",
	args: { query: "kubernetes operator reconcile loop" },
	output: 'no hits for "kubernetes operator reconcile loop" (τ 0.30)',
	details: {
		query: "kubernetes operator reconcile loop",
		keywords: ["kubernetes", "operator", "reconcile"],
		threshold: 0.3,
		hits: [],
		coverage: "complete",
		stats: { ...stats, filesRead: 0, inputTokens: 5_100, cost: 0.0031 },
		elapsedMs: 1_800,
		cwd: "/work/omp-web",
	},
};

/** FindToolCard: in flight, with the tool's progress message. */
export const findRunningTool: ToolItem = {
	...base,
	id: 9105,
	toolCallId: "call_find_9105",
	name: "find",
	status: "running",
	args: { query: "where are provider retries backed off", path: "apps/session" },
	output: "verifying 14 passages",
};

/** FindToolCard: details of an unknown shape fall back to the raw output text. */
export const findUnknownShapeTool: ToolItem = {
	...findDoneTool,
	id: 9106,
	toolCallId: "call_find_9106",
	details: { hits: "not a list" },
};
