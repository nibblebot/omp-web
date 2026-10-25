import type { RosterEntry } from "#lib/wire/protocol";
import { state } from "../state";
import { sessionActivity, type SessionActivity } from "./session-activity";
import { unreadIds } from "./unread";

/**
 * Session activity of one roster entry, read from the live store: the
 * attached session's own signals (streaming, pending extension dialog,
 * unviewed answer), the edge's per-session realtime activity and the
 * client-side unread set. Shared by the workspace rows and the collapsed
 * project summary so both always agree. Null unless the entry is ready
 * (see `sessionActivity`).
 *
 * Reactive: call it inside a memo or JSX expression; every signal and store
 * field it reads is per-session (`state.sessionActivity[workspaceId]`,
 * `unreadIds().has(workspaceId)`), so a roster broadcast or an unrelated
 * session's activity does not refire it.
 */
export function rowActivity(
	session: Pick<RosterEntry, "workspaceId" | "status">,
): SessionActivity | null {
	return sessionActivity(session, {
		attached: session.workspaceId === state.currentWorkspaceId,
		streaming: state.streaming,
		uiPending: state.uiRequest !== null,
		unreviewed: state.answerUnviewed,
		unread: unreadIds().has(session.workspaceId),
		// Undefined for the attached row and any session with no reading yet.
		remote: state.sessionActivity[session.workspaceId],
	});
}
