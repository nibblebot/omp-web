#!/usr/bin/env bun
/**
 * bwrap sandbox provider: implements the provider operation protocol
 * (docs/provider-protocol.md) for clone workspaces on a bwrap-capable Linux
 * host.
 *
 * Invocation: `<executable> ensure-running|inspect|stop|delete|preflight` with exactly
 * one JSON request on stdin and one JSON response on stdout; exit 0 when a
 * response was produced (the `ok` flag classifies the outcome). stderr is a
 * human log the fleet never parses. The provider also has a private
 * supervisor mode (`--supervise <stateDir>`), never invoked by the fleet.
 *
 * Durable supervision model:
 * - `ensure-running` spawns a DETACHED supervisor that becomes the bwrap
 *   parent and holds the sandbox. The supervisor is reparented to init when
 *   the one-shot provider exits, so the sandbox survives provider and fleet
 *   restarts; bwrap's `--die-with-parent` kills the sandbox only when the
 *   SUPERVISOR dies (crash-cleanup, never restart-torn-down).
 * - The supervisor records the launch identity (apps/fleet/bwrap-identity.ts) at
 *   `<stateDir>/provider.pid.json` = {pid, procStartTime, generation,
 *   workspaceToken, startedAt}: pid is the HOST pid of the sandboxed
 *   command, found by walking bwrap's descendants for the workspace token;
 *   procStartTime is /proc/<pid>/stat field 22.
 * - Liveness = pid alive AND procStartTime matches AND /proc/<pid>/cmdline
 *   still contains the workspaceToken. PID reuse never matches. `stop`
 *   proves termination by identity, never by PID alone, escalating
 *   SIGTERM → SIGKILL and reporting stopped only after proof.
 *
 * The sandbox argv is built by lib/runtime/bwrap-args.ts (pure, denylist-
 * enforced: operator credentials, the SSH agent, container
 * sockets, and fleet/provider admin state are never mounted). No shell is
 * ever used.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, normalize } from "node:path";
import {
	ProviderProtocolError,
	type BwrapProfile,
	type ProviderObserved,
	type ProviderRequest,
	type ProviderResponse,
} from "#lib/runtime/provider-protocol";
import { acquireFileLock } from "#lib/platform/file-lock";
import { FLEET_CALLBACK_ENV_KEYS, buildBwrapArgv } from "#lib/runtime/bwrap-args";
import { buildFleetStdinPayload } from "#lib/runtime/fleet-stdin";
import {
	err,
	ok,
	readCallbackEnv,
	serveProviderRequest,
	writeJsonAtomic,
} from "#lib/runtime/provider-callback-env";
import { resolveProfileSecrets } from "#lib/runtime/profile-secrets";
import { preflightBwrapProfile } from "./bwrap-preflight";
import {
	BWRAP_PID_FILE,
	PROVIDER_EXIT_FILE,
	findTokenPid,
	identityLive,
	readExitRecord,
	readLaunchRecord,
	procIdentity,
	stopAndProve,
	writeExitRecord,
	type LaunchRecord,
} from "./bwrap-identity";
import { cloneRuntimeLaunch, defaultDenyRoots } from "./runtime-launch";
import { SessionLog, PROVIDER_DAEMON_LOG, pumpToSessionLog } from "./session-log";

/**
 * Pull the concrete secret-env values for the recorded key names out of the
 * supervisor's own environment. The sidecar carries names only; values never
 * touch disk. A missing value here is an internal inconsistency (resolve
 * re-validates before spawn), so the launch fails loudly rather than
 * launching a sandbox with a hole in its credentials.
 */
function secretEnvFromKeys(keys: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value === undefined) {
			throw new Error(`supervisor lost secret env key ${key} between resolve and spawn`);
		}
		env[key] = value;
	}
	return env;
}

const SUPERVISE_FILE = "supervise.json";
const SUPERVISE_ERR_FILE = "supervise.err";
/** How long ensure-running waits for the supervisor to write the pidfile. */
const PIDFILE_WAIT_MS = 10_000;
/** Descendant-walk poll budget for the sandboxed command pid. */
const INNER_PID_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const STATE_LOCK_HOLDER = "bwrap-provider";

/** Wait up to `timeoutMs` for a pidfile whose identity is live. */
async function waitForLiveRecord(
	stateDir: string,
	timeoutMs: number,
): Promise<LaunchRecord | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = readLaunchRecord(stateDir);
		if (identityLive(record)) return record;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return null;
}

// ---------------------------------------------------------------------------
// Handle (opaque, stable per workspace+generation)
// ---------------------------------------------------------------------------

/** Stable opaque handle: same workspace+generation+identity → same string. */
function handleFor(workspaceId: string, generation: number, record: LaunchRecord | null): string {
	if (record === null) return `bwrap:${workspaceId}:${generation}:none`;
	return `bwrap:${workspaceId}:${generation}:${record.pid}:${record.procStartTime}`;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** Private sidecar the supervisor reads; written by ensure-running. */
interface SuperviseSpec {
	request: ProviderRequest;
	runtimeEntry: string;
	runtimeBin: string;
	runtimeArgs: readonly string[];
	bwrapBin: string;
	startedAt: number;
	workspaceToken: string;
	/** Validated callback enrollment env from callback-env.json (may be empty). */
	callbackEnv: Record<string, string>;
	/** Secret-ref env key NAMES only; values never touch disk. */
	secretEnvKeys: readonly string[];
}

/** The request's profile narrowed to bwrap; another kind is a request error. */
function bwrapProfileOf(request: ProviderRequest): BwrapProfile {
	const profile = request.profile;
	if (profile.provider !== "bwrap") {
		throw ProviderProtocolError.invalidRequest(
			`profile ${profile.id} is a ${profile.provider} profile, not bwrap`,
		);
	}
	return profile;
}

/** Spawn the detached supervisor that owns the sandbox process tree. */
function spawnSupervisor(
	stateDir: string,
	request: ProviderRequest,
	callbackEnv: Record<string, string>,
	secretEnv: Record<string, string>,
): void {
	mkdirSync(stateDir, { recursive: true });
	const launch = cloneRuntimeLaunch();
	const spec: SuperviseSpec = {
		request,
		runtimeEntry: launch.entry,
		runtimeBin: launch.bin,
		runtimeArgs: launch.args,
		bwrapBin: process.env.OMP_BWRAP_BIN ?? "bwrap",
		startedAt: Date.now(),
		workspaceToken: randomUUID().replace(/-/g, ""),
		callbackEnv,
		secretEnvKeys: Object.keys(secretEnv),
	};
	// Carries the callback token and workspace token: owner-only.
	writeFileSync(join(stateDir, SUPERVISE_FILE), `${JSON.stringify(spec)}\n`, { mode: 0o600 });
	const providerScript = process.argv[1];
	if (providerScript === undefined || providerScript === "") {
		throw new Error("cannot resolve the provider script path for the supervisor");
	}
	Bun.spawn([process.execPath, providerScript, "--supervise", stateDir], {
		env: { ...process.env, ...secretEnv },
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
}

/** Append a supervisor failure reason to the stateDir error log. */
function recordSuperviseError(stateDir: string, message: string): void {
	try {
		writeFileSync(join(stateDir, SUPERVISE_ERR_FILE), `${message}\n`, { flag: "a" });
	} catch {
		// The stateDir may be gone (delete raced the supervisor); best effort.
	}
}

/**
 * The daemon's `--fleet-stdin` payload for a handed-over callback pair, or
 * undefined when the handoff carries no pair (the daemon then gets no flag).
 */
function fleetStdinFor(callbackEnv: Record<string, string>): string | undefined {
	if (!FLEET_CALLBACK_ENV_KEYS.some((key) => callbackEnv[key] !== undefined)) return undefined;
	return buildFleetStdinPayload(callbackEnv);
}

/** Supervisor entry: owns the sandbox until it exits; writes the pidfile. */
async function runSupervisor(stateDir: string): Promise<number> {
	let spec: SuperviseSpec;
	try {
		spec = JSON.parse(readFileSync(join(stateDir, SUPERVISE_FILE), "utf8")) as SuperviseSpec;
	} catch (cause) {
		const message = `cannot read ${SUPERVISE_FILE}: ${String(cause)}`;
		console.error(`bwrap-provider: supervise: ${message}`);
		recordSuperviseError(stateDir, message);
		return 1;
	}
	const { request } = spec;

	let built;
	let fleetStdin: string | undefined;
	try {
		// The callback pair reaches the daemon over stdin (--fleet-stdin), never
		// its environment. No pair means no flag, and the daemon never reads stdin.
		fleetStdin = fleetStdinFor(spec.callbackEnv);
		built = buildBwrapArgv({
			workspaceDir: request.workspaceDir,
			homeDir: request.homeDir,
			profile: bwrapProfileOf(request),
			workspaceToken: spec.workspaceToken,
			runtimeEntry: spec.runtimeEntry,
			runtimeBin: spec.runtimeBin,
			runtimeArgs:
				fleetStdin === undefined ? spec.runtimeArgs : [...spec.runtimeArgs, "--fleet-stdin"],
			bwrapBin: spec.bwrapBin,
			denyRoots: defaultDenyRoots(process.env),
			// The handoff env carries OMP_SESSION_RESUME (allowlisted). The callback
			// pair is not allowlisted, so it never enters the sandbox environment.
			env: { ...process.env, ...spec.callbackEnv },
			// The provider's secret refs resolved to concrete values (only
			// key names ride the sidecar; values live in this process env).
			secretEnv: secretEnvFromKeys(spec.secretEnvKeys),
			sourceLocal: request.source?.local,
		});
	} catch (cause) {
		const message = `sandbox argv rejected: ${String(cause)}`;
		console.error(`bwrap-provider: supervise: ${message}`);
		recordSuperviseError(stateDir, message);
		return 1;
	}

	// Child stdout and stderr go to one daemon.log in the state dir, capped per
	// SessionLog. stdin is always a pipe: the payload is written, then closed (EOF
	// when there is no pair). The daemon reads it only when started with --fleet-stdin.
	const logPath = join(stateDir, PROVIDER_DAEMON_LOG);
	let log: SessionLog;
	try {
		log = new SessionLog(logPath);
	} catch (cause) {
		const message = `cannot open ${PROVIDER_DAEMON_LOG}: ${String(cause)}`;
		console.error(`bwrap-provider: supervise: ${message}`);
		recordSuperviseError(stateDir, message);
		return 1;
	}
	const proc = Bun.spawn(built.argv, {
		env: built.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (fleetStdin !== undefined) proc.stdin.write(fleetStdin);
	proc.stdin.end();

	// Child output is pumped into the log, and failure details are read back from
	// it for this run only (a previous run's output is never reported). Failure
	// paths wait a bounded time for the pumps: a grandchild holding a pipe must
	// not stall the failure record.
	const STDERR_CAPTURE_BYTES = 4096;
	const LOG_DRAIN_MS = 1_000;
	const pumps = Promise.all([
		pumpToSessionLog(proc.stdout, log),
		pumpToSessionLog(proc.stderr, log),
	]);
	const recordBwrapFailure = async (message: string): Promise<void> => {
		await Promise.race([pumps, new Promise<void>((r) => setTimeout(r, LOG_DRAIN_MS))]);
		const detail = log.tailOfRun(STDERR_CAPTURE_BYTES);
		recordSuperviseError(stateDir, detail.length > 0 ? `${message}: ${detail}` : message);
	};

	// Find the sandboxed command pid by walking descendants for the token.
	const deadline = Date.now() + INNER_PID_WAIT_MS;
	let inner: number | null = null;
	while (Date.now() < deadline) {
		inner = findTokenPid(proc.pid, spec.workspaceToken);
		if (inner !== null) break;
		const code = await Promise.race([
			proc.exited,
			new Promise<null>((r) => setTimeout(() => r(null), POLL_INTERVAL_MS)),
		]);
		if (code !== null) {
			const message = `bwrap exited (rc ${code}) before the sandbox command appeared`;
			console.error(`bwrap-provider: supervise: ${message}`);
			await recordBwrapFailure(message);
			return code ?? 1;
		}
	}
	if (inner === null) {
		const message = "sandbox command never appeared";
		console.error(`bwrap-provider: supervise: ${message}`);
		await recordBwrapFailure(message);
		proc.kill();
		return 1;
	}

	const identity = procIdentity(inner);
	if (identity === null) {
		const message = "cannot read identity of sandbox command";
		console.error(`bwrap-provider: supervise: ${message}`);
		await recordBwrapFailure(message);
		proc.kill();
		return 1;
	}
	writeJsonAtomic(join(stateDir, BWRAP_PID_FILE), {
		pid: inner,
		procStartTime: identity.startTime,
		generation: request.generation,
		workspaceToken: spec.workspaceToken,
		startedAt: spec.startedAt,
	});

	// Hold the sandbox: bwrap exits when the sandbox command exits. Drain the log
	// pumps to completion so a POST-appearance death (the sandbox command started,
	// then died, e.g. a port collision or a runtime crash) is recorded with its real
	// rc AND output tail. supervise.err is the actionable record either way; the
	// pidfile stays in place so inspect reports "stopped".
	const code = await proc.exited;
	await pumps;
	const detail = log.tailOfRun(STDERR_CAPTURE_BYTES);
	log.close();
	const message = `sandbox exited (rc ${code})`;
	if (detail.length > 0) {
		console.error(`bwrap-provider: supervise: ${message}: ${detail}`);
		recordSuperviseError(stateDir, `${message}: ${detail}`);
	} else {
		console.error(`bwrap-provider: supervise: ${message}`);
	}
	// The exit record inspect reports for this launch (generation + token scope it).
	writeExitRecord(
		stateDir,
		{ generation: request.generation, workspaceToken: spec.workspaceToken },
		{ exitCode: code, summary: message, output: detail },
	);
	return code ?? 0;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Stop proof signals the recorded sandbox command pid (bwrap-identity.ts proves the termination by identity). */
const killRecordedPid = (pid: number, signal: NodeJS.Signals): void => {
	process.kill(pid, signal);
};

async function opEnsureRunning(request: ProviderRequest): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation, homeDir } = request;
	mkdirSync(stateDir, { recursive: true });

	// The workspace-owned private home may not exist yet (a fleet-created
	// clone dir without a home, or a fresh workspace): create it plus the
	// agent dir the sandbox writes its sessions into. Idempotent and
	// workspace-scoped; never touches anything outside homeDir.
	try {
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(join(homeDir, "agent"), { recursive: true });
	} catch (cause) {
		return err(
			"unavailable",
			`cannot create the workspace private home ${homeDir}: ${String(cause)}`,
			true,
		);
	}

	// Fail fast on a policy-rejected profile: validate the sandbox argv before
	// any supervisor spawn (denylist errors are request config problems).
	let secretEnv: Record<string, string>;
	try {
		secretEnv = resolveProfileSecrets(request);
		const launch = cloneRuntimeLaunch();
		buildBwrapArgv({
			workspaceDir: request.workspaceDir,
			homeDir: request.homeDir,
			profile: bwrapProfileOf(request),
			workspaceToken: "validation-token",
			runtimeEntry: launch.entry,
			runtimeBin: launch.bin,
			runtimeArgs: launch.args,
			bwrapBin: process.env.OMP_BWRAP_BIN ?? "bwrap",
			denyRoots: defaultDenyRoots(process.env),
			env: process.env,
		});
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			// resolveProfileSecrets throws invalid_request/unavailable only;
			// timeout is mapped defensively (the fleet owns that code).
			const code = cause.code === "timeout" ? "internal" : cause.code;
			return err(code, cause.message, cause.retryable);
		}
		return err("invalid_request", `profile rejected: ${String(cause)}`, false);
	}

	let lock;
	try {
		lock = acquireFileLock(join(stateDir, "lock"), STATE_LOCK_HOLDER);
	} catch {
		// Another instance is spawning; wait for its live pidfile.
		const record = await waitForLiveRecord(stateDir, PIDFILE_WAIT_MS);
		if (record !== null) {
			return ok(handleFor(workspaceId, generation, record), "running", {
				pid: record.pid,
				startedAt: record.startedAt,
			});
		}
		return err("conflict", "another provider instance holds the spawn lock", false);
	}

	try {
		const existing = readLaunchRecord(stateDir);
		if (existing !== null && identityLive(existing)) {
			if (existing.generation !== generation) {
				return err(
					"conflict",
					`workspace runs under generation ${existing.generation}, requested ${generation}`,
					false,
				);
			}
			return ok(handleFor(workspaceId, generation, existing), "running", {
				pid: existing.pid,
				startedAt: existing.startedAt,
			});
		}

		// Stale record from a dead or different generation: replace it.
		if (existing !== null && existing.generation !== generation) {
			rmSync(join(stateDir, BWRAP_PID_FILE), { force: true });
		}
		rmSync(join(stateDir, SUPERVISE_ERR_FILE), { force: true });
		rmSync(join(stateDir, PROVIDER_EXIT_FILE), { force: true });

		// Read + validate the fleet's callback enrollment handoff BEFORE
		// spawning: a stale enrollment must never start a generation.
		let callbackEnv: Record<string, string>;
		try {
			callbackEnv = readCallbackEnv("bwrap-provider", stateDir, workspaceId, generation) ?? {};
		} catch (cause) {
			if (cause instanceof ProviderProtocolError) {
				// readCallbackEnv throws unavailable/conflict only; timeout is
				// mapped defensively (the fleet owns that code).
				const code = cause.code === "timeout" ? "internal" : cause.code;
				return err(code, cause.message, cause.retryable);
			}
			return err("internal", `cannot read callback enrollment: ${String(cause)}`, false);
		}

		try {
			spawnSupervisor(stateDir, request, callbackEnv, secretEnv);
		} catch (cause) {
			return err("unavailable", `cannot start supervisor: ${String(cause)}`, true);
		}
		const record = await waitForLiveRecord(stateDir, PIDFILE_WAIT_MS);
		if (record === null) {
			let reason = "sandbox did not become live in time";
			try {
				const logged = readFileSync(join(stateDir, SUPERVISE_ERR_FILE), "utf8").trim();
				if (logged.length > 0) reason = logged;
			} catch {
				// No supervisor error log; keep the generic message.
			}
			return err("unavailable", reason, true);
		}
		return ok(handleFor(workspaceId, generation, record), "running", {
			pid: record.pid,
			startedAt: record.startedAt,
		});
	} finally {
		lock.release();
	}
}

function opInspect(request: ProviderRequest): ProviderResponse {
	const { stateDir, workspaceId, generation } = request;
	const record = readLaunchRecord(stateDir);
	if (record !== null && identityLive(record)) {
		return ok(handleFor(workspaceId, generation, record), "running", {
			pid: record.pid,
			startedAt: record.startedAt,
		});
	}
	const observed: ProviderObserved = record === null ? "missing" : "stopped";
	return ok(handleFor(workspaceId, generation, record), observed, readExitRecord(stateDir, record));
}

async function opStop(request: ProviderRequest): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation } = request;
	const record = readLaunchRecord(stateDir);
	const handle = handleFor(workspaceId, generation, record);
	if (!identityLive(record)) return ok(handle, "stopped"); // idempotent
	if (!(await stopAndProve(stateDir, killRecordedPid))) {
		return err("conflict", "could not prove the generation terminated", false);
	}
	return ok(handle, "stopped");
}

async function opDelete(request: ProviderRequest): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation } = request;
	const handle = handleFor(workspaceId, generation, null);
	if (!existsSync(stateDir)) return ok(handle, "missing"); // idempotent

	const record = readLaunchRecord(stateDir);
	if (record !== null && identityLive(record) && !(await stopAndProve(stateDir, killRecordedPid))) {
		return err("conflict", "delete: could not prove the generation terminated", false);
	}
	rmSync(stateDir, { recursive: true, force: true });
	return ok(handle, "missing");
}

/** The `preflight` op: bwrap-owned host checks; `workspaceDir` carries the fleet workspace root. */
async function opPreflight(request: ProviderRequest): Promise<ProviderResponse> {
	return {
		ok: true,
		checks: await preflightBwrapProfile(bwrapProfileOf(request), {
			workspaceRoot: request.workspaceDir,
		}),
	};
}

/**
 * list-sessions is the kubernetes provider's proof of a volume the fleet
 * cannot read. A bwrap volume lives on the fleet host, so the fleet walks its
 * session tree itself and never asks; an ask is rejected like any op the
 * provider does not implement.
 */
function opListSessions(): ProviderResponse {
	return err(
		"invalid_request",
		"list-sessions is not supported by bwrap profiles: the workspace volume is fleet-visible",
		false,
	);
}

// ---------------------------------------------------------------------------
// Protocol entry
// ---------------------------------------------------------------------------

const OPS: Record<
	ProviderRequest["op"],
	(r: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>
> = {
	"ensure-running": opEnsureRunning,
	inspect: opInspect,
	stop: opStop,
	delete: opDelete,
	preflight: opPreflight,
	"list-sessions": opListSessions,
};

async function main(): Promise<number> {
	const argv = process.argv.slice(2);

	// Private supervisor mode (spawned by ensure-running; never by the fleet).
	if (argv[0] === "--supervise") {
		if (argv.length !== 2) {
			console.error("bwrap-provider: --supervise requires a stateDir argument");
			return 1;
		}
		return runSupervisor(argv[1]);
	}

	if (argv.length !== 1) {
		process.stderr.write(
			`bwrap-provider: expected <op> with one JSON request on stdin, got ${argv.length} argv\n`,
		);
		return 1;
	}

	return serveProviderRequest("bwrap-provider", argv[0], (request) => OPS[request.op](request));
}

if (import.meta.main) {
	process.exit(await main());
}
