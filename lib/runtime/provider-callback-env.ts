/**
 * Helpers shared by the bwrap and kubernetes provider executables and the
 * fleet: the callback enrollment handoff reader (`callback-env.json`), the
 * provider response constructors, the atomic record writer, and the stdin
 * request entry. The providers are separate executables, so the share point
 * is lib/, not apps/fleet. Imports only node builtins and lib/*.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FLEET_CALLBACK_ENV_KEYS } from "./bwrap-args";
import { buildFleetStdinPayload } from "./fleet-stdin";
import {
	ProviderProtocolError,
	parseProviderRequest,
	type ProviderErrorCode,
	type ProviderObserved,
	type ProviderOkResponse,
	type ProviderRequest,
	type ProviderResponse,
} from "./provider-protocol";

/** Fleet-written callback enrollment handoff (0600), read before a spawn. */
export const CALLBACK_ENV_FILE = "callback-env.json";
const CALLBACK_ENV_VERSION = 1;

/** P8.9 wake-resume: a fleet-written absolute main-session path (not a
 *  callback key, but allowlisted and daemon-consumed at boot). */
const RESUME_ENV_KEY = "OMP_SESSION_RESUME";

/** Request-size cap for the single JSON request on a provider's stdin. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Read the fleet's callback enrollment handoff (`<stateDir>/callback-env.json`,
 * written 0600 before ensure-running). Returns the callback pair as the
 * `OMP_SESSION_CALLBACK_*` env shape (converted to the daemon's `--fleet-stdin`
 * payload at spawn), or null when the file is absent (a spawn without a pair is
 * still allowed, stop-only management must not break).
 *
 * Strictness (P5.5): only known callback keys pass and the pair must be whole
 * (buildFleetStdinPayload validates it); values are bounded non-empty strings;
 * the file's workspaceId and generation must equal the caller's: a new
 * generation must never start under a stale enrollment. Corrupt files throw
 * `unavailable` (the fleet rewrites and retries); identity mismatches throw
 * `conflict`. `label` prefixes the loose-mode warning.
 */
export function readCallbackEnv(
	label: string,
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
			console.error(`${label}: ${CALLBACK_ENV_FILE} is mode ${mode.toString(8)}, expected 0600`);
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
		// The callback pair's enrollment keys OR the wake-resume hint, both from
		// a closed list so nothing outside it can ride the handoff file (P5.5).
		if (key !== RESUME_ENV_KEY && !FLEET_CALLBACK_ENV_KEYS.includes(key)) {
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
	// A partial pair must never reach the daemon: validate the whole pair here.
	if (FLEET_CALLBACK_ENV_KEYS.some((key) => env[key] !== undefined)) {
		try {
			buildFleetStdinPayload(env);
		} catch (cause) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE} callback pair is incomplete or invalid`,
				{ cause },
			);
		}
	}
	return env;
}

export function ok(
	handle: string,
	observed: ProviderObserved,
	extra?: Pick<ProviderOkResponse, "pid" | "startedAt" | "sessions" | "complete">,
): ProviderResponse {
	return { ok: true, handle, observed, ...extra };
}

export function err(
	code: Exclude<ProviderErrorCode, "timeout">,
	message: string,
	retryable: boolean,
): ProviderResponse {
	return { ok: false, error: { code, message, retryable } };
}

/**
 * Atomically write a provider identity record (0600, tmp file + rename). The
 * tmp name carries the pid so two provider processes never share a tmp file.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * Serve one provider op: read the single JSON request from stdin (1 MiB cap),
 * parse it, require its op to equal `op` from argv, run it, and write the
 * one-line JSON response to stdout. Protocol errors map to typed error
 * responses, anything else to `internal`. Always returns exit code 0 once a
 * request was read; a malformed invocation is the caller's to reject first.
 */
export async function serveProviderRequest(
	provider: string,
	op: string,
	run: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
): Promise<number> {
	let raw = "";
	for await (const chunk of process.stdin as AsyncIterable<string>) {
		raw += chunk;
		if (raw.length > MAX_REQUEST_BYTES) {
			process.stderr.write(`${provider}: request exceeds 1 MiB\n`);
			return 1;
		}
	}

	let response: ProviderResponse;
	try {
		const request = parseProviderRequest(raw);
		if (op !== request.op) {
			throw ProviderProtocolError.invalidRequest(
				`argv op ${op} does not match request op ${request.op}`,
			);
		}
		response = await run(request);
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
