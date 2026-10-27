import type { RosterEntry } from "#lib/wire/protocol";
import { displayTitle } from "../components/ui/title-icons";

// ---------------------------------------------------------------------------
// The session title a roster row (sidebar, command palette) shows for a
// checkout's last session. A real title wins; without one the row says what
// kind of nothing it is: a session with no messages yet, or one with messages
// but no title.
// ---------------------------------------------------------------------------

/** What a row shows for its last session. `placeholder` marks the two stand-in
 *  strings, so the sidebar can mute them and title-first layouts do not treat
 *  them as a real title. */
export type RowTitle = { text: string; placeholder: boolean };

/** Stand-in for a session without messages (or without a session file at all). */
export const NEW_SESSION_TITLE = "New session";
/** Stand-in for a session that has messages but no title yet. */
export const UNTITLED_SESSION_TITLE = "Untitled session";

/**
 * The title text for a roster entry: its real `sessionTitle` (as the web shows
 * titles, honoring `title.icons`); else "New session" when there is no
 * `lastSessionFile` or the session is flagged empty; else "Untitled session".
 */
export function rowTitle(
	entry: Pick<RosterEntry, "sessionTitle" | "sessionEmpty" | "lastSessionFile">,
): RowTitle {
	const title = displayTitle(entry.sessionTitle)?.trim();
	if (title) return { text: title, placeholder: false };
	if (entry.lastSessionFile === undefined || entry.sessionEmpty === true)
		return { text: NEW_SESSION_TITLE, placeholder: true };
	return { text: UNTITLED_SESSION_TITLE, placeholder: true };
}
