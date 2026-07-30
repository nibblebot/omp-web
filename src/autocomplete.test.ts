import { describe, expect, test } from "bun:test";
import { currentToken, fenceOpen, fuzzyRank } from "./autocomplete";

describe("currentToken", () => {
	test("slash only completes at position 0", () => {
		expect(currentToken("/com", 4)).toEqual({ mode: "slash", query: "com", start: 0, end: 4 });
		expect(currentToken("hey /com", 8)).toBeNull();
	});

	test("@ completes after whitespace or start", () => {
		expect(currentToken("see @pac", 8)).toEqual({ mode: "file", query: "pac", start: 4, end: 8 });
		expect(currentToken("@pac", 4)).toEqual({ mode: "file", query: "pac", start: 0, end: 4 });
	});

	test("ordinary tokens and empty input return null", () => {
		expect(currentToken("hello", 5)).toBeNull();
		expect(currentToken("", 0)).toBeNull();
	});

	test("suppressed inside a fenced code block", () => {
		expect(fenceOpen("before\n```js\ncode")).toBe(true);
		expect(currentToken("```\n/comp", 8)).toBeNull();
		expect(fenceOpen("```\ncode\n```\nafter")).toBe(false);
	});
});

describe("fuzzyRank", () => {
	test("exact beats prefix beats subsequence", () => {
		expect(fuzzyRank("compact", "compact")).toBe(0);
		expect(fuzzyRank("comp", "compact")).toBeLessThan(2);
		expect(fuzzyRank("cmp", "compact")).toBeGreaterThanOrEqual(2);
	});

	test("non-matches return null", () => {
		expect(fuzzyRank("xyz", "compact")).toBeNull();
	});

	test("empty query matches everything at rank 0", () => {
		expect(fuzzyRank("", "anything")).toBe(0);
	});
});
