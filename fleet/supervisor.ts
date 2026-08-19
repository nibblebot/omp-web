/**
 * SpawnSupervisor: owns spawned omp-session children.
 *
 * spawn() creates a "spawned" registry entry, mints a fresh bearer token
 * (32 random bytes, base64url), fills the spawn template, and runs it via
 * `sh -c` with stdout/stderr piped. The OMP_SESSION| stdout contract lines
 * are parsed; once a listening line is seen the endpoint is resolved
 * (resolveEndpoint, R6b precedence) and the connector dials the session.
 * A 30s endpoint-resolution timeout → status error + child killed.
 *
 * Failure handling: an unexpected child exit restarts the session with a
 * FRESH token per attempt, bounded backoff 1s→30s jittered, at most
 * restartMax (default 5) restarts, then status "error". A session that had
 * reached "ready" and whose socket was dropped (connector idle policy)
 * exiting cleanly goes "asleep" instead of restarting. respawn()/stop()
 * are the intentional paths: respawn uses `{resume} = "--resume
 * <lastSessionFile>"` when the session has one (R3), stop() SIGTERMs,
 * escalates to SIGKILL after 5s, and sets status "asleep" (respawnable).
 * Child stderr is kept in a rolling ring (default 64KB) for stderrTail().
 *
 * Git-state polling (startGitStatePolling) keeps every local registry
 * entry's branch + dirty counts fresh for the roster; remote entries are
 * never probed with local git (their cwd is on another host). The same poll
 * derives the entry's last-session-file title (sessionTitle) for the roster
 * — remote entries are never probed for it either (their session files live
 * on another host).
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Subprocess } from "bun";
import type { StdoutContractLine } from "../shared/protocol";
import type { FleetConfig, SpawnTemplate } from "./config";
import {
	fillTemplate,
	isValidEndpointUrl,
	parseContractLine,
	resolveEndpoint,
	shellQuote,
} from "./spawn-parse";
import type { DaemonConnector } from "./connector";
import { probeGitState as probeGit, resolveWorktreeOf } from "./discovery";
import type { GitRunner } from "./discovery";
import { readSessionInfo } from "./session-title";
import type { Registry, RegistryEntry } from "./registry";
import type { FleetLogLevel } from "./events";

type Child = Subprocess<"ignore", "pipe", "pipe">;

interface ChildState {
	daemonId: string;
	child: Child | null;
	resolved: boolean;
	endpointTimer: ReturnType<typeof setTimeout> | null;
	lines: StdoutContractLine[];
	restarts: number;
	restartTimer: ReturnType<typeof setTimeout> | null;
	stopping: boolean;
	/** respawn() already launched a replacement; the old child's exit must not restart. */
	manualRespawn: boolean;
	/** In-flight respawn() promise; concurrent respawn() calls coalesce onto it (one launch). */
	respawnInFlight: Promise<void> | null;
	exitHandled: boolean;
	stderrRing: string;
}

const DEFAULT_RESTART_MAX = 5;
const DEFAULT_STDERR_RING_BYTES = 64 * 1024;
const ENDPOINT_TIMEOUT_MS = 30_000;
const STOP_SIGTERM_GRACE_MS = 5_000;
const RESP_AWN_KILL_GRACE_MS = 2_000;
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_GIT_STATE_POLL_MS = 10_000;

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

/** Fresh 32-byte bearer token, base64url-encoded (43 chars). */
function mintToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Stream lines from a child stdout pipe, calling onLine per newline-delimited line. */
function readLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const pump = async (): Promise<void> => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			}
		}
		if (buffer.length > 0) onLine(buffer);
	};
	return pump().catch(() => {
		// Pipe errors (child killed mid-read) end the read loop silently.
	});
}

/** Stream decoded chunks from a child stderr pipe into the ring buffer. */
function readChunks(
	stream: ReadableStream<Uint8Array>,
	onChunk: (chunk: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const pump = async (): Promise<void> => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			onChunk(decoder.decode(value, { stream: true }));
		}
	};
	return pump().catch(() => {
		// Pipe errors end the read loop silently.
	});
}

export class SpawnSupervisor {
	#registry: Registry;
	#connector: DaemonConnector;
	#config: FleetConfig;
	#restartMax: number;
	#stderrRingBytes: number;
	#endpointTimeoutMs: number;
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
	 * directory is gone). Detection only — eviction orchestration
	 * (prune/drop, registry.remove, roster broadcast, toast) is the caller's
	 * job. At most meaningful once per entry: the server dedups in-flight
	 * evictions and the entry is gone from the registry after the first.
	 */
	#onWorktreeRemoved: ((entry: RegistryEntry) => void) | undefined;

	constructor(
		registry: Registry,
		connector: DaemonConnector,
		config: FleetConfig,
		opts?: {
			restartMax?: number;
			stderrRingBytes?: number;
			endpointTimeoutMs?: number;
			backoffMinMs?: number;
			backoffMaxMs?: number;
			/** Fired on spawn/endpoint/exit/stop/respawn/prune lifecycle transitions. */
			onEvent?: (level: FleetLogLevel, message: string, daemonId?: string) => void;
			/**
			 * Fired during git-state polling when a tagged worktree's cwd
			 * vanished on disk (probe failed AND the directory no longer
			 * exists). Detection only — eviction orchestration (prune/drop,
			 * registry.remove, roster broadcast, toast) is the caller's job.
			 * At most meaningful once per entry (the server dedups).
			 */
			onWorktreeRemoved?: (entry: RegistryEntry) => void;
		},
	) {
		this.#registry = registry;
		this.#connector = connector;
		this.#config = config;
		this.#restartMax = opts?.restartMax ?? DEFAULT_RESTART_MAX;
		this.#stderrRingBytes = opts?.stderrRingBytes ?? DEFAULT_STDERR_RING_BYTES;
		this.#endpointTimeoutMs = opts?.endpointTimeoutMs ?? ENDPOINT_TIMEOUT_MS;
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
	 * connector dial happens asynchronously once the child's listening line
	 * resolves an endpoint.
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
	 * R3 rule: respawn = --resume lastSessionFile when known. Fresh token per
	 * attempt. Serialized per daemon: while one respawn is in flight, a
	 * concurrent call coalesces onto the SAME in-flight promise — the child
	 * is never launched twice and an orphan is never left behind. A failed
	 * respawn drops the slot so a later call can retry.
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
		// Drop any stale socket first so the old child's death is not treated
		// as an unexpected close, then replace the child.
		this.#connector.disconnect(current.daemonId);
		if (state.child) {
			await this.#terminate(state.child, RESP_AWN_KILL_GRACE_MS);
			state.child = null;
		}
		const resumeFileLabel =
			resumeFile && resumeFile.trim() !== "" ? resumeFile : current.lastSessionFile;
		this.#onEvent?.("info", `respawn${resumeFileLabel ? " (--resume)" : ""}`, current.daemonId);
		this.#launch(this.#registry.get(current.daemonId) ?? current, template, {
			resume: true,
			resumeFile,
		});
	}

	/**
	 * Intentional stop: cancel restarts, drop the socket, SIGTERM → 5s →
	 * SIGKILL, and set status "asleep" (respawnable, lastSessionFile kept).
	 */
	async stop(daemonId: string): Promise<void> {
		const state = this.#children.get(daemonId);
		if (state) {
			state.stopping = true;
			if (state.restartTimer) {
				clearTimeout(state.restartTimer);
				state.restartTimer = null;
			}
			if (state.endpointTimer) {
				clearTimeout(state.endpointTimer);
				state.endpointTimer = null;
			}
		}
		// Drop the socket before killing so the child's death looks intentional.
		this.#connector.disconnect(daemonId);
		if (state?.child) {
			await this.#terminate(state.child, STOP_SIGTERM_GRACE_MS);
			state.child = null;
		}
		if (this.#registry.get(daemonId)) {
			this.#registry.setStatus(daemonId, "asleep");
		}
		this.#onEvent?.("info", "stop", daemonId);
	}

	/**
	 * Removal-time cleanup (#24): stop() (cancel restarts, drop the socket,
	 * kill the child, status asleep) then drop the per-daemon ChildState —
	 * the stderr ring (up to 64KB), restart budget, and timers — so a
	 * removed daemon leaks nothing. stop() alone keeps the state (the daemon
	 * stays respawnable); prune() is for registry removal only. Idempotent
	 * for daemons the supervisor never tracked.
	 */
	async prune(daemonId: string): Promise<void> {
		await this.stop(daemonId);
		this.#children.delete(daemonId);
		this.#onEvent?.("info", "prune", daemonId);
	}

	/**
	 * Per-daemon supervisor state for /ctl/debug: the live child's pid
	 * (absent when nothing is running), the consecutive-restart counter, and
	 * the resolved endpoint (absent until the contract line resolves).
	 */
	snapshot(): Record<string, { pid?: number; restarts: number; endpoint?: string }> {
		const out: Record<string, { pid?: number; restarts: number; endpoint?: string }> = {};
		for (const [daemonId, state] of this.#children) {
			const info: { pid?: number; restarts: number; endpoint?: string } = {
				restarts: state.restarts,
			};
			if (state.child) info.pid = state.child.pid;
			const endpoint = this.#registry.get(daemonId)?.endpoint;
			if (endpoint !== undefined) info.endpoint = endpoint;
			out[daemonId] = info;
		}
		return out;
	}

	/** Last 64KB (or configured ring) of the child's stderr, as text. */
	stderrTail(daemonId: string): string {
		return this.#children.get(daemonId)?.stderrRing ?? "";
	}

	/**
	 * Connector status hook (wired by server.ts): when a spawned child
	 * reaches the connector's "ready" transition it has demonstrably
	 * stabilized — reset its consecutive-crash budget so `restartMax` bounds
	 * crash LOOPS, not lifetime restarts. A daemon that crashes, recovers to
	 * ready, and later crashes again never exhausts the budget; one that
	 * crash-loops without ever reaching ready still errors after
	 * `restartMax` consecutive exits.
	 */
	onConnectorStatus(entry: RegistryEntry): void {
		if (entry.status !== "ready") return;
		const state = this.#children.get(entry.daemonId);
		if (state) state.restarts = 0;
	}

	/**
	 * Backfill worktreeOf on local entries registered before spawn-time
	 * tagging existed (fired once at server start). Remote entries name paths
	 * on ANOTHER host — never probe those with local git. An unresolvable cwd
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
	 * (default 10s). Remote entries are NEVER probed — their cwd lives on
	 * another host (same rule as backfillWorktrees). A pass updates the
	 * registry only when the probed state actually differs from the entry's
	 * current branch/git — every update broadcasts the roster via
	 * registry.onChange — and a probe failure clears previously-set fields
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
			// is being evicted (e.g. `git worktree remove` outside the fleet) —
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
	 * another host) and neither are entries without a lastSessionFile — same
	 * rule as the git probe's empty-cwd skip. One registry.update happens
	 * only when title OR empty actually differs (a no-change keeps the
	 * registry quiet: no onChange, no roster broadcast); a file that became
	 * unreadable/untitled clears a previously-set title. sessionEmpty only
	 * carries meaning for untitled files — a titled session is never labeled
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

	/** Stop every spawned child and the git-state poll timer. */
	async close(): Promise<void> {
		if (this.#gitStateTimer) {
			clearInterval(this.#gitStateTimer);
			this.#gitStateTimer = null;
		}
		for (const daemonId of [...this.#children.keys()]) {
			await this.stop(daemonId);
		}
	}

	#ensure(daemonId: string): ChildState {
		let state = this.#children.get(daemonId);
		if (!state) {
			state = {
				daemonId,
				child: null,
				resolved: false,
				endpointTimer: null,
				lines: [],
				restarts: 0,
				restartTimer: null,
				stopping: false,
				manualRespawn: false,
				respawnInFlight: null,
				exitHandled: false,
				stderrRing: "",
			};
			this.#children.set(daemonId, state);
		}
		return state;
	}

	/** Spawn one child for the entry with a fresh token and wire up the pipes. */
	#launch(
		entry: RegistryEntry,
		template: SpawnTemplate,
		opts: { resume: boolean; resumeFile?: string },
	): void {
		const daemonId = entry.daemonId;
		const state = this.#ensure(daemonId);
		state.manualRespawn = false;
		state.exitHandled = false;
		state.resolved = false;
		state.lines = [];
		const token = mintToken();
		// Every value interpolated into the template command is
		// attacker-controlled at some call site (POST /ctl/spawn name/labels)
		// and lands in `sh -c` — shell-quote each one so it can never break
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
		let child: Child;
		try {
			child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
		} catch (err) {
			this.#registry.setStatus(daemonId, "error", `spawn failed: ${(err as Error).message}`);
			this.#onEvent?.("error", `spawn failed: ${(err as Error).message}`, daemonId);
			this.#children.delete(daemonId);
			return;
		}
		state.child = child;
		this.#onEvent?.("info", `spawn template=${entry.template ?? "?"} cwd=${entry.cwd}`, daemonId);
		// The fresh token is visible to the roster immediately (R14 rotation).
		this.#registry.update(daemonId, { token, pid: child.pid });
		// Endpoint resolution timeout: no listening line within the window →
		// error + kill. (Injectable so tests can pin the no-resolution path.)
		state.endpointTimer = setTimeout(() => {
			if (state.resolved) return;
			state.exitHandled = true; // we own the aftermath — no restart
			const message = `endpoint timeout: no OMP_SESSION| listening line within ${Math.round(this.#endpointTimeoutMs / 1000)}s`;
			this.#registry.setStatus(daemonId, "error", message);
			this.#onEvent?.("error", message, daemonId);
			child.kill();
		}, this.#endpointTimeoutMs);
		void readLines(child.stdout, (line) => {
			if (state.resolved) return;
			const parsed = parseContractLine(line);
			if (!parsed) return;
			state.lines.push(parsed);
			const resolved = resolveEndpoint(state.lines, template.host);
			if (!resolved) return;
			state.resolved = true;
			if (state.endpointTimer) {
				clearTimeout(state.endpointTimer);
				state.endpointTimer = null;
			}
			// #23: a malformed resolved endpoint (garbage wrapper/advertise
			// url, or a bad template host) would throw inside the connector's
			// new URL() and kill this stdout pump — a sticky wedge in
			// "connecting" with zero diagnostics. Validate BEFORE registering
			// and dialing; fail loudly with the bad value and kill the child.
			if (!isValidEndpointUrl(resolved.url)) {
				state.exitHandled = true; // we own the aftermath — no restart
				this.#registry.setStatus(daemonId, "error", `invalid endpoint from child: ${resolved.url}`);
				this.#onEvent?.("error", `invalid endpoint from child: ${resolved.url}`, daemonId);
				child.kill();
				return;
			}
			this.#registry.update(daemonId, { endpoint: resolved.url });
			this.#onEvent?.("info", `endpoint ${resolved.url} pid ${child.pid}`, daemonId);
			this.#connector.connect(daemonId);
		});
		void readChunks(child.stderr, (chunk) => {
			state.stderrRing = (state.stderrRing + chunk).slice(-this.#stderrRingBytes);
		});
		// Exit handling via `exited` (not the onExit spawn option): state.child
		// is assigned before the promise attaches, so an instant child exit can
		// never be observed before we can correlate it, and a replaced child's
		// late exit is ignored by the proc identity guard.
		void child.exited
			.then((exitCode) => {
				if (state.child !== child) return; // a replaced child's exit is not ours
				state.child = null;
				if (state.endpointTimer) {
					clearTimeout(state.endpointTimer);
					state.endpointTimer = null;
				}
				this.#onChildExit(state, exitCode, child.signalCode ?? null);
			})
			.catch(() => {
				// The exit promise should always resolve; a rejection is surfaced
				// nowhere meaningful, so the child simply stays unreaped.
			});
	}

	#onChildExit(state: ChildState, exitCode: number, signalCode: string | null): void {
		if (state.exitHandled) return;
		state.exitHandled = true;
		const entry = this.#registry.get(state.daemonId);
		if (!entry) return;
		const exit = `exit code=${exitCode}${signalCode !== null ? ` signal=${signalCode}` : ""}`;
		if (state.stopping) {
			// stop() owns the aftermath (status asleep); the exit itself still
			// lands in the ring as the child's last breath.
			this.#onEvent?.("info", `${exit} (stopping)`, state.daemonId);
			return;
		}
		if (state.manualRespawn) {
			// respawn() already launched a replacement; the old child's exit is expected.
			this.#onEvent?.("info", `${exit} (replaced)`, state.daemonId);
			return;
		}
		// Idle auto-exit: a daemon that reached ready and whose socket was
		// dropped (connector idle policy) exiting cleanly goes dormant.
		if (
			entry.status === "ready" &&
			!this.#connector.isConnected(state.daemonId) &&
			exitCode === 0 &&
			signalCode === null
		) {
			this.#registry.setStatus(state.daemonId, "asleep");
			this.#onEvent?.("info", `${exit} clean idle → asleep`, state.daemonId);
			return;
		}
		if (state.restarts >= this.#restartMax) {
			this.#registry.setStatus(
				state.daemonId,
				"error",
				`child exited ${state.restarts + 1} times (${this.#restartMax} restarts allowed)`,
			);
			this.#onEvent?.(
				"error",
				`${exit} — restart budget exhausted (${this.#restartMax} restarts allowed)`,
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
			`${exit} — restart ${attempt + 1}/${this.#restartMax} in ${delay}ms`,
			state.daemonId,
		);
	}

	/** SIGTERM, then SIGKILL after graceMs; resolves once the child has exited. */
	async #terminate(child: Child, graceMs: number): Promise<void> {
		if (child.exitCode !== null) return;
		child.kill();
		const exited = await Promise.race([
			child.exited.then(() => true),
			sleep(graceMs).then(() => false),
		]);
		if (!exited) {
			child.kill("SIGKILL");
			await child.exited.catch(() => {
				// The exit promise may reject if the process was never reaped; ignore.
			});
		}
	}
}
