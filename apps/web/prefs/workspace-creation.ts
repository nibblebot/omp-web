/**
 * Add-workspace dialog preferences (P8.2): remembers ONLY the last-used
 * workspace kind and provider profile, scoped per browser per fleet origin
 * (the key embeds location.origin; unlike the unscoped omp.* keys, a
 * browser talking to two fleet origins through one UI origin keeps
 * separate memories). Cross-project by design. Adding a workspace always
 * starts its session, so there is no start toggle to remember.
 *
 * NEVER persist names, branches, source URLs/paths, revisions, or secrets
 * here; the type below deliberately has no fields for them.
 */

/** Kinds the unified Add-workspace dialog can create (adopting an existing
 *  worktree shares the worktree memory; it creates no new workspace kind). */
export type WorkspaceKindChoice = "worktree" | "clone";

export interface WorkspaceCreationPrefs {
	kind?: WorkspaceKindChoice;
	profileId?: string;
}

/** localStorage key prefix; the fleet origin is appended verbatim. */
const KEY_PREFIX = "omp.workspaceCreation.";

function storageKey(): string {
	const origin = typeof location !== "undefined" ? location.origin : "unknown";
	return KEY_PREFIX + origin;
}

/** Read the remembered creation choices; malformed or unavailable storage
 *  yields {} (no memory), which the dialog treats as "no prior preference". */
export function currentWorkspaceCreationPrefs(): WorkspaceCreationPrefs {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(storageKey());
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const p = parsed as Record<string, unknown>;
		const prefs: WorkspaceCreationPrefs = {};
		if (p.kind === "worktree" || p.kind === "clone") prefs.kind = p.kind;
		if (typeof p.profileId === "string" && p.profileId !== "") prefs.profileId = p.profileId;
		return prefs;
	} catch {
		return {};
	}
}

/**
 * Merge a submitted choice into the memory. `kind` always updates;
 * `profileId` updates only when given, so creating a worktree never erases
 * the remembered clone profile (returning to the Clone tab still
 * pre-selects it).
 */
export function rememberWorkspaceCreationPrefs(update: {
	kind: WorkspaceKindChoice;
	profileId?: string;
}): void {
	if (typeof localStorage === "undefined") return;
	const next: WorkspaceCreationPrefs = {
		...currentWorkspaceCreationPrefs(),
		kind: update.kind,
	};
	if (update.profileId !== undefined) next.profileId = update.profileId;
	try {
		localStorage.setItem(storageKey(), JSON.stringify(next));
	} catch {
		// Storage full/blocked: the dialog still works, nothing is remembered.
	}
}
