import { createSignal } from "solid-js";
import { enterSendsMessage, primaryPointerIsCoarse } from "./key-input";
import { state } from "../state";

/** Tracks the primary pointer type: a tablet gaining or losing a mouse flips Enter's `auto` meaning. */
const [coarsePointer, setCoarsePointer] = createSignal(primaryPointerIsCoarse());
if (typeof matchMedia === "function") {
	matchMedia("(pointer: coarse)").addEventListener?.("change", (e) => setCoarsePointer(e.matches));
}

export { coarsePointer };

/** Whether a plain Enter sends in the composers: the Enter key preference against the pointer type. Reactive. */
export function enterSends(): boolean {
	return enterSendsMessage(state.display.enterKey, coarsePointer());
}
