/**
 * ProjectSync: keeps the registry in step with the filesystem and git. Runtime
 * ownership (spawn, stop, respawn, exit and restart policy, credentials)
 * lives in workspace-lifecycle.ts; this module only observes.
 *
 * Projects are git repos' main checkouts or plain directories. Whether a
 * project is a git repo (its directory has a `.git`) is in-memory state in the
 * registry (`isProjectGit`, reported as `RegisteredProject.git === false`):
 * computed at boot, then kept by per-project watchers (non-recursive fs.watch
 * on the project directory reacting only to `.git`, and for git projects on
 * `.git/worktrees` and `.git` entries named `worktrees`). Events debounce per
 * project, then one project sync runs: a `.git` that appeared or vanished
 * flips the project's git state (a vanished `.git` is NOT missing), a
 * vanished directory marks the project missing, and a git project runs one
 * `git worktree list` to register the rows of worktrees created outside
 * omp-web and reconcile each worktree's lock flag. A project whose watcher
 * cannot start or errors falls back to a 60s poll of the same sync.
 * Non-git projects never run git: they only need their directory and a main
 * row. Their linked worktree rows (left over from a `.git` that was deleted)
 * are evicted once asleep; a running one stays until it stops.
 *
 * Per row (startGitStatePolling) it keeps branch, dirty counts, the detached
 * short sha, and the last-session-file title fresh for the roster. Rows that
 * are not asleep are probed every tick (10s); an asleep row is probed once
 * (when first seen) and never again. A non-clone row of a non-git project
 * skips the git probe, but still reads its session title on the row's cadence.
 *
 * close() stops the poll and every watcher; it never touches sessions.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type { RegisteredProject } from "#lib/wire/protocol";
import { hasGitEntry, probeGitState as probeGit, resolveWorktreeOf } from "./discovery";
import type { GitRunner, GitState } from "./discovery";
import type { Registry, RegistryEntry } from "./registry";
import { readSessionInfo } from "./session-title";
import { cloneCheckoutDir } from "./workspace-lifecycle";
import {
	listWorktreeBlocks,
	realpathOf,
	registerProjectMainEntry,
	registerWorktreeEntry,
	type HostSessions,
} from "./worktrees";
import type { FleetLogLevel } from "./events";

const DEFAULT_SYNC_INTERVAL_MS = 10_000;
/** Quiet time after the last watcher event of a project before its sync runs. */
const WATCH_DEBOUNCE_MS = 250;
/** Poll period of a project whose watchers cannot run (or whose directory is gone). */
const FALLBACK_POLL_MS = 60_000;
/** Max git probes in flight during one sync pass (rows probe in parallel). */
const SYNC_PROBE_CONCURRENCY = 4;

/** Per-project watcher state (all handles are null while the project is not watched). */
interface ProjectWatch {
	/** Directory watch: reacts to `.git` and to the directory itself disappearing. */
	dir: FSWatcher | null;
	/** `.git` watch (git projects): reacts to the `worktrees` entry only. */
	gitDir: FSWatcher | null;
	/** `.git/worktrees` watch (git projects, while that directory exists): any entry. */
	worktrees: FSWatcher | null;
	/** Pending debounce timer. */
	debounce: ReturnType<typeof setTimeout> | null;
	/** Fallback poll (watchers failed or the directory is gone). */
	poll: ReturnType<typeof setInterval> | null;
	/** A `.git` event arrived since the last sync: the git watchers may sit on a dead inode. */
	gitEvent: boolean;
	/** The failure reason was already logged. */
	logged: boolean;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Resolves only after
 * every item settled, so a pass never leaves probes running into the next
 * one; rethrows the first failure once everything settled.
 */
async function forEachLimit<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++];
			try {
				await fn(item);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure) throw failure.error;
}

/** Field-wise git-counts compare: undefined (never probed) differs from any counts object. */
function sameGitState(
	a:
		| {
				added: number;
				modified: number;
				deleted: number;
				untracked: number;
				linesAdded?: number;
				linesDeleted?: number;
		  }
		| undefined,
	b: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	},
): boolean {
	return (
		a !== undefined &&
		a.added === b.added &&
		a.modified === b.modified &&
		a.deleted === b.deleted &&
		a.untracked === b.untracked &&
		a.linesAdded === b.linesAdded &&
		a.linesDeleted === b.linesDeleted
	);
}

/** `#probeGitOf` answer for a row whose project is not a git repo: no git ran, nothing to reconcile. */
const GIT_SKIPPED = Symbol("git-skipped");

export class ProjectSync {
	#registry: Registry;
	#host: HostSessions;
	/** Sync timer (startGitStatePolling); cleared by close(). */
	#gitStateTimer: ReturnType<typeof setInterval> | null = null;
	/** Exec injected via startGitStatePolling (tests); undefined = real git. */
	#gitExec: GitRunner | undefined;
	/** The running sync pass; requests that arrive while it runs coalesce. */
	#syncing: Promise<void> | null = null;
	/** A sync request arrived mid-pass: exactly one follow-up pass runs. */
	#syncQueued = false;
	/** syncNow() was called: the next pass syncs every project, not just the signaled ones. */
	#fullRequested = false;
	/** Projects whose watcher (or fallback poll) signaled: the next pass syncs them. */
	#pending = new Set<string>();
	/** Watchers run (startGitStatePolling was called and close() was not). */
	#watching = false;
	#debounceMs = WATCH_DEBOUNCE_MS;
	#fallbackPollMs = FALLBACK_POLL_MS;
	/** Watcher state per projectId. */
	#watches = new Map<string, ProjectWatch>();
	/** Rows probed at least once: an asleep row is probed only until it has been. */
	#lastProbeAt = new Map<string, number>();
	/** In-flight probe per workspaceId: a sync pass and a spawn-time probe share one run. */
	#probing = new Map<string, Promise<void>>();
	/** Lifecycle-event hook (server.ts wires it to the fleet event ring). */
	#onEvent: ((level: FleetLogLevel, message: string, workspaceId?: string) => void) | undefined;
	/**
	 * Worktree-vanished hook: fired during git-state polling when a tagged
	 * worktree's cwd no longer exists on disk (probe failed AND the
	 * directory is gone). Detection only; eviction orchestration
	 * (prune/drop, registry.remove, roster broadcast, toast) is the caller's
	 * job. At most meaningful once per entry: the server dedups in-flight
	 * evictions and the entry is gone from the registry after the first.
	 */
	#onWorktreeRemoved: ((entry: RegistryEntry) => void) | undefined;

	constructor(
		registry: Registry,
		host: HostSessions,
		opts?: {
			onEvent?: (level: FleetLogLevel, message: string, workspaceId?: string) => void;
			onWorktreeRemoved?: (entry: RegistryEntry) => void;
		},
	) {
		this.#registry = registry;
		this.#host = host;
		this.#onEvent = opts?.onEvent;
		this.#onWorktreeRemoved = opts?.onWorktreeRemoved;
	}

	/**
	 * Backfill worktreeOf on local entries registered before spawn-time
	 * tagging existed (fired once at server start). An unresolvable cwd
	 * leaves the entry untouched; entries removed mid-scan are skipped.
	 */
	async backfillWorktrees(): Promise<void> {
		for (const entry of this.#registry.list()) {
			if (entry.worktreeOf !== undefined || entry.cwd === "") continue;
			const worktreeOf = await resolveWorktreeOf(entry.cwd);
			if (worktreeOf !== undefined && this.#registry.get(entry.workspaceId)) {
				this.#registry.update(entry.workspaceId, { worktreeOf });
			}
		}
	}

	/**
	 * Start sync: compute every project's git state (one `.git` existence
	 * check each), start the per-project watchers, run one full pass, then one
	 * probe pass per `intervalMs` (default 10s). Each tick probes the rows
	 * that are due (not asleep, or never probed); it does not list worktrees,
	 * which is watcher-driven. Idempotent: a second call while the timer runs
	 * is ignored so passes never stack. `close()` stops the timer and the
	 * watchers. The injected `exec` keeps tests hermetic; `watchDebounceMs`
	 * and `fallbackPollMs` shorten the watcher debounce and the fallback poll.
	 */
	startGitStatePolling(opts?: {
		intervalMs?: number;
		exec?: GitRunner;
		watchDebounceMs?: number;
		fallbackPollMs?: number;
	}): void {
		if (this.#gitStateTimer) return;
		this.#gitExec = opts?.exec;
		this.#debounceMs = opts?.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
		this.#fallbackPollMs = opts?.fallbackPollMs ?? FALLBACK_POLL_MS;
		const intervalMs = opts?.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
		for (const project of this.#registry.projects()) {
			// A directory that is gone has no git state to read: keep what it was.
			if (existsSync(project.path)) {
				this.#registry.setProjectGit(project.projectId, hasGitEntry(project.path));
			}
		}
		this.#watching = true;
		this.syncNow();
		this.#gitStateTimer = setInterval(() => this.#kick(), intervalMs);
	}

	/**
	 * Run one full sync pass now (sync_projects calls this): every project is
	 * reconciled. Requests that arrive while a pass runs coalesce into exactly
	 * one follow-up pass: passes never overlap.
	 */
	syncNow(): void {
		this.#fullRequested = true;
		this.#kick();
	}

	/**
	 * One-off git-state probe for one session (fire-and-forget). A host spawn
	 * calls this right after entry creation so a fresh session shows its
	 * branch and dirty counts before the next poll tick. Uses the exec
	 * injected via startGitStatePolling (real git before that).
	 */
	probeGitState(workspaceId: string): void {
		const entry = this.#registry.get(workspaceId);
		if (!entry) return;
		void this.#probeEntry(entry);
	}

	/** Run a pass now, or queue exactly one follow-up when one is running. */
	#kick(): void {
		if (this.#syncing) {
			this.#syncQueued = true;
			return;
		}
		this.#syncing = this.#runSyncPasses();
	}

	/**
	 * Run passes until no sync request is pending. A failing pass is reported
	 * as an error event; it never stops the timer or leaves the sync flag set.
	 */
	async #runSyncPasses(): Promise<void> {
		try {
			do {
				this.#syncQueued = false;
				await this.#syncPass().catch((err: unknown) =>
					this.#onEvent?.("error", `sync failed: ${(err as Error).message}`),
				);
			} while (this.#syncQueued);
		} finally {
			this.#syncing = null;
		}
	}

	/**
	 * One pass: reconcile the watcher set with the registered projects, sync
	 * the projects that need it (all of them after syncNow, the signaled ones
	 * after a watcher event, new ones always), then probe every row that is
	 * due. Forgets probe times of removed rows.
	 */
	async #syncPass(): Promise<void> {
		const full = this.#fullRequested;
		this.#fullRequested = false;
		const due = new Set(this.#pending);
		this.#pending.clear();
		for (const projectId of this.#reconcileWatchers()) due.add(projectId);
		// One realpath memo for the whole pass: projects and rows resolve each
		// distinct path once instead of once per row per project.
		const realpaths = new Map<string, string>();
		for (const project of this.#registry.projects()) {
			if (full || due.has(project.projectId)) await this.#syncProject(project, realpaths);
		}
		this.#evictOrphanedWorktrees();
		const now = Date.now();
		const probes = this.#registry.list().filter((entry) => this.#probeDue(entry));
		for (const entry of probes) this.#lastProbeAt.set(entry.workspaceId, now);
		await forEachLimit(probes, SYNC_PROBE_CONCURRENCY, (entry) => this.#probeEntry(entry));
		for (const workspaceId of this.#lastProbeAt.keys()) {
			if (!this.#registry.get(workspaceId)) this.#lastProbeAt.delete(workspaceId);
		}
	}

	/**
	 * Reconcile one project with the filesystem.
	 *
	 * - Directory gone: the project is `missing` (its git state is kept, its
	 *   watchers are closed, a fallback poll waits for it to return).
	 * - `.git` appeared or vanished: the registry's git state flips, the
	 *   watchers are rearmed for the new state, and a flip to git re-opens the
	 *   rows for one probe (an asleep row is probed only when never probed).
	 * - Non-git: never runs git. Stale branch/git/detachedAt on its rows are
	 *   cleared and the main row is ensured.
	 * - Git: a missing, bare, or unreadable main checkout (a failed worktree
	 *   list with `.git` present) marks the project missing and is never
	 *   removed. Otherwise the main row is ensured and every linked worktree
	 *   without a row is registered asleep (prunable checkouts are skipped).
	 *   Each linked row mirrors git's lock flag.
	 */
	async #syncProject(project: RegisteredProject, realpaths: Map<string, string>): Promise<void> {
		const { projectId } = project;
		const watched = this.#watches.get(projectId);
		if (!existsSync(project.path)) {
			this.#registry.setProjectMissing(projectId, true);
			if (watched) {
				this.#closeWatchers(watched);
				this.#ensurePoll(project, watched);
			}
			return;
		}
		const git = hasGitEntry(project.path);
		const flipped = git !== this.#registry.isProjectGit(projectId);
		if (flipped) this.#registry.setProjectGit(projectId, git);
		if (watched && (flipped || watched.gitEvent || watched.dir === null)) {
			watched.gitEvent = false;
			this.#rearmWatchers(project, watched);
		}
		if (!git) {
			this.#registry.setProjectMissing(projectId, false);
			this.#clearGitFields(projectId);
			await registerProjectMainEntry(this.#registry, this.#host, project, { realpaths });
			return;
		}
		if (flipped) this.#forgetProbes(projectId);
		if (watched) this.#refreshWorktreesWatch(project, watched);
		const blocks = await listWorktreeBlocks(project.path);
		const main = blocks?.[0];
		const missing = main === undefined || main.bare === true;
		this.#registry.setProjectMissing(projectId, missing);
		if (blocks === undefined || missing) return;
		await registerProjectMainEntry(this.#registry, this.#host, project, { realpaths });
		for (const block of blocks.slice(1)) {
			if (block.path === undefined || block.prunable) continue;
			const resolved = realpathOf(block.path, realpaths);
			const known = this.#registry
				.list()
				.find((entry) => entry.cwd !== "" && realpathOf(entry.cwd, realpaths) === resolved);
			const row =
				known ??
				(await registerWorktreeEntry(this.#registry, this.#host, project, block.path, {
					start: false,
				}));
			const locked = block.locked ? true : undefined;
			if (row.worktreeLocked !== locked) {
				this.#registry.update(row.workspaceId, { worktreeLocked: locked });
			}
		}
	}

	/** Clear branch/git/detachedAt on the non-clone rows of a project that is not a git repo (only when set). */
	#clearGitFields(projectId: string): void {
		for (const entry of this.#registry.list()) {
			if (entry.projectId !== projectId || entry.workspace?.kind === "clone") continue;
			if (entry.branch === undefined && entry.git === undefined && entry.detachedAt === undefined) {
				continue;
			}
			this.#registry.update(entry.workspaceId, {
				branch: undefined,
				git: undefined,
				detachedAt: undefined,
			});
		}
	}

	/**
	 * Linked worktree rows of a project that lost its `.git` are stale: their git
	 * metadata went with it, so they never come back. Asleep ones are evicted
	 * through onWorktreeRemoved (transcripts kept); a running one stays until it
	 * stops, and the next pass evicts it. In-memory only, no filesystem access.
	 */
	#evictOrphanedWorktrees(): void {
		if (!this.#onWorktreeRemoved) return;
		for (const entry of this.#registry.list()) {
			if (entry.worktreeOf === undefined || entry.workspace?.kind === "clone") continue;
			if (entry.status !== "asleep" || entry.projectId === undefined) continue;
			if (this.#registry.isProjectGit(entry.projectId)) continue;
			this.#onWorktreeRemoved(entry);
		}
	}

	/** Treat every row of a project as never probed (an asleep row then gets one fresh probe). */
	#forgetProbes(projectId: string): void {
		for (const entry of this.#registry.list()) {
			if (entry.projectId === projectId) this.#lastProbeAt.delete(entry.workspaceId);
		}
	}

	/**
	 * Start watchers for projects that have none and close those of removed
	 * projects. Returns the ids of the projects just started (they need one
	 * sync). A no-op until startGitStatePolling ran.
	 */
	#reconcileWatchers(): string[] {
		if (!this.#watching) return [];
		const projects = this.#registry.projects();
		const live = new Set(projects.map((project) => project.projectId));
		for (const projectId of [...this.#watches.keys()]) {
			if (live.has(projectId)) continue;
			this.#disposeWatch(this.#watches.get(projectId)!);
			this.#watches.delete(projectId);
			this.#pending.delete(projectId);
		}
		const started: string[] = [];
		for (const project of projects) {
			if (this.#watches.has(project.projectId)) continue;
			const watchState: ProjectWatch = {
				dir: null,
				gitDir: null,
				worktrees: null,
				debounce: null,
				poll: null,
				gitEvent: false,
				logged: false,
			};
			this.#watches.set(project.projectId, watchState);
			this.#armWatchers(project, watchState);
			started.push(project.projectId);
		}
		return started;
	}

	/**
	 * Arm the project's watchers for its current git state: the directory
	 * watch always, the `.git` and `.git/worktrees` watches for a git project.
	 * Any failure (inotify limit, network fs, `.git` not a directory, directory
	 * gone) leaves the project on the fallback poll; the reason is logged once.
	 */
	#armWatchers(project: RegisteredProject, state: ProjectWatch): void {
		const { projectId, path } = project;
		const dirName = basename(path);
		try {
			state.dir = watch(path, { persistent: false }, (_event, filename) => {
				const name = filename?.toString();
				if (name === ".git") state.gitEvent = true;
				if (name === undefined || name === ".git" || name === dirName) this.#signal(projectId);
			});
			state.dir.on("error", (err) => this.#watchFailed(project, state, err));
			if (this.#registry.isProjectGit(projectId)) {
				if (!statSync(join(path, ".git")).isDirectory()) {
					throw new Error(".git is not a directory (separate git dir?)");
				}
				state.gitDir = watch(join(path, ".git"), { persistent: false }, (_event, filename) => {
					const name = filename?.toString();
					if (name === undefined || name === "worktrees") this.#signal(projectId);
				});
				state.gitDir.on("error", (err) => this.#watchFailed(project, state, err));
				this.#openWorktreesWatch(project, state);
			}
		} catch (err) {
			this.#watchFailed(project, state, err);
			return;
		}
		if (state.poll) {
			clearInterval(state.poll);
			state.poll = null;
		}
	}

	/** Close and re-open every watcher of a project (a stale `.git` inode, or a git-state flip). */
	#rearmWatchers(project: RegisteredProject, state: ProjectWatch): void {
		this.#closeWatchers(state);
		this.#armWatchers(project, state);
	}

	/** Re-open the `.git/worktrees` watch (the directory may have been deleted and recreated since). */
	#refreshWorktreesWatch(project: RegisteredProject, state: ProjectWatch): void {
		if (state.gitDir === null) return;
		state.worktrees?.close();
		state.worktrees = null;
		try {
			this.#openWorktreesWatch(project, state);
		} catch (err) {
			this.#watchFailed(project, state, err);
		}
	}

	/** Watch `.git/worktrees` (any entry) while it exists; git removes it with its last worktree. */
	#openWorktreesWatch(project: RegisteredProject, state: ProjectWatch): void {
		const dir = join(project.path, ".git", "worktrees");
		if (!existsSync(dir)) return;
		state.worktrees = watch(dir, { persistent: false }, () => this.#signal(project.projectId));
		state.worktrees.on("error", (err) => this.#watchFailed(project, state, err));
	}

	/**
	 * A watcher failed to start or errored: close them all, log the reason once (unless the directory is simply gone),
	 * and poll the project instead. Each poll tick retries the watchers.
	 */
	#watchFailed(project: RegisteredProject, state: ProjectWatch, err: unknown): void {
		this.#closeWatchers(state);
		// A directory that is gone is the `missing` state, not a watcher failure.
		if (!state.logged && existsSync(project.path)) {
			state.logged = true;
			const reason = err instanceof Error ? err.message : String(err);
			console.error(
				`fleet: cannot watch project ${project.path} (${reason}); polling every ${Math.round(this.#fallbackPollMs / 1000)}s`,
			);
		}
		this.#ensurePoll(project, state);
	}

	/** Start the fallback poll (idempotent). Each tick retries the watchers, then syncs the project. */
	#ensurePoll(project: RegisteredProject, state: ProjectWatch): void {
		if (state.poll || !this.#watching) return;
		state.poll = setInterval(() => this.#signal(project.projectId, 0), this.#fallbackPollMs);
	}

	/** Debounced request to sync one project. */
	#signal(projectId: string, delayMs = this.#debounceMs): void {
		const state = this.#watches.get(projectId);
		if (!state || !this.#watching) return;
		if (state.debounce) clearTimeout(state.debounce);
		state.debounce = setTimeout(() => {
			state.debounce = null;
			if (!this.#watching) return;
			this.#pending.add(projectId);
			this.#kick();
		}, delayMs);
	}

	/** Close the project's fs watchers (the poll and debounce timers stay). */
	#closeWatchers(state: ProjectWatch): void {
		state.dir?.close();
		state.gitDir?.close();
		state.worktrees?.close();
		state.dir = null;
		state.gitDir = null;
		state.worktrees = null;
	}

	/** Close everything a project holds: watchers, debounce, poll. */
	#disposeWatch(state: ProjectWatch): void {
		this.#closeWatchers(state);
		if (state.debounce) clearTimeout(state.debounce);
		if (state.poll) clearInterval(state.poll);
		state.debounce = null;
		state.poll = null;
	}

	/**
	 * A row is due when it has never been probed or when it is not asleep. An
	 * asleep row that has been probed once stays frozen until it wakes (or its
	 * project flips to git, which forgets its probe).
	 */
	#probeDue(entry: RegistryEntry): boolean {
		return !this.#lastProbeAt.has(entry.workspaceId) || entry.status !== "asleep";
	}

	/**
	 * Probe one row (git state, then its session title) and reconcile the
	 * registry. Single-flight per row: a sync pass and a spawn-time probe of the
	 * same row share one run.
	 */
	#probeEntry(entry: RegistryEntry): Promise<void> {
		if (entry.cwd === "") return Promise.resolve();
		const inflight = this.#probing.get(entry.workspaceId);
		if (inflight) return inflight;
		const run = this.#probeRow(entry).finally(() => this.#probing.delete(entry.workspaceId));
		this.#probing.set(entry.workspaceId, run);
		return run;
	}

	/**
	 * The entry is re-read after the probe so a removal mid-probe is skipped;
	 * an update happens only on an actual branch/git change. The title probe
	 * runs whatever the git result: a git failure must not hide a title change,
	 * and a row of a non-git project (no git probe at all) still reads its title.
	 */
	async #probeRow(entry: RegistryEntry): Promise<void> {
		const result = await this.#probeGitOf(entry);
		const current = this.#registry.get(entry.workspaceId);
		if (!current) return; // removed while probing
		if (result === GIT_SKIPPED) {
			// Not a git row: nothing to reconcile (the sync clears stale fields).
		} else if (result === undefined) {
			// Probe failure (spawn error / nonzero exit / unparseable). The repo
			// may be gone: a TAGGED worktree whose cwd no longer exists on disk
			// is being evicted (e.g. `git worktree remove` outside the fleet), so
			// report it and return WITHOUT clearing branch/git; the server
			// orchestrates the eviction. A probe failure with the directory
			// still present keeps today's behavior (clear stale fields below).
			if (current.worktreeOf !== undefined && !existsSync(current.cwd)) {
				this.#onWorktreeRemoved?.(current);
				return;
			}
			// Clear stale fields only when previously set, so a never-probed
			// entry doesn't churn the registry with a no-op broadcast.
			if (
				current.branch !== undefined ||
				current.git !== undefined ||
				current.detachedAt !== undefined
			) {
				this.#registry.update(current.workspaceId, {
					branch: undefined,
					git: undefined,
					detachedAt: undefined,
				});
			}
		} else if (
			current.branch !== result.branch ||
			current.detachedAt !== result.detachedAt ||
			!sameGitState(current.git, result.git)
		) {
			this.#registry.update(current.workspaceId, {
				branch: result.branch,
				git: result.git,
				detachedAt: result.detachedAt,
			});
		}
		await this.#probeSessionInfo(this.#registry.get(entry.workspaceId) ?? entry);
	}

	/**
	 * Git state of one row's repo, or undefined (probe failed, or no repo yet),
	 * or GIT_SKIPPED for a non-clone row of a non-git project (no git runs, even
	 * for a running linked worktree orphaned by its project losing `.git`).
	 * A clone row's cwd is its volume root, which is not a repo: its repo is the
	 * checkout under it. A clone whose checkout has no `.git` yet spawns nothing.
	 */
	async #probeGitOf(entry: RegistryEntry): Promise<GitState | undefined | typeof GIT_SKIPPED> {
		if (entry.workspace?.kind !== "clone") {
			if (entry.projectId !== undefined && !this.#registry.isProjectGit(entry.projectId)) {
				return GIT_SKIPPED;
			}
			return probeGit(entry.cwd, { exec: this.#gitExec });
		}
		const checkout = cloneCheckoutDir(entry.cwd);
		if (!hasGitEntry(checkout)) return undefined;
		return probeGit(checkout, { exec: this.#gitExec });
	}

	/**
	 * Probe one entry's last-session-file title and emptiness (a new/empty
	 * session renders "New session" in the roster) and reconcile the
	 * registry. Entries with an empty cwd or no lastSessionFile are skipped.
	 * One registry.update happens only when title OR empty actually differs
	 * (a no-change keeps the registry quiet: no onChange, no roster broadcast);
	 * a file that became unreadable/untitled clears a previously-set title.
	 * sessionEmpty only carries meaning for untitled files; a titled session is never labeled
	 * "New session", so a title appearing clears a stale empty flag in the
	 * same update. The reader never throws.
	 */
	async #probeSessionInfo(entry: RegistryEntry): Promise<void> {
		if (entry.cwd === "" || !entry.lastSessionFile) return;
		const { title, empty } = await readSessionInfo(entry.lastSessionFile);
		const current = this.#registry.get(entry.workspaceId);
		if (!current) return; // removed while probing
		const wantEmpty = title === undefined && empty ? true : undefined;
		if (current.sessionTitle !== title || current.sessionEmpty !== wantEmpty) {
			this.#registry.update(current.workspaceId, {
				sessionTitle: title,
				sessionEmpty: wantEmpty,
			});
		}
	}

	/** Stop the sync timer and every watcher. Sessions are untouched: they outlive the control plane. */
	close(): void {
		if (this.#gitStateTimer) {
			clearInterval(this.#gitStateTimer);
			this.#gitStateTimer = null;
		}
		this.#watching = false;
		for (const state of this.#watches.values()) this.#disposeWatch(state);
		this.#watches.clear();
		this.#pending.clear();
	}
}
