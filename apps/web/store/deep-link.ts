/**
 * URL-to-session wiring. The hash mirrors the attached session
 * (`#/w/<workspaceId>/s/<sessionId>`); a hash change (first load, Back/Forward,
 * a pasted link) reattaches that session. Grammar lives in route.ts; this
 * module decides when to write the hash and how to reattach.
 *
 * History: a user-driven switch pushes an entry so Back returns to the
 * previous session. Filling in a session-level entry with its session id,
 * restoring a route, and closing the dock replace the entry in place. A dock
 * the user closes from its UI instead unwinds the entries it pushed
 * (store/overlay-history.ts `unwindDockEntries`) so Back does not reopen it.
 * Overlay sentinel entries (same URL) never reach this module: writes run on
 * the base entry (`atBaseEntry`).
 */
import { state } from "../state";
import { formatRoute, parseRoute, type Route } from "./route";
import { applyActivitiesRoute } from "./activities";
import { applyRouteDock, closeDock } from "./dock";
import { requestWorkspaceSessions, resumeSession, setView, switchToSession } from "./roster";
import {
	atBaseEntry,
	afterHistorySettles,
	dockEntryDepth,
	isHistoryTraversing,
	routeEntryState,
} from "./overlay-history";
import { pushToast } from "./toasts";
import { watchAttachment } from "./transport";
import { isUserStopped } from "./user-stopped";

/** Route restores in flight. While any runs, the attached session does not write the hash: the restore owns it. */
let restoring = 0;
/** The first non-empty roster has been seen; the initial hash restore has run. */
let initialRouteDone = false;

/** localStorage key for the last attached route (`{ workspaceId, sessionId? }`), the no-hash launch's target. */
export const LAST_ROUTE_KEY = "omp.lastRoute";

/** Remember the attached workspace/session for a launch with no hash (the installed app's `start_url`). Docks live in their own layout store. */
function rememberRoute(route: Route): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (route.kind === "workspace") {
			localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ workspaceId: route.workspaceId }));
		} else if (route.kind === "session") {
			const { workspaceId, sessionId } = route;
			localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ workspaceId, sessionId }));
		} else if (route.kind === "none") localStorage.removeItem(LAST_ROUTE_KEY);
	} catch {
		// Storage full or blocked: the next launch opens on the roster.
	}
}

function readLastRoute(): Route {
	if (typeof localStorage === "undefined") return { kind: "none" };
	try {
		const raw = localStorage.getItem(LAST_ROUTE_KEY);
		if (raw === null) return { kind: "none" };
		const saved: unknown = JSON.parse(raw);
		if (typeof saved !== "object" || saved === null) return { kind: "none" };
		const workspaceId = "workspaceId" in saved ? saved.workspaceId : undefined;
		const sessionId = "sessionId" in saved ? saved.sessionId : undefined;
		if (typeof workspaceId !== "string" || workspaceId === "") return { kind: "none" };
		if (typeof sessionId === "string" && sessionId !== "") {
			return { kind: "session", workspaceId, sessionId };
		}
		return { kind: "workspace", workspaceId };
	} catch {
		return { kind: "none" };
	}
}

/**
 * Write the route. `dockDepth` marks a pushed entry as the Nth entry of one
 * open dock (0: not part of a dock run); a replace keeps the entry's own depth
 * while the route still names a dock. Sentinel entries of open overlays are
 * popped first (`atBaseEntry`).
 */
function writeRoute(route: Route, mode: "push" | "replace", dockDepth = 0): void {
	rememberRoute(route);
	if (typeof history === "undefined" || typeof location === "undefined") return;
	const url = location.pathname + location.search + formatRoute(route);
	atBaseEntry(() => {
		if (mode === "push") history.pushState(routeEntryState(dockDepth), "", url);
		else {
			const keepsDock = "dock" in route && route.dock !== undefined;
			history.replaceState(routeEntryState(keepsDock ? dockEntryDepth() : 0), "", url);
		}
	});
}

/**
 * Mirror the attached session into the hash. Runs whenever the attached
 * session or its session id changes. Analysis hashes belong to the transcript
 * browser and are never touched. `replaceEntry` rewrites the current history
 * entry instead of pushing one: a restore that fills in a saved dock must not
 * truncate the Forward history of the entry the user just navigated to.
 */
export function syncRouteToAttached(replaceEntry = false): void {
	if (restoring > 0) return;
	// A traversal in flight (a dock or overlay unwinding) changes which entry is current: sync on the settled URL.
	if (isHistoryTraversing()) {
		afterHistorySettles(() => syncRouteToAttached(replaceEntry));
		return;
	}
	const workspaceId = state.currentWorkspaceId;
	const hash = parseRoute(location.hash);
	if (workspaceId === "" || hash.kind === "analysis") return;
	let base: Route = hash;
	let pushedBase = false;
	if (
		!((hash.kind === "workspace" || hash.kind === "session") && hash.workspaceId === workspaceId)
	) {
		base = { kind: "workspace", workspaceId };
		pushedBase = true;
		writeRoute(base, "push");
	}
	// state.sessionId is cleared on every session switch, so a non-empty value
	// belongs to the attached session.
	if (state.sessionId === "") return;
	const dock = state.dock ?? undefined;
	const next: Route = {
		kind: "session",
		workspaceId,
		sessionId: state.sessionId,
		...(dock === undefined ? {} : { dock }),
	};
	if (base.kind === "session" && formatRoute(base) === formatRoute(next)) return;
	const sameSession = base.kind === "session" && base.sessionId === next.sessionId;
	// Closing the dock rewrites its entry (Back would otherwise reopen it).
	const closesDock =
		sameSession && base.kind === "session" && base.dock !== undefined && dock === undefined;
	if (pushedBase && dock !== undefined && !replaceEntry) {
		// First write on a fresh hash with a dock open: the session route fills in the entry just pushed and the dock
		// is its own entry, so closing the dock from its UI steps back onto the session instead of rewriting it.
		writeRoute({ kind: "session", workspaceId, sessionId: state.sessionId }, "replace");
		writeRoute(next, "push", 1);
		return;
	}
	if (base.kind === "workspace" || replaceEntry || closesDock) {
		writeRoute(next, "replace");
		return;
	}
	writeRoute(next, "push", dockRunDepth(base, next, sameSession));
}

/** Depth of the entry a push creates: the first dock entry is 1, a retarget or item step on the same session extends the run. */
function dockRunDepth(base: Route, next: Route, sameSession: boolean): number {
	if (next.kind !== "session" || next.dock === undefined) return 0;
	if (base.kind !== "session" || base.dock === undefined) return 1;
	const depth = dockEntryDepth();
	return sameSession && depth > 0 ? depth + 1 : 0;
}

async function attachWorkspace(workspaceId: string): Promise<void> {
	if (state.currentWorkspaceId === workspaceId) return;
	// A user-stopped session stays stopped across a reload: no attach (the edge wakes on attach); the row keeps Stopped + Restart.
	if (isUserStopped(workspaceId)) return;
	await switchToSession(workspaceId);
}

async function attachSessionRoute(workspaceId: string, sessionId: string): Promise<void> {
	if (state.currentWorkspaceId === workspaceId && state.sessionId === sessionId) return;
	// A live session process is nearly always still on the route's session (a reload),
	// so attach first and let its own state frame answer. The session list (a cold
	// directory scan in the fleet) is asked only when the route names another session.
	if (
		state.sessionRoster.find((d) => d.workspaceId === workspaceId)?.status !== "asleep" &&
		state.currentWorkspaceId !== workspaceId &&
		!isUserStopped(workspaceId)
	) {
		const attachment = watchAttachment(workspaceId);
		await attachWorkspace(workspaceId);
		// A refused attach (phase failed) never lands an `attached` frame, and a newer
		// switch owns the pane once the user picks another session: either way the
		// restore ends here instead of waiting out the watch and pulling the user back.
		const refused = state.transcriptPhase === "failed" && state.transcriptTarget === workspaceId;
		const superseded = state.transcriptTarget !== null && state.transcriptTarget !== workspaceId;
		if (refused || superseded) {
			attachment.cancel();
			return;
		}
		const ready = await attachment.done();
		if (state.currentWorkspaceId !== "" && state.currentWorkspaceId !== workspaceId) return;
		if (ready && state.sessionId === sessionId) return;
	}
	const match = (await requestWorkspaceSessions(workspaceId)).find((s) => s.id === sessionId);
	if (match === undefined) {
		pushToast("That session is no longer available in this session process.");
		writeRoute({ kind: "workspace", workspaceId }, "replace");
		await attachWorkspace(workspaceId);
		return;
	}
	// A user-stopped session stays stopped across a reload: attaching would wake it (the edge wakes on attach).
	if (isUserStopped(workspaceId)) return;
	// A sleeping session resumes straight onto the file (one spawn, no default-session flash).
	if (state.sessionRoster.find((d) => d.workspaceId === workspaceId)?.status === "asleep") {
		await resumeSession(workspaceId, match.path);
		return;
	}
	await attachWorkspace(workspaceId);
	// Skip the file switch when the attached session already is the target, so the transcript is not reloaded.
	if (state.sessionId === sessionId) return;
	await resumeSession(workspaceId, match.path);
}

async function restoreRoute(route: Route): Promise<void> {
	if (route.kind === "none" || route.kind === "analysis") return;
	const { workspaceId } = route;
	if (!state.sessionRoster.some((d) => d.workspaceId === workspaceId)) {
		pushToast("That session process is no longer in the fleet.");
		writeRoute({ kind: "none" }, "replace");
		return;
	}
	if (state.view !== "chat") setView("chat");
	const switchedWorkspace = state.currentWorkspaceId !== workspaceId;
	restoring++;
	try {
		if (route.kind === "session") await attachSessionRoute(workspaceId, route.sessionId);
		else await attachWorkspace(workspaceId);
	} finally {
		restoring--;
	}
	// The URL is the source of truth for the dock when it names one. A route
	// without one closes the dock of the workspace the user is already on
	// (Back/Forward); after a switch to another workspace the dock saved for it
	// was restored with the attach (store/dock.ts restoreDockLayout) and stays.
	if (route.dock !== undefined) {
		if (route.dock.kind === "activities") applyActivitiesRoute(route.dock);
		else applyRouteDock(route.dock);
	} else if (!switchedWorkspace || state.currentWorkspaceId !== workspaceId) closeDock();
	syncRouteToAttached(true);
}

/** Restore the hash once the roster first arrives non-empty (the initial load). */
export function restoreInitialRoute(): void {
	if (initialRouteDone) return;
	initialRouteDone = true;
	if (location.hash === "" || location.hash === "#") {
		restoreLastRoute();
		return;
	}
	void restoreRoute(parseRoute(location.hash));
}

/**
 * A launch with no hash (the installed app opens `start_url`): reattach the
 * last attached workspace. Opening the app must never spawn a process, so only
 * a running session is attached; an asleep, user-stopped or still-starting one
 * stays on the roster for the user to wake, and the saved route stays for the
 * next launch. Only the workspace is attached: whatever session it currently
 * runs stays, because a saved session id can be days old and switching a live
 * (possibly shared) process onto it would move other clients with it. A
 * workspace that left the fleet drops the saved route silently (no hash was
 * asked for, so no toast).
 */
function restoreLastRoute(): void {
	const saved = readLastRoute();
	if (saved.kind === "none" || saved.kind === "analysis") return;
	const { workspaceId } = saved;
	const entry = state.sessionRoster.find((d) => d.workspaceId === workspaceId);
	if (entry === undefined) {
		rememberRoute({ kind: "none" });
		return;
	}
	if (entry.status !== "ready" && entry.status !== "reconnecting") return;
	if (isUserStopped(workspaceId)) return;
	// The hash names the workspace before the restore, so its closing sync fills the session in place instead of pushing an entry.
	const route: Route = { kind: "workspace", workspaceId };
	writeRoute(route, "replace");
	void restoreRoute(route);
}

/** Test seam: a fresh page's route state (the initial restore has not run). */
export function resetDeepLink(): void {
	restoring = 0;
	initialRouteDone = false;
}

/** Back/Forward and pasted links reattach the route the hash now names. */
export function onHashChange(): void {
	if (initialRouteDone) void restoreRoute(parseRoute(location.hash));
}
