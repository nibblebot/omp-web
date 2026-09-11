import type { ClientCommand, SessionListEntry } from "../../shared/protocol";
import { awaitAttachPrime, sessionRpcAllowed, setState, state } from "../state";
import { randomId } from "./ids";
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

/** localStorage key for the persisted Work/Analysis top-level view. */
const VIEW_KEY = "omp.view";

/** localStorage key for the transcripts (Analysis) sidebar visibility toggle. */
const TX_SIDEBAR_KEY = "omp.txSidebarVisible";

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
	for (const pending of pendingDaemonSessions.values()) pending.resolve({ status: "cancelled" });
	pendingDaemonSessions.clear();
}

/** Why a per-daemon listing settled without a server answer. */
export type DaemonSessionsResult =
	| { status: "ok"; sessions: SessionListEntry[] }
	| { status: "cancelled" };

interface PendingDaemonSessions {
	resolve: (result: DaemonSessionsResult) => void;
	promise: Promise<DaemonSessionsResult>;
}

/**
 * Per-daemon waiters for the roster dropdown's list_daemon_sessions (answer:
 * unicast `daemon_sessions` frame). Keyed by daemonId; a second lookup for the
 * SAME daemon coalesces onto the in-flight one (same data, one command), so
 * the only cancellations are a stream teardown or a failed POST — reported as
 * `cancelled`, never as an empty listing.
 */
const pendingDaemonSessions = new Map<string, PendingDaemonSessions>();

/** Settle the per-daemon list_daemon_sessions waiter (mux "daemon_sessions" frame). */
export function settleDaemonSessions(daemonId: string, sessions: SessionListEntry[]): void {
	const pending = pendingDaemonSessions.get(daemonId);
	if (pending !== undefined) {
		pendingDaemonSessions.delete(daemonId);
		pending.resolve({ status: "ok", sessions });
	}
}

/** Fetch a daemon's last sessions, distinguishing cancellation (disconnect,
 *  failed POST) from a real empty listing — a cancelled lookup is not proof
 *  the workspace has no stored history. */
export function requestDaemonSessionsResult(daemonId: string): Promise<DaemonSessionsResult> {
	const inflight = pendingDaemonSessions.get(daemonId);
	if (inflight !== undefined) return inflight.promise;
	const { promise, resolve } = Promise.withResolvers<DaemonSessionsResult>();
	if (!isConnected()) {
		resolve({ status: "cancelled" });
		return promise;
	}
	pendingDaemonSessions.set(daemonId, { resolve, promise });
	postCommand({ type: "list_daemon_sessions", id: randomId(), daemonId }).catch(() => {
		if (pendingDaemonSessions.get(daemonId)?.promise === promise) {
			pendingDaemonSessions.delete(daemonId);
			resolve({ status: "cancelled" });
		}
	});
	return promise;
}

/** Fetch a daemon's last sessions for its roster dropdown (newest-first); a
 *  cancelled lookup reads as empty (the dropdown's established wording). */
export function requestDaemonSessions(daemonId: string): Promise<SessionListEntry[]> {
	return requestDaemonSessionsResult(daemonId).then((result) =>
		result.status === "ok" ? result.sessions : [],
	);
}

/**
 * Monotonic navigation intent for the roster's open actions. openDaemonSession
 * and openStoredHistory each claim a new generation and commit only while it
 * is still the newest, so a slow listing/attach for one workspace can never
 * overwrite a route or attachment chosen by a later click.
 */
let navigationGeneration = 0;

/**
 * Open a roster workspace: the shared entry for a row click (no explicit
 * session) and a session-dropdown pick.
 *
 * READ NEVER WAKES: a clone that is not `ready` opens its stored history
 * read-only — attaching an unpaired clone would start a pod. A ready daemon
 * attaches; a clone whose attach fails falls back to its stored lineage,
 * while a worktree surfaces the failure. An asleep WORKTREE keeps the old
 * wake-then-resume behavior. Latest intent wins: an attach/switch/lookup from
 * a superseded call never lands after a newer one.
 */
export async function openDaemonSession(
	daemonId: string,
	session?: SessionListEntry,
): Promise<void> {
	const generation = ++navigationGeneration;
	const entry = state.daemonRoster.find((d) => d.daemonId === daemonId);
	const clone = entry?.workspaceKind === "clone";
	// Every non-ready clone rung (asleep, failed, spawning, connecting,
	// session, resolving, reconnecting) is history-only.
	if (clone && entry?.status !== "ready") {
		await openStoredHistory(daemonId, session?.id);
		return;
	}
	if (entry?.status === "asleep") {
		// Worktree wake: spawn_resume (carrying the picked file) starts the
		// daemon; the edge serializes the attach behind it, so the resumed
		// session needs no explicit switch.
		postCommand({
			type: "spawn_resume",
			id: randomId(),
			daemonId,
			...(session !== undefined ? { sessionFile: session.path } : {}),
		}).catch(() => {});
		if (state.currentSessionId === daemonId) return;
		try {
			await attachSession(daemonId);
		} catch (err) {
			if (generation === navigationGeneration) setState("error", String(err));
		}
		return;
	}
	// Ready daemon (or an entry that just left the roster). Attach FIRST when
	// not already attached: a switchSession dispatched before the attach
	// settles routes to the wrong/no daemon and is swept by the attach's own
	// "session switched" supersession.
	if (state.currentSessionId !== daemonId) {
		try {
			await attachSession(daemonId);
		} catch (err) {
			if (generation !== navigationGeneration) return;
			if (clone) {
				// The pod died between the roster frame and this click; its
				// lineage is still in the store, so land read-only rather than
				// on a dead attach.
				await openStoredHistory(daemonId, session?.id);
				return;
			}
			throw err;
		}
	}
	// Picking the live file is a pure attach; only a different file switches.
	// A superseded call must not switch the session a newer click chose.
	if (generation !== navigationGeneration || session === undefined) return;
	const currentFile =
		state.currentSessionId === daemonId ? state.sessionFile : entry?.lastSessionFile;
	if (session.path === currentFile) return;
	// The admission gate refuses session RPCs on a non-live attachment. In the
	// normal detached / other-live case the switch posts immediately (the
	// attach's own supersession sweeps and retries it); only when the gate
	// would refuse the CURRENT attachment do we wait for this attach's prime.
	if (!sessionRpcAllowed("switchSession")) {
		await awaitAttachPrime(daemonId);
		if (generation !== navigationGeneration || state.currentSessionId !== daemonId) return;
	}
	await switchSessionRetry(daemonId, session.path, generation);
}

/**
 * Switch to `sessionFile`, retrying once when the attach's own supersession
 * swept the first call. The rejection means the daemon JUST became attached
 * (our own pick), so the retry posts to the now-current session and settles
 * cleanly. A superseded switch is never an error banner.
 */
function switchSessionRetry(
	daemonId: string,
	sessionFile: string,
	generation: number,
): Promise<void> {
	return call("switchSession", [sessionFile])
		.then(() => undefined)
		.catch((err: unknown) => {
			if (!isSessionSwitchSupersession(err)) {
				setState("error", String(err));
				return undefined;
			}
			// The switch was swept by a session switch. Retry only while OUR
			// navigation is still the newest intent AND this daemon is still the
			// attached session. The generation guard is load-bearing: a newer
			// open's `attached` sweep also rejects an OLDER superseded switch,
			// and retrying on daemonId alone would resurrect that cancelled
			// file into the new intent whenever both target the same daemon.
			if (generation !== navigationGeneration) return undefined;
			if (state.currentSessionId !== daemonId) return undefined;
			return call("switchSession", [sessionFile]).then(
				() => undefined,
				// A LATER navigation's `attached` sweep rejects this retry too.
				// That is the same expected supersession — silent, never a banner.
				(err2: unknown) => {
					if (!isSessionSwitchSupersession(err2)) setState("error", String(err2));
				},
			);
		});
}

/**
 * Open a clone workspace's fleet-stored history READ-ONLY (Analysis view).
 *
 * This is the read path for a worker that cannot be connected to: a stopped
 * pod, an unreachable cluster, or a lost callback pair. The bytes come from
 * the fleet log store (the daemon's streamed lineage), so the view never
 * wakes compute and has no mutation affordances. `sessionId` defaults to the
 * workspace's newest stored session.
 *
 * Read-only is the whole point: never route this through attach/resume, or a
 * mere look at history starts a pod.
 */
export async function openStoredHistory(daemonId: string, sessionId?: string): Promise<void> {
	const generation = ++navigationGeneration;
	let target = sessionId;
	if (target === undefined) {
		const result = await requestDaemonSessionsResult(daemonId);
		if (generation !== navigationGeneration) return; // a newer open won
		// A cancelled lookup (disconnect, failed POST) is NOT an empty store.
		if (result.status === "cancelled") return;
		target = result.sessions[0]?.id;
	}
	if (generation !== navigationGeneration) return;
	if (target === undefined) {
		setState("error", `no stored history for ${daemonId} yet`);
		return;
	}
	// Hash first: TxBrowser parses it when it mounts and listens for
	// hashchange once mounted, so the deep link lands either way.
	if (typeof location !== "undefined") {
		location.hash = `#/stored/${encodeURIComponent(daemonId)}/${encodeURIComponent(target)}`;
	}
	setView("analysis");
}

export function listSessions(): Promise<SessionListEntry[]> {
	const { promise, resolve, reject } = Promise.withResolvers<SessionListEntry[]>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingSessions?.([]);
	pendingSessions = resolve;
	postCommand({ type: "list_sessions", id: randomId() } satisfies ClientCommand).catch((err) => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingSessions === resolve) pendingSessions = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
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
		id: randomId(),
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

/**
 * Top-level Work/Analysis view. Persists omp.view; entering Work also
 * clears the #/s/<file> deep-link hash (Analysis owns it while active) and
 * the Work-button dot (workUnviewed).
 */
export function setView(view: "work" | "analysis"): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, view);
	setState("view", view);
	if (view === "work") {
		// Clear the transcript deep-link hash without firing a hashchange
		// event; Analysis re-owns the hash on its next selection.
		if (typeof history !== "undefined" && typeof location !== "undefined")
			history.replaceState(null, "", location.pathname + location.search);
		setState("workUnviewed", false);
	}
}

/** Persisted transcripts-sidebar visibility (Analysis mode's own toggle). */
export function setTxSidebarVisible(visible: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(TX_SIDEBAR_KEY, String(visible));
	setState("txSidebarVisible", visible);
}
