import { createHash, randomUUID } from "node:crypto";
import {
	CALLBACK_ERROR_CODES,
	CALLBACK_TRANSPORT_STREAM_ID,
	isCallbackError,
	parseQuiesceEvidence,
	type CallbackErrorCode,
	type CloneGitEvidence,
	type FlushBoundary,
	type QuiesceCloneControl,
	type QuiesceEvidence,
} from "../shared/callback-protocol";
import { canonicalJson, type ArchiveManifest, type ManifestFile } from "../shared/archive-manifest";
import {
	RESOURCE_IDENTITY_RE,
	computeSourcePinDigest,
	type KubernetesBinding,
} from "../shared/provider-protocol";
import { verifyWorkspaceLogs } from "../runtime/verify-store";
import type { LineageVerification } from "../server/daemon-control";
import type { BulkCorrelation, BulkResult, DaemonTransportRegistry } from "./daemon-transport";
import type { FleetEventLog } from "./events";
import type { FleetLogStore, StoredStreamEvidence } from "./log-store";

/**
 * Fleet-side owner of the `quiesce_clone` handshake (KUBERNETES_WORKER_
 * LIFECYCLE_PLAN.md stage 3.1/3.3/3.6): the request, its timeout, and the
 * receipt validation. Nothing quiesce-related is re-implemented here: the
 * daemon half (server/daemon-control.ts `createDaemonControl`) does the
 * writer flush, dispose, tailer finalize, structural verification, and Git
 * collection, and answers with a `quiesce_clone_result` control carrying the
 * evidence as a bulk upload. This module only requests that, bounds it, and
 * proves the result against the fleet's own store.
 *
 * Public API (fleet/workspace-lifecycle.ts consumes it through
 * `WorkspaceLifecycleDeps.collectCloneEvidence`; fleet/server.ts constructs
 * {@link CloneQuiesce}):
 *
 *   class CloneQuiesce            constructed from { transport, logStore, eventLog }
 *     .collect(request)           send + wait + capture + validate, one step
 *   requestQuiesceClone(input)    send the control, await the typed receipt (30 s)
 *   collectQuiesceEvidence(input) await the captured upload, parse it (30 s; always
 *                                 releases the capture, including on timeout)
 *   quiesceClone(input)           open capture -> request -> collect, composing both
 *   validateQuiesceReceipt(input) check a parsed receipt against the store + bindings
 *   receiptAllowsDelete(receipt)  the delete-vs-stop decision (clean Git only)
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

/** Largest safe `Date` input (ms); `new Date(x).toISOString()` throws above it. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Narrow an untrusted wire code onto the frozen ledger vocabulary. */
function ledgerCode(value: unknown): CallbackErrorCode {
	return typeof value === "string" && (CALLBACK_ERROR_CODES as readonly string[]).includes(value)
		? (value as CallbackErrorCode)
		: "provider_failed";
}

/**
 * Split a tailer stream id `logs/<sessionId>/<relpath>` into its store key.
 * Mirrors the fleet log tap exactly (fleet/server.ts #onLogEnvelope: the
 * session id is one slash-free segment, the relpath is everything after the
 * first slash); anything else is null.
 */
function parseLogStreamId(streamId: string): { sessionId: string; relpath: string } | null {
	const prefix = "logs/";
	if (!streamId.startsWith(prefix)) return null;
	const rest = streamId.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const sessionId = rest.slice(0, slash);
	const relpath = rest.slice(slash + 1);
	if (relpath.length === 0) return null;
	return { sessionId, relpath };
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

export type QuiesceCloneAckResult =
	| { ok: true; requestId: string; correlationId: string }
	| { ok: false; code: CallbackErrorCode; message: string };

export interface QuiesceCloneAckInput {
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
 * `timeoutMs` (default 30 s) for the daemon's matching receipt.
 *
 * Settles on the FIRST of:
 *  - `kind:"control"` / `quiesce_clone_result` with our requestId and
 *    correlationId (ok:true, or ok:false with the daemon's typed error);
 *  - `kind:"ack"` carrying our control identity with ok:false (the control
 *    itself was rejected, so no result is coming);
 *  - the callback pair dropping (`paired:false`) or `sendToDaemon` failing
 *    (`unavailable`);
 *  - the timeout (`retryable`).
 *
 * Envelopes from another generation, stream, request, or correlation are
 * ignored. The caller owns the capture correlation: on failure it MUST
 * release it with `cancelBulkCorrelation` (quiesceClone does so).
 */
export async function requestQuiesceClone(
	input: QuiesceCloneAckInput,
): Promise<QuiesceCloneAckResult> {
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
	const { promise: settled, resolve } = Promise.withResolvers<QuiesceCloneAckResult>();
	let done = false;
	const settle = (result: QuiesceCloneAckResult): void => {
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
			const rawError = payload.error;
			const error =
				typeof rawError === "object" && rawError !== null && !Array.isArray(rawError)
					? (rawError as Record<string, unknown>)
					: null;
			settle({
				ok: false,
				code: error === null ? "provider_failed" : ledgerCode(error.code),
				message:
					error !== null && typeof error.message === "string"
						? error.message
						: `daemon rejected quiesce_clone ${requestId}`,
			});
			return;
		}
		if (envelope.kind !== "ack") return;
		if (payload.type !== QUIESCE_REQUEST_TYPE) return;
		if (payload.requestId !== requestId) return;
		if (payload.ok === true) return; // Receipt only; the result control is authoritative.
		settle({
			ok: false,
			code: ledgerCode(payload.code),
			message:
				typeof payload.message === "string"
					? payload.message
					: `daemon rejected quiesce_clone ${requestId}`,
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
	const ack = await requestQuiesceClone({
		transport: input.transport,
		workspaceId: input.workspaceId,
		generation: input.generation,
		requestId,
		correlationId,
		source: input.source,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	});
	if (!ack.ok) {
		input.transport.cancelBulkCorrelation(correlationId);
		return {
			ok: false,
			stage: "request",
			code: ack.code,
			message: ack.message,
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
// Receipt validation
// ---------------------------------------------------------------------------

/** Fleet-side view of one quiesce request; the shapes Main froze for the
 * collector, plus the additive binding/provenance fields validation needs. */
export interface CloneQuiesceRequest {
	workspaceId: string;
	generation: number;
	podUid: string | null;
	pvcUid: string | null;
	namespaceUid: string;
	sourceRemote: string;
	pinnedRevision: string;
	branch: string;
	/**
	 * Kubernetes resource binding (shared/provider-protocol.ts KubernetesBinding),
	 * i.e. the record's persisted `kubernetes`. REQUIRED at runtime: the receipt
	 * is bound to its resourceIdentity, context, and namespace.
	 */
	binding?: KubernetesBinding;
	/** Registry project id for the receipt manifest provenance; falls back to workspaceId. */
	projectId?: string;
	/**
	 * The exact requestId a previous attempt persisted for this workspace, so
	 * a retry replays the daemon's cached quiesce outcome. Generated when
	 * absent; a malformed value fails typed before any daemon work.
	 */
	requestId?: string;
	/** Roster workspace name for the receipt manifest provenance; falls back to workspaceId. */
	workspaceName?: string;
	/** Main transcript relpaths the workspace volume holds. Omit when the volume is not fleet-readable. */
	volumeMainRelpaths?: readonly string[];
}

/**
 * A validated quiesce receipt: the evidence plus the identity it is bound to.
 * Persist this (or its digest) before provider stop so a later attempt can
 * compare a fresh observation against the same Pod/PVC/namespace facts.
 */
export interface ValidatedQuiesceReceipt {
	requestId: string;
	correlationId: string;
	workspaceId: string;
	generation: number;
	resourceIdentity: string;
	namespaceUid: string;
	podUid: string | null;
	pvcUid: string | null;
	source: QuiesceCloneSource;
	/** `computeSourcePinDigest(source)`: compare against the record's persisted digest. */
	sourcePinDigest: string;
	resolvedCommit: string;
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	/** The evidence manifest, proven byte-equal (size/sha256/kind/sessionId/parentPath) to the store. */
	manifestFiles: ManifestFile[];
	/**
	 * Daemon provenance. This is the same shape `createDaemonControl`'s quiesce
	 * path emits (server/daemon-control.ts LineageVerification), reused rather
	 * than redeclared.
	 */
	provenance: LineageVerification["provenance"];
	writers: QuiesceEvidence["writers"];
	git: CloneGitEvidence;
	/** sha256 (lowercase hex) of the canonical evidence document; identifies this receipt. */
	digest: string;
	verifiedAt: number;
}

export interface CloneQuiesceReceipt {
	requestId: string;
	evidence: QuiesceEvidence;
	correlationId: string;
	/** The store-verified receipt to persist before invoking provider stop. */
	receipt: ValidatedQuiesceReceipt;
}

export interface QuiesceReceiptInput {
	/** The parsed evidence document (collectQuiesceEvidence output). */
	evidence: QuiesceEvidence;
	requestId: string;
	correlationId: string;
	request: CloneQuiesceRequest;
	store: FleetLogStore;
}

export type QuiesceReceiptResult =
	| { ok: true; receipt: ValidatedQuiesceReceipt }
	| { ok: false; code: CallbackErrorCode; message: string; path?: string };

/**
 * Writer census check. `parseQuiesceEvidence` only proves the field is an
 * array, so every descendant entry is shape-checked here, along with the two
 * invariants the store can corroborate: advisors must have been caught up
 * when the store holds advisor transcripts, and writer ids must be unique (a
 * repeated id is a corrupted census, not a real double).
 */
function checkWriterEvidence(
	writers: QuiesceEvidence["writers"],
	manifestFiles: readonly ManifestFile[],
): { ok: true } | { ok: false; message: string } {
	if (writers.main !== "flushed") {
		return { ok: false, message: `writers.main must be "flushed", got ${String(writers.main)}` };
	}
	if (writers.advisors !== "caught_up" && writers.advisors !== "inactive") {
		return {
			ok: false,
			message: `writers.advisors must be "caught_up" or "inactive", got ${String(writers.advisors)}`,
		};
	}
	const rawEntries: readonly unknown[] = writers.descendants;
	const ids = new Set<string>();
	for (let index = 0; index < rawEntries.length; index++) {
		const raw = rawEntries[index];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { ok: false, message: `writers.descendants[${index}] must be an object` };
		}
		const entry = raw as Record<string, unknown>;
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			return { ok: false, message: `writers.descendants[${index}].id is missing` };
		}
		if (entry.kind !== "main" && entry.kind !== "sub" && entry.kind !== "advisor") {
			return {
				ok: false,
				message: `writers.descendants[${index}].kind must be "main", "sub", or "advisor"`,
			};
		}
		if (entry.sessionFile !== null && typeof entry.sessionFile !== "string") {
			return {
				ok: false,
				message: `writers.descendants[${index}].sessionFile must be null or a string`,
			};
		}
		if (entry.state !== "flushed" && entry.state !== "parked" && entry.state !== "disposed") {
			return {
				ok: false,
				message: `writers.descendants[${index}].state must be "flushed", "parked", or "disposed"`,
			};
		}
		if (ids.has(entry.id)) {
			return { ok: false, message: `writers.descendants repeats writer id ${entry.id}` };
		}
		ids.add(entry.id);
	}
	const advisorFiles = manifestFiles.filter((file) => file.kind === "advisor");
	if (advisorFiles.length > 0 && writers.advisors === "inactive") {
		return {
			ok: false,
			message: `the store holds ${advisorFiles.length} advisor transcript(s) but writers.advisors is "inactive"`,
		};
	}
	return { ok: true };
}

/**
 * Validate a parsed receipt against the fleet's own state (plan stage 3.6):
 *
 *  - the exact store file set, with hashes, sizes, kinds, session ids, and
 *    parent paths, proven by `verifyWorkspaceLogs` with the evidence manifest
 *    as the expected one (which also re-runs offset-contiguity and structural
 *    JSONL verification);
 *  - every per-stream generation/offset/eof: the evidence's FlushBoundary and
 *    the store's indices must name exactly the same `logs/<sessionId>/<relpath>`
 *    streams at the same generation, durable offset, and eof (the fleet log
 *    tap's mapping, and the store's own covered set, both checked);
 *  - the writer census (see checkWriterEvidence);
 *  - `mainSessionRelpath` identifies exactly one manifest entry, or is null
 *    only when neither the store nor (when supplied) the workspace volume
 *    holds a main transcript;
 *  - the receipt binds to the workspace resource identity, generation,
 *    namespace UID, PVC UID, the supplied source tuple, and the resolved pin.
 */
export async function validateQuiesceReceipt(
	input: QuiesceReceiptInput,
): Promise<QuiesceReceiptResult> {
	const { evidence, request, store } = input;
	const fail = (code: CallbackErrorCode, message: string, path?: string): QuiesceReceiptResult =>
		path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };

	const binding = request.binding;
	if (binding === undefined) {
		return fail(
			"invalid_request",
			`quiesce receipt for ${request.workspaceId} requires the Kubernetes resource binding`,
		);
	}
	if (!RESOURCE_IDENTITY_RE.test(binding.resourceIdentity)) {
		return fail(
			"invalid_request",
			`resourceIdentity must be 32 lowercase hex characters, got ${binding.resourceIdentity}`,
		);
	}
	if (binding.context.length === 0 || binding.namespace.length === 0) {
		return fail("invalid_request", "the Kubernetes binding is missing its context or namespace");
	}
	if (binding.namespaceUid !== request.namespaceUid) {
		return fail(
			"conflict",
			`binding namespace UID ${binding.namespaceUid} does not match the request's ${request.namespaceUid}`,
		);
	}
	if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
		return fail(
			"invalid_request",
			`generation must be a positive integer, got ${request.generation}`,
		);
	}
	if (evidence.requestId !== input.requestId) {
		return fail(
			"conflict",
			`evidence requestId ${evidence.requestId} does not match the quiesce request ${input.requestId}`,
		);
	}
	if (evidence.provenance.workspaceId !== request.workspaceId) {
		return fail(
			"conflict",
			`evidence targets workspace ${evidence.provenance.workspaceId}, not ${request.workspaceId}`,
		);
	}
	if (evidence.provenance.resolvedCommit !== request.pinnedRevision) {
		return fail(
			"conflict",
			`evidence resolves commit ${evidence.provenance.resolvedCommit} but the workspace is pinned at ${request.pinnedRevision}`,
		);
	}
	const generatedAt = evidence.provenance.generatedAt;
	if (!Number.isFinite(generatedAt) || generatedAt < 0 || generatedAt > MAX_DATE_MS) {
		return fail(
			"invalid_request",
			`evidence provenance.generatedAt is not a usable epoch-ms value: ${String(generatedAt)}`,
		);
	}

	const writers = checkWriterEvidence(evidence.writers, evidence.manifestFiles);
	if (!writers.ok) return fail("conflict", `writer evidence is invalid: ${writers.message}`);

	const streams = store.storedStreamEvidence(request.workspaceId);
	const streamById = new Map<string, StoredStreamEvidence>(
		streams.map((stream) => [stream.streamId, stream]),
	);
	const boundary: FlushBoundary = evidence.boundary;
	const manifestKeys = new Set(
		evidence.manifestFiles.map((file) => `${file.sessionId}/${file.path}`),
	);

	// Exact store bytes: every declared file present with equal size/sha256/
	// kind/sessionId/parentPath, and no store file outside the declared set.
	const expectedManifest: ArchiveManifest = {
		provenance: {
			projectId: request.projectId ?? request.workspaceId,
			workspaceId: request.workspaceId,
			workspaceName: request.workspaceName ?? request.workspaceId,
			source: { remote: request.sourceRemote },
			resolvedCommit: request.pinnedRevision,
			generatedAt: new Date(generatedAt).toISOString(),
		},
		files: evidence.manifestFiles,
	};
	let verify;
	try {
		verify = await verifyWorkspaceLogs({
			logsRoot: store.rootDir,
			workspaceId: request.workspaceId,
			expectedManifest,
		});
	} catch (error) {
		return fail(
			"unavailable",
			`cannot verify the fleet store for ${request.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!verify.ok) {
		return fail(
			verify.code === "conflict" ? "archive_conflict" : verify.code,
			`the fleet store does not match the receipt for ${request.workspaceId}: ${verify.message}`,
			verify.path,
		);
	}
	if (verify.manifest === undefined) {
		// No logs/<workspaceId> subtree exists at all: verifyWorkspaceLogs has
		// nothing to compare against, so the receipt must declare nothing.
		if (
			evidence.manifestFiles.length > 0 ||
			Object.keys(boundary).length > 0 ||
			streams.length > 0
		) {
			return fail(
				"archive_conflict",
				`the fleet store holds no subtree for ${request.workspaceId} but the receipt declares ${evidence.manifestFiles.length} file(s)`,
			);
		}
	}

	// Per-stream generation/offset/eof: the boundary and the store must name
	// exactly the same streams, and every boundary stream must be a manifest
	// entry under the fleet log tap's `logs/<sessionId>/<relpath>` mapping.
	for (const streamId of Object.keys(boundary)) {
		const parsed = parseLogStreamId(streamId);
		if (parsed === null) {
			return fail(
				"conflict",
				`the boundary names a malformed log stream id: ${streamId}`,
				streamId,
			);
		}
		const stored = streamById.get(streamId);
		if (stored === undefined) {
			return fail("conflict", `boundary stream ${streamId} is not in the fleet store`, streamId);
		}
		const entry = boundary[streamId];
		if (stored.generation !== entry.generation) {
			return fail(
				"conflict",
				`store generation for ${streamId} is ${stored.generation}, the boundary says ${entry.generation}`,
				streamId,
			);
		}
		if (stored.ackedBytes !== entry.offset) {
			return fail(
				"conflict",
				`store durable offset for ${streamId} is ${stored.ackedBytes}, the boundary says ${entry.offset}`,
				streamId,
			);
		}
		if (!stored.eof) {
			return fail("conflict", `store stream ${streamId} has no final eof marker`, streamId);
		}
		if (!manifestKeys.has(`${parsed.sessionId}/${parsed.relpath}`)) {
			return fail("conflict", `boundary stream ${streamId} has no manifest entry`, streamId);
		}
	}
	for (const stream of streams) {
		if (!(stream.streamId in boundary)) {
			return fail(
				"conflict",
				`the fleet store holds ${stream.streamId}, which the boundary does not cover`,
				stream.streamId,
			);
		}
		if (!manifestKeys.has(`${stream.sessionId}/${stream.relpath}`)) {
			return fail(
				"conflict",
				`stored stream ${stream.streamId} has no manifest entry`,
				stream.streamId,
			);
		}
	}

	// The main transcript, or a justified null (nothing anywhere).
	const mainRelpath = evidence.mainSessionRelpath;
	if (mainRelpath !== null) {
		const matches = evidence.manifestFiles.filter((file) => file.path === mainRelpath);
		if (matches.length !== 1) {
			return fail(
				"conflict",
				`mainSessionRelpath ${mainRelpath} identifies ${matches.length} manifest entries; expected exactly one`,
			);
		}
		if (matches[0].kind !== "main") {
			return fail(
				"conflict",
				`mainSessionRelpath ${mainRelpath} names a ${matches[0].kind} file, not a main transcript`,
			);
		}
	} else {
		const storedMain = evidence.manifestFiles.find((file) => file.kind === "main");
		if (storedMain !== undefined) {
			return fail(
				"conflict",
				`the receipt declares no main transcript but the store holds ${storedMain.path}`,
			);
		}
		const volumeMains = request.volumeMainRelpaths;
		if (volumeMains !== undefined && volumeMains.length > 0) {
			return fail(
				"conflict",
				`the receipt declares no main transcript but the workspace volume holds ${volumeMains.length} main transcript(s)`,
			);
		}
	}

	// Git evidence is bound to the supplied source; a clean or dirty checkout
	// must still report that remote. "unknown" is accepted here (it blocks
	// deletion through receiptAllowsDelete, but the receipt is still recorded).
	const git = evidence.git;
	if (git.status !== "clean" && git.status !== "dirty" && git.status !== "unknown") {
		return fail("invalid_request", `git.status is invalid: ${String(git.status)}`);
	}
	if (git.status !== "unknown") {
		if (git.remote === undefined || git.remote === null) {
			return fail(
				"conflict",
				`git evidence reports no configured remote; the workspace source is ${request.sourceRemote}`,
			);
		}
		if (git.remote.url !== request.sourceRemote) {
			return fail(
				"conflict",
				`git evidence remote ${git.remote.url} does not match the workspace source ${request.sourceRemote}`,
			);
		}
	}

	const source: QuiesceCloneSource = {
		remote: request.sourceRemote,
		revision: request.pinnedRevision,
		branch: request.branch,
	};
	const receipt: ValidatedQuiesceReceipt = {
		requestId: evidence.requestId,
		correlationId: input.correlationId,
		workspaceId: request.workspaceId,
		generation: request.generation,
		resourceIdentity: binding.resourceIdentity,
		namespaceUid: request.namespaceUid,
		podUid: request.podUid,
		pvcUid: request.pvcUid,
		source,
		sourcePinDigest: computeSourcePinDigest(source.remote, source.revision, source.branch),
		resolvedCommit: evidence.provenance.resolvedCommit,
		mainSessionRelpath: mainRelpath,
		boundary,
		manifestFiles: evidence.manifestFiles,
		provenance: evidence.provenance,
		writers: evidence.writers,
		git,
		digest: createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
		verifiedAt: Date.now(),
	};
	return { ok: true, receipt };
}

/**
 * Delete-vs-stop decision over a validated receipt (plan stage 3.6): deletion
 * requires clean Git evidence (no dirt, no stashes, every local ref preserved
 * on the remote) on top of the verified store. Anything else keeps the
 * receipt for the ordinary stop path, which retains storage.
 */
export function receiptAllowsDelete(
	receipt: ValidatedQuiesceReceipt,
): { ok: true } | { ok: false; code: CallbackErrorCode; reason: string } {
	const git = receipt.git;
	if (git.status === "unknown") {
		return {
			ok: false,
			code: "archive_conflict",
			reason: `git evidence is unknown (${git.unknownReason ?? "no reason given"}); deletion is blocked`,
		};
	}
	if (git.status === "dirty") {
		const dirty = git.dirty;
		const counts =
			dirty === undefined
				? "uncommitted changes"
				: `${dirty.added} added, ${dirty.modified} modified, ${dirty.deleted} deleted, ${dirty.untracked} untracked`;
		return {
			ok: false,
			code: "conflict",
			reason: `the checkout is dirty (${counts}); stop preserves the PVC, deletion does not`,
		};
	}
	if ((git.stashes ?? 0) > 0) {
		return {
			ok: false,
			code: "conflict",
			reason: `the checkout holds ${git.stashes} stash(es)`,
		};
	}
	const unpreserved = (git.refs ?? []).filter((ref) => !ref.preserved);
	if (unpreserved.length > 0) {
		return {
			ok: false,
			code: "conflict",
			reason: `${unpreserved.length} local ref(s) are not preserved on the remote: ${unpreserved
				.slice(0, 5)
				.map((ref) => ref.name)
				.join(", ")}`,
		};
	}
	return { ok: true };
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
			// quiesceClone already released the capture; keep the release explicit.
			this.#deps.transport.cancelBulkCorrelation(outcome.correlationId);
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
