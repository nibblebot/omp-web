import { createSignal } from "solid-js";

/**
 * Phone width: the composer is one row (the text box and its Send/Stop buttons), and
 * Attach files and the activity buttons move into the header's More actions menu
 * (MainHeader). Matches the header's fold point; prompt.css and shell.css mirror it.
 */
const media = typeof matchMedia === "function" ? matchMedia("(max-width: 479px)") : null;
const [compactComposer, setCompactComposer] = createSignal(media?.matches ?? false);
media?.addEventListener?.("change", (e) => setCompactComposer(e.matches));

/** Whether the composer is in its one-row phone layout. Reactive. */
export { compactComposer };

let attachPicker: (() => void) | null = null;

/**
 * The main composer registers how to open its file picker, so the header's Attach files
 * item (phone layout) adds files to that composer. Returns the unregister function.
 */
export function registerAttachPicker(open: () => void): () => void {
	attachPicker = open;
	return () => {
		if (attachPicker === open) attachPicker = null;
	};
}

/** Opens the main composer's file picker; a no-op while no composer is mounted. */
export function openAttachPicker(): void {
	attachPicker?.();
}
