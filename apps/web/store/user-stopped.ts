import { createSignal } from "solid-js";

/**
 * Daemon ids the user stopped on purpose (sidebar Stop, header restart flow).
 * A user stop keeps the attached chat column and its transcript behind a
 * "stopped" strip; a crash or a roster removal is NOT in this set and still
 * clears the session view. Cleared when the daemon is woken again.
 */
const [stopped, setStopped] = createSignal<ReadonlySet<string>>(new Set());

/** Reactive: true while the user's stop of this daemon has not been undone. */
export function isUserStopped(daemonId: string): boolean {
	return stopped().has(daemonId);
}

export function markUserStopped(daemonId: string): void {
	if (stopped().has(daemonId)) return;
	setStopped((prev) => new Set(prev).add(daemonId));
}

export function clearUserStopped(daemonId: string): void {
	if (!stopped().has(daemonId)) return;
	setStopped((prev) => {
		const next = new Set(prev);
		next.delete(daemonId);
		return next;
	});
}
