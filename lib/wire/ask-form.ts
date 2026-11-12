/**
 * The `formDialog` ui_request: the SDK's `ask` tool shows one agent-written HTML
 * `<form>` and gets the submitted form data back. The session parses the HTML
 * (the SDK's `parseHtmlForm`), resolves its pictures to bounded `data:` URIs and
 * sends the structured form below; the browser draws it and answers with
 * {@link UiFormSubmit}, which the session turns into the SDK's form data.
 *
 * Mirrors the SDK's form model (`pi-tui/src/html-form/parse.ts`), redefined here
 * because the web client must not import the server package. Everything is
 * JSON-safe. Additive wire: a new ui_request method, no protocol constant moves.
 */

/** Inline emphasis a span keeps (`<code>`, `<strong>`/`<b>`, `<em>`/`<i>`). */
export type UiFormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break. */
export interface UiFormSpan {
	text: string;
	style?: UiFormSpanStyle;
}

/** One answer of a choice field. */
export interface UiFormOption {
	value: string;
	label: UiFormSpan[];
	checked: boolean;
	disabled: boolean;
}

/** Fields carry their position in the form (`index`) and the SDK's question text for them. */
interface UiFormFieldBase {
	/** Position among the form's fields in document order; answers refer to it. */
	index: number;
	/** The question this field answers (its label, the text before it, or its section title). */
	question: string;
	/** The control's `name`; empty for an unnamed control, whose answer is not submitted. */
	name: string;
	label: UiFormSpan[];
	required: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
export interface UiFormChoiceField extends UiFormFieldBase {
	kind: "choice";
	multi: boolean;
	select: boolean;
	/** The UI adds a free-text "Other" answer. */
	other: boolean;
	options: UiFormOption[];
}

/** A single-line `<input>` or a `<textarea>`. */
export interface UiFormTextField extends UiFormFieldBase {
	kind: "text";
	/** The `<input type>`; `textarea` for a textarea. */
	type: string;
	multiline: boolean;
	value: string;
	placeholder: string;
	min?: number;
	max?: number;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	rows: number;
}

export type UiFormField = UiFormChoiceField | UiFormTextField;

/** A renderable unit of a section, in document order. */
export type UiFormBlock =
	| { kind: "text"; spans: UiFormSpan[]; heading: boolean }
	| { kind: "list"; items: UiFormSpan[][]; ordered: boolean }
	| { kind: "pre"; text: string }
	| { kind: "table"; rows: UiFormSpan[][][]; headerRows: number }
	/**
	 * A picture the session already loaded: `src` is always a bounded `data:` URI
	 * (inline `<svg>` included). A picture that could not be loaded is not sent as
	 * an image; its alt text stands in as a `text` block.
	 */
	| { kind: "image"; src: string; alt: string }
	| { kind: "field"; field: UiFormField };

/** A `<fieldset>` (titled by its `<legend>`) or loose content between fieldsets (untitled). */
export interface UiFormSection {
	title: UiFormSpan[];
	blocks: UiFormBlock[];
}

/** Params of the `formDialog` ui_request method. */
export interface UiFormParams {
	sections: UiFormSection[];
	/** `<input type="hidden">` pairs: always part of the submitted data, never drawn. */
	hidden: [name: string, value: string][];
	/**
	 * Epoch ms at which the session submits the form's defaults (`timedOut`) and ends
	 * the dialog; absent without a timeout. A fixed deadline from presentation:
	 * the browser may count down to it, but typing does not postpone it.
	 */
	deadline?: number;
}

/** Longest option note (UTF-16 code units, as a textarea's `maxlength` counts them). */
export const UI_FORM_NOTE_MAX_LENGTH = 2000;
/** Most option notes one form answer carries, over all its fields. */
export const UI_FORM_NOTES_MAX = 64;

/**
 * A note on one chosen option (SDK 18.18.8+), kept apart from the submitted values: the
 * agent reads it next to the answer. A note on an option that is not chosen at submit
 * is a draft and is not sent.
 */
export interface UiFormOptionNote {
	/** Index into the field's `options`. */
	option: number;
	/** At most {@link UI_FORM_NOTE_MAX_LENGTH} long. */
	text: string;
}

/** A choice field's answer: the checked option indices plus the free-text Other answer. */
export interface UiFormChoiceAnswer {
	kind: "choice";
	index: number;
	/** Indices into the field's `options`. A single-choice field has at most one. */
	checked: number[];
	/** The Other text; blank counts as no answer. */
	other?: string;
	/**
	 * Notes on chosen options, one per option at most; absent without any. Additive: a
	 * session that predates it ignores the field, and a browser that predates it never
	 * sends one.
	 */
	notes?: UiFormOptionNote[];
}

/** A text field's raw text (the session coerces numbers). */
export interface UiFormTextAnswer {
	kind: "text";
	index: number;
	text: string;
}

export type UiFormFieldAnswer = UiFormChoiceAnswer | UiFormTextAnswer;

/**
 * The ui_response `result` of a `formDialog` request. A cancel is a ui_response with
 * no result (undefined), like every other dialog. Fields without an answer entry keep
 * their defaults.
 */
export interface UiFormSubmit {
	kind: "submit";
	answers: UiFormFieldAnswer[];
}

/** The form's fields in document order. */
export function formFields(form: UiFormParams): UiFormField[] {
	return form.sections
		.flatMap((section) =>
			section.blocks.flatMap((block) => (block.kind === "field" ? [block.field] : [])),
		)
		.sort((a, b) => a.index - b.index);
}
