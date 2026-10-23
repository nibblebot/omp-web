import type { DaemonStatus } from "#lib/wire/protocol";

/**
 * Roster-row session activity, derived from the ATTACHED session's live
 * signals plus, for ready rows, the fleet edge's per-daemon realtime
 * activity (`daemon_activity` frames). Pure logic, no JSX, no Solid, so
 * the precedence table stays unit-testable.
 *
 * Only a READY daemon gets an activity dot: every other status keeps the
 * existing status-dot ladder and asleep shows nothing at all.
 *
 * WHY detached rows can report live blocked/in-progress: every paired daemon
 * mirrors the frames it emits (`state`/`ui_request`/`ui_request_end`) on its
 * callback control stream; the fleet derives `{streaming, blocked}` per daemon
 * from those and broadcasts them as additive fleet-scoped `daemon_activity`
 * frames (`remote` here), whichever session a browser has open. A browser
 * attached to a session keeps that daemon alive (idle exit is suppressed); a
 * browser connected to the fleet but attached elsewhere does not. `remote` is
 * undefined when the edge predates this feature or the daemon is not paired;
 * such rows simply read idle when not unread.
 *
 * Git dirtiness is deliberately NOT part of this indicator: uncommitted
 * changes surface separately as the row's diffstat chips.
 *
 * "unreviewed" is ATTACHED-only and view-gated: set when a turn ends while
 * the transcript is scrolled away from the live edge (`chatPinned` false →
 * `answerUnviewed` true in apps/web/store/chat.ts), cleared when the user
 * scrolls back to the bottom, sends a prompt, or switches session. An
 * attached session being viewed is never unreviewed; a detached row has no
 * live chat and never reports it. (Earlier versions derived it from the
 * last chat item, never cleared by reading, and from detached git
 * dirtiness; both removed.)
 *
 * Precedence for a ready row, first match wins:
 *   1. attached && uiPending          → "blocked"     (extension-UI dialog open)
 *   2. attached && streaming          → "in_progress" (a turn is streaming)
 *   3. attached && unreviewed         → "unreviewed"  (answer finished below the viewport)
 *   4. !attached && remote?.blocked   → "blocked"     (edge: dialog open on that daemon)
 *   5. !attached && remote?.streaming → "in_progress" (edge: that daemon is mid-turn)
 *   6. !attached && unread            → "unread"      (its turn finished while unattended)
 *   7. otherwise                      → "idle"
 *
 * Remote live truth beats the unread latch: a daemon streaming right now
 * shows the spinner even if previously marked unread; the light-blue dot
 * appears when it finishes (see the daemon_activity handler in apps/web/state.ts,
 * which marks unread on the observed true→false flip for a detached daemon).
 *
 * Rendering maps blocked → red dot, in_progress → spinning green comet ring,
 * unreviewed → yellow dot, unread → light blue, idle → nothing.
 */
export type SessionActivity = "in_progress" | "blocked" | "unread" | "unreviewed" | "idle";

export function sessionActivity(
	entry: { status: DaemonStatus },
	live: {
		attached: boolean;
		streaming: boolean;
		uiPending: boolean;
		/** Turn ended with the latest answer below the viewport (attached
		 *  session only; mirrors state.answerUnviewed, cleared on re-pin/prompt/switch). */
		unreviewed: boolean;
		unread: boolean;
		/** Per-daemon realtime activity broadcast by the fleet edge
		 *  (`daemon_activity` frames). Undefined for a daemon whose stream is
		 *  down or whose activity is not known yet, and for the attached row
		 *  (its own live signals win). */
		remote?: { streaming: boolean; blocked: boolean };
	},
): SessionActivity | null {
	if (entry.status !== "ready") return null;
	// Attached row: the live client signals are the truth; remote is ignored.
	if (live.attached && live.uiPending) return "blocked";
	if (live.attached && live.streaming) return "in_progress";
	// Attached and idle: the finished answer sits below the viewport (the
	// user is scrolled up), yellow until they scroll to the live edge.
	if (live.attached && live.unreviewed) return "unreviewed";
	// Detached row: fall back to the edge's realtime per-daemon reading
	// (undefined while the stream is down or activity is unknown; then only
	// the unread latch below can paint a dot). Remote blocked is checked
	// before remote streaming so a daemon with an open dialog reads "blocked"
	// even mid-turn.
	if (!live.attached && live.remote?.blocked) return "blocked";
	if (!live.attached && live.remote?.streaming) return "in_progress";
	// Unread is detached-only and secondary to the live readings above: the
	// flag is cleared on attach, and a daemon streaming right now shows the
	// spinner (the blue dot appears only once it finishes).
	if (!live.attached && live.unread) return "unread";
	return "idle";
}
