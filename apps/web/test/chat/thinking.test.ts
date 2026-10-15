import { describe, expect, test } from "bun:test";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../chat/thinking";

describe("formatThinkingForDisplay", () => {
	test("returns text untouched when not prose-only and no comment noise", () => {
		const text = "step one\n```ts\nconst a = 1;\n```\nstep two";
		expect(formatThinkingForDisplay(text, false)).toBe(text);
	});

	test("prose-only elides fenced code to an ellipsis on the preceding line", () => {
		const text = "Plan the change:\n```ts\nconst a = 1;\n```\nthen verify.";
		expect(formatThinkingForDisplay(text, true)).toBe("Plan the change:...\nthen verify.");
	});

	test("prose-only keeps an existing trailing period as a single ellipsis", () => {
		const text = "Checking the cache.\n~~~\ncode\n~~~";
		expect(formatThinkingForDisplay(text, true)).toBe("Checking the cache...");
	});

	test("drops empty comment sentinel lines outside fences in both modes", () => {
		const text = "first\n<!-- -->\nsecond";
		expect(formatThinkingForDisplay(text, false)).toBe("first\nsecond");
		expect(formatThinkingForDisplay(text, true)).toBe("first\nsecond");
	});

	test("drops a trailing open comment line", () => {
		expect(formatThinkingForDisplay("answer\n<!--", false)).toBe("answer");
	});

	test("keeps comment-like text inside a fence", () => {
		const text = "```html\n<!-- -->\n```";
		expect(formatThinkingForDisplay(text, false)).toBe(text);
	});

	test("an open fence during streaming elides the rest of the code", () => {
		expect(formatThinkingForDisplay("Reading the file\n```ts\nconst", true)).toBe(
			"Reading the file...",
		);
	});
});

describe("hasDisplayableThinking", () => {
	test("placeholder-only raw text is not displayable", () => {
		expect(hasDisplayableThinking("...", "...")).toBe(false);
		expect(hasDisplayableThinking("…", "…")).toBe(false);
	});

	test("whitespace-only formatted output is not displayable", () => {
		expect(hasDisplayableThinking("<!-- -->", "")).toBe(false);
	});

	test("real prose is displayable", () => {
		expect(hasDisplayableThinking("plan", "plan")).toBe(true);
	});
});
