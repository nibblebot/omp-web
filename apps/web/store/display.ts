import { saveDisplayPref, type DisplayPrefName, type DisplayPrefs } from "../prefs/display";
import { setState, state } from "../state";

/**
 * Display preferences and opening the Appearance sheet. The values are
 * `state.display` (loaded from localStorage at startup, see prefs/display.ts);
 * `setDisplayPref` is their only writer: it applies the value to the store and
 * persists it.
 */

/**
 * Mirror the preferences that styles key on onto the root element: `data-width`
 * (tokens.css picks the chat column cap from it, like `data-scheme`). Called at
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
 * Open the Appearance sheet (`state.modal`, ModalHost mounts it), from the
 * header's Appearance button, the palette and settings search. It replaces any
 * open modal, Settings included; closing goes through ModalHost.
 */
export function openAppearance(): void {
	setState("modal", "appearance");
}
