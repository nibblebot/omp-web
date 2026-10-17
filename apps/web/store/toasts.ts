import { setState } from "../state";
import { isSessionSwitchSupersession } from "./transport";

/**
 * Fleet/app-scoped ephemeral toast notifications (worktree_removed on-disk
 * eviction toasts). Dependency-light like btw.ts: the store array and two
 * actions, nothing else. Mutations go through setState only; components
 * render state.toasts reactively and never hold toast data themselves.
 */
const TOAST_CAP = 5;

/** Auto-dismiss delay; exported so the controllable-clock test can pin it. */
export const TOAST_DISMISS_MS = 6_000;

let nextToastId = 1;

/** Optional inline action rendered as a button in the toast; clicking runs
 *  it and dismisses the toast. */
export interface ToastAction {
	label: string;
	run: () => void;
}

export interface ToastOptions {
	action?: ToastAction;
	/** Auto-dismiss delay override (default TOAST_DISMISS_MS). */
	durationMs?: number;
}

/** Append a notification to the toast stack (newest last), dropping the
 *  oldest once the list would exceed TOAST_CAP. Auto-dismisses after
 *  TOAST_DISMISS_MS (or `durationMs`); the timer removes only its own id, so a
 *  stale timer firing after a manual dismiss (or a cap-drop) is a no-op.
 *  Returns the toast id. */
export function pushToast(text: string, opts: ToastOptions = {}): number {
	const id = nextToastId++;
	setState("toasts", (prev) =>
		[...prev, { id, text, ...(opts.action ? { action: opts.action } : {}) }].slice(-TOAST_CAP),
	);
	window.setTimeout(() => dismissToast(id), opts.durationMs ?? TOAST_DISMISS_MS);
	return id;
}

/** Remove one toast by id (click-to-dismiss). */
export function dismissToast(id: number): void {
	setState("toasts", (prev) => prev.filter((toast) => toast.id !== id));
}

/** Surface a failed store action on the global error banner, as its message
 *  text (never an "Error: " prefix). A session switch supersedes in-flight
 *  calls by design (state.ts rejects them with "session switched"); that is
 *  control flow, never a user-facing error, so it is dropped. */
export function reportError(err: unknown): void {
	if (isSessionSwitchSupersession(err)) return;
	setState("error", err instanceof Error ? err.message : String(err));
}
