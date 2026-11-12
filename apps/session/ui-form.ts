import {
	choiceValue,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	isArrayChoice,
	type OptionNote,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import { loadFormImage, svgMedia, type FormMedia } from "@oh-my-pi/pi-tui/html-form/media";
import {
	type ChoiceField,
	type ChoiceOption,
	type FormBlock,
	type FormField,
	type HtmlForm,
	spansText,
} from "@oh-my-pi/pi-tui/html-form/parse";
import {
	UI_FORM_NOTE_MAX_LENGTH,
	UI_FORM_NOTES_MAX,
	type UiFormBlock,
	type UiFormChoiceAnswer,
	type UiFormField,
	type UiFormFieldAnswer,
	type UiFormParams,
} from "#lib/wire/ask-form";

// ---------------------------------------------------------------------------
// The `formDialog` ui_request, session side: the SDK's parsed HTML form as the
// JSON-safe structure the browser draws, and the browser's (or a collab
// guest's) answer back as the SDK's form data and option notes. The SDK helpers
// do every value and validation rule, so submitted data matches the TUI's byte
// for byte.
// ---------------------------------------------------------------------------

/** Largest picture the browser is sent (decoded bytes). Frames ride a 1 MiB envelope, so far below the SDK's 10 MiB load cap. */
export const FORM_IMAGE_MAX_BYTES = 256 * 1024;
/** Decoded bytes of all pictures in one form; later pictures beyond it are dropped. */
export const FORM_IMAGES_MAX_BYTES = 512 * 1024;

/** A browser or guest answer the form's own rules reject; thrown, so the ask tool reports it to the model. */
export class InvalidFormAnswerError extends Error {}

function dataUri(media: FormMedia): string {
	return `data:${media.mime};base64,${media.bytes.toBase64()}`;
}

type PictureBlock = Extract<FormBlock, { kind: "image" | "svg" }>;

/** One picture's media, or undefined when it cannot be loaded or is over the per-image bound. */
async function loadPicture(
	block: PictureBlock,
	cwd: string,
	signal: AbortSignal,
): Promise<FormMedia | undefined> {
	try {
		const media =
			block.kind === "svg"
				? svgMedia(block.markup)
				: await loadFormImage(block.src, { cwd, signal });
		return media.bytes.byteLength <= FORM_IMAGE_MAX_BYTES ? media : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The form as the browser draws it. Pictures resolve here so the browser never
 * fetches a URL or reads a path: each becomes a bounded `data:` URI (inline
 * `<svg>` too, shown by the browser only as an `<img>`). A picture that fails
 * to load, or does not fit the bounds, becomes its alt text (nothing without one).
 */
export async function buildFormParams(
	form: HtmlForm,
	options: { cwd: string; signal: AbortSignal },
): Promise<UiFormParams> {
	const pictures: PictureBlock[] = [];
	for (const section of form.sections) {
		for (const block of section.blocks) {
			if (block.kind === "image" || block.kind === "svg") pictures.push(block);
		}
	}
	const loaded = await Promise.all(
		pictures.map((block) => loadPicture(block, options.cwd, options.signal)),
	);
	const media = new Map<PictureBlock, FormMedia | undefined>(
		pictures.map((block, i) => [block, loaded[i]]),
	);
	let budget = FORM_IMAGES_MAX_BYTES;

	const questions = fieldQuestions(form);
	const indices = new Map<FormField, number>(form.fields.map((field, i) => [field, i]));
	const uiField = (field: FormField): UiFormField => {
		const base = {
			index: indices.get(field)!,
			question: questions.get(field) ?? field.name,
		};
		// ChoiceField/TextField are the wire's field shapes plus index and question.
		return { ...field, ...base } as UiFormField;
	};
	const uiBlock = (block: FormBlock): UiFormBlock | undefined => {
		switch (block.kind) {
			case "field":
				return { kind: "field", field: uiField(block.field) };
			case "image":
			case "svg": {
				const picture = media.get(block);
				if (picture && picture.bytes.byteLength <= budget) {
					budget -= picture.bytes.byteLength;
					return { kind: "image", src: dataUri(picture), alt: block.alt };
				}
				const alt = block.alt.trim();
				return alt
					? { kind: "text", spans: [{ text: alt, style: "em" }], heading: false }
					: undefined;
			}
			default:
				return block;
		}
	};

	return {
		sections: form.sections.map((section) => ({
			title: section.title,
			blocks: section.blocks.flatMap((block) => uiBlock(block) ?? []),
		})),
		hidden: form.hidden,
	};
}

/** A choice field's initial checked indices as a browser would hold them: the last of several checked radios wins. */
function defaultChecked(field: ChoiceField): number[] {
	const checked = field.options.flatMap((option, i) => (option.checked ? [i] : []));
	return field.multi ? checked : checked.slice(-1);
}

function isIndex(value: unknown, limit: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < limit;
}

/** Checked notes of a choice answer; a malformed list, an oversize note or a repeated option is invalid. */
function checkNotes(notes: unknown, options: number): void {
	if (notes === undefined) return;
	if (!Array.isArray(notes)) throw new InvalidFormAnswerError("option notes are malformed");
	const seen = new Set<number>();
	for (const note of notes as unknown[]) {
		// Untrusted wire data, like the answer that carries it.
		const entry = note as { option?: unknown; text?: unknown } | null;
		if (
			typeof entry !== "object" ||
			entry === null ||
			!isIndex(entry.option, options) ||
			seen.has(entry.option) ||
			typeof entry.text !== "string"
		) {
			throw new InvalidFormAnswerError("option notes are malformed");
		}
		if (entry.text.length > UI_FORM_NOTE_MAX_LENGTH) {
			throw new InvalidFormAnswerError(
				`an option note is longer than ${UI_FORM_NOTE_MAX_LENGTH} characters`,
			);
		}
		seen.add(entry.option);
	}
}

/** The raw answers by field index; a malformed entry is invalid. */
function answersByIndex(form: HtmlForm, raw: unknown): Map<number, UiFormFieldAnswer> {
	if (typeof raw !== "object" || raw === null)
		throw new InvalidFormAnswerError("not a form answer");
	const { kind, answers } = raw as { kind?: unknown; answers?: unknown };
	if (kind !== "submit" || !Array.isArray(answers))
		throw new InvalidFormAnswerError("not a form answer");
	const byIndex = new Map<number, UiFormFieldAnswer>();
	let notes = 0;
	for (const answer of answers as unknown[]) {
		// Untrusted wire data: every property is checked before the entry is used as an answer.
		const entry = answer as {
			kind?: unknown;
			index?: unknown;
			text?: unknown;
			checked?: unknown;
			other?: unknown;
			notes?: unknown;
		} | null;
		if (typeof entry !== "object" || entry === null || !isIndex(entry.index, form.fields.length)) {
			throw new InvalidFormAnswerError("an answer names a field the form does not have");
		}
		const field = form.fields[entry.index]!;
		if (entry.kind !== field.kind) {
			throw new InvalidFormAnswerError(`the answer to field ${entry.index} has the wrong kind`);
		}
		if (entry.kind === "text") {
			if (typeof entry.text !== "string")
				throw new InvalidFormAnswerError("a text answer is not text");
		} else if (
			!Array.isArray(entry.checked) ||
			!entry.checked.every((i) => isIndex(i, (field as ChoiceField).options.length)) ||
			(entry.other !== undefined && typeof entry.other !== "string")
		) {
			throw new InvalidFormAnswerError("a choice answer is malformed");
		} else {
			checkNotes(entry.notes, (field as ChoiceField).options.length);
			notes += Array.isArray(entry.notes) ? entry.notes.length : 0;
			if (notes > UI_FORM_NOTES_MAX) {
				throw new InvalidFormAnswerError(`more than ${UI_FORM_NOTES_MAX} option notes`);
			}
		}
		byIndex.set(entry.index, entry as UiFormFieldAnswer);
	}
	return byIndex;
}

/**
 * An option's shown label as the TUI names it in a note: its label text without control
 * characters, whitespace folded to single spaces, else its value. Derived here because
 * the SDK's `optionText` (`pi-tui/src/html-form/dialog.ts`) is private: tabs become
 * spaces, every other control character but `\n` goes, then whitespace runs fold.
 */
function optionLabel(option: ChoiceOption): string {
	return (
		spansText(option.label)
			// eslint-disable-next-line no-control-regex -- the control characters are what goes.
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
			.replace(/\s+/g, " ")
			.trim() || option.value
	);
}

/**
 * The SDK's notes for one choice answer: a note counts only on an option that is part of
 * the submitted value (checked, enabled, and not set aside by a single-choice group's
 * Other text) of a named field, with its text trimmed; a blank note is no note. Fields
 * and options keep form order, as the TUI's `optionNotes` lists them.
 */
function chosenNotes(
	field: ChoiceField,
	answer: UiFormChoiceAnswer,
	checked: readonly number[],
	question: string,
): OptionNote[] {
	if (!field.name || !answer.notes) return [];
	const typed = field.other ? answer.other?.trim() : undefined;
	const texts = new Map(answer.notes.map((note) => [note.option, note.text.trim()]));
	return field.options.flatMap((option, index) => {
		const text = texts.get(index);
		const chosen = checked.includes(index) && !option.disabled && (isArrayChoice(field) || !typed);
		if (!text || !chosen) return [];
		return [{ name: field.name, question, option: optionLabel(option), value: option.value, text }];
	});
}

/**
 * The SDK's form dialog result for a submitted answer. `data`: hidden pairs, then each
 * named field's value from `choiceValue`/`textValue`; a field the answer leaves out keeps
 * its default. `notes`: the notes on chosen options (see {@link chosenNotes}), present
 * only when there is one, so an answer without notes gives exactly `{ data }`. Every named
 * or answered field must pass the SDK's `fieldError` (required, min/max, length, pattern,
 * email/url): the browser checks the same rules before it submits, so a rejection here
 * comes from a stale or foreign client.
 *
 * @throws {InvalidFormAnswerError} the answer or its notes are malformed, or a field fails its rules.
 */
export function formResultFromSubmit(
	form: HtmlForm,
	raw: unknown,
): { data: HtmlFormData; notes?: OptionNote[] } {
	const answers = answersByIndex(form, raw);
	const questions = fieldQuestions(form);
	const data: HtmlFormData = {};
	const notes: OptionNote[] = [];
	for (const [name, value] of form.hidden) data[name] = value;
	form.fields.forEach((field, index) => {
		const answer = answers.get(index);
		// An unnamed control submits nothing: unanswered, it has no value to check either.
		if (!field.name && !answer) return;
		const question = questions.get(field) ?? field.name;
		let value;
		if (field.kind === "text") {
			value = textValue(field, answer?.kind === "text" ? answer.text : field.value);
		} else {
			const given = answer?.kind === "choice" ? answer : undefined;
			const checked = given
				? field.multi
					? given.checked
					: given.checked.slice(-1)
				: defaultChecked(field);
			value = choiceValue(field, new Set(checked), given?.other);
			if (given) notes.push(...chosenNotes(field, given, checked, question));
		}
		const error = fieldError(field, value);
		if (error) throw new InvalidFormAnswerError(`"${question}": ${error}`);
		if (field.name && value !== undefined) data[field.name] = value;
	});
	return notes.length > 0 ? { data, notes } : { data };
}
