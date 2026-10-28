/** Smallest viewport shrink (CSS px) read as an on-screen keyboard; browser chrome sliding away is smaller. */
const KEYBOARD_MIN_SHRINK_PX = 150;

/** Whether a viewport shrunk from `baseline` to `height` is an open on-screen keyboard. */
export function keyboardShrank(baseline: number, height: number): boolean {
	return baseline - height >= KEYBOARD_MIN_SHRINK_PX;
}

/** Whether focus on `el` raises an on-screen keyboard. */
function isTextEntry(el: EventTarget | null): boolean {
	if (!(el instanceof HTMLElement)) return false;
	if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
	if (!(el instanceof HTMLInputElement)) return false;
	return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(
		el.type,
	);
}

/**
 * Mirrors `visualViewport.height` into the `--app-h` custom property that
 * sizes the app shell (app.css), so the composer stays above the on-screen
 * keyboard on iOS Safari, where neither `100dvh` nor `interactive-widget`
 * shrink for the keyboard. Pinch zoom also shrinks the visual viewport, so
 * updates are skipped while zoomed. Without visualViewport the shell keeps its
 * `100dvh` fallback.
 *
 * It also sets `data-keyboard="open"` on the root while a text field has focus
 * on a coarse pointer and the viewport has shrunk by a keyboard's height since
 * the field was focused; chat.css collapses the status chrome (session bar,
 * activity bar, header) on it so the transcript and composer keep room.
 * Returns the uninstall function.
 */
export function trackViewportHeight(): () => void {
	const viewport = typeof window !== "undefined" ? window.visualViewport : null;
	if (!viewport) return () => {};
	const root = document.documentElement;
	const coarse = window.matchMedia?.("(pointer: coarse)");
	let editing = false;
	// Tallest viewport since a field took focus at this width: what "no keyboard" looks like.
	let baseline = viewport.height;
	let baselineWidth = viewport.width;
	const syncKeyboard = () => {
		if (viewport.width !== baselineWidth || !editing) {
			baseline = viewport.height;
			baselineWidth = viewport.width;
		}
		baseline = Math.max(baseline, viewport.height);
		const open = editing && coarse?.matches === true && keyboardShrank(baseline, viewport.height);
		if (open) root.dataset.keyboard = "open";
		else delete root.dataset.keyboard;
	};
	const update = () => {
		if (Math.abs(viewport.scale - 1) > 0.01) return;
		root.style.setProperty("--app-h", `${viewport.height}px`);
		syncKeyboard();
	};
	const onFocusIn = (e: FocusEvent) => {
		const next = isTextEntry(e.target);
		if (next && !editing) {
			baseline = viewport.height;
			baselineWidth = viewport.width;
		}
		editing = next;
		syncKeyboard();
	};
	const onFocusOut = (e: FocusEvent) => {
		editing = isTextEntry(e.relatedTarget);
		syncKeyboard();
	};
	update();
	viewport.addEventListener("resize", update);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", onFocusOut);
	return () => {
		viewport.removeEventListener("resize", update);
		document.removeEventListener("focusin", onFocusIn);
		document.removeEventListener("focusout", onFocusOut);
		root.style.removeProperty("--app-h");
		delete root.dataset.keyboard;
	};
}
