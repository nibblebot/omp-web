/**
 * The host clone runtime: the in-process provider behind the `host` profile
 * kind. A clone workspace's omp-session runs directly on the fleet host as the
 * fleet user, with NO sandbox: no namespace, no filesystem allowlist, no
 * network isolation. Everything the session can do, the fleet user can do.
 *
 * It answers the provider operation protocol (lib/runtime/provider-protocol.ts)
 * in process instead of through an executable, so the workspace lifecycle
 * drives it like any other clone provider: fleet-side volume preparation, the
 * `callback-env.json` handoff, identity-proven stop, the verified delete gate.
 * The session gets the same env and home layout bwrap gives it
 * (`buildSessionEnv`): `HOME` is the volume's `.home`, the agent dir (and so
 * every transcript) lives under its `agent/sessions`, and the working
 * directory is the volume's checkout.
 *
 * Process mechanics are the host runtime's (host-provider.ts `spawnDetached`:
 * detached child, stdin payload). Identity is the bwrap provider's
 * (bwrap-identity.ts): the launch token rides the runtime's argv and the
 * pidfile `<stateDir>/provider.pid.json` records its pid and start time, so
 * liveness and stop prove a generation terminated by identity, never by a
 * reusable pid, and survive a fleet restart (the runtime is detached and
 * outlives it). Output goes to `<stateDir>/daemon.log` through a detached
 * log relay (log-relay.ts, the shared SessionLog writer) that keeps the file
 * under the 1 MiB cap for the whole run, rotating to `daemon.log.1`, as the
 * bwrap supervisor does. The runtime is therefore a descendant of the launched
 * shell, found by its token.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { FLEET_CALLBACK_ENV_KEYS, assertSecretEnv, buildSessionEnv } from "#lib/runtime/bwrap-args";
import { buildFleetStdinPayload } from "#lib/runtime/fleet-stdin";
import { resolveProfileSecrets } from "#lib/runtime/profile-secrets";
import { readCallbackEnv, writeJsonAtomic } from "#lib/runtime/provider-callback-env";
import {
	ProviderProtocolError,
	type ProviderErrorCode,
	type ProviderErrorResponse,
	type ProviderObserved,
	type ProviderOkResponse,
} from "#lib/runtime/provider-protocol";
import {
	BWRAP_PID_FILE,
	findTokenPid,
	identityLive,
	processGroupOf,
	procIdentity,
	readLaunchRecord,
	stopAndProve,
	type LaunchRecord,
} from "./bwrap-identity";
import { signalProcessGroup, spawnDetached } from "./host-provider";
import type { ExecutableRequest, RuntimeProvider } from "./runtime-provider";
import { cloneRuntimeLaunch, logRelayLaunch } from "./runtime-launch";
import { PROVIDER_DAEMON_LOG, readSessionLogTail, rotateSessionLog } from "./session-log";

/** How long ensure-running waits for the new child's argv to carry its launch token. */
const LIVE_WAIT_MS = 5_000;
const LIVE_POLL_MS = 25;
/** Bytes of the log tail quoted in a launch failure. */
const FAILURE_TAIL_BYTES = 4096;

type Response = ProviderOkResponse | ProviderErrorResponse;

/** Children launched by this process, held until they exit so they are always reaped. */
const launched = new Set<Subprocess>();

function handleFor(workspaceId: string, generation: number, record: LaunchRecord | null): string {
	if (record === null) return `host:${workspaceId}:${generation}:none`;
	return `host:${workspaceId}:${generation}:${record.pid}:${record.procStartTime}`;
}

function okResponse(
	handle: string,
	observed: ProviderObserved,
	record?: LaunchRecord,
): ProviderOkResponse {
	return {
		ok: true,
		handle,
		observed,
		...(record !== undefined ? { pid: record.pid, startedAt: record.startedAt } : {}),
	};
}

function errResponse(
	code: Exclude<ProviderErrorCode, "timeout">,
	message: string,
	retryable: boolean,
): ProviderErrorResponse {
	return { ok: false, error: { code, message, retryable } };
}

/** A protocol error as an envelope (`timeout` is the fleet's code, never a provider's). */
function protocolFailure(cause: ProviderProtocolError): ProviderErrorResponse {
	return errResponse(
		cause.code === "timeout" ? "internal" : cause.code,
		cause.message,
		cause.retryable,
	);
}

/** A request whose profile is another kind is a request error. */
function rejectNonHost(request: ExecutableRequest): ProviderErrorResponse | null {
	const profile = request.profile;
	if (profile.provider === "host") return null;
	return errResponse(
		"invalid_request",
		`profile ${profile.id} is a ${profile.provider} profile, not host`,
		false,
	);
}

/** The daemon's `--fleet-stdin` payload for a handed-over callback pair, or undefined when the handoff carries none. */
function fleetStdinFor(callbackEnv: Record<string, string>): string | undefined {
	if (!FLEET_CALLBACK_ENV_KEYS.some((key) => callbackEnv[key] !== undefined)) return undefined;
	return buildFleetStdinPayload(callbackEnv);
}

async function ensureRunning(request: ExecutableRequest): Promise<Response> {
	const { stateDir, workspaceId, generation, homeDir, workspaceDir } = request;
	try {
		mkdirSync(stateDir, { recursive: true });
		// The private home may not exist yet; the agent dir is where the session writes transcripts.
		mkdirSync(join(homeDir, "agent"), { recursive: true });
	} catch (cause) {
		return errResponse(
			"unavailable",
			`cannot create the workspace private home ${homeDir}: ${String(cause)}`,
			true,
		);
	}

	const existing = readLaunchRecord(stateDir);
	if (existing !== null && identityLive(existing)) {
		if (existing.generation !== generation) {
			return errResponse(
				"conflict",
				`workspace runs under generation ${existing.generation}, requested ${generation}`,
				false,
			);
		}
		return okResponse(handleFor(workspaceId, generation, existing), "running", existing);
	}

	// Validate before spawning: a stale enrollment or an unresolvable secret must never start a generation.
	let secretEnv: Record<string, string>;
	let callbackEnv: Record<string, string>;
	try {
		secretEnv = resolveProfileSecrets(request);
		assertSecretEnv(secretEnv);
		callbackEnv = readCallbackEnv("host-provider", stateDir, workspaceId, generation) ?? {};
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) return protocolFailure(cause);
		return errResponse("invalid_request", `profile rejected: ${String(cause)}`, false);
	}
	if (!existsSync(workspaceDir)) {
		return errResponse(
			"unavailable",
			`the workspace checkout ${workspaceDir} does not exist`,
			false,
		);
	}

	// A stale record (dead process, or a previous generation) is replaced.
	rmSync(join(stateDir, BWRAP_PID_FILE), { force: true });

	const runtime = cloneRuntimeLaunch();
	const fleetStdin = fleetStdinFor(callbackEnv);
	const workspaceToken = randomUUID().replace(/-/g, "");
	const logPath = join(stateDir, PROVIDER_DAEMON_LOG);
	// A launch failure quotes only this run's output: rotate now, then remember where it starts.
	rotateSessionLog(logPath);
	const logStart = logSize(logPath);
	let launcher: Subprocess<"pipe", number, number>;
	try {
		launcher = spawnDetached({
			argv: [
				runtime.bin,
				runtime.entry,
				...runtime.args,
				// The callback pair reaches the daemon over stdin, never its environment.
				...(fleetStdin === undefined ? [] : ["--fleet-stdin"]),
				`--omp-workspace-token=${workspaceToken}`,
			],
			cwd: workspaceDir,
			// The handoff env carries OMP_SESSION_RESUME (allowlisted); the callback pair is not.
			env: buildSessionEnv({
				env: { ...process.env, ...callbackEnv },
				homeDir,
				workspaceDir,
				secretEnv,
			}),
			stdin: fleetStdin ?? "",
			logPath,
			// The runtime can outlive the fleet by days: its log is capped live, not just at launch.
			relay: logRelayLaunch(),
		});
	} catch (cause) {
		return errResponse("unavailable", `spawn failed: ${String(cause)}`, true);
	}
	launched.add(launcher);
	void launcher.exited.finally(() => launched.delete(launcher));
	launcher.unref();

	// The launched process is the shell holding the runtime and its log relay; the runtime is
	// the descendant whose argv carries the launch token, and that is the identity recorded.
	const deadline = Date.now() + LIVE_WAIT_MS;
	let pid = findTokenPid(launcher.pid, workspaceToken);
	while (pid === null) {
		if (launcher.exitCode !== null || Date.now() >= deadline) {
			return errResponse(
				"unavailable",
				await launchFailure(
					launcher.exitCode !== null
						? `exited with code ${launcher.exitCode} before it became live`
						: "did not become live in time",
					logPath,
					logStart,
				),
				true,
			);
		}
		await Bun.sleep(LIVE_POLL_MS);
		pid = findTokenPid(launcher.pid, workspaceToken);
	}
	const identity = procIdentity(pid);
	if (identity === null) {
		return errResponse(
			"unavailable",
			await launchFailure("exited before its identity was recorded", logPath, logStart),
			true,
		);
	}
	const record: LaunchRecord = {
		pid,
		procStartTime: identity.startTime,
		generation,
		workspaceToken,
		startedAt: Date.now(),
	};
	writeJsonAtomic(join(stateDir, BWRAP_PID_FILE), record);
	return okResponse(handleFor(workspaceId, generation, record), "running", record);
}

function logSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * The failure reason with the tail of this run's log (from `logStart`), which holds the runtime's
 * own error. The relay writes the log, so wait briefly for it to drain what the runtime printed.
 */
async function launchFailure(reason: string, logPath: string, logStart: number): Promise<string> {
	for (let settled = 0, last = -1; settled < 2 && last !== logSize(logPath);) {
		last = logSize(logPath);
		await Bun.sleep(100);
		settled = last === logSize(logPath) ? settled + 1 : 0;
	}
	const runBytes = Math.max(0, logSize(logPath) - logStart);
	const tail = readSessionLogTail(logPath, Math.min(runBytes, FAILURE_TAIL_BYTES)).trim();
	return tail === "" ? `session runtime ${reason}` : `session runtime ${reason}: ${tail}`;
}

/**
 * Stop signals the process group the runtime shares with its launcher shell and log relay (the
 * relay ignores the signal and drains the runtime's last output to EOF); a pid that is gone
 * throws, which the proof treats as terminated.
 */
function signalRuntimeGroup(pid: number, signal: NodeJS.Signals): void {
	signalProcessGroup(processGroupOf(pid) ?? pid, signal);
}

function inspect(request: ExecutableRequest): Response {
	const { stateDir, workspaceId, generation } = request;
	const record = readLaunchRecord(stateDir);
	if (record !== null && identityLive(record)) {
		return okResponse(handleFor(workspaceId, generation, record), "running", record);
	}
	return okResponse(
		handleFor(workspaceId, generation, record),
		record === null ? "missing" : "stopped",
	);
}

async function stop(request: ExecutableRequest): Promise<Response> {
	const { stateDir, workspaceId, generation } = request;
	const record = readLaunchRecord(stateDir);
	const handle = handleFor(workspaceId, generation, record);
	if (!identityLive(record)) return okResponse(handle, "stopped"); // idempotent
	if (!(await stopAndProve(stateDir, signalRuntimeGroup))) {
		return errResponse("conflict", "could not prove the generation terminated", false);
	}
	return okResponse(handle, "stopped");
}

async function deleteRuntime(request: ExecutableRequest): Promise<Response> {
	const { stateDir, workspaceId, generation } = request;
	const handle = handleFor(workspaceId, generation, null);
	if (!existsSync(stateDir)) return okResponse(handle, "missing"); // idempotent
	const record = readLaunchRecord(stateDir);
	if (
		record !== null &&
		identityLive(record) &&
		!(await stopAndProve(stateDir, signalRuntimeGroup))
	) {
		return errResponse("conflict", "delete: could not prove the generation terminated", false);
	}
	rmSync(stateDir, { recursive: true, force: true });
	return okResponse(handle, "missing");
}

/**
 * The host volume lives on the fleet host, so the fleet walks its session tree
 * itself and never asks; an ask is rejected like any op the runtime does not
 * implement.
 */
function listSessions(): Response {
	return errResponse(
		"invalid_request",
		"list-sessions is not supported by host profiles: the workspace volume is fleet-visible",
		false,
	);
}

export const hostCloneRuntimeProvider: RuntimeProvider<ExecutableRequest> = {
	async run(request) {
		const rejected = rejectNonHost(request);
		if (rejected !== null) return rejected;
		switch (request.op) {
			case "ensure-running":
				return await ensureRunning(request);
			case "inspect":
				return inspect(request);
			case "stop":
				return await stop(request);
			case "delete":
				return await deleteRuntime(request);
			case "list-sessions":
				return listSessions();
		}
	},
};
