import {
	createEffect,
	createMemo,
	createSignal,
	on,
	untrack,
	type Accessor,
	type Setter,
} from "solid-js";
import {
	alternativesKey,
	moreHint,
	predictionChoicesOf,
	shownPrediction,
} from "../../../prompt/prediction-choices";
import { call, state } from "../../../state";
import { settingValue } from "../../../store/settings";
import type { AcItem } from "./AutocompletePopup";

/** Pause after the last keystroke before asking for a word completion. */
const WORD_DEBOUNCE_MS = 150;
/** Word completion is advisory; a slow answer shows nothing rather than stalling. */
const WORD_TIMEOUT_MS = 5_000;
/** Mirrors the session-side prediction deadline (15 s) plus transport slack. */
const NEXT_TIMEOUT_MS = 20_000;

/**
 * Longest stretch of the draft's end sent with a word-prediction call. The engine reads only the last
 * ~2 000 characters before the word; shipping a large pasted draft whole on every pause (and again as
 * feedback) put the full text on the socket twice per pause. Drafts at or under this go whole.
 */
export const WORD_CONTEXT_CHARS = 32_000;
/** How far past the cut a line start may be and still replace it, so the window never collapses to a last line. */
const WORD_CONTEXT_LINE_SLACK = 2_000;

/** The `[text, cursor]` of a word-prediction call for a caret at the end of `draft`: its tail, starting at a line start when one is near the cut. */
export function wordQueryArgs(draft: string): [string, number] {
	if (draft.length <= WORD_CONTEXT_CHARS) return [draft, draft.length];
	let start = draft.length - WORD_CONTEXT_CHARS;
	const lineStart = draft.indexOf("\n", start);
	if (lineStart >= 0 && lineStart - start < WORD_CONTEXT_LINE_SLACK) start = lineStart + 1;
	else if (draft.charCodeAt(start) >= 0xdc00 && draft.charCodeAt(start) <= 0xdfff) start++;
	const tail = draft.slice(start);
	return [tail, tail.length];
}

/** A `spelling.autocomplete` suffix for the draft `at`, shown at the caret end. */
interface WordGhost {
	at: string;
	suffix: string;
}

/** The Tab list of every next-message prediction, shown over a draft that equals one of them. */
export interface PredictionAlternatives {
	open: Accessor<boolean>;
	/** One row per prediction, most likely first. */
	items: Accessor<AcItem[]>;
	selected: Accessor<number>;
	setSelected: (index: number) => void;
	/** Swaps the whole line for prediction `index` and closes the list; never submits. */
	choose: (index: number) => void;
	/** Closes the list and keeps the line. */
	close: () => void;
	/** Handles a key while the list is open; true when the list consumed it. */
	onKeyDown: (e: KeyboardEvent) => boolean;
}

export interface GhostText {
	/** Ghost text drawn after the caret; empty when none applies. */
	text: Accessor<string>;
	/** The dim `⇥ N more` hint drawn after a draft that equals one of several predictions; empty when none applies. */
	hint: Accessor<string>;
	/** Re-read whether the caret sits at the end; call on input, keyup, and click. */
	refreshCaret: () => void;
	/** Accept the ghost into the draft. Returns false when no ghost is showing. */
	accept: () => boolean;
	/** Open the alternatives list (Tab over a draft that equals one of several predictions). Returns false when it does not apply. */
	openAlternatives: () => boolean;
	alternatives: PredictionAlternatives;
	/** Drop the predictions: the draft was sent, so they no longer follow the conversation. */
	retire: () => void;
}

/** Best-effort feedback to the session's word predictor; no UI depends on it. */
function sendWordFeedback(ghost: WordGhost, accepted: boolean): void {
	void call("predictWordFeedback", [...wordQueryArgs(ghost.at), ghost.suffix, accepted]).catch(
		() => {
			// Feedback is advisory: losing one sample only skews future ranking.
		},
	);
}

/** Best-effort report to the session's prediction metrics; no UI depends on it. */
function reportPrediction(method: "predictionShown" | "predictionAccepted", args: number[]): void {
	void call(method, args).catch(() => {
		// Metrics are advisory: a lost report only undercounts.
	});
}

/** Reads `{suffix}` from an RPC reply without trusting its shape. */
function suffixOf(reply: unknown): string {
	const suffix = (reply as { suffix?: unknown } | null)?.suffix;
	return typeof suffix === "string" ? suffix : "";
}

/**
 * Ghost text for the composer. Two sources share one overlay:
 * - `spelling.autocomplete`: word suffix at the end of the draft (`predictWord`).
 * - `composer.predictions`: ranked predictions of the next message, requested once a streamed turn
 *   ends (`predictNextMessage`; several with `composer.predictionAlternatives`). The ghost follows the
 *   first prediction the draft is a prefix of, like the TUI editor; see `prompt/prediction-choices.ts`.
 * Both are gated by their settings at the point of use, so changes apply live. A prediction wins over
 * a word suffix.
 */
export function useGhostText(
	getTextarea: () => HTMLTextAreaElement | undefined,
	message: Accessor<string>,
	setMessage: Setter<string>,
): GhostText {
	const [caretEnd, setCaretEnd] = createSignal(true);
	const [word, setWord] = createSignal<WordGhost | null>(null);
	const [choices, setChoices] = createSignal<string[]>([]);
	// The line the last prediction insert (Tab, Right, or the list) left; any later edit clears it.
	const [inserted, setInserted] = createSignal<string | null>(null);
	const [listOpen, setListOpen] = createSignal(false);
	const [selected, setSelected] = createSignal(0);
	// Last word suggestion the user could have seen; unresolved ones get rejected feedback.
	let shown: WordGhost | null = null;
	let wordTimer: number | undefined;
	let wordSeq = 0;
	// Bumped whenever an in-flight `predictNextMessage` answer stops being wanted.
	let predictSeq = 0;
	// Whether the current predictions have been reported as shown; once per `predictNextMessage` answer.
	let shownReported = false;

	const refreshCaret = (): void => {
		const ta = getTextarea();
		if (!ta) return;
		setCaretEnd(ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length);
	};

	const open = (): boolean => listOpen() && choices().length > 1;
	const prediction = createMemo(
		() => (caretEnd() && !listOpen() ? shownPrediction(choices(), message(), inserted()) : null),
		null,
		{ equals: (a, b) => a?.index === b?.index && a?.suffix === b?.suffix },
	);
	const hint = createMemo(() =>
		caretEnd() && !listOpen() ? moreHint(choices(), message(), inserted()) : "",
	);
	// A prediction, its hint or its open list owns the overlay: no word suggestion is asked for or drawn.
	const predicting = createMemo(() => prediction() !== null || hint() !== "" || open());

	// The first time the ghost or the `⇥ N more` hint is on screen, the session's metrics count the
	// prediction as shown.
	createEffect(() => {
		if ((prediction() === null && hint() === "") || shownReported) return;
		shownReported = true;
		reportPrediction("predictionShown", []);
	});

	const text = (): string => {
		if (!caretEnd() || predicting()) return prediction()?.suffix ?? "";
		const draft = message();
		const w = word();
		return draft !== "" && w && w.at === draft ? w.suffix : "";
	};

	// Spelling: one debounced request per settled draft; stale replies are dropped.
	createEffect(() => {
		const draft = message();
		const end = caretEnd();
		const mode = settingValue<string>("spelling.autocomplete") ?? "auto";
		const busy = predicting();
		window.clearTimeout(wordTimer);
		const seq = ++wordSeq;
		if (shown) {
			sendWordFeedback(shown, false);
			shown = null;
		}
		setWord(null);
		if (!end || draft === "" || mode === "off" || state.streaming || busy) return;
		wordTimer = window.setTimeout(() => {
			void call("predictWord", wordQueryArgs(draft), WORD_TIMEOUT_MS)
				.then((reply) => {
					const suffix = suffixOf(reply);
					if (seq !== wordSeq || suffix === "") return;
					shown = { at: draft, suffix };
					setWord(shown);
				})
				.catch(() => {
					// Advisory: a failed prediction shows no ghost text.
				});
		}, WORD_DEBOUNCE_MS);
	});

	const retire = (): void => {
		predictSeq++;
		shownReported = false;
		setChoices([]);
		setInserted(null);
		setListOpen(false);
	};

	// Next message: requested when a streamed turn ends and the draft is still empty; a new turn or a
	// session switch retires it.
	createEffect(
		on(
			() => state.streaming,
			(streaming, wasStreaming) => {
				retire();
				if (streaming || wasStreaming !== true) return;
				if (settingValue<boolean>("composer.predictions") !== true || message() !== "") return;
				const seq = predictSeq;
				void call("predictNextMessage", [], NEXT_TIMEOUT_MS)
					.then((reply) => {
						const predicted = predictionChoicesOf(reply);
						if (seq === predictSeq && predicted.length > 0) {
							shownReported = false;
							setChoices(predicted);
						}
					})
					.catch(() => {
						// Advisory: a failed prediction shows no ghost text.
					});
			},
		),
	);
	createEffect(
		on(
			() => `${state.currentWorkspaceId}:${state.sessionId}`,
			() => retire(),
			{ defer: true },
		),
	);

	// Any edit drops the "inserted by a prediction" mark (unless it is the insert itself) and the list.
	createEffect(
		on(
			message,
			(draft) => {
				if (untrack(inserted) !== draft) setInserted(null);
				setListOpen(false);
			},
			{ defer: true },
		),
	);
	createEffect(() => {
		if (!caretEnd()) setListOpen(false);
	});

	const accept = (): boolean => {
		if (!caretEnd() || open()) return false;
		const draft = message();
		const next = prediction();
		if (next) {
			const line = draft + next.suffix;
			setInserted(line);
			reportPrediction("predictionAccepted", [next.index]);
			setMessage(line);
			return true;
		}
		const suffix = text();
		if (suffix === "") return false;
		if (shown) sendWordFeedback(shown, true);
		shown = null;
		setWord(null);
		setMessage(draft + suffix);
		return true;
	};

	const openAlternatives = (): boolean => {
		if (!caretEnd() || open()) return false;
		const index = choices().indexOf(message());
		if (choices().length < 2 || index < 0 || prediction() !== null) return false;
		setSelected(index);
		setListOpen(true);
		return true;
	};

	const close = (): void => {
		setListOpen(false);
	};

	const choose = (index: number): void => {
		const line = choices()[index];
		close();
		// Picking the line already in the buffer changes nothing.
		if (line === undefined || line === message()) return;
		setInserted(line);
		reportPrediction("predictionAccepted", [index]);
		setMessage(line);
		requestAnimationFrame(() => {
			const ta = getTextarea();
			ta?.focus();
			ta?.setSelectionRange(line.length, line.length);
			refreshCaret();
		});
	};

	const onKeyDown = (e: KeyboardEvent): boolean => {
		if (!open()) return false;
		const action = alternativesKey(e, selected(), choices().length);
		if (!action) return false;
		e.preventDefault();
		if (action.kind === "move") setSelected(action.selected);
		else if (action.kind === "pick") choose(action.index);
		else close();
		return true;
	};

	const items = createMemo(() => choices().map((line) => ({ label: line, apply: line })));

	return {
		text,
		hint,
		refreshCaret,
		accept,
		openAlternatives,
		retire,
		alternatives: { open, items, selected, setSelected, choose, close, onKeyDown },
	};
}
