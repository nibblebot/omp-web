import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { ProviderProtocolError } from "../shared/provider-protocol";
import { ENV_ALLOW_KEYS } from "./bwrap-args";

// ---------------------------------------------------------------------------
// Callback-env handoff (`<stateDir>/callback-env.json`).
//
// The fleet writes this file before invoking a provider; the provider reads
// it back to build the sandbox/pod environment (callback URL, workspace,
// generation, credential, resume hint). Both directions go through this
// module so the wire shape, the allowlist, and the filesystem discipline
// cannot drift between the fleet and the two providers (stage 2 item 2).
//
// Write: build the payload, create `<file>.tmp.<random>` with O_EXCL mode
// 0600, write, fsync the file, rename it over the target, then fsync the
// parent directory. The rename is the publish point, so a reader never sees
// a partially written handoff.
//
// Rejections: symlinked target or state directory, non-directory state dir,
// oversized payload (64 KiB), disallowed env key, non-positive-integer
// generation, and identity mismatches. Record problems are
// `invalid_request`; on-disk or filesystem problems are `unavailable`; a
// record for another workspace/generation is `conflict`.
// ---------------------------------------------------------------------------

/** Handoff file name under the provider's per-workspace state directory. */
export const CALLBACK_ENV_FILE = "callback-env.json";
/** Handoff record version; a different version is never interpreted. */
export const CALLBACK_ENV_VERSION = 1;

/** Encoded handoff cap. */
const CALLBACK_ENV_MAX_BYTES = 64 * 1024;
/** One env value cap; mirrors the provider readers. */
const CALLBACK_ENV_VALUE_MAX_CHARS = 4096;
/** Explicit 0600 so umask can never loosen the handoff. */
const CALLBACK_ENV_MODE = 0o600;
/** Random suffix width for the temporary file (8 bytes, hex). */
const CALLBACK_ENV_TMP_BYTES = 8;

/** Persisted handoff: identity, generation, and the sandbox env allowlist. */
export interface CallbackEnvRecord {
	version: 1;
	workspaceId: string;
	generation: number;
	env: Record<string, string>;
}

const CALLBACK_ENV_PREFIX = "OMP_SESSION_CALLBACK_";
const RESUME_ENV_KEY = "OMP_SESSION_RESUME";
const RESUME_REQUIRED_ENV_KEY = "OMP_SESSION_RESUME_REQUIRED";

/**
 * Callback env allowlist: `OMP_SESSION_CALLBACK_*` keys from the shared
 * sandbox allowlist, plus the two wake-resume hints the fleet writes.
 */
export function isAllowedCallbackEnvKey(key: string): boolean {
	return (
		key === RESUME_ENV_KEY ||
		key === RESUME_REQUIRED_ENV_KEY ||
		(key.startsWith(CALLBACK_ENV_PREFIX) && ENV_ALLOW_KEYS.includes(key))
	);
}

/**
 * Validate a callback env map. Returns the normalized copy, or the reason it
 * was rejected, so the writer and reader can map it to their own error code.
 */
function parseCallbackEnv(value: unknown): { env: Record<string, string> } | { error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "env must be an object" };
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!isAllowedCallbackEnvKey(key)) return { error: `env key ${key} is not allowlisted` };
		if (typeof entry !== "string" || entry.length === 0) {
			return { error: `env.${key} must be a non-empty string` };
		}
		if (entry.length > CALLBACK_ENV_VALUE_MAX_CHARS) {
			return { error: `env.${key} exceeds ${CALLBACK_ENV_VALUE_MAX_CHARS} characters` };
		}
		env[key] = entry;
	}
	return { env };
}

/**
 * Stat the state directory, creating it (0700, recursive) when `create` and
 * it is missing. Any failure is `unavailable`.
 */
function statOrCreateDirectory(stateDir: string, create: boolean): Stats {
	try {
		return statSync(stateDir);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
			throw ProviderProtocolError.unavailable(`cannot stat state directory ${stateDir}`, { cause });
		}
	}
	try {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot create state directory ${stateDir}`, { cause });
	}
	try {
		return statSync(stateDir);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot stat state directory ${stateDir}`, { cause });
	}
}

/**
 * Require a real state directory with no symlink anywhere in its path: the
 * realpath comparison collapses links, so equality proves the path is
 * literal.
 */
function assertStateDirectory(stateDir: string, create: boolean): void {
	const stats = statOrCreateDirectory(stateDir, create);
	if (!stats.isDirectory()) {
		throw ProviderProtocolError.unavailable(`state directory ${stateDir} is not a directory`);
	}
	let real: string;
	try {
		real = realpathSync(stateDir);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot resolve state directory ${stateDir}`, {
			cause,
		});
	}
	if (real !== resolve(stateDir)) {
		throw ProviderProtocolError.unavailable(
			`state directory ${stateDir} resolves through a symlink`,
		);
	}
}

/**
 * lstat a path, mapping "absent" to null and any other failure to
 * `unavailable`. `lstat` (not `stat`) so a link itself is observable.
 */
function lstatOrNull(target: string): Stats | null {
	try {
		return lstatSync(target);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw ProviderProtocolError.unavailable(`cannot stat ${target}`, { cause });
	}
}

/** The target may be absent, but must never be a link or a directory. */
function assertReplaceableTarget(target: string): void {
	const stats = lstatOrNull(target);
	if (stats === null) return;
	if (stats.isSymbolicLink()) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} must not be a symlink`);
	}
	if (!stats.isFile()) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} is not a regular file`);
	}
}

/** Validate a record and return its canonical encoded form (with newline). */
function encodeCallbackEnvRecord(record: CallbackEnvRecord): string {
	if (record.version !== CALLBACK_ENV_VERSION) {
		throw ProviderProtocolError.invalidRequest(
			`${CALLBACK_ENV_FILE} version must be ${CALLBACK_ENV_VERSION}`,
		);
	}
	if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) {
		throw ProviderProtocolError.invalidRequest(
			`${CALLBACK_ENV_FILE} workspaceId must be a non-empty string`,
		);
	}
	if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
		throw ProviderProtocolError.invalidRequest(
			`${CALLBACK_ENV_FILE} generation must be a positive integer`,
		);
	}
	const parsed = parseCallbackEnv(record.env);
	if ("error" in parsed) {
		throw ProviderProtocolError.invalidRequest(`${CALLBACK_ENV_FILE} ${parsed.error}`);
	}
	const payload = `${JSON.stringify({
		version: CALLBACK_ENV_VERSION,
		workspaceId: record.workspaceId,
		generation: record.generation,
		env: parsed.env,
	})}\n`;
	if (Buffer.byteLength(payload, "utf8") > CALLBACK_ENV_MAX_BYTES) {
		throw ProviderProtocolError.invalidRequest(
			`${CALLBACK_ENV_FILE} exceeds ${CALLBACK_ENV_MAX_BYTES} bytes`,
		);
	}
	return payload;
}

/**
 * Write `<stateDir>/callback-env.json` atomically (temp "wx" 0600, fsync,
 * rename, fsync parent). Throws ProviderProtocolError("invalid_request") for
 * a bad record and ("unavailable") for a bad state directory or I/O failure.
 */
export function writeCallbackEnvFile(stateDir: string, record: CallbackEnvRecord): void {
	const payload = encodeCallbackEnvRecord(record);
	assertStateDirectory(stateDir, true);
	const target = join(stateDir, CALLBACK_ENV_FILE);
	assertReplaceableTarget(target);
	const tmp = `${target}.tmp.${randomBytes(CALLBACK_ENV_TMP_BYTES).toString("hex")}`;
	let fd: number;
	try {
		fd = openSync(tmp, "wx", CALLBACK_ENV_MODE);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(
			`cannot create a temporary ${CALLBACK_ENV_FILE} in ${stateDir}`,
			{ cause },
		);
	}
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} catch (cause) {
		closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort: the temporary file is inert even if it lingers.
		}
		throw ProviderProtocolError.unavailable(`cannot write ${CALLBACK_ENV_FILE}`, { cause });
	}
	closeSync(fd);
	try {
		renameSync(tmp, target);
	} catch (cause) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort, as above.
		}
		throw ProviderProtocolError.unavailable(`cannot replace ${CALLBACK_ENV_FILE}`, { cause });
	}
	// fsync the parent so the rename itself survives a crash.
	let dirFd: number;
	try {
		dirFd = openSync(stateDir, "r");
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot open state directory ${stateDir}`, { cause });
	}
	try {
		fsyncSync(dirFd);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot fsync state directory ${stateDir}`, { cause });
	} finally {
		closeSync(dirFd);
	}
}

/**
 * Read `<stateDir>/callback-env.json` back. Returns null when absent; throws
 * ProviderProtocolError("unavailable") for a symlinked/linked directory, a
 * malformed or oversized record, or a disallowed env key, and ("conflict")
 * when `opts` names a different workspace or generation. Each key in
 * `opts.required` must be present and non-empty.
 */
export function readCallbackEnvFile(
	stateDir: string,
	opts?: { workspaceId?: string; generation?: number; required?: readonly string[] },
): CallbackEnvRecord | null {
	const target = join(stateDir, CALLBACK_ENV_FILE);
	const stats = lstatOrNull(target);
	if (stats === null) return null;
	if (stats.isSymbolicLink()) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} must not be a symlink`);
	}
	if (!stats.isFile()) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} is not a regular file`);
	}
	assertStateDirectory(stateDir, false);
	if (stats.size > CALLBACK_ENV_MAX_BYTES) {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} exceeds ${CALLBACK_ENV_MAX_BYTES} bytes`,
		);
	}
	let raw: string;
	try {
		raw = readFileSync(target, "utf8");
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`cannot read ${CALLBACK_ENV_FILE}`, { cause });
	}
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
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
	if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} is missing workspaceId`);
	}
	if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} is missing a positive integer generation`,
		);
	}
	const parsedEnv = parseCallbackEnv(record.env);
	if ("error" in parsedEnv) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} ${parsedEnv.error}`);
	}
	const parsed: CallbackEnvRecord = {
		version: CALLBACK_ENV_VERSION,
		workspaceId: record.workspaceId,
		generation: record.generation as number,
		env: parsedEnv.env,
	};
	if (opts?.workspaceId !== undefined && parsed.workspaceId !== opts.workspaceId) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets workspace ${parsed.workspaceId}, requested ${opts.workspaceId}`,
		);
	}
	if (opts?.generation !== undefined && parsed.generation !== opts.generation) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets generation ${parsed.generation}, requested ${opts.generation}; a new generation must not start under a stale enrollment`,
		);
	}
	for (const key of opts?.required ?? []) {
		const entry = parsed.env[key];
		if (entry === undefined || entry.length === 0) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE} is missing required env ${key}`,
			);
		}
	}
	return parsed;
}
