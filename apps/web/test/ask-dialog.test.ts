/**
 * The ask dialog's answer logic: what counts as answered, where the cursor
 * lands when a question is entered, and the results sent for the whole
 * question list (skipped questions included).
 */

import { describe, expect, test } from "bun:test";
import {
	answerSummary,
	buildResults,
	entryCursor,
	initialAnswer,
	isAnswered,
	tabLabel,
} from "../prompt/ask-dialog";
import type { AskQuestion } from "../prompt/ask-types";

const scope: AskQuestion = {
	id: "scope",
	question: "Which scope?",
	options: [{ label: "Narrow" }, { label: "Wide" }, { label: "Everything" }],
	recommended: 1,
};
const checks: AskQuestion = {
	id: "checks",
	header: " Checks ",
	question: "Which checks?",
	options: [{ label: "types" }, { label: "lint" }],
	multi: true,
};

describe("ask dialog answers", () => {
	test("a selected option or non-blank custom text is an answer; whitespace is not", () => {
		expect(isAnswered({ selected: ["Narrow"], custom: "" })).toBe(true);
		expect(isAnswered({ selected: [], custom: "my own" })).toBe(true);
		expect(isAnswered({ selected: [], custom: "   " })).toBe(false);
		expect(isAnswered({ selected: [], custom: "" })).toBe(false);
	});

	test("the recommended option starts selected", () => {
		expect(initialAnswer(scope)).toEqual({ selected: ["Wide"], custom: "" });
		expect(initialAnswer(checks)).toEqual({ selected: [], custom: "" });
	});

	test("the cursor lands on the first selected option, else the recommended one, else the first", () => {
		expect(entryCursor(scope, { selected: ["Everything", "Narrow"], custom: "" })).toBe(0);
		expect(entryCursor(scope, { selected: ["Everything"], custom: "" })).toBe(2);
		expect(entryCursor(scope, { selected: [], custom: "" })).toBe(1);
		expect(entryCursor(checks, { selected: [], custom: "" })).toBe(0);
	});

	test("tabs use the trimmed header, falling back to Q<n>", () => {
		expect(tabLabel(checks, 1)).toBe("Checks");
		expect(tabLabel(scope, 0)).toBe("Q1");
		expect(tabLabel({ ...scope, header: "  " }, 2)).toBe("Q3");
	});

	test("the review summary joins labels and custom text, and is empty when skipped", () => {
		expect(answerSummary({ selected: ["types", "lint"], custom: " extra " })).toBe(
			"types, lint, extra",
		);
		expect(answerSummary({ selected: [], custom: "only custom" })).toBe("only custom");
		expect(answerSummary({ selected: [], custom: "  " })).toBe("");
	});
});

describe("ask dialog results", () => {
	test("one result per question in order; skipped questions carry no selection or custom input", () => {
		const results = buildResults(
			[scope, checks],
			[
				{ selected: [], custom: "" },
				{ selected: ["lint"], custom: "" },
			],
		);
		expect(results).toEqual([
			{
				id: "scope",
				question: "Which scope?",
				options: ["Narrow", "Wide", "Everything"],
				multi: false,
				selectedOptions: [],
			},
			{
				id: "checks",
				question: "Which checks?",
				options: ["types", "lint"],
				multi: true,
				selectedOptions: ["lint"],
			},
		]);
		expect("customInput" in results[0]).toBe(false);
	});

	test("custom text is trimmed and omitted when blank", () => {
		const [trimmed, blank] = buildResults(
			[scope, checks],
			[
				{ selected: [], custom: "  my own  " },
				{ selected: ["types"], custom: "   " },
			],
		);
		expect(trimmed.customInput).toBe("my own");
		expect("customInput" in blank).toBe(false);
	});
});
