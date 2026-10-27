import { createSignal } from "solid-js";
import type {
	ClientCommand,
	CloneFetchResult,
	OmpSetupStatus,
	ProjectBranch,
} from "#lib/wire/protocol";
import { setState, state } from "../state";
import { authedFetch } from "./auth";
import { ctlError } from "./settings";
import { ctlFetch, isConnected, sendCommand } from "./transport";
import { clearUserStopped, markUserStopped } from "./user-stopped";
import { pushToast } from "./toasts";

/** A session-bound fleet command is refused while the transport is down. The
 *  refusal shows as a toast so the click never vanishes silently. */
function refuseIfDisconnected(): boolean {
	if (isConnected()) return false;
	pushToast("Not connected, this action is paused until the connection is back");
	return true;
}

/** A command the transport failed to deliver reports instead of being swallowed. */
function reportCommandFailure(err: unknown): void {
	pushToast(err instanceof Error ? err.message : String(err));
}

/**
 * Projects domain (Phase 3 store facade split): fleet-edge project/worktree/
 * session senders. Results arrive as roster / registered_projects /
 * worktree_delete_info broadcasts and error frames; add_project, create_worktree,
 * create_clone and list_project_branches answer with unicast frames that settle
 * the promises below. The registered-projects / worktreeDeleteInfo mirrors live in
 * state.ts alongside the mux.
 */

/** Answer of list_project_branches (the project_branches frame minus its project key). */
export interface ProjectBranchesResult {
	branches: ProjectBranch[];
	remotes: string[];
	defaultBase?: string;
	cached?: boolean;
	remote?: string;
}

/** In-flight list_project_branches waiters per (projectId, remote). The frame carries no
 *  command id, so every waiter for the same key settles with its answer. */
const pendingBranches = new Map<string, Array<Waiter<ProjectBranchesResult>>>();

function branchesKey(projectId: string, remote: string | undefined): string {
	return `${projectId}\u0000${remote ?? ""}`;
}

/** Settle the list_project_branches waiters (mux "project_branches" frame). */
export function settleProjectBranches(frame: {
	projectId: string;
	remote?: string;
	branches: ProjectBranch[];
	remotes: string[];
	defaultBase?: string;
	cached?: boolean;
}): void {
	const key = branchesKey(frame.projectId, frame.remote);
	const waiters = pendingBranches.get(key);
	if (waiters === undefined) return;
	pendingBranches.delete(key);
	const result: ProjectBranchesResult = {
		branches: frame.branches,
		remotes: frame.remotes,
		...(frame.defaultBase !== undefined ? { defaultBase: frame.defaultBase } : {}),
		...(frame.cached !== undefined ? { cached: frame.cached } : {}),
		...(frame.remote !== undefined ? { remote: frame.remote } : {}),
	};
	for (const waiter of waiters) waiter.resolve(result);
}

/** WorkspaceIds whose delete was submitted and whose roster removal has not arrived yet.
 *  Module-level (like WorkspaceRow's activatingIds) so the dim survives a row
 *  unmounting (collapsed group) and is readable by the delete dialog's sender. The row
 *  dims at once (`.roster-row--deleting`) and collapses only when the roster drops it. */
const [deletePendingIds, setDeletePendingIds] = createSignal<ReadonlySet<string>>(new Set());
export { deletePendingIds };

/** Forget a pending delete: the delete failed, or the roster removal arrived. */
export function clearDeletePending(workspaceId: string): void {
	if (!deletePendingIds().has(workspaceId)) return;
	setDeletePendingIds((prev) => {
		const next = new Set(prev);
		next.delete(workspaceId);
		return next;
	});
}

/** Forget every pending delete. The fleet's refusal is an uncorrelated error frame
 *  (state.error), so ProjectGroups clears them all when one arrives. */
export function clearAllDeletePending(): void {
	if (deletePendingIds().size > 0) setDeletePendingIds(new Set<string>());
}

/** Reject every in-flight project waiter (stream teardown in state.ts). Pending
 *  deletes are forgotten too: after a reconnect the roster resync shows the truth
 *  (row gone: it collapses; row still there: the delete failed or never ran). */
export function resetPendingProjects(): void {
	clearAllDeletePending();
	const err = new Error("Disconnected");
	for (const waiters of pendingBranches.values()) for (const w of waiters) w.reject(err);
	pendingBranches.clear();
	for (const w of pendingAddProject.values()) w.reject(err);
	pendingAddProject.clear();
	for (const w of pendingWorkspaceCreate.values()) w.reject(err);
	pendingWorkspaceCreate.clear();
}

/** List the branches of a registered project: local ones, or those of git remote `remote`
 *  (the New workspace popover's branch picker; checkedOut local branches cannot be
 *  checked out again). Answers also carry the project's remote names and default base. */
export function listProjectBranches(
	projectId: string,
	remote?: string,
): Promise<ProjectBranchesResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ProjectBranchesResult>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	const key = branchesKey(projectId, remote);
	const waiter: Waiter<ProjectBranchesResult> = { resolve, reject };
	const waiters = pendingBranches.get(key);
	if (waiters === undefined) pendingBranches.set(key, [waiter]);
	else waiters.push(waiter);
	sendCommand({
		type: "list_project_branches",
		id: crypto.randomUUID(),
		projectId,
		...(remote !== undefined ? { remote } : {}),
	} satisfies ClientCommand).catch((err) => {
		const list = pendingBranches.get(key);
		const index = list?.indexOf(waiter) ?? -1;
		if (list !== undefined && index >= 0) {
			list.splice(index, 1);
			if (list.length === 0) pendingBranches.delete(key);
		}
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Open the Add project dialog, prefilled with `path` (an unowned session's folder). */
export function openAddProject(path?: string): void {
	setState("addProjectPath", path ?? null);
	setState("modal", "add-project");
}

/**
 * Wake an asleep session (spawned → respawn --resume; attached/remote → redial), on
 * `sessionFile` when picked. Resolves true once the edge acked the command: it
 * registers its pending resume before acking, so an attach posted after this
 * resolves can never overtake the wake. Resolves false when refused (not
 * connected) or the command was refused (reported as a toast); never rejects. Callers that
 * attach next MUST await it and skip the attach on false (see wakeAndAttach).
 */
export function spawnResume(workspaceId: string, sessionFile?: string): Promise<boolean> {
	if (refuseIfDisconnected()) return Promise.resolve(false);
	clearUserStopped(workspaceId);
	return sendCommand({
		type: "spawn_resume",
		id: crypto.randomUUID(),
		workspaceId,
		...(sessionFile !== undefined ? { sessionFile } : {}),
	} satisfies ClientCommand).then(
		() => true,
		(err: unknown) => {
			reportCommandFailure(err);
			return false;
		},
	);
}

/** Stop a session (spawned → terminate child; attached/remote → drop + asleep).
 *  Marked user-stopped so the attached chat keeps its transcript behind the stopped strip. */
export function stopSessionById(workspaceId: string): void {
	if (refuseIfDisconnected()) return;
	markUserStopped(workspaceId);
	void sendCommand({
		type: "stop",
		id: crypto.randomUUID(),
		workspaceId,
	} satisfies ClientCommand).catch(reportCommandFailure);
}

/** Sessions whose restart stop is in flight; each is woken once the roster shows it asleep. */
const restartAwaitingAsleep = new Set<string>();

/** Restart a session process. A ready one is stopped first (marks it), and its wake
 *  waits for the roster to show it asleep: the edge refuses a wake while the process
 *  still reads ready. An asleep one clears the mark and wakes right away. No extra
 *  attach: the edge answers the attached frame on wake when this is the attached session.
 *  Resolves like spawnResume when it wakes at once; a ready row has no wake command to
 *  order an attach after (the later wake rides the roster), so it resolves true. */
export function restartSessionById(workspaceId: string): Promise<boolean> {
	const entry = state.sessionRoster.find((d) => d.workspaceId === workspaceId);
	if (entry?.status !== "ready") return spawnResume(workspaceId);
	restartAwaitingAsleep.add(workspaceId);
	stopSessionById(workspaceId);
	return Promise.resolve(true);
}

/** Called on every roster frame: wake each restarting session that now reads asleep, and
 *  forget restarts whose session left the roster. */
export function resumeRestartedSessions(
	roster: Array<{ workspaceId: string; status: string }>,
): void {
	for (const workspaceId of restartAwaitingAsleep) {
		const entry = roster.find((d) => d.workspaceId === workspaceId);
		if (entry === undefined) {
			restartAwaitingAsleep.delete(workspaceId);
		} else if (entry.status === "asleep") {
			restartAwaitingAsleep.delete(workspaceId);
			void spawnResume(workspaceId);
		}
	}
}

// ---------------------------------------------------------------------------
// Project/workspace onboarding. add_project / create_worktree / create_clone
// answer with id-keyed unicast result frames and resolve as promises; the new
// rows themselves arrive on the roster / registered_projects broadcasts.
// ---------------------------------------------------------------------------

interface Waiter<T> {
	resolve: (value: T) => void;
	reject: (err: Error) => void;
}

const pendingAddProject = new Map<string, Waiter<{ projectId: string; existing: boolean }>>();
const pendingWorkspaceCreate = new Map<string, Waiter<{ workspaceId: string }>>();

/** Settle the add_project waiter (mux "add_project_result" frame); unknown ids are ignored. */
export function settleAddProject(frame: {
	id: string;
	ok: boolean;
	projectId?: string;
	existing?: boolean;
	error?: string;
}): void {
	const waiter = pendingAddProject.get(frame.id);
	if (waiter === undefined) return;
	pendingAddProject.delete(frame.id);
	if (frame.ok && frame.projectId !== undefined) {
		waiter.resolve({ projectId: frame.projectId, existing: frame.existing === true });
	} else {
		waiter.reject(new Error(frame.error ?? "add project failed"));
	}
}

/** Settle the create_worktree / create_clone waiter (mux "workspace_create_result" frame). */
export function settleWorkspaceCreate(frame: {
	id: string;
	ok: boolean;
	workspaceId?: string;
	error?: string;
}): void {
	const waiter = pendingWorkspaceCreate.get(frame.id);
	if (waiter === undefined) return;
	pendingWorkspaceCreate.delete(frame.id);
	if (frame.ok && frame.workspaceId !== undefined) {
		waiter.resolve({ workspaceId: frame.workspaceId });
	} else {
		waiter.reject(new Error(frame.error ?? "workspace creation failed"));
	}
}

/** Send `cmd` and park a waiter under its id until the keyed result frame settles it. */
function sendKeyed<T>(pending: Map<string, Waiter<T>>, id: string, cmd: ClientCommand): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pending.set(id, { resolve, reject });
	sendCommand(cmd).catch((err) => {
		if (!pending.delete(id)) return;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Register a project. `path` may be the main checkout, a linked worktree, a
 *  subdirectory (the fleet resolves the main checkout), or a plain folder with no
 *  git repo above it. Never spawns. Rejects with the fleet's refusal message
 *  (bare repo, ...). */
export function addProject(path: string): Promise<{ projectId: string; existing: boolean }> {
	const id = crypto.randomUUID();
	return sendKeyed(pendingAddProject, id, { type: "add_project", id, path });
}

/** Deregister a project. The fleet stops its running sessions and drops every row
 *  (transcripts and disk untouched); refused while a clone workspace belongs to it
 *  (the refusal arrives as an error frame). */
export function sendRemoveProject(projectId: string): void {
	if (refuseIfDisconnected()) return;
	void sendCommand({
		type: "remove_project",
		id: crypto.randomUUID(),
		projectId,
	} satisfies ClientCommand).catch(reportCommandFailure);
}

/** Create a worktree workspace (start:true: the fleet spawns a session on it). Resolves
 *  with the new row's workspaceId once the fleet accepted it; rejects with the fleet's reason. */
export function createWorktree(
	projectId: string,
	opts: { name: string; baseRef?: string; existingBranch?: string },
): Promise<{ workspaceId: string }> {
	const id = crypto.randomUUID();
	return sendKeyed(pendingWorkspaceCreate, id, {
		type: "create_worktree",
		id,
		projectId,
		name: opts.name,
		...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
		...(opts.existingBranch !== undefined ? { existingBranch: opts.existingBranch } : {}),
		start: true,
	});
}

/** Create a provider-managed clone workspace. `source` names one of the project's git
 *  remotes (resolved fleet-side); omitted = the project's own checkout (kubernetes
 *  profiles default to the origin URL). Lifecycle stages ride the roster entry. */
export function createClone(
	projectId: string,
	opts: {
		name: string;
		profileId: string;
		source?: { remoteName: string };
		revision?: string;
		branch?: string;
	},
): Promise<{ workspaceId: string }> {
	const id = crypto.randomUUID();
	return sendKeyed(pendingWorkspaceCreate, id, {
		type: "create_clone",
		id,
		projectId,
		name: opts.name,
		profileId: opts.profileId,
		...(opts.source !== undefined ? { source: opts.source } : {}),
		...(opts.revision !== undefined ? { revision: opts.revision } : {}),
		...(opts.branch !== undefined ? { branch: opts.branch } : {}),
		start: true,
	});
}

/** Last `sync_projects` send; throttles the focus / group-expand triggers. */
let lastSyncAt = 0;
const SYNC_MIN_INTERVAL_MS = 5000;

/** Ask the fleet to run one project/worktree sync pass now (window focus, group
 *  expand). Fire-and-forget, silent when disconnected, throttled to one per 5s. */
export function syncProjects(): void {
	if (!isConnected()) return;
	const now = Date.now();
	if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;
	lastSyncAt = now;
	void sendCommand({
		type: "sync_projects",
		id: crypto.randomUUID(),
	} satisfies ClientCommand).catch(() => {});
}

/** Open the New workspace popover for a project (owned by the group header "+"). */
export function openNewWorkspace(projectId: string): void {
	setState("newWorkspaceProjectId", projectId);
}

export function closeNewWorkspace(): void {
	setState("newWorkspaceProjectId", null);
}

/** Scroll to and flash a project group. ProjectGroups clears the flag when the
 *  group's flash animation ends (afterMotion), so the flash length lives only in CSS. */
export function highlightProject(projectId: string): void {
	setState("highlightProjectId", projectId);
}

/** Stop + evict the worktree's session and git-remove the linked worktree. `deleteBranch`
 *  names the branch to also delete (the fleet re-checks it is still the checked-out,
 *  unprotected branch). Clean only; a refusal surfaces as an error frame. */
export function sendDeleteWorktree(
	workspaceId: string,
	opts: { deleteBranch?: string } = {},
): void {
	if (refuseIfDisconnected()) return;
	// A refusal arrives as an uncorrelated error frame that only registers when the text
	// changes: drop the stale one so this delete's own refusal always registers (it clears
	// the pending dim below via ProjectGroups, and fills the clone dialog's refusal).
	setState("error", null);
	setDeletePendingIds((prev) => new Set(prev).add(workspaceId));
	void sendCommand({
		type: "delete_worktree",
		id: crypto.randomUUID(),
		workspaceId,
		...(opts.deleteBranch !== undefined ? { deleteBranch: opts.deleteBranch } : {}),
	} satisfies ClientCommand).catch((err: unknown) => {
		clearDeletePending(workspaceId);
		reportCommandFailure(err);
	});
}

/** Pull guard evidence for the delete-worktree confirm; the answer lands in
 *  state.worktreeDeleteInfo[workspaceId] (worktree_delete_info unicast). */
export function sendWorktreeDeleteInfo(workspaceId: string): void {
	if (refuseIfDisconnected()) return;
	void sendCommand({
		type: "worktree_delete_info",
		id: crypto.randomUUID(),
		workspaceId,
	} satisfies ClientCommand).catch(reportCommandFailure);
}

/** Toast copy for a fetch-into-project answer. */
function fetchOutcomeText(result: CloneFetchResult): string {
	const into = `into ${result.projectPath}`;
	switch (result.outcome) {
		case "created":
			return `Created branch ${result.branch} ${into}`;
		case "updated":
			return `Fast-forwarded ${result.branch} ${into}`;
		case "up-to-date":
			return `${result.branch} is already up to date ${into}`;
	}
}

/** POST /ctl/clones/:id/fetch-into-project: fetch a local-source clone's branch into
 *  its project's main repo (create or fast-forward only; the fleet refuses anything
 *  else). Success and the fleet's refusal reason both surface as toasts. Resolves
 *  true when the branch landed (or was already there). */
export async function fetchCloneIntoProject(workspaceId: string): Promise<boolean> {
	try {
		const res = await (state.authStatus !== "disabled" ? authedFetch : fetch)(
			`/ctl/clones/${encodeURIComponent(workspaceId)}/fetch-into-project`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		if (!res.ok) {
			pushToast(`Fetch into project refused: ${await ctlError(res)}`, { durationMs: 12_000 });
			return false;
		}
		pushToast(fetchOutcomeText((await res.json()) as CloneFetchResult));
		return true;
	} catch (err) {
		pushToast(`Fetch into project failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// /ctl/fs/browse, the fleet edge's directory listing behind the Add project
// folder chooser (AddProjectDialog). Raw GET like the ctl fetchers in
// transport.ts, but living here with the project domain.
// ---------------------------------------------------------------------------

export interface FsBrowseDir {
	name: string;
	path: string;
	hasGit: boolean;
}

/** 200 answer of GET /ctl/fs/browse (fleet edge contract). */
export interface FsBrowseResult {
	/** Realpath-canonicalized absolute path actually listed. */
	path: string;
	/** Null at the filesystem root. */
	parent: string | null;
	/** Subdirectories only, name-sorted; dot-directories are never listed. */
	dirs: FsBrowseDir[];
	/** True when the listing was capped at 500 entries. */
	truncated: boolean;
}

/** GET /ctl/fs/browse?path=… returns the subdirectory listing for the
 *  onboarding dir pickers. `path` may be absolute, "~", or "~/rel" (all
 *  expanded edge-side); omitted → the fleet host's home directory. 400
 *  answers carry the edge's reason as { error }, surfaced verbatim (missing
 *  dir, not-a-directory, unreadable). */
export async function fetchFsBrowse(path?: string): Promise<FsBrowseResult> {
	const url =
		path === undefined ? "/ctl/fs/browse" : `/ctl/fs/browse?${new URLSearchParams({ path })}`;
	const res = await ctlFetch(
		url,
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => `directory browse failed (${s})`,
		async (r) => {
			const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
			return typeof body?.error === "string" ? body.error : `directory browse failed (${r.status})`;
		},
	);
	return (await res.json()) as FsBrowseResult;
}

/** GET /ctl/fs/recent-roots answer: Git roots of recent omp sessions, newest first, then registered roots. */
export interface RecentRootsResult {
	roots: Array<{ path: string; registered: boolean }>;
}

/** Recent Git roots for the Add-project path autocomplete (read-only fleet route). */
export async function fetchRecentRoots(): Promise<RecentRootsResult> {
	const res = await ctlFetch(
		"/ctl/fs/recent-roots",
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => `recent roots failed (${s})`,
	);
	return (await res.json()) as RecentRootsResult;
}

// ---------------------------------------------------------------------------
// The omp setup probe (FLEET-20).

/** GET /ctl/omp-setup: read-only omp install, provider-auth, and default-model
 *  probe for the empty roster's sign-in prompt. Never writes fleet config. */
export async function fetchOmpSetup(): Promise<OmpSetupStatus> {
	const res = await ctlFetch(
		"/ctl/omp-setup",
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => `omp setup check failed (${s})`,
	);
	return (await res.json()) as OmpSetupStatus;
}
