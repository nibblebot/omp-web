/**
 * The pure side of the job widget components: what a glance reads, which spark a
 * mini chart draws, which blocks a compact widget shows, and a spark's geometry.
 */
import { describe, expect, test } from "bun:test";
import type { WireJobWidgetSparkBlock, WireJobWidgetView } from "#lib/wire/protocol";
import {
	jobWidgetGlance,
	jobWidgetSpark,
	jobWidgetSummary,
	latestJobWidget,
	meterFraction,
	SPARK_HEIGHT,
	SPARK_WIDTH,
	sparkGeometry,
	visibleBlocks,
} from "../../chat/job-widget";

const spark = (
	values: number[],
	over: Partial<WireJobWidgetSparkBlock> = {},
): WireJobWidgetSparkBlock => ({
	kind: "spark",
	label: "tok/s",
	values,
	min: 0,
	max: 10,
	last: values.length > 0 ? `${values.at(-1)} tok/s` : "",
	...over,
});

const view = (over: Partial<WireJobWidgetView> = {}): WireJobWidgetView => ({
	title: "bench",
	blocks: [],
	state: "live",
	updatedAt: 1,
	...over,
});

describe("jobWidgetGlance", () => {
	test("reads the headline first, with its label and trend", () => {
		expect(
			jobWidgetGlance(
				view({
					headline: {
						text: "186 tok/s",
						label: "decode",
						trend: { text: "▲ 15%", tone: "success" },
					},
					blocks: [spark([1, 2])],
				}),
			),
		).toEqual({ text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } });
	});

	test("falls back to the latest figure of the first spark with data or the first meter", () => {
		expect(jobWidgetGlance(view({ blocks: [spark([]), spark([1, 4])] }))).toEqual({
			text: "4 tok/s",
			label: "tok/s",
		});
		expect(
			jobWidgetGlance(
				view({
					blocks: [
						{ kind: "stat", items: [] },
						{ kind: "meter", label: "trials", value: 0.5, text: "5/10" },
						spark([3]),
					],
				}),
			),
		).toEqual({ text: "5/10", label: "trials" });
	});

	test("reads nothing from a view with no figure", () => {
		expect(jobWidgetGlance(view({ blocks: [{ kind: "text", text: "x" }] }))).toBeUndefined();
	});
});

describe("jobWidgetSpark", () => {
	test("cuts the first spark to its newest points, tips included", () => {
		const values = Array.from({ length: 30 }, (_, i) => i);
		const tips = values.map((value) => `t${value}`);
		const cut = jobWidgetSpark(view({ blocks: [spark(values, { tips })] }), 4);
		expect(cut?.values).toEqual([26, 27, 28, 29]);
		expect(cut?.tips).toEqual(["t26", "t27", "t28", "t29"]);
	});

	test("has none without data", () => {
		expect(jobWidgetSpark(view({ blocks: [spark([])] }))).toBeUndefined();
		expect(jobWidgetSpark(view())).toBeUndefined();
	});
});

describe("latestJobWidget and jobWidgetSummary", () => {
	test("the latest entry is the live one with the newest data", () => {
		const entries = [
			{ id: "a", view: view({ updatedAt: 5 }) },
			{ id: "b", view: view({ updatedAt: 9, state: "fallback" }) },
			{ id: "c", view: view({ updatedAt: 7 }) },
		];
		expect(latestJobWidget(entries)?.id).toBe("c");
		expect(latestJobWidget([entries[1]!])).toBeUndefined();
	});

	test("the summary joins the title and the figure", () => {
		expect(
			jobWidgetSummary(
				view({
					title: "verb-bench",
					headline: {
						text: "186 tok/s",
						label: "decode",
						trend: { text: "▲ 15%", tone: "success" },
					},
				}),
			),
		).toBe("verb-bench: decode 186 tok/s ▲ 15%");
		expect(jobWidgetSummary(view({ title: "verb-bench" }))).toBe("verb-bench");
	});
});

describe("visibleBlocks", () => {
	test("compact keeps only the primary block", () => {
		const blocks = [spark([1]), { kind: "text" as const, text: "x" }];
		expect(visibleBlocks(view({ blocks }), true)).toEqual([blocks[0]!]);
		expect(visibleBlocks(view({ blocks }), false)).toEqual(blocks);
	});
});

describe("sparkGeometry", () => {
	test("maps values over the domain, newest at the right edge, higher values higher up", () => {
		const geometry = sparkGeometry(
			spark([0, 10], { min: 0, max: 10, marks: [{ value: 5, label: "mid" }] }),
		);
		expect(geometry.xs).toEqual([0, SPARK_WIDTH]);
		expect(geometry.line).toBe(`0,${SPARK_HEIGHT - 2} ${SPARK_WIDTH},2`);
		expect(geometry.area).toBe(`${geometry.line} ${SPARK_WIDTH},${SPARK_HEIGHT} 0,${SPARK_HEIGHT}`);
		expect(geometry.marks).toEqual([{ y: SPARK_HEIGHT / 2, label: "mid" }]);
	});

	test("clamps values outside the domain and draws a flat domain at mid height", () => {
		expect(sparkGeometry(spark([99], { min: 0, max: 10 })).line).toBe(`0,2 ${SPARK_WIDTH},2`);
		expect(sparkGeometry(spark([3, 3], { min: 3, max: 3 })).line).toBe(
			`0,${SPARK_HEIGHT / 2} ${SPARK_WIDTH},${SPARK_HEIGHT / 2}`,
		);
	});
});

describe("meterFraction", () => {
	test("clamps to 0-1 and tolerates a broken scale", () => {
		expect(meterFraction(5, 10)).toBe(0.5);
		expect(meterFraction(50, 10)).toBe(1);
		expect(meterFraction(-1, 10)).toBe(0);
		expect(meterFraction(5, 0)).toBe(0);
		expect(meterFraction(Number.NaN, 10)).toBe(0);
	});
});
