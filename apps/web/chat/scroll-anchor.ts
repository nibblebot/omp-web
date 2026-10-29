/**
 * Keeping an unpinned scroller's visible content in place while items above
 * it appear or disappear (the Activities panel hiding and restoring cards).
 * The browser's own scroll anchoring does not cover this reliably under the
 * transcript's `content-visibility: auto` items, so the stream captures the
 * on-screen children before the change and, once the DOM has settled,
 * scrolls by however far the first survivor moved.
 */

interface Rect {
	top: number;
	bottom: number;
}

/** What the capture reads of an item element. */
export interface AnchorElement {
	readonly isConnected: boolean;
	getBoundingClientRect(): Rect;
}

/** A scroller: its box and scroll offset. */
export interface AnchorScroller {
	scrollTop: number;
	getBoundingClientRect(): Rect;
}

/** An on-screen item and where its top sat below the scroller's top. */
export interface ScrollAnchor {
	el: AnchorElement;
	offset: number;
}

/** The children of `content` that intersect the scroller's viewport, with their offsets from its top, in document order. */
export function captureScrollAnchors(
	scroller: AnchorScroller,
	children: ArrayLike<AnchorElement>,
): ScrollAnchor[] {
	const view = scroller.getBoundingClientRect();
	const anchors: ScrollAnchor[] = [];
	// Items are in document order, so their bottoms ascend: find the first one that
	// ends below the viewport's top by bisection instead of measuring every item above it.
	let lo = 0;
	let hi = children.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (children[mid]!.getBoundingClientRect().bottom <= view.top) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < children.length; i++) {
		const el = children[i]!;
		const rect = el.getBoundingClientRect();
		if (rect.top >= view.bottom) break;
		anchors.push({ el, offset: rect.top - view.top });
	}
	return anchors;
}

/**
 * Scroll so the first captured item still in the document sits at its
 * captured offset. Several are captured because the first may be the one
 * that was removed. Returns whether an item was found; with none (everything
 * on screen went away) the scroller keeps whatever the browser left.
 */
export function restoreScrollAnchor(
	scroller: AnchorScroller,
	anchors: readonly ScrollAnchor[],
): boolean {
	for (const anchor of anchors) {
		if (!anchor.el.isConnected) continue;
		const moved =
			anchor.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
		if (moved !== 0) scroller.scrollTop += moved;
		return true;
	}
	return false;
}
