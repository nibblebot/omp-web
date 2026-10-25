import type {
	WireJobWidgetBlock,
	WireJobWidgetView,
	WireJobWidgetSparkBlock,
} from "#lib/wire/protocol";
import type { ToolItem } from "../../web/state";

/** Fixed epoch so widget timestamps (and their tooltips) never drift between renders. */
const UPDATED_AT = Date.parse("2026-10-09T12:00:00Z");

/** A smooth series with a little ripple; deterministic so stories stay still. */
const series = (count: number, base: number, rise: number, wave: number): number[] =>
	Array.from(
		{ length: count },
		(_, i) => Math.round((base + rise * i + wave * Math.sin(i / 2.5)) * 10) / 10,
	);

const decodeValues = series(32, 140, 1.4, 9);
const decodeSpark: WireJobWidgetSparkBlock = {
	kind: "spark",
	label: "tok/s · nvfp4 b1",
	values: decodeValues,
	min: 120,
	max: 200,
	marks: [
		{ value: 160, label: "baseline 160", tone: "muted" },
		{ value: 190, label: "target 190", tone: "success" },
	],
	last: `${decodeValues.at(-1)} tok/s`,
	tips: decodeValues.map((value, i) => `12:${String(i).padStart(2, "0")}:00 · ${value} tok/s`),
};

const bars: WireJobWidgetBlock = {
	kind: "bars",
	label: "decode tok/s per model",
	max: 220,
	items: [
		{ label: "nvfp4 b1", value: 186, text: "186 tok/s", tone: "success" },
		{ label: "fp8 b1", value: 141, text: "141 tok/s" },
		{ label: "bf16 b1", value: 87, text: "87 tok/s", tone: "warning" },
	],
};

const meter: WireJobWidgetBlock = {
	kind: "meter",
	label: "trials",
	value: 7 / 9,
	text: "7/9 trials",
};

const stat: WireJobWidgetBlock = {
	kind: "stat",
	items: [
		{ label: "p50", text: "41 ms", trend: { text: "▼ 8%", tone: "success" } },
		{ label: "p99", text: "212 ms", trend: { text: "▲ 12%", tone: "error" } },
		{ label: "errors", text: "0", tone: "success" },
		{ label: "queue", text: "14", tone: "warning" },
	],
};

const grid: WireJobWidgetBlock = {
	kind: "grid",
	label: "CI shards",
	items: [
		{ label: "unit", text: "passed in 41s", tone: "success" },
		{ label: "lint", text: "passed in 12s", tone: "success" },
		{ label: "e2e-1", text: "running", tone: "accent" },
		{ label: "e2e-2", text: "queued", tone: "pending" },
		{ label: "types", text: "failed: 3 errors", tone: "error" },
		{ label: "docs", text: "skipped", tone: "muted" },
		{ label: "audit", text: "2 warnings", tone: "warning" },
		{ label: "bench", text: "checked", tone: "info" },
		{ label: "release", text: "waiting on you", tone: "user" },
		{ label: "cache", text: "restored", tone: "neutral" },
	],
};

const text: WireJobWidgetBlock = {
	kind: "text",
	text: "(pass) outbox resend keeps the original command id [2.3ms]",
};

/** The widget a spec-driven job draws: headline and trend, then a spark, bars, a meter, stats, a grid and the latest line. */
export const benchWidget: WireJobWidgetView = {
	title: "verb-bench · 3 models",
	headline: {
		text: "186 tok/s",
		label: "decode",
		trend: { text: "▲ 15%", tone: "success" },
	},
	stage: "Running trial 7 of 9",
	blocks: [decodeSpark, bars, meter, stat, grid, text],
	state: "live",
	updatedAt: UPDATED_AT,
};

/** One live widget per block kind, so each can be seen alone. */
export const blockWidgets: Readonly<Record<WireJobWidgetBlock["kind"], WireJobWidgetView>> = {
	spark: {
		title: "decode throughput",
		headline: { text: "186 tok/s", trend: { text: "▲ 15%", tone: "success" } },
		blocks: [decodeSpark],
		state: "live",
		updatedAt: UPDATED_AT,
	},
	bars: { title: "models", blocks: [bars], state: "live", updatedAt: UPDATED_AT },
	meter: {
		title: "trials",
		headline: { text: "78%", label: "done" },
		blocks: [meter],
		state: "live",
		updatedAt: UPDATED_AT,
	},
	stat: { title: "latency", blocks: [stat], state: "live", updatedAt: UPDATED_AT },
	grid: { title: "CI", blocks: [grid], state: "live", updatedAt: UPDATED_AT },
	text: {
		title: "bun test apps/web",
		stage: "Watching for file changes",
		blocks: [text],
		state: "live",
		updatedAt: UPDATED_AT,
	},
};

/** The model writing the spec: the model-free fallback shows meanwhile. */
export const authoringWidget: WireJobWidgetView = {
	title: "bun run dev",
	stage: "[vite] page reload apps/web/index.tsx",
	blocks: [
		{
			kind: "stat",
			items: [
				{ label: "lines", text: "1.2k" },
				{ label: "lines/s", text: "3.4" },
			],
		},
	],
	state: "authoring",
	updatedAt: UPDATED_AT,
};

/** No spec: last line and rates only. */
export const fallbackWidget: WireJobWidgetView = {
	...authoringWidget,
	title: "tail -f /var/log/app.log",
	stage: "GET /api/health 200 3ms",
	state: "fallback",
};

/** A live widget whose rules matched nothing yet. */
export const emptyWidget: WireJobWidgetView = {
	title: "bun test apps/auth --watch",
	blocks: [
		{ ...decodeSpark, label: "tests/s", values: [], last: "" },
		{ kind: "grid", label: "suites", items: [] },
		{ kind: "bars", label: "per file", items: [], max: 1 },
	],
	state: "live",
	updatedAt: UPDATED_AT,
};

/** A subagent's widget: its stage as the head, a meter of its own progress. */
export const subagentWidget: WireJobWidgetView = {
	title: "Trace the retry path",
	stage: "Writing the failing test",
	headline: { text: "62%", label: "plan" },
	blocks: [
		{
			kind: "meter",
			label: "plan",
			value: 0.62,
			text: "5/8 steps",
		},
		stat,
	],
	state: "live",
	updatedAt: UPDATED_AT,
};

/** A wait card that settled with widgets: a live benchmark, a live subagent, a still-running job's basic widget (its stage is drawn), a failed run's headline, a job without a widget. */
export const waitWidgetsTool: ToolItem = {
	kind: "tool",
	id: 9100,
	toolCallId: "call_wait_widgets",
	name: "wait",
	args: {},
	status: "done",
	output: "## Completed (2)\n\n### bg_bench [bash] - completed",
	details: {
		op: "wait",
		jobs: [
			{
				id: "bg_bench",
				type: "bash",
				status: "completed",
				label: "bun run bench:verb",
				durationMs: 142_000,
				widget: benchWidget,
			},
			{
				id: "TraceRetry",
				type: "task",
				status: "running",
				label: "Trace the retry path through the outbox",
				durationMs: 130_000,
				stage: "Writing the failing test",
				completionPercent: 62,
				widget: subagentWidget,
			},
			{
				id: "bg_dev",
				type: "bash",
				status: "running",
				label: "bun run dev",
				durationMs: 640_000,
				widget: fallbackWidget,
			},
			{
				id: "bg_ci",
				type: "bash",
				status: "failed",
				label: "gh run watch",
				durationMs: 88_000,
				exitCode: 1,
				widget: {
					...blockWidgets.grid,
					headline: {
						text: "1 of 10 failed",
						label: "shards",
						trend: { text: "types", tone: "error" },
					},
					state: "live",
				},
			},
			{
				id: "bg_plain",
				type: "bash",
				status: "completed",
				label: "bun run build:web",
				durationMs: 38_000,
			},
		],
	},
};
