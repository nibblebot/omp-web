/**
 * What a job widget's view gives the components that draw it: the glance a row
 * or bar takes away, the mini chart's series, which blocks a compact widget
 * shows, and the geometry of a spark. Mirrors pi-tui's `jobWidgetGlance`,
 * `jobWidgetSpark`, `latestJobWidget` and `jobWidgetSummary` (tools/job-widget.ts)
 * over the wire view; the texts arrive clean (`parseJobWidgetView`). Pure, so it
 * stays testable without a DOM.
 */
import type {
	WireJobWidgetBlock,
	WireJobWidgetSparkBlock,
	WireJobWidgetState,
	WireJobWidgetTrend,
	WireJobWidgetView,
} from "#lib/wire/protocol";

/** What a glance at a widget reads: its headline, else the primary figure of its blocks. */
export interface JobWidgetGlanceFigure {
	text: string;
	label?: string;
	trend?: WireJobWidgetTrend;
}

/** Values the mini chart keeps from the primary spark. */
export const MINI_SPARK_POINTS = 16;

/** Spark viewBox: 100 wide however wide it is drawn, 32 tall. */
export const SPARK_WIDTH = 100;
export const SPARK_HEIGHT = 32;
const SPARK_PAD = 2;

/** The headline, else the latest figure of the first spark or meter that has data. */
export function jobWidgetGlance(view: WireJobWidgetView): JobWidgetGlanceFigure | undefined {
	if (view.headline && view.headline.text !== "") {
		const { text, label, trend } = view.headline;
		return { text, ...(label ? { label } : {}), ...(trend ? { trend } : {}) };
	}
	for (const block of view.blocks) {
		if (block.kind === "spark" && block.values.length > 0 && block.last !== "") {
			return { text: block.last, label: block.label };
		}
		if (block.kind === "meter" && block.text !== "")
			return { text: block.text, label: block.label };
	}
	return undefined;
}

/** The first spark cut to its newest `points` values; undefined without data. */
export function jobWidgetSpark(
	view: WireJobWidgetView,
	points = MINI_SPARK_POINTS,
): WireJobWidgetSparkBlock | undefined {
	const spark = view.blocks.find(
		(block): block is WireJobWidgetSparkBlock => block.kind === "spark",
	);
	if (!spark || spark.values.length === 0) return undefined;
	if (spark.values.length <= points) return spark;
	const from = spark.values.length - points;
	return {
		...spark,
		values: spark.values.slice(from),
		...(spark.tips ? { tips: spark.tips.slice(from) } : {}),
	};
}

/** The entry whose live widget (one a spec drives) saw data last. */
export function latestJobWidget<T extends { view: WireJobWidgetView }>(
	entries: readonly T[],
): T | undefined {
	let latest: T | undefined;
	for (const entry of entries) {
		if (entry.view.state !== "live") continue;
		if (!latest || entry.view.updatedAt > latest.view.updatedAt) latest = entry;
	}
	return latest;
}

/** The widget as one plain line for tooltips: `verb-bench · 3 models: decode 186 tok/s ▲ 15%`. */
export function jobWidgetSummary(view: WireJobWidgetView): string {
	const glance = jobWidgetGlance(view);
	if (!glance) return view.title;
	const figure = [glance.label, glance.text, glance.trend?.text].filter(Boolean).join(" ");
	return view.title ? `${view.title}: ${figure}` : figure;
}

/** What a view says when it has no figure: the state in words. */
export const JOB_WIDGET_STATE_LABEL: Record<WireJobWidgetState, string> = {
	authoring: "writing widget",
	live: "live",
	fallback: "basic",
};

/** The blocks a widget draws: all of them, or only the primary one when compact. */
export function visibleBlocks(view: WireJobWidgetView, compact: boolean): WireJobWidgetBlock[] {
	return compact ? view.blocks.slice(0, 1) : view.blocks;
}

/** A spark's drawing in its viewBox: the area under the series, the line, and where each reference line sits. */
export interface SparkGeometry {
	/** `polyline` points. */
	line: string;
	/** Closed `polygon` points under the line. */
	area: string;
	/** Each point's x, for tooltip hit areas. */
	xs: number[];
	/** Width of one point's hit area. */
	step: number;
	marks: { y: number; label: string; tone?: WireJobWidgetSparkBlock["tone"] }[];
}

const coord = (value: number): string => String(Math.round(value * 100) / 100);

/** Geometry of a spark over its own domain; a flat or empty domain draws at mid height. */
export function sparkGeometry(block: WireJobWidgetSparkBlock): SparkGeometry {
	const span = block.max - block.min;
	const inner = SPARK_HEIGHT - 2 * SPARK_PAD;
	const yOf = (value: number): number => {
		if (!(span > 0)) return SPARK_HEIGHT / 2;
		const fraction = Math.min(1, Math.max(0, (value - block.min) / span));
		return SPARK_HEIGHT - SPARK_PAD - fraction * inner;
	};
	const count = block.values.length;
	const xs = block.values.map((_, index) =>
		count === 1 ? SPARK_WIDTH / 2 : (index * SPARK_WIDTH) / (count - 1),
	);
	// One point draws as a short flat segment so the series stays visible.
	const drawn =
		count === 1
			? [
					[0, yOf(block.values[0] ?? 0)],
					[SPARK_WIDTH, yOf(block.values[0] ?? 0)],
				]
			: block.values.map((value, index) => [xs[index] ?? 0, yOf(value)]);
	const line = drawn.map(([x, y]) => `${coord(x ?? 0)},${coord(y ?? 0)}`).join(" ");
	const first = drawn[0];
	const last = drawn[drawn.length - 1];
	const area =
		first && last
			? `${line} ${coord(last[0] ?? 0)},${SPARK_HEIGHT} ${coord(first[0] ?? 0)},${SPARK_HEIGHT}`
			: "";
	return {
		line,
		area,
		xs,
		step: count > 1 ? SPARK_WIDTH / (count - 1) : SPARK_WIDTH,
		marks: (block.marks ?? []).map((mark) => ({
			y: yOf(mark.value),
			label: mark.label,
			...(mark.tone ? { tone: mark.tone } : {}),
		})),
	};
}

/** `value / max` clamped to 0 to 1 (0 for an empty or broken scale). */
export function meterFraction(value: number, max: number): number {
	if (!(max > 0) || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / max));
}
