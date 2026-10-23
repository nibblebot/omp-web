import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	highlightCode as HighlightCode,
	highlightLines as HighlightLines,
	languageForPath as LanguageForPath,
	loadHighlighter as LoadHighlighter,
} from "../../text/highlight";
import type {
	getMarkdownSanitizer as GetMarkdownSanitizer,
	renderMarkdown as RenderMarkdown,
	splitForStreaming as SplitForStreaming,
} from "../../text/markdown";

// ---------------------------------------------------------------------------
// Minimal DOM double.
//
// Bun's test runner has no DOM, and dompurify refuses to sanitize without one
// (isSupported is false, so `DOMPurify.sanitize` is undefined), which would
// leave renderMarkdown untestable. This double implements just the surface
// dompurify's string path touches: a node tree with prototype accessors, a
// document-order NodeIterator, an HTML tokenizer that honors raw-text elements
// and quoted attributes, and an HTML serializer. It is NOT a browser DOM or a
// spec HTML parser: no layout, shadow roots or document fragments, no
// implied-tag or foreign-content parsing, and only the common named entities
// decode — deliberately scoped to the fixed inputs below, where the `removed`
// assertions fail loudly if the double ever stops handing dompurify the
// dangerous node it must strip.
// ---------------------------------------------------------------------------
const HTML_NS = "http://www.w3.org/1999/xhtml";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;

const VOID_TAGS: Record<string, true> = {
	area: true,
	base: true,
	br: true,
	col: true,
	embed: true,
	hr: true,
	img: true,
	input: true,
	link: true,
	meta: true,
	param: true,
	source: true,
	track: true,
	wbr: true,
};

/** Elements whose content the tokenizer must swallow as text, closing tag included. */
const RAW_TEXT_TAGS: Record<string, true> = {
	script: true,
	style: true,
	textarea: true,
	title: true,
	xmp: true,
	iframe: true,
	noembed: true,
	noframes: true,
	plaintext: true,
};

class MinAttr {
	value: string;
	constructor(
		readonly name: string,
		value: string,
		readonly namespaceURI: string | null = null,
	) {
		this.value = value;
	}
}

class MinNode {
	#type: number;
	#name: string;
	#owner: MinDocument | null;
	#parent: MinNode | null = null;
	#children: MinNode[] = [];

	constructor(type: number, name: string, owner: MinDocument | null) {
		this.#type = type;
		this.#name = name;
		this.#owner = owner;
	}

	get nodeType(): number {
		return this.#type;
	}
	get nodeName(): string {
		return this.#name;
	}
	get ownerDocument(): MinDocument | null {
		return this.#owner;
	}
	get parentNode(): MinNode | null {
		return this.#parent;
	}
	get childNodes(): MinNode[] {
		return this.#children;
	}
	get firstChild(): MinNode | null {
		return this.#children[0] ?? null;
	}
	get nextSibling(): MinNode | null {
		const parent = this.#parent;
		if (!parent) return null;
		const index = parent.#children.indexOf(this);
		return index === -1 ? null : (parent.#children[index + 1] ?? null);
	}
	get firstElementChild(): MinElement | null {
		for (const child of this.#children) if (child instanceof MinElement) return child;
		return null;
	}
	get textContent(): string {
		let out = "";
		for (const child of this.#children) out += child.textContent;
		return out;
	}
	hasChildNodes(): boolean {
		return this.#children.length > 0;
	}
	appendChild(node: MinNode): MinNode {
		return this.insertBefore(node, null);
	}
	insertBefore(node: MinNode, reference: MinNode | null): MinNode {
		const index = reference === null ? this.#children.length : this.#children.indexOf(reference);
		if (index === -1) throw new Error("reference node is not a child");
		node.#parent?.removeChild(node);
		node.#parent = this;
		if (this.#owner) node.#adopt(this.#owner);
		this.#children.splice(index, 0, node);
		return node;
	}
	removeChild(node: MinNode): MinNode {
		const index = this.#children.indexOf(node);
		if (index === -1) throw new Error("node is not a child");
		this.#children.splice(index, 1);
		node.#parent = null;
		return node;
	}
	#adopt(owner: MinDocument): void {
		this.#owner = owner;
		for (const child of this.#children) child.#adopt(owner);
	}
}

class MinText extends MinNode {
	#data: string;
	constructor(data: string, owner: MinDocument | null = null) {
		super(TEXT_NODE, "#text", owner);
		this.#data = data;
	}
	get data(): string {
		return this.#data;
	}
	get textContent(): string {
		return this.#data;
	}
}

class MinComment extends MinNode {
	#data: string;
	constructor(data: string, owner: MinDocument | null = null) {
		super(COMMENT_NODE, "#comment", owner);
		this.#data = data;
	}
	get data(): string {
		return this.#data;
	}
	get textContent(): string {
		return this.#data;
	}
}

class MinElement extends MinNode {
	#tag: string;
	#namespace: string;
	#attrs: MinAttr[] = [];

	constructor(tag: string, namespace: string = HTML_NS, owner: MinDocument | null = null) {
		super(ELEMENT_NODE, tag, owner);
		this.#tag = tag;
		this.#namespace = namespace;
	}
	get tagName(): string {
		return this.#tag;
	}
	get namespaceURI(): string {
		return this.#namespace;
	}
	get attributes(): MinAttr[] {
		return this.#attrs;
	}
	get children(): MinElement[] {
		return this.childNodes.filter((child): child is MinElement => child instanceof MinElement);
	}
	getAttribute(name: string): string | null {
		return this.#attr(name)?.value ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.#attr(name) !== null;
	}
	setAttribute(name: string, value: string): void {
		this.setAttributeNS(null, name, value);
	}
	setAttributeNS(namespace: string | null, name: string, value: string): void {
		const existing = this.#attr(name);
		if (existing) existing.value = value;
		else this.#attrs.push(new MinAttr(name, value, namespace));
	}
	getAttributeNode(name: string): MinAttr | null {
		return this.#attr(name);
	}
	removeAttribute(name: string): void {
		const attr = this.#attr(name);
		if (attr) this.removeAttributeNode(attr);
	}
	removeAttributeNode(attr: MinAttr): MinAttr {
		const index = this.#attrs.indexOf(attr);
		if (index === -1) throw new Error("attribute is not on this element");
		this.#attrs.splice(index, 1);
		return attr;
	}
	#attr(name: string): MinAttr | null {
		for (const attr of this.#attrs) if (attr.name === name) return attr;
		return null;
	}
	get innerHTML(): string {
		return serializeChildren(this);
	}
}

class MinDocument extends MinNode {
	readonly implementation = { createHTMLDocument: (): MinDocument => new MinDocument() };

	constructor() {
		super(DOCUMENT_NODE, "#document", null);
	}

	get documentElement(): MinElement | null {
		const child = this.childNodes.find((node): node is MinElement => node instanceof MinElement);
		return child ?? null;
	}
	get body(): MinElement | null {
		const html = this.documentElement;
		if (!html) return null;
		if (html.tagName === "body") return html;
		return html.children.find((child) => child.tagName === "body") ?? null;
	}
	createElement(name: string): MinElement {
		return new MinElement(name, HTML_NS, this);
	}
	createTextNode(data: string): MinText {
		return new MinText(data, this);
	}
	createComment(data: string): MinComment {
		return new MinComment(data, this);
	}
	getElementsByTagName(name: string): MinElement[] {
		return collectByTagName(this, name);
	}
	createNodeIterator(root: MinNode, whatToShow: number): MinNodeIterator {
		return new MinNodeIterator(root, whatToShow);
	}
}

type TrailStep = { node: MinNode; nextSibling: MinNode | null };

/**
 * `nextNode()` in document order, masked by `whatToShow`. dompurify removes
 * the node it just visited (sometimes after hoisting that node's children into
 * the parent), so the walk precomputes where it resumes instead of relying on
 * the visited node still being attached.
 */
class MinNodeIterator {
	readonly root: MinNode;
	readonly whatToShow: number;
	#started = false;
	#last: MinNode | null = null;
	#hoistedChild: MinNode | null = null;
	#trail: TrailStep[] = [];

	constructor(root: MinNode, whatToShow: number) {
		this.root = root;
		this.whatToShow = whatToShow;
	}

	nextNode(): MinNode | null {
		let candidate = this.#started ? this.#resume() : this.root;
		while (candidate && !this.#accepts(candidate)) candidate = this.#advance(candidate);
		if (!candidate) return null;
		this.#record(candidate);
		return candidate;
	}

	#resume(): MinNode | null {
		if (!this.#last) return null;
		if (this.#attached(this.#last)) return this.#advance(this.#last);
		const hoisted = this.#hoistedChild;
		if (hoisted && this.#attached(hoisted)) return hoisted;
		for (let index = this.#trail.length - 1; index >= 0; index--) {
			const step = this.#trail[index];
			if (!step || !this.#attached(step.node)) continue;
			if (step.nextSibling && this.#attached(step.nextSibling)) return step.nextSibling;
		}
		return null;
	}

	#advance(node: MinNode): MinNode | null {
		if (node.firstChild) return node.firstChild;
		let cursor: MinNode | null = node;
		while (cursor && cursor !== this.root) {
			if (cursor.nextSibling) return cursor.nextSibling;
			cursor = cursor.parentNode;
		}
		return null;
	}

	#record(node: MinNode): void {
		this.#started = true;
		this.#last = node;
		this.#hoistedChild = node.firstChild;
		this.#trail = [];
		for (let cursor: MinNode | null = node; cursor; cursor = cursor.parentNode) {
			this.#trail.push({ node: cursor, nextSibling: cursor.nextSibling });
			if (cursor === this.root) break;
		}
	}

	#attached(node: MinNode): boolean {
		for (let cursor: MinNode | null = node; cursor; cursor = cursor.parentNode) {
			if (cursor === this.root) return true;
		}
		return false;
	}

	#accepts(node: MinNode): boolean {
		return (this.whatToShow & (1 << (node.nodeType - 1))) !== 0;
	}
}

class MinDOMParser {
	parseFromString(html: string): MinDocument {
		const doc = new MinDocument();
		const htmlEl = doc.createElement("html");
		htmlEl.appendChild(doc.createElement("head"));
		htmlEl.appendChild(doc.createElement("body"));
		doc.appendChild(htmlEl);
		parseInto(doc.body as MinElement, html, doc);
		return doc;
	}
}

function collectByTagName(root: MinNode, name: string): MinElement[] {
	const wanted = name.toLowerCase();
	const found: MinElement[] = [];
	const walk = (node: MinNode): void => {
		for (const child of node.childNodes) {
			if (!(child instanceof MinElement)) continue;
			if (wanted === "*" || child.tagName === wanted) found.push(child);
			walk(child);
		}
	};
	walk(root);
	return found;
}

function parseInto(parent: MinNode, html: string, doc: MinDocument): void {
	const open: MinElement[] = [];
	const append = (node: MinNode): void => {
		(open[open.length - 1] ?? parent).appendChild(node);
	};
	const appendText = (text: string): void => {
		const decoded = decodeEntities(text);
		if (decoded !== "") append(doc.createTextNode(decoded));
	};
	let index = 0;
	while (index < html.length) {
		const lt = html.indexOf("<", index);
		if (lt === -1) {
			appendText(html.slice(index));
			break;
		}
		if (lt > index) appendText(html.slice(index, lt));
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			append(doc.createComment(html.slice(lt + 4, end === -1 ? html.length : end)));
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			index = end === -1 ? html.length : end + 1;
			continue;
		}
		const gt = findTagEnd(html, lt);
		if (gt === -1) {
			appendText(html.slice(lt));
			break;
		}
		const raw = html.slice(lt + 1, gt);
		if (raw.startsWith("/")) {
			const name = raw.slice(1).trim().toLowerCase();
			for (let depth = open.length - 1; depth >= 0; depth--) {
				if (open[depth]?.tagName === name) {
					open.length = depth;
					break;
				}
			}
			index = gt + 1;
			continue;
		}
		const selfClosing = raw.endsWith("/");
		const inner = selfClosing ? raw.slice(0, -1) : raw;
		const nameMatch = /^[^\s/>]+/.exec(inner);
		if (nameMatch === null) {
			appendText(html.slice(lt, gt + 1));
			index = gt + 1;
			continue;
		}
		const name = nameMatch[0].toLowerCase();
		const element = doc.createElement(name);
		parseAttributes(element, inner.slice(nameMatch[0].length));
		append(element);
		index = gt + 1;
		if (!selfClosing && RAW_TEXT_TAGS[name]) {
			const close = html.toLowerCase().indexOf(`</${name}`, index);
			const textEnd = close === -1 ? html.length : close;
			if (textEnd > index) element.appendChild(doc.createTextNode(html.slice(index, textEnd)));
			const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
			index = closeEnd === -1 ? html.length : closeEnd + 1;
			continue;
		}
		if (!selfClosing && !VOID_TAGS[name]) open.push(element);
	}
}

function findTagEnd(html: string, from: number): number {
	let quote: string | null = null;
	for (let index = from; index < html.length; index++) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return index;
	}
	return -1;
}

const ATTRIBUTE = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

function parseAttributes(element: MinElement, text: string): void {
	for (const match of text.matchAll(ATTRIBUTE)) {
		const name = match[1]!.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		element.setAttribute(name, decodeEntities(value));
	}
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body === "amp") return "&";
		if (body === "lt") return "<";
		if (body === "gt") return ">";
		if (body === "quot") return '"';
		if (body === "apos") return "'";
		if (body === "nbsp") return "\u00a0";
		if (body.startsWith("#")) {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
			if (!Number.isNaN(code) && code > 0) return String.fromCodePoint(code);
		}
		return match;
	});
}

function serializeChildren(node: MinNode): string {
	let out = "";
	for (const child of node.childNodes) out += serializeNode(child);
	return out;
}

function serializeNode(node: MinNode): string {
	if (node instanceof MinText) return escapeText(node.data);
	if (node instanceof MinComment) return `<!--${node.data}-->`;
	if (node instanceof MinElement) {
		const attrs = node.attributes
			.map((attr) => ` ${attr.name}="${escapeAttr(attr.value)}"`)
			.join("");
		const open = `<${node.tagName}${attrs}>`;
		if (VOID_TAGS[node.tagName]) return open;
		return `${open}${serializeChildren(node)}</${node.tagName}>`;
	}
	return serializeChildren(node);
}

function escapeText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const NODE_FILTER = {
	SHOW_ALL: 0xffffffff,
	SHOW_ELEMENT: 1,
	SHOW_ATTRIBUTE: 2,
	SHOW_TEXT: 4,
	SHOW_CDATA_SECTION: 8,
	SHOW_ENTITY_REFERENCE: 16,
	SHOW_ENTITY: 32,
	SHOW_PROCESSING_INSTRUCTION: 64,
	SHOW_COMMENT: 128,
	SHOW_DOCUMENT: 256,
	SHOW_DOCUMENT_TYPE: 512,
	SHOW_DOCUMENT_FRAGMENT: 1024,
	SHOW_NOTATION: 2048,
};

/** Install the double as `globalThis.window`; restore only while still owned. */
function installMinimalDom(): () => void {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	const window = {
		document: new MinDocument(),
		DOMParser: MinDOMParser,
		Node: MinNode,
		Element: MinElement,
		NodeFilter: NODE_FILTER,
		HTMLFormElement: class HTMLFormElement {},
		NamedNodeMap: class NamedNodeMap {},
	} as unknown as Window & typeof globalThis;
	const installed: PropertyDescriptor = {
		value: window,
		writable: true,
		enumerable: true,
		configurable: true,
	};
	Object.defineProperty(globalThis, "window", installed);
	return () => {
		const current = Object.getOwnPropertyDescriptor(globalThis, "window");
		if (
			current?.value !== window ||
			current.writable !== installed.writable ||
			current.enumerable !== installed.enumerable ||
			current.configurable !== installed.configurable
		) {
			return;
		}
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else Reflect.deleteProperty(globalThis, "window");
	};
}

let restoreMinimalDom: (() => void) | undefined;
let renderMarkdown: typeof RenderMarkdown;
let splitForStreaming: typeof SplitForStreaming;
let getMarkdownSanitizer: typeof GetMarkdownSanitizer;
let highlightCode: typeof HighlightCode;
let highlightLines: typeof HighlightLines;
let languageForPath: typeof LanguageForPath;
let loadHighlighter: typeof LoadHighlighter;

// Import in the hook after installing the DOM double so the first sanitizer
// creation sees this window, without mutating globals while collecting tests.
beforeAll(async () => {
	restoreMinimalDom = installMinimalDom();
	({ renderMarkdown, splitForStreaming, getMarkdownSanitizer } =
		await import("../../text/markdown"));
	({ highlightCode, highlightLines, languageForPath, loadHighlighter } =
		await import("../../text/highlight"));
});
afterAll(() => {
	restoreMinimalDom?.();
	restoreMinimalDom = undefined;
});

/**
 * What the sanitizer stripped during its last run, as `element:<tag>` /
 * `attribute:<name>` entries. Asserting on it proves the dangerous markup was
 * really parsed and removed, which an output-only assertion cannot: a double
 * that silently dropped the node would produce the same clean output.
 */
function removedBySanitizer(): string[] {
	const DOMPurify = getMarkdownSanitizer();
	return DOMPurify.removed.map((entry) =>
		"element" in entry
			? `element:${entry.element.nodeName}`
			: `attribute:${entry.attribute?.name ?? "null"}`,
	);
}

describe("renderMarkdown", () => {
	test("<script> is stripped", () => {
		expect(renderMarkdown("safe <script>alert(1)</script> done")).toBe("<p>safe  done</p>\n");
		expect(removedBySanitizer()).toEqual(["element:script"]);
	});

	test("<img onerror=...> keeps the image but loses the handler", () => {
		const src = `look <img src="https://e/x.png" onerror="alert(1)">`;
		expect(renderMarkdown(src)).toBe('<p>look <img src="https://e/x.png"></p>\n');
		expect(removedBySanitizer()).toEqual(["attribute:onerror"]);
	});

	test("a javascript: href is neutralized", () => {
		const src = `<a href="javascript:alert(1)">click</a>`;
		expect(renderMarkdown(src)).toBe("<p><a>click</a></p>\n");
		expect(removedBySanitizer()).toEqual(["attribute:href"]);
	});

	test("benign markdown (emphasis, code, links) survives intact", () => {
		const src = "*a* and `code <x>` and [link](https://example.com)";
		expect(renderMarkdown(src)).toBe(
			'<p><em>a</em> and <code>code &lt;x&gt;</code> and <a href="https://example.com">link</a></p>\n',
		);
		expect(removedBySanitizer()).toEqual([]);
	});
});

describe("splitForStreaming", () => {
	test("splits on blank lines outside fences", () => {
		expect(splitForStreaming("a\n\nb", false)).toEqual({ complete: ["a"], tail: "b" });
	});

	test("does not split on blank lines inside a fenced code block", () => {
		const src = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
		expect(splitForStreaming(src, false)).toEqual({
			complete: ["```js\nconst a = 1;\n\nconst b = 2;\n```"],
			tail: "after",
		});
	});

	test("final: everything complete, tail empty", () => {
		expect(splitForStreaming("a\n\nb", true)).toEqual({ complete: ["a\n\nb"], tail: "" });
	});

	test("unclosed fence keeps everything in the tail", () => {
		const src = "intro\n\n```\nopen block\n\nstill open";
		expect(splitForStreaming(src, false)).toEqual({
			complete: ["intro"],
			tail: "```\nopen block\n\nstill open",
		});
	});
});

describe("highlightCode", () => {
	test("returns null until the library has loaded, then highlights", async () => {
		// First call triggers the lazy load and renders plain.
		expect(highlightCode("const a = 1;", "ts")).toBeNull();
		await loadHighlighter();
		const html = highlightCode("const a = 1;", "ts");
		expect(html).toContain('<span class="hljs-keyword">const</span>');
	});

	test("resolves aliases and returns null for unknown or missing languages", async () => {
		await loadHighlighter();
		for (const alias of [
			"sh",
			"shell",
			"zsh",
			"py",
			"tsx",
			"js",
			"jsx",
			"yml",
			"toml",
			"html",
			"c++",
			"golang",
			"rs",
		]) {
			expect(highlightCode("x", alias)).not.toBeNull();
		}
		expect(highlightCode("x", "klingon")).toBeNull();
		expect(highlightCode("x", undefined)).toBeNull();
		expect(highlightCode("x", "")).toBeNull();
	});

	test("escapes markup inside the code", async () => {
		await loadHighlighter();
		const html = highlightCode('<img src=x onerror="alert(1)">', "html");
		expect(html).not.toBeNull();
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;");
	});

	test("repeat calls hit the cache and return an identical string", async () => {
		await loadHighlighter();
		const first = highlightCode("def f(): return 1", "python");
		expect(first).not.toBeNull();
		expect(highlightCode("def f(): return 1", "python")).toBe(first);
	});
});

describe("languageForPath", () => {
	test("maps extensions onto registered grammars", () => {
		const cases: Record<string, string> = {
			"a.ts": "typescript",
			"a/b/c.TSX": "typescript",
			"x.mts": "typescript",
			"x.cts": "typescript",
			"a.js": "javascript",
			"a.jsx": "javascript",
			"a.mjs": "javascript",
			"a.cjs": "javascript",
			"a.py": "python",
			"a.rs": "rust",
			"a.go": "go",
			"a.json": "json",
			"tsconfig.jsonc": "json",
			"a.yaml": "yaml",
			"a.yml": "yaml",
			"Cargo.toml": "ini",
			"a.ini": "ini",
			"a.css": "css",
			"a.html": "xml",
			"a.xml": "xml",
			"icon.svg": "xml",
			"a.sql": "sql",
			"a.diff": "diff",
			"a.patch": "diff",
			"README.md": "markdown",
			"a.c": "c",
			"a.h": "c",
			"a.cpp": "cpp",
			"a.cc": "cpp",
			"a.hpp": "cpp",
			"A.java": "java",
			"a.sh": "bash",
			"a.bash": "bash",
			"a.zsh": "bash",
			"/home/u/.zshrc": "bash",
			".gitconfig": "ini",
		};
		for (const [path, lang] of Object.entries(cases)) {
			expect(languageForPath(path)).toBe(lang);
		}
	});

	test("every mapped language is registered", async () => {
		await loadHighlighter();
		for (const path of ["a.ts", "a.js", "a.py", "a.toml", "a.svg", "a.hh", "a.zsh", "a.jsonc"]) {
			expect(highlightCode("x", languageForPath(path))).not.toBeNull();
		}
	});

	test("unknown, missing and extensionless names have no language", () => {
		for (const path of [
			"",
			"Makefile",
			"Dockerfile",
			".gitignore",
			"a.klingon",
			"dir.ts/noext",
			"a.constructor",
			"a.toString",
		]) {
			expect(languageForPath(path)).toBeUndefined();
		}
	});

	test("tolerates read selectors and archive members", () => {
		expect(languageForPath("src/a.ts:10-20")).toBe("typescript");
		expect(languageForPath("src/a.py:raw:5-9")).toBe("python");
		expect(languageForPath("bundle.zip:src/a.rs")).toBe("rust");
		expect(languageForPath("bundle.tar.gz:notes.md")).toBe("markdown");
	});
});

/** Every `<span ...>` is closed and nothing but spans nests. */
function balanced(html: string): boolean {
	let depth = 0;
	for (const m of html.matchAll(/<(\/?)span\b[^>]*>/g)) {
		depth += m[1] ? -1 : 1;
		if (depth < 0) return false;
	}
	return depth === 0;
}

describe("highlightLines", () => {
	test("returns null before load, for unknown languages and oversized input", async () => {
		await loadHighlighter();
		expect(highlightLines("x", undefined)).toBeNull();
		expect(highlightLines("x", "klingon")).toBeNull();
		expect(highlightLines("a\n".repeat(60_000), "ts")).toBeNull();
	});

	test("one entry per input line, trailing newline gives a final empty entry", async () => {
		await loadHighlighter();
		const lines = highlightLines("const a = 1;\nconst b = 2;\n", "ts");
		expect(lines).toHaveLength(3);
		expect(lines?.[0]).toContain('<span class="hljs-keyword">const</span>');
		expect(lines?.[1]).toContain('<span class="hljs-keyword">const</span>');
		expect(lines?.[2]).toBe("");
		expect(highlightLines("", "ts")).toEqual([""]);
	});

	test("a multi-line block comment stays colored on every row with balanced spans", async () => {
		await loadHighlighter();
		const code = "/**\n * doc\n\n */\nconst x = 1;";
		const lines = highlightLines(code, "ts");
		expect(lines).toHaveLength(5);
		for (const line of lines ?? []) expect(balanced(line)).toBe(true);
		// Each comment row, including the blank one, is wrapped in the comment span.
		for (const i of [0, 1, 2, 3]) expect(lines?.[i]).toMatch(/^<span class="hljs-comment">/);
		expect(lines?.[1]).toContain(" * doc");
		expect(lines?.[4]).toContain('<span class="hljs-keyword">const</span>');
	});

	test("a multi-line template string and python docstring keep the string span per row", async () => {
		await loadHighlighter();
		const ts = highlightLines("const s = `a\nb\nc`;", "ts");
		expect(ts).toHaveLength(3);
		expect(ts?.[1]).toBe('<span class="hljs-string">b</span>');
		for (const line of ts ?? []) expect(balanced(line)).toBe(true);
		const py = highlightLines('"""doc\nmore\n"""\nx = 1', "python");
		expect(py).toHaveLength(4);
		expect(py?.[1]).toBe('<span class="hljs-string">more</span>');
		for (const line of py ?? []) expect(balanced(line)).toBe(true);
	});

	test("joined lines equal the whole-text highlight and markup stays escaped", async () => {
		await loadHighlighter();
		const code = '<img src=x onerror="alert(1)">\n<!-- c\nd -->\n<b>x</b>';
		const lines = highlightLines(code, "html");
		expect(lines).toHaveLength(4);
		for (const line of lines ?? []) {
			expect(balanced(line)).toBe(true);
			expect(line).not.toContain("<img");
			expect(line).not.toContain("<b>");
		}
		const flat = (lines ?? []).join("\n").replace(/<\/?span\b[^>]*>/g, "");
		const whole = (highlightCode(code, "html") ?? "").replace(/<\/?span\b[^>]*>/g, "");
		expect(flat).toBe(whole);
	});

	test("repeat calls hit the cache and return the same array", async () => {
		await loadHighlighter();
		const first = highlightLines("x = 1\ny = 2", "py");
		expect(first).not.toBeNull();
		expect(highlightLines("x = 1\ny = 2", "py")).toBe(first);
	});
});

describe("renderMarkdown code fences", () => {
	test("a closed fence is highlighted and keeps the language-x shape", async () => {
		await loadHighlighter();
		const html = renderMarkdown("```ts\nconst a = 1;\n```\n");
		expect(html).toContain('<pre><code class="language-ts">');
		expect(html).toContain("hljs-keyword");
	});

	test("an open (unterminated) fence renders exactly as plain", async () => {
		await loadHighlighter();
		const html = renderMarkdown("```ts\nconst a = 1;\n");
		expect(html).toBe('<pre><code class="language-ts">const a = 1;\n</code></pre>\n');
	});

	test("a fence closed by a shorter fence stays open", async () => {
		await loadHighlighter();
		const html = renderMarkdown("````ts\nconst a = 1;\n```\n");
		expect(html).not.toContain("hljs-");
	});

	test("tilde fences close with tildes", async () => {
		await loadHighlighter();
		expect(renderMarkdown("~~~ts\nconst a = 1;\n~~~\n")).toContain("hljs-keyword");
		expect(renderMarkdown("~~~ts\nconst a = 1;\n")).not.toContain("hljs-");
	});

	test("unknown or missing language renders plain", async () => {
		await loadHighlighter();
		expect(renderMarkdown("```klingon\nconst a = 1;\n```\n")).toBe(
			'<pre><code class="language-klingon">const a = 1;\n</code></pre>\n',
		);
		expect(renderMarkdown("```\nconst a = 1;\n```\n")).toBe(
			"<pre><code>const a = 1;\n</code></pre>\n",
		);
	});

	test("markup inside a highlighted fence stays escaped", async () => {
		await loadHighlighter();
		const html = renderMarkdown('```html\n<img src=x onerror="alert(1)">\n```\n');
		expect(html).toContain("hljs-");
		expect(html).not.toContain("<img");
		expect(removedBySanitizer()).toEqual([]);
	});
});
