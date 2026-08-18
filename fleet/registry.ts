/**
 * Daemon registry for the omp-fleet: the persistent, insertion-ordered
 * roster of daemons (spawned, attached, remote) with monotonic `dN` id
 * allocation that survives restarts, plus the first-class registered
 * `projects[]` (realpath-keyed, `pN` ids) that project groups hang off.
 *
 * State is a JSON file
 * `{ "nextId": number, "entries": RegistryEntry[], "projects"?: RegisteredProject[], "nextProjectId"?: number }` —
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
import type { DaemonEntry, DaemonStatus, RegisteredProject } from "../shared/protocol";
import { validateProjectPath } from "./discovery";

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
	/** Remote/attached: the ws(s)://host:port as registered. */
	endpoint?: string;
	/** Bearer token for dial-in (R14). */
	token?: string;
	/** Spawned entries: the template name they were spawned from. */
	template?: string;
	registeredAt: number;
}

/** On-disk shape of state.json. */
interface RegistryFile {
	nextId: number;
	entries: RegistryEntry[];
	/** First-class registered projects; absent in files written before Phase 2. */
	projects?: RegisteredProject[];
	/** Next `pN` project id; absent in files written before Phase 2. */
	nextProjectId?: number;
}

/**
 * Truthful boot status for a persisted entry after a fleet restart: every
 * spawned child and connector socket died with the old process, so any
 * non-terminal persisted status describes nothing that is running.
 * Terminal statuses are kept: "error" (the failure is real) and "asleep"
 * (an intentional stop). Everything else maps per mode:
 *   - "spawning" → "asleep" — a failed spawn; nothing was ever dialed
 *     (respawn --resume is the documented recovery for spawned entries);
 *   - spawned + any other non-terminal status → "asleep" — the child is
 *     gone, so "ready"/"connecting"/… are lies; the user respawns;
 *   - remote/attached + any other non-terminal status → "connecting" — a
 *     dial-in entry has nothing to respawn, so the server redials it at
 *     boot (the same recovery the edge's #wake uses for remote entries).
 * Returns null when the persisted status should be left untouched.
 */
export function bootStatusFor(entry: Pick<RegistryEntry, "mode" | "status">): DaemonStatus | null {
	if (entry.status === "error" || entry.status === "asleep") return null;
	if (entry.status === "spawning") return "asleep"; // failed spawn — no live child, never dialed
	if (entry.mode === "spawned") return "asleep"; // child died with the old fleet process
	return "connecting"; // dial-in: nothing to respawn — redial immediately
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
		// (edge stop, supervisor stop, idle exit, ctl stop) in one place — the
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
	 * containing a git repo (realpath-normalized via validateProjectPath —
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
	 * provably-empty placeholders block removal — the error names their
	 * daemon ids (callers surface the blockers); never touches disk.
	 * Placeholder entries — mode "spawned", status "asleep", no
	 * lastSessionFile, no endpoint: the auto-registered default workspace of
	 * a project that never started, so the roster row is their only state —
	 * are implicitly dropped with the project, no two-step removal needed.
	 * Unknown ids also throw.
	 */
	removeProject(projectId: string): void {
		const index = this.projectList.findIndex((project) => project.projectId === projectId);
		if (index === -1) throw new Error(`unknown project id: ${projectId}`);
		// Partition referencing entries: real blockers (anything that ever
		// ran, is spawning/ready/error, or is remote/attached) refuse the
		// removal wholesale; placeholders are dropped in the same mutation
		// as the project (and only then — a refused removal leaves them).
		const isPlaceholder = (entry: RegistryEntry): boolean =>
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
		} satisfies RegistryFile);
		const tmp = `${this.statePath}.tmp`;
		writeFileSync(tmp, payload, "utf8");
		renameSync(tmp, this.statePath);
	}
}
