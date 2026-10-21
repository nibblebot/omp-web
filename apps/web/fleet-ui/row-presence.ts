// ---------------------------------------------------------------------------
// Pure derivation of a project group's rendered row list: the live rows plus
// the rows that just left the roster and are still playing their exit motion.
// ProjectGroups feeds it each roster change; RowMotion plays the motion and
// reports the exit's end back through finishRowExit.
// ---------------------------------------------------------------------------

/** "enter": mounted this frame as a brand-new row (plays its enter motion);
 *  "open": settled; "exit": left the roster, kept rendered until its exit ends. */
export type RowMode = "enter" | "open" | "exit";

export interface RowSlot<T> {
	id: string;
	item: T;
	mode: RowMode;
}

/** The first render of a group: every row is already there, none animates. */
export function initialRowSlots<T>(live: readonly T[], idOf: (item: T) => string): RowSlot<T>[] {
	return live.map((item) => ({ id: idOf(item), item, mode: "open" }));
}

/**
 * Next slot list after a roster change.
 *
 * - An id never rendered before enters ("enter"); a page load or a roster
 *   refresh that only reports known ids animates nothing.
 * - An "enter" slot stays "enter" until it leaves (RowMotion flips its own
 *   phase a frame later), so a status frame right after creation cannot cut
 *   the enter motion short.
 * - An id that left the roster becomes "exit" and keeps its last item and its
 *   position (right after the nearest preceding row that is still rendered).
 * - An id re-added while exiting returns to "open"; the CSS transition
 *   reverses from where it is.
 * - `animate: false` (the group is collapsed, nothing is on screen to play
 *   motion) settles everything: no enter, no exit, exiting rows are dropped.
 *   Expanding the group later therefore never counts its rows as new.
 */
export function reconcileRowSlots<T>(
	prev: readonly RowSlot<T>[],
	live: readonly T[],
	idOf: (item: T) => string,
	animate: boolean,
): RowSlot<T>[] {
	if (!animate) return initialRowSlots(live, idOf);
	const prevById = new Map(prev.map((s) => [s.id, s]));
	const liveIds = new Set<string>();
	const out: RowSlot<T>[] = live.map((item) => {
		const id = idOf(item);
		liveIds.add(id);
		const was = prevById.get(id);
		if (was === undefined) return { id, item, mode: "enter" };
		return { id, item, mode: was.mode === "enter" ? "enter" : "open" };
	});
	prev.forEach((slot, index) => {
		if (liveIds.has(slot.id)) return;
		// Insert after the nearest preceding previous row that is still rendered
		// (live, or an exiting row inserted just before: prev is walked in order).
		let at = 0;
		for (let i = index - 1; i >= 0; i--) {
			const found = out.findIndex((s) => s.id === prev[i]!.id);
			if (found >= 0) {
				at = found + 1;
				break;
			}
		}
		out.splice(at, 0, { id: slot.id, item: slot.item, mode: "exit" });
	});
	return out;
}

/** Drop a slot whose exit motion ended, unless it came back in the meantime. */
export function finishRowExit<T>(prev: readonly RowSlot<T>[], id: string): RowSlot<T>[] {
	return prev.filter((s) => s.id !== id || s.mode !== "exit");
}
