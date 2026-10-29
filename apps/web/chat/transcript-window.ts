/**
 * The suffix of the transcript that is mounted. Opening or switching to a long
 * session mounts its tail at once (each card costs a markdown parse and a
 * sanitize pass, so the whole list in one task blocks the page) and the stream
 * then mounts older items in small time-sliced chunks until `start` reaches 0
 * (`showEarlier`), or earlier when the reader nears the top or jumps to a card
 * that is not mounted yet (`reveal`). Every item ends up mounted, so find-in-page
 * and free scrolling work as usual once the backfill is done; items pushed
 * later stay mounted.
 *
 * `start` is the index of the first mounted item. The window never begins
 * inside a run that draws as one row at its first call: it starts at the run's
 * first call, so the row is not lost while its later calls are mounted.
 */
import { $TRACK, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { unwrap } from "solid-js/store";
import type { ChatItem } from "../state";

/** Items mounted when a transcript opens. */
export const WINDOW_INITIAL = 30;
/** Items a reveal or the near-top loader adds above the first. */
export const WINDOW_CHUNK = 30;

export interface TranscriptWindow {
	/** The mounted items, oldest first. The same array every time, rewritten in place. */
	items: Accessor<ChatItem[]>;
	/** Items older than the first mounted one. */
	hiddenBefore: Accessor<number>;
	/** Counts up each time another transcript opens (a switch, a rebuild): a backfill of the old one is stale. */
	epoch: Accessor<number>;
	/** Mount `count` more items above the first; false when none are left. Returns synchronously with the cards mounted. */
	showEarlier(count?: number): boolean;
	/**
	 * Where the window has to start for the newest item `match` accepts to be mounted with a
	 * chunk of older ones above it (so the card can be scrolled to the middle of the screen):
	 * an index at or before the current start means older items must still be mounted down to
	 * it, one `showEarlier` at a time; undefined when no item matches.
	 */
	revealStart(match: (item: ChatItem) => boolean): number | undefined;
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
		/** A run member's first call (see `windowStartFor`). */
		leadOf: (id: number) => number;
	},
): TranscriptWindow {
	// The first mounted index lives in a plain variable that one computation owns,
	// so no reader can see a start it has not applied. `start` mirrors it for the
	// readers that render it.
	let first = 0;
	const [start, setStart] = createSignal(0);
	const [rev, touch] = createSignal(0);
	const [epoch, setEpoch] = createSignal(0);
	let source: readonly ChatItem[] | undefined;
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
			if (raw !== source) {
				// Another transcript (a switch, a rebuild): open at its tail.
				source = raw;
				first = startFor(raw, raw.length - WINDOW_INITIAL);
				setEpoch((n) => n + 1);
			} else if (first > raw.length) {
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
		epoch,
		showEarlier(count = WINDOW_CHUNK) {
			if (first <= 0) return false;
			const raw = untrack(() => read().raw);
			first = startFor(raw, Math.max(0, first - count));
			touch((n) => n + 1);
			return true;
		},
		revealStart(match) {
			const raw = untrack(() => read().raw);
			const index = raw.findLastIndex(match);
			return index < 0 ? undefined : startFor(raw, index - WINDOW_CHUNK);
		},
	};
}
