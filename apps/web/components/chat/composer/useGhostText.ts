import { createEffect, createSignal, on, type Accessor, type Setter } from "solid-js";
import { call, state } from "../../../state";
import { settingValue } from "../../../store/settings";

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

export interface GhostText {
	/** Ghost text drawn after the caret; empty when none applies. */
	text: Accessor<string>;
	/** Re-read whether the caret sits at the end; call on input, keyup, and click. */
	refreshCaret: () => void;
	/** Accept the ghost into the draft. Returns false when no ghost is showing. */
	accept: () => boolean;
}

/** Best-effort feedback to the session's word predictor; no UI depends on it. */
function sendWordFeedback(ghost: WordGhost, accepted: boolean): void {
	void call("predictWordFeedback", [...wordQueryArgs(ghost.at), ghost.suffix, accepted]).catch(
		() => {
			// Feedback is advisory: losing one sample only skews future ranking.
		},
	);
}

/** Reads `{suffix}` from an RPC reply without trusting its shape. */
function suffixOf(reply: unknown): string {
	const suffix = (reply as { suffix?: unknown } | null)?.suffix;
	return typeof suffix === "string" ? suffix : "";
}

/** Reads `{text}` from an RPC reply without trusting its shape. */
function predictedTextOf(reply: unknown): string | null {
	const text = (reply as { text?: unknown } | null)?.text;
	return typeof text === "string" && text !== "" ? text : null;
}

/**
 * Ghost text for the composer. Two sources share one overlay:
 * - `spelling.autocomplete`: word suffix at the end of the draft (`predictWord`).
 * - `composer.predictions`: a predicted next message, offered on an empty draft
 *   once a streamed turn ends (`predictNextMessage`).
 * Both are gated by their settings at the point of use, so changes apply live.
 */
export function useGhostText(
	getTextarea: () => HTMLTextAreaElement | undefined,
	message: Accessor<string>,
	setMessage: Setter<string>,
): GhostText {
	const [caretEnd, setCaretEnd] = createSignal(true);
	const [word, setWord] = createSignal<WordGhost | null>(null);
	const [nextMessage, setNextMessage] = createSignal<string | null>(null);
	// Last word suggestion the user could have seen; unresolved ones get rejected feedback.
	let shown: WordGhost | null = null;
	let wordTimer: number | undefined;
	let wordSeq = 0;

	const refreshCaret = (): void => {
		const ta = getTextarea();
		if (!ta) return;
		setCaretEnd(ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length);
	};

	const text = (): string => {
		if (!caretEnd()) return "";
		const draft = message();
		if (draft === "") return nextMessage() ?? "";
		const w = word();
		return w && w.at === draft ? w.suffix : "";
	};

	// Spelling: one debounced request per settled draft; stale replies are dropped.
	createEffect(() => {
		const draft = message();
		const end = caretEnd();
		const mode = settingValue<string>("spelling.autocomplete") ?? "auto";
		window.clearTimeout(wordTimer);
		const seq = ++wordSeq;
		if (shown) {
			sendWordFeedback(shown, false);
			shown = null;
		}
		setWord(null);
		setNextMessage(null);
		if (!end || draft === "" || mode === "off" || state.streaming) return;
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

	// Next message: when a streamed turn ends and the draft is still empty.
	createEffect(
		on(
			() => state.streaming,
			(streaming, wasStreaming) => {
				if (streaming || wasStreaming !== true) return;
				if (settingValue<boolean>("composer.predictions") !== true || message() !== "") return;
				void call("predictNextMessage", [], NEXT_TIMEOUT_MS)
					.then((reply) => {
						const predicted = predictedTextOf(reply);
						if (predicted !== null && message() === "") setNextMessage(predicted);
					})
					.catch(() => {
						// Advisory: a failed prediction shows no ghost text.
					});
			},
		),
	);

	const accept = (): boolean => {
		if (!caretEnd()) return false;
		const suffix = text();
		if (suffix === "") return false;
		const draft = message();
		if (draft === "") {
			setNextMessage(null);
			setMessage(suffix);
			return true;
		}
		if (shown) sendWordFeedback(shown, true);
		shown = null;
		setWord(null);
		setMessage(draft + suffix);
		return true;
	};

	return { text, refreshCaret, accept };
}
