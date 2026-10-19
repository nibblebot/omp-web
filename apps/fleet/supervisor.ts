/**
 * SpawnSupervisor: owns spawned omp-session children and the callback
 * credentials they dial back with.
 *
 * Sessions connect OUT to the control plane (callback pair); the fleet never
 * dials a session. spawn() creates a "spawned" registry entry, enrolls a
 * fresh callback credential for the next generation (enrollSessionCredential),
 * fills the spawn template, and runs it via `sh -c` as a detached child (its
 * own process group, so a terminal Ctrl+C never reaches sessions). Child
 * stdout and stderr are appended to `<state dir>/session-logs/<daemonId>.log`.
 * Each launch first rotates a log above 1 MiB to `<daemonId>.log.1` (one
 * generation kept): one run is uncapped, but restarts bound the disk use.
 * prune() deletes both files. stderrTail() reads the last 64 KiB of the log
 * (a provider-managed clone reads its daemon.log). The entry is "connecting"
 * until its pair appears; no pair within PAIR_TIMEOUT_MS → status error and
 * the child is killed.
 *
 * Exit policy: exit 0 (a session that shut itself down, e.g. its control
 * grace expired) → "asleep", no restart. Exit OMP_SESSION_EXIT_SESSION_LOCKED
 * (the session file is open in another omp-session) or
 * OMP_SESSION_EXIT_RESUME_FAILED (its --resume session cannot be restored):
 * deterministic, so no restart; the entry goes "asleep" carrying the child's
 * last log line as its reason. Any other unexpected exit restarts with a FRESH
 * credential, bounded
 * backoff 1s→30s jittered, at most restartMax (default 5) restarts, then status
 * "error". The budget refills only after a pair holds for STABLE_PAIR_MS, so a
 * pair-then-crash loop still exhausts it. respawn()/stop() are the intentional paths:
 * respawn uses `{resume} = "--resume <lastSessionFile>"` when the session has
 * one (R3); stop() asks a paired session to shut down (ShutdownControl),
 * SIGTERMs its group, escalates to SIGKILL after 5s, revokes the credential,
 * and sets status "asleep" (respawnable).
 *
 * close() stops the git poll and the supervisor's timers only: children keep
 * running and their enrollments persist, so sessions outlive the control plane.
 *
 * Sync (startGitStatePolling, syncNow) keeps the registry in step with git.
 * Per project it registers missing rows (main checkout and linked worktrees),
 * reconciles project.missing and each worktree's lock flag. Per row it keeps
 * branch, dirty counts, the detached short sha, and the last-session-file
 * title fresh for the roster. Running rows are probed every tick; asleep rows
 * every 60s.
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Subprocess } from "bun";
import {
	CALLBACK_TRANSPORT_STREAM_ID,
	ENROLLMENT_KEY_BYTES,
	type ShutdownControl,
} from "#lib/wire/callback-protocol";
import {
	OMP_SESSION_EXIT_RESUME_FAILED,
	OMP_SESSION_EXIT_SESSION_LOCKED,
	type RegisteredProject,
} from "#lib/wire/protocol";
import type { FleetConfig, SpawnTemplate } from "./config";
import { fillTemplate, shellQuote } from "./spawn-parse";
import type { DaemonTransportRegistry } from "./daemon-transport";
import { probeGitState as probeGit, resolveWorktreeOf } from "./discovery";
import type { GitRunner, GitState } from "./discovery";
import { sessionLiveness } from "./session-liveness";
import {
	PROVIDER_DAEMON_LOG,
	readSessionLogTail,
	removeSessionLog,
	rotateSessionLog,
} from "./session-log";
import { cloneCheckoutDir } from "./workspace-lifecycle";
import { readSessionInfo } from "./session-title";
import type { Registry, RegistryEntry } from "./registry";
import {
	listWorktreeBlocks,
	realpathOf,
	registerProjectMainEntry,
	registerWorktreeEntry,
} from "./worktrees";
import type { FleetLogLevel } from "./events";

type Child = Subprocess<"pipe", number, number>;

/** A session's callback credential for one generation (the raw token is handed to the child once). */
export interface SessionEnrollment {
	generation: number;
	credential: string;
}

/** Collaborators the supervisor needs beyond the registry and config. */
export interface SupervisorDeps {
	transport: DaemonTransportRegistry;
	/** The fleet state file; session logs live beside it under session-logs/. */
	statePath: string;
	/** The callback URL children dial (server #callbackUrl()). */
	callbackUrl: () => string;
	/** Overrides PAIR_TIMEOUT_MS (tests). */
	pairTimeoutMs?: number;
	/**
	 * Fired after each launch enrolls the entry's callback credential, so the
	 * server can watch the entry's pair for status (covers edge-initiated spawns).
	 */
	onEnrolled?: (daemonId: string) => void;
}

interface ChildState {
	daemonId: string;
	child: Child | null;
	restarts: number;
	restartTimer: ReturnType<typeof setTimeout> | null;
	/** Armed per launch: a pair must appear within the pair timeout. */
	pairTimer: ReturnType<typeof setTimeout> | null;
	/** Armed when a pair lands: the restart budget refills only if the pair holds for STABLE_PAIR_MS. */
	stableTimer: Timer | null;
	/** Unsubscribe from the transport's pair-change feed (set once, at ensure time). */
	pairUnsub: (() => void) | null;
	stopping: boolean;
	/** Exit summary of the child stop() terminated; stop() reports it on its one line. */
	stopExit?: string;
	/** respawn() already launched a replacement; the old child's exit must not restart. */
	manualRespawn: boolean;
	/** In-flight respawn() promise; concurrent respawn() calls coalesce onto it (one launch). */
	respawnInFlight: Promise<void> | null;
	exitHandled: boolean;
}

/** Exported so tests and the launch path share one pair-timeout budget. */
export const PAIR_TIMEOUT_MS = 60_000;
/** A pair must hold this long before its restarts are forgiven; a pair-then-crash loop still exhausts restartMax. */
const STABLE_PAIR_MS = 60_000;
const DEFAULT_RESTART_MAX = 5;
const STDERR_TAIL_BYTES = 64 * 1024;
const STOP_SIGTERM_GRACE_MS = 5_000;
const RESPAWN_KILL_GRACE_MS = 2_000;
const RESPAWN_LOCK_POLL_MS = 100;
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_SYNC_INTERVAL_MS = 10_000;
const ASLEEP_SYNC_INTERVAL_MS = 60_000;
/** Max git probes in flight during one sync pass (rows probe in parallel). */
const SYNC_PROBE_CONCURRENCY = 4;
const DETERMINISTIC_EXIT_FALLBACK = "session refused to run and will not be retried";

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
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

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Enroll a fresh callback credential for the entry's next generation. The
 * previous generation is revoked and cleared FIRST (P6.2 fencing order, as in
 * workspace-lifecycle): a stale credential can never authenticate against
 * the new launch. The generation is monotonic: one above both the persisted
 * enrollment and the last authorized generation, so it survives a stop
 * (which clears the enrollment). The registry keeps only the digest.
 */
export function enrollSessionCredential(
	transport: DaemonTransportRegistry,
	registry: Registry,
	daemonId: string,
): SessionEnrollment {
	const entry = registry.get(daemonId);
	if (!entry) throw new Error(`unknown daemon ${daemonId}`);
	const previous = entry.workspace?.enrollment;
	if (previous !== undefined) {
		transport.revokeEnrollment(daemonId, previous.generation);
		registry.clearWorkspaceEnrollment(daemonId, previous.generation);
	}
	const generation =
		Math.max(previous?.generation ?? 0, entry.workspace?.authorizedGeneration ?? 0) + 1;
	const credential = randomBytes(ENROLLMENT_KEY_BYTES).toString("hex");
	const digest = transport.enrollWorkspace(daemonId, generation, credential);
	registry.setWorkspaceEnrollment(daemonId, { credentialHash: digest, generation });
	registry.updateWorkspace(daemonId, { authorizedGeneration: generation });
	return { generation, credential };
}

/** Revoke the entry's live callback enrollment and clear its binding (no-op when none). */
export function releaseSessionCredential(
	transport: DaemonTransportRegistry,
	registry: Registry,
	daemonId: string,
): void {
	const enrollment = registry.get(daemonId)?.workspace?.enrollment;
	if (enrollment === undefined) return;
	transport.revokeEnrollment(daemonId, enrollment.generation);
	registry.clearWorkspaceEnrollment(daemonId, enrollment.generation);
}

/**
 * Ask a paired session to shut down gracefully (ShutdownControl on the
 * reserved transport stream). Best effort: resolves false when no pair is
 * live or the send is refused; callers tear the session down regardless.
 */
export async function requestSessionShutdown(
	transport: DaemonTransportRegistry,
	daemonId: string,
	reason: string,
): Promise<boolean> {
	if (!transport.pairStatus(daemonId).paired) return false;
	const control: ShutdownControl = { type: "shutdown", reason };
	try {
		await transport.sendToDaemon(daemonId, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: control,
		});
		return true;
	} catch {
		// The pair dropped between the check and the send; the caller's
		// teardown still ends the session.
		return false;
	}
}

/**
 * The `--fleet-stdin` payload for one child: the daemon's only source of its callback pair and
 * listener token, so neither reaches its argv or environment. `allowHttp` is set only for an http
 * callback URL (the daemon honors it for loopback hosts only).
 */
export function fleetStdinPayload(
	callback: { url: string; daemonId: string; enrollment: SessionEnrollment },
	listenerToken: string,
): string {
	const httpCallback = new URL(callback.url).protocol === "http:";
	return JSON.stringify({
		v: 1,
		callback: {
			url: callback.url,
			workspace: callback.daemonId,
			generation: callback.enrollment.generation,
			token: callback.enrollment.credential,
			...(httpCallback ? { allowHttp: true } : {}),
		},
		token: listenerToken,
	});
}

/**
 * The child's inherited environment with the fleet's own secrets removed: an ambient
 * OMP_SESSION_CALLBACK_* or OMP_SESSION_TOKEN never reaches a child.
 */
function inheritedChildEnv(base: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (key.startsWith("OMP_SESSION_CALLBACK_") || key === "OMP_SESSION_TOKEN") continue;
		env[key] = value;
	}
	return env;
}

/** Signal the child's process group (grandchildren included); falls back to the child alone. */
function signalGroup(child: Child, signal: NodeJS.Signals): void {
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The group is already gone (or never formed); signal the child itself.
		child.kill(signal);
	}
}

export class SpawnSupervisor {
	#registry: Registry;
	#config: FleetConfig;
	#deps: SupervisorDeps;
	#pairTimeoutMs: number;
	#restartMax: number;
	#stablePairMs: number;
	#backoffMinMs: number;
	#backoffMaxMs: number;
	#children = new Map<string, ChildState>();
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
		config: FleetConfig,
		deps: SupervisorDeps,
		opts?: {
			restartMax?: number;
			/** How long a pair must hold before the restart budget refills (tests shorten it). */
			stablePairMs?: number;
			backoffMinMs?: number;
			backoffMaxMs?: number;
			/** Fired on spawn/pair/exit/stop/respawn/prune lifecycle transitions. */
			onEvent?: (level: FleetLogLevel, message: string, daemonId?: string) => void;
			/**
			 * Fired during git-state polling when a tagged worktree's cwd
			 * vanished on disk (probe failed AND the directory no longer
			 * exists). Detection only; eviction orchestration (prune/drop,
			 * registry.remove, roster broadcast, toast) is the caller's job.
			 * At most meaningful once per entry (the server dedups).
			 */
			onWorktreeRemoved?: (entry: RegistryEntry) => void;
		},
	) {
		this.#registry = registry;
		this.#config = config;
		this.#deps = deps;
		this.#pairTimeoutMs = deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS;
		this.#restartMax = opts?.restartMax ?? DEFAULT_RESTART_MAX;
		this.#stablePairMs = opts?.stablePairMs ?? STABLE_PAIR_MS;
		this.#backoffMinMs = opts?.backoffMinMs ?? RESTART_BACKOFF_MIN_MS;
		this.#backoffMaxMs = opts?.backoffMaxMs ?? RESTART_BACKOFF_MAX_MS;
		this.#onEvent = opts?.onEvent;
		this.#onWorktreeRemoved = opts?.onWorktreeRemoved;
	}

	/**
	 * Resolve the template NAME for a cwd: explicit →
	 * `projectTemplates[basename(cwd)]` → `defaultTemplate`; throws when the
	 * resolved name is not in `templates` (spawn rejects before any entry is
	 * created). Stored on the entry so respawn() finds the same template.
	 */
	resolveTemplateName(cwd: string, explicit?: string): string {
		const name =
			explicit ?? this.#config.projectTemplates?.[basename(cwd)] ?? this.#config.defaultTemplate;
		if (this.#config.templates[name] === undefined) {
			throw new Error(`unknown spawn template: ${name}`);
		}
		return name;
	}

	/**
	 * Create a spawned entry, launch its child, and return the entry. The
	 * child dials the control plane itself; the entry turns "ready" when its
	 * pair appears (server.ts) or fails after PAIR_TIMEOUT_MS.
	 *
	 * Template resolution (first match wins): an explicit `init.template`,
	 * else `config.projectTemplates[basename(cwd)]`, else
	 * `config.defaultTemplate`. An unknown template name at any tier rejects
	 * before any entry is created.
	 *
	 * A cwd inside a linked git worktree is tagged with the owning repo's
	 * name (worktreeOf) so the roster can group it; a main checkout or an
	 * unresolvable cwd stays untagged.
	 *
	 * `reuse`: the fleet's own create/start paths pass it so a row the sync
	 * registered for this checkout meanwhile is woken instead of duplicated
	 * (an asleep or errored row respawns; a live one is returned as is).
	 * Without it a spawn always adds a row: several sessions per folder stay a
	 * deliberate CLI/`/ctl/spawn` capability.
	 */
	async spawn(init: {
		cwd: string;
		template?: string;
		name?: string;
		labels?: string[];
		reuse?: boolean;
	}): Promise<RegistryEntry> {
		const project = basename(init.cwd);
		const templateName = this.resolveTemplateName(init.cwd, init.template);
		const template = this.#config.templates[templateName];
		const worktreeOf = await resolveWorktreeOf(init.cwd);
		if (init.reuse) {
			// After the last await: the sync's own lookup + create is synchronous,
			// so no row can slip in between this lookup and the create below.
			const resolved = realpathOf(init.cwd);
			const existing = this.#registry
				.list()
				.find(
					(entry) =>
						entry.cwd !== "" &&
						entry.workspace?.kind !== "clone" &&
						realpathOf(entry.cwd) === resolved,
				);
			if (existing !== undefined) {
				if (existing.status === "asleep" || existing.status === "error") {
					await this.respawn(existing);
				}
				return this.#registry.get(existing.daemonId) ?? existing;
			}
		}
		const entry = this.#registry.create({
			name: init.name ?? project,
			cwd: init.cwd,
			project,
			...(worktreeOf !== undefined ? { worktreeOf } : {}),
			labels: init.labels ?? [],
			template: templateName,
		});
		this.#launch(entry, template, { resume: false });
		// Give the fresh entry its branch/git before the next poll tick.
		this.probeGitState(entry.daemonId);
		return entry;
	}

	/**
	 * R3 rule: respawn = --resume lastSessionFile when known. A fresh token and
	 * credential per attempt. Serialized per daemon: while one respawn is in
	 * flight, a concurrent call coalesces onto the SAME in-flight promise; the
	 * child is never launched twice and an orphan is never left behind. A
	 * failed respawn drops the slot so a later call can retry.
	 */
	async respawn(entry: RegistryEntry, opts?: { resumeFile?: string }): Promise<void> {
		const current = this.#registry.get(entry.daemonId) ?? entry;
		// Fallback for template-less entries (registered asleep, or state
		// files written before entries stored the resolved name): resolve the
		// same name spawn() would for the cwd.
		const templateName = current.template ?? this.resolveTemplateName(current.cwd);
		const template = this.#config.templates[templateName];
		if (!template) throw new Error(`unknown spawn template: ${templateName}`);
		// Heal the persisted entry so later respawns skip the fallback.
		if (current.template === undefined) {
			this.#registry.update(current.daemonId, { template: templateName });
		}
		const state = this.#ensure(current.daemonId);
		if (state.respawnInFlight) return state.respawnInFlight;
		const inFlight = this.#respawnNow(state, current, template, opts?.resumeFile);
		state.respawnInFlight = inFlight;
		try {
			await inFlight;
		} finally {
			// Only clear when this call still owns the slot (a newer respawn
			// may have started after we settled).
			if (state.respawnInFlight === inFlight) state.respawnInFlight = null;
		}
	}

	/** The respawn body, run under respawn()'s per-daemon coalescing guard. */
	async #respawnNow(
		state: ChildState,
		current: RegistryEntry,
		template: SpawnTemplate,
		resumeFile?: string,
	): Promise<void> {
		if (state.restartTimer) {
			clearTimeout(state.restartTimer);
			state.restartTimer = null;
		}
		// An adopted row has no child handle here, so its previous process may still
		// hold the session lock. Launching now would race that process for the lock
		// (the loser exits 77), so wait for the release or refuse.
		if (!state.child) await this.#awaitLockRelease(current);
		state.stopping = false;
		state.manualRespawn = true;
		// Replace the child; the old child's death is expected (manualRespawn),
		// and #launch revokes the old credential when it enrolls the new one.
		if (state.child) {
			await this.#terminate(state.child, RESPAWN_KILL_GRACE_MS);
			state.child = null;
		}
		// The launch's own event line names it a respawn (and --resume).
		this.#launch(this.#registry.get(current.daemonId) ?? current, template, {
			resume: true,
			resumeFile,
		});
	}

	/**
	 * Adopted-row respawn: a session this supervisor never launched may still hold
	 * its lock. Ask it to shut down and wait up to RESPAWN_KILL_GRACE_MS for the
	 * lock to free; throw when it still holds it. A dead or unknown session passes.
	 */
	async #awaitLockRelease(entry: RegistryEntry): Promise<void> {
		if (sessionLiveness(entry) !== "alive") return;
		await requestSessionShutdown(this.#deps.transport, entry.daemonId, "respawn");
		const deadline = Date.now() + RESPAWN_KILL_GRACE_MS;
		while (sessionLiveness(entry) === "alive") {
			if (Date.now() >= deadline) {
				throw new Error(`session ${entry.name} still holds its lock; respawn refused`);
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, RESPAWN_LOCK_POLL_MS);
			await promise;
		}
	}

	/**
	 * Intentional stop: cancel restarts, ask a paired session to shut down
	 * (ShutdownControl), SIGTERM → 5s → SIGKILL our own child, revoke the
	 * callback credential, and set status "asleep" (respawnable, lastSessionFile
	 * kept). Also serves remote entries: no child to kill, the paired session
	 * is asked to exit and its enrollment is revoked.
	 */
	async stop(daemonId: string): Promise<void> {
		const state = this.#children.get(daemonId);
		if (state) {
			state.stopping = true;
			this.#clearTimers(state);
		}
		await requestSessionShutdown(this.#deps.transport, daemonId, "stop");
		const killed = state?.child != null;
		if (state?.child) {
			state.stopExit = undefined;
			await this.#terminate(state.child, STOP_SIGTERM_GRACE_MS);
			state.child = null;
		}
		releaseSessionCredential(this.#deps.transport, this.#registry, daemonId);
		if (this.#registry.get(daemonId)) {
			this.#registry.setStatus(daemonId, "asleep");
		}
		// One line per stop that actually ended a child (stopping an already
		// asleep entry, e.g. on fleet shutdown, is a no-op and stays quiet).
		if (killed) this.#onEvent?.("info", `stop (${state?.stopExit ?? "exited"})`, daemonId);
	}

	/**
	 * Removal-time cleanup: stop() (cancel restarts, ask the session to shut
	 * down, kill the child, revoke, status asleep), then drop the per-daemon
	 * ChildState: restart budget, timers, and the pair-change subscription, so
	 * a removed daemon leaks nothing. stop() alone keeps the state (the daemon
	 * stays respawnable); prune() is for registry removal only. Idempotent
	 * for daemons the supervisor never tracked.
	 */
	async prune(daemonId: string): Promise<void> {
		await this.stop(daemonId);
		this.#children.get(daemonId)?.pairUnsub?.();
		this.#children.delete(daemonId);
		removeSessionLog(this.#logPath(daemonId));
		this.#onEvent?.("info", "prune", daemonId);
	}

	/**
	 * Per-daemon supervisor state for /ctl/debug: the live child's pid
	 * (absent when nothing is running) and the consecutive-restart counter.
	 */
	snapshot(): Record<string, { pid?: number; restarts: number }> {
		const out: Record<string, { pid?: number; restarts: number }> = {};
		for (const [daemonId, state] of this.#children) {
			const info: { pid?: number; restarts: number } = { restarts: state.restarts };
			if (state.child) info.pid = state.child.pid;
			out[daemonId] = info;
		}
		return out;
	}

	/**
	 * The child's log (stdout and stderr, appended per launch): the last 64 KiB
	 * as text, empty when the child never logged. Read from the file, so it
	 * survives a fleet restart. A provider-managed clone logs to its own
	 * daemon.log instead.
	 */
	stderrTail(daemonId: string): string {
		const local = readSessionLogTail(this.#logPath(daemonId), STDERR_TAIL_BYTES);
		const entry = this.#registry.get(daemonId);
		if (local !== "" || entry?.workspace === undefined || entry.cwd === undefined) return local;
		// Mirrors the provider's clone layout (workspace-lifecycle #clonePaths):
		// state dir = <dirname(clone root)>/.provider-state/<daemonId>.
		const stateDir = join(dirname(entry.cwd), ".provider-state", daemonId);
		return readSessionLogTail(join(stateDir, PROVIDER_DAEMON_LOG), STDERR_TAIL_BYTES);
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
	 * One-off git-state probe for one daemon (fire-and-forget). spawn()
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
		await registerProjectMainEntry(this.#registry, this, project, { realpaths });
		for (const block of blocks.slice(1)) {
			if (block.path === undefined || block.prunable) continue;
			const resolved = realpathOf(block.path, realpaths);
			const known = this.#registry
				.list()
				.find((entry) => entry.cwd !== "" && realpathOf(entry.cwd, realpaths) === resolved);
			const row =
				known ??
				(await registerWorktreeEntry(this.#registry, this, project, block.path, { start: false }));
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

	/**
	 * Stop the git-state poll and the supervisor's own timers. Children keep
	 * running and their callback enrollments persist: sessions outlive the
	 * control plane and redial the next one.
	 */
	close(): void {
		if (this.#gitStateTimer) {
			clearInterval(this.#gitStateTimer);
			this.#gitStateTimer = null;
		}
		for (const state of this.#children.values()) {
			this.#clearTimers(state);
			state.pairUnsub?.();
			state.pairUnsub = null;
		}
	}

	#logPath(daemonId: string): string {
		return join(dirname(this.#deps.statePath), "session-logs", `${daemonId}.log`);
	}

	#clearTimers(state: ChildState): void {
		if (state.restartTimer) {
			clearTimeout(state.restartTimer);
			state.restartTimer = null;
		}
		if (state.pairTimer) {
			clearTimeout(state.pairTimer);
			state.pairTimer = null;
		}
		if (state.stableTimer) {
			clearTimeout(state.stableTimer);
			state.stableTimer = null;
		}
	}

	#ensure(daemonId: string): ChildState {
		let state = this.#children.get(daemonId);
		if (!state) {
			const created: ChildState = {
				daemonId,
				child: null,
				restarts: 0,
				restartTimer: null,
				pairTimer: null,
				stableTimer: null,
				pairUnsub: null,
				stopping: false,
				manualRespawn: false,
				respawnInFlight: null,
				exitHandled: false,
			};
			// A pair that holds for STABLE_PAIR_MS refills the restart budget, so
			// restartMax bounds crash LOOPS (pair, crash, pair, crash), not lifetime restarts.
			created.pairUnsub = this.#deps.transport.onPairChange(daemonId, (status) => {
				if (created.stableTimer) {
					clearTimeout(created.stableTimer);
					created.stableTimer = null;
				}
				if (!status.paired) return;
				if (created.pairTimer) {
					clearTimeout(created.pairTimer);
					created.pairTimer = null;
				}
				created.stableTimer = setTimeout(() => {
					created.stableTimer = null;
					created.restarts = 0;
				}, this.#stablePairMs);
			});
			this.#children.set(daemonId, created);
			state = created;
		}
		return state;
	}

	/** Spawn one child for the entry with a fresh token and credential. */
	#launch(
		entry: RegistryEntry,
		template: SpawnTemplate,
		opts: { resume: boolean; resumeFile?: string },
	): void {
		const daemonId = entry.daemonId;
		const state = this.#ensure(daemonId);
		state.manualRespawn = false;
		state.exitHandled = false;
		if (state.pairTimer) {
			clearTimeout(state.pairTimer);
			state.pairTimer = null;
		}
		const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		const enrollment = enrollSessionCredential(this.#deps.transport, this.#registry, daemonId);
		this.#deps.onEnrolled?.(daemonId);
		// Every value interpolated into the template command is
		// attacker-controlled at some call site (POST /ctl/spawn name/labels)
		// and lands in `sh -c`; shell-quote each one so it can never break
		// out into command execution (CVE-style injection defense).
		const labelsArg = (entry.labels ?? []).map((label) => `--label ${shellQuote(label)}`).join(" ");
		// R3: resume = --resume <file>. default to the entry's last session file;
		// opts.resumeFile overrides it for a dropdown-picked session (the edge
		// validates it belongs to the worktree before it ever gets here).
		const resumeFile =
			opts.resumeFile && opts.resumeFile.trim() !== "" ? opts.resumeFile : entry.lastSessionFile;
		// Strict unless the file is known unwritten: an explicit pick, or a file the daemon
		// reported persisted, must exist (a missing one exits 78). Otherwise a never-prompted
		// session's recorded path may not exist yet, so the daemon adopts it (identity kept).
		const resumeStrict =
			(opts.resumeFile !== undefined && opts.resumeFile.trim() !== "") ||
			entry.lastSessionPersisted === true;
		const resumeArg =
			opts.resume && resumeFile
				? `--resume ${shellQuote(resumeFile)}${resumeStrict ? "" : " --resume-unwritten"}`
				: "";
		const command = fillTemplate(template.command, {
			cwd: shellQuote(entry.cwd),
			fleet: "--fleet-stdin",
			name: shellQuote(entry.name),
			labels: labelsArg,
			resume: resumeArg,
		});
		const stdinPayload = fleetStdinPayload(
			{ url: this.#deps.callbackUrl(), daemonId, enrollment },
			token,
		);
		const logPath = this.#logPath(daemonId);
		mkdirSync(dirname(logPath), { recursive: true });
		rotateSessionLog(logPath);
		const logFd = openSync(logPath, "a");
		let child: Child;
		try {
			// Detached: its own session and process group, so a terminal
			// Ctrl+C never reaches the child; stdin carries the --fleet-stdin payload (written below).
			child = Bun.spawn(["sh", "-c", command], {
				stdin: "pipe",
				stdout: logFd,
				stderr: logFd,
				detached: true,
				env: {
					...inheritedChildEnv(process.env),
					OMP_SESSION_LOG_MIRROR: "0",
				},
			});
		} catch (err) {
			releaseSessionCredential(this.#deps.transport, this.#registry, daemonId);
			this.#registry.setStatus(daemonId, "error", `spawn failed: ${(err as Error).message}`);
			this.#onEvent?.("error", `spawn failed: ${(err as Error).message}`, daemonId);
			return;
		} finally {
			// The child holds its own copy of the descriptor.
			closeSync(logFd);
		}
		// The daemon reads its callback pair and listener token from stdin to EOF. A write racing the
		// child's exit is not ours to report: the exit handler records that outcome.
		try {
			child.stdin.write(stdinPayload);
			child.stdin.end();
		} catch {
			// The child exited before reading its payload.
		}
		state.child = child;
		// One line per launch: spawn vs respawn (resume) and the template.
		const verb = opts.resume ? `respawn${resumeArg !== "" ? " --resume" : ""}` : "spawn";
		this.#onEvent?.("info", `${verb} template=${entry.template ?? "?"}`, daemonId);
		this.#registry.update(daemonId, { pid: child.pid });
		this.#registry.setStatus(daemonId, "connecting");
		// No pair within the window → error + kill (a session that cannot reach
		// the control plane never becomes ready).
		state.pairTimer = setTimeout(() => this.#onPairTimeout(state, child), this.#pairTimeoutMs);
		// Exit handling via `exited` (not the onExit spawn option): state.child
		// is assigned before the promise attaches, so an instant child exit can
		// never be observed before we can correlate it, and a replaced child's
		// late exit is ignored by the identity guard.
		void child.exited
			.then((exitCode) => {
				if (state.child !== child) return; // a replaced child's exit is not ours
				state.child = null;
				if (state.pairTimer) {
					clearTimeout(state.pairTimer);
					state.pairTimer = null;
				}
				if (state.stableTimer) {
					clearTimeout(state.stableTimer);
					state.stableTimer = null;
				}
				this.#onChildExit(state, exitCode, child.signalCode ?? null);
			})
			.catch((err: unknown) => {
				// #onChildExit threw (e.g. the log tail could not be read): the entry would
				// otherwise keep its last status with no restart and no reason.
				releaseSessionCredential(this.#deps.transport, this.#registry, daemonId);
				const message = `exit handling failed: ${(err as Error).message}`;
				this.#registry.setStatus(daemonId, "error", message);
				this.#onEvent?.("error", message, daemonId);
			});
	}

	/** The launch's pair window elapsed without a pair: fail the entry and kill the child. */
	#onPairTimeout(state: ChildState, child: Child): void {
		state.pairTimer = null;
		if (state.child !== child || this.#deps.transport.pairStatus(state.daemonId).paired) return;
		state.exitHandled = true; // we own the aftermath, no restart
		const message = `no callback pair within ${this.#pairTimeoutMs / 1000}s`;
		releaseSessionCredential(this.#deps.transport, this.#registry, state.daemonId);
		this.#registry.setStatus(state.daemonId, "error", message);
		this.#onEvent?.("error", message, state.daemonId);
		void this.#terminate(child, STOP_SIGTERM_GRACE_MS);
	}

	#onChildExit(state: ChildState, exitCode: number, signalCode: string | null): void {
		if (state.exitHandled) return;
		state.exitHandled = true;
		const entry = this.#registry.get(state.daemonId);
		if (!entry) return;
		const exit = `exit code=${exitCode}${signalCode !== null ? ` signal=${signalCode}` : ""}`;
		if (state.stopping) {
			// stop() owns the aftermath (status asleep) and reports the exit on
			// its own line.
			state.stopExit = exit;
			return;
		}
		if (state.manualRespawn) {
			// respawn() already launched a replacement; the old child's exit is expected.
			this.#onEvent?.("info", `${exit} (replaced)`, state.daemonId);
			return;
		}
		// P6.4: the fleet is the SOLE idle-stop authority for provider-managed
		// clone workspaces; their compute is not a child of this supervisor.
		if (entry.workspace?.kind === "clone") {
			// A clone workspace's child is provider-owned; if it exited, the
			// provider has already reconciled it; do not race it with this
			// supervisor's restart budget. The desired state + reconciliation
			// decide the next step.
			this.#onEvent?.("info", `${exit} (clone workspace; provider-managed)`, state.daemonId);
			return;
		}
		if (
			exitCode === OMP_SESSION_EXIT_SESSION_LOCKED ||
			exitCode === OMP_SESSION_EXIT_RESUME_FAILED
		) {
			// Deterministic refusals: another omp-session holds the session file
			// (77), or --resume names a session that cannot be restored (78). Dormant
			// (no restart), with the child's last log line as the reason.
			const reason = this.#deterministicExitReason(state.daemonId);
			releaseSessionCredential(this.#deps.transport, this.#registry, state.daemonId);
			this.#registry.setStatus(state.daemonId, "asleep", reason);
			this.#onEvent?.("error", reason, state.daemonId);
			return;
		}
		if (exitCode === 0 && signalCode === null) {
			// The session shut itself down cleanly (e.g. its control grace
			// expired, or a credential it held was revoked): dormant, not restarted.
			releaseSessionCredential(this.#deps.transport, this.#registry, state.daemonId);
			this.#registry.setStatus(state.daemonId, "asleep");
			this.#onEvent?.("info", `${exit} clean → asleep`, state.daemonId);
			return;
		}
		if (state.restarts >= this.#restartMax) {
			releaseSessionCredential(this.#deps.transport, this.#registry, state.daemonId);
			this.#registry.setStatus(
				state.daemonId,
				"error",
				`child exited ${state.restarts + 1} times (${this.#restartMax} restarts allowed)`,
			);
			this.#onEvent?.(
				"error",
				`${exit}, restart budget exhausted (${this.#restartMax} restarts allowed)`,
				state.daemonId,
			);
			return;
		}
		const attempt = state.restarts++;
		const delay = backoffDelay(attempt, this.#backoffMinMs, this.#backoffMaxMs);
		state.restartTimer = setTimeout(() => {
			state.restartTimer = null;
			if (state.stopping) return;
			const current = this.#registry.get(state.daemonId);
			if (!current) return;
			const template = this.#config.templates[current.template ?? ""];
			if (!template) {
				this.#registry.setStatus(
					state.daemonId,
					"error",
					`unknown spawn template: ${current.template}`,
				);
				return;
			}
			try {
				this.#launch(current, template, { resume: true });
			} catch (err) {
				releaseSessionCredential(this.#deps.transport, this.#registry, state.daemonId);
				const message = `restart failed: ${(err as Error).message}`;
				this.#registry.setStatus(state.daemonId, "error", message);
				this.#onEvent?.("error", message, state.daemonId);
			}
		}, delay);
		this.#onEvent?.(
			"warn",
			`${exit}, restart ${attempt + 1}/${this.#restartMax} in ${delay}ms`,
			state.daemonId,
		);
	}

	/** The child's last non-empty log line (its refusal reason), without the omp-session prefix. */
	#deterministicExitReason(daemonId: string): string {
		const lastLine = this.stderrTail(daemonId)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.at(-1);
		return lastLine?.replace(/^omp-session: /, "") ?? DETERMINISTIC_EXIT_FALLBACK;
	}

	/** SIGTERM, then SIGKILL after graceMs; resolves once the child has exited. */
	async #terminate(child: Child, graceMs: number): Promise<void> {
		if (child.exitCode !== null) return;
		signalGroup(child, "SIGTERM");
		const exited = await Promise.race([
			child.exited.then(() => true),
			sleep(graceMs).then(() => false),
		]);
		if (!exited) {
			signalGroup(child, "SIGKILL");
			await child.exited.catch(() => {
				// The exit promise may reject if the process was never reaped; ignore.
			});
		}
	}
}
