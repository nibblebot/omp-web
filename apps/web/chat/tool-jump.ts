/**
 * Jump from one place in the transcript to a tool card: scroll the card to the
 * middle of the viewport and flash it. Cards carry `data-tool-call-id`
 * (`ToolCardShell`). The flash is the `tool-card--jump` class, which the
 * stylesheet animates (`tool-card-jump`); it is released when that animation
 * ends, so its length lives in CSS only.
 */

const JUMP_CLASS = "tool-card--jump";
const JUMP_ANIMATION = "tool-card-jump";

/** Scroll the card of `toolCallId` into view and flash it. False when no such card is mounted. */
export function jumpToToolCard(toolCallId: string): boolean {
	const card = document.querySelector<HTMLElement>(
		`[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
	);
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
