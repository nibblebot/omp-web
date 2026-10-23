import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { highlightCode } from "./highlight";

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
// markup is part of the string DOMPurify sanitizes. Returning false falls back
// to marked's default `<pre><code class="language-x">` output, which is what
// open fences, unknown languages and the not-yet-loaded state render.
const markdown = new Marked({
	renderer: {
		code({ text, lang, raw }: Tokens.Code) {
			const language = lang?.match(/^\S*/)?.[0];
			if (!language || !isClosedFence(raw)) return false;
			const html = highlightCode(text.replace(/\n$/, ""), language);
			if (html === null) return false;
			const cls = language.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
			return `<pre><code class="language-${cls}">${html}\n</code></pre>\n`;
		},
	},
});

// Sanitization is mandatory, because model output can contain raw HTML.
// `highlightCode` reads the highlighter's ready signal, so a memo wrapping this
// call re-runs once highlight.js finishes loading.
export function renderMarkdown(src: string): string {
	return getMarkdownSanitizer().sanitize(markdown.parse(src, { async: false }));
}

/**
 * Splits a streaming markdown source into frozen paragraphs (parsed once) and
 * a live tail (re-parsed per frame). Blank lines split ONLY outside fenced
 * code blocks. When `final` is true, everything is complete.
 */
export function splitForStreaming(
	src: string,
	final: boolean,
): { complete: string[]; tail: string } {
	if (final) return { complete: src ? [src] : [], tail: "" };
	const lines = src.split("\n");
	const complete: string[] = [];
	let inFence = false;
	let segStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trimStart();
		if (trimmed === "" && !inFence) {
			const chunk = lines.slice(segStart, i).join("\n");
			if (chunk.trim() !== "") complete.push(chunk);
			segStart = i + 1;
			continue;
		}
		if (trimmed.startsWith("```")) inFence = !inFence;
	}
	return { complete, tail: lines.slice(segStart).join("\n") };
}
