import { describe, expect, test } from "bun:test";
import {
	composite,
	contrastRatio,
	formatColor,
	formatOklch,
	hslHue,
	isColor,
	mix,
	parseColor,
	toOklch,
} from "../color";

describe("parseColor", () => {
	test("reads #rgb, #rrggbb and #rrggbbaa", () => {
		expect(parseColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
		expect(parseColor("#1E1E2E")).toEqual({ r: 30, g: 30, b: 46, a: 1 });
		expect(parseColor("#00000080")?.a).toBeCloseTo(128 / 255, 5);
	});

	test("reads oklch with and without alpha", () => {
		expect(parseColor("oklch(100% 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseColor("oklch(0% 0 0)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
		expect(parseColor("oklch(70% 0.1 200 / 0.4)")?.a).toBeCloseTo(0.4, 5);
		expect(parseColor("oklch(70% 0.1 200 / 40%)")?.a).toBeCloseTo(0.4, 5);
		expect(parseColor("oklch(70% 0.1 200deg)")).not.toBeNull();
	});

	test.each([
		"rgb(1, 2, 3)",
		"rgba(1, 2, 3, 0.5)",
		"hsl(10 20% 30%)",
		"red",
		"transparent",
		"#abcd",
		"#12345",
		"#gggggg",
		"fff",
		"oklch(70 0.1 200)",
		"oklch(70% -0.1 200)",
		"oklch(70% 0.1)",
		"oklch(none 0.1 200)",
		"",
	])("rejects %p", (value) => {
		expect(parseColor(value)).toBeNull();
		expect(isColor(value)).toBe(false);
	});

	test("isColor rejects non-strings", () => {
		expect(isColor(12)).toBe(false);
		expect(isColor(null)).toBe(false);
	});
});

describe("formatting", () => {
	test("hex round-trips through the parser, alpha only when translucent", () => {
		expect(formatColor({ r: 30, g: 30, b: 46, a: 1 })).toBe("#1e1e2e");
		expect(formatColor({ r: 17, g: 17, b: 27, a: 0.65 })).toBe("#11111ba6");
		expect(parseColor(formatColor({ r: 1, g: 2, b: 3, a: 0.5 }))).toEqual({
			r: 1,
			g: 2,
			b: 3,
			a: 128 / 255,
		});
	});

	test("oklch survives a round trip within a rounding step", () => {
		for (const hex of ["#89b4fa", "#a6e3a1", "#f38ba8", "#256f1a", "#92400e"]) {
			const lch = toOklch(parseColor(hex)!);
			expect(formatOklch(lch.l, lch.c, lch.h)).toBe(hex);
		}
	});

	test("out-of-gamut oklch is brought into gamut", () => {
		const color = parseColor("oklch(60% 0.4 140)")!;
		for (const channel of [color.r, color.g, color.b]) {
			expect(channel).toBeGreaterThanOrEqual(0);
			expect(channel).toBeLessThanOrEqual(255);
		}
	});
});

describe("contrast and compositing", () => {
	test("black on white is 21:1 and the ratio is symmetric", () => {
		const black = parseColor("#000000")!;
		const white = parseColor("#ffffff")!;
		expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
		expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
		expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
	});

	test("matches a known WCAG value", () => {
		// #767676 on white is the classic 4.54:1 AA threshold gray.
		expect(contrastRatio(parseColor("#767676")!, parseColor("#ffffff")!)).toBeCloseTo(4.54, 2);
	});

	test("alpha composites over an opaque background", () => {
		const over = composite({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 255, a: 1 });
		expect(over).toEqual({ r: 128, g: 0, b: 128, a: 1 });
	});

	test("mix takes pct of the first color", () => {
		expect(mix({ r: 100, g: 0, b: 0, a: 1 }, { r: 0, g: 100, b: 0, a: 1 }, 25)).toEqual({
			r: 25,
			g: 75,
			b: 0,
			a: 1,
		});
	});

	test("hslHue reports degrees and null for grays", () => {
		expect(hslHue(parseColor("#ff0000")!)).toBe(0);
		expect(hslHue(parseColor("#00ff00")!)).toBe(120);
		expect(hslHue(parseColor("#808080")!)).toBeNull();
	});
});
