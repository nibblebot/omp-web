/**
 * Jump from one place in the transcript to a tool card: scroll the card to the
 * middle of the viewport and flash it. Cards carry `data-tool-call-id`
 * (`ToolCardShell`); a stream that mounts its items in chunks registers a
 * reveal, which mounts a card the jump cannot find, in slices. The flash is the
 * `tool-card--jump` class, which the stylesheet animates (`tool-card-jump`); it
 * is released when that animation ends, so its length lives in CSS only.
 */

const JUMP_CLASS = "tool-card--jump";
const JUMP_ANIMATION = "tool-card-jump";

/** Streams: each mounts the card of a tool call it holds, leaves the live edge, and settles with whether it holds it. */
type Reveal = (toolCallId: string) => Promise<boolean>;
const revealers = new Set<Reveal>();

/** Let jumps reach the cards of a stream; the returned function removes it. */
export function registerToolReveal(reveal: Reveal): () => void {
	revealers.add(reveal);
	return () => revealers.delete(reveal);
}

function findCard(toolCallId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
}

/** Frames a freshly mounted card gets to settle before the jump stops following it. */
const SETTLE_FRAMES = 12;

/**
 * Cards a reveal just mounted lay out at estimated heights until they render, so the
 * card can drift off screen after the first scroll: bring it back while it does.
 */
function keepInView(card: HTMLElement): void {
	let frames = 0;
	const step = () => {
		if (!card.isConnected || ++frames > SETTLE_FRAMES) return;
		const rect = card.getBoundingClientRect();
		if (rect.bottom <= 0 || rect.top >= window.innerHeight)
			card.scrollIntoView({ block: "center" });
		requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/** Scroll the card of `toolCallId` into view and flash it. False when no stream holds such a card. */
export async function jumpToToolCard(toolCallId: string): Promise<boolean> {
	const wasMounted = findCard(toolCallId) !== null;
	// Every stream that holds the card mounts it if needed and leaves the live edge: a scroll event
	// cannot say that the jump is not the reader's own scrolling, so the stream is told.
	await Promise.all([...revealers].map((reveal) => reveal(toolCallId)));
	const card = findCard(toolCallId);
	if (!card) return false;
	if (!wasMounted) keepInView(card);
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
