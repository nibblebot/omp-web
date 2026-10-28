import type { ThemeScheme, ThemesPayload } from "#lib/themes/types";
import {
	applyStoredTheme,
	applyThemesPayload,
	currentThemeSelection,
	selectLinkedTheme,
	selectSchemeTheme,
	setThemeLinked,
	setThemeMode,
	type ThemeMode,
} from "../prefs/theme";
import { setState, state } from "../state";
import { authedFetch } from "./auth";
import { ctlError } from "./settings";

/**
 * Theme domain: the fleet's theme list (GET /ctl/themes, built-ins plus the
 * custom files in the config dir) mirrored into state.themes, and the stored
 * mode/theme selection mirrored into state.themeSelection. The persistence and
 * DOM work lives in prefs/theme.ts; these actions only keep the mirrors current.
 */

let inflight: Promise<void> | null = null;

/**
 * Fetch the theme list, install its stylesheet and re-apply the selection.
 * Single-flight: callers during a fetch share it. Failure sets
 * state.themesError and keeps the previous payload (and its stylesheet).
 */
export function reloadThemes(): Promise<void> {
	inflight ??= (async () => {
		setState("themesLoading", true);
		try {
			const res = await (state.authStatus !== "disabled" ? authedFetch : fetch)("/ctl/themes");
			if (!res.ok) throw new Error(await ctlError(res));
			const payload = (await res.json()) as ThemesPayload;
			applyThemesPayload(payload);
			setState({
				themes: payload,
				themesError: null,
				themeSelection: currentThemeSelection(),
			});
		} catch (err) {
			setState("themesError", err instanceof Error ? err.message : String(err));
		} finally {
			setState("themesLoading", false);
			inflight = null;
		}
	})();
	return inflight;
}

export function changeThemeMode(mode: ThemeMode): void {
	setState("themeSelection", setThemeMode(mode));
}

/** The linked picker chose a theme (a single-variant theme unlinks, see selectLinkedTheme). */
export function chooseLinkedTheme(id: string): void {
	setState("themeSelection", selectLinkedTheme(id));
}

/** An unlinked picker chose a theme for one scheme. */
export function chooseSchemeTheme(scheme: ThemeScheme, id: string): void {
	setState("themeSelection", selectSchemeTheme(scheme, id));
}

/** The chain toggle (relinking moves both schemes to one family, see setThemeLinked). */
export function changeThemeLinked(linked: boolean): void {
	setState("themeSelection", setThemeLinked(linked));
}

/** Re-apply the stored selection after another document wrote it (design system embeds). */
export function resyncTheme(): void {
	applyStoredTheme();
	setState("themeSelection", currentThemeSelection());
}
