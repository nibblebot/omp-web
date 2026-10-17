/**
 * The right-hand dock (U18): which panel is open and how wide. The panel kinds
 * are registered by components/app/DockHost.tsx; this module only owns state.
 * `state.dock` is mirrored into the URL by store/deep-link.ts.
 */
import { clampDockWidth, persistDockWidth } from "../prefs/dock";
import { setState, state } from "../state";

/** Open a dock panel, or retarget it. A no-op when it is already open on that panel. */
export function openDock(kind: string, id?: string): void {
	const current = state.dock;
	if (current !== null && current.kind === kind && current.id === id) return;
	setState("dock", id === undefined ? { kind } : { kind, id });
}

export function closeDock(): void {
	if (state.dock !== null) setState("dock", null);
}

/** Set and persist the dock width (clamped to the allowed range). */
export function setDockWidth(px: number): void {
	const width = clampDockWidth(px);
	setState("dockWidth", width);
	persistDockWidth(width);
}

/** Alt+A opens the agents dock. Exact "a" key only: Option+A on mac types "å". */
export function isAgentsShortcut(
	e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
	return e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "a";
}
