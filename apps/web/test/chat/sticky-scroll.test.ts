/**
 * useStickyScroll's touch direction tracker. The hook's DOM wiring cannot run
 * under bun:test (bun resolves solid-js to its SSR build, so onMount never
 * fires); the direction decisions live in the pure `TouchScrollTracker`.
 */
import { describe, expect, test } from "bun:test";
import { TouchScrollTracker } from "../../components/chat/transcript/useStickyScroll";

describe("useStickyScroll touch tracker", () => {
	test("the first move event of a drag has no direction (scrollTop is not applied yet)", () => {
		const t = new TouchScrollTracker();
		t.start(9_200);
		expect(t.move(9_200)).toBeNull();
		expect(t.move(9_150)).toBe("up");
	});

	test("a drag toward the bottom, then lift, leaves the finger going down for the momentum settle check", () => {
		const t = new TouchScrollTracker();
		t.start(5_000);
		expect(t.move(5_000)).toBeNull();
		expect(t.move(5_240)).toBe("down");
		expect(t.end()).toBe("down");
	});

	test("lifting after an upward drag, or with no scrolling at all, schedules no re-pin", () => {
		const t = new TouchScrollTracker();
		t.start(5_000);
		t.move(5_100);
		t.move(4_900);
		expect(t.end()).toBe("up");
		t.start(4_900); // a tap that stops the glide: no movement, no direction
		expect(t.end()).toBeNull();
	});
});
