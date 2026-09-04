import type { SessionSummary } from "../api";

/**
 * Partition a server-returned session list (already most-recent-first) into
 * project groups. Group key: `cwd ?? folder`; header label: `folder`.
 *
 * Sessions keep the server's per-session order inside their group, so each
 * group stays recent-first. Groups are ordered by their most-recent member:
 * the group whose newest session sits earliest in the server list comes
 * first, so the visible ordering is a stable partition of the input.
 *
 * The header is rendered for every group (uniform look), including the
 * single-group case. Because a group can only ever be absent when `sessions`
 * is empty, the "no sessions" empty state is the caller's concern, not this
 * helper's.
 */
export function groupSessionsByProject(
	sessions: SessionSummary[],
): { key: string; label: string; sessions: SessionSummary[] }[] {
	const byKey = new Map<string, { key: string; label: string; sessions: SessionSummary[] }>();
	// Insertion order preserves first-appearance position: the group of the
	// first (most-recent) session leads, later groups follow in their own
	// most-recent-member order.
	for (const s of sessions) {
		const key = s.cwd ?? s.folder;
		let group = byKey.get(key);
		if (group === undefined) {
			// Key falls back to folder, so it is never empty when present;
			// the label keeps the folder (lossy display name) either way.
			group = { key, label: s.folder, sessions: [] };
			byKey.set(key, group);
		}
		group.sessions.push(s);
	}
	return [...byKey.values()];
}
