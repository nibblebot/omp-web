/**
 * Generated theme stylesheet: one `[data-theme-variant="<id>/<scheme>"]` rule per
 * variant. Browser-safe and independent of the DOM (`CSS.escape` is not used because
 * this also runs in Bun).
 */
import { THEME_SCHEMES, THEME_TOKENS } from "./types";
import type { ThemeEntry, ThemeScheme, ThemeVariant } from "./types";

/** A double-quoted CSS string body: quotes, backslashes, `<` and control characters hex-escaped. */
function escapeCssString(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		out +=
			ch === '"' || ch === "\\" || ch === "<" || code < 0x20 || code === 0x7f
				? `\\${code.toString(16)} `
				: ch;
	}
	return out;
}

/** The attribute selector that matches `<html data-theme-variant="<id>/<scheme>">`. */
export function themeVariantSelector(id: string, scheme: ThemeScheme): string {
	return `[data-theme-variant="${escapeCssString(`${id}/${scheme}`)}"]`;
}

/** One rule: `color-scheme` plus a custom property for every token. */
export function themeVariantCss(id: string, variant: ThemeVariant): string {
	let body = `color-scheme:${variant.scheme};`;
	for (const token of THEME_TOKENS) body += `--${token}:${variant.tokens[token]};`;
	return `${themeVariantSelector(id, variant.scheme)}{${body}}`;
}

/** Every variant of every theme, one rule per line (dark before light within a theme). */
export function themesCss(themes: readonly ThemeEntry[]): string {
	const rules: string[] = [];
	for (const theme of themes) {
		for (const scheme of THEME_SCHEMES) {
			const variant = theme.variants[scheme];
			if (variant) rules.push(themeVariantCss(theme.id, variant));
		}
	}
	return rules.join("\n");
}
