import { themeVariantCss, themesCss } from "#lib/themes/css";
import { DEFAULT_THEME_ID, THEME_SCHEMES, THEME_STEM_PATTERN } from "#lib/themes/types";
import type { ThemeEntry, ThemeScheme, ThemesPayload, ThemeVariant } from "#lib/themes/types";

/**
 * Theme preferences and the root attributes that select a palette.
 *
 * Themes are data: the generated stylesheet (`lib/themes/css.ts`) holds one
 * `[data-theme-variant="<id>/<scheme>"]` block per variant, and the root picks
 * one through `data-theme-variant` (light-only CSS keys on `data-scheme`). This
 * module is store-free: it persists the selection in localStorage, applies it,
 * installs the stylesheet, and caches what the boot script in index.html needs
 * to paint the right palette before any JS or network answer.
 */

export type ThemeMode = "system" | "light" | "dark";

/** Mode choices in display order. */
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/**
 * The persisted selection. `light` / `dark` are theme ids and may name a theme
 * that no longer exists (see `unavailableSchemes`); `linked` means one picker
 * drives both.
 */
export interface ThemeSelection {
	mode: ThemeMode;
	linked: boolean;
	light: string;
	dark: string;
}

// The old single `omp-web:theme` key is deliberately not read: everyone resets to defaults.
const KEY_MODE = "omp-web:theme-mode";
const KEY_LINKED = "omp-web:theme-linked";
const KEY_LIGHT = "omp-web:theme-light";
const KEY_DARK = "omp-web:theme-dark";
/** `bg` of the applied variant, for the boot script's first paint. */
const KEY_BG = "omp-web:theme-bg";
/** CSS of the selected light and dark variants, for the boot script's first paint. */
const KEY_CSS = "omp-web:theme-css";
const FONT_KEY = "omp-web:font-size";
/**
 * The in-app size is a "px at the browser's default 16px" number, so the stored
 * values older builds wrote (12..18) keep their meaning. `applyFontSize` turns it
 * into a percentage of the browser's default root size, which lets the browser or
 * OS text-scaling setting (Android Chrome "Font size") scale the whole UI too.
 * The floor keeps `--fs-micro` (0.688rem) at 11px; the ceiling serves low vision.
 */
export const FONT_MIN = 16;
export const FONT_MAX = 24;
export const FONT_DEFAULT = 18;
/** The root size a browser starts from; the divisor that makes the percentage relative. */
const BROWSER_DEFAULT_PX = 16;

/** The generated stylesheet's element; index.html's boot script installs the cached copy under the same id. */
const STYLE_ID = "omp-themes";

/** The last payload applied; null until `/ctl/themes` answers (the stored ids are trusted until then). */
let payload: ThemesPayload | null = null;

function readStored(key: string): string | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
	} catch {
		return null; // storage blocked: behave as unset
	}
}

function writeStored(key: string, value: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
	} catch {
		// storage blocked or full: the selection still applies for this page
	}
}

function storedThemeId(key: string): string {
	const stored = readStored(key);
	return stored !== null && THEME_STEM_PATTERN.test(stored) ? stored : DEFAULT_THEME_ID;
}

/** The stored selection; every field falls back to its default when unset or malformed. */
export function currentThemeSelection(): ThemeSelection {
	const mode = readStored(KEY_MODE);
	return {
		mode: mode === "light" || mode === "dark" ? mode : "system",
		linked: readStored(KEY_LINKED) !== "false",
		light: storedThemeId(KEY_LIGHT),
		dark: storedThemeId(KEY_DARK),
	};
}

function osScheme(): ThemeScheme {
	return typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-color-scheme: light)").matches === true
		? "light"
		: "dark";
}

/** The scheme in effect: an explicit mode, else the OS preference. */
export function effectiveScheme(selection: ThemeSelection = currentThemeSelection()): ThemeScheme {
	return selection.mode === "system" ? osScheme() : selection.mode;
}

function findTheme(themes: ThemesPayload | null, id: string): ThemeEntry | undefined {
	return themes?.themes.find((theme) => theme.id === id);
}

/**
 * Whether `id` can render for `scheme`. True before any payload loads (the
 * stored id is trusted until `/ctl/themes` answers).
 */
export function isThemeAvailable(
	themes: ThemesPayload | null,
	id: string,
	scheme: ThemeScheme,
): boolean {
	return themes === null || findTheme(themes, id)?.variants[scheme] !== undefined;
}

/** Schemes whose stored theme is missing from a loaded payload: it renders `DEFAULT_THEME_ID` while the stored id is kept. */
export function unavailableSchemes(
	themes: ThemesPayload | null,
	selection: ThemeSelection,
): ThemeScheme[] {
	return THEME_SCHEMES.filter((scheme) => !isThemeAvailable(themes, selection[scheme], scheme));
}

/** The id that actually renders for `scheme`: the stored one, or the default when it is unavailable. */
function renderedId(selection: ThemeSelection, scheme: ThemeScheme): string {
	return isThemeAvailable(payload, selection[scheme], scheme)
		? selection[scheme]
		: DEFAULT_THEME_ID;
}

/**
 * The effective in-app size for a stored string: unset or non-numeric gives the
 * default, anything else is clamped to `[FONT_MIN, FONT_MAX]` (this migrates the
 * 12..15 values older builds allowed up to the new floor).
 */
export function parseFontSize(raw: string | null): number {
	if (raw === null || raw.trim() === "") return FONT_DEFAULT;
	const n = Number(raw);
	if (!Number.isFinite(n)) return FONT_DEFAULT;
	return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

/** The root `font-size` for an in-app size: a percentage of the browser default, never px. */
export function rootFontSizeCss(size: number): string {
	return `${(size / BROWSER_DEFAULT_PX) * 100}%`;
}

export function currentFontSize(): number {
	return parseFontSize(readStored(FONT_KEY));
}

/** Cache what the boot script needs: the applied variant's `bg` and the CSS of both selected variants. */
function refreshBootCaches(selection: ThemeSelection, applied: ThemeScheme): void {
	if (payload === null) return;
	const rules: string[] = [];
	let bg: string | undefined;
	for (const scheme of THEME_SCHEMES) {
		const id = renderedId(selection, scheme);
		const variant: ThemeVariant | undefined = findTheme(payload, id)?.variants[scheme];
		if (variant === undefined) continue;
		rules.push(themeVariantCss(id, variant));
		if (scheme === applied) bg = variant.tokens.bg;
	}
	writeStored(KEY_CSS, rules.join("\n"));
	if (bg !== undefined) writeStored(KEY_BG, bg);
}

/**
 * Point the browser chrome (Android status bar, tab strip, standalone title
 * bar) at the applied variant's `bg` token, the same value the boot script
 * caches. Uses one un-media `theme-color` meta placed first in <head>, which
 * wins over index.html's media-qualified fallbacks; the boot script creates
 * the same element for the first paint. Before `/ctl/themes` answers there is
 * no variant data, and the boot script's value stands.
 */
function syncThemeColor(selection: ThemeSelection, scheme: ThemeScheme): void {
	const bg = findTheme(payload, renderedId(selection, scheme))?.variants[scheme]?.tokens.bg;
	if (bg === undefined) return;
	let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
	if (meta === null) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.prepend(meta);
	}
	meta.content = bg;
}

function apply(): void {
	const selection = currentThemeSelection();
	const scheme = effectiveScheme(selection);
	const root = document.documentElement;
	root.dataset.scheme = scheme;
	root.dataset.themeVariant = `${renderedId(selection, scheme)}/${scheme}`;
	root.style.fontSize = rootFontSizeCss(currentFontSize());
	// index.html pre-paints the boot background inline; once the theme is set,
	// the CSS --bg token is authoritative, so drop the stale inline value
	// (identical to the token on first paint, correct after runtime switches).
	root.style.background = "";
	refreshBootCaches(selection, scheme);
	syncThemeColor(selection, scheme);
}

/** Install (or replace) the theme stylesheet as the LAST element of <head>, so it follows the global CSS and wins equal-specificity ties. */
function installThemeStyle(css: string): void {
	let style = document.getElementById(STYLE_ID);
	if (style === null) {
		style = document.createElement("style");
		style.id = STYLE_ID;
	}
	style.textContent = css;
	document.head.append(style);
}

export function setThemeMode(mode: ThemeMode): ThemeSelection {
	writeStored(KEY_MODE, mode);
	apply();
	return currentThemeSelection();
}

/**
 * The linked picker chose `id`. A theme with both variants sets both schemes;
 * a single-variant theme unlinks and sets only the scheme it has.
 */
export function selectLinkedTheme(id: string): ThemeSelection {
	const entry = findTheme(payload, id);
	const schemes =
		entry === undefined ? THEME_SCHEMES : THEME_SCHEMES.filter((s) => entry.variants[s]);
	if (schemes.length < THEME_SCHEMES.length) writeStored(KEY_LINKED, "false");
	for (const scheme of schemes) writeStored(scheme === "light" ? KEY_LIGHT : KEY_DARK, id);
	apply();
	return currentThemeSelection();
}

/**
 * An unlinked picker chose `id` for one scheme. If that leaves the two schemes
 * on different themes while still linked, the selection unlinks.
 */
export function selectSchemeTheme(scheme: ThemeScheme, id: string): ThemeSelection {
	writeStored(scheme === "light" ? KEY_LIGHT : KEY_DARK, id);
	const selection = currentThemeSelection();
	if (selection.linked && selection.light !== selection.dark) writeStored(KEY_LINKED, "false");
	apply();
	return currentThemeSelection();
}

/**
 * Unlink keeps both ids. Relink moves both schemes to the family of the
 * variant currently in effect when it has both variants, else to
 * `DEFAULT_THEME_ID`.
 */
export function setThemeLinked(linked: boolean): ThemeSelection {
	if (!linked) {
		writeStored(KEY_LINKED, "false");
	} else {
		const selection = currentThemeSelection();
		const id = renderedId(selection, effectiveScheme(selection));
		const entry = findTheme(payload, id);
		const family =
			entry !== undefined && THEME_SCHEMES.every((s) => entry.variants[s]) ? id : DEFAULT_THEME_ID;
		writeStored(KEY_LIGHT, family);
		writeStored(KEY_DARK, family);
		writeStored(KEY_LINKED, "true");
	}
	apply();
	return currentThemeSelection();
}

/**
 * Install the generated stylesheet for `themes`, re-apply the selection against
 * it (a missing selected theme renders the default but keeps its stored id) and
 * refresh the first-paint caches.
 */
export function applyThemesPayload(themes: ThemesPayload): void {
	payload = themes;
	installThemeStyle(themesCss(themes.themes));
	apply();
}

export function stepFontSize(delta: number): number {
	const next = Math.min(FONT_MAX, Math.max(FONT_MIN, currentFontSize() + delta));
	writeStored(FONT_KEY, String(next));
	apply();
	return next;
}

/**
 * Re-apply the stored selection, e.g. after another document of this origin
 * (the design system's parent page) wrote it. Without a payload the cached
 * stylesheet is refreshed too, since the boot copy is all this page has.
 */
export function applyStoredTheme(): void {
	if (payload === null) {
		const css = readStored(KEY_CSS);
		if (css !== null) installThemeStyle(css);
	}
	apply();
}

/** Apply persisted theme/font-size on startup and follow OS theme changes while the mode is "system". */
export function initTheme(): void {
	// Keep the boot-installed stylesheet after the global CSS (in dev, Vite injects CSS from JS).
	const style = document.getElementById(STYLE_ID);
	if (style !== null) document.head.append(style);
	apply();
	window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
		if (currentThemeSelection().mode === "system") apply();
	});
}
