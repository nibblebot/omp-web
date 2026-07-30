export type Theme = "dark" | "light";

const THEME_KEY = "omp-web:theme";
const FONT_KEY = "omp-web:font-size";
const FONT_MIN = 12;
const FONT_MAX = 18;
const FONT_DEFAULT = 14;

function apply(theme: Theme, fontSize: number): void {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.fontSize = `${fontSize}px`;
}

export function currentTheme(): Theme {
	return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function currentFontSize(): number {
	const n = Number(localStorage.getItem(FONT_KEY));
	return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT;
}

export function setTheme(theme: Theme): Theme {
	localStorage.setItem(THEME_KEY, theme);
	apply(theme, currentFontSize());
	return theme;
}

export function stepFontSize(delta: number): number {
	const next = Math.min(FONT_MAX, Math.max(FONT_MIN, currentFontSize() + delta));
	localStorage.setItem(FONT_KEY, String(next));
	apply(currentTheme(), next);
	return next;
}

/** Apply persisted theme/font-size on startup. */
export function initTheme(): void {
	apply(currentTheme(), currentFontSize());
}
