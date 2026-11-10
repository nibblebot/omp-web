/**
 * The ask form's answer logic (prompt/ask-form.ts): working state, what each field
 * contributes, validation, and the answer sent for the whole form. The rules port the
 * SDK's (`choiceValue`, `textValue`, `fieldError`), and the session applies them again to
 * what is submitted, so these tests hold the browser to the SDK's own answers and run its
 * submit through the session's conversion. Forms come from the session's real
 * `buildFormParams` over parsed HTML, so the field shapes are the wire's.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import {
	choiceValue,
	fieldError as sdkFieldError,
	textValue as sdkTextValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, type FormField } from "@oh-my-pi/pi-tui/html-form/parse";
import {
	formFields,
	type UiFormChoiceField,
	type UiFormField,
	type UiFormParams,
} from "#lib/wire/ask-form";
import { buildFormParams, formDataFromSubmit } from "../../session/ui-form";
import { AskForm } from "../components/requests/AskForm";
import {
	buildSubmit,
	clearOther,
	fieldError,
	fieldValue,
	initialFormState,
	inputType,
	isImageDataUri,
	isOtherActive,
	setChecked,
	setOther,
	toggleOption,
	validateForm,
	type ChoiceState,
	type FormState,
} from "../prompt/ask-form";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

beforeEach(() => installJsxShim({ onElement: () => undefined }));
afterAll(restoreJsxShim);

const signal = new AbortController().signal;

async function load(
	html: string,
): Promise<{ params: UiFormParams; fields: UiFormField[]; sdk: FormField[] }> {
	const form = parseHtmlForm(html);
	const params = await buildFormParams(form, { cwd: process.cwd(), signal });
	return { params, fields: formFields(params), sdk: form.fields };
}

const STORE_FORM = `<form>
  <p>Which store?</p>
  <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
  <label><input type="radio" name="store" value="redis"> Redis</label>
  <label><input type="radio" name="store" value="pg" disabled> Postgres</label>
  <fieldset>
    <legend>Checks</legend>
    <label><input type="checkbox" name="checks" value="types" required> types</label>
    <label><input type="checkbox" name="checks" value="lint"> lint</label>
  </fieldset>
  <label>Days <input type="number" name="days" value="30" min="1" max="90" required></label>
  <label>Version <input name="version" pattern="[0-9]+\\.[0-9]+" placeholder="1.0"></label>
  <label>Notes <textarea name="notes" rows="3">hello</textarea></label>
</form>`;

/** Field indices of STORE_FORM. */
const STORE = 0;
const CHECKS = 1;
const DAYS = 2;
const VERSION = 3;
const NOTES = 4;

function choice(state: FormState, index: number): ChoiceState {
	return state[index] as ChoiceState;
}

describe("initial state", () => {
	test("preselected options and prefilled text; the last of several checked radios wins", async () => {
		const { fields } = await load(STORE_FORM);
		const state = initialFormState(fields);
		expect(choice(state, STORE)).toEqual({ checked: [0], other: "" });
		expect(choice(state, CHECKS)).toEqual({ checked: [], other: "" });
		expect(state[DAYS]).toEqual({ text: "30" });
		expect(state[NOTES]).toEqual({ text: "hello" });

		const several = await load(`<form>
  <label><input type="radio" name="r" value="a" checked> a</label>
  <label><input type="radio" name="r" value="b" checked> b</label>
</form>`);
		expect(choice(initialFormState(several.fields), 0).checked).toEqual([1]);
	});
});

describe("choosing", () => {
	test("a radio pick replaces; a checkbox toggles and keeps the set ordered; a disabled option is ignored", async () => {
		const { fields } = await load(STORE_FORM);
		const store = fields[STORE] as UiFormChoiceField;
		const checks = fields[CHECKS] as UiFormChoiceField;
		let radio = initialFormState(fields)[STORE] as ChoiceState;
		radio = toggleOption(store, radio, 1);
		expect(radio.checked).toEqual([1]);
		expect(toggleOption(store, radio, 2)).toBe(radio);

		let boxes = initialFormState(fields)[CHECKS] as ChoiceState;
		boxes = toggleOption(checks, boxes, 1);
		boxes = toggleOption(checks, boxes, 0);
		expect(boxes.checked).toEqual([0, 1]);
		expect(toggleOption(checks, boxes, 0).checked).toEqual([1]);
	});

	test("a multi select reports its whole set; a single select keeps one", async () => {
		const { fields } = await load(`<form>
  <select name="one"><option value="a">a</option><option value="b" selected>b</option></select>
  <select name="many" multiple><option value="x">x</option><option value="y">y</option><option value="z" disabled>z</option></select>
</form>`);
		const one = fields[0] as UiFormChoiceField;
		const many = fields[1] as UiFormChoiceField;
		expect(one.select && !one.multi).toBe(true);
		expect(choice(initialFormState(fields), 0).checked).toEqual([1]);
		expect(setChecked(one, { checked: [], other: "" }, [0, 1]).checked).toEqual([1]);
		expect(setChecked(many, { checked: [], other: "" }, [0, 1, 2]).checked).toEqual([0, 1]);
	});
});

describe("Other", () => {
	test("typed text drops a radio's picked option; picking one afterwards sets the text aside", async () => {
		const { fields } = await load(STORE_FORM);
		const store = fields[STORE] as UiFormChoiceField;
		expect(store.other).toBe(true);

		let state = initialFormState(fields)[STORE] as ChoiceState;
		state = setOther(store, state, "mysql");
		expect(state).toEqual({ checked: [], other: "mysql" });
		expect(isOtherActive(store, state)).toBe(true);
		expect(fieldValue(store, state)).toBe("mysql");

		state = toggleOption(store, state, 1);
		expect(state.other).toBe("mysql");
		expect(isOtherActive(store, state)).toBe(false);
		expect(fieldValue(store, state)).toBe("redis");
	});

	test("a blank Other counts for nothing and never drops the pick", async () => {
		const { fields } = await load(STORE_FORM);
		const store = fields[STORE] as UiFormChoiceField;
		const state = setOther(store, initialFormState(fields)[STORE] as ChoiceState, "   ");
		expect(state.checked).toEqual([0]);
		expect(isOtherActive(store, state)).toBe(false);
		expect(fieldValue(store, state)).toBe("sqlite");
	});

	test("a checkbox group adds Other to the checked values, and clearing it removes the text", async () => {
		const { fields } = await load(STORE_FORM);
		const checks = fields[CHECKS] as UiFormChoiceField;
		let state = toggleOption(checks, initialFormState(fields)[CHECKS] as ChoiceState, 0);
		state = setOther(checks, state, " custom ");
		expect(state.checked).toEqual([0]);
		expect(fieldValue(checks, state)).toEqual(["types", "custom"]);
		state = clearOther(state);
		expect(fieldValue(checks, state)).toEqual(["types"]);
	});

	test("a group without the Other flag ignores typed text", async () => {
		const { fields } = await load(`<form>
  <label><input type="checkbox" name="solo" value="yes"> I agree</label>
</form>`);
		const solo = fields[0] as UiFormChoiceField;
		expect(solo.other).toBe(false);
		expect(isOtherActive(solo, { checked: [], other: "text" })).toBe(false);
	});

	test("buildSubmit sends the Other text and no checked option for a radio group", async () => {
		const { fields } = await load(STORE_FORM);
		const store = fields[STORE] as UiFormChoiceField;
		const state = initialFormState(fields);
		state[STORE] = setOther(store, choice(state, STORE), " mysql ");
		const answer = buildSubmit(fields, state).answers[STORE];
		expect(answer).toEqual({ kind: "choice", index: STORE, checked: [], other: "mysql" });

		// Text set aside by a later pick is not sent.
		state[STORE] = toggleOption(store, choice(state, STORE), 1);
		expect(buildSubmit(fields, state).answers[STORE]).toEqual({
			kind: "choice",
			index: STORE,
			checked: [1],
		});
	});
});

describe("validation", () => {
	test("a required checkbox group needs a check or Other; the preselected radio is fine", async () => {
		const { fields } = await load(STORE_FORM);
		const state = initialFormState(fields);
		const errors = validateForm(fields, state);
		expect(errors[CHECKS]).toBe("Select at least one");
		expect(errors[STORE]).toBeUndefined();

		const checks = fields[CHECKS] as UiFormChoiceField;
		state[CHECKS] = setOther(checks, choice(state, CHECKS), "something else");
		expect(validateForm(fields, state)[CHECKS]).toBeUndefined();
	});

	test("number bounds, non-numbers, required and pattern", async () => {
		const { fields } = await load(STORE_FORM);
		const state = initialFormState(fields);
		const check = (index: number, text: string) =>
			validateForm(fields, { ...state, [index]: { text } })[index];
		expect(check(DAYS, "30")).toBeUndefined();
		expect(check(DAYS, "0")).toBe("Must be at least 1");
		expect(check(DAYS, "91")).toBe("Must be at most 90");
		expect(check(DAYS, "1e1")).toBeUndefined();
		expect(check(DAYS, "abc")).toBe("Enter a number");
		expect(check(DAYS, "  ")).toBe("Required");
		expect(check(VERSION, "")).toBeUndefined();
		expect(check(VERSION, "1.2")).toBeUndefined();
		expect(check(VERSION, "1.2.3")).toBe("Must match [0-9]+\\.[0-9]+");
	});

	test("every rule agrees with the SDK's fieldError over a matrix of texts", async () => {
		const html = `<form>
  <input name="plain" required>
  <input type="number" name="n" min="-2" max="10.5">
  <input type="email" name="mail">
  <input type="url" name="link">
  <input name="short" minlength="3" maxlength="5">
  <input name="code" pattern="[a-z]+-\\d{2}">
  <input name="bad" pattern="[unclosed">
</form>`;
		const { fields, sdk } = await load(html);
		const samples = [
			"",
			" ",
			"a",
			"abc",
			"abcdef",
			"10.5",
			"10.6",
			"-2",
			"-3",
			"1e2",
			"NaN",
			"x@y",
			"x@",
			"https://a.b",
			"a.b",
			"ab-12",
			"ab-1",
			"AB-12",
		];
		for (const [i, field] of fields.entries()) {
			for (const text of samples) {
				const sdkField = sdk[i]!;
				const expected = sdkFieldError(
					sdkField,
					sdkField.kind === "text" ? sdkTextValue(sdkField, text) : undefined,
				);
				expect(
					fieldError(field, fieldValue(field, { text })),
					`${field.name} = ${JSON.stringify(text)}`,
				).toBe(expected);
			}
		}
	});

	test("choice values and errors agree with the SDK over every checked set and Other text", async () => {
		const { fields, sdk } = await load(STORE_FORM);
		const sets = [[], [0], [1], [0, 1], [2], [0, 2]];
		for (const index of [STORE, CHECKS]) {
			const field = fields[index] as UiFormChoiceField;
			const sdkField = sdk[index]!;
			if (sdkField.kind !== "choice") throw new Error("not a choice field");
			for (const checked of sets) {
				for (const other of ["", "  ", " typed "]) {
					const web = fieldValue(field, { checked, other });
					const expected = choiceValue(
						sdkField,
						new Set(checked),
						field.multi || checked.length === 0 ? other : undefined,
					);
					// The SDK's helper takes the Other text as given; the browser only passes it once it counts.
					expect(web, `${field.name} ${checked} ${JSON.stringify(other)}`).toEqual(expected);
					expect(fieldError(field, web)).toBe(sdkFieldError(sdkField, expected));
				}
			}
		}
	});
});

describe("the submitted answer", () => {
	test("converts to the SDK's form data through the session: Other, checkboxes, numbers", async () => {
		const form = parseHtmlForm(STORE_FORM);
		const { fields } = await load(STORE_FORM);
		const state = initialFormState(fields);
		const store = fields[STORE] as UiFormChoiceField;
		const checks = fields[CHECKS] as UiFormChoiceField;
		state[STORE] = setOther(store, choice(state, STORE), "mysql");
		state[CHECKS] = setOther(checks, toggleOption(checks, choice(state, CHECKS), 1), "extra");
		state[DAYS] = { text: "45" };
		state[VERSION] = { text: "2.0" };
		expect(validateForm(fields, state)).toEqual({});

		expect(formDataFromSubmit(form, buildSubmit(fields, state))).toEqual({
			store: "mysql",
			checks: ["lint", "extra"],
			days: 45,
			version: "2.0",
			notes: "hello",
		});
	});

	test("the untouched form submits what the SDK's defaults would", async () => {
		const form = parseHtmlForm(`<form>
  <label><input type="radio" name="a" value="1" checked> 1</label>
  <label><input type="radio" name="a" value="2"> 2</label>
  <input type="hidden" name="h" value="v">
  <input name="t" value="prefilled">
</form>`);
		const { fields } = await load(`<form>
  <label><input type="radio" name="a" value="1" checked> 1</label>
  <label><input type="radio" name="a" value="2"> 2</label>
  <input type="hidden" name="h" value="v">
  <input name="t" value="prefilled">
</form>`);
		expect(formDataFromSubmit(form, buildSubmit(fields, initialFormState(fields)))).toEqual({
			h: "v",
			a: "1",
			t: "prefilled",
		});
	});
});

describe("drawing helpers", () => {
	test("only a handful of input types are drawn; the model's free-form type falls back to text", async () => {
		const { fields } = await load(`<form>
  <input type="range" name="r" min="0" max="5">
  <input type="color" name="c">
  <input type="datetime-local" name="d">
  <input type="password" name="p">
</form>`);
		expect(fields.map((f) => (f.kind === "text" ? inputType(f) : ""))).toEqual([
			"number",
			"text",
			"datetime-local",
			"password",
		]);
	});

	test("a picture draws only from a data: image URI", () => {
		expect(isImageDataUri("data:image/png;base64,AAAA")).toBe(true);
		expect(isImageDataUri("data:image/svg+xml;base64,AAAA")).toBe(true);
		expect(isImageDataUri("data:image/svg+xml,%3Csvg%3E")).toBe(true);
		expect(isImageDataUri("https://example.com/a.png")).toBe(false);
		expect(isImageDataUri("file:///etc/passwd")).toBe(false);
		expect(isImageDataUri("/home/me/a.png")).toBe(false);
		expect(isImageDataUri("data:text/html;base64,AAAA")).toBe(false);
		expect(isImageDataUri("javascript:alert(1)")).toBe(false);
	});
});

describe("AskForm markup", () => {
	test("draws sections, preselected radio, Other, number bounds, the picture and Submit", async () => {
		const pixel =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const { params } = await load(`<form>
  <p>Pick <code>one</code>.</p>
  <img src="${pixel}" alt="a pixel">
  <fieldset><legend>Store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
  <label>Days <input type="number" name="days" value="30" min="1" max="90" required></label>
  <textarea name="notes" rows="4" placeholder="Anything else"></textarea>
</form>`);
		const html = renderToString(() => createComponent(AskForm, { id: "ui7", params }));

		expect(html).toContain("Agent asks");
		expect(html).toContain("<legend");
		expect(html).toContain("Store");
		expect(html).toContain("<code");
		expect(html).toContain("one</code>");
		expect(html).toContain(`src="${pixel}"`);
		expect(html).toContain('type="radio"');
		// The recommended option arrives checked; Redis does not.
		expect(html).toMatch(/type="radio"[^>]*checked[^>]*>\s*<span[^>]*>SQLite/);
		expect(html).not.toMatch(/checked[^>]*>\s*<span[^>]*>Redis/);
		expect(html).toContain("Other: type your own answer");
		expect(html).toContain('type="number"');
		expect(html).toContain('min="1"');
		expect(html).toContain('max="90"');
		expect(html).toContain("<textarea");
		expect(html).toContain('rows="4"');
		expect(html).toContain("Submit");
		expect(html).toContain("novalidate");
	});

	test("a picture that is not a data: URI is never given to an <img>", async () => {
		const { params } = await load(`<form><input name="x"></form>`);
		const hostile: UiFormParams = {
			...params,
			sections: [
				{
					title: [],
					blocks: [
						{ kind: "image", src: "https://tracker.example/pixel.png", alt: "tracker" },
						...params.sections[0]!.blocks,
					],
				},
			],
		};
		const html = renderToString(() => createComponent(AskForm, { id: "ui8", params: hostile }));
		expect(html).not.toContain("<img");
		expect(html).not.toContain("tracker.example");
		expect(html).toContain("tracker");
	});
});
