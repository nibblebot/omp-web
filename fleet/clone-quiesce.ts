import { randomUUID } from "node:crypto";
import {
	CALLBACK_ERROR_CODES,
	CALLBACK_TRANSPORT_STREAM_ID,
	isCallbackError,
	parseQuiesceEvidence,
	type CallbackErrorCode,
	type QuiesceCloneControl,
	type QuiesceEvidence,
} from "../shared/callback-protocol";
import { RESOURCE_IDENTITY_RE } from "../shared/provider-protocol";
import type { BulkCorrelation, BulkResult, DaemonTransportRegistry } from "./daemon-transport";
import type { FleetEventLog } from "./events";
import {
	validateQuiesceReceipt,
	type CloneQuiesceRequest,
	type ValidatedQuiesceReceipt,
} from "./clone-quiesce-receipt";
import type { FleetLogStore } from "./log-store";

/**
 * Fleet-side owner of the `quiesce_clone` handshake (clone-plan P7.3/P7.5;
 * contracts: docs/clone-contracts.md "Fleet log store" and "Typed errors"):
 * the request, its timeout, the bulk capture, and the composition of the two.
 * Nothing quiesce-related is re-implemented here: the daemon half
 * (server/daemon-control.ts `createDaemonControl`) does the writer flush,
 * dispose, tailer finalize, structural verification, and Git collection, and
 * answers with a `quiesce_clone_result` control carrying the evidence as a
 * bulk upload. This module only requests that, bounds it, and hands the
 * result to the receipt leaf.
 *
 * Public API (fleet/workspace-lifecycle.ts consumes it through
 * `WorkspaceLifecycleDeps.collectCloneEvidence`; fleet/server.ts constructs
 * {@link CloneQuiesce}):
 *
 *   class CloneQuiesce            constructed from { transport, logStore, eventLog }
 *     .collect(request)           send + wait + capture + validate, one step
 *   requestQuiesceClone(input)    send the control, await the typed result (30 s)
 *   collectQuiesceEvidence(input) await the captured upload, parse it (30 s; always
 *                                 releases the capture, including on timeout)
 *   quiesceClone(input)           open capture -> request -> collect, composing both
 *
 * The receipt validation and delete-vs-stop decision live in
 * fleet/clone-quiesce-receipt.ts, which this module calls but does not
 * re-export.
 *
 * Wire shape: `{type:"quiesce_clone", requestId, correlationId, sourceRemote,
 * pinnedRevision, branch}` on the reserved transport stream, acknowledged by
 * the daemon's `quiesce_clone_result` control (shared/callback-protocol.ts).
 * The evidence document is uploaded by the daemon through
 * `FleetCallback.requestBulkUploadParts` (server/fleet-callback.ts) under the
 * fleet-issued capture correlation; the fleet awaits `BulkCorrelation.done`.
 *
 * Timeouts: no quiesce request is ever left uncancelled. Every failure path
 * (control timeout, ack failure, evidence timeout, parse failure, validation
 * failure, missing log store) releases the correlation through
 * `DaemonTransportRegistry.cancelBulkCorrelation`, and transport shutdown
 * releases whatever is still in flight.
 */

/** Fleet-side bound on the control round trip (plan stage 4.4: quiesce 30 s). */
export const QUIESCE_CLONE_TIMEOUT_MS = 30_000;
/** Bound on the post-ack evidence upload; the same 30 s quiesce budget. */
export const QUIESCE_EVIDENCE_TIMEOUT_MS = 30_000;
/**
 * Bound on a `quiesce_clone` request id. The daemon caches its outcome under
 * this key for the Pod's lifetime, so the id a retry persists and replays must
 * stay a bounded non-empty string.
 */
export const QUIESCE_REQUEST_ID_MAX_CHARS = 128;

const QUIESCE_REQUEST_TYPE = "quiesce_clone";
const QUIESCE_RESULT_TYPE = "quiesce_clone_result";

/** Narrow an untrusted wire code onto the frozen ledger vocabulary. */
function ledgerCode(value: unknown): CallbackErrorCode {
	return typeof value === "string" && (CALLBACK_ERROR_CODES as readonly string[]).includes(value)
		? (value as CallbackErrorCode)
		: "provider_failed";
}

/**
 * The nested typed error a control ack or control result carries
 * (`ControlAckPayload.error`, `QuiesceCloneResultControl.error`). Null when
 * the payload has no usable typed error.
 */
function controlError(
	payload: Record<string, unknown>,
): { code: CallbackErrorCode; message: string | undefined } | null {
	const raw = payload["error"];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const error = raw as Record<string, unknown>;
	return {
		code: ledgerCode(error["code"]),
		message: typeof error["message"] === "string" ? error["message"] : undefined,
	};
}

// ---------------------------------------------------------------------------
// Transport request
// ---------------------------------------------------------------------------

/** The clone source tuple the fleet supplies and the daemon must not re-derive. */
export interface QuiesceCloneSource {
	remote: string;
	revision: string;
	branch: string;
}

/** Which half of the handshake failed. */
export type QuiesceCloneStage = "request" | "evidence" | "validation";

/** Typed quiesce failure; `code` is the frozen ledger vocabulary, so a caller
 * maps it straight onto its own typed error (CloneLifecycleError's code set
 * is the same union). */
export class CloneQuiesceError extends Error {
	constructor(
		readonly code: CallbackErrorCode,
		message: string,
		readonly stage: QuiesceCloneStage,
	) {
		super(message);
		this.name = "CloneQuiesceError";
	}
}

export type QuiesceCloneRequestResult =
	| { ok: true; requestId: string; correlationId: string }
	| { ok: false; code: CallbackErrorCode; message: string };

export interface QuiesceCloneRequestInput {
	transport: DaemonTransportRegistry;
	workspaceId: string;
	generation: number;
	requestId: string;
	correlationId: string;
	source: QuiesceCloneSource;
	/** Defaults to {@link QUIESCE_CLONE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Send `quiesce_clone` on the reserved transport stream and wait up to
 * `timeoutMs` (default 30 s) for the daemon's matching result.
 *
 * Settles on the FIRST of:
 *  - `kind:"control"` / `quiesce_clone_result` with our requestId and
 *    correlationId (ok:true, or ok:false with the daemon's nested typed error);
 *  - `kind:"ack"` carrying our control identity with ok:false (the control
 *    itself was rejected, so no result is coming; the typed error is the
 *    nested `ControlAckPayload.error`);
 *  - the callback pair dropping (`paired:false`) or `sendToDaemon` failing
 *    (`unavailable`);
 *  - the timeout (`retryable`).
 *
 * Envelopes from another generation, stream, request, or correlation are
 * ignored. The caller owns the capture correlation: on failure it MUST
 * release it with `cancelBulkCorrelation` (quiesceClone does so).
 */
export async function requestQuiesceClone(
	input: QuiesceCloneRequestInput,
): Promise<QuiesceCloneRequestResult> {
	const { transport, workspaceId, generation, requestId, correlationId, source } = input;
	if (
		workspaceId.length === 0 ||
		requestId.length === 0 ||
		correlationId.length === 0 ||
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		source.remote.length === 0 ||
		source.revision.length === 0 ||
		source.branch.length === 0
	) {
		return {
			ok: false,
			code: "invalid_request",
			message:
				"requestQuiesceClone requires a workspaceId, a positive integer generation, requestId, correlationId, and a complete source tuple",
		};
	}
	const timeoutMs = input.timeoutMs ?? QUIESCE_CLONE_TIMEOUT_MS;
	const { promise: settled, resolve } = Promise.withResolvers<QuiesceCloneRequestResult>();
	let done = false;
	const settle = (result: QuiesceCloneRequestResult): void => {
		if (done) return;
		done = true;
		resolve(result);
	};
	const unsubscribeEnvelope = transport.onDaemonEnvelope(workspaceId, (envelope) => {
		if (envelope.workspaceId !== workspaceId || envelope.generation !== generation) return;
		if (envelope.streamId !== CALLBACK_TRANSPORT_STREAM_ID) return;
		const raw = envelope.payload;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
		const payload = raw as Record<string, unknown>;
		if (envelope.kind === "control") {
			if (payload.type !== QUIESCE_RESULT_TYPE) return;
			if (payload.requestId !== requestId || payload.correlationId !== correlationId) return;
			if (payload.ok === true) {
				settle({ ok: true, requestId, correlationId });
				return;
			}
			const error = controlError(payload);
			settle({
				ok: false,
				code: error?.code ?? "provider_failed",
				message: error?.message ?? `daemon rejected quiesce_clone ${requestId}`,
			});
			return;
		}
		if (envelope.kind !== "ack") return;
		if (payload.type !== QUIESCE_REQUEST_TYPE) return;
		if (payload.requestId !== requestId) return;
		if (payload.ok === true) return; // Receipt only; the result control is authoritative.
		const error = controlError(payload);
		settle({
			ok: false,
			code: error?.code ?? "provider_failed",
			message: error?.message ?? `daemon rejected quiesce_clone ${requestId}`,
		});
	});
	const unsubscribePair = transport.onPairChange(workspaceId, (status) => {
		if (status.paired) return;
		settle({
			ok: false,
			code: "unavailable",
			message: `the callback pair for ${workspaceId} dropped while awaiting the quiesce receipt`,
		});
	});
	const timer = setTimeout(() => {
		settle({
			ok: false,
			code: "retryable",
			message: `quiesce_clone ${requestId} was not acknowledged within ${timeoutMs} ms`,
		});
	}, timeoutMs);
	try {
		await transport.sendToDaemon(workspaceId, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: {
				type: QUIESCE_REQUEST_TYPE,
				requestId,
				correlationId,
				sourceRemote: source.remote,
				pinnedRevision: source.revision,
				branch: source.branch,
			} satisfies QuiesceCloneControl,
		});
	} catch (error) {
		settle({
			ok: false,
			code: "unavailable",
			message: `cannot send quiesce_clone to ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	try {
		return await settled;
	} finally {
		clearTimeout(timer);
		unsubscribeEnvelope();
		unsubscribePair();
	}
}

// ---------------------------------------------------------------------------
// Evidence capture
// ---------------------------------------------------------------------------

export type QuiesceEvidenceCollectResult =
	| { ok: true; evidence: QuiesceEvidence }
	| { ok: false; code: CallbackErrorCode; message: string };

export interface QuiesceEvidenceCollectInput {
	transport: DaemonTransportRegistry;
	workspaceId: string;
	/** The request the evidence must be bound to (checked against its requestId). */
	requestId: string;
	/** The open capture correlation created with `createBulkCorrelation(workspaceId, { capture: true })`. */
	capture: BulkCorrelation;
	/** Defaults to {@link QUIESCE_EVIDENCE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Await the daemon's bulk evidence upload on a capture correlation, parse it
 * with `parseQuiesceEvidence`, and bind it to `requestId`.
 *
 * The correlation is released through `cancelBulkCorrelation` on EVERY path
 * (success included: the bytes are already in hand, and the correlation is
 * single-use), so a timed-out or failed upload never leaves the capture
 * buffered. A timeout reports `retryable`, a transport-level failure
 * `unavailable`, and malformed or mismatched evidence `invalid_request`
 * (parse) / `conflict` (request id).
 */
export async function collectQuiesceEvidence(
	input: QuiesceEvidenceCollectInput,
): Promise<QuiesceEvidenceCollectResult> {
	const { transport, requestId, capture } = input;
	const correlationId = capture.correlationId;
	const timeoutMs = input.timeoutMs ?? QUIESCE_EVIDENCE_TIMEOUT_MS;
	const { promise: timedOut, resolve: onTimeout } = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => onTimeout("timeout"), timeoutMs);
	let result: BulkResult | "timeout";
	try {
		result = await Promise.race([capture.done, timedOut]);
	} finally {
		clearTimeout(timer);
		transport.cancelBulkCorrelation(correlationId);
	}
	if (result === "timeout") {
		return {
			ok: false,
			code: "retryable",
			message: `evidence upload ${correlationId} did not complete within ${timeoutMs} ms`,
		};
	}
	if (result.state !== "received" || result.data === undefined) {
		return {
			ok: false,
			code: "unavailable",
			message: `evidence upload ${correlationId} failed: ${result.error ?? "transfer aborted"}`,
		};
	}
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(result.data);
	} catch {
		return {
			ok: false,
			code: "invalid_request",
			message: `evidence upload ${correlationId} is not valid UTF-8`,
		};
	}
	let evidence: QuiesceEvidence;
	try {
		evidence = parseQuiesceEvidence(raw);
	} catch (error) {
		return {
			ok: false,
			code: isCallbackError(error) ? error.code : "invalid_request",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (evidence.requestId !== requestId) {
		return {
			ok: false,
			code: "conflict",
			message: `evidence requestId ${evidence.requestId} does not match the quiesce request ${requestId}`,
		};
	}
	return { ok: true, evidence };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type QuiesceCloneOutcome =
	| { ok: true; requestId: string; correlationId: string; evidence: QuiesceEvidence }
	| {
			ok: false;
			stage: "request" | "evidence";
			code: CallbackErrorCode;
			message: string;
			requestId: string;
			/** Empty when the request was rejected before a capture correlation was opened. */
			correlationId: string;
	  };

export interface QuiesceCloneInput {
	transport: DaemonTransportRegistry;
	workspaceId: string;
	generation: number;
	source: QuiesceCloneSource;
	/**
	 * The exact id a previous attempt persisted, so a retry replays the
	 * daemon's cached quiesce outcome instead of collecting a new one.
	 * Generated when absent; a supplied value must be non-empty and at most
	 * {@link QUIESCE_REQUEST_ID_MAX_CHARS} characters.
	 */
	requestId?: string;
	/** Bound on the control round trip; defaults to {@link QUIESCE_CLONE_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Bound on the evidence upload; defaults to {@link QUIESCE_EVIDENCE_TIMEOUT_MS}. */
	evidenceTimeoutMs?: number;
}

/**
 * One full handshake: open the capture correlation, send `quiesce_clone` with
 * its id, await the receipt, then await and parse the evidence upload.
 *
 * The correlation is created BEFORE the control so the daemon can never
 * upload to an unregistered id, and it is released on every failure path
 * (including a request timeout, where the daemon may still be quiescing).
 *
 * `input.requestId` is used verbatim when supplied (the retry-replay key) and
 * minted otherwise. A supplied id outside the usable shape is refused typed
 * before the correlation, the pair, or the daemon is touched.
 */
export async function quiesceClone(input: QuiesceCloneInput): Promise<QuiesceCloneOutcome> {
	const supplied = input.requestId;
	if (
		supplied !== undefined &&
		(supplied.length === 0 || supplied.length > QUIESCE_REQUEST_ID_MAX_CHARS)
	) {
		return {
			ok: false,
			stage: "request",
			code: "invalid_request",
			message: `quiesce_clone requestId must be a non-empty string of at most ${QUIESCE_REQUEST_ID_MAX_CHARS} characters, got ${supplied.length}`,
			requestId: supplied,
			correlationId: "",
		};
	}
	const requestId = supplied ?? randomUUID();
	const capture = input.transport.createBulkCorrelation(input.workspaceId, { capture: true });
	const correlationId = capture.correlationId;
	const result = await requestQuiesceClone({
		transport: input.transport,
		workspaceId: input.workspaceId,
		generation: input.generation,
		requestId,
		correlationId,
		source: input.source,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	});
	if (!result.ok) {
		input.transport.cancelBulkCorrelation(correlationId);
		return {
			ok: false,
			stage: "request",
			code: result.code,
			message: result.message,
			requestId,
			correlationId,
		};
	}
	const collected = await collectQuiesceEvidence({
		transport: input.transport,
		workspaceId: input.workspaceId,
		requestId,
		capture,
		...(input.evidenceTimeoutMs !== undefined ? { timeoutMs: input.evidenceTimeoutMs } : {}),
	});
	if (!collected.ok) {
		return {
			ok: false,
			stage: "evidence",
			code: collected.code,
			message: collected.message,
			requestId,
			correlationId,
		};
	}
	return { ok: true, requestId, correlationId, evidence: collected.evidence };
}

// ---------------------------------------------------------------------------
// Collector return
// ---------------------------------------------------------------------------

/** A collected quiesce: the request identity, the raw evidence document, and
 * the store-verified receipt to persist before invoking provider stop. */
export interface CloneQuiesceReceipt {
	requestId: string;
	evidence: QuiesceEvidence;
	correlationId: string;
	receipt: ValidatedQuiesceReceipt;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface CloneQuiesceDeps {
	transport: DaemonTransportRegistry;
	/** Fleet log store; null means nothing can be verified (collect reports unavailable). */
	logStore: FleetLogStore | null;
	/** Fleet event ring for quiesce failures (optional). */
	eventLog?: FleetEventLog;
}

/**
 * Fleet-side collector injected into the lifecycle as
 * `WorkspaceLifecycleDeps.collectCloneEvidence`. It composes the handshake and
 * the receipt validation so the delete gate has one call: request, timeout,
 * capture, store + boundary + binding validation. Failures throw
 * {@link CloneQuiesceError} carrying the frozen ledger code.
 */
export class CloneQuiesce {
	readonly #deps: CloneQuiesceDeps;

	constructor(deps: CloneQuiesceDeps) {
		this.#deps = deps;
	}

	async collect(request: CloneQuiesceRequest): Promise<CloneQuiesceReceipt> {
		// Fast fail before anything is asked of the daemon: a request whose
		// binding cannot be validated would waste a quiesce and then be
		// rejected anyway.
		const binding = request.binding;
		if (
			binding === undefined ||
			!RESOURCE_IDENTITY_RE.test(binding.resourceIdentity) ||
			binding.namespaceUid !== request.namespaceUid
		) {
			throw new CloneQuiesceError(
				"invalid_request",
				`the quiesce request for ${request.workspaceId} is missing a usable Kubernetes resource binding (resourceIdentity and a matching namespaceUid are required)`,
				"validation",
			);
		}
		const outcome = await quiesceClone({
			transport: this.#deps.transport,
			workspaceId: request.workspaceId,
			generation: request.generation,
			source: {
				remote: request.sourceRemote,
				revision: request.pinnedRevision,
				branch: request.branch,
			},
			...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
		});
		if (!outcome.ok) {
			this.#deps.eventLog?.add(
				"warn",
				"server",
				`clone quiesce: final evidence for ${request.workspaceId} failed during the ${outcome.stage} stage (${outcome.code}): ${outcome.message}`,
				request.workspaceId,
			);
			throw new CloneQuiesceError(outcome.code, outcome.message, outcome.stage);
		}
		const store = this.#deps.logStore;
		if (store === null) {
			// quiesceClone already released the capture on the success path
			// (collectQuiesceEvidence releases in its finally).
			throw new CloneQuiesceError(
				"unavailable",
				`the fleet log store is unavailable; the receipt for ${request.workspaceId} cannot be verified`,
				"validation",
			);
		}
		const validated = await validateQuiesceReceipt({
			evidence: outcome.evidence,
			requestId: outcome.requestId,
			correlationId: outcome.correlationId,
			request,
			store,
		});
		if (!validated.ok) {
			this.#deps.eventLog?.add(
				"warn",
				"server",
				`clone quiesce: receipt for ${request.workspaceId} was rejected (${validated.code}): ${validated.message}`,
				request.workspaceId,
			);
			throw new CloneQuiesceError(validated.code, validated.message, "validation");
		}
		return {
			requestId: outcome.requestId,
			evidence: outcome.evidence,
			correlationId: outcome.correlationId,
			receipt: validated.receipt,
		};
	}
}
