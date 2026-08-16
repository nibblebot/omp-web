export type ThemeId = "dark" | "light" | "catppuccin-mocha" | "catppuccin-latte" | "omp-dark" | "omp-light";
export type ThemePreference = ThemeId | "system";

export interface ThemeOption {
	id: ThemePreference;
	label: string;
}

/** Selectable options in the theme switcher, in display order. */
export const THEME_OPTIONS: ThemeOption[] = [
	{ id: "system", label: "system" },
	{ id: "dark", label: "dark" },
	{ id: "light", label: "light" },
	{ id: "catppuccin-mocha", label: "catppuccin mocha" },
	{ id: "catppuccin-latte", label: "catppuccin latte" },
	{ id: "omp-dark", label: "omp dark" },
	{ id: "omp-light", label: "omp light" },
];

const THEME_KEY = "omp-web:theme";
const FONT_KEY = "omp-web:font-size";
const FONT_MIN = 12;
const FONT_MAX = 18;
const FONT_DEFAULT = 15;

const THEME_IDS: Record<ThemeId, true> = {
	dark: true,
	light: true,
	"catppuccin-mocha": true,
	"catppuccin-latte": true,
	"omp-dark": true,
	"omp-light": true,
};

function apply(theme: ThemeId, fontSize: number): void {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.fontSize = `${fontSize}px`;
	// index.html pre-paints the boot background inline; once the theme is set,
	// the CSS --bg token is authoritative, so drop the stale inline value
	// (identical to the token on first paint, correct after runtime switches).
	document.documentElement.style.background = "";
}

/** The stored preference; defaults to "system" when unset or unrecognized. */
export function currentThemePreference(): ThemePreference {
	const stored = localStorage.getItem(THEME_KEY);
	if (stored === "system" || stored === null) return "system";
	return THEME_IDS[stored as ThemeId] ? (stored as ThemeId) : "system";
}

/** The concrete palette currently in effect (preference resolved through the OS when set to "system"). */
export function resolvedTheme(): ThemeId {
	const pref = currentThemePreference();
	return pref === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : pref;
}

export function currentFontSize(): number {
	const n = Number(localStorage.getItem(FONT_KEY));
	return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT;
}

export function setTheme(pref: ThemePreference): ThemePreference {
	localStorage.setItem(THEME_KEY, pref);
	apply(resolvedTheme(), currentFontSize());
	return pref;
}

export function stepFontSize(delta: number): number {
	const next = Math.min(FONT_MAX, Math.max(FONT_MIN, currentFontSize() + delta));
	localStorage.setItem(FONT_KEY, String(next));
	apply(resolvedTheme(), next);
	return next;
}

/** Apply persisted theme/font-size on startup and follow OS theme changes while the preference is "system". */
export function initTheme(): void {
	apply(resolvedTheme(), currentFontSize());
	window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", e => {
		if (currentThemePreference() === "system") apply(e.matches ? "light" : "dark", currentFontSize());
	});
}
