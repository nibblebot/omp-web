/**
 * The `<inject>` block of a /btw answer: the steering prompt a side answer drafted for the
 * main session when `btw.inject` is on. Port of the TUI's `splitBtwInject`,
 * `formatBtwInjectText` and `getBtwInject` (pi-tui overlays/btw-history.ts), so the block the
 * web shows is the text the session sends.
 */

const INJECT_OPEN = "<inject>";
const INJECT_CLOSE = "</inject>";
const TAB_SPACES = "   ";

/** An answer around its `<inject>` block. */
export interface BtwInjectParts {
	before: string;
	inject: string;
	after: string;
	/** False while no opener has a close: the block may still be streaming, so it runs to the end. */
	closed: boolean;
}

/**
 * Split an answer at its last closed `<inject>` block: the last opener that has a close
 * after it, paired with the first close after it. A tag merely mentioned in prose, before or
 * after the block, cannot capture it. Without a closed block, the last opener runs to the end
 * (`closed: false`); show it as a block only while the answer still streams.
 */
export function splitBtwInject(answer: string): BtwInjectParts | undefined {
	const lastClose = answer.lastIndexOf(INJECT_CLOSE);
	const open =
		lastClose === -1 ? -1 : answer.lastIndexOf(INJECT_OPEN, lastClose - INJECT_OPEN.length);
	if (open !== -1) {
		const close = answer.indexOf(INJECT_CLOSE, open + INJECT_OPEN.length);
		return {
			before: answer.slice(0, open),
			inject: answer.slice(open + INJECT_OPEN.length, close),
			after: answer.slice(close + INJECT_CLOSE.length),
			closed: true,
		};
	}
	const streaming = answer.lastIndexOf(INJECT_OPEN);
	if (streaming === -1) return undefined;
	return {
		before: answer.slice(0, streaming),
		inject: answer.slice(streaming + INJECT_OPEN.length),
		after: "",
		closed: false,
	};
}

/** Strip ANSI sequences, C0 controls (but tab and newline), DEL and C1, drop malformed unicode. */
function stripControls(text: string): string {
	const wellFormed = text.toWellFormed().replaceAll("\ufffd", "");
	let out = "";
	for (let i = 0; i < wellFormed.length; i++) {
		const code = wellFormed.charCodeAt(i);
		if (code === 0x1b) {
			i = endOfEscape(wellFormed, i);
			continue;
		}
		const control =
			(code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
		if (!control) out += wellFormed[i];
	}
	return out;
}

/** Index of the last character of the escape sequence that starts at `start` (an ESC). */
function endOfEscape(text: string, start: number): number {
	const kind = text[start + 1];
	if (kind === "[") {
		// CSI: parameter and intermediate bytes, then one final byte 0x40-0x7e.
		let i = start + 2;
		while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) i++;
		return i < text.length ? i : text.length - 1;
	}
	if (kind === "]") {
		// OSC: runs to BEL or ST (ESC backslash).
		for (let i = start + 2; i < text.length; i++) {
			if (text.charCodeAt(i) === 0x07) return i;
			if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i + 1;
		}
		return text.length - 1;
	}
	return Math.min(start + 1, text.length - 1);
}

/** A block's text as shown and as sent: control sequences stripped, tabs expanded, trimmed. */
export function formatBtwInjectText(inject: string): string {
	return stripControls(inject).replaceAll("\t", TAB_SPACES).trim();
}

/** The steering prompt to send, exactly as the block shows it; undefined while unclosed or blank. */
export function getBtwInject(answer: string): string | undefined {
	const parts = splitBtwInject(answer);
	const text = parts?.closed ? formatBtwInjectText(parts.inject) : "";
	return text || undefined;
}

/**
 * A turn's steering prompt as the session reports it: `pending` can be sent, `sending` is in
 * flight, `sent` was admitted by the main session. A turn the session never offered for
 * sending (asked with injecting off, answered in an earlier run) has none and shows as prose.
 */
export type BtwInjectState = "pending" | "sending" | "sent";

/** How a block shows: the session's state, or `failed` for a pending block whose last send was refused. */
export type BtwInjectDisplay = BtwInjectState | "failed";

/** The label under a block, as the TUI words it (`Injected into main session` once sent). */
export const BTW_INJECT_LABEL = "Inject into main session";
export const BTW_INJECTED_LABEL = "Injected into main session";

/**
 * Where a block stands, from the session's state for the turn and this page's own send: a
 * send in flight shows as sending before the session's next read says so, and a refused send
 * puts the block back to pending with the failure flagged. What the session has sent stays
 * sent, whatever this page last saw.
 */
export function btwInjectDisplay(
	server: BtwInjectState | undefined,
	local: { sending: boolean; failed: boolean },
): BtwInjectDisplay | undefined {
	if (server === undefined) return undefined;
	if (server === "sent") return "sent";
	if (server === "sending" || local.sending) return "sending";
	return local.failed ? "failed" : "pending";
}
