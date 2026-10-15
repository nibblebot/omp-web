/**
 * Magic keywords for the web composer: standalone prose words (`ultrathink`,
 * `orchestrate`, `workflowz`, `jevify`) that glow with a per-word gradient, as
 * in the TUI editor.
 *
 * The table mirrors `MAGIC_KEYWORDS` in `@oh-my-pi/pi-coding-agent`
 * `modes/magic-keywords.ts`, and the matching mirrors `@oh-my-pi/pi-tui`
 * `prompt/magic-keywords.ts`. The web bundle never imports the SDK at runtime;
 * `test/prompt/magic-keywords.test.ts` guards both against drift.
 */
import { maskNonProse } from "./prose-mask";

export type MagicKeywordId = "ultrathink" | "orchestrate" | "workflow" | "jevify";

export interface MagicKeywordSpec {
	readonly id: MagicKeywordId;
	/** Exact lowercase trigger, matched only as standalone prose. */
	readonly word: string;
	/** HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap through red. */
	readonly hue: readonly [number, number];
}

export const MAGIC_KEYWORDS: readonly MagicKeywordSpec[] = [
	{ id: "ultrathink", word: "ultrathink", hue: [0, 330] },
	{ id: "orchestrate", word: "orchestrate", hue: [150, 280] },
	{ id: "workflow", word: "workflowz", hue: [30, 150] },
	{ id: "jevify", word: "jevify", hue: [300, 420] },
];

export interface MagicKeywordRange {
	from: number;
	to: number;
	id: MagicKeywordId;
}

/** Characters that bind a keyword into an identifier or path segment. */
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

/** Characters that cannot immediately follow a standalone keyword. */
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

/**
 * Case-sensitive global matcher for `word` at prose punctuation boundaries.
 * Sentence punctuation and quotes may touch the keyword; letters, digits,
 * underscores, slashes, hyphens, file-extension dots, `foo::keyword` and
 * `keyword(` keep the occurrence embedded in code rather than prose.
 */
function keywordRegex(word: string): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, "gu");
}

/**
 * Ranges of standalone prose keywords (never inside code/XML), sorted by
 * `from`; `enabled(id)` filters which keywords count (default: all).
 */
export function magicKeywordRanges(
	text: string,
	enabled?: (id: MagicKeywordId) => boolean,
): MagicKeywordRange[] {
	const ranges: MagicKeywordRange[] = [];
	let masked: string | undefined;
	for (const spec of MAGIC_KEYWORDS) {
		// Fast path: a keyword that is not even a substring cannot match, so skip masking.
		if (!text.includes(spec.word)) continue;
		if (enabled && !enabled(spec.id)) continue;
		masked ??= maskNonProse(text);
		for (const match of masked.matchAll(keywordRegex(spec.word))) {
			ranges.push({ from: match.index, to: match.index + match[0].length, id: spec.id });
		}
	}
	return ranges.sort((a, b) => a.from - b.from);
}

/** Color stops swept across each keyword, as in the SDK gradient highlighter. */
const GRADIENT_STOPS = 14;

/**
 * HSL saturation and lightness of every gradient stop. The SDK editor uses
 * 90% / 62%, tuned for a dark terminal; 62% lightness is too pale on a white
 * page. The web composer sits on both light and dark themes, so lightness is
 * pulled to 55% while saturation stays high enough that the hues stay distinct.
 */
const GRADIENT_SATURATION = 85;
const GRADIENT_LIGHTNESS = 55;

/**
 * CSS `linear-gradient(90deg, ...)` with 14 HSL stops sweeping the keyword's
 * hue. Stop `i` sits at `t = i / 14` of the `[from, to]` sweep, wrapped into
 * `[0, 360)`, exactly as the SDK `createGradientHighlighter` computes it.
 */
export function magicKeywordGradient(id: MagicKeywordId): string {
	const spec = MAGIC_KEYWORDS.find((candidate) => candidate.id === id);
	if (!spec) throw new Error(`Unknown magic keyword: ${id}`);
	const [from, to] = spec.hue;
	const stops: string[] = [];
	for (let i = 0; i < GRADIENT_STOPS; i++) {
		const hue = Math.round((from + (i / GRADIENT_STOPS) * (to - from)) % 360);
		stops.push(`hsl(${hue}, ${GRADIENT_SATURATION}%, ${GRADIENT_LIGHTNESS}%)`);
	}
	return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Split `text` into plain and keyword segments for rendering; concatenating the segments yields `text`. */
export function magicKeywordSegments(
	text: string,
	enabled?: (id: MagicKeywordId) => boolean,
): Array<{ text: string; id?: MagicKeywordId }> {
	const segments: Array<{ text: string; id?: MagicKeywordId }> = [];
	let last = 0;
	for (const range of magicKeywordRanges(text, enabled)) {
		if (range.from > last) segments.push({ text: text.slice(last, range.from) });
		segments.push({ text: text.slice(range.from, range.to), id: range.id });
		last = range.to;
	}
	if (last < text.length) segments.push({ text: text.slice(last) });
	return segments;
}
