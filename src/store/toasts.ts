import { setState } from "../state";

/**
 * Fleet/app-scoped ephemeral toast notifications (worktree_removed on-disk
 * eviction toasts). Dependency-light like btw.ts: the store array and two
 * actions, nothing else. Mutations go through setState only — components
 * render state.toasts reactively and never hold toast data themselves.
 */
const TOAST_CAP = 5;

/** Auto-dismiss delay; exported so the controllable-clock test can pin it. */
export const TOAST_DISMISS_MS = 6_000;

let nextToastId = 1;

/** Append a notification to the toast stack (newest last), dropping the
 *  oldest once the list would exceed TOAST_CAP. Auto-dismisses after
 *  TOAST_DISMISS_MS; the timer removes only its own id, so a stale timer
 *  firing after a manual dismiss (or a cap-drop) is a no-op. */
export function pushToast(text: string): void {
	const id = nextToastId++;
	setState("toasts", (prev) => [...prev, { id, text }].slice(-TOAST_CAP));
	window.setTimeout(() => dismissToast(id), TOAST_DISMISS_MS);
}

/** Remove one toast by id (click-to-dismiss). */
export function dismissToast(id: number): void {
	setState("toasts", (prev) => prev.filter((toast) => toast.id !== id));
}
