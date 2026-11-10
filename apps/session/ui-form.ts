import {
	choiceValue,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import { loadFormImage, svgMedia, type FormMedia } from "@oh-my-pi/pi-tui/html-form/media";
import type { ChoiceField, FormBlock, FormField, HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { UiFormBlock, UiFormField, UiFormFieldAnswer, UiFormParams } from "#lib/wire/ask-form";

// ---------------------------------------------------------------------------
// The `formDialog` ui_request, session side: the SDK's parsed HTML form as the
// JSON-safe structure the browser draws, and the browser's (or a collab
// guest's) answer back as the SDK's form data. The SDK helpers do every value
// and validation rule, so submitted data matches the TUI's byte for byte.
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

/** The raw answers by field index; a malformed entry is invalid. */
function answersByIndex(form: HtmlForm, raw: unknown): Map<number, UiFormFieldAnswer> {
	if (typeof raw !== "object" || raw === null)
		throw new InvalidFormAnswerError("not a form answer");
	const { kind, answers } = raw as { kind?: unknown; answers?: unknown };
	if (kind !== "submit" || !Array.isArray(answers))
		throw new InvalidFormAnswerError("not a form answer");
	const byIndex = new Map<number, UiFormFieldAnswer>();
	for (const answer of answers as unknown[]) {
		// Untrusted wire data: every property is checked before the entry is used as an answer.
		const entry = answer as {
			kind?: unknown;
			index?: unknown;
			text?: unknown;
			checked?: unknown;
			other?: unknown;
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
		}
		byIndex.set(entry.index, entry as UiFormFieldAnswer);
	}
	return byIndex;
}

/**
 * The SDK's form data for a submitted answer: hidden pairs, then each named field's
 * value from `choiceValue`/`textValue`. A field the answer leaves out keeps its
 * default. Every named or answered field must pass the SDK's `fieldError` (required,
 * min/max, length, pattern, email/url): the browser checks the same rules before it
 * submits, so a rejection here comes from a stale or foreign client.
 *
 * @throws {InvalidFormAnswerError} the answer is malformed or a field fails its rules.
 */
export function formDataFromSubmit(form: HtmlForm, raw: unknown): HtmlFormData {
	const answers = answersByIndex(form, raw);
	const questions = fieldQuestions(form);
	const data: HtmlFormData = {};
	for (const [name, value] of form.hidden) data[name] = value;
	form.fields.forEach((field, index) => {
		const answer = answers.get(index);
		// An unnamed control submits nothing: unanswered, it has no value to check either.
		if (!field.name && !answer) return;
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
		}
		const error = fieldError(field, value);
		if (error) {
			throw new InvalidFormAnswerError(`"${questions.get(field) ?? field.name}": ${error}`);
		}
		if (field.name && value !== undefined) data[field.name] = value;
	});
	return data;
}
