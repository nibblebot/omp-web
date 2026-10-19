import {
	SSE_BACKPRESSURE_BYTES,
	SSE_KEEPALIVE_MS,
	SSE_RING_CAP,
	SSE_SILENCE_DEADLINE_MS,
} from "./protocol";
import { encodeSseEvent, parseSseUnits, SSE_PING_EVENT } from "./sse";

/**
 * Callback transport protocol (OMP_CALLBACK_PROTO = 1), separately versioned
 * from OMP_PROTO. Encoding, parsing, and policy frozen by
 * docs/clone-contracts.md ("Callback transport" and "Typed errors").
 *
 * Pure module: no I/O, no ambient state beyond the explicit parser/dedup
 * objects this file creates. Shared by the fleet (server routes, edge) and
 * the daemon's callback client.
 *
 * Up:   daemon-initiated long-lived POST /callback/up, body
 *       application/x-ndjson UTF-8 envelopes, one record <= 1 MiB,
 *       incremental parsing, HTTP chunk boundaries are not message
 *       boundaries.
 * Down: daemon-initiated long-lived GET /callback/down, SSE response,
 *       same envelope version, Last-Event-ID resume.
 * Bulk: daemon-initiated POST /callback/bulk/<correlationId>, 64 MiB cap;
 *       completion is never archive acceptance.
 *
 * An HTTP 200 on the POST is transport receipt only; an `ack` envelope
 * confirms command receipt at the daemon boundary; neither is command
 * execution acceptance (that remains the daemon's 202/call_result
 * semantics).
 */

/** Callback protocol version. */
export const OMP_CALLBACK_PROTO = 1;

/** Fleet route shapes for the three callback legs. */
export const CALLBACK_UP_PATH = "/callback/up";
export const CALLBACK_DOWN_PATH = "/callback/down";
export const CALLBACK_BULK_PATH_PREFIX = "/callback/bulk/";
/**
 * Reserved control-plane wire literals both halves must agree on
 * byte-for-byte; carried here so neither lane invents a variant:
 *
 * - CALLBACK_TRANSPORT_STREAM_ID: streamId the fleet uses for its own
 *   envelopes (pair_ready, heartbeats); rides the replay ring so a resuming
 *   redial re-delivers them.
 * - CALLBACK_CONTROL_STREAM_ID: streamId the daemon uses for its transport
 *   heartbeats on the up stream.
 * - CALLBACK_PAIR_READY_TYPE: payload.type of the single control envelope
 *   the fleet emits once both halves of a connectionId are live; payload is
 *   {type, connectionId, generation}, idempotent by connectionId.
 */
export const CALLBACK_TRANSPORT_STREAM_ID = "transport";
export const CALLBACK_CONTROL_STREAM_ID = "control";
export const CALLBACK_PAIR_READY_TYPE = "pair_ready";

/** streamId prefix of per-browser virtual streams: `browser/<connId>`. */
export const CALLBACK_BROWSER_STREAM_PREFIX = "browser/";
/**
 * Bulk multi-part upload headers (daemon → fleet, POST /callback/bulk/<id>).
 * Parts are 0-based, strictly sequential, no gaps/overlaps; the final part
 * carries BULK_FINAL_HEADER: 1. The AGGREGATE across all parts stays capped
 * at BULK_MAX_BYTES (64 MiB); multi-part exists so neither side buffers the
 * whole body at once, never to raise the ceiling. A failed/aborted/expired
 * part fails the whole correlation.
 */
export const BULK_PART_HEADER = "x-omp-bulk-part";
export const BULK_FINAL_HEADER = "x-omp-bulk-final";

// ---------------------------------------------------------------------------
// Virtual-stream + control-plane payload vocabulary. Every payload below
// rides an existing envelope kind on a reserved or browser stream; no new
// envelope kinds. Frozen with the Transport and Lifecycle lanes (2026-09-06).
// ---------------------------------------------------------------------------

/**
 * daemon→fleet, kind "control", on the affected stream: the daemon could not
 * honor replay (ring underflow, foreign connection, or an outbound buffer
 * drop) and a full re-prime burst follows on that stream. Forward-transparent
 * to the browser.
 */
export interface StreamResyncControl {
	type: "stream_resync";
}

/** daemon→fleet, kind "ack", on the command's own stream: receipt only. */
export interface CommandAckPayload {
	type: "command_ack";
	/** The ClientCommand id received; deduped re-submits are acked, not re-dispatched. */
	id?: string;
}

/**
 * Generic control ack discipline: every control the daemon receives is
 * answered with kind "ack" on the same stream carrying the original control's
 * identity and either ok:true or an explicit typed failure. Nothing is
 * silently discarded.
 */
export interface ControlAckPayload {
	/** The control's {type, requestId?} identity, echoed. */
	type: string;
	requestId?: string;
	ok: boolean;
	error?: { code: CallbackErrorCode; message: string };
}

/**
 * fleet→daemon, kind "command", streamId "control": stream a server-side file
 * to the fleet as multi-part raw bytes under the given bulk correlation. Same
 * realpath jail + authorization rules as the session's canonicalRoots; failures are reported
 * via DownloadBulkFailedControl and the fleet fails the whole correlation.
 */
export interface DownloadBulkCommand {
	type: "download_bulk";
	correlationId: string;
	path: string;
	sessionId?: string;
}

/** daemon→fleet, kind "control", streamId "control": a correlated bulk upload failed mid-transfer. */
export interface DownloadBulkFailedControl {
	type: "download_bulk_failed";
	correlationId: string;
	error: { code: CallbackErrorCode; message: string };
}

/** fleet→daemon, kind "control", streamId "transport": graceful shutdown; the daemon acks, then exits 0. */
export interface ShutdownControl {
	type: "shutdown";
	reason?: string;
}

/** Serialized envelope cap: one NDJSON record / one SSE data payload (1 MiB). */
export const ENVELOPE_MAX_BYTES = 1024 * 1024;
/** Per-connection buffered-envelope cap across all streams (8 MiB). */
export const CONNECTION_MAX_BYTES = 8 * 1024 * 1024;
/** Per-virtual-stream buffered cap (4 MiB); also bounds reassembled chunks. */
export const STREAM_MAX_BYTES = SSE_BACKPRESSURE_BYTES;
/** Replay ring entries kept for Last-Event-ID resume (10k). */
export const REPLAY_RING_ENTRIES = SSE_RING_CAP;
/** Daemon heartbeat cadence on the down stream (15 s). */
export const HEARTBEAT_INTERVAL_MS = SSE_KEEPALIVE_MS;
/** Down-stream silence deadline (30 s): no envelope by then = dead pair. */
export const SILENCE_DEADLINE_MS = SSE_SILENCE_DEADLINE_MS;
/**
 * Up-leg lifetime byte budget (64 MiB). The fleet's Bun.serve counts a
 * streaming request body against `maxRequestBodySize` (default 128 MiB) for
 * the WHOLE life of the POST, so the long-lived /callback/up upload dies
 * (413) once it has carried that many bytes. The daemon renews the pair
 * voluntarily before then; half the platform default leaves headroom.
 */
export const UP_RENEWAL_BYTES = 64 * 1024 * 1024;
/** Wait for the daemon's pair-ready confirmation (60 s). */
export const PAIR_READY_TIMEOUT_MS = 60_000;
/** Wait for a parked/suspended daemon to wake (60 s). */
export const WAKE_TIMEOUT_MS = 60_000;
/** Reconnect backoff ramp, jittered (1 s → 30 s). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** Bulk transfer cap for POST /callback/bulk/<correlationId> (64 MiB). */
export const BULK_MAX_BYTES = 64 * 1024 * 1024;
/** Callback enrollment credential width (256-bit, hashed fleet-side). */
export const ENROLLMENT_KEY_BYTES = 32;

/** Envelope kinds; the event name on the down stream mirrors the kind. */
export const CALLBACK_KINDS = ["frame", "command", "control", "ack", "heartbeat"] as const;
export type CallbackKind = (typeof CALLBACK_KINDS)[number];

/**
 * Typed error vocabulary frozen by the ledger ("Typed errors"). Every
 * protocol-level rejection uses one of these codes; the fleet routes map
 * them to HTTP statuses via CALLBACK_ERROR_HTTP_STATUS.
 */
export const CALLBACK_ERROR_CODES = [
	"invalid_request",
	"invalid_identity",
	"unauthorized",
	"forbidden",
	"unavailable",
	"conflict",
	"generation_obsolete",
	"writer_active",
	"archive_pending",
	"archive_conflict",
	"provider_failed",
	"retryable",
	"payload_too_large",
] as const;
export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

/** HTTP status each ledger error code maps to on the callback routes. */
export const CALLBACK_ERROR_HTTP_STATUS: Record<CallbackErrorCode, number> = {
	invalid_request: 400,
	invalid_identity: 401,
	unauthorized: 401,
	forbidden: 403,
	unavailable: 503,
	conflict: 409,
	generation_obsolete: 409,
	writer_active: 409,
	archive_pending: 409,
	archive_conflict: 409,
	provider_failed: 500,
	retryable: 503,
	payload_too_large: 413,
};

/** True when `value` names a frozen callback error code. */
export function isCallbackErrorCode(value: string): value is CallbackErrorCode {
	return (CALLBACK_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Ledger code a refusal with no typed `error` body stands for, keyed by HTTP
 * status. Shared statuses take the ledger's canonical code; 404/410 predate
 * typed refusals and have no ledger code of their own.
 */
const UNTYPED_REFUSAL_CODE: Record<number, CallbackErrorCode> = {
	400: "invalid_request",
	401: "unauthorized",
	403: "forbidden",
	404: "invalid_identity",
	409: "conflict",
	410: "generation_obsolete",
	429: "retryable",
	503: "unavailable",
};

/** Ledger code for a non-2xx response without a typed body; unknown statuses are retryable. */
export function codeFromHttpStatus(status: number): CallbackErrorCode {
	return UNTYPED_REFUSAL_CODE[status] ?? "retryable";
}

/** Request header a session sets on POST /callback/up when it reassembles chunked commands ("1"). */
export const CALLBACK_CHUNKS_HEADER = "x-omp-callback-chunks";

/** Typed protocol error carrying a ledger error code. */
export class CallbackError extends Error {
	readonly code: CallbackErrorCode;
	readonly detail: string | undefined;

	constructor(
		code: CallbackErrorCode,
		message: string,
		opts?: { detail?: string; cause?: unknown },
	) {
		super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
		this.name = "CallbackError";
		this.code = code;
		this.detail = opts?.detail;
	}
}

/** Typed-error factory over the ledger vocabulary. */
export function callbackError(
	code: CallbackErrorCode,
	message: string,
	opts?: { detail?: string; cause?: unknown },
): CallbackError {
	return new CallbackError(code, message, opts);
}

export function isCallbackError(value: unknown): value is CallbackError {
	return value instanceof CallbackError;
}

/** One callback-transport envelope (ledger "Callback transport"). */
export interface CallbackEnvelope {
	version: typeof OMP_CALLBACK_PROTO;
	workspaceId: string;
	/** authorizedGeneration of the workspace; obsolete generations are rejected fleet-side (`generation_obsolete`). */
	generation: number;
	/** crypto.randomUUID() per callback pair. */
	connectionId: string;
	/** Logical per-browser/control stream within the connection. */
	streamId: string;
	/** Per-connection monotonic; senders assign at emit time. */
	seq: number;
	kind: CallbackKind;
	payload: unknown;
	/** Epoch ms. */
	at: number;
}

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Serialized byte length of a value's canonical JSON form. */
function canonicalBytes(value: unknown): number {
	return utf8.encode(JSON.stringify(value)).length;
}

export interface ValidateEnvelopeOptions {
	/** Serialized-size cap; defaults to ENVELOPE_MAX_BYTES. */
	maxBytes?: number;
}

/**
 * Validate an untrusted value as a callback envelope and return it narrowed.
 * Throws CallbackError("invalid_request") on any violation: required fields,
 * types, safe-integer generation (positive) and seq (non-negative), kind in
 * CALLBACK_KINDS, and a serialized size within `maxBytes`. The size bound
 * applies to the canonical JSON.stringify form (wire forms carrying
 * insignificant whitespace are accepted when their canonical form fits).
 * Unknown extra fields are tolerated; every ledger-named field is enforced.
 */
export function validateEnvelope(value: unknown, opts?: ValidateEnvelopeOptions): CallbackEnvelope {
	const fail = (detail: string): never => {
		throw new CallbackError("invalid_request", `invalid callback envelope: ${detail}`);
	};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail("expected an object");
	const env = value as Record<string, unknown>;
	if (env.version !== OMP_CALLBACK_PROTO) fail(`version must be ${OMP_CALLBACK_PROTO}`);
	if (typeof env.workspaceId !== "string" || env.workspaceId.length === 0)
		fail("workspaceId must be a non-empty string");
	if (typeof env.connectionId !== "string" || env.connectionId.length === 0)
		fail("connectionId must be a non-empty string");
	if (typeof env.streamId !== "string" || env.streamId.length === 0)
		fail("streamId must be a non-empty string");
	if (
		typeof env.generation !== "number" ||
		!Number.isSafeInteger(env.generation) ||
		env.generation < 1
	) {
		fail("generation must be a positive integer");
	}
	if (typeof env.seq !== "number" || !Number.isSafeInteger(env.seq) || env.seq < 0) {
		fail("seq must be a non-negative integer");
	}
	if (typeof env.at !== "number" || !Number.isFinite(env.at) || env.at < 0)
		fail("at must be a finite epoch-ms number");
	if (typeof env.kind !== "string" || !CALLBACK_KINDS.includes(env.kind as CallbackKind)) {
		fail(`kind must be one of ${CALLBACK_KINDS.join("|")}`);
	}
	if (env.payload === undefined) fail("payload is required");
	const maxBytes = opts?.maxBytes ?? ENVELOPE_MAX_BYTES;
	let bytes: number;
	try {
		bytes = canonicalBytes(value);
	} catch (cause) {
		throw new CallbackError(
			"invalid_request",
			"invalid callback envelope: payload is not JSON-serializable",
			{ cause },
		);
	}
	if (bytes > maxBytes)
		fail(`serialized envelope is ${bytes} bytes, over the ${maxBytes}-byte limit`);
	return value as CallbackEnvelope;
}

/** Encode one envelope as a complete NDJSON record (trailing newline included). */
export function encodeNdjsonLine(envelope: CallbackEnvelope): string {
	return `${JSON.stringify(envelope)}\n`;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b.slice();
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** One NDJSON outcome: a complete record, or one bad record dropped (the stream resynchronizes after it). */
export type NdjsonItem = { record: string } | { dropped: CallbackError };

/** Incremental NDJSON parser over raw HTTP chunks. Never throws on a bad record. */
export interface NdjsonParser {
	/** Feed one HTTP chunk; returns every record and dropped record it completes, in stream order. */
	push(chunk: Uint8Array | string): NdjsonItem[];
	/** Flush at end-of-body; a trailing non-blank record without a newline is legal. */
	end(): NdjsonItem[];
	/** Bytes buffered since the last record boundary (bounded by the record cap). */
	readonly bufferedBytes: number;
}

/**
 * Create an incremental NDJSON record parser for POST /callback/up bodies.
 * Bytes accumulate until a newline and only complete records are decoded, so
 * HTTP chunk boundaries are not message boundaries and multi-byte UTF-8
 * sequences split across chunks stay intact (0x0a can never occur inside a
 * UTF-8 multi-byte sequence). A bad record (over `maxRecordBytes`, default
 * ENVELOPE_MAX_BYTES, or invalid UTF-8) is returned as a `dropped` item and
 * the stream resynchronizes at the next newline. An over-cap record is dropped
 * as soon as the cap is crossed; its remaining bytes are discarded unbuffered.
 * Blank lines are skipped; a trailing CR is tolerated.
 */
export function createNdjsonParser(opts?: { maxRecordBytes?: number }): NdjsonParser {
	const maxRecordBytes = opts?.maxRecordBytes ?? ENVELOPE_MAX_BYTES;
	let pending: Uint8Array = new Uint8Array(0);
	// Set once an over-cap record was dropped: its bytes are discarded up to the next newline.
	let discarding = false;

	const overSize = (length: number): CallbackError =>
		new CallbackError(
			"invalid_request",
			`invalid ndjson stream: record is ${length} bytes, over the ${maxRecordBytes}-byte record limit`,
		);

	// Close the buffered record at a newline or end-of-body.
	const closeRecord = (): NdjsonItem | undefined => {
		let line = pending;
		pending = new Uint8Array(0);
		if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		if (line.length === 0) return undefined;
		if (line.length > maxRecordBytes) return { dropped: overSize(line.length) };
		try {
			return { record: utf8Strict.decode(line) };
		} catch (cause) {
			return {
				dropped: new CallbackError(
					"invalid_request",
					"invalid ndjson stream: record is not valid UTF-8",
					{ cause },
				),
			};
		}
	};

	return {
		get bufferedBytes(): number {
			return pending.length;
		},
		push(chunk) {
			const bytes = typeof chunk === "string" ? utf8.encode(chunk) : chunk;
			const out: NdjsonItem[] = [];
			let start = 0;
			for (;;) {
				const nl = bytes.indexOf(0x0a, start);
				if (nl === -1) break;
				if (discarding) {
					discarding = false;
				} else {
					pending = concatBytes(pending, bytes.subarray(start, nl));
					const item = closeRecord();
					if (item !== undefined) out.push(item);
				}
				start = nl + 1;
			}
			if (start < bytes.length && !discarding) {
				pending = concatBytes(pending, bytes.subarray(start));
				if (pending.length > maxRecordBytes) {
					out.push({ dropped: overSize(pending.length) });
					pending = new Uint8Array(0);
					discarding = true;
				}
			}
			return out;
		},
		end() {
			if (discarding) {
				discarding = false;
				return [];
			}
			const item = closeRecord();
			return item === undefined ? [] : [item];
		},
	};
}

/**
 * Encode one envelope as a complete SSE event block on the down stream:
 * event name is the envelope kind, id is the envelope seq (Last-Event-ID
 * resume), data is the canonical JSON. Reuses lib/wire/sse.ts conventions.
 */
export function encodeSseEnvelope(envelope: CallbackEnvelope): string {
	return encodeSseEvent(envelope.kind, envelope, envelope.seq);
}

/**
 * Async-iterate validated envelopes from a /callback/down response body.
 * Reuses parseSseUnits (partial-chunk, CRLF, multi-line-data handling).
 * Comments and the transport `ping` keepalive are consumed silently;
 * observable liveness comes from `heartbeat` envelopes (15 s cadence vs the
 * 30 s silence deadline). Malformed event data throws
 * CallbackError("invalid_request") unless `onRecordError` is given: then the
 * bad event is reported and skipped (SSE event boundaries stay intact), so one
 * malformed envelope fails only itself. The event name mirrors the envelope
 * kind by convention but only the data is validated.
 */
export async function* parseSseEnvelope(
	body: ReadableStream<Uint8Array>,
	opts?: { onRecordError?: (error: CallbackError) => void },
): AsyncGenerator<CallbackEnvelope> {
	for await (const unit of parseSseUnits(body)) {
		if (unit.kind !== "event" || unit.event === SSE_PING_EVENT) continue;
		let envelope: CallbackEnvelope;
		try {
			envelope = parseEventEnvelope(unit.data);
		} catch (error) {
			if (opts?.onRecordError === undefined) throw error;
			opts.onRecordError(error as CallbackError);
			continue;
		}
		yield envelope;
	}
}

function parseEventEnvelope(data: string): CallbackEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch (cause) {
		throw new CallbackError("invalid_request", "sse event data is not valid JSON", { cause });
	}
	return validateEnvelope(value);
}

/** Payload of a control envelope carrying one slice of an oversized payload. */
export interface ChunkEnvelopePayload {
	type: "chunk";
	/** Groups the slices of one logical payload. */
	chunkId: string;
	/** 0-based slice index. */
	index: number;
	/** Total slice count; identical on every slice. */
	total: number;
	/** Base64 slice of the original payload's UTF-8 JSON bytes. */
	data: string;
}

/**
 * Structural predicate for a chunk payload carried by a control envelope.
 * Validates field presence and primitive shape only; group consistency
 * (shared chunkId/total, complete index set) is reassembleChunks' job.
 */
export function isChunkPayload(value: unknown): value is ChunkEnvelopePayload {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v.type === "chunk" &&
		typeof v.chunkId === "string" &&
		Number.isSafeInteger(v.index) &&
		Number.isSafeInteger(v.total) &&
		(v.total as number) >= 1 &&
		typeof v.data === "string"
	);
}

/**
 * True when the envelope's canonical serialization exceeds `maxBytes`
 * (default ENVELOPE_MAX_BYTES) and must be chunked before sending.
 */
export function needsSplit(
	envelope: CallbackEnvelope,
	maxBytes: number = ENVELOPE_MAX_BYTES,
): boolean {
	return canonicalBytes(envelope) > maxBytes;
}

/** A concrete chunking plan; every envelope is kind "control" with a ChunkEnvelopePayload. */
export interface OversizeSplit {
	chunkId: string;
	total: number;
	envelopes: CallbackEnvelope[];
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function newChunkId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `chunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Split an oversized payload into application-level `control`/"chunk"
 * envelopes (ledger: chunk kind control 'chunk' with chunkId/index/total).
 * Each slice transports base64 of the original payload's UTF-8 JSON bytes,
 * so arbitrary slice points are byte-exact and every produced envelope
 * re-validates under `maxRecordBytes` (default ENVELOPE_MAX_BYTES; enforced
 * with a defensive re-validation pass). Slice envelopes inherit the source
 * envelope's identity fields and seq; the sender assigns fresh monotonic
 * seq values at emit time. Reassemble with reassembleChunks.
 */
export function planOversizeSplit(
	envelope: CallbackEnvelope,
	opts?: { maxRecordBytes?: number; chunkId?: string },
): OversizeSplit {
	const maxRecordBytes = opts?.maxRecordBytes ?? ENVELOPE_MAX_BYTES;
	const chunkId = opts?.chunkId ?? newChunkId();
	const payloadJson = JSON.stringify(envelope.payload) ?? "null";
	const base64 = toBase64(utf8.encode(payloadJson));
	// Measure the chunk envelope overhead with the real identity fields and an
	// empty data segment; data is pure-ASCII base64, so JSON escaping never
	// expands it. 16 spare bytes absorb index/total digit growth.
	const probe: CallbackEnvelope = {
		...envelope,
		kind: "control",
		payload: { type: "chunk", chunkId, index: 0, total: 1, data: "" },
	};
	const dataBudget = maxRecordBytes - canonicalBytes(probe) - 16;
	if (dataBudget <= 0) {
		throw new CallbackError(
			"invalid_request",
			`envelope identity is too large to chunk under the ${maxRecordBytes}-byte record limit`,
		);
	}
	const total = Math.max(1, Math.ceil(base64.length / dataBudget));
	const envelopes: CallbackEnvelope[] = [];
	for (let index = 0; index < total; index++) {
		envelopes.push({
			...envelope,
			kind: "control",
			payload: {
				type: "chunk",
				chunkId,
				index,
				total,
				data: base64.slice(index * dataBudget, (index + 1) * dataBudget),
			},
		});
	}
	for (const chunk of envelopes) validateEnvelope(chunk, { maxBytes: maxRecordBytes });
	return { chunkId, total, envelopes };
}

/**
 * Reassemble chunk envelopes produced by planOversizeSplit into the original
 * payload. Order-independent: slices are sorted by index. Enforces that
 * every slice is a validated control/"chunk" envelope sharing one chunkId
 * and total, that the 0..total-1 index set is complete without duplicates,
 * and that the reassembled payload fits `streamMaxBytes` (default
 * STREAM_MAX_BYTES, the per-virtual-stream cap). Returns the original
 * payload value; the logical kind of the original envelope is the consumer's
 * context (chunk payloads carry only the ledger-frozen fields).
 */
export function reassembleChunks(
	chunks: readonly CallbackEnvelope[],
	opts?: { streamMaxBytes?: number },
): unknown {
	const streamMaxBytes = opts?.streamMaxBytes ?? STREAM_MAX_BYTES;
	const fail: (detail: string) => never = (detail) => {
		throw new CallbackError("invalid_request", `chunk reassembly failed: ${detail}`);
	};
	if (!Array.isArray(chunks) || chunks.length === 0) fail("no chunks supplied");
	const byIndex = new Map<number, string>();
	let chunkId: string | undefined;
	let total: number | undefined;
	for (const chunk of chunks) {
		validateEnvelope(chunk);
		if (chunk.kind !== "control")
			fail(`chunk ${chunk.seq} has kind "${chunk.kind}", expected "control"`);
		const payload = chunk.payload;
		if (!isChunkPayload(payload)) fail(`chunk ${chunk.seq} payload is not a "chunk" payload`);
		if (chunkId === undefined) chunkId = payload.chunkId;
		else if (payload.chunkId !== chunkId) fail(`chunk ${chunk.seq} has a foreign chunkId`);
		if (total === undefined) total = payload.total;
		else if (payload.total !== total) fail(`chunk ${chunk.seq} disagrees on total`);
		if (payload.index < 0 || payload.index >= total)
			fail(`chunk ${chunk.seq} index ${payload.index} is out of range`);
		if (byIndex.has(payload.index)) fail(`duplicate index ${payload.index}`);
		byIndex.set(payload.index, payload.data);
	}
	if (chunkId === undefined || total === undefined) fail("no chunks supplied");
	if (byIndex.size !== total)
		fail(`incomplete chunk group ${chunkId}: ${byIndex.size}/${total} slices`);
	const ordered: string[] = [];
	for (let index = 0; index < total; index++) ordered.push(byIndex.get(index)!);
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(ordered.join(""));
	} catch (cause) {
		throw new CallbackError(
			"invalid_request",
			"chunk reassembly failed: chunk data is not valid base64",
			{ cause },
		);
	}
	if (bytes.length > streamMaxBytes) {
		fail(
			`reassembled payload is ${bytes.length} bytes, over the ${streamMaxBytes}-byte stream limit`,
		);
	}
	try {
		return JSON.parse(utf8Strict.decode(bytes));
	} catch (cause) {
		throw new CallbackError(
			"invalid_request",
			"chunk reassembly failed: reassembled payload is not valid JSON",
			{ cause },
		);
	}
}
