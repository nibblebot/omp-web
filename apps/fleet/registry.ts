/**
 * Daemon registry for the omp-fleet: the persistent, insertion-ordered
 * roster of daemons (spawned, attached, remote) with monotonic `dN` id
 * allocation that survives restarts, plus the first-class registered
 * `projects[]` (realpath-keyed, `pN` ids) that project groups hang off.
 *
 * State is a JSON file
 * `{ "nextId": number, "entries": RegistryEntry[], "projects"?: RegisteredProject[], "nextProjectId"?: number }`;
 * the path is injectable for tests; the fleet server resolves
 * `OMP_FLEET_STATE` / `~/.omp-web/fleet-state.json` and passes it
 * in. Files written before projects existed lack the two new keys and load
 * fine (projects start empty, the counter at 1). Every mutation is persisted
 * atomically (write a sibling tmp file, then rename over the real one)
 * before the mutation returns, and fires `onChange` (set by the edge server
 * for roster broadcasts); project-set mutations additionally fire
 * `onProjectsChange` (set by the edge server for registered_projects
 * broadcasts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	DaemonEntry,
	DaemonStatus,
	DesiredState,
	RegisteredProject,
	WorkspaceKind,
} from "#lib/wire/protocol";
import { validateProjectPath } from "./discovery";

/**
 * Workspace identity unions, re-exported for fleet/registry consumers. The
 * canonical definitions live in shared/protocol.ts, the shared leaf that
 * already feeds DaemonEntry/RegisteredProject to this file. Defining them
 * here instead would make the wire types (or this file's importers) depend
 * on a fleet-internal module; re-exporting keeps one source and the
 * registry-facing export surface.
 */
export type { WorkspaceKind, DesiredState };

/**
 * Deletion-gate error codes: the frozen ledger vocabulary
 * (docs/clone-contracts.md "Typed errors").
 */
export type DeletionErrorCode =
	| "invalid_request"
	| "invalid_identity"
	| "unauthorized"
	| "forbidden"
	| "unavailable"
	| "conflict"
	| "generation_obsolete"
	| "writer_active"
	| "archive_pending"
	| "archive_conflict"
	| "provider_failed"
	| "retryable";

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
	/** Clone sources. */
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
	/** Current git branch of the session cwd for local entries; set by the supervisor's git-state polling. */
	branch?: string;
	/** git dirty-state file counts; set by the supervisor's git-state polling (absent until the first successful probe). */
	git?: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
	/** Title of the daemon's last session file; set by the supervisor's git-state polling probe. */
	sessionTitle?: string;
	/** True when the daemon's last session file has no messages (new/empty session);
	 *  set alongside sessionTitle by the supervisor's git-state polling probe. */
	sessionEmpty?: boolean;
	/** Remote/attached: the ws(s)://host:port as registered. */
	endpoint?: string;
	/** Bearer token for dial-in (R14). */
	token?: string;
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

/**
 * Truthful boot status for a persisted entry after a fleet restart: every
 * spawned child and connector socket died with the old process, so any
 * non-terminal persisted status describes nothing that is running.
 * Terminal statuses are kept: "error" (the failure is real) and "asleep"
 * (an intentional stop). Everything else maps per mode:
 *   - "spawning" → "asleep", a failed spawn; nothing was ever dialed
 *     (respawn --resume is the documented recovery for spawned entries);
 *   - spawned + any other non-terminal status → "asleep", the child is
 *     gone, so "ready"/"connecting"/… are lies; the user respawns;
 *   - remote/attached + any other non-terminal status → "connecting", a
 *     dial-in entry has nothing to respawn, so the server redials it at
 *     boot (the same recovery the edge's #wake uses for remote entries).
 * Returns null when the persisted status should be left untouched.
 */
export function bootStatusFor(entry: Pick<RegistryEntry, "mode" | "status">): DaemonStatus | null {
	if (entry.status === "error" || entry.status === "asleep") return null;
	if (entry.status === "spawning") return "asleep"; // failed spawn, no live child, never dialed
	if (entry.mode === "spawned") return "asleep"; // child died with the old fleet process
	return "connecting"; // dial-in: nothing to respawn, so redial immediately
}

/**
 * Legacy-inference base workspace record for entries persisted before P1.
 * Contract rule: managed or worktreeOf → "worktree"; every other mode
 * (spawned without worktreeOf, remote, attached) → "direct". desiredState
 * is "running": a legacy entry is a live roster row. projectId comes from
 * the entry's registered-project link ("" when absent, e.g. remote
 * entries). In-memory only: load() stamps it and the entry's next mutation
 * persists it; no rewrite at boot.
 */
function inferWorkspaceRecord(
	entry: Pick<RegistryEntry, "managed" | "worktreeOf" | "projectId">,
): WorkspaceRecord {
	return {
		kind: entry.managed || entry.worktreeOf !== undefined ? "worktree" : "direct",
		projectId: entry.projectId ?? "",
		desiredState: "running",
	};
}

export class Registry {
	/** Fired after every mutation (not on load); set by the edge server for roster broadcasts. */
	onChange: (() => void) | null = null;
	/**
	 * Fired after PROJECT-set mutations only (addProject/removeProject), not
	 * daemon mutations; set by the edge server for registered_projects
	 * broadcasts. Projects are rare mutations and the frame is re-derivable
	 * from stream priming, so broadcasts ride this dedicated hook instead of
	 * the every-mutation onChange.
	 */
	onProjectsChange: (() => void) | null = null;

	private readonly statePath: string;
	private entries: RegistryEntry[] = [];
	private nextId = 1;
	/** Registered projects in insertion order (public API: projects()). */
	private projectList: RegisteredProject[] = [];
	private nextProjectId = 1;
	/** Deleted-without-verification markers keyed by workspaceId (P7.5). */
	private storeOrphanList: Record<string, StoreOrphanMarker> = {};

	constructor(statePath: string) {
		this.statePath = statePath;
	}

	/** Missing file → empty registry. Corrupt file → throws with the path in the message. */
	async load(): Promise<void> {
		if (!existsSync(this.statePath)) {
			this.entries = [];
			this.nextId = 1;
			this.projectList = [];
			this.nextProjectId = 1;
			this.storeOrphanList = {};
			return;
		}
		const file = this.#readFile();
		let maxIndex = 0;
		for (const entry of file.entries) {
			if (typeof entry !== "object" || entry === null || typeof entry.daemonId !== "string") {
				throw new Error(`registry state corrupt at ${this.statePath}: entry missing daemonId`);
			}
			const n = Number.parseInt(entry.daemonId.slice(1), 10);
			if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
		}
		this.entries = [...file.entries];
		// Never reuse ids: floor the counter above the highest id on disk.
		this.nextId = Math.max(file.nextId, maxIndex + 1);
		// Lazy workspace migration (P1): entries persisted before workspace
		// records existed get an in-memory record here; it persists on the
		// entry's next mutation, never at boot.
		for (const entry of this.entries) {
			if (entry.workspace === undefined) entry.workspace = inferWorkspaceRecord(entry);
		}

		// Tolerant read: files written before projects existed lack the keys.
		const projects = file.projects ?? [];
		if (!Array.isArray(projects) || projects.some((p) => typeof p?.projectId !== "string")) {
			throw new Error(
				`registry state corrupt at ${this.statePath}: projects entry missing projectId`,
			);
		}
		let maxProjectIndex = 0;
		for (const project of projects) {
			const n = Number.parseInt(project.projectId.slice(1), 10);
			if (Number.isFinite(n) && n > maxProjectIndex) maxProjectIndex = n;
		}
		this.projectList = [...projects];
		// Same never-reuse rule as dN ids. Non-number garbage falls back to 1
		// (missing key = 1), then the max-index floor applies.
		const rawNextProjectId = typeof file.nextProjectId === "number" ? file.nextProjectId : 1;
		this.nextProjectId = Math.max(rawNextProjectId, maxProjectIndex + 1);
		// Tolerant read of deletion-without-verification markers (absent in
		// files written before P7.5). Entries whose workspace record claims a
		// non-verified deletion also reconcile to the orphan list on their
		// next mutation (never at boot, matching the P1 lazy-migration rule).
		this.storeOrphanList = {};
		if (file.storeOrphans !== undefined) {
			if (
				typeof file.storeOrphans !== "object" ||
				file.storeOrphans === null ||
				Array.isArray(file.storeOrphans)
			) {
				throw new Error(
					`registry state corrupt at ${this.statePath}: storeOrphans must be an object`,
				);
			}
			for (const [workspaceId, marker] of Object.entries(file.storeOrphans)) {
				if (marker === null || typeof marker !== "object" || typeof marker.at !== "number") {
					throw new Error(
						`registry state corrupt at ${this.statePath}: storeOrphans entry ${workspaceId} missing at`,
					);
				}
				this.storeOrphanList[workspaceId] = marker;
			}
		}
	}

	/** Atomic persist (tmp + rename). Mutations persist internally; this is the public API. */
	async save(): Promise<void> {
		this.#persist();
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
		this.#mutated();
		return entry;
	}

	update(daemonId: string, patch: Partial<RegistryEntry>): RegistryEntry {
		const index = this.#indexOf(daemonId);
		const entry = { ...this.entries[index], ...patch };
		this.entries[index] = entry;
		this.#mutated();
		return entry;
	}

	/**
	 * Replaces the fleet-private workspace record and persists. Throws on an
	 * unknown daemon id.
	 */
	setWorkspace(daemonId: string, record: WorkspaceRecord): RegistryEntry {
		const entry = this.#require(daemonId);
		entry.workspace = record;
		this.#mutated();
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
		this.#mutated();
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
		this.#mutated();
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
		this.#mutated();
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
		this.#mutated();
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
		this.#mutated();
	}

	/**
	 * Capture source + pinnedRevision from the workspace record about to be
	 * removed (P8.10: resume-onto-fresh-clone for orphaned clone
	 * workspaces). Returns undefined when the entry is gone or has no usable
	 * provenance. Exactly-one-source and pinnedRevision validity are
	 * enforced by the resume-clone route, not here; this only mirrors what
	 * the record carried at removal time.
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
		this.#mutated();
		return true;
	}

	/**
	 * Sets the status; the `error` field is only carried while status is
	 * "error" and is cleared on every other transition (or when no message
	 * is supplied).
	 */
	setStatus(daemonId: string, status: DaemonStatus, error?: string): void {
		const entry = this.#require(daemonId);
		entry.status = status;
		if (status === "error") {
			if (error === undefined) delete entry.error;
			else entry.error = error;
		} else {
			delete entry.error;
		}
		// An asleep daemon has no live process: stale liveness facts must not
		// leak into the roster (no pid, no uptime growing since readyAt). The
		// registry is the roster truth, so clearing here covers every stop path
		// (edge stop, supervisor stop, idle exit, ctl stop) in one place; the
		// same invariant the boot downgrade in server.ts enforces explicitly.
		if (status === "asleep") {
			delete entry.pid;
			delete entry.readyAt;
		}
		this.#mutated();
	}

	remove(daemonId: string): boolean {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) return false;
		this.entries.splice(index, 1);
		this.#mutated();
		return true;
	}

	/** Registered projects in insertion order (defensive copy). */
	projects(): RegisteredProject[] {
		return [...this.projectList];
	}

	/**
	 * Register a project. Validates that `path` is an existing directory
	 * containing a git repo (realpath-normalized via validateProjectPath;
	 * symlinked paths alias the same project), dedups on realpath equality
	 * returning the EXISTING project, and persists atomically + fires
	 * onChange. Throws when the path is not a directory or not a git repo.
	 */
	async addProject(path: string): Promise<RegisteredProject> {
		const resolved = await validateProjectPath(path);
		if (resolved === null) throw new Error(`not a directory: ${path}`);
		// Same .git dir-or-file heuristic discovery's scan uses: a main
		// checkout has a .git directory, a linked worktree a .git file.
		if (!existsSync(join(resolved, ".git"))) {
			throw new Error(`not a git repository: ${path}`);
		}
		const existing = this.projectList.find((project) => project.path === resolved);
		if (existing !== undefined) return existing;
		const project: RegisteredProject = {
			projectId: `p${this.nextProjectId++}`,
			path: resolved,
			name: basename(resolved),
			addedAt: Date.now(),
		};
		this.projectList.push(project);
		this.#mutated();
		this.onProjectsChange?.();
		return project;
	}

	/**
	 * Remove a registered project. Referencing roster entries that are NOT
	 * provably-empty placeholders block removal; the error names their
	 * daemon ids (callers surface the blockers); never touches disk.
	 * A placeholder is the auto-registered default workspace of a project
	 * that never started: mode "spawned", status "asleep", no lastSessionFile,
	 * no endpoint, so the roster row is their only state. Placeholders are
	 * implicitly dropped with the project, no two-step removal needed.
	 * Unknown ids also throw.
	 */
	removeProject(projectId: string): void {
		const index = this.projectList.findIndex((project) => project.projectId === projectId);
		if (index === -1) throw new Error(`unknown project id: ${projectId}`);
		// Partition referencing entries: real blockers (anything that ever
		// ran, is spawning/ready/error, or is remote/attached) refuse the
		// removal wholesale; placeholders are dropped in the same mutation
		// as the project (and only then; a refused removal leaves them).
		// A placeholder is a never-started DEFAULT workspace only: spawned
		// and asleep, no lastSessionFile, no endpoint. A clone workspace is
		// NEVER a placeholder: its cwd is a managed volume under the fleet
		// workspaceDir with preparation/provider state, so it must block
		// project removal until it is deleted through the verified gate
		// (P7.3/P7.5); silently dropping it would orphan the volume and
		// bypass the gate.
		const isPlaceholder = (entry: RegistryEntry): boolean =>
			entry.workspace?.kind !== "clone" &&
			entry.mode === "spawned" &&
			entry.status === "asleep" &&
			entry.lastSessionFile === undefined &&
			entry.endpoint === undefined;
		const blockers = this.entries.filter(
			(entry) => entry.projectId === projectId && !isPlaceholder(entry),
		);
		if (blockers.length > 0) {
			throw new Error(
				`project ${projectId} in use by daemons: ${blockers.map((entry) => entry.daemonId).join(", ")}`,
			);
		}
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry.projectId === projectId && isPlaceholder(entry)) this.entries.splice(i, 1);
		}
		this.projectList.splice(index, 1);
		this.#mutated();
		this.onProjectsChange?.();
	}

	#readFile(): RegistryFile {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
		} catch (err) {
			throw new Error(`registry state corrupt at ${this.statePath}: ${(err as Error).message}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`registry state corrupt at ${this.statePath}: expected an object`);
		}
		const file = parsed as Partial<RegistryFile>;
		if (typeof file.nextId !== "number" || !Array.isArray(file.entries)) {
			throw new Error(`registry state corrupt at ${this.statePath}: missing nextId or entries`);
		}
		return file as RegistryFile;
	}

	#indexOf(daemonId: string): number {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) throw new Error(`unknown daemon id: ${daemonId}`);
		return index;
	}

	#require(daemonId: string): RegistryEntry {
		return this.entries[this.#indexOf(daemonId)];
	}

	/** Persist atomically, then notify. Called after every mutation. */
	#mutated(): void {
		this.#persist();
		this.onChange?.();
	}

	#persist(): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		const payload = JSON.stringify({
			nextId: this.nextId,
			entries: this.entries,
			projects: this.projectList,
			nextProjectId: this.nextProjectId,
			...(Object.keys(this.storeOrphanList).length > 0
				? { storeOrphans: this.storeOrphanList }
				: {}),
		} satisfies RegistryFile);
		const tmp = `${this.statePath}.tmp`;
		writeFileSync(tmp, payload, "utf8");
		renameSync(tmp, this.statePath);
	}
}
