import { createSignal } from "solid-js";
import { state } from "../state";
import { closeDrawers, resumeSession } from "./roster";

/**
 * Worktree session list domain: the roster row's waking pulse and the resume
 * path used by the dialog (components/fleet/sidebar).
 */

/** WorkspaceIds with a wake-attach in flight (asleep-row click or resume → attach
 *  settles). Module-level so it survives a row unmounting mid-wake (the row
 *  leaving the roster, or a reconnect resetting the sidebar); per-row
 *  component signals would not survive that. */
export const [activatingIds, setActivatingIds] = createSignal<ReadonlySet<string>>(new Set());

/** Mark a row as waking until its wake/attach/new-session settles. */
export function beginActivating(id: string): void {
	setActivatingIds((prev) => new Set(prev).add(id));
}

/** Clear a row's activating mark once its wake/attach/new-session settles. */
export function endActivating(id: string): void {
	setActivatingIds((prev) => {
		const next = new Set(prev);
		next.delete(id);
		return next;
	});
}

/**
 * Resume one session of a worktree: asleep rows wake with spawn_resume
 * carrying the file, ready rows attach (if not already) and switchSession to
 * it. An asleep row pulses until the attach settles (mirrors the row-click
 * wake), and the sidebar drawers close so the transcript is visible. The
 * caller closes its own surface.
 */
export function resumeWorktreeSession(workspaceId: string, sessionFile: string): void {
	const wasAsleep =
		state.sessionRoster.find((d) => d.workspaceId === workspaceId)?.status === "asleep";
	if (wasAsleep) beginActivating(workspaceId);
	const pending = resumeSession(workspaceId, sessionFile);
	closeDrawers();
	if (wasAsleep) {
		Promise.resolve(pending)
			.catch(() => {})
			.finally(() => endActivating(workspaceId));
	}
}
