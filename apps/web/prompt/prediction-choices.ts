/**
 * Next-message prediction rules shared by the composer's ghost text: which of the ranked
 * predictions the draft follows, when the `⇥ N more` hint shows, and the alternatives list's
 * keys. Mirrors pi-tui's `Editor.predictions` (SDK 18.17.0) so the web and the TUI agree.
 * Everything here is pure; the caret-at-end gate is the caller's. Predictions are single lines,
 * so a draft with a line break never matches one.
 */

/** Most likely first; one entry unless `composer.predictionAlternatives` returned several. */
export type PredictionChoices = readonly string[];

/** The prediction painted as ghost text: its rank and the part of it the draft has not typed. */
export interface ShownPrediction {
	index: number;
	suffix: string;
}

/**
 * The ranked predictions of a `predictNextMessage` reply: its `choices` when it carries two or more,
 * else its `text` as the only one (an older session answers `text` alone), else none. Reads the
 * reply without trusting its shape.
 */
export function predictionChoicesOf(reply: unknown): string[] {
	const body = reply as { text?: unknown; choices?: unknown } | null;
	if (Array.isArray(body?.choices)) {
		const choices = body.choices.filter(
			(choice): choice is string => typeof choice === "string" && choice !== "",
		);
		if (choices.length > 1) return choices;
	}
	const text = body?.text;
	return typeof text === "string" && text !== "" ? [text] : [];
}

/**
 * The first prediction the draft is a strict prefix of. While `inserted` (the line a prediction
 * insert left, still unedited) equals the draft and one of two or more predictions, none shows:
 * Tab opens their list instead of extending to a longer one. A draft the user typed keeps the
 * ghost of a longer prediction even when it equals a shorter one.
 */
export function shownPrediction(
	choices: PredictionChoices,
	draft: string,
	inserted: string | null,
): ShownPrediction | null {
	if (choices.length === 0 || draft.includes("\n")) return null;
	if (choices.length > 1 && draft === inserted && choices.includes(draft)) return null;
	const index = choices.findIndex(
		(choice) => draft.length < choice.length && choice.startsWith(draft),
	);
	return index < 0 ? null : { index, suffix: choices[index]!.slice(draft.length) };
}

/** With two or more predictions, the rank of the one the draft equals (Tab then lists them all); else null. */
export function alternativesIndex(choices: PredictionChoices, draft: string): number | null {
	if (choices.length < 2 || draft.includes("\n")) return null;
	const index = choices.indexOf(draft);
	return index < 0 ? null : index;
}

/** The dim `⇥ N more` hint: the draft equals one of several predictions and no ghost shows. Empty otherwise. */
export function moreHint(
	choices: PredictionChoices,
	draft: string,
	inserted: string | null,
): string {
	if (alternativesIndex(choices, draft) === null) return "";
	if (shownPrediction(choices, draft, inserted) !== null) return "";
	return `⇥ ${choices.length - 1} more`;
}

/** What a key does while the alternatives list is open. */
export type AlternativesKeyAction =
	| { kind: "move"; selected: number }
	| { kind: "pick"; index: number }
	| { kind: "close" };

/**
 * Keys of the open alternatives list: Up and Down move (wrapping), Enter, Tab or Right swap the
 * whole line for the selected prediction (never submitting), Escape keeps the line. Any other key
 * is not the list's.
 */
export function alternativesKey(
	event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
	selected: number,
	count: number,
): AlternativesKeyAction | null {
	if (count < 1 || event.ctrlKey || event.metaKey || event.altKey) return null;
	switch (event.key) {
		case "ArrowDown":
			return { kind: "move", selected: (selected + 1) % count };
		case "ArrowUp":
			return { kind: "move", selected: (selected - 1 + count) % count };
		case "Tab":
		case "Enter":
		case "ArrowRight":
			return event.shiftKey ? null : { kind: "pick", index: selected };
		case "Escape":
			return { kind: "close" };
		default:
			return null;
	}
}
