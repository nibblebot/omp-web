import type { ModelBrowserEntry } from "#lib/wire/protocol";

/** Rows whose `kind` is in `kinds`; `undefined` keeps every kind. */
export function filterByKinds(
	models: readonly ModelBrowserEntry[],
	kinds: readonly string[] | undefined,
): readonly ModelBrowserEntry[] {
	return kinds ? models.filter((model) => kinds.includes(model.kind)) : models;
}

/** Rows kept mounted above and below the visible ones, so fast scrolling never shows a gap. */
const OVERSCAN_ROWS = 8;

/**
 * The slice `[start, end)` of `count` fixed-pitch rows a list must mount to cover its
 * viewport at `scrollTop`, plus overscan on both sides. Everything outside is a spacer.
 */
export function virtualWindow(
	scrollTop: number,
	viewportHeight: number,
	rowPitch: number,
	count: number,
): { start: number; end: number } {
	if (count === 0 || rowPitch <= 0) return { start: 0, end: 0 };
	const first = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowPitch)));
	const shown = Math.ceil(viewportHeight / rowPitch) + 1;
	return {
		start: Math.max(0, first - OVERSCAN_ROWS),
		end: Math.min(count, first + shown + OVERSCAN_ROWS),
	};
}
