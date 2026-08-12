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
 */

import { basename } from "node:path";
import type { Subprocess } from "bun";
import type { StdoutContractLine } from "../src/protocol";
import type { FleetConfig, SpawnTemplate } from "./config";
import { fillTemplate, parseContractLine, resolveEndpoint } from "./spawn-parse";
import type { DaemonConnector } from "./connector";
import { resolveWorktreeOf } from "./discovery";
import type { Registry, RegistryEntry } from "./registry";

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

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
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
function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
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
function readChunks(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): Promise<void> {
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
	#children = new Map<string, ChildState>();

	constructor(
		registry: Registry,
		connector: DaemonConnector,
		config: FleetConfig,
		opts?: { restartMax?: number; stderrRingBytes?: number },
	) {
		this.#registry = registry;
		this.#connector = connector;
		this.#config = config;
		this.#restartMax = opts?.restartMax ?? DEFAULT_RESTART_MAX;
		this.#stderrRingBytes = opts?.stderrRingBytes ?? DEFAULT_STDERR_RING_BYTES;
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
	async spawn(init: { cwd: string; template?: string; name?: string; labels?: string[] }): Promise<RegistryEntry> {
		const project = basename(init.cwd);
		const templateName = init.template ?? this.#config.projectTemplates?.[project] ?? this.#config.defaultTemplate;
		const template = this.#config.templates[templateName];
		if (!template) throw new Error(`unknown spawn template: ${templateName}`);
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
		return entry;
	}

	/** R3 rule: respawn = --resume lastSessionFile when known. Fresh token per attempt. */
	async respawn(entry: RegistryEntry): Promise<void> {
		const current = this.#registry.get(entry.daemonId) ?? entry;
		if (current.mode !== "spawned") {
			throw new Error(`daemon ${current.daemonId} is not spawned (mode ${current.mode})`);
		}
		const template = this.#config.templates[current.template ?? ""];
		if (!template) throw new Error(`unknown spawn template: ${current.template}`);
		const state = this.#ensure(current.daemonId);
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
		this.#launch(this.#registry.get(current.daemonId) ?? current, template, { resume: true });
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
	}

	/** Last 64KB (or configured ring) of the child's stderr, as text. */
	stderrTail(daemonId: string): string {
		return this.#children.get(daemonId)?.stderrRing ?? "";
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

	/** Stop every spawned child. */
	async close(): Promise<void> {
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
				exitHandled: false,
				stderrRing: "",
			};
			this.#children.set(daemonId, state);
		}
		return state;
	}

	/** Spawn one child for the entry with a fresh token and wire up the pipes. */
	#launch(entry: RegistryEntry, template: SpawnTemplate, opts: { resume: boolean }): void {
		const daemonId = entry.daemonId;
		const state = this.#ensure(daemonId);
		state.manualRespawn = false;
		state.exitHandled = false;
		state.resolved = false;
		state.lines = [];
		const token = mintToken();
		const labelsArg = (entry.labels ?? []).map((label) => `--label ${label}`).join(" ");
		const resumeArg = opts.resume && entry.lastSessionFile ? `--resume ${entry.lastSessionFile}` : "";
		const command = fillTemplate(template.command, {
			cwd: entry.cwd,
			token,
			name: entry.name,
			labels: labelsArg,
			resume: resumeArg,
		});
		let child: Child;
		try {
			child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
		} catch (err) {
			this.#registry.setStatus(daemonId, "error", `spawn failed: ${(err as Error).message}`);
			this.#children.delete(daemonId);
			return;
		}
		state.child = child;
		// The fresh token is visible to the roster immediately (R14 rotation).
		this.#registry.update(daemonId, { token, pid: child.pid });
		// Endpoint resolution timeout: no listening line within 30s → error + kill.
		state.endpointTimer = setTimeout(() => {
			if (state.resolved) return;
			state.exitHandled = true; // we own the aftermath — no restart
			this.#registry.setStatus(daemonId, "error", "endpoint timeout: no OMP_SESSION| listening line within 30s");
			child.kill();
		}, ENDPOINT_TIMEOUT_MS);
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
			this.#registry.update(daemonId, { endpoint: resolved.url });
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
		if (state.stopping) return; // stop() owns the aftermath (status asleep)
		if (state.manualRespawn) return; // respawn() already launched a replacement
		// Idle auto-exit: a daemon that reached ready and whose socket was
		// dropped (connector idle policy) exiting cleanly goes dormant.
		if (entry.status === "ready" && !this.#connector.isConnected(state.daemonId) && exitCode === 0 && signalCode === null) {
			this.#registry.setStatus(state.daemonId, "asleep");
			return;
		}
		if (state.restarts >= this.#restartMax) {
			this.#registry.setStatus(
				state.daemonId,
				"error",
				`child exited ${state.restarts + 1} times (${this.#restartMax} restarts allowed)`,
			);
			return;
		}
		const attempt = state.restarts++;
		const delay = backoffDelay(attempt, RESTART_BACKOFF_MIN_MS, RESTART_BACKOFF_MAX_MS);
		state.restartTimer = setTimeout(() => {
			state.restartTimer = null;
			if (state.stopping) return;
			const current = this.#registry.get(state.daemonId);
			if (!current) return;
			const template = this.#config.templates[current.template ?? ""];
			if (!template) {
				this.#registry.setStatus(state.daemonId, "error", `unknown spawn template: ${current.template}`);
				return;
			}
			this.#launch(current, template, { resume: true });
		}, delay);
	}

	/** SIGTERM, then SIGKILL after graceMs; resolves once the child has exited. */
	async #terminate(child: Child, graceMs: number): Promise<void> {
		if (child.exitCode !== null) return;
		child.kill();
		const exited = await Promise.race([child.exited.then(() => true), sleep(graceMs).then(() => false)]);
		if (!exited) {
			child.kill("SIGKILL");
			await child.exited.catch(() => {
				// The exit promise may reject if the process was never reaped; ignore.
			});
		}
	}
}
