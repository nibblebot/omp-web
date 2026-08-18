import type { ClientCommand, SessionListEntry } from "../../shared/protocol";
import { setState, state } from "../state";
import { isConnected, postCommand } from "./transport";

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
