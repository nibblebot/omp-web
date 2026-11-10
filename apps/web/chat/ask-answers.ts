/**
 * Per-question views for the transcript `ask` card, for both shapes of the tool
 * the durable logs hold.
 *
 * - Form shape (SDK 18.18.3+): args `{ html }` (one HTML `<form>`), details
 *   `AskToolDetails = { answers: { name, question, answer }[]; timedOut? }`.
 *   {@link formAnswerViews} lists the answers; {@link askFormPrompts} recovers what a
 *   call without a result (pending, cancelled) asked, by an inert text-only parse of the
 *   model's untrusted HTML.
 * - Question shape (older transcripts): args `{ questions: [{ question, options,
 *   multi }] }`, details either a single answer's fields or `{ results }`, plus `note`,
 *   `noteOption` (SDK 18.13.1+) and `chatRedirect`. {@link questionViews} merges the
 *   offered options with the answer.
 */

export type AskArgsQuestion = {
	question?: string;
	options?: { label?: string; description?: string }[];
	multi?: boolean;
};

/** One answered question in the question-shape details (single-question fields or a `results` row). */
export type AskAnswer = {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	note?: string;
	/** The option the note was attached to (SDK 18.13.1+); absent for a note on the question as a whole. */
	noteOption?: string;
	timedOut?: boolean;
};

/** One form field's answer in the form-shape details (the SDK's `FormAnswer`): both texts. */
export type AskFormAnswer = { name?: string; question?: string; answer?: string };

export type AskDetails = AskAnswer & {
	results?: AskAnswer[];
	chatRedirect?: boolean;
	/** Form shape: each named field's question and answer. */
	answers?: AskFormAnswer[];
};

export type AskOptionView = { label: string; description?: string; selected: boolean };

export type AskQuestionView = {
	question: string;
	multi: boolean;
	options: AskOptionView[];
	/** Present once the user answered; absent while waiting or after a dismissal. */
	answer?: {
		customInput?: string;
		note?: string;
		noteOption?: string;
		timedOut?: boolean;
		empty: boolean;
	};
};

/** The transcript label for an answer's note: names the option when the note was attached to one. */
export function noteLabel(noteOption: string | undefined): string {
	return noteOption === undefined ? "Note" : `Note on ${noteOption}`;
}

export function askDetails(details: unknown): AskDetails | undefined {
	return details && typeof details === "object" ? (details as AskDetails) : undefined;
}

export function answersOf(details: AskDetails | undefined): AskAnswer[] {
	if (!details) return [];
	if (Array.isArray(details.results)) return details.results;
	return details.selectedOptions !== undefined || details.customInput !== undefined
		? [details]
		: [];
}

/** Merges the offered options (args) with the user's answer (result details). */
export function questionViews(args: AskArgsQuestion[], answers: AskAnswer[]): AskQuestionView[] {
	const count = Math.max(args.length, answers.length);
	return Array.from({ length: count }, (_, i) => {
		const q = args[i];
		const a = answers[i];
		const selected = a?.selectedOptions ?? [];
		const offered: AskOptionView[] = q?.options?.length
			? q.options
					.filter((o) => o?.label)
					.map((o) => ({
						label: o.label as string,
						description: o.description?.trim() || undefined,
						selected: selected.includes(o.label as string),
					}))
			: (a?.options ?? []).map((label) => ({ label, selected: selected.includes(label) }));
		// A selection the offered list lacks still has to show as chosen.
		const extra = selected
			.filter((label) => !offered.some((o) => o.label === label))
			.map((label) => ({ label, selected: true }));
		return {
			question: q?.question ?? a?.question ?? "",
			multi: q?.multi ?? a?.multi ?? false,
			options: [...offered, ...extra],
			answer: a
				? {
						customInput: a.customInput,
						note: a.note,
						noteOption: a.noteOption,
						timedOut: a.timedOut,
						empty: selected.length === 0 && a.customInput === undefined,
					}
				: undefined,
		};
	});
}

// ---------------------------------------------------------------------------
// Form shape: args `{ html }`, details `{ answers, timedOut? }`.
// ---------------------------------------------------------------------------

/** The form HTML of a form-shape call; undefined for a question-shape call or malformed args. */
export function askHtml(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("html" in args)) return undefined;
	return typeof args.html === "string" ? args.html : undefined;
}

/** One form field's answer as the card lists it: empty when the field was left blank. */
export type AskFormAnswerView = { name: string; question: string; answer: string };

/** The answered fields of a form-shape result, in form order; empty for any other details. */
export function formAnswerViews(details: AskDetails | undefined): AskFormAnswerView[] {
	if (!details || !Array.isArray(details.answers)) return [];
	return details.answers.map((row) => {
		const name = row?.name ?? "";
		return {
			name,
			question: row?.question?.trim() || name,
			answer: row?.answer?.trim() ?? "",
		};
	});
}

/** The slice of a DOM node the prompt extraction reads; browser nodes and test DOMs both satisfy it. */
export type FormDomNode = {
	nodeType: number;
	childNodes: ArrayLike<FormDomNode>;
	textContent: string | null;
	localName?: string;
	getAttribute?(name: string): string | null;
};

/** Parses markup into an inert document: nothing in it runs, loads or attaches to the page. */
export type FormHtmlParser = (html: string) => { body: FormDomNode | null };

const browserFormParser: FormHtmlParser = (html) =>
	new DOMParser().parseFromString(html, "text/html");

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** Source cut before parsing: a form is short, and the card only needs its first questions. */
const MAX_FORM_HTML = 20_000;
const MAX_PROMPTS = 12;
const MAX_PROMPT_CHARS = 160;
/** Elements whose text is not a question: code, widget content, and the options themselves. */
const SKIPPED_TAGS: Record<string, true> = {
	script: true,
	style: true,
	template: true,
	noscript: true,
	textarea: true,
	select: true,
	option: true,
	datalist: true,
	button: true,
};
/** Elements whose text states a question or its context. */
const PROMPT_TAGS: Record<string, true> = {
	legend: true,
	label: true,
	p: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
};

function tagOf(node: FormDomNode): string {
	return (node.localName ?? "").toLowerCase();
}

function isChoiceInput(node: FormDomNode): boolean {
	if (node.nodeType !== ELEMENT_NODE || tagOf(node) !== "input") return false;
	const type = (node.getAttribute?.("type") ?? "").toLowerCase();
	return type === "radio" || type === "checkbox";
}

/** A label around a radio or checkbox names one option, not a question. */
function isOptionLabel(node: FormDomNode): boolean {
	if (tagOf(node) !== "label") return false;
	return Array.from(node.childNodes).some((child) => isChoiceInput(child) || isOptionLabel(child));
}

function collectText(node: FormDomNode, out: string[]): void {
	if (node.nodeType === TEXT_NODE) {
		out.push(node.textContent ?? "");
		return;
	}
	if (node.nodeType !== ELEMENT_NODE) return;
	if (Object.hasOwn(SKIPPED_TAGS, tagOf(node)) || isOptionLabel(node)) return;
	for (const child of Array.from(node.childNodes)) collectText(child, out);
}

function textOf(node: FormDomNode): string {
	const parts: string[] = [];
	collectText(node, parts);
	const text = parts.join("").replace(/\s+/g, " ").trim();
	return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS - 1)}…` : text;
}

function collectPrompts(node: FormDomNode, out: string[]): void {
	if (out.length >= MAX_PROMPTS || node.nodeType !== ELEMENT_NODE) return;
	const tag = tagOf(node);
	if (Object.hasOwn(SKIPPED_TAGS, tag) || isOptionLabel(node)) return;
	if (Object.hasOwn(PROMPT_TAGS, tag)) {
		const text = textOf(node);
		if (text !== "" && !out.includes(text)) out.push(text);
		return;
	}
	for (const child of Array.from(node.childNodes)) collectPrompts(child, out);
}

/**
 * What a form asks, for a call without an answer: its legends, headings, paragraphs and
 * labels of text controls, one line each (at most 12, 160 characters each). A form with none
 * of those falls back to its plain text. The html is the model's and untrusted: it is parsed
 * inert and only text is read, never inserted into the page.
 */
export function askFormPrompts(html: string, parse: FormHtmlParser = browserFormParser): string[] {
	const body = parse(html.slice(0, MAX_FORM_HTML)).body;
	if (!body) return [];
	const prompts: string[] = [];
	collectPrompts(body, prompts);
	if (prompts.length > 0) return prompts;
	const text = textOf(body);
	return text === "" ? [] : [text];
}
