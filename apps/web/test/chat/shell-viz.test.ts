/** The pure helpers of the bash card's shell visualization: replay clock text, replay gating, row access, notes. */
import { describe, expect, test } from "bun:test";
import type { ShellVizRowDto } from "#lib/wire/protocol";
import {
	formatShellVizTime,
	shellVizOmitted,
	shellVizReplayable,
	shellVizRowText,
	shellVizRows,
	shellVizTimelineLabel,
	shellVizUnavailableNote,
	type ShellVizView,
} from "../../chat/shell-viz";

const row = (...texts: string[]): ShellVizRowDto => ({
	depth: 0,
	segments: texts.map((text) => ({ text })),
});

const view = (over: Partial<ShellVizView> = {}): ShellVizView => ({
	available: true,
	running: false,
	status: 0,
	pseudo: [row("a = ", '"1"')],
	raw: [row("a=1"), row("b=2")],
	timeline: { length: 65, cursor: 65, elapsedNs: 31_883_506, durationNs: 31_883_506 },
	...over,
});

describe("formatShellVizTime", () => {
	test("reads ns as µs, ms or seconds", () => {
		expect(formatShellVizTime(0)).toBe("0 ms");
		expect(formatShellVizTime(Number.NaN)).toBe("0 ms");
		expect(formatShellVizTime(37_348)).toBe("37 µs");
		expect(formatShellVizTime(3_400_000)).toBe("3.4 ms");
		expect(formatShellVizTime(31_883_506)).toBe("32 ms");
		expect(formatShellVizTime(2_500_000_000)).toBe("2.50 s");
		expect(formatShellVizTime(42_000_000_000)).toBe("42.0 s");
	});
});

describe("shellVizTimelineLabel", () => {
	test("names the step and the elapsed run time", () => {
		expect(
			shellVizTimelineLabel({ length: 65, cursor: 12, elapsedNs: 343_495, durationNs: 31_883_506 }),
		).toBe("Step 12 of 65 · 343 µs of 32 ms");
	});
});

describe("shellVizReplayable", () => {
	test("only a finished run with history to step through", () => {
		expect(shellVizReplayable(view())).toBe(true);
		expect(shellVizReplayable(view({ running: true }))).toBe(false);
		expect(
			shellVizReplayable(view({ timeline: { length: 1, cursor: 1, elapsedNs: 0, durationNs: 0 } })),
		).toBe(false);
		expect(
			shellVizReplayable(view({ timeline: { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0 } })),
		).toBe(false);
	});
});

describe("rows and notes", () => {
	test("rows follow the chosen rendering", () => {
		expect(shellVizRows(view(), "pseudo")).toHaveLength(1);
		expect(shellVizRows(view(), "raw")).toHaveLength(2);
	});

	test("omitted rows are counted per rendering", () => {
		expect(shellVizOmitted(view(), "raw")).toBe(0);
		expect(shellVizOmitted(view({ omittedRows: { pseudo: 7, raw: 2 } }), "pseudo")).toBe(7);
		expect(shellVizOmitted(view({ omittedRows: { pseudo: 7, raw: 2 } }), "raw")).toBe(2);
	});

	test("a row's text joins its runs", () => {
		expect(shellVizRowText(row("a = ", '"1"'))).toBe('a = "1"');
	});

	test("every unavailable reason has its own note", () => {
		const notes = (["unknown_call", "no_trace", "invalid_trace"] as const).map(
			shellVizUnavailableNote,
		);
		expect(new Set(notes).size).toBe(3);
	});
});
