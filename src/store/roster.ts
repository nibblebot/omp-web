import type { ClientCommand, SessionListEntry } from "../../shared/protocol";
import { setState, state } from "../state";
import {
	attachSession,
	call,
	isConnected,
	isSessionSwitchSupersession,
	postCommand,
} from "./transport";

/**
 * Fleet-roster domain (Phase 3 store facade split): session/file listing
 * (latest-wins pulls answered by unicast frames) and the persisted roster
 * sidebar visibility toggle. The roster mirror itself
 * (daemonsByProject, roster frame handling, daemon status announcements)
 * stays in state.ts alongside the mux.
 */

/** localStorage key for the roster sidebar visibility toggle. */
const SIDEBAR_KEY = "omp.sidebarVisible";

// list_sessions / list_files carry no id on the wire; with a single user,
// latest-wins correlation is sufficient (a superseded request resolves empty.
let pendingSessions: ((sessions: SessionListEntry[]) => void) | null = null;
let pendingFiles: ((files: string[]) => void) | null = null;

/** Settle the latest-wins list_sessions waiter (mux "sessions" frame). */
export function settleSessions(sessions: SessionListEntry[]): void {
	pendingSessions?.(sessions);
	pendingSessions = null;
}

/** Settle the latest-wins list_files waiter (mux "files" frame). */
export function settleFiles(files: string[]): void {
	pendingFiles?.(files);
	pendingFiles = null;
}

/** Resolve both waiters empty (stream teardown in state.ts). */
export function resetPendingSessionsFiles(): void {
	pendingSessions?.([]);
	pendingSessions = null;
	pendingFiles?.([]);
	pendingFiles = null;
	for (const resolve of pendingDaemonSessions.values()) resolve([]);
	pendingDaemonSessions.clear();
}

/**
 * Per-daemon latest-wins waiters for the roster dropdown's
 * list_daemon_sessions (answer: unicast `daemon_sessions` frame). Keyed by
 * daemonId so N open dropdowns never clobber each other; a superseded
 * request resolves empty.
 */
const pendingDaemonSessions = new Map<string, (sessions: SessionListEntry[]) => void>();

/** Settle the per-daemon list_daemon_sessions waiter (mux "daemon_sessions" frame). */
export function settleDaemonSessions(daemonId: string, sessions: SessionListEntry[]): void {
	const resolve = pendingDaemonSessions.get(daemonId);
	if (resolve !== undefined) {
		pendingDaemonSessions.delete(daemonId);
		resolve(sessions);
	}
}

/** Fetch a daemon's last sessions for its roster dropdown (newest-first). */
export function requestDaemonSessions(daemonId: string): Promise<SessionListEntry[]> {
	const { promise, resolve } = Promise.withResolvers<SessionListEntry[]>();
	if (!isConnected()) {
		resolve([]);
		return promise;
	}
	pendingDaemonSessions.get(daemonId)?.([]); // supersede an older request
	pendingDaemonSessions.set(daemonId, resolve);
	postCommand({ type: "list_daemon_sessions", id: crypto.randomUUID(), daemonId }).catch(() => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingDaemonSessions.get(daemonId) === resolve) {
			pendingDaemonSessions.delete(daemonId);
			resolve([]);
		}
	});
	return promise;
}

/**
 * Resume a specific session of a daemon from the roster dropdown.
 *
 * Asleep daemons wake with spawn_resume carrying the chosen session file
 * (the edge validates it belongs to the worktree) and then attach. Ready
 * daemons attach (when not already attached) and switch to the session if
 * it is not the one currently live. Resolves when the attach settles / the
 * command is issued, so the caller can end its waking pulse. NEVER surfaces
 * a "session switched" supersession as an error — see switchSessionRetry.
 */
export function resumeDaemonSession(daemonId: string, sessionFile: string): Promise<void> {
	const back = state.daemonRoster.find((d) => d.daemonId === daemonId);
	const currentFile =
		state.currentSessionId === daemonId ? state.sessionFile : back?.lastSessionFile;
	if (back?.status === "asleep") {
		// Wake then attach (mirrors the old asleep-row click): the edge wakes
		// first and answers the attach once the session is ready.
		postCommand({ type: "spawn_resume", id: crypto.randomUUID(), daemonId, sessionFile }).catch(
			() => {},
		);
		if (state.currentSessionId === daemonId) return Promise.resolve();
		return attachSession(daemonId).then(
			() => undefined,
			(err) => {
				setState("error", String(err));
			},
		);
	}
	// Ready daemon. Attach FIRST when not already attached — a switchSession
	// dispatched before the attach settles routes to the wrong/no daemon and
	// is swept by the attach's "session switched" supersession. The switch
	// only ever runs once the current daemon is (or is already) attached.
	const attach =
		state.currentSessionId === daemonId
			? Promise.resolve()
			: attachSession(daemonId).then(
					() => undefined,
					(err) => {
						setState("error", String(err));
					},
				);
	// Picking the live file on a ready daemon is a pure attach (no switch).
	if (sessionFile === currentFile) return attach;
	return attach.then(() => switchSessionRetry(daemonId, sessionFile));
}

/**
 * Switch to `sessionFile`, retrying once when the attach's own supersession
 * swept the first call. The rejection means the daemon JUST became attached
 * (our own pick), so the retry posts to the now-current session and settles
 * cleanly. A superseded switch is never an error banner.
 */
function switchSessionRetry(daemonId: string, sessionFile: string): Promise<void> {
	return call("switchSession", [sessionFile])
		.then(() => undefined)
		.catch((err: unknown) => {
			if (!isSessionSwitchSupersession(err)) {
				setState("error", String(err));
				return undefined;
			}
			// The switch was swept by a session switch. Retry only while THIS
			// daemon is still the attached session (the rejection means it just
			// became attached — our own pick); a superseded resume is dropped
			// silently, never applied to a different daemon.
			if (state.currentSessionId !== daemonId) return undefined;
			return call("switchSession", [sessionFile]).then(
				() => undefined,
				(err2: unknown) => setState("error", String(err2)),
			);
		});
}

export function listSessions(): Promise<SessionListEntry[]> {
	const { promise, resolve, reject } = Promise.withResolvers<SessionListEntry[]>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingSessions?.([]);
	pendingSessions = resolve;
	postCommand({ type: "list_sessions", id: crypto.randomUUID() } satisfies ClientCommand).catch(
		(err) => {
			// Latest-wins: only clear the slot if a newer request hasn't claimed it.
			if (pendingSessions === resolve) pendingSessions = null;
			reject(err instanceof Error ? err : new Error(String(err)));
		},
	);
	return promise;
}

export function listFiles(query: string, limit?: number): Promise<string[]> {
	const { promise, resolve, reject } = Promise.withResolvers<string[]>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingFiles?.([]);
	pendingFiles = resolve;
	postCommand({
		type: "list_files",
		id: crypto.randomUUID(),
		query,
		limit,
	} satisfies ClientCommand).catch((err) => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingFiles === resolve) pendingFiles = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Persisted roster-sidebar visibility (status-bar ☰ + sidebar ×). */
export function setSidebarVisible(visible: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(SIDEBAR_KEY, String(visible));
	setState("sidebarVisible", visible);
}

export function toggleSidebar(): void {
	setSidebarVisible(!state.sidebarVisible);
}
