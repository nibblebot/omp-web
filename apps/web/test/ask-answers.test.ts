/**
 * The ask transcript card merges the offered options (call args) with the
 * user's answer (SDK AskToolDetails): chosen options are marked, extra and
 * custom answers stay visible, and a chat redirect carries no answers.
 */

import { describe, expect, test } from "bun:test";
import { answersOf, askDetails, questionViews } from "../chat/ask-answers";

const opts = (...labels: string[]) => labels.map((label) => ({ label }));

describe("ask answer merge", () => {
	test("single-question details mark the chosen option", () => {
		const details = askDetails({ selectedOptions: ["B"] });
		const [view] = questionViews(
			[{ question: "Pick", options: opts("A", "B") }],
			answersOf(details),
		);
		expect(view?.question).toBe("Pick");
		expect(view?.options.map((o) => [o.label, o.selected])).toEqual([
			["A", false],
			["B", true],
		]);
		expect(view?.answer?.empty).toBe(false);
	});

	test("multi-question results align with the questions by index", () => {
		const details = askDetails({
			results: [{ selectedOptions: ["Y"] }, { selectedOptions: ["P"] }],
		});
		const views = questionViews(
			[
				{ question: "First", options: opts("X", "Y") },
				{ question: "Second", options: opts("P", "Q") },
			],
			answersOf(details),
		);
		expect(views.map((v) => v.options.filter((o) => o.selected).map((o) => o.label))).toEqual([
			["Y"],
			["P"],
		]);
	});

	test("questions beyond the results stay unanswered", () => {
		const details = askDetails({ results: [{ selectedOptions: ["X"] }] });
		const views = questionViews(
			[
				{ question: "First", options: opts("X") },
				{ question: "Second", options: opts("P", "Q") },
			],
			answersOf(details),
		);
		expect(views).toHaveLength(2);
		expect(views[0]?.answer).toBeDefined();
		expect(views[1]?.answer).toBeUndefined();
		expect(views[1]?.options.some((o) => o.selected)).toBe(false);
	});

	test("without args the result's own question and options are shown", () => {
		const details = askDetails({
			results: [{ question: "Which?", options: ["A", "B"], multi: true, selectedOptions: ["A"] }],
		});
		const [view] = questionViews([], answersOf(details));
		expect(view?.question).toBe("Which?");
		expect(view?.multi).toBe(true);
		expect(view?.options).toEqual([
			{ label: "A", selected: true },
			{ label: "B", selected: false },
		]);
	});

	test("a selection missing from the offered options is appended as selected", () => {
		const details = askDetails({ selectedOptions: ["Z"] });
		const [view] = questionViews([{ question: "Pick", options: opts("A") }], answersOf(details));
		expect(view?.options).toEqual([
			{ label: "A", description: undefined, selected: false },
			{ label: "Z", selected: true },
		]);
	});

	test("a custom-only answer selects nothing, keeps the text, and is not empty", () => {
		const details = askDetails({ selectedOptions: [], customInput: "something else" });
		const [view] = questionViews(
			[{ question: "Pick", options: opts("A", "B") }],
			answersOf(details),
		);
		expect(view?.options.some((o) => o.selected)).toBe(false);
		expect(view?.answer?.customInput).toBe("something else");
		expect(view?.answer?.empty).toBe(false);
	});

	test("an answered multi-select with nothing chosen is empty", () => {
		const details = askDetails({ selectedOptions: [], multi: true });
		const [view] = questionViews(
			[{ question: "Pick", options: opts("A", "B"), multi: true }],
			answersOf(details),
		);
		expect(view?.answer?.empty).toBe(true);
		expect(view?.answer?.customInput).toBeUndefined();
	});

	test("a chat redirect yields no answers", () => {
		const details = askDetails({ chatRedirect: true });
		expect(answersOf(details)).toEqual([]);
		const [view] = questionViews([{ question: "Pick", options: opts("A") }], answersOf(details));
		expect(view?.answer).toBeUndefined();
	});
});
