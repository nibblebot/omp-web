/** Which side of its trigger a kebab menu opens on. */
export type KebabSide = "below" | "above";

/**
 * The side a dropdown of `menuHeight` px opens on, given its trigger and the
 * visible band it must stay inside (the scrolling list it lives in, or the
 * viewport). Below is the default; it flips above only when below is too short
 * for the whole menu and above has more room, so a menu on the last rows of a
 * list opens upward instead of hiding its items past the list edge.
 */
export function kebabSide(
	trigger: { top: number; bottom: number },
	band: { top: number; bottom: number },
	menuHeight: number,
): KebabSide {
	const below = band.bottom - trigger.bottom;
	const above = trigger.top - band.top;
	return below < menuHeight && above > below ? "above" : "below";
}

/** The nearest ancestor that scrolls vertically, as a visible band clipped to the viewport. */
export function visibleBand(el: HTMLElement): { top: number; bottom: number } {
	let band = { top: 0, bottom: window.innerHeight };
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflowY = getComputedStyle(node).overflowY;
		if (overflowY !== "auto" && overflowY !== "scroll") continue;
		const rect = node.getBoundingClientRect();
		band = { top: Math.max(band.top, rect.top), bottom: Math.min(band.bottom, rect.bottom) };
		break;
	}
	return band;
}
