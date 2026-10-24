/**
 * A job widget crossing the wire: the SDK's `JobWidgetView` (or a session file's
 * copy of one) cut to a clean, bounded view, and the glance a list row carries.
 */
import { describe, expect, test } from "bun:test";
import {
	glanceJobWidgetView,
	JOB_WIDGET_BLOCKS,
	JOB_WIDGET_GLANCE_POINTS,
	JOB_WIDGET_SPARK_POINTS,
	JOB_WIDGET_TEXT_CHARS,
	parseJobWidgetView,
} from "../job-widget";
import type { WireJobWidgetView } from "../protocol";

const spark = (count: number) => ({
	kind: "spark",
	label: "tok/s",
	values: Array.from({ length: count }, (_, i) => i),
	min: 0,
	max: count,
	marks: [{ value: 5, label: "target", tone: "success" }],
	last: "9 tok/s",
	tips: Array.from({ length: count }, (_, i) => `t${i}`),
});

describe("parseJobWidgetView", () => {
	test("rejects what is not a view", () => {
		expect(parseJobWidgetView(undefined)).toBeUndefined();
		expect(parseJobWidgetView("view")).toBeUndefined();
		expect(parseJobWidgetView([])).toBeUndefined();
		expect(parseJobWidgetView({ blocks: [] })).toBeUndefined();
	});

	test("strips escapes and control characters and cuts texts to one clean line", () => {
		const view = parseJobWidgetView({
			title: "\u001b[1;32mbench\u001b[0m\u001b]8;;http://x\u0007run\u001b]8;;\u0007\tnow",
			stage: `${"a".repeat(JOB_WIDGET_TEXT_CHARS + 50)}`,
			headline: {
				text: "186\n tok/s",
				label: "  decode ",
				trend: { text: "▲ 15%", tone: "success" },
			},
			blocks: [],
			state: "live",
			updatedAt: 7,
		});
		expect(view?.title).toBe("benchrun now");
		expect(view?.stage).toHaveLength(JOB_WIDGET_TEXT_CHARS);
		expect(view?.stage?.endsWith("\u2026")).toBe(true);
		expect(view?.headline).toEqual({
			text: "186 tok/s",
			label: "decode",
			trend: { text: "▲ 15%", tone: "success" },
		});
	});

	test("keeps the newest spark points with their tips and drops non-finite values", () => {
		const raw = spark(JOB_WIDGET_SPARK_POINTS + 10);
		raw.values[raw.values.length - 1] = Number.NaN;
		const view = parseJobWidgetView({ title: "t", blocks: [raw], state: "live", updatedAt: 1 });
		const block = view?.blocks[0];
		if (block?.kind !== "spark") throw new Error("expected a spark");
		expect(block.values).toHaveLength(JOB_WIDGET_SPARK_POINTS - 1);
		expect(block.tips).toHaveLength(block.values.length);
		expect(block.values.at(-1)).toBe(raw.values.length - 2);
		expect(block.tips?.at(-1)).toBe(`t${raw.values.length - 2}`);
		expect(block.marks).toEqual([{ value: 5, label: "target", tone: "success" }]);
	});

	test("defaults an unknown state to fallback, drops unknown blocks and tones, clamps a meter", () => {
		const view = parseJobWidgetView({
			title: "t",
			state: "stale",
			blocks: [
				{ kind: "radar" },
				{ kind: "meter", label: "m", value: 4, text: "x", tone: "nope" },
				{ kind: "grid", label: "g", items: [{ label: "a", text: "ok", tone: "nope" }] },
				"junk",
			],
		});
		expect(view?.state).toBe("fallback");
		expect(view?.updatedAt).toBe(0);
		expect(view?.blocks).toEqual([
			{ kind: "meter", label: "m", value: 1, text: "x" },
			{ kind: "grid", label: "g", items: [{ label: "a", text: "ok", tone: "neutral" }] },
		]);
	});

	test("bounds the block count", () => {
		const blocks = Array.from({ length: JOB_WIDGET_BLOCKS + 3 }, () => ({
			kind: "text",
			text: "x",
		}));
		expect(
			parseJobWidgetView({ title: "t", blocks, state: "live", updatedAt: 1 })?.blocks,
		).toHaveLength(JOB_WIDGET_BLOCKS);
	});
});

describe("glanceJobWidgetView", () => {
	const full = parseJobWidgetView({
		title: "bench",
		stage: "trial 7",
		headline: { text: "186 tok/s" },
		blocks: [
			{ kind: "stat", items: [{ label: "p50", text: "41 ms" }] },
			spark(40),
			{ kind: "meter", label: "trials", value: 0.5, text: "5/10" },
			spark(5),
			{ kind: "text", text: "line" },
		],
		state: "live",
		updatedAt: 9,
	}) as WireJobWidgetView;

	test("keeps the head and only the first spark (cut, no tips or marks) and the first meter, in order", () => {
		const glance = glanceJobWidgetView(full);
		expect(glance).toMatchObject({ title: "bench", stage: "trial 7", state: "live", updatedAt: 9 });
		expect(glance.blocks.map((block) => block.kind)).toEqual(["spark", "meter"]);
		const block = glance.blocks[0];
		if (block?.kind !== "spark") throw new Error("expected a spark");
		expect(block.values).toHaveLength(JOB_WIDGET_GLANCE_POINTS);
		expect(block.values.at(-1)).toBe(39);
		expect(block).not.toHaveProperty("tips");
		expect(block).not.toHaveProperty("marks");
	});

	test("is far smaller than the view it cuts", () => {
		expect(JSON.stringify(glanceJobWidgetView(full)).length).toBeLessThan(
			JSON.stringify(full).length / 2,
		);
	});

	test("leaves a view without a spark or meter with no blocks", () => {
		const view = parseJobWidgetView({
			title: "t",
			blocks: [{ kind: "text", text: "x" }],
			state: "fallback",
			updatedAt: 1,
		}) as WireJobWidgetView;
		expect(glanceJobWidgetView(view).blocks).toEqual([]);
	});
});
