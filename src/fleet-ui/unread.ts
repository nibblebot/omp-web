import { createSignal } from "solid-js";

// Fleet-scoped set of daemonIds whose in-progress turn's END was never
// viewed: a session marked unread when the user switches away MID-STREAM,
// cleared when the row is clicked (attached), and pruned when a daemon
// leaves the roster. It is purely CLIENT-side because the fleet edge exposes
// live streaming only for the ATTACHED daemon — the abandoned session's turn
// may keep running on its daemon, but this tab never receives the deltas that
// would mark it done, so only the switch-away-mid-stream moment is observable
// here. The fleet itself holds zero agent state and, per the AGENTS.md
// invariant, emits no fleet-side activity frame for us to hook. Session-only
// (no localStorage): like the other activity dots, it is ephemeral UI state
// that must not survive a reload.
const [unreadIds, setUnreadIds] = createSignal<ReadonlySet<string>>(new Set());

/** Add an id (no-op when already present). */
function markUnread(daemonId: string): void {
	if (unreadIds().has(daemonId)) return;
	setUnreadIds(new Set(unreadIds()).add(daemonId));
}

/** Remove an id (no-op when absent). */
function clearUnread(daemonId: string): void {
	if (!unreadIds().has(daemonId)) return;
	const next = new Set(unreadIds());
	next.delete(daemonId);
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
