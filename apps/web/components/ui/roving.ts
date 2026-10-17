/**
 * Roving tabindex for composite widgets (WAI-ARIA APG): a list, tablist, or
 * menu exposes one tab stop (the active item, tabindex 0) and moves focus
 * among its items with the arrow keys, Home, and End.
 */

export type RovingAxis = "vertical" | "horizontal";

/**
 * Index the roving `key` moves to, or null when the key is not a roving key.
 * Home and End jump to the ends; the arrow keys step by one (wrapping when
 * `wrap` is set, clamping otherwise). `current` may be -1 (no item focused).
 */
export function rovingTarget(
	key: string,
	axis: RovingAxis,
	current: number,
	count: number,
	wrap = false,
): number | null {
	if (count === 0) return null;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	const back = axis === "vertical" ? "ArrowUp" : "ArrowLeft";
	const forward = axis === "vertical" ? "ArrowDown" : "ArrowRight";
	if (key !== back && key !== forward) return null;
	const raw = current + (key === forward ? 1 : -1);
	if (wrap) return (raw + count) % count;
	return Math.min(count - 1, Math.max(0, raw));
}

/** Make `items[active]` the single tab stop; every other item gets tabindex -1. */
export function setRovingTabStop(items: readonly HTMLElement[], active: number): void {
	items.forEach((el, i) => {
		el.tabIndex = i === active ? 0 : -1;
	});
}

/**
 * Handle a roving key press on `items`, where `current` is the index of the
 * focused item. Moves focus, updates the tab stop, and returns the new index,
 * or null when the key was not handled (the event is left untouched).
 */
export function moveRovingFocus(
	e: KeyboardEvent,
	items: readonly HTMLElement[],
	current: number,
	axis: RovingAxis,
	wrap = false,
): number | null {
	const target = rovingTarget(e.key, axis, current, items.length, wrap);
	if (target === null) return null;
	e.preventDefault();
	setRovingTabStop(items, target);
	items[target]?.focus();
	return target;
}
