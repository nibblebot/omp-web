import type { DaemonStatus } from "../../shared/protocol";

/**
 * Roster-row session activity, derived from the roster entry's git facts and
 * the ATTACHED session's live signals, plus — for ready rows — the fleet
 * edge's per-daemon realtime activity (`daemon_activity` frames). Pure logic
 * — no JSX, no Solid — so the precedence table stays unit-testable.
 *
 * Only a READY daemon gets an activity chip: every other status keeps the
 * existing status-dot ladder and asleep shows nothing at all.
 *
 * WHY detached rows can now report live blocked/in-progress: the fleet edge
 * retains a connector stream to every ready daemon while at least one browser
 * is attached, derives `{streaming, blocked}` per daemon from the tapped
 * `state`/`ui_request`/`ui_request_end` frames, and broadcasts those as
 * additive fleet-scoped `daemon_activity` frames (`remote` here). This is the
 * accepted tradeoff: a retained stream counts as an attached client, so a
 * ready daemon's idle auto-exit is SUSPENDED while any browser is connected
 * (resuming via the connector idle-drop after the last browser disconnects) —
 * a deliberate, user-approved deviation from the old "never invent a
 * fleet-side frame / idle-drop" invariant. `remote` is undefined when the edge
 * predates this feature or the daemon's stream is down; such rows fall back to
 * the git-driven unreviewed / idle readings below.
 *
 * Precedence for a ready row, first match wins:
 *   1. attached && uiPending        → "blocked"     (extension-UI dialog open)
 *   2. attached && streaming        → "in_progress" (a turn is streaming)
 *   3. !attached && remote?.blocked → "blocked"     (edge: dialog open on that daemon)
 *   4. !attached && remote?.streaming → "in_progress" (edge: that daemon is mid-turn)
 *   5. !attached && unread          → "unread"      (its turn finished while unattended)
 *   6. attached ? unreviewed : git dirty → "unreviewed" (agent done, user hasn't reviewed)
 *   7. otherwise                    → "idle"
 *
 * Remote live truth beats the unread latch: a daemon streaming right now shows
 * the spinner even if previously marked unread; the light-blue dot appears
 * when it finishes (see the daemon_activity handler in src/state.ts — it marks
 * unread on the observed true→false flip for a detached daemon).
 *
 * The unreviewed reading differs by attach state: for the ATTACHED session the
 * live chat decides (an assistant item sits last — the turn finished and the
 * user has not sent anything after it); a DETACHED row has no live chat, so
 * probed git dirtiness (uncommitted changes) is the only durable "agent left
 * work behind" proxy. Rendering maps blocked → red dot, in_progress → spinning
 * green, unread → light blue, unreviewed → yellow dot, idle → nothing.
 */
export type SessionActivity = "in_progress" | "blocked" | "unread" | "unreviewed" | "idle";

export function sessionActivity(
	entry: {
		status: DaemonStatus;
		git?: { added: number; modified: number; deleted: number; untracked: number };
	},
	live: {
		attached: boolean;
		streaming: boolean;
		uiPending: boolean;
		unreviewed: boolean;
		unread: boolean;
		/** Per-daemon realtime activity broadcast by the fleet edge
		 *  (`daemon_activity` frames). Undefined for old edges that never send
		 *  them, for a daemon whose stream is down, and for the attached row
		 *  (its own live signals win). */
		remote?: { streaming: boolean; blocked: boolean };
	},
): SessionActivity | null {
	if (entry.status !== "ready") return null;
	// Attached row: the live client signals are the truth — remote is ignored.
	if (live.attached && live.uiPending) return "blocked";
	if (live.attached && live.streaming) return "in_progress";
	// Detached row: fall back to the edge's realtime per-daemon reading
	// (undefined for old edges / a down stream — then git/unread rules hold).
	// Remote blocked is checked before remote streaming so a daemon with an
	// open dialog reads "blocked" even mid-turn.
	if (!live.attached && live.remote?.blocked) return "blocked";
	if (!live.attached && live.remote?.streaming) return "in_progress";
	// Unread is detached-only and secondary to the live readings above: the
	// flag is cleared on attach, and a daemon streaming right now shows the
	// spinner (the blue dot appears only once it finishes).
	if (!live.attached && live.unread) return "unread";
	const gitDirty =
		entry.git !== undefined &&
		entry.git.added + entry.git.modified + entry.git.deleted + entry.git.untracked > 0;
	if (live.attached ? live.unreviewed : gitDirty) return "unreviewed";
	return "idle";
}
