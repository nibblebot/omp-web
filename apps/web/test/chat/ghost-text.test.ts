import { describe, expect, test } from "bun:test";
import { WORD_CONTEXT_CHARS, wordQueryArgs } from "../../components/chat/composer/useGhostText";

describe("wordQueryArgs", () => {
	test("a draft within the window goes whole, cursor at its end", () => {
		const draft = "short draft";
		expect(wordQueryArgs(draft)).toEqual([draft, draft.length]);
	});

	test("a large draft sends only its tail, cursor at the end of that tail", () => {
		const draft = `${"word ".repeat(20_000)}last wor`;
		const [text, cursor] = wordQueryArgs(draft);
		expect(text.length).toBeLessThanOrEqual(WORD_CONTEXT_CHARS);
		expect(cursor).toBe(text.length);
		expect(draft.endsWith(text)).toBe(true);
	});

	test("the window starts on a line start when one is near the cut", () => {
		const draft = `${"x".repeat(100)}\n${"line\n".repeat(20_000)}tail`;
		const [text] = wordQueryArgs(draft);
		expect(text.startsWith("line\n")).toBe(true);
		expect(draft.endsWith(text)).toBe(true);
	});

	test("the window never starts inside a surrogate pair", () => {
		const draft = "😀".repeat(40_000);
		const [text] = wordQueryArgs(draft);
		expect(text.charCodeAt(0)).toBeGreaterThanOrEqual(0xd800);
		expect(text.charCodeAt(0)).toBeLessThan(0xdc00);
	});
});
