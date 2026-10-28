import type { ChatItem } from "../state";

/**
 * Structural equality of two plain-data values (items are JSON-shaped: no
 * functions, no cycles). A key holding `undefined` equals a missing key, since
 * the history builder writes `usage: undefined` where a live-built item omits it.
 */
function sameData(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	let defined = 0;
	for (const key in left) {
		if (left[key] === undefined) continue;
		if (!sameData(left[key], right[key])) return false;
		defined++;
	}
	for (const key in right) if (right[key] !== undefined) defined--;
	return defined === 0;
}

/**
 * The transcript to show when a history frame lands while items are already on
 * screen (a re-attach of the session being viewed, a history resync): the
 * longest prefix whose items are unchanged keeps the ON-SCREEN objects, and
 * only the rest is the freshly built `next`. Replacing every object would
 * make the keyed transcript list dispose and remount every card (and drop its
 * local state) for a transcript that did not change; an appended tail or a
 * changed suffix remounts only the cards it touches. Returns `prev` itself
 * when nothing differs, so the caller can skip the write.
 *
 * Items carry ids assigned sequentially by the history builder, so an item
 * is unchanged only when its position, id and content all match.
 */
export function keepUnchangedPrefix(prev: readonly ChatItem[], next: ChatItem[]): ChatItem[] {
	const limit = Math.min(prev.length, next.length);
	let same = 0;
	while (same < limit && sameData(prev[same], next[same])) same++;
	if (same === prev.length && same === next.length) return prev as ChatItem[];
	if (same === 0) return next;
	const merged = prev.slice(0, same);
	for (let i = same; i < next.length; i++) merged.push(next[i]);
	return merged;
}
