import type { SessionSummary } from "../api";

/** Facts the session list has gathered about the current sessions request. */
export interface MissingFileSnapshot {
	/** Deep-linked route file (`#/s/<file>`), or null when on the list view. */
	selectedFile: string | null;
	/** Sessions returned by the latest (unfiltered) request, if it landed. */
	sessions: SessionSummary[];
	/** True while the sessions request is in flight (no verdict yet). */
	loading: boolean;
	/** True when the sessions request failed (the detail pane shows its own error). */
	errored: boolean;
	/** True when the response was truncated (absence of the file proves nothing). */
	truncated: boolean;
	/** True when a search query narrows the list (absence of the file proves nothing). */
	hasQuery: boolean;
}

/**
 * Decide whether a deep-linked selected session file is missing and the
 * route should fall back to the (empty) list view.
 *
 * Never fires while the sessions resource is loading or errored (the detail
 * pane's own error UI covers genuine fetch failures), nor while a search
 * query narrows the list. With a settled, untruncated, unfiltered response
 * the verdict is: fall back when the file is present-but-deleted
 * (`onDisk === false`) or when it is absent entirely; an absent file under a
 * truncated response proves nothing, so it never falls back there.
 */
export function shouldFallbackMissingFile(snapshot: MissingFileSnapshot): boolean {
	const { selectedFile, sessions, loading, errored, truncated, hasQuery } = snapshot;
	if (selectedFile === null || loading || errored || truncated || hasQuery) return false;
	const hit = sessions.find((s) => s.file === selectedFile);
	if (hit !== undefined) return !hit.onDisk;
	return true;
}
