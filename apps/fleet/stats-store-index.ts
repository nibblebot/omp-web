/**
 * Fleet log-store coverage for /ctl/stats. Everything here is a pure
 * disk read over FleetLogStore: never a daemon, the SDK, or compute.
 *
 * Rows joined by STABLE SESSION IDENTITY (the store sessionId ↔ a
 * fleet-local session header id). Main-streamed sessions that survive on
 * disk are counted once; the local row carries the `stored` annotation
 * rather than duplicating. Store-only sessions (deleted/stopped workspaces,
 * compute absent) surface as origin "fleet-store" rows whose `file` is a
 * display key only; their bytes are served by /ctl/stored, never by
 * /ctl/stats. Unstreamed remote history is simply absent: no row, no
 * completeness claim.
 *
 * Layering: imports only ./log-store, ./session-head, node builtins.
 * Never server/ or src/.
 */
import type { FleetLogStore, StoredSessionInfo } from "./log-store";
import { statSync } from "node:fs";
import { parseSessionHead, SESSION_HEAD_BYTES } from "./session-head";
import type { SessionHead } from "./session-head";

/** One stored main file's head facts, read from the stored bytes. */
export interface StoredHead extends SessionHead {
	/** Full stored file size, not the parsed prefix. */
	bytes: number;
}

/** Read the stored main file's head (title, cwd, id, first/last timestamps). */
export function readStoredHead(
	store: FleetLogStore,
	wsId: string,
	sessionId: string,
	relpath: string,
): StoredHead | null {
	const prefix = store.readStoredPrefix(wsId, sessionId, relpath, SESSION_HEAD_BYTES);
	const file = store.storedFilePath(wsId, sessionId, relpath);
	if (prefix === null || file === null) return null;
	try {
		return { ...parseSessionHead(prefix.toString("utf8")), bytes: statSync(file).size };
	} catch {
		return null;
	}
}

/** Session, workspace, and byte totals of the loaded store (O(1), no disk). */
export function storeCoverage(
	store: FleetLogStore | null,
): { workspaces: number; sessions: number; bytes: number } | null {
	if (store === null) return null;
	return store.coverage();
}

/** File key for a store-only summary row (display only, never a stats :file). */
export function storeFileKey(session: StoredSessionInfo, mainRelpath: string | undefined): string {
	return mainRelpath === undefined
		? `${session.workspaceId}/${session.sessionId}`
		: `${session.workspaceId}/${session.sessionId}/${mainRelpath}`;
}
