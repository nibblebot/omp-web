/**
 * Tests for the visible-range logic behind the transcript's exit snapshot
 * (cloneVisible clones only the items in view). bun has no DOM, so these drive
 * the pure `visibleRange` from a layout model: items stacked in a column with a gap,
 * measured in the viewport's coordinate space like getBoundingClientRect.
 */
import { describe, expect, test } from "bun:test";
import {
	type ColumnLayout,
	type Extent,
	visibleRange,
} from "../../components/chat/transcript/clone-visible";

/** A flex column starting at `top`: item i is `heights[i]` tall, `gap` below its predecessor. */
function column(heights: number[], gap = 0, top = 0): { items: Extent[]; layout: ColumnLayout } {
	const items: Extent[] = [];
	let y = top;
	for (const h of heights) {
		items.push({ top: y, bottom: y + h });
		y += h + gap;
	}
	const contentBottom = heights.length === 0 ? top : y - gap;
	return { items, layout: { contentTop: top, contentBottom, gap } };
}

function range(
	col: { items: Extent[]; layout: ColumnLayout },
	viewTop: number,
	viewBottom: number,
) {
	return visibleRange(col.items.length, (i) => col.items[i]!, viewTop, viewBottom, col.layout);
}

/** Linear-scan reference for the first/last visible items (bottom > viewTop && top < viewBottom). */
function scan(items: Extent[], viewTop: number, viewBottom: number): [number, number] | null {
	let first = -1;
	let last = -1;
	items.forEach((it, i) => {
		if (it.bottom > viewTop && it.top < viewBottom) {
			if (first === -1) first = i;
			last = i;
		}
	});
	return first === -1 ? null : [first, last];
}

describe("visibleRange", () => {
	test("an empty list has no range", () => {
		expect(visibleRange(0, () => ({ top: 0, bottom: 0 }), 0, 100)).toBeNull();
	});

	test("an item partly above the viewport is included", () => {
		const col = column([50, 50, 50, 50]); // 0-50, 50-100, 100-150, 150-200
		const r = range(col, 30, 120);
		expect(r).toMatchObject({ first: 0, last: 2 });
	});

	test("convention: touching an edge is not visible (bottom == viewTop, top == viewBottom)", () => {
		const col = column([50, 50, 50, 50]);
		// Item 0 ends exactly at viewTop 50: excluded. Item 3 starts exactly at viewBottom 150: excluded.
		const r = range(col, 50, 150);
		expect(r).toMatchObject({ first: 1, last: 2 });
		// One pixel inside either edge brings the neighbour in.
		expect(range(col, 49, 151)).toMatchObject({ first: 0, last: 3 });
	});

	test("the viewport at the very top", () => {
		const col = column([40, 40, 40, 40, 40, 40], 10);
		const r = range(col, 0, 101); // item 2 starts at 100
		expect(r).toMatchObject({ first: 0, last: 2, spacerAbove: 0 });
		expect(r!.spacerBelow).toBeGreaterThan(0);
	});

	test("the viewport at the very bottom", () => {
		const col = column([40, 40, 40, 40, 40, 40], 10); // content height 290
		const r = range(col, 190, 290);
		expect(r).toMatchObject({ first: 4, last: 5, spacerBelow: 0 });
		expect(r!.spacerAbove).toBeGreaterThan(0);
	});

	test("a single item taller than the viewport is the whole range", () => {
		const col = column([40, 5000, 40], 10);
		const r = range(col, 1000, 1500);
		expect(r).toMatchObject({ first: 1, last: 1 });
	});

	test("a single item list is always kept, with no spacers", () => {
		const col = column([30]);
		expect(range(col, 0, 100)).toEqual({ first: 0, last: 0, spacerAbove: 0, spacerBelow: 0 });
		// Even a viewport that misses it entirely keeps the one item.
		expect(range(col, 500, 600)).toEqual({ first: 0, last: 0, spacerAbove: 0, spacerBelow: 0 });
	});

	test("a viewport in a gap keeps the nearest item below, a viewport past the end keeps the last", () => {
		const col = column([20, 20, 20], 100); // 0-20, 120-140, 240-260
		expect(range(col, 50, 60)).toMatchObject({ first: 1, last: 1 });
		expect(range(col, 900, 1000)).toMatchObject({ first: 2, last: 2 });
	});

	test("with gaps between items the spacers reproduce every cloned item's offset and the total height", () => {
		const heights = [30, 80, 45, 120, 60, 25, 90, 70, 55, 40];
		for (const gap of [0, 12, 7.5]) {
			const col = column(heights, gap, 16);
			for (const [viewTop, viewBottom] of [
				[16, 120],
				[100, 300],
				[250, 380],
				[0, 5000],
				[16 + 500, 16 + 520],
			] as const) {
				const r = range(col, viewTop, viewBottom)!;
				// Lay the clone out the way the column does: spacer, gap, items with gaps, gap, spacer.
				let y = col.layout.contentTop;
				if (r.first > 0) y += r.spacerAbove + gap;
				for (let i = r.first; i <= r.last; i++) {
					expect(y).toBeCloseTo(col.items[i]!.top, 9);
					y += col.items[i]!.bottom - col.items[i]!.top;
					if (i < r.last) y += gap;
				}
				if (r.last < heights.length - 1) y += gap + r.spacerBelow;
				expect(y).toBeCloseTo(col.layout.contentBottom, 9);
			}
		}
	});

	test("without a layout the column spans the first item's top to the last item's bottom", () => {
		const col = column([50, 50, 50, 50, 50]);
		const r = visibleRange(5, (i) => col.items[i]!, 100, 150)!;
		expect(r).toEqual({ first: 2, last: 2, spacerAbove: 100, spacerBelow: 100 });
	});

	test("10,000 items give the same range as a linear scan, reading only a few extents", () => {
		const heights = Array.from({ length: 10_000 }, (_, i) => 20 + ((i * 37) % 90));
		const col = column(heights, 12, 16);
		let reads = 0;
		const extentAt = (i: number) => {
			reads++;
			return col.items[i]!;
		};
		const total = col.layout.contentBottom;
		for (const frac of [0, 0.001, 0.25, 0.5, 0.731, 0.999, 1]) {
			const viewTop = Math.max(0, Math.round(total * frac) - 300);
			const viewBottom = viewTop + 700;
			reads = 0;
			const r = visibleRange(col.items.length, extentAt, viewTop, viewBottom, col.layout)!;
			const expected = scan(col.items, viewTop, viewBottom)!;
			expect([r.first, r.last]).toEqual(expected);
			// ~log2(10k) probes plus the visible run, nowhere near a scan of every item.
			expect(reads).toBeLessThan(80);
		}
	});
});
