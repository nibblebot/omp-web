import { describe, expect, test } from "bun:test";
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, parseFontSize, rootFontSizeCss } from "../prefs/theme";

describe("in-app font size preference", () => {
	test("unset, empty or non-numeric storage gives the default", () => {
		for (const raw of [null, "", "  ", "large", "NaN", "Infinity"]) {
			expect(parseFontSize(raw), String(raw)).toBe(FONT_DEFAULT);
		}
	});

	test("values older builds stored below the new floor migrate up to it", () => {
		// Builds before the range change allowed 12..15; micro text at those sizes was 8-10px.
		for (const raw of ["12", "13", "14", "15"]) expect(parseFontSize(raw)).toBe(FONT_MIN);
		expect(parseFontSize("16")).toBe(16);
		expect(parseFontSize("18")).toBe(18);
	});

	test("values above the ceiling clamp to it and decimals round", () => {
		expect(parseFontSize("99")).toBe(FONT_MAX);
		expect(parseFontSize(String(FONT_MAX))).toBe(FONT_MAX);
		expect(parseFontSize("17.6")).toBe(18);
	});

	test("the root size is a percentage of the browser default, never px", () => {
		// The 18px default keeps its desktop size (18 / 16 of a 16px browser default).
		expect(rootFontSizeCss(FONT_DEFAULT)).toBe("112.5%");
		expect(rootFontSizeCss(16)).toBe("100%");
		expect(rootFontSizeCss(FONT_MAX)).toBe("150%");
		expect(rootFontSizeCss(FONT_MIN)).not.toContain("px");
	});
});
