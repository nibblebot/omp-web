/**
 * New workspace popover preferences: remembers the last "Run on" and "Source"
 * choice per project, scoped per browser per fleet origin (the key embeds
 * location.origin, so a browser talking to two fleet origins keeps separate
 * memories). Keyed by projectId: each project remembers its own choice.
 *
 * NEVER persist branch names, workspace names, source URLs/paths, revisions,
 * or secrets here; the type below deliberately has no fields for them. A git
 * remote name is the only source detail kept.
 */

/** "worktree" = This machine; "clone" = a provider profile (`profileId`). */
export type WorkspaceKindChoice = "worktree" | "clone";

/** Clone source: the project's own main checkout, or one of its git remotes. */
export type WorkspaceSourceChoice = "local" | "remote";

export interface WorkspaceCreationPrefs {
	kind?: WorkspaceKindChoice;
	profileId?: string;
	source?: WorkspaceSourceChoice;
	remote?: string;
}

/** localStorage key prefix; the fleet origin and project id are appended verbatim. */
const KEY_PREFIX = "omp.workspaceCreation.";

function storageKey(projectId: string): string {
	const origin = typeof location !== "undefined" ? location.origin : "unknown";
	return `${KEY_PREFIX}${origin}.${projectId}`;
}

/** Read one project's remembered choices; malformed or unavailable storage
 *  yields {} (no memory), which the popover treats as "no prior preference". */
export function currentWorkspaceCreationPrefs(projectId: string): WorkspaceCreationPrefs {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(storageKey(projectId));
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const p = parsed as Record<string, unknown>;
		const prefs: WorkspaceCreationPrefs = {};
		if (p.kind === "worktree" || p.kind === "clone") prefs.kind = p.kind;
		if (typeof p.profileId === "string" && p.profileId !== "") prefs.profileId = p.profileId;
		if (p.source === "local" || p.source === "remote") prefs.source = p.source;
		if (typeof p.remote === "string" && p.remote !== "") prefs.remote = p.remote;
		return prefs;
	} catch {
		return {};
	}
}

/** Replace one project's remembered choices with the submitted ones. */
export function rememberWorkspaceCreationPrefs(
	projectId: string,
	prefs: WorkspaceCreationPrefs,
): void {
	if (typeof localStorage === "undefined") return;
	const next: WorkspaceCreationPrefs = {};
	if (prefs.kind !== undefined) next.kind = prefs.kind;
	if (prefs.profileId !== undefined) next.profileId = prefs.profileId;
	if (prefs.source !== undefined) next.source = prefs.source;
	if (prefs.remote !== undefined) next.remote = prefs.remote;
	try {
		localStorage.setItem(storageKey(projectId), JSON.stringify(next));
	} catch {
		// Storage full/blocked: the popover still works, nothing is remembered.
	}
}
