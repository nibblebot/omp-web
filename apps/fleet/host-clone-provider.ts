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
 * outlives it). Output goes to `<stateDir>/session.log` through a detached
 * log relay (log-relay.ts, the shared SessionLog writer) that keeps the file
 * under the 1 MiB cap for the whole run, rotating to `session.log.1`, as the
 * bwrap supervisor does. The runtime is therefore a descendant of the launched
 * shell, found by its token. The shell writes the runtime's exit status to
 * `<stateDir>/runtime.status` (the launcher's own exit code is the relay's), and
 * when the launcher ends this runtime records the exit for `inspect`
 * (`exitCode` and the last logged line, bwrap-identity.ts `writeExitRecord`,
 * which never recreates a deleted stateDir).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
	PROVIDER_EXIT_FILE,
	cmdlineOf,
	findTokenPid,
	identityLive,
	processGroupOf,
	procIdentity,
	readExitRecord,
	readLaunchRecord,
	stopAndProve,
	writeExitRecord,
	type LaunchRecord,
} from "./bwrap-identity";
import { signalProcessGroup, spawnDetached } from "./host-provider";
import type { ExecutableRequest, RuntimeProvider } from "./runtime-provider";
import { cloneRuntimeLaunch, logRelayLaunch } from "./runtime-launch";
import { PROVIDER_SESSION_LOG, readSessionLogTail, rotateSessionLog } from "./session-log";

/** The runtime's exit status, written by the launcher shell beside the pidfile. */
const RUNTIME_STATUS_FILE = "runtime.status";
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
	exit?: { exitCode?: number; detail?: string },
): ProviderOkResponse {
	return {
		ok: true,
		handle,
		observed,
		...(record !== undefined ? { pid: record.pid, startedAt: record.startedAt } : {}),
		...exit,
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

/** The session's `--fleet-stdin` payload for a handed-over callback pair, or undefined when the handoff carries none. */
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
	rmSync(join(stateDir, PROVIDER_EXIT_FILE), { force: true });
	const statusFile = join(stateDir, RUNTIME_STATUS_FILE);
	rmSync(statusFile, { force: true });

	const runtime = cloneRuntimeLaunch();
	const fleetStdin = fleetStdinFor(callbackEnv);
	const workspaceToken = randomUUID().replace(/-/g, "");
	const logPath = join(stateDir, PROVIDER_SESSION_LOG);
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
				// The callback pair reaches the session over stdin, never its environment.
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
			relay: { ...logRelayLaunch(), statusFile },
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
	// The shell's forked subshell carries the token too until the runtime executes: skip any
	// descendant that still looks like the shell. Bun returns the launcher before its exec has
	// finished, when /proc reports an empty cmdline; a baseline read then would let the subshell
	// pass for the runtime (recording the wrong pid, and a runtime that already died looks live).
	// The shell's argv carries the token, so the baseline is only trusted once it does.
	let shellCmdline = "";
	const probe = (): number | null => {
		if (!shellCmdline.includes(workspaceToken)) shellCmdline = cmdlineOf(launcher.pid);
		return shellCmdline.includes(workspaceToken)
			? findTokenPid(launcher.pid, workspaceToken, shellCmdline)
			: null;
	};
	let pid = probe();
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
		pid = probe();
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
	// How this launch ends, for inspect (exit code and the last line it logged). The launcher
	// shell exits only after the runtime ended and the relay drained its output, so the capped
	// log already holds the runtime's last words. The runtime's own status comes from the file
	// the shell wrote (the launcher's exit code is the relay's, not the runtime's); a runtime
	// killed with its group leaves none. The launcher is this process's own child, so a fleet
	// restart loses the observation and inspect then reports a bare stop.
	void launcher.exited.then(() => {
		const exitCode = readRuntimeStatus(statusFile);
		const runBytes = Math.max(0, logSize(logPath) - logStart);
		writeExitRecord(
			stateDir,
			{ generation, workspaceToken },
			{
				exitCode,
				summary:
					exitCode === undefined
						? "session runtime ended without an exit status"
						: `session runtime exited (rc ${exitCode})`,
				output: readSessionLogTail(logPath, Math.min(runBytes, FAILURE_TAIL_BYTES)),
			},
		);
	});
	return okResponse(handleFor(workspaceId, generation, record), "running", record);
}

/** The runtime's exit status the launcher shell recorded, or undefined when it never got to. */
function readRuntimeStatus(path: string): number | undefined {
	try {
		const code = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : undefined;
	} catch {
		return undefined;
	}
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
		undefined,
		readExitRecord(stateDir, record),
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
