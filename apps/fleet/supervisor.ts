/**
 * SpawnSupervisor: owns spawned omp-session children and the callback
 * credentials they dial back with.
 *
 * Sessions connect OUT to the control plane (callback pair); the fleet never
 * dials a session. spawn() creates a "spawned" registry entry, enrolls a
 * fresh callback credential for the next generation (enrollSessionCredential),
 * fills the spawn template, and runs it via `sh -c` as a detached child (its
 * own process group, so a terminal Ctrl+C never reaches sessions). Child
 * stdout and stderr are appended to `<state dir>/session-logs/<daemonId>.log`;
 * stderrTail() reads the last 64 KiB of that file. The entry is "connecting"
 * until its pair appears; no pair within PAIR_TIMEOUT_MS → status error and
 * the child is killed.
 *
 * Exit policy: exit 0 (a session that shut itself down, e.g. its control
 * grace expired) → "asleep", no restart. Exit OMP_SESSION_EXIT_SESSION_LOCKED
 * (the session file is open in another omp-session): deterministic, so no
 * restart; the entry goes "asleep" carrying the child's last log line as its
 * reason. Any other unexpected exit restarts with a FRESH credential, bounded
 * backoff 1s→30s jittered, at most restartMax (default 5) restarts between
 * pair-ups, then status "error". respawn()/stop() are the intentional paths:
 * respawn uses `{resume} = "--resume <lastSessionFile>"` when the session has
 * one (R3); stop() asks a paired session to shut down (ShutdownControl),
 * SIGTERMs its group, escalates to SIGKILL after 5s, revokes the credential,
 * and sets status "asleep" (respawnable).
 *
 * close() stops the git poll and the supervisor's timers only: children keep
 * running and their enrollments persist, so sessions outlive the control plane.
 *
 * Git-state polling (startGitStatePolling) keeps every local registry
 * entry's branch + dirty counts fresh for the roster; remote entries are
 * never probed with local git (their cwd is on another host). The same poll
 * derives the entry's last-session-file title (sessionTitle) for the roster
 * and never probes remote entries for it either (their session files live
 * on another host).
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Subprocess } from "bun";
import {
	CALLBACK_TRANSPORT_STREAM_ID,
	ENROLLMENT_KEY_BYTES,
	type ShutdownControl,
} from "#lib/wire/callback-protocol";
import { OMP_SESSION_EXIT_SESSION_LOCKED } from "#lib/wire/protocol";
import type { FleetConfig, SpawnTemplate } from "./config";
import { fillTemplate, shellQuote } from "./spawn-parse";
import type { DaemonTransportRegistry } from "./daemon-transport";
import { probeGitState as probeGit, resolveWorktreeOf } from "./discovery";
import type { GitRunner } from "./discovery";
import { readSessionInfo } from "./session-title";
import type { Registry, RegistryEntry } from "./registry";
import type { FleetLogLevel } from "./events";

type Child = Subprocess<"ignore", number, number>;

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
const DEFAULT_RESTART_MAX = 5;
const STDERR_TAIL_BYTES = 64 * 1024;
const STOP_SIGTERM_GRACE_MS = 5_000;
const RESPAWN_KILL_GRACE_MS = 2_000;
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_GIT_STATE_POLL_MS = 10_000;
const LOCKED_REASON_FALLBACK =
	"session file is locked by another omp-session; close it there and retry";

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
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
 * The child's environment with the callback-pair vars (C5). Inherited
 * OMP_SESSION_CALLBACK_* values are stripped first so an ambient fleet
 * environment can never leak into a child's callback target. ALLOW_HTTP is
 * set only for an http callback URL (loopback http; the daemon refuses
 * anything else).
 */
export function withCallbackEnv(
	base: Record<string, string | undefined>,
	callback: { url: string; daemonId: string; enrollment: SessionEnrollment },
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !key.startsWith("OMP_SESSION_CALLBACK_")) env[key] = value;
	}
	env.OMP_SESSION_CALLBACK_URL = callback.url;
	env.OMP_SESSION_CALLBACK_WORKSPACE = callback.daemonId;
	env.OMP_SESSION_CALLBACK_GENERATION = String(callback.enrollment.generation);
	env.OMP_SESSION_CALLBACK_TOKEN = callback.enrollment.credential;
	if (new URL(callback.url).protocol === "http:") env.OMP_SESSION_CALLBACK_ALLOW_HTTP = "1";
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
	#backoffMinMs: number;
	#backoffMaxMs: number;
	#children = new Map<string, ChildState>();
	/** Git-state poll timer (startGitStatePolling); cleared by close(). */
	#gitStateTimer: ReturnType<typeof setInterval> | null = null;
	/** Exec injected via startGitStatePolling (tests); undefined = real git. */
	#gitExec: GitRunner | undefined;
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
	 */
	async spawn(init: {
		cwd: string;
		template?: string;
		name?: string;
		labels?: string[];
	}): Promise<RegistryEntry> {
		const project = basename(init.cwd);
		const templateName = this.resolveTemplateName(init.cwd, init.template);
		const template = this.#config.templates[templateName];
		const worktreeOf = await resolveWorktreeOf(init.cwd);
		const entry = this.#registry.create({
			name: init.name ?? project,
			cwd: init.cwd,
			project,
			...(worktreeOf !== undefined ? { worktreeOf } : {}),
			labels: init.labels ?? [],
			mode: "spawned",
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
		if (current.mode !== "spawned") {
			throw new Error(`daemon ${current.daemonId} is not spawned (mode ${current.mode})`);
		}
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
	 * survives a fleet restart.
	 */
	stderrTail(daemonId: string): string {
		const path = this.#logPath(daemonId);
		if (!existsSync(path)) return "";
		const size = statSync(path).size;
		const start = Math.max(0, size - STDERR_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, start);
		} finally {
			closeSync(fd);
		}
		return buffer.toString("utf8");
	}

	/**
	 * Backfill worktreeOf on local entries registered before spawn-time
	 * tagging existed (fired once at server start). Remote entries name paths
	 * on ANOTHER host, so never probe those with local git. An unresolvable cwd
	 * leaves the entry untouched; entries removed mid-scan are skipped.
	 */
	async backfillWorktrees(): Promise<void> {
		for (const entry of this.#registry.list()) {
			if (entry.mode === "remote" || entry.worktreeOf !== undefined || entry.cwd === "") continue;
			const worktreeOf = await resolveWorktreeOf(entry.cwd);
			if (worktreeOf !== undefined && this.#registry.get(entry.daemonId)) {
				this.#registry.update(entry.daemonId, { worktreeOf });
			}
		}
	}

	/**
	 * Start polling git state (branch + dirty counts) for every local
	 * registry entry: one immediate pass, then one pass every `intervalMs`
	 * (default 10s). Remote entries are NEVER probed; their cwd lives on
	 * another host (same rule as backfillWorktrees). A pass updates the
	 * registry only when the probed state actually differs from the entry's
	 * current branch/git; every update broadcasts the roster via
	 * registry.onChange, and a probe failure clears previously-set fields
	 * only. The injected `exec` keeps tests hermetic. Idempotent: a second
	 * call while polling is ignored so passes never stack. `close()` stops
	 * the timer.
	 */
	startGitStatePolling(opts?: { intervalMs?: number; exec?: GitRunner }): void {
		if (this.#gitStateTimer) return;
		this.#gitExec = opts?.exec;
		const intervalMs = opts?.intervalMs ?? DEFAULT_GIT_STATE_POLL_MS;
		void this.#pollGitState();
		this.#gitStateTimer = setInterval(() => void this.#pollGitState(), intervalMs);
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

	/** One poll pass: every local entry, in registry order. */
	async #pollGitState(): Promise<void> {
		for (const entry of this.#registry.list()) {
			await this.#probeEntry(entry);
		}
	}

	/**
	 * Probe one entry and reconcile the registry. The entry is re-read after
	 * the probe so a removal mid-probe is skipped; an update happens only on
	 * an actual branch/git change.
	 */
	async #probeEntry(entry: RegistryEntry): Promise<void> {
		if (entry.mode === "remote" || entry.cwd === "") return;
		const result = await probeGit(entry.cwd, { exec: this.#gitExec });
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
			if (current.branch !== undefined || current.git !== undefined) {
				this.#registry.update(current.daemonId, { branch: undefined, git: undefined });
			}
			return;
		}
		if (current.branch !== result.branch || !sameGitState(current.git, result.git)) {
			this.#registry.update(current.daemonId, { branch: result.branch, git: result.git });
		}
		await this.#probeSessionInfo(this.#registry.get(entry.daemonId) ?? entry);
	}

	/**
	 * Probe one entry's last-session-file title and emptiness (a new/empty
	 * session renders "New session" in the roster) and reconcile the
	 * registry. Remote entries are never probed (their session files live on
	 * another host) and neither are entries without a lastSessionFile, the same
	 * rule as the git probe's empty-cwd skip. One registry.update happens
	 * only when title OR empty actually differs (a no-change keeps the
	 * registry quiet: no onChange, no roster broadcast); a file that became
	 * unreadable/untitled clears a previously-set title. sessionEmpty only
	 * carries meaning for untitled files; a titled session is never labeled
	 * "New session", so a title appearing clears a stale empty flag in the
	 * same update. The reader never throws.
	 */
	async #probeSessionInfo(entry: RegistryEntry): Promise<void> {
		if (entry.mode === "remote" || entry.cwd === "" || !entry.lastSessionFile) return;
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
				pairUnsub: null,
				stopping: false,
				manualRespawn: false,
				respawnInFlight: null,
				exitHandled: false,
			};
			// A paired child is healthy: its restart budget resets, so restartMax
			// bounds crash LOOPS, not lifetime restarts.
			created.pairUnsub = this.#deps.transport.onPairChange(daemonId, (status) => {
				if (!status.paired) return;
				if (created.pairTimer) {
					clearTimeout(created.pairTimer);
					created.pairTimer = null;
				}
				created.restarts = 0;
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
		const resumeArg = opts.resume && resumeFile ? `--resume ${shellQuote(resumeFile)}` : "";
		const command = fillTemplate(template.command, {
			cwd: shellQuote(entry.cwd),
			token: shellQuote(token),
			name: shellQuote(entry.name),
			labels: labelsArg,
			resume: resumeArg,
		});
		const logPath = this.#logPath(daemonId);
		mkdirSync(dirname(logPath), { recursive: true });
		const logFd = openSync(logPath, "a");
		let child: Child;
		try {
			// Detached: its own session and process group, so a terminal
			// Ctrl+C never reaches the child; stdin is closed.
			child = Bun.spawn(["sh", "-c", command], {
				stdin: "ignore",
				stdout: logFd,
				stderr: logFd,
				detached: true,
				env: {
					...withCallbackEnv(process.env, {
						url: this.#deps.callbackUrl(),
						daemonId,
						enrollment,
					}),
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
				this.#onChildExit(state, exitCode, child.signalCode ?? null);
			})
			.catch(() => {
				// The exit promise should always resolve; a rejection is surfaced
				// nowhere meaningful, so the child stays unreaped.
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
		if (exitCode === OMP_SESSION_EXIT_SESSION_LOCKED) {
			// Deterministic: another omp-session holds the session file. Dormant
			// (no restart), with the child's last log line as the reason.
			const reason = this.#lockReason(state.daemonId);
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
			this.#launch(current, template, { resume: true });
		}, delay);
		this.#onEvent?.(
			"warn",
			`${exit}, restart ${attempt + 1}/${this.#restartMax} in ${delay}ms`,
			state.daemonId,
		);
	}

	/** The child's last non-empty log line (its lock reason), without the omp-session prefix. */
	#lockReason(daemonId: string): string {
		const lastLine = this.stderrTail(daemonId)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.at(-1);
		return lastLine?.replace(/^omp-session: /, "") ?? LOCKED_REASON_FALLBACK;
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
