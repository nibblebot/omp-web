/**
 * Node-side theme loading: built-ins plus `<config dir>/themes/*.json`. Read on every
 * call (no watcher, no cache). Never throws for bad files; they become failures.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BUILTIN_THEMES } from "./builtin";
import { parseThemeFile } from "./parse";
import type { ThemeEntry, ThemeLoadFailure, ThemesPayload } from "./types";

/** `<config dir>/themes` for a resolved fleet config path. */
export function themesDirFor(configPath: string): string {
	return join(dirname(configPath), "themes");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Built-ins, then every valid custom theme in `dir`; invalid files are listed as failures. */
export async function loadThemes(dir: string): Promise<ThemesPayload> {
	const absolute = resolve(dir);
	const themes: ThemeEntry[] = [...BUILTIN_THEMES];
	const failures: ThemeLoadFailure[] = [];

	let names: string[];
	try {
		names = await readdir(absolute);
	} catch (error) {
		// A missing themes dir is normal; anything else (not a directory, permissions) is worth reporting.
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			failures.push({
				file: absolute,
				errors: [`cannot read themes directory: ${errorMessage(error)}`],
			});
		}
		return { dir: absolute, themes, failures };
	}

	const customs: ThemeEntry[] = [];
	for (const file of names.filter((n) => !n.startsWith(".") && n.endsWith(".json")).sort()) {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(join(absolute, file), "utf8"));
		} catch (error) {
			failures.push({ file, errors: [`cannot read file: ${errorMessage(error)}`] });
			continue;
		}
		const stem = basename(file, ".json");
		const builtinIndex = BUILTIN_THEMES.findIndex((theme) => theme.id === stem);
		const result = parseThemeFile(stem, raw, builtinIndex >= 0 ? "modified" : "custom");
		if (!result.ok) {
			failures.push({ file, errors: result.errors });
		} else if (builtinIndex >= 0) {
			themes[builtinIndex] = result.entry;
		} else {
			customs.push(result.entry);
		}
	}

	customs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return { dir: absolute, themes: [...themes, ...customs], failures };
}
