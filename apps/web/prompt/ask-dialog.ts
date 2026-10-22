import type { AskQuestion } from "./ask-types";

/** The user's working answer to one ask question. */
export interface AskAnswer {
	selected: string[];
	custom: string;
}

/** One entry of ExtensionAskDialogSubmitResult; the SDK validates count, order, and ids. */
export interface AskResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

/** The recommended option starts selected so a plain Enter accepts it. */
export function initialAnswer(q: AskQuestion): AskAnswer {
	const rec = q.recommended !== undefined ? q.options[q.recommended] : undefined;
	return { selected: rec ? [rec.label] : [], custom: "" };
}

/** Answered means a selected option or non-blank custom text. */
export function isAnswered(a: AskAnswer): boolean {
	return a.selected.length > 0 || a.custom.trim() !== "";
}

/** Where the option cursor lands on entering a question: first selected, else recommended, else 0. */
export function entryCursor(q: AskQuestion, a: AskAnswer): number {
	const selected = q.options.findIndex((o) => a.selected.includes(o.label));
	if (selected >= 0) return selected;
	return q.recommended !== undefined && q.recommended >= 0 && q.recommended < q.options.length
		? q.recommended
		: 0;
}

/** The answer as shown on the review step: selected labels then custom text, ", "-joined; "" when unanswered. */
export function answerSummary(a: AskAnswer): string {
	const custom = a.custom.trim();
	return [...a.selected, ...(custom ? [custom] : [])].join(", ");
}

/** Tab label: the question's header, else Q1, Q2, ... */
export function tabLabel(q: AskQuestion, index: number): string {
	return q.header?.trim() || `Q${index + 1}`;
}

/** One result per question in order; skipped questions send no selection and no custom input. */
export function buildResults(questions: AskQuestion[], answers: AskAnswer[]): AskResult[] {
	return questions.map((q, i) => {
		const text = answers[i].custom.trim();
		return {
			id: q.id,
			question: q.question,
			options: q.options.map((o) => o.label),
			multi: q.multi ?? false,
			selectedOptions: answers[i].selected,
			...(text ? { customInput: text } : {}),
		};
	});
}
