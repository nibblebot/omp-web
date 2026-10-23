import type { DaemonEntry } from "#lib/wire/protocol";
import { state } from "../state";
import { sessionActivity, type SessionActivity } from "./session-activity";
import { unreadIds } from "./unread";

/**
 * Session activity of one roster entry, read from the live store: the
 * attached session's own signals (streaming, pending extension dialog,
 * unviewed answer), the edge's per-daemon realtime activity and the
 * client-side unread set. Shared by the workspace rows and the collapsed
 * project summary so both always agree. Null unless the entry is ready
 * (see `sessionActivity`).
 *
 * Reactive: call it inside a memo or JSX expression; every signal and store
 * field it reads is per-daemon (`state.daemonActivity[daemonId]`,
 * `unreadIds().has(daemonId)`), so a roster broadcast or an unrelated
 * daemon's activity does not refire it.
 */
export function rowActivity(
	daemon: Pick<DaemonEntry, "daemonId" | "status">,
): SessionActivity | null {
	return sessionActivity(daemon, {
		attached: daemon.daemonId === state.currentSessionId,
		streaming: state.streaming,
		uiPending: state.uiRequest !== null,
		unreviewed: state.answerUnviewed,
		unread: unreadIds().has(daemon.daemonId),
		// Undefined for the attached row and any daemon with no reading yet.
		remote: state.daemonActivity[daemon.daemonId],
	});
}
