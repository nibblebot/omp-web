import { createSignal } from "solid-js";

// Fleet-scoped set of workspaceIds whose in-progress turn's END was never
// viewed: a detached session's `session_activity` flip true→false marks it,
// cleared when the row is clicked (attached), and pruned when a session
// leaves the roster. It is purely CLIENT-side: the fleet edge derives the
// per-session streaming flag from that session's tapped stream and broadcasts
// it, so this set is the latch for "ended while you were looking away",
// never fleet state. Session-only (no localStorage): like the other activity
// dots, it is ephemeral UI state that must not survive a reload.
const [unreadIds, setUnreadIds] = createSignal<ReadonlySet<string>>(new Set());

/** Add an id (no-op when already present). */
function markUnread(workspaceId: string): void {
	if (unreadIds().has(workspaceId)) return;
	setUnreadIds(new Set(unreadIds()).add(workspaceId));
}

/** Remove an id (no-op when absent). */
function clearUnread(workspaceId: string): void {
	if (!unreadIds().has(workspaceId)) return;
	const next = new Set(unreadIds());
	next.delete(workspaceId);
	setUnreadIds(next);
}

/** Drop stored ids not present in `ids`; no-op when nothing changes. */
function pruneUnread(ids: ReadonlySet<string>): void {
	const kept = new Set([...unreadIds()].filter((id) => ids.has(id)));
	const before = unreadIds();
	if (kept.size === before.size && [...kept].every((id) => before.has(id))) return;
	setUnreadIds(kept);
}

export { clearUnread, markUnread, pruneUnread, unreadIds };
