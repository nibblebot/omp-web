import { daemonSessionsLimit, type ClientCommand, type SessionListEntry } from "#lib/wire/protocol";
import { SIDEBAR_KEY, SIDEBAR_TITLE_LINES_KEY, TX_SIDEBAR_KEY, setState, state } from "../state";
import { startNewSession } from "./chat";
import { spawnResume } from "./projects";
import { parseRoute } from "./route";
import {
	attachSession,
	call,
	claimAttachIntent,
	currentAttachIntent,
	isConnected,
	isLatestAttachIntent,
	isSessionSwitchSupersession,
	sendCommand,
	watchAttachment,
} from "./transport";
import { reportError } from "./toasts";

/**
 * Fleet-roster domain (Phase 3 store facade split): session/file listing
 * (latest-wins pulls answered by unicast frames) and the persisted roster
 * sidebar visibility toggle. The roster mirror itself
 * (daemonsByProject, roster frame handling, daemon status announcements)
 * stays in state.ts alongside the mux.
 */

/** localStorage key for the persisted Chat/Analysis top-level view. */
const VIEW_KEY = "omp.view";

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
 * Latest-wins waiters for list_daemon_sessions (answer: unicast
 * `daemon_sessions` frame echoing the effective limit). Keyed by daemonId and
 * effective limit so a 200-row dialog request never supersedes the
 * default-limit empty-screen request for the same daemon; a superseded
 * request resolves empty.
 */
const pendingDaemonSessions = new Map<string, (sessions: SessionListEntry[]) => void>();

function daemonSessionsKey(daemonId: string, limit: number | undefined): string {
	return `${daemonId}\u0000${daemonSessionsLimit(limit)}`;
}

/**
 * Settle the list_daemon_sessions waiter for `daemonId` at `limit` (the
 * answer frame's effective limit; omitted = the default size).
 */
export function settleDaemonSessions(
	daemonId: string,
	sessions: SessionListEntry[],
	limit?: number,
): void {
	const key = daemonSessionsKey(daemonId, limit);
	const resolve = pendingDaemonSessions.get(key);
	if (resolve !== undefined) {
		pendingDaemonSessions.delete(key);
		resolve(sessions);
	}
}

/**
 * Fetch a daemon's last sessions, newest-first. `limit` omitted = the fleet
 * default (10); the fleet clamps to 1..200.
 */
export function requestDaemonSessions(
	daemonId: string,
	limit?: number,
): Promise<SessionListEntry[]> {
	const { promise, resolve } = Promise.withResolvers<SessionListEntry[]>();
	if (!isConnected()) {
		resolve([]);
		return promise;
	}
	const key = daemonSessionsKey(daemonId, limit);
	pendingDaemonSessions.get(key)?.([]); // supersede an older same-size request
	pendingDaemonSessions.set(key, resolve);
	sendCommand({
		type: "list_daemon_sessions",
		id: crypto.randomUUID(),
		daemonId,
		...(limit !== undefined && { limit }),
	}).catch(() => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingDaemonSessions.get(key) === resolve) {
			pendingDaemonSessions.delete(key);
			resolve([]);
		}
	});
	return promise;
}

/**
 * Attach `daemonId`, first waiting for its wake when `woke` is given (the
 * spawn_resume command, see spawnResume). The browser posts the two as independent
 * fetches whose arrival order at the edge is not guaranteed; an attach that
 * overtakes the wake would wake the row on lastSessionFile and fail the pick, so
 * the attach waits for the accept (the edge registers its pending resume
 * before answering). Resolves null with no attach posted when the wake was
 * refused or failed (spawnResume already reported it). An attach requested
 * meanwhile (another row click, another wake) supersedes this one: no attach
 * is posted and it resolves with whichever session is current, like a
 * superseded attachSession. Otherwise settles like attachSession.
 *
 * This is the one writer of the transcript's switch phases (`waking`,
 * `attaching`, `failed`), each only while its attach intent is still the
 * latest: a superseded switch never touches the pane the newer one owns.
 * Re-attaching the daemon the view is already on is no transition and writes
 * nothing (the caller reports its failure). `loaded` comes from the history
 * frame (loadHistory), never from here.
 */
export function wakeAndAttach(
	daemonId: string,
	woke: Promise<boolean> | null = null,
): Promise<string | null> {
	const quiet = state.currentSessionId === daemonId;
	let intent = claimAttachIntent();
	const writePhase = (phase: "waking" | "attaching" | "failed", error: string | null = null) => {
		if (quiet || !isLatestAttachIntent(intent)) return;
		setState({ transcriptPhase: phase, transcriptTarget: daemonId, transcriptError: error });
	};
	const attach = (): Promise<string> => {
		// The attach request claims its own intent; the phase writes ride it. They
		// hang off a side branch so the caller's chain keeps its microtask timing.
		const attached = attachSession(daemonId);
		intent = currentAttachIntent();
		attached.then(
			() => {
				// The wake is done once the edge answers; the history is what remains.
				if (state.transcriptPhase === "waking") writePhase("attaching");
			},
			(err: unknown) => writePhase("failed", err instanceof Error ? err.message : String(err)),
		);
		return attached;
	};
	if (woke === null) {
		writePhase("attaching");
		return attach();
	}
	writePhase("waking");
	return woke.then((ok) => {
		if (!ok) {
			writePhase("failed", "The session could not be started.");
			return null;
		}
		if (!isLatestAttachIntent(intent)) return state.currentSessionId;
		return attach();
	});
}

/**
 * Switch the transcript to `daemonId` (a row click, the new-workspace attach, the
 * palette, a deep link): asleep/stopped daemons wake then attach, everything else
 * attaches. Claims the attach intent, so a later click supersedes this one and
 * only the latest writes `transcriptPhase`. Never rejects: a failure lands in
 * phase `failed` with `transcriptError` (the transcript shows it with Retry).
 * Resolves when the switch settled or was superseded; the history frame, not
 * this promise, marks the transcript loaded. Clicking the attached daemon is a
 * no-op, except that it dismisses a failed attempt at another daemon.
 */
export async function switchToDaemon(daemonId: string): Promise<void> {
	const asleep = state.daemonRoster.find((d) => d.daemonId === daemonId)?.status === "asleep";
	if (!asleep && state.currentSessionId === daemonId) {
		if (state.transcriptPhase === "failed")
			setState({ transcriptPhase: "loaded", transcriptError: null, transcriptTarget: null });
		return;
	}
	const quiet = state.currentSessionId === daemonId;
	try {
		await wakeAndAttach(daemonId, asleep ? spawnResume(daemonId) : null);
	} catch (err) {
		// A quiet re-attach has no pane to show the failure in.
		if (quiet) reportError(err);
	}
}

/**
 * Resume a specific session of a daemon from the worktree sessions dialog.
 *
 * Asleep daemons wake with spawn_resume carrying the chosen session file
 * (the edge validates it belongs to the worktree) and then attach, even when
 * the view is already on that daemon: a UI stop keeps currentSessionId on the
 * stopped daemon while the edge closes its browser pipe, so only a fresh
 * attach rebinds the stream (the edge closes any previous pipe first, so
 * re-attaching the same daemon never double-primes). Ready daemons attach
 * (when not already attached) and switch to the session if it is not the one
 * currently live. Resolves when the attach settles / the command is issued,
 * so the caller can end its waking pulse. NEVER surfaces a "session
 * switched" supersession as an error; see switchSessionRetry.
 */
export function resumeDaemonSession(daemonId: string, sessionFile: string): Promise<void> {
	const back = state.daemonRoster.find((d) => d.daemonId === daemonId);
	const currentFile =
		state.currentSessionId === daemonId ? state.sessionFile : back?.lastSessionFile;
	if (back?.status === "asleep") {
		// Wake then attach (mirrors the old asleep-row click): the edge wakes
		// first and answers the attach once the session is ready.
		const woke = spawnResume(daemonId, sessionFile);
		return wakeAndAttach(daemonId, woke).then(
			() => undefined,
			(err) => {
				reportError(err);
			},
		);
	}
	// Ready daemon. Attach FIRST when not already attached; a switchSession
	// dispatched before the attach settles routes to the wrong/no daemon and
	// is swept by the attach's "session switched" supersession. The switch
	// only ever runs once the current daemon is (or is already) attached.
	const attach =
		state.currentSessionId === daemonId
			? Promise.resolve()
			: wakeAndAttach(daemonId).then(
					() => undefined,
					(err) => {
						reportError(err);
					},
				);
	// Picking the live file on a ready daemon is a pure attach (no switch).
	if (sessionFile === currentFile) return attach;
	return attach.then(() => switchSessionRetry(daemonId, sessionFile));
}

/**
 * Start a fresh session in a daemon's worktree (the roster row's "+" under
 * its session switcher). Asleep daemons wake first (respawn --resume
 * lastSessionFile, as a row click does); the daemon attaches when it is not
 * already the live attached session; then, once THIS attach's `attached` frame
 * has installed it and the attachment's first `state` frame has set the new
 * scope (see watchAttachment), the session runs the same newSession path /new
 * uses (collab-share confirm included). A wake keeps the view on a stopped
 * current row, so currentSessionId alone never proves the new attachment is
 * live: posting earlier would carry the previous generation's scope and be
 * rejected as stale. Never retried: a duplicate would start two sessions.
 * When the user moves to another session meanwhile, the attempt is dropped
 * silently, never banners.
 */
export async function startDaemonNewSession(daemonId: string): Promise<void> {
	const asleep = state.daemonRoster.find((d) => d.daemonId === daemonId)?.status === "asleep";
	if (asleep || state.currentSessionId !== daemonId) {
		// Registered before the attach is posted: a fast frame is never missed.
		const watch = watchAttachment(daemonId);
		try {
			// A superseded attach resolves with whichever session is current; a
			// refused wake resolves null (already reported): nothing to start on.
			const attach = wakeAndAttach(daemonId, asleep ? spawnResume(daemonId) : null);
			if ((await attach) !== daemonId) {
				watch.cancel();
				return;
			}
		} catch (err) {
			watch.cancel();
			reportError(err);
			return;
		}
		if (!(await watch.done())) return;
	}
	await startNewSession().catch(reportError);
}

/**
 * Attach `daemonId` for a panel that opens once the daemon is live (Open
 * review). Resolves true when the panel should open, which is only once the
 * attachment's first `state` frame has set the new scope (see watchAttachment):
 * the panel's reads would otherwise carry the previous attachment's scope and
 * be rejected as stale. A superseded attach is never an error: when another
 * session took over meanwhile, the attach only still counts if THIS daemon is
 * now the attached session (the same rule as switchSessionRetry); otherwise the
 * user has moved on and the panel stays closed.
 */
export async function attachForPanel(daemonId: string): Promise<boolean> {
	const watch = watchAttachment(daemonId);
	let attached: string | null;
	try {
		attached = await wakeAndAttach(daemonId);
	} catch (err) {
		watch.cancel();
		if (!isSessionSwitchSupersession(err)) {
			reportError(err);
			return false;
		}
		return state.currentSessionId === daemonId;
	}
	if (attached !== daemonId) {
		watch.cancel();
		return state.currentSessionId === daemonId;
	}
	return watch.done();
}

/**
 * A registered project with no daemon yet: folder → the session file to resume once
 * the daemon started for that folder is ready. Cleared when that daemon errors.
 */
const pendingProjectWakes = new Map<string, string>();

/**
 * Start a daemon for a registered project's folder, then resume `sessionFile` in it
 * once it is ready (see settleProjectWakes). The roster mirror shows it spawning.
 */
export function spawnProjectSession(cwd: string, sessionFile: string): void {
	pendingProjectWakes.set(cwd, sessionFile);
	sendCommand({ type: "spawn", id: crypto.randomUUID(), cwd } satisfies ClientCommand).catch(
		(err: unknown) => {
			pendingProjectWakes.delete(cwd);
			reportError(err);
		},
	);
}

/** Resume each pending project wake whose daemon is now ready; called on roster changes. */
export function settleProjectWakes(): void {
	for (const [cwd, sessionFile] of pendingProjectWakes) {
		const daemon = state.daemonRoster.find((d) => d.cwd === cwd);
		if (daemon?.status === "error") pendingProjectWakes.delete(cwd);
		if (daemon?.status !== "ready") continue;
		pendingProjectWakes.delete(cwd);
		void resumeDaemonSession(daemon.daemonId, sessionFile);
	}
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
				reportError(err);
				return undefined;
			}
			// The switch was swept by a session switch. Retry only while THIS
			// daemon is still the attached session (the rejection means it just
			// became attached, our own pick); a superseded resume is dropped
			// silently, never applied to a different daemon.
			if (state.currentSessionId !== daemonId) return undefined;
			return call("switchSession", [sessionFile]).then(
				() => undefined,
				(err2: unknown) => reportError(err2),
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
	sendCommand({ type: "list_sessions", id: crypto.randomUUID() } satisfies ClientCommand).catch(
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
	sendCommand({
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

/**
 * Roster-sidebar visibility. A docked column persists its choice; a drawer
 * (viewport below 1024px) is session-only and never written to storage.
 */
export function setSidebarVisible(visible: boolean): void {
	if (!state.drawerViewport && typeof localStorage !== "undefined")
		localStorage.setItem(SIDEBAR_KEY, String(visible));
	setState("sidebarVisible", visible);
}

export function toggleSidebar(): void {
	setSidebarVisible(!state.sidebarVisible);
}

/** Persist + apply how many lines a roster row's session title may take. */
export function setSidebarSessionTitleLines(lines: 1 | 2): void {
	if (typeof localStorage !== "undefined")
		localStorage.setItem(SIDEBAR_TITLE_LINES_KEY, String(lines));
	setState("sidebarSessionTitleLines", lines);
}

/** Closes both sidebar drawers. A no-op when docked, since docked visibility is a choice, not a drawer state. */
export function closeDrawers(): void {
	if (state.drawerViewport) setState({ sidebarVisible: false, txSidebarVisible: false });
}

/**
 * Top-level Chat/Analysis view. Persists omp.view; entering Chat also
 * clears an Analysis hash (#/s/<file>, #/stored/...; Analysis owns it while
 * active) and the Chat-button dot (chatUnviewed).
 */
export function setView(view: "chat" | "analysis"): void {
	closeDrawers();
	if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, view);
	setState("view", view);
	if (view === "chat") {
		// Clear an Analysis deep-link hash without firing a hashchange event;
		// Analysis re-owns the hash on its next selection. Session routes
		// (#/d/...) stay: the URL mirrors the attached session.
		if (
			typeof history !== "undefined" &&
			typeof location !== "undefined" &&
			parseRoute(location.hash).kind === "analysis"
		)
			history.replaceState(null, "", location.pathname + location.search);
		setState("chatUnviewed", false);
	}
}

/** Transcripts-sidebar visibility (Analysis mode's own toggle). Persists only when docked. */
export function setTxSidebarVisible(visible: boolean): void {
	if (!state.drawerViewport && typeof localStorage !== "undefined")
		localStorage.setItem(TX_SIDEBAR_KEY, String(visible));
	setState("txSidebarVisible", visible);
}
