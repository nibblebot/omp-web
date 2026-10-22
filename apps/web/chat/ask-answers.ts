/** Merges the `ask` tool's offered options (call args) with the user's answer (SDK `AskToolDetails`) into per-question views for the transcript card. */

export type AskArgsQuestion = {
	question?: string;
	options?: { label?: string; description?: string }[];
	multi?: boolean;
};

/** One answered question in the SDK's `AskToolDetails` (single-question fields or a `results` row). */
export type AskAnswer = {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
};

export type AskDetails = AskAnswer & { results?: AskAnswer[]; chatRedirect?: boolean };

export type AskOptionView = { label: string; description?: string; selected: boolean };

export type AskQuestionView = {
	question: string;
	multi: boolean;
	options: AskOptionView[];
	/** Present once the user answered; absent while waiting or after a dismissal. */
	answer?: { customInput?: string; note?: string; timedOut?: boolean; empty: boolean };
};

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
						timedOut: a.timedOut,
						empty: selected.length === 0 && a.customInput === undefined,
					}
				: undefined,
		};
	});
}
