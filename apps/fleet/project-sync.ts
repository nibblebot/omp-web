/**
 * ProjectSync: keeps the registry in step with git. Runtime ownership (spawn,
 * stop, respawn, exit and restart policy, credentials) lives in
 * workspace-lifecycle.ts; this module only observes.
 *
 * Sync (startGitStatePolling, syncNow) registers, per project, missing rows
 * (main checkout and linked worktrees, asleep), reconciles project.missing and
 * each worktree's lock flag. Per row it keeps branch, dirty counts, the
 * detached short sha, and the last-session-file title fresh for the roster.
 * Running rows are probed every tick; asleep rows every 60s.
 *
 * close() stops the poll; it never touches sessions.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RegisteredProject } from "#lib/wire/protocol";
import { probeGitState as probeGit, resolveWorktreeOf } from "./discovery";
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
const ASLEEP_SYNC_INTERVAL_MS = 60_000;
/** Max git probes in flight during one sync pass (rows probe in parallel). */
const SYNC_PROBE_CONCURRENCY = 4;

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
	/** Last probe time per daemonId; asleep rows wait ASLEEP_SYNC_INTERVAL_MS. */
	#lastProbeAt = new Map<string, number>();
	/** In-flight probe per daemonId: a sync pass and a spawn-time probe share one run. */
	#probing = new Map<string, Promise<void>>();
	/** Lifecycle-event hook (server.ts wires it to the fleet event ring). */
	#onEvent: ((level: FleetLogLevel, message: string, daemonId?: string) => void) | undefined;
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
			onEvent?: (level: FleetLogLevel, message: string, daemonId?: string) => void;
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
			if (worktreeOf !== undefined && this.#registry.get(entry.daemonId)) {
				this.#registry.update(entry.daemonId, { worktreeOf });
			}
		}
	}

	/**
	 * Start the sync timer: one immediate pass, then one per `intervalMs`
	 * (default 10s). Each tick calls syncNow(); rows whose cadence has not
	 * elapsed are skipped (asleep rows every 60s). Idempotent: a second call
	 * while the timer runs is ignored so passes never stack. `close()` stops
	 * the timer. The injected `exec` keeps tests hermetic.
	 */
	startGitStatePolling(opts?: { intervalMs?: number; exec?: GitRunner }): void {
		if (this.#gitStateTimer) return;
		this.#gitExec = opts?.exec;
		const intervalMs = opts?.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
		this.syncNow();
		this.#gitStateTimer = setInterval(() => this.syncNow(), intervalMs);
	}

	/**
	 * Run one sync pass now (sync_projects calls this). Requests that arrive
	 * while a pass runs coalesce into exactly one follow-up pass: passes never
	 * overlap.
	 */
	syncNow(): void {
		if (this.#syncing) {
			this.#syncQueued = true;
			return;
		}
		this.#syncing = this.#runSyncPasses();
	}

	/**
	 * One-off git-state probe for one daemon (fire-and-forget). A host spawn
	 * calls this right after entry creation so a fresh session shows its
	 * branch and dirty counts before the next poll tick. Uses the exec
	 * injected via startGitStatePolling (real git before that).
	 */
	probeGitState(daemonId: string): void {
		const entry = this.#registry.get(daemonId);
		if (!entry) return;
		void this.#probeEntry(entry);
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
	 * One pass: reconcile every project (its rows and project.missing), then
	 * probe every row whose cadence is due. Forgets probe times of removed rows.
	 */
	async #syncPass(): Promise<void> {
		// One realpath memo for the whole pass: projects and rows resolve each
		// distinct path once instead of once per row per project.
		const realpaths = new Map<string, string>();
		for (const project of this.#registry.projects()) {
			await this.#syncProject(project, realpaths);
		}
		const now = Date.now();
		const due = this.#registry.list().filter((entry) => this.#probeDue(entry, now));
		for (const entry of due) this.#lastProbeAt.set(entry.daemonId, now);
		await forEachLimit(due, SYNC_PROBE_CONCURRENCY, (entry) => this.#probeEntry(entry));
		for (const daemonId of this.#lastProbeAt.keys()) {
			if (!this.#registry.get(daemonId)) this.#lastProbeAt.delete(daemonId);
		}
	}

	/**
	 * Reconcile one project against its main checkout's worktree list. A
	 * missing, bare, or unreadable main checkout marks the project missing and
	 * is never removed. Otherwise the main row is ensured and every linked
	 * worktree without a row is registered asleep (prunable checkouts are
	 * skipped). Each linked row mirrors git's lock flag.
	 */
	async #syncProject(project: RegisteredProject, realpaths: Map<string, string>): Promise<void> {
		const blocks = await listWorktreeBlocks(project.path);
		const main = blocks?.[0];
		const missing = main === undefined || main.bare === true;
		this.#registry.setProjectMissing(project.projectId, missing);
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
				this.#registry.update(row.daemonId, { worktreeLocked: locked });
			}
		}
	}

	/**
	 * A row is due when it has never been probed, when it is not asleep (live
	 * rows are probed on every pass), or when its asleep interval has elapsed.
	 */
	#probeDue(entry: RegistryEntry, now: number): boolean {
		const last = this.#lastProbeAt.get(entry.daemonId);
		if (last === undefined || entry.status !== "asleep") return true;
		return now - last >= ASLEEP_SYNC_INTERVAL_MS;
	}

	/**
	 * Probe one row (git state, then its session title) and reconcile the
	 * registry. Single-flight per row: a sync pass and a spawn-time probe of the
	 * same row share one run.
	 */
	#probeEntry(entry: RegistryEntry): Promise<void> {
		if (entry.cwd === "") return Promise.resolve();
		const inflight = this.#probing.get(entry.daemonId);
		if (inflight) return inflight;
		const run = this.#probeRow(entry).finally(() => this.#probing.delete(entry.daemonId));
		this.#probing.set(entry.daemonId, run);
		return run;
	}

	/**
	 * The entry is re-read after the probe so a removal mid-probe is skipped;
	 * an update happens only on an actual branch/git change. The title probe
	 * runs whatever the git result: a git failure must not hide a title change.
	 */
	async #probeRow(entry: RegistryEntry): Promise<void> {
		const result = await this.#probeGitOf(entry);
		const current = this.#registry.get(entry.daemonId);
		if (!current) return; // removed while probing
		if (result === undefined) {
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
				this.#registry.update(current.daemonId, {
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
			this.#registry.update(current.daemonId, {
				branch: result.branch,
				git: result.git,
				detachedAt: result.detachedAt,
			});
		}
		await this.#probeSessionInfo(this.#registry.get(entry.daemonId) ?? entry);
	}

	/**
	 * Git state of one row's repo, or undefined (probe failed, or no repo yet).
	 * A clone row's cwd is its volume root, which is not a repo: its repo is the
	 * checkout under it. A clone whose checkout has no `.git` yet spawns nothing.
	 */
	async #probeGitOf(entry: RegistryEntry): Promise<GitState | undefined> {
		if (entry.workspace?.kind !== "clone") {
			return probeGit(entry.cwd, { exec: this.#gitExec });
		}
		const checkout = cloneCheckoutDir(entry.cwd);
		if (!existsSync(join(checkout, ".git"))) return undefined;
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
		const current = this.#registry.get(entry.daemonId);
		if (!current) return; // removed while probing
		const wantEmpty = title === undefined && empty ? true : undefined;
		if (current.sessionTitle !== title || current.sessionEmpty !== wantEmpty) {
			this.#registry.update(current.daemonId, {
				sessionTitle: title,
				sessionEmpty: wantEmpty,
			});
		}
	}

	/** Stop the git-state poll. Sessions are untouched: they outlive the control plane. */
	close(): void {
		if (this.#gitStateTimer) {
			clearInterval(this.#gitStateTimer);
			this.#gitStateTimer = null;
		}
	}
}
