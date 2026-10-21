/** A vertical extent in the coordinate space the viewport is measured in. */
export interface Extent {
	top: number;
	bottom: number;
}

/** The column's own extent and the gap between its items (a spacer brings one gap of its own). */
export interface ColumnLayout {
	contentTop: number;
	contentBottom: number;
	gap: number;
}

export interface VisibleRange {
	/** First and last item to clone, inclusive. */
	first: number;
	last: number;
	/** Height of the spacer standing in for items before `first` (0 when `first` is 0). */
	spacerAbove: number;
	/** Height of the spacer standing in for items after `last` (0 when `last` is the final item). */
	spacerBelow: number;
}

/**
 * Which items to clone for a viewport, from `count` items in visual order whose
 * extents `extentAt` reads on demand (so the cost is a binary search plus the
 * visible run, never a scan of every item).
 *
 * Convention: an item is visible when `bottom > viewTop && top < viewBottom`, so
 * one merely touching an edge is not. An item at least partly in view is always
 * included. When none is in view (the viewport sits in a gap or past either end)
 * the nearest item below the viewport is kept, or the last one when none is below,
 * so a non-empty list always yields at least one item. An empty list yields null.
 *
 * A spacer is a flex item too and brings one gap of its own, so spacerAbove is the
 * run's height minus a gap, and likewise below: spacer + gap + items + gap +
 * spacer reproduces the column's height and every cloned item's offset.
 * `layout` defaults to the first item's top, the last item's bottom and no gap.
 */
export function visibleRange(
	count: number,
	extentAt: (index: number) => Extent,
	viewTop: number,
	viewBottom: number,
	layout?: ColumnLayout,
): VisibleRange | null {
	if (count === 0) return null;
	// Binary search for the first item whose bottom edge is below the viewport's top.
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (extentAt(mid).bottom > viewTop) hi = mid;
		else lo = mid + 1;
	}
	const first = Math.min(lo, count - 1);
	let last = first;
	while (last + 1 < count && extentAt(last + 1).top < viewBottom) last++;
	const { contentTop, contentBottom, gap } = layout ?? {
		contentTop: extentAt(0).top,
		contentBottom: extentAt(count - 1).bottom,
		gap: 0,
	};
	return {
		first,
		last,
		spacerAbove: first > 0 ? Math.max(0, extentAt(first).top - contentTop - gap) : 0,
		spacerBelow: last < count - 1 ? Math.max(0, contentBottom - extentAt(last).bottom - gap) : 0,
	};
}

/** Stands in for the transcript items not cloned, so the ones that are keep their offset and the scroller its height. */
function spacer(height: number): HTMLElement {
	const el = document.createElement("div");
	el.className = "chat-transcript-ghost-spacer";
	el.style.setProperty("--spacer", `${height}px`);
	return el;
}

/**
 * The content column with only the items that intersect the scroller's viewport
 * cloned (deeply), flanked by spacers for the rest. The cost depends on what is on
 * screen, not on the transcript's length: the first visible item is found by binary
 * search and the walk stops at the viewport's bottom edge.
 */
function cloneContent(content: HTMLElement, clip: DOMRect): HTMLElement {
	const copy = content.cloneNode(false) as HTMLElement;
	const items = content.children;
	if (items.length === 0) return copy;
	const contentRect = content.getBoundingClientRect();
	const range = visibleRange(
		items.length,
		(i) => items[i]!.getBoundingClientRect(),
		clip.top,
		clip.bottom,
		{
			contentTop: contentRect.top,
			contentBottom: contentRect.bottom,
			gap: Number.parseFloat(getComputedStyle(content).rowGap) || 0,
		},
	);
	if (range === null) return copy;
	if (range.first > 0) copy.append(spacer(range.spacerAbove));
	for (let i = range.first; i <= range.last; i++) copy.append(items[i]!.cloneNode(true));
	if (range.last < items.length - 1) copy.append(spacer(range.spacerBelow));
	return copy;
}

/**
 * A copy of the transcript body that looks the same on screen but only holds the
 * visible items: the elements around the content column (body, wrap, scroller, jump
 * button) are cloned as they are, the column keeps just the items in view. A body
 * without a message list (the empty state) is small and cloned whole.
 */
export function cloneVisible(body: HTMLElement): HTMLElement {
	const content = body.querySelector<HTMLElement>(".chat-transcript-content");
	const scroller = content?.closest<HTMLElement>(".chat-transcript");
	if (!content || !scroller) return body.cloneNode(true) as HTMLElement;
	const clip = scroller.getBoundingClientRect();
	const build = (node: Element): Node => {
		if (node === content) return cloneContent(content, clip);
		if (!node.contains(content)) return node.cloneNode(true);
		const copy = node.cloneNode(false);
		for (const child of node.childNodes) {
			copy.appendChild(child instanceof Element ? build(child) : child.cloneNode(true));
		}
		return copy;
	};
	return build(body) as HTMLElement;
}
