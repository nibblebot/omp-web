/**
 * Where an anchored popover opens: the preferred side, a flip when that side is short of room and the
 * other has more, and a clamp that keeps it inside the viewport.
 */
import { describe, expect, test } from "bun:test";
import { placePopover, type PopoverPlacementOptions } from "../components/ui/popover-placement";

const viewport = { width: 1000, height: 800 };
const opts: PopoverPlacementOptions = {
	width: 320,
	side: "above",
	align: "start",
	gap: 4,
	margin: 8,
	minRoom: 240,
};
const anchorAt = (top: number, left = 400, size = 28) => ({
	top,
	bottom: top + size,
	left,
	right: left + size,
});

describe("placePopover", () => {
	test("opens above the anchor when there is room", () => {
		const p = placePopover(anchorAt(600), viewport, opts);
		expect(p.side).toBe("above");
		// Bottom edge sits `gap` above the anchor's top.
		expect(p.offset).toBe(viewport.height - 600 + 4);
		expect(p.maxHeight).toBe(600 - 4 - 8);
	});

	test("flips below when the room above is short and below has more", () => {
		const p = placePopover(anchorAt(100), viewport, opts);
		expect(p.side).toBe("below");
		expect(p.offset).toBe(128 + 4);
		expect(p.maxHeight).toBe(800 - 128 - 4 - 8);
	});

	test("stays on the preferred side when it is short but the other side is shorter", () => {
		const tight = { width: 1000, height: 200 };
		const p = placePopover(anchorAt(120, 400, 28), tight, opts);
		// above: 120-12 = 108; below: 200-148-12 = 40.
		expect(p.side).toBe("above");
	});

	test("a below preference flips above near the viewport's foot", () => {
		const p = placePopover(anchorAt(700), viewport, { ...opts, side: "below" });
		expect(p.side).toBe("above");
		expect(placePopover(anchorAt(100), viewport, { ...opts, side: "below" }).side).toBe("below");
	});

	test("the left edge is clamped inside the viewport margin", () => {
		expect(placePopover(anchorAt(600, 2), viewport, opts).left).toBe(8);
		expect(placePopover(anchorAt(600, 990), viewport, opts).left).toBe(1000 - 320 - 8);
	});

	test("end alignment lines the right edges up, then clamps", () => {
		const aligned = placePopover(anchorAt(600, 700), viewport, { ...opts, align: "end" });
		expect(aligned.left).toBe(728 - 320);
		const clamped = placePopover(anchorAt(600, 100), viewport, { ...opts, align: "end" });
		expect(clamped.left).toBe(8);
	});

	test("a viewport narrower than the popover shrinks it to fit between the margins", () => {
		const phone = { width: 375, height: 700 };
		const wide = { ...opts, width: 440, align: "end" as const };
		const p = placePopover(anchorAt(600, 340), phone, wide);
		expect(p.width).toBe(375 - 2 * 8);
		expect(p.left).toBe(8);
		expect(p.left + p.width).toBeLessThanOrEqual(phone.width - 8);
	});

	test("the requested width is kept when the viewport has room", () => {
		expect(placePopover(anchorAt(600), viewport, opts).width).toBe(320);
	});
});
