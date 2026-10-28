/**
 * What the theme pickers list: the linked picker shows every theme (one half per variant it
 * has), an unlinked picker only the themes that have its scheme, and type-ahead lands on the
 * option a user would expect.
 */

import { describe, expect, test } from "bun:test";
import type { ThemeEntry, ThemeScheme, ThemeVariant } from "#lib/themes/types";
import { themeOptions, typeAheadIndex } from "../../prefs/theme-picker";

const variant = (scheme: ThemeScheme): ThemeVariant => ({
	scheme,
	tokens: {} as never,
});
const theme = (id: string, schemes: ThemeScheme[]): ThemeEntry => ({
	id,
	name: id,
	source: "custom",
	variants: Object.fromEntries(schemes.map((s) => [s, variant(s)])),
});

const themes = [
	theme("both", ["dark", "light"]),
	theme("night", ["dark"]),
	theme("day", ["light"]),
];

describe("theme picker rows", () => {
	test("the linked picker lists every theme with its dark half before its light half", () => {
		expect(themeOptions(themes, "linked").map((o) => [o.entry.id, o.schemes])).toEqual([
			["both", ["dark", "light"]],
			["night", ["dark"]],
			["day", ["light"]],
		]);
	});

	test("an unlinked picker lists only the themes that have its scheme, one half each", () => {
		expect(themeOptions(themes, "dark").map((o) => [o.entry.id, o.schemes])).toEqual([
			["both", ["dark"]],
			["night", ["dark"]],
		]);
		expect(themeOptions(themes, "light").map((o) => [o.entry.id, o.schemes])).toEqual([
			["both", ["light"]],
			["day", ["light"]],
		]);
	});

	test("no themes means no rows", () => {
		expect(themeOptions([], "linked")).toEqual([]);
	});
});

describe("theme picker type-ahead", () => {
	const names = ["Catppuccin", "Gruvbox", "Everforest", "Gruvbox Hard"];

	test("a typed prefix finds the first matching name, case-insensitively", () => {
		expect(typeAheadIndex(names, "e", -1)).toBe(2);
		expect(typeAheadIndex(names, "GRU", -1)).toBe(1);
	});

	test("a single letter pressed again moves on to the next name with that initial, wrapping", () => {
		expect(typeAheadIndex(names, "g", 1)).toBe(3);
		expect(typeAheadIndex(names, "g", 3)).toBe(1);
		expect(typeAheadIndex(names, "gg", 1)).toBe(3);
	});

	test("an unmatched prefix finds nothing", () => {
		expect(typeAheadIndex(names, "z", 0)).toBe(-1);
	});
});
