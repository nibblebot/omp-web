import type { ClientCommand, ProjectBranch, ProjectEntry } from "../../shared/protocol";
import { setState } from "../state";
import { isConnected, postCommand } from "./transport";

/**
 * Projects/onboarding domain (Phase 3 store facade split): fleet-edge
 * project/worktree/daemon senders and their latest-wins pending slots. All
 * fire-and-forget — answers ride the registered_projects / roster /
 * worktree_delete_info broadcasts and error frames. The registered-projects /
 * worktreeDeleteInfo mirrors live in state.ts alongside the mux.
 */

// ---------------------------------------------------------------------------
// Phase 3 fleet edge: roster-mode command senders. spawn/spawn_resume/
// stop are fire-and-forget — results arrive as roster + daemon_status
// broadcasts (spawn failures surface as an error frame). list_projects is a
// latest-wins pull like listSessions (the edge answers with one `projects`
// frame).
// ---------------------------------------------------------------------------
let pendingProjects: ((projects: ProjectEntry[]) => void) | null = null;

/** Settle the latest-wins list_projects waiter (mux "projects" frame). */
export function settleProjects(projects: ProjectEntry[]): void {
	pendingProjects?.(projects);
	pendingProjects = null;
}

/** Latest-wins pull like listProjects, keyed by projectId: the edge answers
 *  list_project_branches with one `project_branches` unicast frame, so a
 *  superseded request is resolved [] immediately (its frame, if it arrives,
 *  carries the OLD projectId and is left pending). */
let pendingBranches: { projectId: string; resolve: (branches: ProjectBranch[]) => void } | null =
	null;

/** Settle the keyed list_project_branches waiter (mux "project_branches" frame). */
export function settleProjectBranches(projectId: string, branches: ProjectBranch[]): void {
	if (pendingBranches && pendingBranches.projectId === projectId) {
		pendingBranches.resolve(branches);
		pendingBranches = null;
	}
}

/** Resolve both waiters empty (stream teardown in state.ts). */
export function resetPendingProjects(): void {
	pendingProjects?.([]);
	pendingProjects = null;
	pendingBranches?.resolve([]);
	pendingBranches = null;
}

export function listProjects(): Promise<ProjectEntry[]> {
	const { promise, resolve, reject } = Promise.withResolvers<ProjectEntry[]>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingProjects?.([]);
	pendingProjects = resolve;
	postCommand({ type: "list_projects", id: crypto.randomUUID() } satisfies ClientCommand).catch(
		(err) => {
			// Latest-wins: only clear the slot if a newer request hasn't claimed it.
			if (pendingProjects === resolve) pendingProjects = null;
			reject(err instanceof Error ? err : new Error(String(err)));
		},
	);
	return promise;
}

/** List the local branches of a registered project (feeds the add-worktree
 *  branch picker; checkedOut branches cannot be checked out again). */
export function listProjectBranches(projectId: string): Promise<ProjectBranch[]> {
	const { promise, resolve, reject } = Promise.withResolvers<ProjectBranch[]>();
	if (!isConnected()) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingBranches?.resolve([]);
	pendingBranches = { projectId, resolve };
	postCommand({
		type: "list_project_branches",
		id: crypto.randomUUID(),
		projectId,
	} satisfies ClientCommand).catch((err) => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingBranches?.resolve === resolve) pendingBranches = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Spawn a new daemon from a repo/worktree path (validated edge-side; the
 *  resulting entry appears in the roster as it transitions spawning → ready). */
export function spawnDaemon(cwd: string, template?: string, labels?: string[]): void {
	if (!isConnected()) return;
	void postCommand({
		type: "spawn",
		id: crypto.randomUUID(),
		cwd,
		...(template !== undefined ? { template } : {}),
		...(labels !== undefined ? { labels } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Wake an asleep daemon (spawned → respawn --resume; attached/remote → redial). */
export function spawnResume(daemonId: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "spawn_resume",
		id: crypto.randomUUID(),
		daemonId,
	} satisfies ClientCommand).catch(() => {});
}

/** Stop a daemon (spawned → terminate child; attached/remote → drop + asleep). */
export function stopDaemonById(daemonId: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "stop",
		id: crypto.randomUUID(),
		daemonId,
	} satisfies ClientCommand).catch(() => {});
}

/** Stop a daemon AND evict it from the fleet roster (registry removal). */
export function removeDaemonById(daemonId: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "remove",
		id: crypto.randomUUID(),
		daemonId,
	} satisfies ClientCommand).catch(() => {});
}

// ---------------------------------------------------------------------------
// Phase 5: project/worktree onboarding senders. All fire-and-forget like the
// senders above — answers ride the registered_projects / roster /
// worktree_delete_info broadcasts and error frames. A `start: true` sender
// also ARMS the post-attach session-picker gate: the spawned daemon's id is
// server-assigned and unknowable here, so the gate is set to a sentinel and
// requestAttach stamps the real daemonId when the onboarding attach fires.
// ---------------------------------------------------------------------------

/** Sentinel value of pendingSessionPicker between a start:true sender and the
 *  attach that follows; never equals a real daemonId. */
const PICKER_GATE_ARMED = "__picker_gate_armed__";

/** Register a first-class project with the fleet (realpath-keyed, deduped
 *  edge-side). start:true also spawns a daemon on the main checkout and
 *  arms the post-attach picker gate. */
export function sendAddProject(
	path: string,
	opts: { start?: boolean; template?: string; labels?: string[] } = {},
): void {
	if (!isConnected()) return;
	if (opts.start === true) setState("pendingSessionPicker", PICKER_GATE_ARMED);
	void postCommand({
		type: "add_project",
		id: crypto.randomUUID(),
		path,
		...(opts.start !== undefined ? { start: opts.start } : {}),
		...(opts.template !== undefined ? { template: opts.template } : {}),
		...(opts.labels !== undefined ? { labels: opts.labels } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Deregister a first-class project; refused edge-side (error frame) while
 *  any daemon references it. */
export function sendRemoveProject(projectId: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "remove_project",
		id: crypto.randomUUID(),
		projectId,
	} satisfies ClientCommand).catch(() => {});
}

/** Create a managed worktree under workspaceDir (branch = slugified name
 *  unless baseRef/existingBranch override) and optionally spawn a daemon on
 *  it (start:true arms the post-attach picker gate). */
export function sendCreateWorktree(
	projectId: string,
	name: string,
	opts: { baseRef?: string; existingBranch?: string; start?: boolean } = {},
): void {
	if (!isConnected()) return;
	if (opts.start === true) setState("pendingSessionPicker", PICKER_GATE_ARMED);
	void postCommand({
		type: "create_worktree",
		id: crypto.randomUUID(),
		projectId,
		name,
		...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
		...(opts.existingBranch !== undefined ? { existingBranch: opts.existingBranch } : {}),
		...(opts.start !== undefined ? { start: opts.start } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Register an existing discovered worktree of a project and optionally
 *  spawn a daemon on it (start:true arms the post-attach picker gate). */
export function sendAddExistingWorktree(
	projectId: string,
	worktreePath: string,
	opts: { start?: boolean } = {},
): void {
	if (!isConnected()) return;
	if (opts.start === true) setState("pendingSessionPicker", PICKER_GATE_ARMED);
	void postCommand({
		type: "add_worktree",
		id: crypto.randomUUID(),
		projectId,
		worktreePath,
		...(opts.start !== undefined ? { start: opts.start } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Stop + evict the worktree's daemon and git-remove the managed worktree
 *  (deleteBranch:true also `git branch -d`s it). Owned+clean only — a
 *  refusal surfaces as an error frame. */
export function sendDeleteWorktree(daemonId: string, opts: { deleteBranch?: boolean } = {}): void {
	if (!isConnected()) return;
	void postCommand({
		type: "delete_worktree",
		id: crypto.randomUUID(),
		daemonId,
		...(opts.deleteBranch !== undefined ? { deleteBranch: opts.deleteBranch } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Pull guard evidence for the delete-worktree confirm; the answer lands in
 *  state.worktreeDeleteInfo[daemonId] (worktree_delete_info unicast). */
export function sendWorktreeDeleteInfo(daemonId: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "worktree_delete_info",
		id: crypto.randomUUID(),
		daemonId,
	} satisfies ClientCommand).catch(() => {});
}
