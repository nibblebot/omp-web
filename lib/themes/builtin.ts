/**
 * The built-in themes, resolved once at import. The JSON files are statically
 * imported so the bundler inlines them; a broken built-in is a build bug, so it
 * throws here rather than being reported as a load failure.
 */
import catppuccin from "./builtin/catppuccin.json";
import darkVolcanic from "./builtin/dark-volcanic.json";
import everforest from "./builtin/everforest.json";
import gruvbox from "./builtin/gruvbox.json";
import kanagawa from "./builtin/kanagawa.json";
import nord from "./builtin/nord.json";
import poimandres from "./builtin/poimandres.json";
import rosePine from "./builtin/rose-pine.json";
import tokyoNight from "./builtin/tokyo-night.json";
import { parseThemeFile } from "./parse";
import type { ThemeEntry } from "./types";

const SOURCES: readonly (readonly [string, unknown])[] = [
	["catppuccin", catppuccin],
	["gruvbox", gruvbox],
	["everforest", everforest],
	["tokyo-night", tokyoNight],
	["nord", nord],
	["kanagawa", kanagawa],
	["rose-pine", rosePine],
	["poimandres", poimandres],
	["dark-volcanic", darkVolcanic],
];

/**
 * Catppuccin, Gruvbox, Everforest, Tokyo Night, Nord, Kanagawa, Rosé Pine,
 * Poimandres, Dark Volcanic, in that order. Nord, Poimandres and Dark Volcanic
 * are dark-only: their sources publish no light variant.
 */
export const BUILTIN_THEMES: readonly ThemeEntry[] = SOURCES.map(([id, json]) => {
	const result = parseThemeFile(id, json, "builtin");
	if (!result.ok)
		throw new Error(`built-in theme "${id}" is invalid:\n${result.errors.join("\n")}`);
	return result.entry;
});
