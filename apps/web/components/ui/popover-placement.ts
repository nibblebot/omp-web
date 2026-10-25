/** Where an anchored popover sits: the side it opens on, its left edge, its distance from the viewport edge and its height cap. */
export interface PopoverPlacement {
	side: "above" | "below";
	/** Left edge in viewport px, clamped so the popover stays inside the viewport. */
	left: number;
	/** `top` px when opening below, `bottom` px when opening above (both measured from the viewport edge). */
	offset: number;
	/** Room on the chosen side: the popover never grows past it. */
	maxHeight: number;
}

export interface PopoverPlacementOptions {
	width: number;
	/** Preferred side; the popover flips only when that side is short of room and the other has more. */
	side: "above" | "below";
	/** Which edge of the anchor the popover lines up with. */
	align: "start" | "end";
	/** Gap between the anchor and the popover. */
	gap: number;
	/** Minimum distance to the viewport edge. */
	margin: number;
	/** Below this much room on the preferred side the popover flips when the other side has more. */
	minRoom: number;
}

/**
 * Anchored placement: the preferred side of the anchor, flipped when the room there
 * is under `minRoom` and the opposite side has more, clamped inside the viewport.
 */
export function placePopover(
	anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
	viewport: { width: number; height: number },
	opts: PopoverPlacementOptions,
): PopoverPlacement {
	const wanted = opts.align === "end" ? anchor.right - opts.width : anchor.left;
	const left = Math.max(opts.margin, Math.min(wanted, viewport.width - opts.width - opts.margin));
	const below = viewport.height - anchor.bottom - opts.gap - opts.margin;
	const above = anchor.top - opts.gap - opts.margin;
	const preferred = opts.side === "above" ? above : below;
	const other = opts.side === "above" ? below : above;
	const flipped = preferred < opts.minRoom && other > preferred;
	const side = !flipped ? opts.side : opts.side === "above" ? "below" : "above";
	return side === "above"
		? { side, left, offset: viewport.height - anchor.top + opts.gap, maxHeight: Math.max(0, above) }
		: { side, left, offset: anchor.bottom + opts.gap, maxHeight: Math.max(0, below) };
}
