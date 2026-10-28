import { describe, expect, test } from "bun:test";
import { BUILTIN_THEMES } from "../builtin";
import { isColor } from "../color";
import { DEFAULT_THEME_ID, THEME_SCHEMES, THEME_TOKENS } from "../types";

describe("BUILTIN_THEMES", () => {
	test("are listed in their fixed order with the variants their sources publish", () => {
		expect(
			BUILTIN_THEMES.map((t) => [
				t.id,
				t.name,
				t.source,
				THEME_SCHEMES.filter((scheme) => t.variants[scheme]?.scheme === scheme),
			]),
		).toEqual([
			["catppuccin", "Catppuccin", "builtin", ["dark", "light"]],
			["gruvbox", "Gruvbox", "builtin", ["dark", "light"]],
			["everforest", "Everforest", "builtin", ["dark", "light"]],
			["tokyo-night", "Tokyo Night", "builtin", ["dark", "light"]],
			["nord", "Nord", "builtin", ["dark"]],
			["kanagawa", "Kanagawa", "builtin", ["dark", "light"]],
			["rose-pine", "Rosé Pine", "builtin", ["dark", "light"]],
			["poimandres", "Poimandres", "builtin", ["dark"]],
			["dark-volcanic", "Dark Volcanic", "builtin", ["dark"]],
		]);
		expect(BUILTIN_THEMES[0]!.id).toBe(DEFAULT_THEME_ID);
	});

	test("resolve every token to a valid color", () => {
		for (const theme of BUILTIN_THEMES) {
			for (const scheme of THEME_SCHEMES) {
				const variant = theme.variants[scheme];
				if (!variant) continue;
				for (const token of THEME_TOKENS) expect(isColor(variant.tokens[token])).toBe(true);
			}
		}
	});

	test("catppuccin keeps the original Mocha and Latte palette", () => {
		const [mocha, latte] = [
			BUILTIN_THEMES[0]!.variants.dark!.tokens,
			BUILTIN_THEMES[0]!.variants.light!.tokens,
		];
		expect(mocha).toMatchObject({
			bg: "#1e1e2e",
			panel: "#313244",
			text: "#cdd6f4",
			accent: "#89b4fa",
			backdrop: "#11111ba6",
		});
		expect(latte).toMatchObject({
			bg: "#eff1f5",
			panel: "#ffffff",
			text: "#4c4f69",
			accent: "#1a55d6",
			"accent-border": "#1e66f566",
		});
	});

	test("gruvbox and everforest use their medium palettes", () => {
		expect(BUILTIN_THEMES[1]!.variants.dark!.tokens.bg).toBe("#282828");
		expect(BUILTIN_THEMES[1]!.variants.light!.tokens.bg).toBe("#fbf1c7");
		expect(BUILTIN_THEMES[2]!.variants.dark!.tokens.bg).toBe("#2d353b");
		expect(BUILTIN_THEMES[2]!.variants.light!.tokens.panel).toBe("#fdf6e3");
	});
});
