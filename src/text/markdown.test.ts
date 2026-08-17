import { describe, expect, test } from "bun:test";
import { splitForStreaming } from "./markdown";

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
