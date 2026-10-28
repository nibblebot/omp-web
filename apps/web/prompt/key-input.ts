import type { EnterKeyPref } from "../prefs/display";

/**
 * Keyboard helpers shared by every text field that submits or navigates on a
 * key: the IME guard and the composer's Enter-key resolution. Pure, so the
 * browser-dependent inputs (pointer type, preference) are arguments.
 */

/** The slice of a keydown the IME guard reads. */
export interface ImeKeyEvent {
	readonly isComposing: boolean;
	readonly keyCode: number;
}

/**
 * Whether a keydown belongs to an active IME composition and must not trigger
 * the field's own key action (submit, accept, navigate, dismiss). Enter, Tab,
 * arrows and Escape during composition confirm, pick or cancel candidates in
 * the IME. Android keyboards (Gboard) report keyCode 229 with
 * `key: "Unidentified"` while composing, so `isComposing` alone is not enough.
 */
export function isImeKey(e: ImeKeyEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

/** Whether the primary pointer is coarse (a finger on a phone or tablet), i.e. a soft keyboard is the likely input. */
export function primaryPointerIsCoarse(): boolean {
	return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * Whether a plain Enter sends the message. `auto` follows the pointer: a
 * soft keyboard has no Shift+Enter, so Enter inserts a newline there and the
 * Send button sends; with a fine pointer Enter sends (Shift+Enter is the newline).
 */
export function enterSendsMessage(pref: EnterKeyPref, coarsePointer: boolean): boolean {
	return pref === "send" || (pref === "auto" && !coarsePointer);
}

/** What one Enter keydown does in the composer. */
export type EnterAction = "send" | "followup" | "newline";

/** The modifier state of an Enter keydown. */
export interface EnterModifiers {
	readonly shiftKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
}

/**
 * Resolve an Enter keydown. Ctrl/Cmd+Enter always submits (as a follow-up while
 * the agent streams), whatever the preference, so hardware keyboards keep it;
 * Shift+Enter is always a newline; a plain Enter follows `sendsOnEnter`.
 */
export function resolveEnterAction(mods: EnterModifiers, sendsOnEnter: boolean): EnterAction {
	if (mods.ctrlKey || mods.metaKey) return "followup";
	if (mods.shiftKey) return "newline";
	return sendsOnEnter ? "send" : "newline";
}

/** The `enterkeyhint` the soft keyboard shows for the Enter key. */
export function enterKeyHint(sendsOnEnter: boolean): "send" | "enter" {
	return sendsOnEnter ? "send" : "enter";
}
