import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_THEMES } from "#lib/themes/builtin";
import { DEFAULT_THEME_ID, THEME_TOKENS } from "#lib/themes/types";
import type { ThemeScheme } from "#lib/themes/types";

const tokensCss = readFileSync(
	join(import.meta.dir, "..", "..", "styles", "tokens.css"),
	"utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations (`color-scheme`, `--token`) of the first block opened by `selector`. */
function declarations(selector: string): Map<string, string> {
	const open = tokensCss.indexOf(`${selector} {`);
	if (open === -1) throw new Error(`${selector} block not found in styles/tokens.css`);
	const body = tokensCss.slice(tokensCss.indexOf("{", open) + 1, tokensCss.indexOf("\n}", open));
	return new Map([...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const fallbacks: Record<ThemeScheme, string> = {
	dark: ":root",
	light: ':root:where([data-scheme="light"])',
};

describe("tokens.css first-visit fallback palette", () => {
	const theme = BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
	for (const scheme of ["dark", "light"] as const) {
		test(`${fallbacks[scheme]} equals the derived ${DEFAULT_THEME_ID} ${scheme} tokens`, () => {
			const css = declarations(fallbacks[scheme]);
			expect(css.get("color-scheme")).toBe(scheme);
			const tokens = theme.variants[scheme]!.tokens;
			for (const token of THEME_TOKENS) expect(css.get(`--${token}`), token).toBe(tokens[token]);
		});
	}
});
