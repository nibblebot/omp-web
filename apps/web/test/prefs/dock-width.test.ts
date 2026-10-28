import { describe, expect, test } from "bun:test";
import {
	clampDockWidth,
	DOCK_DEFAULT_WIDTH,
	DOCK_MAX_WIDTH,
	DOCK_MIN_WIDTH,
	maxDockWidthFor,
} from "../../prefs/dock";

describe("dock width clamp", () => {
	test("without a viewport it clamps to the fixed range", () => {
		expect(clampDockWidth(100)).toBe(DOCK_MIN_WIDTH);
		expect(clampDockWidth(5_000)).toBe(DOCK_MAX_WIDTH);
		expect(clampDockWidth(Number.NaN)).toBe(DOCK_DEFAULT_WIDTH);
	});

	test("a saved 900px dock on a 1100px viewport leaves room for the sidebar and a chat column", () => {
		expect(clampDockWidth(900, 1_100)).toBe(maxDockWidthFor(1_100));
		expect(maxDockWidthFor(1_100)).toBe(460);
	});

	test("a viewport too narrow for any side-by-side dock still yields the minimum width", () => {
		expect(maxDockWidthFor(800)).toBe(DOCK_MIN_WIDTH);
		expect(clampDockWidth(900, 800)).toBe(DOCK_MIN_WIDTH);
	});

	test("a wide viewport does not raise the cap above the maximum", () => {
		expect(maxDockWidthFor(4_000)).toBe(DOCK_MAX_WIDTH);
		expect(clampDockWidth(480, 4_000)).toBe(480);
	});
});
