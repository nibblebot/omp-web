import { BUILTIN_THEMES } from "#lib/themes/builtin";
import { parseThemeFile } from "#lib/themes/parse";
import { DEFAULT_THEME_ID } from "#lib/themes/types";
import type { ThemeEntry, ThemesPayload } from "#lib/themes/types";
import type { ThemeMode } from "../../web/prefs/theme";
import {
	changeThemeLinked,
	changeThemeMode,
	chooseLinkedTheme,
	chooseSchemeTheme,
	setState,
} from "../../web/state";

/**
 * Fixture answer of `GET /ctl/themes`: the built-ins plus a custom single-variant theme, a
 * built-in replaced by a custom file (`modified`), and two files that failed to load, so the
 * picker shows a half row, the "modified" badge and the footer's failure list.
 */

/** A custom dark-only theme, so the linked picker shows a single-half row. */
function customEntry(): ThemeEntry {
	const result = parseThemeFile(
		"dusk-terminal",
		{
			schemaVersion: 1,
			name: "Dusk Terminal",
			variants: {
				dark: {
					bg: "#14161b",
					panel: "#1b1e25",
					text: "#d8dde6",
					muted: "#8a92a0",
					border: "#2b303a",
					accent: "#e06c75",
					success: "#7bd88f",
					warning: "#e5c07b",
					error: "#ef596f",
				},
			},
		},
		"custom",
	);
	if (!result.ok) throw new Error(`fixture theme invalid: ${result.errors.join("; ")}`);
	return result.entry;
}

/** The themes payload the design server and the stories answer with. */
export function fixtureThemes(): ThemesPayload {
	return {
		dir: "/home/demo/.omp-web/themes",
		themes: [
			...BUILTIN_THEMES.map((theme) =>
				theme.id === "gruvbox" ? { ...theme, source: "modified" as const } : theme,
			),
			customEntry(),
		],
		failures: [
			{
				file: "neon-night.json",
				errors: [
					'variants.dark.accent: not a color (expected #rgb, #rrggbb, #rrggbbaa or oklch(L% C h [/ a]), got "neon")',
					"variants.dark.panel: missing required token",
				],
			},
			{
				file: "My Theme.json",
				errors: [
					'file name: "My Theme" must match ^[a-z0-9-]+$ (lowercase letters, digits and dashes)',
				],
			},
		],
	};
}

/**
 * Seed the theme store the way a story needs it: the fixture payload (what `/ctl/themes`
 * answers) and a stored selection, driven through the real actions so the prefs and the
 * root attributes follow. The default is linked Catppuccin in dark mode; an unlinked
 * selection takes `light` and `dark` ids, which may name a theme the payload lacks.
 */
export function seedThemes(
	selection: { mode?: ThemeMode; linked?: boolean; light?: string; dark?: string } = {},
): void {
	setState({ themes: fixtureThemes(), themesError: null });
	changeThemeMode(selection.mode ?? "dark");
	changeThemeLinked(true);
	chooseLinkedTheme(DEFAULT_THEME_ID);
	if (selection.linked === false) changeThemeLinked(false);
	if (selection.light !== undefined) chooseSchemeTheme("light", selection.light);
	if (selection.dark !== undefined) chooseSchemeTheme("dark", selection.dark);
}
