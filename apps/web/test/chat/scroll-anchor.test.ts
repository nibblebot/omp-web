/**
 * Keeping an unpinned viewport's on-screen content in place while cards above
 * it hide or return (captureScrollAnchors / restoreScrollAnchor), over fake
 * elements whose tops follow a model of the stream layout.
 */
import { describe, expect, test } from "bun:test";
import {
	captureScrollAnchors,
	restoreScrollAnchor,
	type AnchorElement,
} from "../../chat/scroll-anchor";

interface FakeItem extends AnchorElement {
	height: number;
	connected: boolean;
}

/** A stream of items stacked from the content top, scrolled by `scrollTop` in a viewport at y = 0. */
function makeStream(heights: number[], viewportHeight: number) {
	const items: FakeItem[] = heights.map((height) => ({
		height,
		connected: true,
		get isConnected() {
			return this.connected;
		},
		getBoundingClientRect: () => {
			throw new Error("bound below");
		},
	}));
	const stream = {
		scrollTop: 0,
		items,
		/** The items the DOM currently holds, in order. */
		live: () => items.filter((item) => item.connected),
		scroller: {
			get scrollTop() {
				return stream.scrollTop;
			},
			set scrollTop(value: number) {
				stream.scrollTop = value;
			},
			getBoundingClientRect: () => ({ top: 0, bottom: viewportHeight }),
		},
	};
	for (const item of items) {
		item.getBoundingClientRect = () => {
			let top = -stream.scrollTop;
			for (const other of stream.live()) {
				if (other === item) break;
				top += other.height;
			}
			return { top, bottom: top + item.height };
		};
	}
	return stream;
}

describe("scroll anchors", () => {
	test("hiding items above the viewport keeps the visible content in place", () => {
		const stream = makeStream([100, 100, 100, 100, 100, 100], 200);
		stream.scrollTop = 300; // items 3 and 4 on screen
		const [onScreen] = captureScrollAnchors(stream.scroller, stream.live());
		expect(onScreen!.el).toBe(stream.items[3]!);
		const before = stream.items[3]!.getBoundingClientRect().top;
		stream.items[1]!.connected = false;
		stream.items[2]!.connected = false;
		expect(stream.items[3]!.getBoundingClientRect().top).not.toBe(before);
		expect(restoreScrollAnchor(stream.scroller, [onScreen!])).toBe(true);
		expect(stream.items[3]!.getBoundingClientRect().top).toBe(before);
	});

	test("restoring cards above the viewport pushes the scroll offset down by their height", () => {
		const stream = makeStream([100, 100, 100, 100, 100], 200);
		stream.items[1]!.connected = false;
		stream.scrollTop = 100; // items 2 and 3 on screen
		const anchors = captureScrollAnchors(stream.scroller, stream.live());
		stream.items[1]!.connected = true;
		expect(restoreScrollAnchor(stream.scroller, anchors)).toBe(true);
		expect(stream.scrollTop).toBe(200);
	});

	test("an anchor that was removed falls to the next survivor on screen", () => {
		const stream = makeStream([100, 100, 100, 100], 250);
		stream.scrollTop = 50;
		const anchors = captureScrollAnchors(stream.scroller, stream.live());
		expect(anchors.map((a) => a.el)).toEqual([
			stream.items[0]!,
			stream.items[1]!,
			stream.items[2]!,
		]);
		const before = stream.items[1]!.getBoundingClientRect().top;
		stream.items[0]!.connected = false;
		restoreScrollAnchor(stream.scroller, anchors);
		expect(stream.items[1]!.getBoundingClientRect().top).toBe(before);
	});

	test("everything on screen removed leaves the scroll offset alone", () => {
		const stream = makeStream([100, 100, 100], 100);
		stream.scrollTop = 100;
		const anchors = captureScrollAnchors(stream.scroller, stream.live());
		stream.items[1]!.connected = false;
		expect(restoreScrollAnchor(stream.scroller, anchors)).toBe(false);
		expect(stream.scrollTop).toBe(100);
	});

	test("only items intersecting the viewport are captured", () => {
		const stream = makeStream([100, 100, 100, 100, 100], 150);
		stream.scrollTop = 150;
		const anchors = captureScrollAnchors(stream.scroller, stream.live());
		expect(anchors.map((a) => a.offset)).toEqual([-50, 50]);
	});
});
