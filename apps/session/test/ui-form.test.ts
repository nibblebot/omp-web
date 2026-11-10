/**
 * The `formDialog` ui_request's session half: the SDK's parsed HTML form as the JSON-safe
 * params the browser draws (pictures resolved here, bounded, never fetched by the browser) and
 * the browser's raw answers turned back into the SDK's form data through its own helpers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { UiFormBlock, UiFormParams } from "#lib/wire/ask-form";
import {
	buildFormParams,
	FORM_IMAGE_MAX_BYTES,
	formDataFromSubmit,
	InvalidFormAnswerError,
} from "../ui-form";

afterAll(cleanupTempDirs);

const FORM = `<form>
  <input type="hidden" name="source" value="ui">
  <p>Which store?</p>
  <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
  <label><input type="radio" name="store" value="redis"> Redis</label>
  <fieldset>
    <legend>Checks</legend>
    <label><input type="checkbox" name="checks" value="types" checked> types</label>
    <label><input type="checkbox" name="checks" value="lint"> lint</label>
    <label><input type="checkbox" name="checks" value="test"> test</label>
  </fieldset>
  <label>Days <input type="number" name="days" value="30" min="1" max="90"></label>
  <label>Notes <textarea name="notes" rows="3">hello</textarea></label>
</form>`;

const PNG = Uint8Array.fromBase64(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

const signal = new AbortController().signal;

/** Field indices of FORM: store 0, checks 1, days 2, notes 3. */
const submit = (...answers: unknown[]) => ({ kind: "submit", answers });

type ImageBlock = Extract<UiFormBlock, { kind: "image" }>;

function imageBlocks(params: UiFormParams): ImageBlock[] {
	return params.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "image" ? [b] : [])));
}

describe("buildFormParams", () => {
	test("carries sections, indexed fields with their questions, and hidden pairs as plain JSON", async () => {
		const form = parseHtmlForm(FORM);
		const params = await buildFormParams(form, { cwd: process.cwd(), signal });

		expect(params.hidden).toEqual([["source", "ui"]]);
		const fields = params.sections.flatMap((s) =>
			s.blocks.flatMap((b) => (b.kind === "field" ? [b.field] : [])),
		);
		expect(fields.map((f) => [f.index, f.name, f.question])).toEqual([
			[0, "store", "Which store?"],
			[1, "checks", "Checks"],
			[2, "days", "Days"],
			[3, "notes", "Notes"],
		]);
		const store = fields[0]!;
		expect(store.kind === "choice" && store.other).toBe(true);
		expect(store.kind === "choice" && store.options.map((o) => [o.value, o.checked])).toEqual([
			["sqlite", true],
			["redis", false],
		]);
		expect(params.sections.map((s) => spansTitle(s.title))).toEqual(["", "Checks", ""]);
		// The wire is JSON: nothing in the params is lost or shared by reference.
		expect(JSON.parse(JSON.stringify(params))).toEqual(params);
		expect(params.deadline).toBeUndefined();
	});

	test("pictures become data: URIs; one that fails keeps its alt text; no alt, nothing", async () => {
		const dir = tempDir("omp-ask-form-");
		await Bun.write(`${dir}/pixel.png`, PNG);
		const dataUri = `data:image/png;base64,${PNG.toBase64()}`;
		const html = `<form>
  <img src="pixel.png" alt="from disk">
  <img src="${dataUri}" alt="inline">
  <img src="missing.png" alt="gone">
  <img src="also-missing.png">
  <svg viewBox="0 0 10 10" role="img"><circle cx="5" cy="5" r="4"/></svg>
  <input name="x">
</form>`;
		const params = await buildFormParams(parseHtmlForm(html), { cwd: dir, signal });
		const blocks = params.sections.flatMap((s) => s.blocks);

		const images = imageBlocks(params);
		expect(images.map((b) => b.alt)).toContain("from disk");
		expect(images.find((b) => b.alt === "from disk")!.src).toBe(dataUri);
		expect(images.find((b) => b.alt === "inline")!.src).toBe(dataUri);
		// The inline <svg> is a data: URI too: the browser only ever draws an <img>.
		const svg = images.find((b) => b.src.startsWith("data:image/svg+xml;base64,"))!;
		expect(Buffer.from(svg.src.split(",")[1]!, "base64").toString()).toContain("<circle");
		expect(images.every((b) => b.src.startsWith("data:"))).toBe(true);
		// The failed picture keeps its alt text; the one without alt is dropped.
		expect(blocks).toContainEqual({
			kind: "text",
			spans: [{ text: "gone", style: "em" }],
			heading: false,
		});
		expect(blocks.filter((b) => b.kind === "text" && b.spans[0]?.text === "")).toEqual([]);
		expect(images).toHaveLength(3);
	});

	test("a picture over the per-image bound, or past the form's total, is dropped to its alt", async () => {
		const dir = tempDir("omp-ask-form-");
		const big = new Uint8Array(FORM_IMAGE_MAX_BYTES + 1);
		big.set(PNG);
		await Bun.write(`${dir}/big.png`, big);
		const medium = new Uint8Array(200 * 1024);
		medium.set(PNG);
		await Bun.write(`${dir}/m.png`, medium);
		const html = `<form>
  <img src="big.png" alt="big">
  <img src="m.png" alt="one">
  <img src="m.png" alt="two">
  <img src="m.png" alt="three">
  <input name="x">
</form>`;
		const params = await buildFormParams(parseHtmlForm(html), { cwd: dir, signal });
		expect(imageBlocks(params).map((b) => b.alt)).toEqual(["one", "two"]);
		const texts = params.sections.flatMap((s) =>
			s.blocks.flatMap((b) => (b.kind === "text" ? [b.spans[0]?.text] : [])),
		);
		expect(texts).toEqual(expect.arrayContaining(["big", "three"]));
	});
});

function spansTitle(spans: Array<{ text: string }>): string {
	return spans.map((s) => s.text).join("");
}

describe("formDataFromSubmit", () => {
	const form = parseHtmlForm(FORM);

	test("no answers submit the SDK's defaults", () => {
		expect(formDataFromSubmit(form, submit())).toEqual(defaultFormData(form));
		expect(defaultFormData(form)).toEqual({
			source: "ui",
			store: "sqlite",
			checks: ["types"],
			days: 30,
			notes: "hello",
		});
	});

	test("answers map to the values the TUI would submit", () => {
		const data = formDataFromSubmit(
			form,
			submit(
				{ kind: "choice", index: 0, checked: [1] },
				{ kind: "choice", index: 1, checked: [0, 2] },
				{ kind: "text", index: 2, text: "45" },
				{ kind: "text", index: 3, text: "line one\nline two" },
			),
		);
		expect(data).toEqual({
			source: "ui",
			store: "redis",
			checks: ["types", "test"],
			days: 45,
			notes: "line one\nline two",
		});
	});

	test("Other text stands in for a radio value and joins a checkbox group; blank Other counts for nothing", () => {
		const other = formDataFromSubmit(
			form,
			submit(
				{ kind: "choice", index: 0, checked: [], other: "  mysql " },
				{ kind: "choice", index: 1, checked: [1], other: "custom" },
			),
		);
		expect(other.store).toBe("mysql");
		expect(other.checks).toEqual(["lint", "custom"]);

		const blank = formDataFromSubmit(
			form,
			submit({ kind: "choice", index: 0, checked: [1], other: "   " }),
		);
		expect(blank.store).toBe("redis");
	});

	test("a radio group keeps the last of several checked; an emptied checkbox group reports an empty array", () => {
		const data = formDataFromSubmit(
			form,
			submit(
				{ kind: "choice", index: 0, checked: [0, 1] },
				{ kind: "choice", index: 1, checked: [] },
			),
		);
		expect(data.store).toBe("redis");
		expect(data.checks).toEqual([]);
	});

	test("a disabled option is never part of an answer", () => {
		const disabled = parseHtmlForm(`<form>
  <label><input type="radio" name="p" value="a" checked> a</label>
  <label><input type="radio" name="p" value="b" disabled> b</label>
</form>`);
		const data = formDataFromSubmit(disabled, submit({ kind: "choice", index: 0, checked: [1] }));
		expect(data).not.toHaveProperty("p");
	});

	test("fields fail the SDK's rules: number bounds, required groups, patterns", () => {
		expect(() => formDataFromSubmit(form, submit({ kind: "text", index: 2, text: "500" }))).toThrow(
			/Days.*at most 90/,
		);
		expect(() => formDataFromSubmit(form, submit({ kind: "text", index: 2, text: "abc" }))).toThrow(
			/Enter a number/,
		);
		const required = parseHtmlForm(`<form>
  <label><input type="checkbox" name="c" value="a" required> a</label>
  <label><input type="checkbox" name="c" value="b"> b</label>
  <input name="code" pattern="[A-Z]{3}" value="ABC">
</form>`);
		expect(() =>
			formDataFromSubmit(required, submit({ kind: "choice", index: 0, checked: [] })),
		).toThrow(/Select at least one/);
		expect(() =>
			formDataFromSubmit(
				required,
				submit(
					{ kind: "choice", index: 0, checked: [1] },
					{ kind: "text", index: 1, text: "abcd" },
				),
			),
		).toThrow(/Must match/);
		expect(
			formDataFromSubmit(required, submit({ kind: "choice", index: 0, checked: [1] })).c,
		).toEqual(["b"]);
	});

	test("an unnamed unanswered control submits nothing and is not checked", () => {
		const unnamed = parseHtmlForm(`<form><input required><input name="a" value="1"></form>`);
		expect(formDataFromSubmit(unnamed, submit())).toEqual({ a: "1" });
	});

	test("a malformed answer is rejected with InvalidFormAnswerError", () => {
		const bad: unknown[] = [
			undefined,
			"submit",
			{ kind: "submit" },
			{ kind: "cancel", answers: [] },
			submit({ kind: "text", index: 9, text: "x" }),
			submit({ kind: "text", index: 0, text: "x" }),
			submit({ kind: "choice", index: 0, checked: [5] }),
			submit({ kind: "choice", index: 0, checked: "0" }),
			submit({ kind: "text", index: 3, text: 7 }),
			submit(null),
		];
		for (const answer of bad) {
			expect(() => formDataFromSubmit(form, answer)).toThrow(InvalidFormAnswerError);
		}
	});
});
