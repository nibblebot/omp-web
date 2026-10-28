/**
 * What a theme picker lists: the pure half of `ThemePicker.tsx`, kept apart so the
 * row set and type-ahead have one definition and need no DOM to check.
 */
import { THEME_SCHEMES } from "#lib/themes/types";
import type { ThemeEntry, ThemeScheme } from "#lib/themes/types";

/** `linked`: one picker of themes, each row split into its dark and light halves; a scheme: the unlinked picker of that scheme. */
export type ThemePickerKind = "linked" | ThemeScheme;

/** One picker row: a theme and the variants (dark before light) the row shows as halves. */
export interface ThemeOption {
	entry: ThemeEntry;
	schemes: ThemeScheme[];
}

/** Value of `data-theme-variant` for a variant: the attribute the generated stylesheet keys on. */
export function themeVariantKey(id: string, scheme: ThemeScheme): string {
	return `${id}/${scheme}`;
}

/**
 * The rows of a picker. The linked picker lists every theme with all its variants (a
 * single-variant theme gets one half); an unlinked picker lists the themes that have
 * that scheme's variant, each as one full-width half.
 */
export function themeOptions(themes: readonly ThemeEntry[], kind: ThemePickerKind): ThemeOption[] {
	const options: ThemeOption[] = [];
	for (const entry of themes) {
		const schemes = THEME_SCHEMES.filter(
			(scheme) => entry.variants[scheme] !== undefined && (kind === "linked" || kind === scheme),
		);
		if (schemes.length > 0) options.push({ entry, schemes });
	}
	return options;
}

/** Index of the next option whose name starts with `typed` (case-insensitive), searching forward from `from` and wrapping; -1 when none. */
export function typeAheadIndex(names: readonly string[], typed: string, from: number): number {
	const needle = typed.toLowerCase();
	// A single repeated letter cycles through the names with that initial, so the search starts after the current option.
	const cycling = needle.length > 1 && [...needle].every((ch) => ch === needle[0]);
	const prefix = cycling ? needle[0]! : needle;
	const start = cycling || needle.length === 1 ? from + 1 : Math.max(from, 0);
	for (let step = 0; step < names.length; step++) {
		const i = (start + step) % names.length;
		if (names[i]!.toLowerCase().startsWith(prefix)) return i;
	}
	return -1;
}
