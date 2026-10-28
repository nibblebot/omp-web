/**
 * Jump from one place in the transcript to a tool card: scroll the card to the
 * middle of the viewport and flash it. Cards carry `data-tool-call-id`
 * (`ToolCardShell`); a stream that mounts its items on demand registers a
 * reveal, which mounts a card the jump cannot find. The flash is the
 * `tool-card--jump` class, which the stylesheet animates (`tool-card-jump`); it
 * is released when that animation ends, so its length lives in CSS only.
 */

const JUMP_CLASS = "tool-card--jump";
const JUMP_ANIMATION = "tool-card-jump";

/** Streams that mount their items on demand: each mounts the card of a tool call it holds and returns whether it did. */
const revealers = new Set<(toolCallId: string) => boolean>();

/** Let jumps reach cards a stream has not mounted yet; the returned function removes it. */
export function registerToolReveal(reveal: (toolCallId: string) => boolean): () => void {
	revealers.add(reveal);
	return () => revealers.delete(reveal);
}

function findCard(toolCallId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
}

/** Scroll the card of `toolCallId` into view and flash it. False when no stream holds such a card. */
export function jumpToToolCard(toolCallId: string): boolean {
	let card = findCard(toolCallId);
	if (!card) {
		for (const reveal of revealers) {
			if (!reveal(toolCallId)) continue;
			card = findCard(toolCallId);
			if (card) break;
		}
	}
	if (!card) return false;
	card.scrollIntoView({ block: "center" });
	// Restart the flash when the card is jumped to again mid-flash.
	card.classList.remove(JUMP_CLASS);
	void card.offsetWidth;
	card.classList.add(JUMP_CLASS);
	const release = (event: AnimationEvent) => {
		// The card's own children (spinners, pulses) animate too and their events bubble here.
		if (event.target !== card || event.animationName !== JUMP_ANIMATION) return;
		card.classList.remove(JUMP_CLASS);
		card.removeEventListener("animationend", release);
	};
	card.addEventListener("animationend", release);
	return true;
}
