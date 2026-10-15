/**
 * Pure emoji composer logic ported from the TUI (pi-tui emoji-autocomplete):
 * `:name` suggestions, `:name:` shortcode replace, and emoticon replace.
 * The shortcode table is loaded lazily so it stays out of the main bundle.
 */

/** One popup row: `emoji` is the character to insert, `label` the display text. */
export interface EmojiSuggestion {
	emoji: string;
	label: string;
}

// Bucket layout: `{ "<first-char>": [["<name>", "<emoji>"], ...] }`, each
// bucket pre-sorted by name.
type Entry = readonly [name: string, char: string];
type Buckets = Readonly<Record<string, readonly Entry[]>>;

let buckets: Buckets | null = null;
let loading: Promise<void> | null = null;

/** Loads the shortcode table once; later calls reuse the same promise. */
export function ensureEmojiTable(): Promise<void> {
	// Dynamic import is deliberate: it splits the JSON into its own chunk so the
	// main web bundle never carries the shortcode table.
	loading ??= import("../../../node_modules/@oh-my-pi/pi-tui/src/prompt/data/emojis.json").then(
		(m) => {
			buckets = m.default as unknown as Buckets;
		},
	);
	return loading;
}

// Western text emoticons sit outside the `:name:` grammar. Sorted longest-first
// so `:-)` wins over `:)` when both would match.
const EMOTICONS: ReadonlyArray<readonly [pattern: string, char: string]> = [
	[":'-(", "😢"],
	[">:-(", "😠"],
	[":-)", "🙂"],
	[":-(", "🙁"],
	[":-D", "😃"],
	[":-P", "😛"],
	[":-p", "😛"],
	[":-O", "😮"],
	[":-o", "😮"],
	[":-|", "😐"],
	[":-/", "😕"],
	[":-\\", "😕"],
	[":-*", "😘"],
	[";-)", "😉"],
	[";-P", "😜"],
	[":')", "🥲"],
	[":'D", "😂"],
	[":'(", "😢"],
	["</3", "💔"],
	[">:(", "😠"],
	["B-)", "😎"],
	["8-)", "😎"],
	["o.O", "😳"],
	["O.o", "😳"],
	[":)", "🙂"],
	[":(", "🙁"],
	[":D", "😃"],
	[":P", "😛"],
	[":p", "😛"],
	[":O", "😮"],
	[":o", "😮"],
	[":|", "😐"],
	[":/", "😕"],
	[":\\", "😕"],
	[":*", "😘"],
	[";)", "😉"],
	[":3", "😺"],
	["<3", "❤️"],
	["xD", "😆"],
	["XD", "😆"],
	["B)", "😎"],
	["8)", "😎"],
];

const MAX_SUGGESTIONS = 12;

function lowerBound(arr: readonly Entry[], target: string): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid]![0] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function lookupExact(table: Buckets, name: string): string | undefined {
	const bucket = table[name[0] ?? ""];
	if (!bucket) return undefined;
	const hit = bucket[lowerBound(bucket, name)];
	return hit && hit[0] === name ? hit[1] : undefined;
}

// Shortcode-name characters: `a-z`, `A-Z`, `0-9`, `_`, `+`, `-`.
function isNameCharCode(c: number): boolean {
	return (
		(c >= 0x61 && c <= 0x7a) ||
		(c >= 0x41 && c <= 0x5a) ||
		(c >= 0x30 && c <= 0x39) ||
		c === 0x5f ||
		c === 0x2b ||
		c === 0x2d
	);
}

// Token boundary left of an opening `:`: start of string, whitespace, an
// opening bracket, or `>` for quoted blocks.
function hasLeftBoundary(text: string, colonIdx: number): boolean {
	if (colonIdx === 0) return true;
	const c = text.charCodeAt(colonIdx - 1);
	return (
		c === 0x20 ||
		c === 0x09 ||
		c === 0x0a ||
		c === 0x0d ||
		c === 0x28 ||
		c === 0x5b ||
		c === 0x7b ||
		c === 0x3e
	);
}

// Walk back over name characters, then require an opening `:` with a left boundary.
export function extractTrigger(text: string): { prefix: string; query: string } | null {
	let i = text.length;
	while (i > 0 && isNameCharCode(text.charCodeAt(i - 1))) i--;
	if (i === 0 || text.charCodeAt(i - 1) !== 0x3a) return null;
	if (!hasLeftBoundary(text, i - 1)) return null;
	const name = text.slice(i);
	return { prefix: `:${name}`, query: name.toLowerCase() };
}

/** Popup rows for the `:name` token ending at the cursor; null until the table loads or when nothing matches. */
export function emojiSuggestions(
	textBeforeCursor: string,
): { items: EmojiSuggestion[]; prefix: string } | null {
	const table = buckets;
	if (!table) return null;
	const trigger = extractTrigger(textBeforeCursor);
	// Require at least one letter so a bare `:` in prose ("note:") stays quiet.
	if (!trigger || trigger.query.length === 0) return null;

	const items: EmojiSuggestion[] = [];

	// Emoticon literals whose pattern starts with `:<query>` come first.
	const wanted = `:${trigger.query}`;
	for (const [pattern, char] of EMOTICONS) {
		if (items.length >= MAX_SUGGESTIONS) break;
		if (pattern.length < wanted.length) continue;
		if (pattern.toLowerCase().slice(0, wanted.length) !== wanted) continue;
		items.push({ emoji: char, label: `${char}  ${pattern}` });
	}

	const bucket = table[trigger.query[0]!];
	if (bucket) {
		for (
			let i = lowerBound(bucket, trigger.query);
			i < bucket.length && items.length < MAX_SUGGESTIONS;
			i++
		) {
			const [name, char] = bucket[i]!;
			if (!name.startsWith(trigger.query)) break;
			items.push({ emoji: char, label: `${char}  :${name}:` });
		}
	}

	return items.length === 0 ? null : { items, prefix: trigger.prefix };
}

function shortcodeReplace(
	table: Buckets,
	text: string,
): { replaceLen: number; insert: string } | null {
	const len = text.length;
	// Shortcode replace only fires on a trailing `:`.
	if (len === 0 || text.charCodeAt(len - 1) !== 0x3a) return null;
	const closeIdx = len - 1;
	let nameStart = closeIdx;
	while (nameStart > 0 && isNameCharCode(text.charCodeAt(nameStart - 1))) nameStart--;
	if (nameStart === closeIdx) return null; // empty name (`::`)
	if (nameStart === 0 || text.charCodeAt(nameStart - 1) !== 0x3a) return null;
	if (!hasLeftBoundary(text, nameStart - 1)) return null;
	const name = text.slice(nameStart, closeIdx).toLowerCase();
	const char = lookupExact(table, name);
	return char ? { replaceLen: name.length + 2, insert: char } : null;
}

// A trailing space/tab/newline/CR confirms the token is finished, so typing
// `:PATH` does not turn into an emoji halfway through.
// Fires once a terminator follows the pattern; the terminator is preserved.
// EMOTICONS is longest-first so `:-) ` wins over `:) `.
function emoticonReplace(text: string): { replaceLen: number; insert: string } | null {
	const len = text.length;
	if (len < 2) return null;
	const terminator = text.charCodeAt(len - 1);
	if (terminator !== 0x20 && terminator !== 0x09 && terminator !== 0x0a && terminator !== 0x0d)
		return null;
	const term = text[len - 1]!;
	const tail = len - 1;
	for (const [pattern, char] of EMOTICONS) {
		const plen = pattern.length;
		if (tail < plen) continue;
		const start = tail - plen;
		if (!text.startsWith(pattern, start)) continue;
		// Emoticons embedded in identifiers, URLs, or code stay untouched.
		if (start > 0 && !hasLeftBoundary(text, start)) continue;
		return { replaceLen: plen + 1, insert: char + term };
	}
	return null;
}

/** Inline rewrite for a just-typed `:name:` shortcode (needs the table) or `;) ` emoticon (does not); null when none applies. */
export function emojiInlineReplace(
	textBeforeCursor: string,
): { replaceLen: number; insert: string } | null {
	return (
		(buckets && shortcodeReplace(buckets, textBeforeCursor)) ?? emoticonReplace(textBeforeCursor)
	);
}
