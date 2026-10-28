/**
 * The built-in themes, resolved once at import. The JSON files are statically
 * imported so the bundler inlines them; a broken built-in is a build bug, so it
 * throws here rather than being reported as a load failure.
 */
import catppuccin from "./builtin/catppuccin.json";
import everforest from "./builtin/everforest.json";
import gruvbox from "./builtin/gruvbox.json";
import { parseThemeFile } from "./parse";
import type { ThemeEntry } from "./types";

const SOURCES: readonly (readonly [string, unknown])[] = [
	["catppuccin", catppuccin],
	["gruvbox", gruvbox],
	["everforest", everforest],
];

/** Catppuccin, Gruvbox, Everforest, in that order. */
export const BUILTIN_THEMES: readonly ThemeEntry[] = SOURCES.map(([id, json]) => {
	const result = parseThemeFile(id, json, "builtin");
	if (!result.ok)
		throw new Error(`built-in theme "${id}" is invalid:\n${result.errors.join("\n")}`);
	return result.entry;
});
