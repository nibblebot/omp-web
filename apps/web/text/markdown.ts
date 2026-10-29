import DOMPurify from "dompurify";
import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { highlightCodeRaw, highlightReady } from "./highlight";

let sanitizer: typeof DOMPurify | undefined;

/** Return the sanitizer shared by rendering and removal diagnostics. */
export function getMarkdownSanitizer(): typeof DOMPurify {
	return (sanitizer ??= DOMPurify());
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * True when a fenced code token's closing fence has arrived: the token spans
 * more than the opening line and its last non-blank line is a fence of the
 * same character that is at least as long as the opener. A streaming fence
 * that is still open ends in code, so it fails this check.
 */
function isClosedFence(raw: string): boolean {
	const lines = raw.trimEnd().split("\n");
	if (lines.length < 2) return false;
	const open = OPEN_FENCE.exec(lines[0]);
	if (!open) return false;
	const fence = open[1];
	const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[lines.length - 1]);
	return close !== null && close[1][0] === fence[0] && close[1].length >= fence.length;
}

// Closed fences with a registered language are highlighted here, so the hljs
// markup is part of the string DOMPurify sanitizes (one pass over the whole
// fragment; `highlightCodeRaw` is unsanitized on purpose). Returning false falls
// back to marked's default `<pre><code class="language-x">` output, which is
// what open fences, unknown languages and the not-yet-loaded state render.
// `consultedHighlighter` records that a render depended on the highlighter's
// ready state, so a cached result is only reused under the state it was made in.
let consultedHighlighter = false;
const markdown = new Marked({
	renderer: {
		code({ text, lang, raw }: Tokens.Code) {
			const language = lang?.match(/^\S*/)?.[0];
			if (!language || !isClosedFence(raw)) return false;
			consultedHighlighter = true;
			const html = highlightCodeRaw(text.replace(/\n$/, ""), language);
			if (html === null) return false;
			const cls = language.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
			return `<pre><code class="language-${cls}">${html}\n</code></pre>\n`;
		},
	},
});

interface Rendered {
	/** Sanitized HTML: only ever the output of `DOMPurify.sanitize`. */
	html: string;
	/** The highlighter's ready state the render saw, or null when it never consulted it. */
	highlighted: boolean | null;
}

// Rendered markdown by source text. Remounting a settled message (switching
// back to a session, a virtualized list re-entering the viewport) re-renders the
// same text, and the live stream renders each frozen segment that a settled
// message later contains. Bounded by entry count and by the characters held
// (source + HTML); the least recently used entry goes first.
const RENDER_CACHE_MAX_ENTRIES = 4000;
const RENDER_CACHE_MAX_CHARS = 16_000_000;
const renderCache = new Map<string, Rendered>();
let renderCacheChars = 0;

function cacheGet(src: string): string | undefined {
	const entry = renderCache.get(src);
	if (entry === undefined) return undefined;
	// Reading the signal re-subscribes a memo to the highlighter finishing its load.
	if (entry.highlighted !== null && entry.highlighted !== highlightReady()) return undefined;
	renderCache.delete(src);
	renderCache.set(src, entry);
	return entry.html;
}

function cachePut(src: string, entry: Rendered): void {
	// One giant message must not flush every other entry.
	if (src.length + entry.html.length > RENDER_CACHE_MAX_CHARS / 8) return;
	const old = renderCache.get(src);
	if (old !== undefined) {
		renderCacheChars -= src.length + old.html.length;
		renderCache.delete(src);
	}
	renderCache.set(src, entry);
	renderCacheChars += src.length + entry.html.length;
	for (const [key, evicted] of renderCache) {
		if (renderCache.size <= RENDER_CACHE_MAX_ENTRIES && renderCacheChars <= RENDER_CACHE_MAX_CHARS)
			break;
		if (key === src) continue;
		renderCache.delete(key);
		renderCacheChars -= key.length + evicted.html.length;
	}
}

/** Sanitized HTML of already-lexed `tokens`; sanitization is mandatory, because model output can contain raw HTML. */
function renderTokens(tokens: Token[]): Rendered {
	consultedHighlighter = false;
	const html = getMarkdownSanitizer().sanitize(markdown.parser(tokens));
	return { html, highlighted: consultedHighlighter ? highlightReady() : null };
}

/** `\r\n` and lone `\r` read as `\n`, as marked's lexer does, so token `raw` strings concatenate back into the source. */
function normalizeNewlines(src: string): string {
	return src.includes("\r") ? src.replace(/\r\n?/g, "\n") : src;
}

/**
 * Top-level blocks of `tokens[from, to)` grouped into segments: each is one
 * non-blank block followed by the blank lines after it (blank lines before the
 * first block ride with it), so the segments concatenate back to the source.
 */
function segmentsOf(tokens: Token[], from: number, to: number): string[] {
	const out: string[] = [];
	let seg = "";
	let hasBlock = false;
	for (let i = from; i < to; i++) {
		const token = tokens[i];
		if (token.type !== "space" && hasBlock) {
			out.push(seg);
			seg = "";
		}
		seg += token.raw;
		if (token.type !== "space") hasBlock = true;
	}
	if (seg !== "") out.push(seg);
	return out;
}

/** A source this long may be a streamed message whose segments are already rendered. */
const SEGMENTED_MIN_CHARS = 1500;

/**
 * Renders a long source from the cached HTML of its top-level blocks when most
 * of it is cached (a message that just finished streaming), rendering and
 * caching the misses; undefined when the cache would not help or when a block
 * is not self-contained. Link reference definitions resolve across blocks and
 * a raw HTML block can span blank lines, so a source with either renders whole.
 */
function renderFromSegments(src: string, tokens: TokensList): Rendered | undefined {
	if (Object.keys(tokens.links).length > 0 || tokens.some((token) => token.type === "html")) {
		return undefined;
	}
	const segments = segmentsOf(tokens, 0, tokens.length);
	if (segments.join("") !== normalizeNewlines(src)) return undefined;
	let cached = 0;
	for (const segment of segments) {
		if (renderCache.has(segment)) cached += segment.length;
	}
	if (cached * 2 < src.length) return undefined;
	let html = "";
	let highlighted: boolean | null = null;
	for (const segment of segments) {
		let entry = renderCache.get(segment);
		if (
			entry === undefined ||
			(entry.highlighted !== null && entry.highlighted !== highlightReady())
		) {
			entry = renderTokens(markdown.lexer(segment));
			cachePut(segment, entry);
		}
		html += entry.html;
		if (entry.highlighted !== null) highlighted = entry.highlighted;
	}
	return { html, highlighted };
}

// `highlightCodeRaw` reads the highlighter's ready signal, so a memo wrapping
// this call re-runs once highlight.js finishes loading (cache hits that depend
// on it read the signal too). `cache: false` skips the cache for text that will
// not be rendered again, such as the streaming tail.
export function renderMarkdown(src: string, options?: { cache?: boolean }): string {
	const useCache = options?.cache !== false;
	if (useCache) {
		const hit = cacheGet(src);
		if (hit !== undefined) return hit;
	}
	const tokens = markdown.lexer(src);
	const entry =
		(useCache && src.length >= SEGMENTED_MIN_CHARS ? renderFromSegments(src, tokens) : undefined) ??
		renderTokens(tokens);
	if (useCache) cachePut(src, entry);
	return entry.html;
}

/** A line that is only digits: possibly an ordered-list marker still being typed. */
const BARE_NUMBER = /^ {0,3}\d{1,9}$/;

/** A streaming markdown source as frozen blocks (final, rendered once) and the open tail (re-rendered per frame). */
export interface StreamSplit {
	frozen: readonly string[];
	tail: string;
}

/**
 * A splitter for one growing markdown source. A block is frozen once a later
 * block has started, so what it holds is final: the lexer, not blank lines,
 * decides where blocks end (a list with a blank line between items stays one
 * block, a fence with blank lines in it too). Only the unfrozen remainder is
 * lexed on each call. `frozen` keeps its identity until a block freezes; strings
 * are the exact source slices, so they key `renderMarkdown`'s cache. When the
 * source stops extending what was frozen (a different text altogether), it
 * starts over.
 */
export function createStreamSplitter(): (src: string) => StreamSplit {
	let frozen: readonly string[] = [];
	let frozenText = "";
	return (source) => {
		const src = normalizeNewlines(source);
		if (!src.startsWith(frozenText)) {
			frozen = [];
			frozenText = "";
		}
		let rest = frozenText === "" ? src : src.slice(frozenText.length);
		const tokens = markdown.lexer(rest);
		let open = tokens.length - 1;
		while (open >= 0 && tokens[open].type === "space") open--;
		// A bare number may be the start of an ordered-list marker ("2" of "2. two"):
		// the block before it, a list, would then still be growing.
		while (open > 0 && BARE_NUMBER.test(tokens[open].raw)) {
			open--;
			while (open > 0 && tokens[open].type === "space") open--;
		}
		// tokens[open] is the block still growing; blank lines after it are its own.
		if (open > 1 || (open === 1 && tokens[0].type !== "space")) {
			const segments = segmentsOf(tokens, 0, open);
			const text = segments.join("");
			if (rest.startsWith(text)) {
				frozen = frozen.concat(segments);
				frozenText += text;
				rest = rest.slice(text.length);
			}
		}
		return { frozen, tail: rest };
	};
}
