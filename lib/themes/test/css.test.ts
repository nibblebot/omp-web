import { describe, expect, test } from "bun:test";
import { BUILTIN_THEMES } from "../builtin";
import { themeVariantCss, themeVariantSelector, themesCss } from "../css";
import { parseThemeFile } from "../parse";
import { THEME_SCHEMES, THEME_TOKENS } from "../types";
import type { ThemeEntry } from "../types";
import { themeDoc } from "./fixtures.testkit";

function entry(id: string, light = true): ThemeEntry {
	const result = parseThemeFile(id, themeDoc(id, { light }), "custom");
	if (!result.ok) throw new Error(result.errors.join("\n"));
	return result.entry;
}

describe("themeVariantSelector", () => {
	test("selects by data-theme-variant", () => {
		expect(themeVariantSelector("catppuccin", "dark")).toBe(
			'[data-theme-variant="catppuccin/dark"]',
		);
		expect(themeVariantSelector("my-theme-2", "light")).toBe(
			'[data-theme-variant="my-theme-2/light"]',
		);
	});

	test("escapes characters that could break out of the attribute string or the style element", () => {
		const selector = themeVariantSelector('a"]{x}</style><b', "dark");
		expect(selector).toBe('[data-theme-variant="a\\22 ]{x}\\3c /style>\\3c b/dark"]');
		expect(selector).not.toContain("<");
		expect(themeVariantSelector("a\\b\nc", "dark")).toBe(
			'[data-theme-variant="a\\5c b\\a c/dark"]',
		);
	});
});

describe("themeVariantCss", () => {
	test("is one rule with color-scheme and every token as a custom property", () => {
		const theme = entry("mine");
		for (const scheme of ["dark", "light"] as const) {
			const css = themeVariantCss(theme.id, theme.variants[scheme]!);
			expect(css.startsWith(`[data-theme-variant="mine/${scheme}"]{color-scheme:${scheme};`)).toBe(
				true,
			);
			expect(css.endsWith("}")).toBe(true);
			expect(css.match(/\{/g)).toHaveLength(1);
			for (const token of THEME_TOKENS) {
				expect(css).toContain(`--${token}:${theme.variants[scheme]!.tokens[token]};`);
			}
		}
	});
});

describe("themesCss", () => {
	test("emits dark then light per theme and skips missing variants", () => {
		const css = themesCss([entry("one"), entry("two", false)]);
		const selectors = [...css.matchAll(/^(\[data-theme-variant="[^"]+"\])\{/gm)].map((m) => m[1]);
		expect(selectors).toEqual([
			'[data-theme-variant="one/dark"]',
			'[data-theme-variant="one/light"]',
			'[data-theme-variant="two/dark"]',
		]);
	});

	test("covers every built-in variant and an empty list is empty", () => {
		const css = themesCss(BUILTIN_THEMES);
		for (const theme of BUILTIN_THEMES) {
			for (const scheme of THEME_SCHEMES) {
				const selector = `[data-theme-variant="${theme.id}/${scheme}"]`;
				if (theme.variants[scheme]) expect(css).toContain(selector);
				else expect(css).not.toContain(selector);
			}
		}
		expect(themesCss([])).toBe("");
	});
});
