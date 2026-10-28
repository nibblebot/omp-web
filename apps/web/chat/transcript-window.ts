/**
 * The tail of the transcript that is mounted. A long session draws its last
 * screens at once and older items on demand: opening or switching to a
 * 1500-item session mounts a few dozen cards instead of every one (each card
 * costs a markdown parse and a sanitize pass whether or not it is on screen),
 * and the per-item `content-visibility` observers, Ctrl+O and the DOM stay
 * proportional to what is mounted.
 *
 * `start` is the index of the first mounted item. A pinned stream follows the
 * tail (the window keeps about WINDOW_INITIAL items and drops the oldest ones
 * as the transcript grows); an unpinned one keeps `start` where it is, so what
 * the reader scrolled to never moves, and grows upward through `showEarlier`
 * when the reader nears the top. The window never begins inside a run that
 * draws as one row at its first call: it starts at the run's first call, so
 * the row is not lost while its later calls are mounted.
 */
import { $TRACK, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { unwrap } from "solid-js/store";
import type { ChatItem } from "../state";

/** Items mounted when a transcript opens, and kept while the stream follows its tail. */
export const WINDOW_INITIAL = 30;
/** Items one `showEarlier` adds. */
export const WINDOW_CHUNK = 30;

export interface TranscriptWindow {
	/** The mounted items, oldest first. The same array every time, rewritten in place. */
	items: Accessor<ChatItem[]>;
	/** Items older than the first mounted one. */
	hiddenBefore: Accessor<number>;
	/** Mount `count` more items above the first; false when none are left. */
	showEarlier(count?: number): boolean;
	/** Mount the newest item `match` accepts, with a chunk of older ones above it; false when there is none. */
	reveal(match: (item: ChatItem) => boolean): boolean;
}

/**
 * The first index at or before `index` the window can begin at: not inside a
 * run drawn at an earlier item (`leadOf` gives a member's first call). Looks
 * past assistant items, which draw no row of their own inside a run.
 */
export function windowStartFor(
	items: readonly ChatItem[],
	index: number,
	leadOf: (id: number) => number,
): number {
	const from = Math.max(0, index);
	let at = from;
	while (at < items.length && items[at]!.kind === "assistant") at++;
	const item = items[at];
	if (item === undefined || item.kind !== "tool") return from;
	const lead = leadOf(item.id);
	if (lead === item.id) return from;
	for (let i = at - 1; i >= 0; i--) if (items[i]!.id === lead) return Math.min(i, from);
	return from;
}

export function createTranscriptWindow(
	items: () => readonly ChatItem[],
	options: {
		/** The viewport sits at the live edge. */
		pinned: () => boolean;
		/** A run member's first call (see `windowStartFor`). */
		leadOf: (id: number) => number;
	},
): TranscriptWindow {
	// The first mounted index lives in a plain variable that one computation owns
	// (it applies the follow rules below before it rewrites the mounted list), so
	// no reader can see a start the rules have not been applied to. `start`
	// mirrors it for the readers that render it.
	let first = 0;
	const [start, setStart] = createSignal(0);
	const [rev, touch] = createSignal(0);
	let source: readonly ChatItem[] | undefined;
	let seenLength = 0;
	let seenPinned = true;
	// A revealed item stays mounted until the viewport leaves the live edge (the jump unpins it).
	let held = false;
	const read = (): { list: readonly ChatItem[]; raw: readonly ChatItem[] } => {
		const list = items();
		// The list's length and structure: an append, or any other write to the array itself.
		void list.length;
		void (list as unknown as Record<symbol, unknown>)[$TRACK];
		return { list, raw: unwrap(list) as readonly ChatItem[] };
	};
	const startFor = (raw: readonly ChatItem[], index: number) =>
		windowStartFor(raw, index, options.leadOf);

	// Rewritten in place and read through a notifying memo: the `<For>` over it
	// keeps one array for its mapper closures however long the transcript grows.
	const view: ChatItem[] = [];
	const mounted = createMemo(
		() => {
			rev();
			const { list, raw } = read();
			const pinned = options.pinned();
			if (!pinned) held = false;
			// The tail rules react to the list growing or the viewport re-pinning, not to the reader mounting older items.
			const followed = raw.length !== seenLength || pinned !== seenPinned;
			seenLength = raw.length;
			seenPinned = pinned;
			if (raw !== source) {
				// Another transcript (a switch, a rebuild): open at its tail.
				source = raw;
				first = startFor(raw, raw.length - WINDOW_INITIAL);
			} else if (first > raw.length) {
				first = startFor(raw, raw.length - WINDOW_INITIAL);
			} else if (
				followed &&
				pinned &&
				!held &&
				raw.length - first > WINDOW_INITIAL + WINDOW_CHUNK
			) {
				// Following the tail: drop the oldest items a chunk at a time, not one per append.
				first = startFor(raw, raw.length - WINDOW_INITIAL);
			}
			if (untrack(start) !== first) setStart(first);
			view.length = 0;
			for (let i = first; i < raw.length; i++) view.push(untrack(() => list[i]!));
			return view;
		},
		view,
		{ equals: false },
	);

	return {
		items: mounted,
		hiddenBefore: start,
		showEarlier(count = WINDOW_CHUNK) {
			if (first <= 0) return false;
			const raw = untrack(() => read().raw);
			first = startFor(raw, Math.max(0, first - count));
			touch((n) => n + 1);
			return true;
		},
		reveal(match) {
			const raw = untrack(() => read().raw);
			const index = raw.findLastIndex(match);
			if (index < 0) return false;
			if (index >= first) return true;
			held = true;
			// With a chunk above it, so the card can be scrolled to the middle of the screen.
			first = startFor(raw, index - WINDOW_CHUNK);
			touch((n) => n + 1);
			return true;
		},
	};
}
