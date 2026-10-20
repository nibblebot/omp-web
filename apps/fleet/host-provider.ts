/**
 * The host runtime provider: the in-process implementation of the four-op
 * runtime contract (runtime-provider.ts) for sessions that run as children of
 * the fleet on the fleet host (main checkouts and git worktrees).
 *
 * It owns process mechanics only: launch the template command through
 * `sh -c` as a detached child (its own process group, so a terminal Ctrl+C
 * never reaches sessions) with the launch's stdin payload and the session log
 * as stdout and stderr (rotated above the cap on each launch), signal the
 * child's group on stop (SIGTERM, then SIGKILL after the grace), and observe
 * liveness: the tracked child, or for a session this process did not launch
 * (adopted from a previous fleet process) its file lock and recorded pid
 * (session-liveness.ts). Policy (generations, credentials, status, restarts,
 * exit codes) stays with the lifecycle, which reports back through `onExit`:
 * a child that dies without this provider having ended it.
 *
 * Children are never tied to the provider's lifetime: nothing here kills them
 * when the fleet closes. `spawnDetached` is the launch mechanic itself, shared
 * with the host clone provider (host-clone-provider.ts).
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Subprocess } from "bun";
import type { ProviderErrorResponse, ProviderOkResponse } from "#lib/runtime/provider-protocol";
import type { RegistryEntry } from "./registry";
import type { RuntimeProvider } from "./runtime-provider";
import { sessionLiveness } from "./session-liveness";
import { removeSessionLog, rotateSessionLog } from "./session-log";

type Child = Subprocess<"pipe", number, number>;

export type HostOp = "ensure-running" | "inspect" | "stop" | "delete";

/** What an ensure-running launches: the filled template command and the stdin payload (the callback pair). */
export interface HostLaunch {
	command: string;
	stdin: string;
}

export interface HostRequest {
	op: HostOp;
	workspaceId: string;
	/** The runtime generation the launch carries; an ensure-running at the tracked generation is a no-op. */
	generation: number;
	/** The roster row: liveness evidence for a session this provider did not launch. */
	entry: RegistryEntry;
	/** The session log file the child appends to; `delete` removes it. */
	logPath: string;
	/** ensure-running only. */
	launch?: HostLaunch;
	/** SIGTERM-to-SIGKILL grace when an op terminates a child (replacing a predecessor, stop, delete). */
	killGraceMs?: number;
}

export interface HostOkResponse extends ProviderOkResponse {
	/** The runtime is a child this provider launched; false for an adopted session or none. */
	owned: boolean;
	/** Exit summary (`exit code=N signal=S`) of a child this op terminated. */
	exit?: string;
}

/** A child that exited without this provider ending it. */
export interface HostExit {
	workspaceId: string;
	generation: number;
	exitCode: number;
	signalCode: string | null;
}

interface Hosted {
	child: Child;
	generation: number;
	startedAt: number;
	/** This provider ended (or is ending) the child: its exit is not a crash. */
	expected: boolean;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
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

/**
 * Signal the process group a detached child leads, or the pid alone when the group is gone.
 * Throws when the pid itself is gone (the caller treats that as terminated).
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		process.kill(pid, signal);
	}
}

/** A detached child to launch on the fleet host. */
export interface DetachedLaunch {
	argv: string[];
	cwd?: string;
	/** The child's whole environment. */
	env: Record<string, string>;
	/** Written to the child's stdin, which is then closed (the daemon reads its payload to EOF). */
	stdin: string;
	/** The file the child appends its combined stdout and stderr to; rotated above the cap on each launch. */
	logPath: string;
}

/**
 * Launch a child detached (its own session and process group, so a terminal
 * Ctrl+C or the fleet's exit never reaches it) with the stdin payload and the
 * log as stdout and stderr. The one process mechanic shared by the host
 * runtime and the host clone runtime. Throws when the log or the spawn fails.
 */
export function spawnDetached(launch: DetachedLaunch): Child {
	mkdirSync(dirname(launch.logPath), { recursive: true });
	rotateSessionLog(launch.logPath);
	const logFd = openSync(launch.logPath, "a");
	let child: Child;
	try {
		child = Bun.spawn(launch.argv, {
			stdin: "pipe",
			stdout: logFd,
			stderr: logFd,
			detached: true,
			...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
			env: launch.env,
		});
	} finally {
		// The child holds its own copy of the descriptor.
		closeSync(logFd);
	}
	// A write racing the child's exit is not ours to report: whoever supervises the child
	// records that outcome.
	try {
		child.stdin.write(launch.stdin);
		child.stdin.end();
	} catch {
		// The child exited before reading its payload.
	}
	return child;
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

export function describeExit(exitCode: number, signalCode: string | null): string {
	return `exit code=${exitCode}${signalCode !== null ? ` signal=${signalCode}` : ""}`;
}

function handleOf(workspaceId: string): string {
	return `host:${workspaceId}`;
}

function failure(message: string): ProviderErrorResponse {
	return { ok: false, error: { code: "internal", message, retryable: false } };
}

export class HostRuntimeProvider implements RuntimeProvider<HostRequest, HostOkResponse> {
	readonly #hosted = new Map<string, Hosted>();
	readonly #onExit: (exit: HostExit) => void;

	constructor(onExit: (exit: HostExit) => void) {
		this.#onExit = onExit;
	}

	run(request: HostRequest): Promise<HostOkResponse | ProviderErrorResponse> {
		switch (request.op) {
			case "ensure-running":
				return this.#ensureRunning(request);
			case "inspect":
				return Promise.resolve(this.inspect(request));
			case "stop":
				return this.#stop(request);
			case "delete":
				return this.#delete(request);
		}
	}

	/** Pid of the child this provider is running for the workspace, if any. */
	pidOf(workspaceId: string): number | undefined {
		const hosted = this.#hosted.get(workspaceId);
		return hosted !== undefined && hosted.child.exitCode === null ? hosted.child.pid : undefined;
	}

	/**
	 * Observe the runtime: the tracked child, else the row's file lock and
	 * recorded pid. `stopped` is proof of death; `missing` means no evidence
	 * either way (nothing tracked, and neither a lock nor a dead pid proves
	 * anything). Synchronous so boot reconciliation can run before the fleet
	 * serves its first request.
	 */
	inspect(request: HostRequest): HostOkResponse {
		const hosted = this.#hosted.get(request.workspaceId);
		if (hosted !== undefined && hosted.child.exitCode === null) {
			return {
				ok: true,
				handle: handleOf(request.workspaceId),
				observed: "running",
				pid: hosted.child.pid,
				startedAt: hosted.startedAt,
				owned: true,
			};
		}
		const verdict = sessionLiveness(request.entry);
		return {
			ok: true,
			handle: handleOf(request.workspaceId),
			observed: verdict === "alive" ? "running" : verdict === "dead" ? "stopped" : "missing",
			owned: false,
		};
	}

	async #ensureRunning(request: HostRequest): Promise<HostOkResponse | ProviderErrorResponse> {
		const existing = this.#hosted.get(request.workspaceId);
		let exit: string | undefined;
		if (existing !== undefined && existing.child.exitCode === null) {
			if (existing.generation === request.generation) {
				return {
					ok: true,
					handle: handleOf(request.workspaceId),
					observed: "running",
					pid: existing.child.pid,
					startedAt: existing.startedAt,
					owned: true,
				};
			}
			// Replace the predecessor: its death is expected, not a crash.
			exit = await this.#terminate(request.workspaceId, existing, request.killGraceMs);
		}
		if (request.launch === undefined) return failure("ensure-running without a launch");
		let child: Child;
		try {
			child = spawnDetached({
				argv: ["sh", "-c", request.launch.command],
				env: { ...inheritedChildEnv(process.env), OMP_SESSION_LOG_MIRROR: "0" },
				stdin: request.launch.stdin,
				logPath: request.logPath,
			});
		} catch (err) {
			return failure(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		const hosted: Hosted = {
			child,
			generation: request.generation,
			startedAt: Date.now(),
			expected: false,
		};
		this.#hosted.set(request.workspaceId, hosted);
		// Exit handling via `exited` (not the onExit spawn option): the child is tracked before the
		// promise attaches, so an instant exit is always correlated, and a replaced child's late
		// exit is ignored by the identity guard.
		void child.exited.then((exitCode) => {
			if (this.#hosted.get(request.workspaceId) !== hosted) return;
			this.#hosted.delete(request.workspaceId);
			if (hosted.expected) return;
			this.#onExit({
				workspaceId: request.workspaceId,
				generation: hosted.generation,
				exitCode,
				signalCode: child.signalCode ?? null,
			});
		});
		return {
			ok: true,
			handle: handleOf(request.workspaceId),
			observed: "running",
			pid: child.pid,
			startedAt: hosted.startedAt,
			owned: true,
			...(exit !== undefined ? { exit } : {}),
		};
	}

	/**
	 * Terminate the tracked child, if any. A session this provider did not
	 * launch is not signalled (its pid may be reused): the lifecycle asks it
	 * to shut down over the pair, and the observation reports whether it is
	 * still alive.
	 */
	async #stop(request: HostRequest): Promise<HostOkResponse> {
		const hosted = this.#hosted.get(request.workspaceId);
		if (hosted === undefined) return this.inspect(request);
		const exit = await this.#terminate(request.workspaceId, hosted, request.killGraceMs);
		return {
			ok: true,
			handle: handleOf(request.workspaceId),
			observed: "stopped",
			owned: false,
			exit,
		};
	}

	/** Stop, then forget the workspace and delete its session logs. */
	async #delete(request: HostRequest): Promise<HostOkResponse> {
		const stopped = await this.#stop(request);
		removeSessionLog(request.logPath);
		return { ...stopped, observed: "missing" };
	}

	/** SIGTERM, then SIGKILL after the grace; resolves with the exit summary once the child has exited. */
	async #terminate(
		workspaceId: string,
		hosted: Hosted,
		graceMs = DEFAULT_KILL_GRACE_MS,
	): Promise<string> {
		hosted.expected = true;
		if (this.#hosted.get(workspaceId) === hosted) this.#hosted.delete(workspaceId);
		const { child } = hosted;
		if (child.exitCode === null) {
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
		return describeExit(child.exitCode ?? 0, child.signalCode ?? null);
	}
}
