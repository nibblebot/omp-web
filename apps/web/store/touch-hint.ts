import { pushToast } from "./toasts";

/** How long a touch hint stays up; longer than a plain toast because it is read, not glanced at. */
const TOUCH_HINT_MS = 6_000;

/**
 * Touch has no tooltips, so an element that explains itself only through `title`
 * calls this from its click handler: on a `(hover: none)` device the text shows as a
 * toast. Fine pointers keep the native tooltip and nothing happens.
 */
export function showTouchHint(text: string | undefined): void {
	if (!text || typeof matchMedia !== "function" || !matchMedia("(hover: none)").matches) return;
	pushToast(text, { durationMs: TOUCH_HINT_MS });
}
