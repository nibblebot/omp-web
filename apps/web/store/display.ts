import { saveDisplayPref, type DisplayPrefName, type DisplayPrefs } from "../prefs/display";
import { setState, state } from "../state";

/**
 * Display preferences and the Appearance popover's open state. The values are
 * `state.display` (loaded from localStorage at startup, see prefs/display.ts);
 * `setDisplayPref` is their only writer: it applies the value to the store and
 * persists it.
 */

/**
 * Mirror the preferences that styles key on onto the root element: `data-width`
 * (tokens.css picks the chat column cap from it, like `data-theme`). Called at
 * startup and by `setDisplayPref`; a no-op without a document.
 */
export function applyDisplayAttributes(): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.width = state.display.width;
}

/** Apply and persist one display preference. */
export function setDisplayPref<N extends DisplayPrefName>(name: N, value: DisplayPrefs[N]): void {
	saveDisplayPref(name, value);
	setState("display", name, value);
	applyDisplayAttributes();
}

/**
 * The Appearance popover is owned by the header's Appearance button (like the
 * New workspace popover and its "+"): MainHeader mounts it from this flag, so
 * the palette and settings search open it without holding the button.
 */
export function openAppearance(): void {
	setState("appearanceOpen", true);
}

export function closeAppearance(): void {
	setState("appearanceOpen", false);
}
