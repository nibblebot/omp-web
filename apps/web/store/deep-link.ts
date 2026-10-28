/**
 * URL-to-session wiring. The hash mirrors the attached session
 * (`#/w/<workspaceId>/s/<sessionId>`); a hash change (first load, Back/Forward,
 * a pasted link) reattaches that session. Grammar lives in route.ts; this
 * module decides when to write the hash and how to reattach.
 *
 * History: a user-driven switch pushes an entry so Back returns to the
 * previous session. Filling in a session-level entry with its session id, and
 * restoring a route, replace the entry in place.
 */
import { state } from "../state";
import { formatRoute, parseRoute, type Route } from "./route";
import { applyActivitiesRoute } from "./activities";
import { applyRouteDock, closeDock } from "./dock";
import { requestWorkspaceSessions, resumeSession, setView, switchToSession } from "./roster";
import { pushToast } from "./toasts";
import { watchAttachment } from "./transport";
import { isUserStopped } from "./user-stopped";

/** Route restores in flight. While any runs, the attached session does not write the hash: the restore owns it. */
let restoring = 0;
/** The first non-empty roster has been seen; the initial hash restore has run. */
let initialRouteDone = false;

function writeRoute(route: Route, mode: "push" | "replace"): void {
	if (typeof history === "undefined" || typeof location === "undefined") return;
	const url = location.pathname + location.search + formatRoute(route);
	if (mode === "push") history.pushState(null, "", url);
	else history.replaceState(null, "", url);
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
	const workspaceId = state.currentWorkspaceId;
	const hash = parseRoute(location.hash);
	if (workspaceId === "" || hash.kind === "analysis") return;
	let base: Route = hash;
	if (
		!((hash.kind === "workspace" || hash.kind === "session") && hash.workspaceId === workspaceId)
	) {
		base = { kind: "workspace", workspaceId };
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
	writeRoute(next, base.kind === "workspace" || replaceEntry ? "replace" : "push");
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
		if ((await attachment.done()) && state.sessionId === sessionId) return;
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
	void restoreRoute(parseRoute(location.hash));
}

/** Back/Forward and pasted links reattach the route the hash now names. */
export function onHashChange(): void {
	if (initialRouteDone) void restoreRoute(parseRoute(location.hash));
}
