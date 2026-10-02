#!/usr/bin/env bun
/**
 * bwrap sandbox provider (P5.2): implements the frozen provider operation
 * protocol (docs/clone-contracts.md, "Provider operation protocol") for
 * clone workspaces on a bwrap-capable Linux host.
 *
 * Invocation: `<executable> ensure-running|inspect|stop|delete` with exactly
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
 * - The supervisor records the launch identity at
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
 * enforced per P5.5: operator credentials, the SSH agent, container
 * sockets, and fleet/provider admin state are never mounted). No shell is
 * ever used.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, normalize } from "node:path";
import {
	ProviderProtocolError,
	parseProviderRequest,
	type ProviderObserved,
	type ProviderRequest,
	type ProviderResponse,
} from "../../lib/runtime/provider-protocol";
import type { ProviderErrorCode } from "../../lib/runtime/provider-protocol";
import { acquireFileLock } from "../../lib/platform/file-lock";
import { ENV_ALLOW_KEYS, buildBwrapArgv } from "../../lib/runtime/bwrap-args";
import { defaultDenyRoots, defaultRuntimeLaunch, type RuntimeLaunch } from "./runtime-launch";

/** The provider's own pidfile record (superset of the shared identity shape). */
interface LaunchRecord {
	pid: number;
	procStartTime: number;
	generation: number;
	workspaceToken: string;
	startedAt: number;
}

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

const PID_FILE = "provider.pid.json";
const SUPERVISE_FILE = "supervise.json";
const SUPERVISE_ERR_FILE = "supervise.err";
/** Fleet-written callback enrollment handoff (0600), read before a spawn. */
const CALLBACK_ENV_FILE = "callback-env.json";
const CALLBACK_ENV_VERSION = 1;
/** How long ensure-running waits for the supervisor to write the pidfile. */
const PIDFILE_WAIT_MS = 10_000;
/** Descendant-walk poll budget for the sandboxed command pid. */
const INNER_PID_WAIT_MS = 5_000;
/** SIGTERM proof budget before SIGKILL escalation. */
const TERM_PROOF_MS = 10_000;
/** SIGKILL proof budget before declaring conflict. */
const KILL_PROOF_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const STATE_LOCK_HOLDER = "bwrap-provider";

// ---------------------------------------------------------------------------
// Host-side /proc identity helpers
// ---------------------------------------------------------------------------

/** Host pids that are direct children of `pid` (read from each tid's children file). */
function childrenOf(pid: number): number[] {
	try {
		const kids = new Set<number>();
		for (const tid of readdirSync(`/proc/${pid}/task`)) {
			const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
			if (raw.length === 0) continue;
			for (const k of raw.split(" ")) {
				const n = Number(k);
				if (Number.isSafeInteger(n) && n > 0) kids.add(n);
			}
		}
		return [...kids];
	} catch {
		return [];
	}
}

/** The process command line, space-joined ("" when unreadable or gone). */
function cmdlineOf(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
	} catch {
		return "";
	}
}

/** procStartTime (stat field 22) + state letter of a pid, or null when gone. */
function procIdentity(pid: number): { startTime: number; state: string } | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(") ");
		if (close < 0) return null;
		const tail = stat.slice(close + 2).split(" ");
		const startTime = Number(tail[19]);
		const state = tail[0] ?? "";
		if (!Number.isFinite(startTime)) return null;
		return { startTime, state };
	} catch {
		return null;
	}
}

/** Walk descendants of `root` looking for a cmdline containing `token`. */
function findTokenPid(root: number, token: string): number | null {
	const seen = new Set<number>([root]);
	const queue: number[] = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const kid of childrenOf(current)) {
			if (seen.has(kid)) continue;
			seen.add(kid);
			if (cmdlineOf(kid).includes(token)) return kid;
			queue.push(kid);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// State dir helpers
// ---------------------------------------------------------------------------

/** Read the provider launch record, or null when absent or malformed. */
function readLaunchRecord(stateDir: string): LaunchRecord | null {
	try {
		const value = JSON.parse(readFileSync(join(stateDir, PID_FILE), "utf8")) as Record<
			string,
			unknown
		>;
		if (
			typeof value.pid !== "number" ||
			typeof value.procStartTime !== "number" ||
			typeof value.generation !== "number" ||
			typeof value.workspaceToken !== "string" ||
			typeof value.startedAt !== "number"
		) {
			return null;
		}
		return {
			pid: value.pid,
			procStartTime: value.procStartTime,
			generation: value.generation,
			workspaceToken: value.workspaceToken,
			startedAt: value.startedAt,
		};
	} catch {
		return null;
	}
}

/** Atomically write the launch record (tmp file + rename). */
function writeLaunchRecord(stateDir: string, record: LaunchRecord): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = join(stateDir, `${PID_FILE}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	renameSync(tmp, join(stateDir, PID_FILE));
}

/**
 * The workspace identity check (frozen contract): the pid is alive, its
 * procStartTime (stat field 22) matches the record, its state is not a
 * zombie, and its cmdline still contains the workspace token.
 */
function identityLive(stateDir: string, record: LaunchRecord | null): boolean {
	if (record === null) return false;
	const identity = procIdentity(record.pid);
	if (identity === null) return false;
	if (identity.state === "Z" || identity.state === "X") return false;
	if (identity.startTime !== record.procStartTime) return false;
	return cmdlineOf(record.pid).includes(record.workspaceToken);
}

/** Wait up to `timeoutMs` for a pidfile whose identity is live. */
async function waitForLiveRecord(
	stateDir: string,
	timeoutMs: number,
): Promise<LaunchRecord | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = readLaunchRecord(stateDir);
		if (identityLive(stateDir, record)) return record;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return null;
}

// ---------------------------------------------------------------------------
// Callback enrollment handoff (fleet-written, provider-read)
// ---------------------------------------------------------------------------

/** Env key prefix the fleet may hand over for the sandbox callback pair. */
const CALLBACK_ENV_PREFIX = "OMP_SESSION_CALLBACK_";
/** P8.9 wake-resume: a fleet-written absolute main-session path (not under
 *  the CALLBACK_ prefix, but allowlisted and daemon-consumed at boot). */
const RESUME_ENV_KEY = "OMP_SESSION_RESUME";

function isCallbackEnvKey(key: string): boolean {
	// The callback pair's enrollment keys OR the wake-resume hint, both gated
	// by ENV_ALLOW_KEYS membership so nothing outside the allowlist can ride
	// the handoff file (P5.5).
	return (
		key === RESUME_ENV_KEY || (key.startsWith(CALLBACK_ENV_PREFIX) && ENV_ALLOW_KEYS.includes(key))
	);
}

/**
 * Read the fleet's callback enrollment handoff (`<stateDir>/callback-env.json`,
 * written 0600 before ensure-running). Returns the env entries to inject into
 * the sandbox, or null when the file is absent (a spawn without callback
 * flags is still allowed, stop-only management must not break).
 *
 * Strictness (P5.5): only known `OMP_SESSION_CALLBACK_*` keys pass; values
 * are bounded non-empty strings; the file's workspaceId and generation must
 * equal the request's: a new generation must never start under a stale
 * enrollment. Corrupt files throw `unavailable` (the fleet rewrites and
 * retries); identity mismatches throw `conflict`.
 */
function readCallbackEnv(
	stateDir: string,
	workspaceId: string,
	generation: number,
): Record<string, string> | null {
	const file = join(stateDir, CALLBACK_ENV_FILE);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null; // absent (or unreadable): spawn without callback env
	}
	try {
		const mode = statSync(file).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			console.error(
				`bwrap-provider: ${CALLBACK_ENV_FILE} is mode ${mode.toString(8)}, expected 0600`,
			);
		}
	} catch {
		// Stat raced a rewrite; the content parse below is authoritative.
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} is not valid JSON`, { cause });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} must be a JSON object`);
	}
	const record = value as Record<string, unknown>;
	if (record.version !== CALLBACK_ENV_VERSION) {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} has unsupported version ${JSON.stringify(record.version)}`,
		);
	}
	if (typeof record.workspaceId !== "string" || typeof record.generation !== "number") {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} is missing workspaceId/generation`,
		);
	}
	if (record.workspaceId !== workspaceId) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets workspace ${record.workspaceId}, requested ${workspaceId}`,
		);
	}
	if (record.generation !== generation) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets generation ${record.generation}, requested ${generation}; a new generation must not start under a stale enrollment`,
		);
	}
	const rawEnv = record.env;
	if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE}.env must be an object`);
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(rawEnv as Record<string, unknown>)) {
		if (!isCallbackEnvKey(key)) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE}.env.${key} is not an allowed callback env key`,
			);
		}
		if (typeof entry !== "string" || entry.length === 0) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE}.env.${key} must be a non-empty string`,
			);
		}
		if (entry.length > 4096) {
			throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE}.env.${key} exceeds 4096 bytes`);
		}
		env[key] = entry;
	}
	return env;
}

// ---------------------------------------------------------------------------
// Handle (opaque, stable per workspace+generation)
// ---------------------------------------------------------------------------

/** Stable opaque handle: same workspace+generation+identity → same string. */
function handleFor(workspaceId: string, generation: number, record: LaunchRecord | null): string {
	if (record === null) return `bwrap:${workspaceId}:${generation}:none`;
	return `bwrap:${workspaceId}:${generation}:${record.pid}:${record.procStartTime}`;
}

function ok(
	handle: string,
	observed: ProviderObserved,
	extra?: { pid?: number; startedAt?: number },
): ProviderResponse {
	return { ok: true, handle, observed, ...extra };
}

function err(
	code: Exclude<ProviderErrorCode, "timeout">,
	message: string,
	retryable: boolean,
): ProviderResponse {
	return { ok: false, error: { code, message, retryable } };
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

/** Secret-ref scheme prefix: the value is an environment variable name. */
const SECRET_ENV_SCHEME = "env:";
/** Secret-values bound (values ride the supervisor's process env). */
const SECRET_MAX_CHARS = 4096;

/**
 * Resolve profile `secretRefs` to concrete sandbox env values (P5.5).
 * Scheme `env:NAME` reads the named variable from the PROVIDER's own
 * environment: selected model credentials are supplied to the fleet, never
 * mounted from the operator agent dir. Values never touch the request JSON,
 * argv, or the stateDir; the supervisor receives only key names and pulls
 * the actual values from its own env. Unknown schemes are configuration
 * errors (`invalid_request`); a missing variable is `unavailable` with
 * actionable remediation (the operator must provision it before launch).
 */
function resolveProfileSecrets(request: ProviderRequest): {
	env: Record<string, string>;
	keys: readonly string[];
} {
	const refs = request.profile.secretRefs;
	if (refs === undefined || Object.keys(refs).length === 0) return { env: {}, keys: [] };
	const env: Record<string, string> = {};
	const keys: string[] = [];
	for (const [name, ref] of Object.entries(refs)) {
		if (!ref.startsWith(SECRET_ENV_SCHEME)) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: unsupported secret reference scheme "${ref}" (expected ${SECRET_ENV_SCHEME}NAME)`,
				{},
			);
		}
		const varName = ref.slice(SECRET_ENV_SCHEME.length);
		if (varName.length === 0) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: empty environment variable name in reference "${ref}"`,
				{},
			);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(varName)) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: "${varName}" is not a valid POSIX environment variable name`,
				{},
			);
		}
		const value = process.env[varName];
		if (value === undefined) {
			throw new ProviderProtocolError(
				"unavailable",
				`secretRefs.${name} references environment variable ${varName}, which is not set on the fleet host; provide it to the provider process (e.g. systemd unit EnvironmentFile) or fix the reference`,
				{},
			);
		}
		if (value.length === 0 || value.length > SECRET_MAX_CHARS) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: ${varName} must be a non-empty string of at most ${SECRET_MAX_CHARS} characters`,
				{},
			);
		}
		env[name] = value;
		keys.push(name);
	}
	return { env, keys };
}

/** Runtime entry resolution: process.resources env, else dev/bundle layout. */
function runtimeLaunchFor(): RuntimeLaunch {
	const launch = defaultRuntimeLaunch(process.env);
	// Clone daemons dial OUT over the callback channel; nobody dials in. The
	// daemon still binds its HTTP listener at boot, and under a host-network
	// profile (P5.7) the default port 4721 collides with any other local
	// daemon: an instant, silent in-sandbox death (smoke 2026-09-06: "Failed
	// to start server. Is port 4721 in use?"). Always bind an ephemeral port
	// unless the operator pinned one (env flag mapping is 1:1).
	if (process.env.OMP_SESSION_PORT === undefined && !launch.args.includes("--port")) {
		return { ...launch, args: [...launch.args, "--port", "0"] };
	}
	return launch;
}

/** Spawn the detached supervisor that owns the sandbox process tree. */
function spawnSupervisor(
	stateDir: string,
	request: ProviderRequest,
	callbackEnv: Record<string, string>,
	secretEnv: Record<string, string>,
): void {
	mkdirSync(stateDir, { recursive: true });
	const launch = runtimeLaunchFor();
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
	writeFileSync(join(stateDir, SUPERVISE_FILE), `${JSON.stringify(spec)}\n`);
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
	try {
		built = buildBwrapArgv({
			workspaceDir: request.workspaceDir,
			homeDir: request.homeDir,
			profile: request.profile,
			workspaceToken: spec.workspaceToken,
			runtimeEntry: spec.runtimeEntry,
			runtimeBin: spec.runtimeBin,
			runtimeArgs: spec.runtimeArgs,
			bwrapBin: spec.bwrapBin,
			denyRoots: defaultDenyRoots(process.env),
			// The fleet-written callback enrollment rides only the env
			// allowlist path, never the request JSON (P5.5).
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

	const proc = Bun.spawn(built.argv, {
		env: built.env,
		stdio: ["ignore", "ignore", "pipe"],
	});

	// Bounded stderr capture (human log, never parsed): keep the last chunk
	// so an early bwrap death surfaces the REAL reason (e.g. "Can't find
	// source path ..."), not a bare exit code. Capped at 4 KiB.
	const STDERR_CAPTURE_BYTES = 4096;
	let stderrTail = "";
	const stderrReader = (async () => {
		const reader = proc.stderr.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value !== undefined) {
					stderrTail = (stderrTail + Buffer.from(value).toString("utf8")).slice(
						-STDERR_CAPTURE_BYTES,
					);
				}
			}
		} catch {
			// Reader closed by process death; the tail is best-effort.
		}
	})();
	const recordBwrapFailure = (message: string): void => {
		const detail = stderrTail.trim();
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
			recordBwrapFailure(message);
			void stderrReader;
			return code ?? 1;
		}
	}
	if (inner === null) {
		const message = "sandbox command never appeared";
		console.error(`bwrap-provider: supervise: ${message}`);
		recordBwrapFailure(message);
		proc.kill();
		void stderrReader;
		return 1;
	}

	const identity = procIdentity(inner);
	if (identity === null) {
		const message = "cannot read identity of sandbox command";
		console.error(`bwrap-provider: supervise: ${message}`);
		recordBwrapFailure(message);
		proc.kill();
		return 1;
	}
	writeLaunchRecord(stateDir, {
		pid: inner,
		procStartTime: identity.startTime,
		generation: request.generation,
		workspaceToken: spec.workspaceToken,
		startedAt: spec.startedAt,
	});

	// Hold the sandbox: bwrap exits when the sandbox command exits. Drain
	// the bounded stderr reader to completion so a POST-appearance death
	// (the sandbox command started, then died, e.g. a port collision or a
	// runtime crash) is recorded with its real rc AND stderr tail, not lost
	// with the dropped reader. supervise.err is the actionable record either
	// way; the pidfile stays in place so inspect reports "stopped".
	const code = await proc.exited;
	await stderrReader;
	const detail = stderrTail.trim();
	const message = `sandbox exited (rc ${code})`;
	if (detail.length > 0) {
		console.error(`bwrap-provider: supervise: ${message}: ${detail}`);
		recordSuperviseError(stateDir, `${message}: ${detail}`);
	} else {
		console.error(`bwrap-provider: supervise: ${message}`);
	}
	return code ?? 0;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Stop the workspace's sandbox and PROVE the generation terminated by
 * identity. Returns true when the recorded process is gone or no longer
 * matches the launch identity; false when proof is impossible (conflict).
 */
async function stopAndProve(stateDir: string, generation: number): Promise<boolean> {
	const record = readLaunchRecord(stateDir);
	if (record === null || !identityLive(stateDir, record)) return true; // already stopped/missing
	const target = record.pid;

	const escalate = async (signal: NodeJS.Signals, budgetMs: number): Promise<boolean> => {
		try {
			process.kill(target, signal);
		} catch {
			return true;
		}
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			const now = readLaunchRecord(stateDir);
			if (!identityLive(stateDir, now)) return true;
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		return false;
	};

	if (await escalate("SIGTERM", TERM_PROOF_MS)) return true;
	if (await escalate("SIGKILL", KILL_PROOF_MS)) return true;
	return false;
}

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
	// any supervisor spawn (P5.5 denylist errors are request config problems).
	let secretResolved: { env: Record<string, string>; keys: readonly string[] } | undefined;
	try {
		secretResolved = resolveProfileSecrets(request);
		const launch = runtimeLaunchFor();
		buildBwrapArgv({
			workspaceDir: request.workspaceDir,
			homeDir: request.homeDir,
			profile: request.profile,
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
		if (existing !== null && identityLive(stateDir, existing)) {
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
			rmSync(join(stateDir, PID_FILE), { force: true });
		}
		rmSync(join(stateDir, SUPERVISE_ERR_FILE), { force: true });

		// Read + validate the fleet's callback enrollment handoff BEFORE
		// spawning: a stale enrollment must never start a generation.
		let callbackEnv: Record<string, string>;
		try {
			callbackEnv = readCallbackEnv(stateDir, workspaceId, generation) ?? {};
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
			spawnSupervisor(stateDir, request, callbackEnv, secretResolved.env);
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
	if (record !== null && identityLive(stateDir, record)) {
		return ok(handleFor(workspaceId, generation, record), "running", {
			pid: record.pid,
			startedAt: record.startedAt,
		});
	}
	const observed: ProviderObserved = record === null ? "missing" : "stopped";
	return ok(handleFor(workspaceId, generation, record), observed);
}

async function opStop(request: ProviderRequest): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation } = request;
	const record = readLaunchRecord(stateDir);
	const handle = handleFor(workspaceId, generation, record);
	if (!identityLive(stateDir, record)) return ok(handle, "stopped"); // idempotent
	if (!(await stopAndProve(stateDir, generation))) {
		return err("conflict", "could not prove the generation terminated", false);
	}
	return ok(handle, "stopped");
}

async function opDelete(request: ProviderRequest): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation } = request;
	const handle = handleFor(workspaceId, generation, null);
	if (!existsSync(stateDir)) return ok(handle, "missing"); // idempotent

	const record = readLaunchRecord(stateDir);
	if (
		record !== null &&
		identityLive(stateDir, record) &&
		!(await stopAndProve(stateDir, generation))
	) {
		return err("conflict", "delete: could not prove the generation terminated", false);
	}
	rmSync(stateDir, { recursive: true, force: true });
	return ok(handle, "missing");
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

	let raw = "";
	for await (const chunk of process.stdin as AsyncIterable<string>) {
		raw += chunk;
		if (raw.length > 1024 * 1024) {
			process.stderr.write("bwrap-provider: request exceeds 1 MiB\n");
			return 1;
		}
	}

	let response: ProviderResponse;
	try {
		const request = parseProviderRequest(raw);
		if (argv[0] !== request.op) {
			throw ProviderProtocolError.invalidRequest(
				`argv op ${argv[0]} does not match request op ${request.op}`,
			);
		}
		response = await OPS[request.op](request);
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			response = {
				ok: false,
				error: { code: cause.code, message: cause.message, retryable: cause.retryable },
			};
		} else {
			response = {
				ok: false,
				error: { code: "internal", message: `provider failed: ${String(cause)}`, retryable: false },
			};
		}
	}

	process.stdout.write(`${JSON.stringify(response)}\n`);
	return 0;
}

process.exit(await main());
