/**
 * Regression tests for useStickyScroll's unpin-only scroll rule.
 *
 * The hook itself cannot run under bun: there is no DOM/ResizeObserver, and
 * bun resolves solid-js to its SSR build (onMount never fires). So the
 * decision logic lives in the pure `shouldUnpinOnScroll`, and these tests drive
 * it from a tiny layout model that mirrors the hook's wiring exactly: the
 * ResizeObserver callback snaps to the bottom only while pinned (recording the
 * post-snap scrollTop), and the scroll listener unpins when the rule says so.
 */
import { describe, expect, test } from "bun:test";
import { shouldUnpinOnScroll } from "../../components/chat/transcript/useStickyScroll";

const VIEWPORT = 800;

class FakeScroller {
	pinned = true;
	jumpVisible = false;
	scrollTop = 0;
	snapTop: number | null = null;
	constructor(
		public scrollHeight: number,
		public clientHeight = VIEWPORT,
	) {}

	private get maxTop(): number {
		return Math.max(0, this.scrollHeight - this.clientHeight);
	}

	/** snapToBottom in the hook. */
	snap(): void {
		this.scrollTop = this.maxTop;
		this.snapTop = this.scrollTop;
	}

	/** ResizeObserver callback after a content size change (browser clamps first). */
	resizeContent(scrollHeight: number): void {
		this.scrollHeight = scrollHeight;
		this.scrollTop = Math.min(this.scrollTop, this.maxTop); // browser clamp
		if (this.pinned) this.snap();
	}

	/** Programmatic jump (scrollIntoView / find-in-page). */
	jumpTo(top: number): void {
		this.scrollTop = Math.min(Math.max(0, top), this.maxTop);
	}

	/** The scroll listener. */
	scrollEvent(): void {
		if (shouldUnpinOnScroll({ ...this, pinned: this.pinned })) {
			this.pinned = false;
			this.jumpVisible = true;
		}
	}
}

describe("useStickyScroll unpin-only scroll rule", () => {
	test("programmatic jump far above the bottom unpins, so the following size change does not snap back", () => {
		const s = new FakeScroller(200_000);
		s.snap();
		s.scrollEvent(); // echo of our own snap: ignored
		expect(s.pinned).toBe(true);

		s.jumpTo(5_000); // jump into never-rendered content
		s.scrollEvent();
		expect(s.pinned).toBe(false);
		expect(s.jumpVisible).toBe(true);

		// Items render: placeholders swap for real content, content size changes.
		s.resizeContent(190_000);
		expect(s.scrollTop).toBe(5_000);
		s.resizeContent(215_000);
		expect(s.scrollTop).toBe(5_000);
		expect(s.pinned).toBe(false);
		expect(s.jumpVisible).toBe(true);
	});

	test("jump to the very top (scrollTop 0) still unpins", () => {
		const s = new FakeScroller(200_000);
		s.snap();
		s.jumpTo(0);
		s.scrollEvent();
		expect(s.pinned).toBe(false);
		expect(s.jumpVisible).toBe(true);
	});

	test("pinned content growth still snaps to the bottom and stays pinned", () => {
		const s = new FakeScroller(10_000);
		s.snap();
		// A huge append (more than a viewport) lands before our snap's scroll event is dispatched.
		s.resizeContent(10_000 + 5 * VIEWPORT);
		expect(s.scrollTop).toBe(s.scrollHeight - VIEWPORT);
		s.scrollEvent(); // echo of the snap: scrollTop == snapTop
		expect(s.pinned).toBe(true);
		expect(s.jumpVisible).toBe(false);

		s.resizeContent(s.scrollHeight + 300);
		s.scrollEvent();
		expect(s.scrollTop).toBe(s.scrollHeight - VIEWPORT);
		expect(s.pinned).toBe(true);
	});

	test("content growing after our snap, before its scroll event, does not unpin", () => {
		const s = new FakeScroller(10_000);
		s.snap();
		s.scrollHeight += 3 * VIEWPORT; // grows with no RO callback yet
		expect(s.scrollHeight - s.scrollTop - s.clientHeight).toBeGreaterThan(VIEWPORT);
		s.scrollEvent();
		expect(s.pinned).toBe(true);
	});

	test("a small clamp (less than a viewport) while pinned keeps pinned", () => {
		const s = new FakeScroller(10_000);
		s.snap();
		s.resizeContent(10_000 - 300); // shrink: browser clamps scrollTop, RO re-snaps
		s.scrollEvent();
		expect(s.pinned).toBe(true);
		expect(s.jumpVisible).toBe(false);

		// Clamp event with no snap record at all (e.g. clamp won the race).
		const clamped = { pinned: true, scrollHeight: 9_700, scrollTop: 8_900, clientHeight: VIEWPORT };
		expect(shouldUnpinOnScroll({ ...clamped, snapTop: null })).toBe(false);
	});

	test("boundary: exactly one viewport above the bottom does not unpin, beyond it does", () => {
		const base = { pinned: true, scrollHeight: 10_000, clientHeight: VIEWPORT, snapTop: null };
		expect(shouldUnpinOnScroll({ ...base, scrollTop: 10_000 - 2 * VIEWPORT })).toBe(false);
		expect(shouldUnpinOnScroll({ ...base, scrollTop: 10_000 - 2 * VIEWPORT - 1 })).toBe(true);
	});

	test("never re-pins: an unpinned view returns false wherever it sits", () => {
		const base = { pinned: false, scrollHeight: 10_000, clientHeight: VIEWPORT, snapTop: null };
		expect(shouldUnpinOnScroll({ ...base, scrollTop: 0 })).toBe(false);
		expect(shouldUnpinOnScroll({ ...base, scrollTop: 10_000 - VIEWPORT })).toBe(false);
	});
});
