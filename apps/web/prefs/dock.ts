/**
 * Right-hand dock width (U18). The layout reads only the `--dock-w` CSS
 * variable; this module owns the clamp, the persisted value, and the write.
 */
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 900;
export const DOCK_DEFAULT_WIDTH = 480;
/**
 * Viewport width the side-by-side dock leaves to everything but itself: the
 * widest docked sidebar (touch, 280px) plus a 360px chat column. dock.css caps
 * the rendered width with the same reserve (using the live `--sidebar-w`).
 */
export const DOCK_VIEWPORT_RESERVE = 280 + 360;
const STORAGE_KEY = "omp-web:dock-width";

/** Widest dock the viewport allows: never above DOCK_MAX_WIDTH, never below DOCK_MIN_WIDTH. */
export function maxDockWidthFor(viewportWidth: number): number {
	if (!Number.isFinite(viewportWidth)) return DOCK_MAX_WIDTH;
	return Math.max(
		DOCK_MIN_WIDTH,
		Math.min(DOCK_MAX_WIDTH, Math.floor(viewportWidth) - DOCK_VIEWPORT_RESERVE),
	);
}

/** Clamp to the allowed range; pass the viewport width to also keep the chat column usable. */
export function clampDockWidth(px: number, viewportWidth = Number.POSITIVE_INFINITY): number {
	if (!Number.isFinite(px)) return DOCK_DEFAULT_WIDTH;
	const max = Math.min(DOCK_MAX_WIDTH, maxDockWidthFor(viewportWidth));
	return Math.min(max, Math.max(DOCK_MIN_WIDTH, Math.round(px)));
}

export function readDockWidth(): number {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (raw === null || raw === undefined) return DOCK_DEFAULT_WIDTH;
		return clampDockWidth(Number(raw));
	} catch {
		return DOCK_DEFAULT_WIDTH;
	}
}

export function applyDockWidth(px: number): void {
	globalThis.document?.documentElement.style.setProperty("--dock-w", `${px}px`);
}

export function persistDockWidth(px: number): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, String(px));
	} catch {
		// Storage can be unavailable (private mode); the width still applies for this page.
	}
	applyDockWidth(px);
}
