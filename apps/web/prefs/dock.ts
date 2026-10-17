/**
 * Right-hand dock width (U18). The layout reads only the `--dock-w` CSS
 * variable; this module owns the clamp, the persisted value, and the write.
 */
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 900;
export const DOCK_DEFAULT_WIDTH = 480;
const STORAGE_KEY = "omp-web:dock-width";

export function clampDockWidth(px: number): number {
	if (!Number.isFinite(px)) return DOCK_DEFAULT_WIDTH;
	return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(px)));
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
