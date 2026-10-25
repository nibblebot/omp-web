import { createSignal } from "solid-js";

/** localStorage key for the persisted user-stopped workspace ids (a JSON string array). */
export const USER_STOPPED_KEY = "omp.userStopped";

/**
 * Session ids the user stopped on purpose (sidebar Stop, header restart flow).
 * A user stop keeps the attached chat column and its transcript behind a
 * "stopped" strip; a crash or a roster removal is NOT in this set and still
 * clears the session view. Cleared when the session is woken again.
 *
 * The set is a browser pref (localStorage, like the sidebar's collapsed
 * groups): the fleet holds no per-browser intent, and without persistence a
 * reload turned the row's "Stopped" chip back into "Asleep". Ids read from
 * storage are unverified until the first roster frame confirms the session is
 * still asleep (see `reconcileUserStopped`), so a session woken from another
 * browser or the CLI while this one was closed does not read Stopped later.
 */
const [stopped, setStopped] = createSignal<ReadonlySet<string>>(new Set());

/** Ids read from storage that no roster frame has confirmed yet. */
let unverified = new Set<string>();

function persist(ids: ReadonlySet<string>): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (ids.size === 0) localStorage.removeItem(USER_STOPPED_KEY);
		else localStorage.setItem(USER_STOPPED_KEY, JSON.stringify([...ids]));
	} catch {
		// Storage full or blocked: the mark stays in memory for this page load.
	}
}

function update(next: ReadonlySet<string>): void {
	setStopped(next);
	persist(next);
}

/**
 * (Re)load the persisted marks into the in-memory set. Runs once at module
 * load; exported so a test can model a page reload. Malformed storage reads
 * as empty.
 */
export function loadUserStopped(): void {
	const ids = new Set<string>();
	if (typeof localStorage !== "undefined") {
		try {
			const raw = localStorage.getItem(USER_STOPPED_KEY);
			const parsed: unknown = raw === null ? [] : JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const id of parsed) if (typeof id === "string" && id !== "") ids.add(id);
			}
		} catch {
			// Malformed value: start clean.
		}
	}
	unverified = new Set(ids);
	setStopped(ids);
}

/** Reactive: true while the user's stop of this session has not been undone. */
export function isUserStopped(workspaceId: string): boolean {
	return stopped().has(workspaceId);
}

export function markUserStopped(workspaceId: string): void {
	if (stopped().has(workspaceId)) return;
	update(new Set(stopped()).add(workspaceId));
}

export function clearUserStopped(workspaceId: string): void {
	unverified.delete(workspaceId);
	if (!stopped().has(workspaceId)) return;
	const next = new Set(stopped());
	next.delete(workspaceId);
	update(next);
}

/**
 * Reconcile the marks with a full roster frame. Ids that left the roster are
 * dropped (workspace ids are never reused). A mark read from storage survives
 * only if its session is still asleep on the first roster frame after load;
 * marks made this page load follow the stop/restart flow instead.
 */
export function reconcileUserStopped(
	roster: ReadonlyArray<{ workspaceId: string; status: string }>,
): void {
	const status = new Map(roster.map((entry) => [entry.workspaceId, entry.status]));
	let next: Set<string> | undefined;
	for (const id of stopped()) {
		const current = status.get(id);
		if (current === undefined || (unverified.has(id) && current !== "asleep")) {
			next ??= new Set(stopped());
			next.delete(id);
		}
	}
	unverified = new Set();
	if (next !== undefined) update(next);
}

loadUserStopped();
