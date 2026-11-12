/**
 * The ask transcript card reads two shapes of the tool. Question shape (before
 * SDK 18.18.3): the offered options (call args) merge with the user's answer
 * (details): chosen options are marked, extra and custom answers stay visible,
 * and a chat redirect carries no answers. Form shape: details list each field's
 * answer, and a call without an answer still shows what its HTML form asks.
 */

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import {
	answersOf,
	askDetails,
	askFormPrompts,
	askHtml,
	formAnswerViews,
	noteLabel,
	questionViews,
	type FormHtmlParser,
} from "../chat/ask-answers";

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

describe("ask note on an option", () => {
	test("the answer carries the option the note was attached to", () => {
		const details = askDetails({
			results: [
				{ selectedOptions: ["Wide"], note: "only for the docs", noteOption: "Wide" },
				{ selectedOptions: ["A"], note: "general remark" },
			],
		});
		const views = questionViews([], answersOf(details));
		expect(views.map((v) => [v.answer?.note, v.answer?.noteOption])).toEqual([
			["only for the docs", "Wide"],
			["general remark", undefined],
		]);
	});

	test("the label names the option, else stays Note", () => {
		expect(noteLabel("Wide")).toBe("Note on Wide");
		expect(noteLabel(undefined)).toBe("Note");
	});
});

describe("ask form answers", () => {
	test("each answered field lists its question and value in form order", () => {
		const details = askDetails({
			answers: [
				{ name: "db", question: "Which database?", answer: "PostgreSQL" },
				{ name: "notes", question: "Anything else?", answer: "keep migrations small" },
			],
		});
		expect(formAnswerViews(details)).toEqual([
			{ name: "db", question: "Which database?", answer: "PostgreSQL", notes: [] },
			{ name: "notes", question: "Anything else?", answer: "keep migrations small", notes: [] },
		]);
	});

	test("a blank answer is empty and a missing question falls back to the name", () => {
		const details = askDetails({ answers: [{ name: "notes", question: "  ", answer: "" }] });
		expect(formAnswerViews(details)).toEqual([
			{ name: "notes", question: "notes", answer: "", notes: [] },
		]);
	});

	test("a timed-out submission still lists its answers and keeps the flag", () => {
		const details = askDetails({
			timedOut: true,
			answers: [{ name: "db", question: "Which database?", answer: "SQLite" }],
		});
		expect(formAnswerViews(details)).toHaveLength(1);
		expect(details?.timedOut).toBe(true);
	});

	test("question-shape details yield no form answers, and form details no question answers", () => {
		expect(formAnswerViews(askDetails({ selectedOptions: ["A"] }))).toEqual([]);
		expect(formAnswerViews(undefined)).toEqual([]);
		expect(answersOf(askDetails({ answers: [{ name: "db", answer: "x" }] }))).toEqual([]);
	});

	test("option notes list under the answer with their field's name and question", () => {
		const note = (name: string, question: string, option: string, text: string) => ({
			name,
			question,
			option,
			value: option.toLowerCase(),
			text,
		});
		const details = askDetails({
			answers: [
				{ name: "db", question: "Which database?", answer: "PostgreSQL" },
				{ name: "checks", question: "Which checks?", answer: "Types, Lint" },
				{ name: "db", question: "Which replica?", answer: "Primary" },
			],
			notes: [
				note("checks", "Which checks?", "Lint", "only the fast rules"),
				note("db", "Which database?", "Postgre\n  SQL", " already deployed \n"),
				note("checks", "Which checks?", "Types", "strict mode\nno any"),
				// Same name, other question: belongs to the second db field only.
				note("db", "Which replica?", "Primary", "closest region"),
				// No answer claims it: not shown.
				note("gone", "Which database?", "x", "orphan"),
			],
		});
		expect(formAnswerViews(details).map((a) => a.notes)).toEqual([
			[{ option: "Postgre SQL", text: "already deployed" }],
			[
				{ option: "Lint", text: "only the fast rules" },
				{ option: "Types", text: "strict mode\nno any" },
			],
			[{ option: "Primary", text: "closest region" }],
		]);
	});

	test("malformed notes are ignored and never break the answers", () => {
		const answers = [{ name: "db", question: "Which database?", answer: "SQLite" }];
		const valid = { name: "db", question: "Which database?", option: "SQLite", value: "sqlite" };
		for (const notes of ["note", 7, { 0: valid }, null]) {
			expect(formAnswerViews(askDetails({ answers, notes }))[0]?.notes).toEqual([]);
		}
		const views = formAnswerViews(
			askDetails({
				answers,
				notes: [
					null,
					"text",
					{ ...valid },
					{ ...valid, text: 3 },
					{ ...valid, value: ["sqlite"], text: "x" },
					{ ...valid, option: undefined, text: "x" },
					{ ...valid, text: "   " },
					{ ...valid, text: "kept" },
				],
			}),
		);
		expect(views).toEqual([
			{
				name: "db",
				question: "Which database?",
				answer: "SQLite",
				notes: [{ option: "SQLite", text: "kept" }],
			},
		]);
	});

	test("askHtml reads only a string html arg", () => {
		expect(askHtml({ html: "<form></form>" })).toBe("<form></form>");
		expect(askHtml({ questions: [] })).toBeUndefined();
		expect(askHtml({ html: 3 })).toBeUndefined();
		expect(askHtml(null)).toBeUndefined();
	});
});

describe("ask form prompts", () => {
	// A real DOM implementation stands in for the browser's inert DOMParser; the wrapper
	// gives it the html/body document a browser parse of a fragment yields.
	const parse: FormHtmlParser = (html) =>
		parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

	test("legends, paragraphs and text-control labels are the questions; option labels are not", () => {
		const html = `<form>
			<fieldset><legend>Which database?</legend>
				<label><input type="radio" name="db" value="sqlite"> SQLite</label>
				<label><input type="radio" name="db" value="pg"> Postgres</label>
			</fieldset>
			<p>Pick the <code>checks</code> to run</p>
			<label>Branch name <input type="text" name="branch"></label>
			<label for="n">Notes</label><textarea id="n" name="notes">draft text</textarea>
		</form>`;
		expect(askFormPrompts(html, parse)).toEqual([
			"Which database?",
			"Pick the checks to run",
			"Branch name",
			"Notes",
		]);
	});

	test("markup is read as text: scripts and styles contribute nothing", () => {
		const html = `<form><p>Ship it?<script>alert(1)</script><style>p{}</style></p></form>`;
		expect(askFormPrompts(html, parse)).toEqual(["Ship it?"]);
	});

	test("a form without question markup falls back to its plain text", () => {
		expect(
			askFormPrompts("<form>Continue with the upgrade? <input name=go></form>", parse),
		).toEqual(["Continue with the upgrade?"]);
		expect(askFormPrompts("", parse)).toEqual([]);
	});

	test("the list is bounded in count and length", () => {
		const many = Array.from({ length: 30 }, (_, i) => `<p>Question ${i}</p>`).join("");
		expect(askFormPrompts(`<form>${many}</form>`, parse)).toHaveLength(12);
		const [long] = askFormPrompts(`<form><p>${"x".repeat(500)}</p></form>`, parse);
		expect(long).toHaveLength(160);
		expect(long?.endsWith("…")).toBe(true);
	});

	test("repeated text is listed once", () => {
		expect(askFormPrompts("<form><p>Same?</p><p>Same?</p></form>", parse)).toEqual(["Same?"]);
	});
});
