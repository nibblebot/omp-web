/**
 * URL-to-session wiring. The hash mirrors the attached session
 * (`#/d/<daemonId>/s/<sessionId>`); a hash change (first load, Back/Forward,
 * a pasted link) reattaches that session. Grammar lives in route.ts; this
 * module decides when to write the hash and how to reattach.
 *
 * History: a user-driven switch pushes an entry so Back returns to the
 * previous session. Filling in a daemon-level entry with its session id, and
 * restoring a route, replace the entry in place.
 */
import { state } from "../state";
import { formatRoute, parseRoute, type Route } from "./route";
import { closeDock, openDock } from "./dock";
import { requestDaemonSessions, resumeDaemonSession, setView, switchToDaemon } from "./roster";
import { pushToast } from "./toasts";
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
 * daemon or its session id changes. Analysis hashes belong to the transcript
 * browser and are never touched.
 */
export function syncRouteToAttached(): void {
	if (restoring > 0) return;
	const daemonId = state.currentSessionId;
	const hash = parseRoute(location.hash);
	if (daemonId === "" || hash.kind === "analysis") return;
	let base: Route = hash;
	if (!((hash.kind === "daemon" || hash.kind === "session") && hash.daemonId === daemonId)) {
		base = { kind: "daemon", daemonId };
		writeRoute(base, "push");
	}
	// state.sessionId is cleared on every daemon switch, so a non-empty value
	// belongs to the attached daemon.
	if (state.sessionId === "") return;
	const dock = state.dock ?? undefined;
	const next: Route = {
		kind: "session",
		daemonId,
		sessionId: state.sessionId,
		...(dock === undefined ? {} : { dock }),
	};
	if (base.kind === "session" && formatRoute(base) === formatRoute(next)) return;
	writeRoute(next, base.kind === "daemon" ? "replace" : "push");
}

async function attachDaemon(daemonId: string): Promise<void> {
	if (state.currentSessionId === daemonId) return;
	// A user-stopped daemon stays stopped across a reload: no attach (the edge wakes on attach); the row keeps Stopped + Restart.
	if (isUserStopped(daemonId)) return;
	await switchToDaemon(daemonId);
}

async function attachSessionRoute(daemonId: string, sessionId: string): Promise<void> {
	if (state.currentSessionId === daemonId && state.sessionId === sessionId) return;
	const match = (await requestDaemonSessions(daemonId)).find((s) => s.id === sessionId);
	if (match === undefined) {
		pushToast("That session is no longer available in this session process.");
		writeRoute({ kind: "daemon", daemonId }, "replace");
		await attachDaemon(daemonId);
		return;
	}
	// A user-stopped daemon stays stopped across a reload: attaching would wake it (the edge wakes on attach).
	if (isUserStopped(daemonId)) return;
	// A sleeping daemon resumes straight onto the file (one spawn, no default-session flash).
	if (state.daemonRoster.find((d) => d.daemonId === daemonId)?.status === "asleep") {
		await resumeDaemonSession(daemonId, match.path);
		return;
	}
	await attachDaemon(daemonId);
	// Skip the file switch when the attached session already is the target, so the transcript is not reloaded.
	if (state.sessionId === sessionId) return;
	await resumeDaemonSession(daemonId, match.path);
}

async function restoreRoute(route: Route): Promise<void> {
	if (route.kind === "none" || route.kind === "analysis") return;
	const { daemonId } = route;
	if (!state.daemonRoster.some((d) => d.daemonId === daemonId)) {
		pushToast("That session process is no longer in the fleet.");
		writeRoute({ kind: "none" }, "replace");
		return;
	}
	if (state.view !== "chat") setView("chat");
	restoring++;
	try {
		if (route.kind === "session") await attachSessionRoute(daemonId, route.sessionId);
		else await attachDaemon(daemonId);
	} finally {
		restoring--;
	}
	// The URL is the source of truth for the dock: a route without one closes it.
	if (route.kind === "session" && route.dock !== undefined)
		openDock(route.dock.kind, route.dock.id);
	else closeDock();
	syncRouteToAttached();
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
