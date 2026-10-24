/**
 * Fleet operations: the one implementation of every roster and workspace
 * mutation that both transports expose. The browser edge (command table in
 * edge-commands.ts, answered as frames) and the control API (`/ctl/*` in
 * server.ts, answered as HTTP) parse their own wire shapes, then call the
 * matching method here. Validation that has a semantic meaning (NUL in names,
 * clone source shape, linked/clean worktree guards, unknown ids,
 * clone refusals), the stop/evict sequencing, and the result shapes live here
 * once, so a rule fixed for one transport cannot be missed on the other.
 *
 * A failure with a client-visible meaning throws {@link OperationError}: its
 * `status` is the HTTP class (the edge ignores it and shows the message; the
 * control API answers with it). Anything else is unexpected and propagates.
 *
 * Browser pipe teardown is announced here, not performed: a method that stops,
 * removes or deletes a daemon calls the {@link FleetOperations.onDetach}
 * listeners at the point a browser attached to it must drop its pipe (a
 * stopped pair would otherwise surface a phantom "daemon connection lost").
 */

import type { CloneCreateInput } from "./workspace-lifecycle";
import type { FleetConfig } from "./config";
import { validateProjectPath } from "./discovery";
import type { FleetEventLog } from "./events";
import type { Registry, RegistryEntry } from "./registry";
import type { CloneFetchResult, RegisteredProject } from "#lib/wire/protocol";
import type { ProjectSync } from "./project-sync";
import type { LifecycleApi } from "./workspace-lifecycle";
import {
	createWorktree,
	deleteWorktree,
	projectIdForCwd,
	registerProjectMainEntry,
	registerWorktreeEntry,
	resolveProjectRoot,
	WorktreeDirtyError,
	WorktreeTargetExistsError,
	worktreeDeleteInfo,
	type CreateWorktreeResult,
	type DeleteWorktreeResult,
	type WorktreeDeleteInfo,
} from "./worktrees";

/** An error whose message is safe to show the caller; `status` is its HTTP class. */
export class OperationError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Single eviction path for non-clone roster rows (FLC-22), implemented by the
 * server (`#evictRow` / `#evictProject`), which owns the pair watch, log tap,
 * and store-orphan marker a removal must also clear. `evictRow` prunes the
 * session, runs `removal`, and drops the row only once `removal` resolves
 * (FLC-21: a rejecting `removal` leaves the row registered).
 */
export interface RowEvictionHooks {
	evictRow<T>(daemonId: string, removal: () => Promise<T>): Promise<T>;
	evictProject(projectId: string): Promise<void>;
}

/** Result of the verified clone delete gate. */
export interface CloneDeleteResult {
	removed: string;
	verified: string[];
}

/**
 * The lifecycle verbs the operations layer drives. Every runtime transition
 * (spawn, stop, verified clone delete, create, fetch) goes through the
 * lifecycle owner, which dispatches on the workspace kind: operations never
 * stop, remove or delete a runtime any other way, so the provider lifecycle,
 * admission and the verify-at-deletion gate cannot be bypassed.
 */
export type OperationsLifecycle = Pick<
	LifecycleApi,
	| "spawnHost"
	| "start"
	| "stop"
	| "delete"
	| "resolveTemplateName"
	| "createClone"
	| "fetchCloneIntoProject"
>;

export interface OperationsDeps {
	registry: Registry;
	lifecycle: OperationsLifecycle;
	sync: Pick<ProjectSync, "syncNow">;
	config: Pick<FleetConfig, "workspaceDir">;
	eventLog: FleetEventLog;
	eviction: RowEvictionHooks;
}

/** Result of addProject: `entry` is the new main-checkout row (absent for an already registered checkout). */
export interface AddProjectResult {
	project: RegisteredProject;
	existing: boolean;
	entry?: RegistryEntry;
}

/** Result of deleteWorkspace: the clone gate's verification, or the worktree removal. */
export type DeleteWorkspaceResult =
	| CloneDeleteResult
	| { removed: string; worktree: DeleteWorktreeResult };

/**
 * Validate a create_clone `source` (when given): an object with exactly one
 * non-empty member of local/remote/remoteName. Returns that single member.
 * Throws OperationError(400) with the bare message; each transport adds its
 * own command prefix. Shared by the edge command table and the control API.
 */
export function parseCloneSource(raw: unknown): CloneCreateInput["source"] {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new OperationError(400, "source must be an object");
	}
	const fields = raw as Record<string, unknown>;
	const given = (["local", "remote", "remoteName"] as const)
		.map((key) => [key, fields[key]] as const)
		.filter(([, value]) => typeof value === "string" && value !== "");
	if (given.length !== 1) {
		throw new OperationError(400, "source must set exactly one of local, remote, or remoteName");
	}
	return Object.fromEntries(given) as CloneCreateInput["source"];
}

export class FleetOperations {
	readonly #registry: Registry;
	readonly #lifecycle: OperationsLifecycle;
	readonly #sync: Pick<ProjectSync, "syncNow">;
	readonly #config: Pick<FleetConfig, "workspaceDir">;
	readonly #eventLog: FleetEventLog;
	readonly #eviction: RowEvictionHooks;
	readonly #detachListeners = new Set<(daemonId: string) => void>();

	constructor(deps: OperationsDeps) {
		this.#registry = deps.registry;
		this.#lifecycle = deps.lifecycle;
		this.#sync = deps.sync;
		this.#config = deps.config;
		this.#eventLog = deps.eventLog;
		this.#eviction = deps.eviction;
	}

	/**
	 * Subscribe to "stop talking to this daemon" notices (browser pipes). Fired
	 * by stop, remove, delete and remove-project at the point a browser attached
	 * to the daemon must drop its pipe. Returns the unsubscribe function.
	 */
	onDetach(listener: (daemonId: string) => void): () => void {
		this.#detachListeners.add(listener);
		return () => {
			this.#detachListeners.delete(listener);
		};
	}

	#detach(daemonId: string): void {
		for (const listener of this.#detachListeners) listener(daemonId);
	}

	#entry(daemonId: string): RegistryEntry {
		const entry = this.#registry.get(daemonId);
		if (!entry) throw new OperationError(404, `unknown daemon: ${daemonId}`);
		return entry;
	}

	/**
	 * Spawn a session for `cwd`. A cwd that belongs to a registered project
	 * (main checkout or linked worktree) is tagged with that projectId so the
	 * roster groups it; an unregistered path stays untagged.
	 */
	async spawn(input: { cwd: string; template?: string; name?: string }): Promise<RegistryEntry> {
		if (input.name !== undefined && input.name.includes("\0")) {
			throw new OperationError(400, "invalid field: name must not contain NUL");
		}
		const resolved = await validateProjectPath(input.cwd);
		if (resolved === null) throw new OperationError(400, `not a directory: ${input.cwd}`);
		const entry = await this.#lifecycle.spawnHost({
			cwd: resolved,
			template: input.template,
			name: input.name,
		});
		const projectId = await projectIdForCwd(this.#registry.projects(), resolved);
		if (projectId !== undefined) this.#registry.update(entry.daemonId, { projectId });
		return this.#registry.get(entry.daemonId) ?? entry;
	}

	/**
	 * Stop a daemon, leaving its row asleep, through the lifecycle's stop verb
	 * (the same call for every kind; the lifecycle picks the proof-bearing
	 * provider stop or the host child stop and keeps a failed stop from
	 * leaving the row "ready"). Browsers detach first.
	 */
	async stop(daemonId: string): Promise<void> {
		this.#entry(daemonId);
		this.#detach(daemonId);
		await this.#lifecycle.stop(daemonId);
	}

	/**
	 * Remove a daemon's row. A clone routes through the verified deletion gate
	 * (never registry.remove: dropping the roster identity unverified would
	 * orphan or lose the volume/store silently); its browsers detach only after
	 * the gate passes, so a refusal keeps live attachments. Anything else is
	 * detached, stopped and evicted through the single eviction path (the guards
	 * and the row removal around `lifecycle.delete`).
	 */
	async remove(daemonId: string): Promise<{ verified: string[] }> {
		const entry = this.#entry(daemonId);
		let verified: string[] = [];
		if (entry.workspace?.kind === "clone") {
			verified = (await this.#lifecycle.delete(daemonId)).verified;
			this.#detach(daemonId);
		} else {
			this.#detach(daemonId);
			await this.#eviction.evictRow(daemonId, async () => {});
		}
		this.#eventLog.add("info", "server", "removed", daemonId);
		return { verified };
	}

	/**
	 * Register the main checkout behind `path` (a main checkout, a linked
	 * worktree, or a subdirectory; bare and non-git paths are refused). A
	 * checkout that is already registered changes nothing (`existing`). A new
	 * project gets its main-checkout row (spawned only with `start`, asleep
	 * otherwise). Staged: registration happens first, so a failed spawn reports
	 * 500 naming the stage while the project stays registered.
	 */
	async addProject(input: {
		path: string;
		start?: boolean;
		template?: string;
	}): Promise<AddProjectResult> {
		let mainPath: string;
		try {
			mainPath = await resolveProjectRoot(input.path);
		} catch (err) {
			throw new OperationError(400, err instanceof Error ? err.message : String(err));
		}
		let registered: { project: RegisteredProject; existing: boolean };
		try {
			registered = this.#registry.addProject(mainPath);
		} catch (err) {
			throw new OperationError(400, err instanceof Error ? err.message : String(err));
		}
		const { project, existing } = registered;
		if (existing) {
			this.#sync.syncNow();
			return { project, existing: true };
		}
		let entry: RegistryEntry;
		try {
			entry = await registerProjectMainEntry(this.#registry, this.#lifecycle, project, {
				start: input.start ?? false,
				template: input.template,
			});
		} catch (err) {
			throw new OperationError(
				500,
				`project ${project.projectId} registered, spawn failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.#sync.syncNow();
		return { project, existing: false, entry };
	}

	/**
	 * Deregister a project and drop all of its rows (never touches disk).
	 * Running rows are shut down and their pair revoked; transcripts are kept.
	 * Refused (409) while a clone workspace still belongs to the project; that
	 * check runs before any row is stopped.
	 */
	async removeProject(projectId: string): Promise<void> {
		if (!this.#registry.projects().some((p) => p.projectId === projectId)) {
			throw new OperationError(404, `unknown project id: ${projectId}`);
		}
		const rows = this.#registry.list().filter((entry) => entry.projectId === projectId);
		const cloneIds = rows
			.filter((entry) => entry.workspace?.kind === "clone")
			.map((entry) => entry.daemonId);
		if (cloneIds.length > 0) {
			throw new OperationError(
				409,
				`project ${projectId} has clone workspaces: ${cloneIds.join(", ")}`,
			);
		}
		for (const row of rows) this.#detach(row.daemonId);
		await this.#eviction.evictProject(projectId);
	}

	/**
	 * git worktree add under workspaceDir for a registered project (branch =
	 * slugified name; `existingBranch` attaches instead), then the roster row
	 * (spawned only with `start`). Staged: a failure names its stage; a created
	 * worktree that never gets a row is picked up by the next project sync.
	 */
	async createWorktree(
		projectId: string,
		input: { name: string; baseRef?: string; existingBranch?: string; start?: boolean },
	): Promise<RegistryEntry> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) throw new OperationError(404, `unknown project: ${projectId}`);
		let created: CreateWorktreeResult;
		try {
			created = await createWorktree(project, input.name, {
				workspaceDir: this.#config.workspaceDir,
				baseRef: input.baseRef,
				existingBranch: input.existingBranch,
			});
		} catch (err) {
			throw new OperationError(
				err instanceof WorktreeTargetExistsError ? 409 : 400,
				`create worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		let entry: RegistryEntry;
		try {
			entry = await registerWorktreeEntry(this.#registry, this.#lifecycle, project, created.path, {
				start: input.start,
			});
		} catch (err) {
			throw new OperationError(
				500,
				`register worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.#eventLog.add(
			"info",
			"server",
			`worktree created ${created.path} (${created.branch})`,
			entry.daemonId,
		);
		return entry;
	}

	/**
	 * Guard evidence (linked, dirty, branch state) for a worktree delete
	 * confirmation. Never deletes. A clone has no git-worktree guard facts (its
	 * checkout is a provider volume, not a fleet-local cwd): its evidence rides
	 * the roster's lifecycleStage/lifecycleError, so this answers 400 for it.
	 */
	async worktreeDeleteInfo(daemonId: string): Promise<WorktreeDeleteInfo> {
		const entry = this.#entry(daemonId);
		if (entry.workspace?.kind === "clone") {
			throw new OperationError(
				400,
				"clone deletion guard evidence rides lifecycleStage/lifecycleError",
			);
		}
		return await worktreeDeleteInfo(entry);
	}

	/**
	 * Delete a workspace. A clone runs the lifecycle's verify-at-deletion gate
	 * (never the git guards, which reason about a fleet-local cwd). Anything
	 * else is a worktree: the linked-worktree and clean-tree guards (403 not
	 * linked / 409 dirty; never --force) run BEFORE any mutation, so a refusal
	 * leaves the daemon and roster untouched. Then the daemon is detached,
	 * stopped, git-removed (optionally `git branch -d`), and evicted only once
	 * the removal succeeded. Transcripts live under the agent dir and survive.
	 */
	async deleteWorkspace(
		daemonId: string,
		opts: { deleteBranch?: string } = {},
	): Promise<DeleteWorkspaceResult> {
		const entry = this.#entry(daemonId);
		if (entry.workspace?.kind === "clone") {
			// The verified gate (never the git guards, which reason about a
			// fleet-local cwd), then the browsers detach.
			const result = await this.#lifecycle.delete(daemonId);
			this.#detach(daemonId);
			return result;
		}
		const path = entry.cwd ?? "";
		const info = await worktreeDeleteInfo(entry);
		if (!info.linked) {
			throw new OperationError(403, info.reason ?? `not a linked worktree: ${path}`);
		}
		if (info.dirty) {
			throw new OperationError(409, info.reason ?? `worktree has uncommitted changes: ${path}`);
		}
		this.#detach(daemonId);
		let deleted: DeleteWorktreeResult;
		try {
			deleted = await this.#eviction.evictRow(daemonId, () =>
				deleteWorktree(entry, { deleteBranch: opts.deleteBranch }),
			);
		} catch (err) {
			if (err instanceof WorktreeDirtyError) throw new OperationError(409, err.message);
			throw new OperationError(
				500,
				`delete worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.#eventLog.add(
			"info",
			"server",
			`worktree deleted ${deleted.path}${deleted.branch !== undefined ? ` (${deleted.branch})` : ""}`,
			daemonId,
		);
		return { removed: daemonId, worktree: deleted };
	}

	/**
	 * Create (and optionally start) a clone workspace through the lifecycle:
	 * the SAME create for the control API and the browser command. Lifecycle
	 * failures (CloneLifecycleError) propagate unchanged: each transport maps
	 * them to its own status, so this module never depends on the lifecycle
	 * module at runtime.
	 */
	async createClone(input: CloneCreateInput): Promise<RegistryEntry> {
		const entry = await this.#lifecycle.createClone(input);
		this.#eventLog.add("info", "server", `clone created ${entry.daemonId}`, entry.daemonId);
		return entry;
	}

	/**
	 * Fetch a local-source clone's branch into its project through the
	 * lifecycle (git runs only there, never in a handler). Refusals
	 * (CloneLifecycleError) propagate for each transport to map.
	 */
	async fetchCloneIntoProject(daemonId: string): Promise<CloneFetchResult> {
		this.#entry(daemonId);
		return await this.#lifecycle.fetchCloneIntoProject(daemonId);
	}
}
