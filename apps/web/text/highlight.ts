import DOMPurify from "dompurify";
import { createSignal } from "solid-js";
import type { HLJSApi } from "highlight.js";

/**
 * Shared syntax highlighter. highlight.js core and the language grammars are
 * dynamically imported on first use (a separate chunk, never in the initial
 * bundle). Until the load finishes, `highlightCode` returns null and callers
 * render plain text; `highlightReady()` is a Solid signal so memos that read
 * it re-run once the grammars are registered.
 */

/** Past this size the highlight cost outweighs the benefit; render plain. */
const MAX_HIGHLIGHT_CHARS = 100_000;
/** Cache cap: settled tool args and closed fences are never re-highlighted. */
const CACHE_MAX_ENTRIES = 500;

const [ready, setReady] = createSignal(false);

/** True once highlight.js finished loading. Reading it in a memo tracks the flip. */
export const highlightReady = ready;

let hljs: HLJSApi | undefined;
let loading: Promise<void> | undefined;
let sanitizer: typeof DOMPurify | undefined;
const cache = new Map<string, string>();

async function loadGrammars(): Promise<HLJSApi> {
	const [
		core,
		bash,
		json,
		python,
		typescript,
		javascript,
		rust,
		go,
		yaml,
		ini,
		css,
		xml,
		sql,
		diff,
		markdown,
		c,
		cpp,
		java,
	] = await Promise.all([
		import("highlight.js/lib/core"),
		import("highlight.js/lib/languages/bash"),
		import("highlight.js/lib/languages/json"),
		import("highlight.js/lib/languages/python"),
		import("highlight.js/lib/languages/typescript"),
		import("highlight.js/lib/languages/javascript"),
		import("highlight.js/lib/languages/rust"),
		import("highlight.js/lib/languages/go"),
		import("highlight.js/lib/languages/yaml"),
		import("highlight.js/lib/languages/ini"),
		import("highlight.js/lib/languages/css"),
		import("highlight.js/lib/languages/xml"),
		import("highlight.js/lib/languages/sql"),
		import("highlight.js/lib/languages/diff"),
		import("highlight.js/lib/languages/markdown"),
		import("highlight.js/lib/languages/c"),
		import("highlight.js/lib/languages/cpp"),
		import("highlight.js/lib/languages/java"),
	]);
	const api = core.default;
	api.registerLanguage("bash", bash.default);
	api.registerLanguage("json", json.default);
	api.registerLanguage("python", python.default);
	api.registerLanguage("typescript", typescript.default);
	api.registerLanguage("javascript", javascript.default);
	api.registerLanguage("rust", rust.default);
	api.registerLanguage("go", go.default);
	api.registerLanguage("yaml", yaml.default);
	api.registerLanguage("ini", ini.default);
	api.registerLanguage("css", css.default);
	api.registerLanguage("xml", xml.default);
	api.registerLanguage("sql", sql.default);
	api.registerLanguage("diff", diff.default);
	api.registerLanguage("markdown", markdown.default);
	api.registerLanguage("c", c.default);
	api.registerLanguage("cpp", cpp.default);
	api.registerLanguage("java", java.default);
	// Grammars already bring most aliases (sh, zsh, py, ts, tsx, js, jsx, yml,
	// toml, html, c++, golang, rs, md, patch); add the ones they lack.
	api.registerAliases(["shell"], { languageName: "bash" });
	api.registerAliases(["jsonc"], { languageName: "json" });
	return api;
}

/** Start (once) loading highlight.js; resolves when `highlightReady()` is true. */
export function loadHighlighter(): Promise<void> {
	loading ??= loadGrammars().then((api) => {
		hljs = api;
		setReady(true);
	});
	return loading;
}

/**
 * Highlight `code` as sanitized hljs HTML, or null when the library is not
 * loaded yet, `lang` is missing/unregistered, or the input is too large.
 * Never auto-detects the language. The first call triggers the lazy load.
 */
export function highlightCode(code: string, lang: string | undefined): string | null {
	const isReady = ready();
	if (!isReady) {
		void loadHighlighter();
		return null;
	}
	const name = lang?.trim().toLowerCase();
	if (!name || !hljs?.getLanguage(name)) return null;
	if (code.length > MAX_HIGHLIGHT_CHARS) return null;
	const key = `${name}\0${code}`;
	const hit = cache.get(key);
	if (hit !== undefined) {
		// Refresh recency.
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const raw = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
	const html = (sanitizer ??= DOMPurify()).sanitize(raw);
	if (cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, html);
	return html;
}

const linesCache = new Map<string, string[]>();

/**
 * Split sanitized hljs HTML into one HTML string per source line. hljs emits
 * only `<span class="…">` wrappers and entity-escaped text, so tracking the
 * span stack is enough: every open span is closed at a line end and reopened at
 * the next line start, which keeps each entry balanced on its own.
 */
function splitHtmlLines(html: string): string[] {
	const out: string[] = [];
	const open: string[] = [];
	let current = "";
	let last = 0;
	for (const m of html.matchAll(/<span\b[^>]*>|<\/span>|\n/g)) {
		current += html.slice(last, m.index);
		last = m.index + m[0].length;
		if (m[0] === "\n") {
			out.push(current + "</span>".repeat(open.length));
			current = open.join("");
		} else if (m[0] === "</span>") {
			open.pop();
			current += m[0];
		} else {
			open.push(m[0]);
			current += m[0];
		}
	}
	out.push(current + html.slice(last));
	return out;
}

/**
 * Highlight `code` once as a whole (so multi-line comments and strings color
 * correctly), then return one sanitized, span-balanced HTML string per line:
 * exactly `code.split("\n").length` entries, a trailing newline yielding a
 * final empty entry. Null in the same cases as {@link highlightCode}.
 */
export function highlightLines(code: string, lang: string | undefined): string[] | null {
	const html = highlightCode(code, lang);
	if (html === null) return null;
	const key = `${lang?.trim().toLowerCase()}\0${code}`;
	const hit = linesCache.get(key);
	if (hit !== undefined) {
		linesCache.delete(key);
		linesCache.set(key, hit);
		return hit;
	}
	const lines = splitHtmlLines(html);
	if (linesCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = linesCache.keys().next().value;
		if (oldest !== undefined) linesCache.delete(oldest);
	}
	linesCache.set(key, lines);
	return lines;
}

/** File extension (no dot, lowercase) to registered grammar. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	pyi: "python",
	rs: "rust",
	go: "go",
	json: "json",
	jsonc: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	ini: "ini",
	cfg: "ini",
	css: "css",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	sql: "sql",
	diff: "diff",
	patch: "diff",
	md: "markdown",
	markdown: "markdown",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	java: "java",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
};

/** Extensionless or dotfile names that carry a language. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
	".bashrc": "bash",
	".bash_profile": "bash",
	".zshrc": "bash",
	".profile": "bash",
	".gitconfig": "ini",
	".editorconfig": "ini",
	"cargo.lock": "ini",
};

/** Trailing read/grep selector (`:50-100`, `:raw`, `:-20`) on a path. */
const PATH_SELECTOR = /(?::(?:raw|conflicts|-?\d[\d,+-]*))+$/;

/**
 * Registered grammar for a file path, or undefined when the file type has none
 * (callers render plain text). Tolerates read selectors (`a.ts:10-20`) and
 * archive members (`bundle.zip:src/a.ts`).
 */
export function languageForPath(path: string): string | undefined {
	const trimmed = path.trim().replace(PATH_SELECTOR, "");
	const sep = Math.max(
		trimmed.lastIndexOf("/"),
		trimmed.lastIndexOf("\\"),
		trimmed.lastIndexOf(":"),
	);
	const base = trimmed.slice(sep + 1).toLowerCase();
	if (Object.hasOwn(LANGUAGE_BY_FILENAME, base)) return LANGUAGE_BY_FILENAME[base];
	const dot = base.lastIndexOf(".");
	// A leading-dot-only name (`.gitignore`) has no extension.
	if (dot <= 0) return undefined;
	const ext = base.slice(dot + 1);
	return Object.hasOwn(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : undefined;
}
