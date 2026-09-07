/**
 * Fleet-side provider invocation (P5.1): runs a clone-workspace provider
 * executable per the frozen op contract (docs/clone-contracts.md, "Provider
 * operation protocol"; wire shapes and validation live in
 * shared/provider-protocol.ts).
 *
 * Invocation model: `<executable> <op>` with exactly one JSON request on
 * stdin (<= 1 MiB), exactly one JSON response on stdout, stderr a human log
 * never parsed. Exit 0 means a response was produced on stdout — an
 * `ok:false` response envelope is still exit 0, because the invocation
 * succeeded and the OPERATION failed (the envelope classifies it). This
 * function therefore returns every well-formed envelope as-is (callers
 * branch on `response.ok`) and throws {@link ProviderOpError} only for
 * transport/protocol failures: spawn failure, timeout, oversized output, a
 * non-zero exit, or a malformed response.
 *
 * Like the rest of the runtime, spawning uses explicit argv arrays — never a
 * shell — and every byte of child output is collected with a hard cap so a
 * misbehaving provider cannot exhaust fleet memory.
 */

import type { Subprocess } from "bun";
import type {
	ProviderErrorCode,
	ProviderOp,
	ProviderRequest,
	ProviderResponse,
} from "../shared/provider-protocol";
import {
	PROVIDER_JSON_MAX_BYTES,
	ProviderProtocolError,
	isProviderProtocolError,
	parseProviderResponse,
	validateProviderRequest,
} from "../shared/provider-protocol";

/** Default op timeout when the caller does not pick one. */
export const PROVIDER_OP_TIMEOUT_MS_DEFAULT = 30_000;

export interface RunProviderOpOptions {
	/** Wall-clock budget for the whole invocation; must be a positive integer. */
	timeoutMs?: number;
}

/** Construction details for {@link ProviderOpError}. */
interface ProviderOpErrorInit {
	code: ProviderErrorCode;
	message: string;
	executable: string;
	op: ProviderOp;
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	/** Overrides the code-derived retryability (used for provider-authored envelopes). */
	retryable?: boolean;
	cause?: unknown;
}

/**
 * Typed failure of one provider invocation: thrown for spawn failures,
 * timeouts, oversized output, non-zero exits, and malformed responses. A
 * provider-authored `ok:false` envelope returned at exit 0 is NOT thrown —
 * the caller receives the response and branches on `ok`. Non-zero exits
 * throw even when stdout carries an `ok:false` envelope (exit 0 is the
 * contract's "a response was produced" signal), but the envelope's
 * code/message/retryable are preserved on the error.
 */
export class ProviderOpError extends ProviderProtocolError {
	readonly executable: string;
	readonly op: ProviderOp;
	/** Process exit code; null when the process was killed before exiting. */
	readonly exitCode: number | null;
	/** Response bytes (capped) the provider wrote, for diagnostics. */
	readonly stdout: string | undefined;
	/** Human-log bytes (capped) the provider wrote, for diagnostics. */
	readonly stderr: string | undefined;
	readonly retryable: boolean;

	constructor(init: ProviderOpErrorInit) {
		super(init.code, init.message, { cause: init.cause });
		this.name = "ProviderOpError";
		this.executable = init.executable;
		this.op = init.op;
		this.exitCode = init.exitCode ?? null;
		this.stdout = init.stdout;
		this.stderr = init.stderr;
		this.retryable = init.retryable ?? (init.code === "unavailable" || init.code === "timeout");
	}
}

/** One-line stderr excerpt for error messages; full text rides `stderr`. */
function stderrSummary(stderr: string): string {
	const lines = stderr.trim().split("\n");
	const line = lines[lines.length - 1] ?? "";
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Human message for an unexpected thrown value. */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Collect one piped child stream up to `maxBytes`, decoding as UTF-8. When
 * the cap is exceeded the remaining output is discarded (the caller kills
 * the child via `onOverflow` so the sibling stream drains) and "" is
 * returned — oversized output is a failure, not a payload.
 */
async function collectPipe(
	pipe: ReadableStream<Uint8Array>,
	maxBytes: number,
	onOverflow: () => void,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of pipe) {
		if (total + chunk.byteLength > maxBytes) {
			onOverflow();
			return "";
		}
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Run one provider operation to completion: spawn `<executable> <op>`, write
 * the validated request JSON to stdin, collect bounded stdout/stderr, and
 * return the validated response envelope.
 *
 * Returns any well-formed envelope (ok or not) the provider produced at exit
 * 0. Throws {@link ProviderOpError}:
 * - `unavailable` (retryable) — the executable could not be spawned;
 * - `timeout` (retryable) — no response within `timeoutMs`; the child is
 *   SIGTERM-killed and SIGKILL-escalated after a grace period;
 * - `internal` — output exceeded the 1 MiB cap, the provider exited non-zero
 *   without a trustworthy envelope, or the response envelope is malformed;
 * - a provider envelope's own code when the provider exited non-zero but
 *   still produced a valid `ok:false` envelope.
 *
 * Request validation failures throw `invalid_request` before any spawn.
 */
export async function runProviderOp(
	executable: string,
	request: ProviderRequest,
	opts?: RunProviderOpOptions,
): Promise<ProviderResponse> {
	const timeoutMs = opts?.timeoutMs ?? PROVIDER_OP_TIMEOUT_MS_DEFAULT;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		throw new ProviderOpError({
			code: "invalid_request",
			message: `timeoutMs must be a positive integer, got ${String(timeoutMs)}`,
			executable,
			op: request.op,
		});
	}

	let validated: ProviderRequest;
	try {
		validated = validateProviderRequest(request);
	} catch (err) {
		if (isProviderProtocolError(err)) {
			throw new ProviderOpError({
				code: err.code,
				message: `provider request rejected: ${err.message}`,
				executable,
				op: request.op,
				cause: err,
			});
		}
		throw err;
	}

	const payload = new TextEncoder().encode(JSON.stringify(validated));
	if (payload.byteLength > PROVIDER_JSON_MAX_BYTES) {
		throw new ProviderOpError({
			code: "invalid_request",
			message: `provider request serializes to ${payload.byteLength} bytes, over the ${PROVIDER_JSON_MAX_BYTES}-byte limit`,
			executable,
			op: validated.op,
		});
	}

	// Wall-clock budget. SIGTERM first; SIGKILL after a grace period for
	// children that ignore SIGTERM. Both timers are unref'd: a provider that
	// finishes early must not hold the fleet's event loop.
	let timedOut = false;
	let proc: Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn([executable, validated.op], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Explicit inheritance: like runGit in prepare-workspace, Bun.spawn
			// must not be relied on to inherit process.env on its own.
			env: { ...process.env },
		});
	} catch (err) {
		throw new ProviderOpError({
			code: "unavailable",
			message: `cannot spawn provider executable ${executable}: ${errorMessage(err)}`,
			executable,
			op: validated.op,
			retryable: true,
			cause: err,
		});
	}

	const killTimer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			/* already dead */
		}
		setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, 1_000).unref();
	}, timeoutMs);
	killTimer.unref();

	try {
		// The provider may exit before consuming its stdin (e.g. on an
		// invalid request); the exit code below is then the verdict.
		try {
			await proc.stdin.write(payload);
			await proc.stdin.end();
		} catch {
			/* child exited early; ignored here, surfaced via exit code */
		}

		let overflowed: "stdout" | "stderr" | null = null;
		const [stdout, stderr] = await Promise.all([
			collectPipe(proc.stdout as ReadableStream<Uint8Array>, PROVIDER_JSON_MAX_BYTES, () => {
				overflowed = "stdout";
				try {
					proc.kill();
				} catch {
					/* already dead */
				}
			}),
			collectPipe(proc.stderr as ReadableStream<Uint8Array>, PROVIDER_JSON_MAX_BYTES, () => {
				overflowed = "stderr";
				try {
					proc.kill();
				} catch {
					/* already dead */
				}
			}),
		]);
		const exitCode = await proc.exited;

		if (timedOut) {
			throw new ProviderOpError({
				code: "timeout",
				message: `provider ${executable} did not complete ${validated.op} within ${timeoutMs}ms`,
				executable,
				op: validated.op,
				exitCode,
				stdout,
				stderr,
			});
		}
		if (overflowed !== null) {
			throw new ProviderOpError({
				code: "internal",
				message: `provider ${executable} wrote more than ${PROVIDER_JSON_MAX_BYTES} bytes to ${overflowed} during ${validated.op}`,
				executable,
				op: validated.op,
				exitCode,
				stdout,
				stderr,
			});
		}

		if (exitCode !== 0) {
			try {
				const envelope = parseProviderResponse(stdout);
				if (envelope.ok) {
					throw new ProviderOpError({
						code: "internal",
						message: `provider ${executable} exited ${exitCode} during ${validated.op} after reporting ok:true`,
						executable,
						op: validated.op,
						exitCode,
						stdout,
						stderr,
					});
				}
				throw new ProviderOpError({
					code: envelope.error.code,
					message: `provider ${executable} failed ${validated.op}: ${envelope.error.message}`,
					executable,
					op: validated.op,
					exitCode,
					stdout,
					stderr,
					retryable: envelope.error.retryable,
				});
			} catch (err) {
				if (err instanceof ProviderOpError) throw err;
				throw new ProviderOpError({
					code: "internal",
					message: `provider ${executable} exited ${exitCode} during ${validated.op} without a valid response${stderr.trim() === "" ? "" : `: ${stderrSummary(stderr)}`}`,
					executable,
					op: validated.op,
					exitCode,
					stdout,
					stderr,
					cause: err,
				});
			}
		}

		try {
			return parseProviderResponse(stdout);
		} catch (err) {
			throw new ProviderOpError({
				code: "internal",
				message: `provider ${executable} returned an invalid response to ${validated.op}: ${errorMessage(err)}`,
				executable,
				op: validated.op,
				exitCode: 0,
				stdout,
				stderr,
				cause: err,
			});
		}
	} catch (err) {
		// Unknown failures (pipe read errors, rejections): never leak a raw
		// error while a child may still be alive.
		if (!(err instanceof ProviderOpError)) {
			try {
				proc.kill();
			} catch {
				/* already dead */
			}
			throw new ProviderOpError({
				code: "internal",
				message: `provider ${executable} ${validated.op} invocation failed: ${errorMessage(err)}`,
				executable,
				op: validated.op,
				cause: err,
			});
		}
		throw err;
	} finally {
		clearTimeout(killTimer);
	}
}
