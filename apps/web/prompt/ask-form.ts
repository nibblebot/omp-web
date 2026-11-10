/**
 * The ask form's answer logic: the working state of every field, what each
 * contributes, the validation rules, and the answer sent for the whole form.
 *
 * The value and validation rules port the SDK's (`pi-tui/src/html-form/data.ts`:
 * `choiceValue`, `textValue`, `fieldError`), which the session applies again to
 * the submitted answer, so what the browser accepts is what the session accepts.
 * Redefined here because the web client must not import the server package;
 * `test/ask-form.test.ts` holds the two to the same answers.
 */

import type {
	UiFormChoiceField,
	UiFormField,
	UiFormSpan,
	UiFormSubmit,
	UiFormTextField,
} from "#lib/wire/ask-form";

/** A choice field's working answer: its checked option indices and the free-text Other. */
export interface ChoiceState {
	checked: number[];
	other: string;
}

/** A text field's working text. */
export interface TextState {
	text: string;
}

/** Working state by field `index`. */
export type FormState = Record<number, ChoiceState | TextState>;

/** A submitted value as the SDK models it: text, a number, or a group's checked values. */
export type FieldValue = string | number | string[];

/** Plain text of inline spans. */
export function spansText(spans: UiFormSpan[]): string {
	return spans.map((span) => span.text).join("");
}

/** A checkbox group or multi-select reports an array; a lone checkbox reports its one value. */
function isArrayChoice(field: UiFormChoiceField): boolean {
	return field.multi && field.options.length > 1;
}

/** The options a user can pick: a disabled option is shown but never part of an answer. */
function isPickable(field: UiFormChoiceField, option: number): boolean {
	const entry = field.options[option];
	return entry !== undefined && !entry.disabled;
}

/** Preselected options, and prefilled text; several checked radios leave the last, as in a browser. */
export function initialFieldState(field: UiFormField): ChoiceState | TextState {
	if (field.kind === "text") return { text: field.value };
	const checked = field.options.flatMap((option, i) => (option.checked ? [i] : []));
	return { checked: field.multi ? checked : checked.slice(-1), other: "" };
}

export function initialFormState(fields: UiFormField[]): FormState {
	return Object.fromEntries(fields.map((field) => [field.index, initialFieldState(field)]));
}

/**
 * Whether a group's Other answer counts: it has text and, for a single-choice group, no
 * option is picked (typing in Other drops the picked option; picking one afterwards keeps
 * the text but sets Other aside).
 */
export function isOtherActive(field: UiFormChoiceField, state: ChoiceState): boolean {
	if (!field.other || state.other.trim() === "") return false;
	return field.multi || state.checked.length === 0;
}

/** Pick (radio, single select) or toggle (checkbox, multi select) one option. */
export function toggleOption(
	field: UiFormChoiceField,
	state: ChoiceState,
	option: number,
): ChoiceState {
	if (!isPickable(field, option)) return state;
	if (!field.multi) return { ...state, checked: [option] };
	const checked = state.checked.includes(option)
		? state.checked.filter((i) => i !== option)
		: [...state.checked, option];
	return { ...state, checked: checked.sort((a, b) => a - b) };
}

/** Replace the checked set (a multi `<select>` reports it whole); disabled options are dropped. */
export function setChecked(
	field: UiFormChoiceField,
	state: ChoiceState,
	checked: number[],
): ChoiceState {
	const pickable = checked.filter((i) => isPickable(field, i));
	return { ...state, checked: field.multi ? pickable : pickable.slice(-1) };
}

/** Type into Other; for a single-choice group, typed text drops the picked option. */
export function setOther(field: UiFormChoiceField, state: ChoiceState, other: string): ChoiceState {
	if (!field.multi && other.trim() !== "") return { checked: [], other };
	return { ...state, other };
}

/** Switch a multi group's Other off: its text goes with it. */
export function clearOther(state: ChoiceState): ChoiceState {
	return { ...state, other: "" };
}

/** The value a field contributes (the SDK's `choiceValue`/`textValue`); undefined for none. */
export function fieldValue(
	field: UiFormField,
	state: ChoiceState | TextState,
): FieldValue | undefined {
	if (field.kind === "text") {
		const text = (state as TextState).text;
		if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
			const number = Number(text);
			if (Number.isFinite(number)) return number;
		}
		return text;
	}
	const choice = state as ChoiceState;
	const typed = isOtherActive(field, choice) ? choice.other.trim() : undefined;
	const values = field.options.flatMap((option, i) =>
		choice.checked.includes(i) && !option.disabled ? [option.value] : [],
	);
	if (isArrayChoice(field)) return typed ? [...values, typed] : values;
	return typed || values[0];
}

/** `^(?:pattern)$` as HTML matches `pattern`, or undefined when the model wrote an invalid one. */
function compilePattern(pattern: string): RegExp | undefined {
	try {
		return new RegExp(`^(?:${pattern})$`, "v");
	} catch {
		return undefined;
	}
}

/**
 * Why `value` is not an acceptable answer for `field`, or undefined when it is: `required`,
 * numeric `min`/`max`, `minlength`/`maxlength`, `email` and `url` shapes, and `pattern`
 * (anchored, as HTML does; an invalid pattern is ignored).
 */
export function fieldError(field: UiFormField, value: FieldValue | undefined): string | undefined {
	if (field.kind === "choice") {
		const empty = value === undefined || (Array.isArray(value) && value.length === 0);
		if (!field.required || !empty) return undefined;
		return isArrayChoice(field) ? "Select at least one" : "Required";
	}
	const text = value === undefined ? "" : String(value);
	if (text.trim() === "") return field.required ? "Required" : undefined;
	if (field.type === "number" || field.type === "range") {
		const number = Number(text);
		if (!Number.isFinite(number)) return "Enter a number";
		if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
		if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
	}
	if (field.minLength !== undefined && text.length < field.minLength) {
		return `Needs at least ${field.minLength} characters`;
	}
	if (field.maxLength !== undefined && text.length > field.maxLength) {
		return `At most ${field.maxLength} characters`;
	}
	if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
	if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
	if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
		return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
	}
	return undefined;
}

/** Every failing field's error by `index`; empty when the form can be submitted. */
export function validateForm(fields: UiFormField[], state: FormState): Record<number, string> {
	const errors: Record<number, string> = {};
	for (const field of fields) {
		const error = fieldError(field, fieldValue(field, state[field.index]!));
		if (error) errors[field.index] = error;
	}
	return errors;
}

/**
 * The ui_response for the form: one answer per field. A single-choice group whose Other
 * text counts sends no checked option (the text stands in for its value); Other text that
 * does not count is not sent.
 */
export function buildSubmit(fields: UiFormField[], state: FormState): UiFormSubmit {
	return {
		kind: "submit",
		answers: fields.map((field) => {
			const entry = state[field.index]!;
			if (field.kind === "text") {
				return { kind: "text" as const, index: field.index, text: (entry as TextState).text };
			}
			const choice = entry as ChoiceState;
			const other = isOtherActive(field, choice);
			return {
				kind: "choice" as const,
				index: field.index,
				checked: other && !field.multi ? [] : choice.checked,
				...(other ? { other: choice.other.trim() } : {}),
			};
		}),
	};
}

/** The `<input type>` a text field draws; the model's free-form type falls back to text. */
export function inputType(field: UiFormTextField): string {
	switch (field.type) {
		case "number":
		case "range":
			return "number";
		case "url":
		case "email":
		case "password":
		case "tel":
		case "search":
		case "date":
		case "time":
		case "datetime-local":
		case "month":
		case "week":
			return field.type;
		default:
			return "text";
	}
}

/** Whether `src` is a picture the session resolved: only `data:` images are ever drawn. */
export function isImageDataUri(src: string): boolean {
	return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(src);
}
