import { virtualWindow } from "../../usage/model-query";

/** Where one project group sits in the session list and which of its rows to mount. */
export interface GroupSpan {
	/** Group top, in px from the top of the list content. */
	top: number;
	/** Rows `[start, end)` of the group to mount. */
	start: number;
	end: number;
}

/** Rows mounted beyond the viewport edge, in px, before a group counts as on screen. */
const EDGE_ROWS = 8;

/**
 * Layout of project groups stacked in one scroller: each is a head of `headHeight`
 * plus `counts[i]` rows of `rowPitch`. Only groups that reach the viewport (plus overscan)
 * get rows; every other group gets an empty range and is held open by spacers.
 */
export function groupSpans(
	counts: readonly number[],
	scrollTop: number,
	viewportHeight: number,
	rowPitch: number,
	headHeight: number,
): GroupSpan[] {
	const edge = EDGE_ROWS * rowPitch;
	const out: GroupSpan[] = [];
	let top = 0;
	for (const n of counts) {
		const height = headHeight + n * rowPitch;
		const local = scrollTop - top - headHeight;
		let start = 0;
		let end = 0;
		if (top + height >= scrollTop - edge && top <= scrollTop + viewportHeight + edge) {
			const win =
				local < 0
					? virtualWindow(0, viewportHeight + local, rowPitch, n)
					: virtualWindow(local, viewportHeight, rowPitch, n);
			start = win.start;
			end = Math.max(win.start, win.end);
		}
		out.push({ top, start, end });
		top += height;
	}
	return out;
}
