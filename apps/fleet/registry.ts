/**
 * Daemon registry for the omp-fleet: the persistent, insertion-ordered
 * roster of daemons with monotonic `dN` id allocation that survives
 * restarts, plus the first-class registered `projects[]` (realpath-keyed,
 * `pN` ids) that project groups hang off.
 *
 * State is a JSON file
 * `{ "nextId": number, "entries": RegistryEntry[], "projects"?: RegisteredProject[], "nextProjectId"?: number }`;
 * the path is injectable for tests; the fleet server resolves
 * `OMP_FLEET_STATE` / `~/.omp-web/fleet-state.json` and passes it in. Files
 * written before projects existed lack the two new keys and load fine
 * (projects start empty, the counter at 1).
 *
 * Mutations apply in memory at once and fire `onChange` with the roster rows
 * they changed (the edge server broadcasts that delta); project-set mutations
 * also fire `onProjectsChange`. Writes are coalesced: each mutation arms one
 * write, so a burst shares it. Volatile-only updates (status, pid, git and
 * title facts, all re-derived at boot) wait longer. `flush()` writes now; the
 * fleet server calls it on close and on process exit.
 *
 * A write is durable and atomic: the new state goes to a sibling tmp file that
 * is fsynced; the current state file is first copied to `<state>.bak`; the tmp
 * file is renamed over the state file; the directory is fsynced. `load()` falls
 * back to the `.bak` when the state file is unreadable or malformed.
 */

import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	DaemonEntry,
	DaemonStatus,
	DesiredState,
	RegisteredProject,
	WorkspaceKind,
} from "#lib/wire/protocol";
import type { CallbackErrorCode } from "#lib/wire/callback-protocol";
import { expandTilde } from "./config";

/**
 * How long an enrolled session may stay unpaired after a control-plane boot
 * before it is shown asleep. A session that redials inside this window keeps
 * its status; the lifecycle owns the status of sessions it launches.
 */
export const REDIAL_GRACE_MS = 45_000;

/**
 * How long a ready session may stay unpaired before it is shown
 * "reconnecting". A voluntary byte renewal or a brief re-dial re-pairs well
 * inside this window, so the roster does not flicker; a drop that outlasts it
 * is a real outage.
 */
export const PAIR_LOSS_GRACE_MS = 5_000;

/**
 * Workspace identity unions, re-exported for fleet/registry consumers. The
 * canonical definitions live in lib/wire/protocol.ts, the shared leaf that
 * already feeds DaemonEntry/RegisteredProject to this file. Defining them
 * here instead would make the wire types (or this file's importers) depend
 * on a fleet-internal module; re-exporting keeps one source and the
 * registry-facing export surface.
 */
export type { WorkspaceKind, DesiredState };

/**
 * Deletion-gate error codes: the frozen ledger vocabulary.
 */
export type DeletionErrorCode = CallbackErrorCode;

/** Typed deletion-gate failure persisted on the workspace record. */
export interface DeletionGateError {
	code: DeletionErrorCode;
	message: string;
	/** Store path the failure names (a session subtree or stream file), when applicable. */
	path?: string;
}

/**
 * Per-entry verify-at-deletion state (P7.3). Absent = never deleted.
 *
 * Lifecycle: a delete request enters "deleting" (gate in flight; the roster
 * identity is NEVER removed early; cleanup state remains until the whole
 * transition finishes and survives fleet restart). A failed gate persists
 * "delete-pending-retry" with the typed error; the workspace, its volume,
 * and its (still writable) store are all retained, and a retry re-enters
 * "deleting". On success the store flips read-only, provider resources are
 * deleted, and only then does the roster entry transition away (removal by
 * the caller; a "deleted" entry is a removed identity whose verified store
 * is served view-only by Retention).
 */
export interface WorkspaceDeletion {
	/** "deleting" (gate in flight) | "delete-pending-retry" (blocked; retry by deleting again). */
	state: "deleting" | "delete-pending-retry";
	/** Epoch ms of the delete request that entered the current state. */
	requestedAt: number;
	/** Why the gate blocked (present on "delete-pending-retry"). */
	error?: DeletionGateError;
	/** Provider resources still present after a partial post-verification provider deletion (retry-able; never a full-volume promise). */
	remainingResources?: string[];
}

/**
 * Registry-level marker for a workspace deleted WITHOUT a passed
 * verification gate whose log-store subtree survives. Persisted separately
 * from the roster entry because the legacy removal paths drop the identity:
 * the marker is what Retention reports after the entry is gone. Cleared only
 * by the explicit manual purge.
 */
export interface StoreOrphanMarker {
	/** Epoch ms when the marker was persisted. */
	at: number;
	/** Why the workspace was deleted without verification. */
	reason?: string;
	/**
	 * Clone provenance retained for P8.10 resume-onto-fresh-clone: the
	 * workspace record's source + pinnedRevision, captured at removal. The
	 * roster identity is dropped on deletion, so this is the ONLY place the
	 * provenance survives for an orphaned clone workspace.
	 */
	provenance?: { source?: { local?: string; remote?: string }; pinnedRevision?: string };
}

/**
 * Persisted callback-enrollment binding (restart survival): ONLY the
 * SHA-256 hex digest of the 256-bit enrollment credential plus its
 * generation; the raw credential is never persisted. Fleet-private like
 * the rest of the workspace record: never serialized into roster frames,
 * registered_projects frames, or /ctl/debug.
 */
export interface WorkspaceEnrollment {
	/** SHA-256 hex digest of the enrollment credential. */
	credentialHash: string;
	generation: number;
}

/**
 * Fleet-private workspace lifecycle record riding RegistryEntry. The whole
 * record, including the opaque `providerHandle` and the deletion state,
 * is fleet-private: never serialize it into roster frames,
 * registered_projects frames, or /ctl/debug; the edge maps the public
 * projection explicitly.
 */
export interface WorkspaceRecord {
	kind: WorkspaceKind;
	projectId: string;
	/** Clone sources; for local worktrees, local is the canonical owning repository path. */
	source?: { local?: string; remote?: string };
	/** Resolved commit, pinned once. */
	pinnedRevision?: string;
	/** Derived from the workspace name (clone workspaces). */
	branch?: string;
	/** Clone workspaces only. */
	profileId?: string;
	desiredState: DesiredState;
	/** Absent = unmanaged. */
	authorizedGeneration?: number;
	/** Private, opaque provider-owned state. */
	providerHandle?: unknown;
	/** Verify-at-deletion state (P7.3). Absent = never deleted. */
	deletion?: WorkspaceDeletion;
	/** Persisted callback enrollment (digest only). Absent = not enrolled. */
	enrollment?: WorkspaceEnrollment;
}

/** A roster entry: DaemonEntry plus fleet-side registration data. */
export interface RegistryEntry extends DaemonEntry {
	/** Current git branch of the session cwd for local entries; set by ProjectSync's git-state polling. */
	branch?: string;
	/** git dirty-state file counts; set by ProjectSync's git-state polling (absent until the first successful probe). */
	git?: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
	/** Title of the daemon's last session file; set by ProjectSync's git-state polling probe. */
	sessionTitle?: string;
	/** True when the daemon's last session file has no messages (new/empty session);
	 *  set alongside sessionTitle by ProjectSync's git-state polling probe. */
	sessionEmpty?: boolean;
	/**
	 * True once the daemon reported (`state.sessionPersisted`) that `lastSessionFile`
	 * is on disk. Absent means unknown or not yet written: a relaunch then adopts the
	 * path (`--resume-unwritten`) instead of failing strictly. Reset whenever
	 * lastSessionFile changes.
	 */
	lastSessionPersisted?: true;
	/** Spawned entries: the template name they were spawned from. */
	template?: string;
	registeredAt: number;
	/**
	 * Fleet-private P1 workspace record: lifecycle, provider handle,
	 * cleanup/archive state. Never serialized into roster frames,
	 * registered_projects frames, or /ctl/debug.
	 */
	workspace?: WorkspaceRecord;
}

/** On-disk shape of state.json. */
interface RegistryFile {
	nextId: number;
	entries: RegistryEntry[];
	/** First-class registered projects; absent in files written before Phase 2. */
	projects?: RegisteredProject[];
	/** Next `pN` project id; absent in files written before Phase 2. */
	nextProjectId?: number;
	/**
	 * Registry-level markers for workspaces deleted without a passed
	 * verification gate (P7.3/P7.5); absent in files written before the
	 * markers existed. Keyed by workspaceId.
	 */
	storeOrphans?: Record<string, StoreOrphanMarker>;
}

/** Roster rows one mutation changed: the source of the roster_delta broadcast. */
export interface RegistryChange {
	/** Rows created or changed, as they now stand in the registry. */
	upserted: RegistryEntry[];
	/** daemonIds removed from the registry. */
	removed: string[];
}

/** A parsed and validated state file, ready to install. */
interface LoadedState {
	entries: RegistryEntry[];
	nextId: number;
	projects: RegisteredProject[];
	nextProjectId: number;
	storeOrphans: Record<string, StoreOrphanMarker>;
}

/** Delay before a volatile-only mutation reaches disk. Durable mutations write on the next timer tick. */
const VOLATILE_PERSIST_DELAY_MS = 200;

/** Entry fields a mutation may touch without a durable write: boot reconcile and the git/session probes re-derive them. */
const VOLATILE_ENTRY_KEYS: Record<string, true> = {
	status: true,
	error: true,
	pid: true,
	readyAt: true,
	branch: true,
	git: true,
	sessionTitle: true,
	sessionEmpty: true,
};

/**
 * Legacy-inference base workspace record for entries persisted before P1.
 * Contract rule: managed or worktreeOf → "worktree"; every other entry
 * (spawned without worktreeOf) → "direct". desiredState is "running": a
 * legacy entry is a live roster row. projectId comes from the entry's
 * registered-project link ("" when absent). In-memory only: load() stamps
 * it and the entry's next mutation persists it; no rewrite at boot.
 * `managed` is the legacy persisted roster flag, read here only to infer
 * the kind of entries written before workspace records existed.
 */
function inferWorkspaceRecord(
	entry: Pick<RegistryEntry, "worktreeOf" | "projectId"> & { managed?: boolean },
): WorkspaceRecord {
	const kind = entry.managed || entry.worktreeOf !== undefined ? "worktree" : "direct";
	return {
		kind,
		projectId: entry.projectId ?? "",
		desiredState: "running",
	};
}

/** Realpath of `p` when it is an existing directory, else null (sync twin of validateProjectPath). */
function realpathIfDirectory(p: string): string | null {
	try {
		const resolved = realpathSync(expandTilde(p));
		return statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

/** fsync a file or directory by path (the durability half of the rename-based write). */
function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export class Registry {
	/**
	 * Fired after every mutation (not on load) with the roster rows it changed;
	 * set by the edge server for roster_delta broadcasts.
	 */
	onChange: ((change: RegistryChange) => void) | null = null;
	/**
	 * Fired after PROJECT-set mutations only (addProject/removeProject), not
	 * daemon mutations; set by the edge server for registered_projects
	 * broadcasts. Projects are rare mutations and the frame is re-derivable
	 * from stream priming, so broadcasts ride this dedicated hook instead of
	 * the every-mutation onChange.
	 */
	onProjectsChange: (() => void) | null = null;

	private readonly statePath: string;
	/**
	 * Test seam: invoked by the atomic persist after the sibling tmp file is
	 * written and before the rename, so a test can inject a failed save.
	 * Production never passes it (undefined = no-op).
	 */
	private readonly failBeforeRename: (() => void) | undefined;
	private entries: RegistryEntry[] = [];
	private nextId = 1;
	/** Registered projects in insertion order (public API: projects()). */
	private projectList: RegisteredProject[] = [];
	private nextProjectId = 1;
	/** Deleted-without-verification markers keyed by workspaceId (P7.5). */
	private storeOrphanList: Record<string, StoreOrphanMarker> = {};
	/** Pending coalesced write, armed by #schedule and cleared by flush(). */
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#flushDue = 0;
	/** True when the in-memory state is newer than the last successful write. */
	#dirty = false;
	/**
	 * False for the first write after a fallback load: the state file is then
	 * the corrupt one, so the good `.bak` must not be overwritten by it.
	 */
	#rotateBackup = true;
	/** True while the process exit hook is armed (exists only while a write is pending). */
	#exitHooked = false;
	/** Writes a pending state when the process exits without close() (process.exit skips timers). */
	readonly #onExit = (): void => {
		try {
			this.flush();
		} catch (err) {
			console.error(`fleet: registry write failed at ${this.statePath}: ${(err as Error).message}`);
		}
	};

	constructor(statePath: string, failBeforeRename?: () => void) {
		this.statePath = statePath;
		this.failBeforeRename = failBeforeRename;
	}

	/**
	 * Missing file → empty registry. Unreadable or malformed state file → the
	 * `.bak` kept by the last write (logged; rewritten by the next write). When
	 * the `.bak` is unusable too, throws with the path in the message.
	 */
	async load(): Promise<void> {
		if (!existsSync(this.statePath)) {
			this.#install({ entries: [], nextId: 1, projects: [], nextProjectId: 1, storeOrphans: {} });
			return;
		}
		let state: LoadedState;
		try {
			state = this.#parseFile(this.statePath);
		} catch (err) {
			const backup = `${this.statePath}.bak`;
			if (!existsSync(backup)) throw err;
			state = this.#parseFile(backup);
			console.error(
				`fleet: ${(err as Error).message}; restored the last good registry state from ${backup}`,
			);
			this.#rotateBackup = false;
			this.#schedule(0);
		}
		this.#install(state);
	}

	#install(state: LoadedState): void {
		this.entries = state.entries;
		this.nextId = state.nextId;
		this.projectList = state.projects;
		this.nextProjectId = state.nextProjectId;
		this.storeOrphanList = state.storeOrphans;
	}

	/** Write the pending state now. No-op when nothing changed. Throws on an I/O failure (the state stays pending). */
	flush(): void {
		if (!this.#dirty) return;
		if (this.#flushTimer !== null) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#persist();
		this.#dirty = false;
		if (this.#exitHooked) {
			process.off("exit", this.#onExit);
			this.#exitHooked = false;
		}
	}

	/** Insertion order. */
	list(): RegistryEntry[] {
		return [...this.entries];
	}

	get(daemonId: string): RegistryEntry | undefined {
		return this.entries.find((entry) => entry.daemonId === daemonId);
	}

	create(
		init: Omit<RegistryEntry, "daemonId" | "registeredAt" | "status"> & { status?: DaemonStatus },
	): RegistryEntry {
		const entry: RegistryEntry = {
			...init,
			daemonId: `d${this.nextId++}`,
			registeredAt: Date.now(),
			status: init.status ?? "spawning",
		};
		// create() is a mutation, so it stamps the legacy-inferred record when
		// init omits one; in-memory state then matches what a reload would
		// produce (load() inference covers files written before P1).
		if (entry.workspace === undefined) entry.workspace = inferWorkspaceRecord(entry);
		this.entries.push(entry);
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	update(daemonId: string, patch: Partial<RegistryEntry>): RegistryEntry {
		const index = this.#indexOf(daemonId);
		const entry = { ...this.entries[index], ...patch };
		this.entries[index] = entry;
		this.#mutated(
			{ upserted: [entry], removed: [] },
			Object.keys(patch).some((key) => !Object.hasOwn(VOLATILE_ENTRY_KEYS, key)),
		);
		return entry;
	}

	/**
	 * Replaces the fleet-private workspace record and persists. Throws on an
	 * unknown daemon id.
	 */
	setWorkspace(daemonId: string, record: WorkspaceRecord): RegistryEntry {
		const entry = this.#require(daemonId);
		entry.workspace = record;
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	/**
	 * Shallow-merges `patch` into the workspace record and persists;
	 * top-level keys replace wholesale (deletion/providerHandle are not
	 * deep-merged; use the dedicated deletion accessors for deletion-state
	 * transitions). Entries without a persisted record get the legacy-
	 * inferred base first. Throws on an unknown daemon id.
	 */
	updateWorkspace(daemonId: string, patch: Partial<WorkspaceRecord>): RegistryEntry {
		const entry = this.#require(daemonId);
		entry.workspace = { ...(entry.workspace ?? inferWorkspaceRecord(entry)), ...patch };
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	/**
	 * Replaces the deletion state on the workspace record and persists. The
	 * roster identity is never removed by deletion: the record stays on the
	 * entry so Retention/state survive restart. Throws on an unknown daemon
	 * id or an entry without a workspace record.
	 */
	setWorkspaceDeletion(daemonId: string, deletion: WorkspaceDeletion): RegistryEntry {
		const entry = this.#require(daemonId);
		const workspace = entry.workspace ?? inferWorkspaceRecord(entry);
		entry.workspace = { ...workspace, deletion };
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	/**
	 * Drops the deletion state (a refused delete the operator abandoned by
	 * starting the workspace again) and persists. Throws on an unknown id.
	 */
	clearWorkspaceDeletion(daemonId: string): RegistryEntry {
		const entry = this.#require(daemonId);
		if (entry.workspace?.deletion === undefined) return entry;
		const next = { ...entry.workspace };
		delete next.deletion;
		entry.workspace = next;
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	/**
	 * Replaces the persisted callback-enrollment binding on the workspace
	 * record and persists. The binding carries ONLY the SHA-256 hex digest
	 * of the credential (never the raw credential) so a fleet restart can
	 * re-enroll the transport without re-issuing. Throws on an unknown
	 * daemon id.
	 */
	setWorkspaceEnrollment(daemonId: string, enrollment: WorkspaceEnrollment): RegistryEntry {
		const entry = this.#require(daemonId);
		const workspace = entry.workspace ?? inferWorkspaceRecord(entry);
		entry.workspace = { ...workspace, enrollment };
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return entry;
	}

	/**
	 * Clears the persisted callback-enrollment binding and persists. When
	 * `generation` is given, clears ONLY a binding at that generation; a
	 * stale-generation revocation must not wipe a newer binding. Returns
	 * whether a binding was cleared; throws on an unknown daemon id.
	 */
	clearWorkspaceEnrollment(daemonId: string, generation?: number): boolean {
		const entry = this.#require(daemonId);
		const workspace = entry.workspace;
		if (workspace?.enrollment === undefined) return false;
		if (generation !== undefined && workspace.enrollment.generation !== generation) {
			return false;
		}
		const next = { ...workspace };
		delete next.enrollment;
		entry.workspace = next;
		this.#mutated({ upserted: [entry], removed: [] }, true);
		return true;
	}

	/**
	 * Persisted callback-enrollment bindings, one per workspace holding one
	 * (defensive copies), the boot re-enrollment supply for the transport.
	 */
	workspaceEnrollments(): Array<{ workspaceId: string; enrollment: WorkspaceEnrollment }> {
		const out: Array<{ workspaceId: string; enrollment: WorkspaceEnrollment }> = [];
		for (const entry of this.entries) {
			const enrollment = entry.workspace?.enrollment;
			if (enrollment !== undefined) {
				out.push({ workspaceId: entry.daemonId, enrollment: { ...enrollment } });
			}
		}
		return out;
	}

	/** Recorded store-orphan markers (deleted without verification), keyed by workspaceId. */
	storeOrphans(): Record<string, StoreOrphanMarker> {
		return { ...this.storeOrphanList };
	}

	/**
	 * Persist a store-orphan marker (P7.5: a workspace deleted without a
	 * passed verification gate whose log-store subtree survives). Idempotent
	 * for an existing marker. Cleared only by {@link clearStoreOrphan}.
	 */
	markStoreOrphan(workspaceId: string, reason?: string): void {
		this.storeOrphanList[workspaceId] = {
			at: Date.now(),
			...(reason ? { reason } : {}),
			...(this.#captureOrphanProvenance(workspaceId) ?? {}),
		};
		this.#mutated({ upserted: [], removed: [] }, true);
	}

	/**
	 * Capture source + pinnedRevision from the workspace record about to be
	 * removed (orphan provenance, shown on stored-session listings). Returns
	 * undefined when the entry is gone or has no usable provenance. Validity is
	 * not checked here; this only mirrors what the record carried at removal.
	 */
	#captureOrphanProvenance(
		workspaceId: string,
	): { provenance: NonNullable<StoreOrphanMarker["provenance"]> } | undefined {
		const entry = this.get(workspaceId);
		const record = entry?.workspace;
		const source = record?.source;
		const sourcePresent =
			source !== undefined && (source.local !== undefined || source.remote !== undefined);
		if (!sourcePresent && record?.pinnedRevision === undefined) return undefined;
		return {
			provenance: {
				...(source?.local !== undefined || source?.remote !== undefined ? { source } : {}),
				...(record?.pinnedRevision !== undefined ? { pinnedRevision: record.pinnedRevision } : {}),
			},
		};
	}

	/** Remove the store-orphan marker (explicit manual purge only). */
	clearStoreOrphan(workspaceId: string): boolean {
		if (!(workspaceId in this.storeOrphanList)) return false;
		delete this.storeOrphanList[workspaceId];
		this.#mutated({ upserted: [], removed: [] }, true);
		return true;
	}

	/**
	 * Sets the status; the `error` field is only carried while status is
	 * "error" or "asleep" (an asleep entry may carry the reason it stopped,
	 * e.g. a session lock) and is cleared on every other transition (or when
	 * no message is supplied).
	 */
	setStatus(daemonId: string, status: DaemonStatus, error?: string): void {
		const entry = this.#require(daemonId);
		entry.status = status;
		if (status === "error" || status === "asleep") {
			if (error === undefined) delete entry.error;
			else entry.error = error;
		} else {
			delete entry.error;
		}
		// An asleep daemon has no live process: stale liveness facts must not
		// leak into the roster (no pid, no uptime growing since readyAt). The
		// registry is the roster truth, so clearing here covers every stop path
		// (edge stop, lifecycle stop, idle exit, ctl stop) in one place; the
		// same invariant the boot downgrade in server.ts enforces explicitly.
		if (status === "asleep") {
			delete entry.pid;
			delete entry.readyAt;
		}
		this.#mutated({ upserted: [entry], removed: [] }, false);
	}

	remove(daemonId: string): boolean {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) return false;
		this.entries.splice(index, 1);
		this.#mutated({ upserted: [], removed: [daemonId] }, true);
		return true;
	}

	/** Registered projects in insertion order (defensive copy). */
	projects(): RegisteredProject[] {
		return [...this.projectList];
	}

	/**
	 * Register a project by its MAIN checkout path (callers resolve a linked
	 * worktree/subdirectory through `resolveProjectRoot` first). Validates
	 * that `mainPath` is an existing directory with a `.git` entry
	 * (realpath-normalized; symlinked paths alias the same project). A path
	 * already registered returns the EXISTING project with `existing: true`
	 * and changes nothing. Otherwise persists atomically and fires onChange +
	 * onProjectsChange. Throws on invalid input (not a directory / not a git
	 * repository).
	 */
	addProject(mainPath: string): { project: RegisteredProject; existing: boolean } {
		const resolved = realpathIfDirectory(mainPath);
		if (resolved === null) throw new Error(`not a directory: ${mainPath}`);
		if (!existsSync(join(resolved, ".git"))) {
			throw new Error(`not a git repository: ${mainPath}`);
		}
		const existing = this.projectList.find((project) => project.path === resolved);
		if (existing !== undefined) return { project: existing, existing: true };
		const project: RegisteredProject = {
			projectId: `p${this.nextProjectId++}`,
			path: resolved,
			name: basename(resolved),
			addedAt: Date.now(),
		};
		this.projectList.push(project);
		this.#mutated({ upserted: [], removed: [] }, true);
		this.onProjectsChange?.();
		return { project, existing: false };
	}

	/**
	 * Remove a registered project and every NON-CLONE row that belongs to it
	 * (main checkout, linked worktrees, and any never-started placeholder
	 * alike: rows are a derived view of git state, so dropping them touches
	 * no disk and no transcript). The CALLER stops running rows first
	 * (shutdown/stop + forgetPair); this method only edits the registry.
	 * Clone workspaces own provider-managed volumes that must go through the
	 * verified deletion gate (P7.3/P7.5), so any clone of the project refuses
	 * the whole removal with `project <id> has clone workspaces: <ids>`
	 * (nothing is removed on refusal). Unknown ids also throw. Returns the
	 * removed daemon ids.
	 */
	removeProject(projectId: string): string[] {
		const index = this.projectList.findIndex((project) => project.projectId === projectId);
		if (index === -1) throw new Error(`unknown project id: ${projectId}`);
		const owned = this.entries.filter((entry) => entry.projectId === projectId);
		const clones = owned.filter((entry) => entry.workspace?.kind === "clone");
		if (clones.length > 0) {
			throw new Error(
				`project ${projectId} has clone workspaces: ${clones.map((entry) => entry.daemonId).join(", ")}`,
			);
		}
		const removed = owned.map((entry) => entry.daemonId);
		this.entries = this.entries.filter((entry) => entry.projectId !== projectId);
		this.projectList.splice(index, 1);
		this.#mutated({ upserted: [], removed }, true);
		this.onProjectsChange?.();
		return removed;
	}

	/**
	 * Set or clear `RegisteredProject.missing` (the sync pass found the main
	 * checkout gone or no longer a repo). The flag is persisted with the
	 * project so a restart does not flash a missing project as healthy until
	 * the first pass. No-op (no persist, no broadcast) when unchanged or the
	 * project is unknown.
	 */
	setProjectMissing(projectId: string, missing: boolean): void {
		const project = this.projectList.find((p) => p.projectId === projectId);
		if (project === undefined || (project.missing === true) === missing) return;
		if (missing) project.missing = true;
		else Reflect.deleteProperty(project, "missing");
		this.#mutated({ upserted: [], removed: [] }, true);
		this.onProjectsChange?.();
	}

	/**
	 * Read and validate one state file (the state file or its `.bak`). Throws
	 * with the path in the message when it is unreadable or malformed.
	 */
	#parseFile(path: string): LoadedState {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (err) {
			throw new Error(`registry state corrupt at ${path}: ${(err as Error).message}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`registry state corrupt at ${path}: expected an object`);
		}
		const file = parsed as Partial<RegistryFile>;
		if (typeof file.nextId !== "number" || !Array.isArray(file.entries)) {
			throw new Error(`registry state corrupt at ${path}: missing nextId or entries`);
		}
		let maxIndex = 0;
		for (const entry of file.entries) {
			if (typeof entry !== "object" || entry === null || typeof entry.daemonId !== "string") {
				throw new Error(`registry state corrupt at ${path}: entry missing daemonId`);
			}
			const n = Number.parseInt(entry.daemonId.slice(1), 10);
			if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
		}
		const entries = [...file.entries];
		// Lazy workspace migration (P1): entries persisted before workspace
		// records existed get an in-memory record here; it persists on the
		// entry's next mutation, never at boot.
		for (const entry of entries) {
			// Retired keys (`mode` on entries, `branchCreatedByOmpWeb` on records)
			// are dropped silently: every entry is spawned now and branch deletion
			// is guarded by the probed branch.
			Reflect.deleteProperty(entry, "mode");
			if (entry.workspace === undefined) entry.workspace = inferWorkspaceRecord(entry);
			if (entry.workspace !== undefined)
				Reflect.deleteProperty(entry.workspace, "branchCreatedByOmpWeb");
		}
		// Tolerant read: files written before projects existed lack the keys.
		const projects = file.projects ?? [];
		if (!Array.isArray(projects) || projects.some((p) => typeof p?.projectId !== "string")) {
			throw new Error(`registry state corrupt at ${path}: projects entry missing projectId`);
		}
		let maxProjectIndex = 0;
		for (const project of projects) {
			const n = Number.parseInt(project.projectId.slice(1), 10);
			if (Number.isFinite(n) && n > maxProjectIndex) maxProjectIndex = n;
		}
		// Same never-reuse rule as dN ids. Non-number garbage falls back to 1
		// (missing key = 1), then the max-index floor applies.
		const rawNextProjectId = typeof file.nextProjectId === "number" ? file.nextProjectId : 1;
		// Tolerant read of deletion-without-verification markers (absent in
		// files written before P7.5). Entries whose workspace record claims a
		// non-verified deletion also reconcile to the orphan list on their
		// next mutation (never at boot, matching the P1 lazy-migration rule).
		const storeOrphans: Record<string, StoreOrphanMarker> = {};
		if (file.storeOrphans !== undefined) {
			if (
				typeof file.storeOrphans !== "object" ||
				file.storeOrphans === null ||
				Array.isArray(file.storeOrphans)
			) {
				throw new Error(`registry state corrupt at ${path}: storeOrphans must be an object`);
			}
			for (const [workspaceId, marker] of Object.entries(file.storeOrphans)) {
				if (marker === null || typeof marker !== "object" || typeof marker.at !== "number") {
					throw new Error(
						`registry state corrupt at ${path}: storeOrphans entry ${workspaceId} missing at`,
					);
				}
				storeOrphans[workspaceId] = marker;
			}
		}
		return {
			entries,
			// Never reuse ids: floor the counter above the highest id on disk.
			nextId: Math.max(file.nextId, maxIndex + 1),
			projects: [...projects],
			nextProjectId: Math.max(rawNextProjectId, maxProjectIndex + 1),
			storeOrphans,
		};
	}

	#indexOf(daemonId: string): number {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) throw new Error(`unknown daemon id: ${daemonId}`);
		return index;
	}

	#require(daemonId: string): RegistryEntry {
		return this.entries[this.#indexOf(daemonId)];
	}

	/** Write any pending state now and stop the coalesced-write timer. The fleet server calls it on close. */
	close(): void {
		this.flush();
	}

	/**
	 * Notify after a mutation: arm its write and fire onChange with the rows it
	 * touched. A durable change writes on the next timer tick; a volatile-only
	 * one waits VOLATILE_PERSIST_DELAY_MS so bursts of status and git updates
	 * share one write.
	 */
	#mutated(change: RegistryChange, durable: boolean): void {
		this.#schedule(durable ? 0 : VOLATILE_PERSIST_DELAY_MS);
		this.onChange?.(change);
	}

	/** Arm the coalesced write, or pull an armed one earlier. */
	#schedule(delayMs: number): void {
		this.#dirty = true;
		if (!this.#exitHooked) {
			this.#exitHooked = true;
			process.once("exit", this.#onExit);
		}
		const due = Date.now() + delayMs;
		if (this.#flushTimer !== null) {
			if (due >= this.#flushDue) return;
			clearTimeout(this.#flushTimer);
		}
		this.#flushDue = due;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			try {
				this.flush();
			} catch (err) {
				// The state stays pending: the next mutation or close() retries.
				console.error(
					`fleet: registry write failed at ${this.statePath}: ${(err as Error).message}`,
				);
			}
		}, delayMs);
	}

	#persist(): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		const payload = JSON.stringify(
			{
				nextId: this.nextId,
				entries: this.entries,
				projects: this.projectList,
				nextProjectId: this.nextProjectId,
				...(Object.keys(this.storeOrphanList).length > 0
					? { storeOrphans: this.storeOrphanList }
					: {}),
			} satisfies RegistryFile,
			null,
			2,
		);
		const tmp = `${this.statePath}.tmp`;
		const backup = `${this.statePath}.bak`;
		writeFileSync(tmp, `${payload}\n`, "utf8");
		fsyncPath(tmp);
		this.failBeforeRename?.();
		// Keep the state being replaced as the fallback copy (written through a
		// sibling tmp file, so .bak is always a complete file).
		if (this.#rotateBackup && existsSync(this.statePath)) {
			copyFileSync(this.statePath, `${backup}.tmp`);
			fsyncPath(`${backup}.tmp`);
			renameSync(`${backup}.tmp`, backup);
		}
		this.#rotateBackup = true;
		renameSync(tmp, this.statePath);
		fsyncPath(dirname(this.statePath));
	}
}
