import {
	CLIENT_BACKPRESSURE_BYTES,
	CLIENT_KEEPALIVE_MS,
	CLIENT_SILENCE_DEADLINE_MS,
} from "./protocol";

/**
 * Callback transport protocol (OMP_CALLBACK_PROTO = 2), separately versioned
 * from OMP_PROTO. This module is the single source of truth for the
 * envelope shape, route paths, and parsing rules shared by the fleet and the
 * session callback client.
 *
 * Pure module: no I/O, no ambient state. Shared by the fleet (server routes,
 * edge) and the session's callback client.
 *
 * Pair: one session-initiated WebSocket, `GET /callback/ws` upgrade, carrying
 *       envelopes both ways. Identity, credential and protocol version ride
 *       the upgrade request HEADERS, never the URL. One text message is one
 *       canonical-JSON envelope of at most ENVELOPE_MAX_BYTES; larger payloads
 *       travel as chunk envelopes (planOversizeSplit). Binary messages are a
 *       protocol violation. Each socket mints a fresh connectionId with its
 *       own seq space per direction (starts at 1, strictly monotonic) and is
 *       never resumed. No per-connection byte cap and no renewal: a pair lives
 *       until either side closes it or its silence deadline passes.
 *       perMessageDeflate stays off on both ends.
 * Credit: the session's uploads are paced by a pair-level credit window
 *       (PairCreditControl, PAIR_CREDIT_WINDOW_BYTES): the fleet grants as it
 *       consumes, a session never has more than the window outstanding, and
 *       the fleet closes a pair that ignores it. This, not a size guess,
 *       bounds what a forwarder or reverse proxy holds for one pair.
 * Refusal: the fleet authenticates the upgrade request, but a WebSocket
 *       client cannot read a non-101 status, so a refused dial is upgraded
 *       and immediately closed with a refusal close code
 *       ({@link callbackCloseFor}); the session maps it back with
 *       {@link callbackErrorFromClose}.
 * Bulk: session-initiated POST /callback/bulk/<correlationId>, 64 MiB cap,
 *       on its own HTTP request so a transfer never blocks the pair;
 *       completion is never archive acceptance.
 */

/** Callback protocol version. */
export const OMP_CALLBACK_PROTO = 2;

/** The one pair route: WebSocket upgrade. */
export const CALLBACK_WS_PATH = "/callback/ws";
/** Bulk transfer route prefix (HTTP POST). */
export const CALLBACK_BULK_PATH_PREFIX = "/callback/bulk/";
/**
 * Upgrade request header naming the session's OMP_CALLBACK_PROTO. The fleet
 * refuses an upgrade without it or with another value (`proto_unsupported`).
 */
export const CALLBACK_PROTO_HEADER = "x-omp-callback-proto";
/**
 * Reserved control-plane wire literals both halves must agree on
 * byte-for-byte; carried here so neither lane invents a variant:
 *
 * - CALLBACK_TRANSPORT_STREAM_ID: streamId the fleet uses for its own
 *   envelopes (pair_ready, heartbeats).
 * - CALLBACK_CONTROL_STREAM_ID: streamId the session uses for its transport
 *   heartbeats on the up stream.
 * - CALLBACK_PAIR_READY_TYPE: payload.type of the single control envelope
 *   the fleet sends first on an accepted socket, once it registered the
 *   pair; payload is {type, connectionId, generation}.
 */
export const CALLBACK_TRANSPORT_STREAM_ID = "transport";
export const CALLBACK_CONTROL_STREAM_ID = "control";
export const CALLBACK_PAIR_READY_TYPE = "pair_ready";

/** streamId prefix of per-browser virtual streams: `browser/<connId>`. */
export const CALLBACK_BROWSER_STREAM_PREFIX = "browser/";

/**
 * Bulk multi-part upload headers (session → fleet, POST /callback/bulk/<id>).
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
 * session→fleet, kind "control", on the affected stream: the session could not
 * honor replay (ring underflow, foreign connection, or an outbound buffer
 * drop) and a full re-prime burst follows on that stream. Forward-transparent
 * to the browser.
 */
export interface StreamResyncControl {
	type: "stream_resync";
}

/**
 * fleet→session, kind "control", on a `browser/<connId>` stream: (re)open it.
 * `lastSeq` is the replay floor (absent after a pair replacement). The session
 * paces the stream's priming and history resyncs by the fleet's drain: it
 * keeps at most STREAM_ACK_WINDOW_BYTES of frames the fleet has not yet
 * acknowledged with StreamAckControl, instead of pacing against its own
 * outbound buffer alone.
 */
export interface StreamOpenControl {
	type: "stream_open";
	lastSeq?: number;
}

/**
 * fleet→session, kind "control", on a `browser/<connId>` stream: every frame the
 * session sent on this stream with wire seq at or below `seq` has left the
 * fleet's memory for the browser's socket (the fleet's per-browser queue
 * drained past it). Cumulative; stale or repeated values are harmless.
 */
export interface StreamAckControl {
	type: "stream_ack";
	seq: number;
}

/**
 * Unacknowledged bytes a session may hold in flight per browser stream
 * (sent, or queued for sending, and not yet covered by a stream_ack). A
 * sender also keeps one maximal envelope (ENVELOPE_MAX_BYTES) of headroom
 * inside it, so the fleet's per-browser queue (CLIENT_BACKPRESSURE_BYTES) always
 * has at least 1 MiB left for live frames that interleave with a burst.
 */
export const STREAM_ACK_WINDOW_BYTES = 3 * 1024 * 1024;
/** The fleet acknowledges once at least this many more bytes drained since its last ack. */
export const STREAM_ACK_STEP_BYTES = 512 * 1024;

/**
 * fleet→session, kind "control", streamId "transport": pair upload credit. The
 * fleet has consumed (parsed, routed, handed to its sinks) `consumed` bytes of
 * everything the session sent on this socket since it opened. Cumulative, in
 * the UTF-8 length of each text message, so a stale or repeated value is
 * harmless and a lost grant is repaired by the next.
 *
 * A session hands the socket a message only while the bytes it has sent beyond
 * the last grant, plus that message, fit PAIR_CREDIT_WINDOW_BYTES. The fleet
 * counts every message it receives (dropped and binary ones too) and closes a
 * pair that is more than PAIR_CREDIT_WINDOW_BYTES ahead of the credit it has
 * granted: `invalid_request`, retryable (4400, like the other per-pair protocol
 * violations; the redial starts a fresh window). The fleet's receive side is
 * thereby bounded exactly: never more than the window sits between the
 * session's `send()` and the fleet's consumer, in the socket buffers, a
 * forwarder (`omp-web ui`) and a reverse proxy alike, because a grant is only
 * issued by the real consumer at the end of the path.
 */
export interface PairCreditControl {
	type: "pair_credit";
	consumed: number;
}

/** True when `payload` is a {@link PairCreditControl}: a non-negative safe integer `consumed`. */
export function isPairCreditControl(payload: unknown): payload is PairCreditControl {
	if (typeof payload !== "object" || payload === null) return false;
	const grant = payload as Record<string, unknown>;
	return (
		grant.type === "pair_credit" &&
		typeof grant.consumed === "number" &&
		Number.isSafeInteger(grant.consumed) &&
		grant.consumed >= 0
	);
}

/**
 * Bytes a session may have on the wire towards the fleet beyond the credit it
 * has seen: sent, in the socket buffers, in a forwarder, or received and not
 * yet consumed. 8 MiB, the session's own per-connection queue cap
 * (CONNECTION_MAX_BYTES), so a full queue never waits on more than it can hold.
 * It must admit a maximal message beside the ungranted tail the grant cadence
 * leaves behind: window - PAIR_CREDIT_STEP_BYTES must be at least
 * CALLBACK_WS_MAX_PAYLOAD_BYTES (2 MiB, which covers ENVELOPE_MAX_BYTES), or a
 * sender could wait for credit that never comes.
 */
export const PAIR_CREDIT_WINDOW_BYTES = 8 * 1024 * 1024;
/** The fleet grants once at least this many more bytes were consumed since its last grant (the tail below it is never granted). */
export const PAIR_CREDIT_STEP_BYTES = 512 * 1024;

/**
 * fleet→session, kind "command", streamId "control": stream a server-side file
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

/** session→fleet, kind "control", streamId "control": a correlated bulk upload failed mid-transfer. */
export interface DownloadBulkFailedControl {
	type: "download_bulk_failed";
	correlationId: string;
	error: { code: CallbackErrorCode; message: string };
}

/** fleet→session, kind "control", streamId "transport": graceful shutdown; the session acks, then exits 0. */
export interface ShutdownControl {
	type: "shutdown";
	reason?: string;
}

/** Serialized envelope cap: one WebSocket text message (1 MiB). */
export const ENVELOPE_MAX_BYTES = 1024 * 1024;
/** Per-connection buffered-envelope cap across all streams (8 MiB). */
export const CONNECTION_MAX_BYTES = 8 * 1024 * 1024;
/** Per-virtual-stream buffered cap (4 MiB); also bounds reassembled chunks. */
export const STREAM_MAX_BYTES = CLIENT_BACKPRESSURE_BYTES;
/** Heartbeat envelope cadence each side sends while otherwise idle (15 s). */
export const HEARTBEAT_INTERVAL_MS = CLIENT_KEEPALIVE_MS;
/** Receive silence deadline (30 s), applied by both sides: no envelope by then = dead pair. */
export const SILENCE_DEADLINE_MS = CLIENT_SILENCE_DEADLINE_MS;
/**
 * Socket-level message cap (`maxPayloadLength`) on both ends: above the
 * envelope cap, so an over-cap envelope reaches validation and is dropped
 * alone instead of killing the socket.
 */
export const CALLBACK_WS_MAX_PAYLOAD_BYTES = 2 * ENVELOPE_MAX_BYTES;
/**
 * Socket send-buffer high-water mark. A sender hands the socket no further
 * envelope while its buffered amount is above this and resumes once it drains
 * below, so unsent envelopes stay in the sender's own bounded queues. Neither
 * side relies on the socket to buffer or drop: Bun's server `send()` drops a
 * message silently past `backpressureLimit`.
 */
export const CALLBACK_WS_SEND_HIGH_WATER_BYTES = 1024 * 1024;
/** Wait for the session's pair-ready confirmation (60 s). */
export const PAIR_READY_TIMEOUT_MS = 60_000;
/** Wait for a parked/suspended session to wake (60 s). */
export const WAKE_TIMEOUT_MS = 60_000;
/** Reconnect backoff ramp, jittered (1 s → 30 s). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** Bulk transfer cap for POST /callback/bulk/<correlationId> (64 MiB). */
export const BULK_MAX_BYTES = 64 * 1024 * 1024;
/** Callback enrollment credential width (256-bit, hashed fleet-side). */
export const ENROLLMENT_KEY_BYTES = 32;

/** Envelope kinds. */
export const CALLBACK_KINDS = ["frame", "command", "control", "heartbeat"] as const;
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
	"proto_unsupported",
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
	proto_unsupported: 410,
};

/** True when `value` names a frozen callback error code. */
export function isCallbackErrorCode(value: string): value is CallbackErrorCode {
	return (CALLBACK_ERROR_CODES as readonly string[]).includes(value);
}

/** Ledger code a refusal with no typed `error` body stands for, keyed by HTTP status. */
const UNTYPED_REFUSAL_CODE: Record<number, CallbackErrorCode> = {
	400: "invalid_request",
	401: "unauthorized",
	403: "forbidden",
	409: "conflict",
	429: "retryable",
	503: "unavailable",
};

/** Ledger code for a non-2xx response without a typed body; unknown statuses are retryable. */
export function codeFromHttpStatus(status: number): CallbackErrorCode {
	return UNTYPED_REFUSAL_CODE[status] ?? "retryable";
}

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

/** WebSocket close codes at or above this carry a typed refusal: 4000 + the code's HTTP status. */
export const CALLBACK_CLOSE_REFUSAL_BASE = 4000;
/** RFC 6455 caps a close reason at 123 UTF-8 bytes. */
const CLOSE_REASON_MAX_BYTES = 123;

/**
 * Close frame carrying a typed refusal on the pair socket: code
 * CALLBACK_CLOSE_REFUSAL_BASE + the ledger code's HTTP status, reason
 * `<ledger code>: <message>` cut to the 123-byte close-reason limit.
 */
export function callbackCloseFor(error: CallbackError): { code: number; reason: string } {
	let reason = `${error.code}: ${error.message}`;
	if (Buffer.byteLength(reason, "utf8") > CLOSE_REASON_MAX_BYTES) {
		const bytes = Buffer.from(reason, "utf8").subarray(0, CLOSE_REASON_MAX_BYTES);
		// Drop a multi-byte character the cut split (decodes as U+FFFD).
		reason = bytes.toString("utf8").replace(/\uFFFD+$/, "");
	}
	return { code: CALLBACK_CLOSE_REFUSAL_BASE + CALLBACK_ERROR_HTTP_STATUS[error.code], reason };
}

/**
 * Typed refusal a pair-socket close stands for, or null for an ordinary close
 * (below CALLBACK_CLOSE_REFUSAL_BASE or above 4999). The reason's leading
 * ledger code wins; without one the status picks the code (codeFromHttpStatus).
 */
export function callbackErrorFromClose(code: number, reason: string): CallbackError | null {
	if (code < CALLBACK_CLOSE_REFUSAL_BASE || code > 4999) return null;
	const sep = reason.indexOf(": ");
	const head = sep === -1 ? reason : reason.slice(0, sep);
	const message = sep === -1 ? reason : reason.slice(sep + 2);
	const ledger = isCallbackErrorCode(head)
		? head
		: codeFromHttpStatus(code - CALLBACK_CLOSE_REFUSAL_BASE);
	return new CallbackError(ledger, message || `callback pair refused (close ${code})`);
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
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface ValidateEnvelopeOptions {
	/** Serialized-size cap; defaults to ENVELOPE_MAX_BYTES. */
	maxBytes?: number;
	/**
	 * Serialized byte length, when the caller already has it (skips a second
	 * JSON.stringify): the UTF-8 length of JSON.stringify(value), or of a wire
	 * form of it (never shorter than the canonical form). Only bounds the cap.
	 */
	bytes?: number;
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
	let bytes = opts?.bytes;
	if (bytes === undefined) {
		try {
			bytes = canonicalBytes(value);
		} catch (cause) {
			throw new CallbackError(
				"invalid_request",
				"invalid callback envelope: payload is not JSON-serializable",
				{ cause },
			);
		}
	}
	if (bytes > maxBytes)
		fail(`serialized envelope is ${bytes} bytes, over the ${maxBytes}-byte limit`);
	return value as CallbackEnvelope;
}

/**
 * A payload serialized once (canonical JSON.stringify form) with its UTF-8
 * length. Hand one to a sender instead of the raw value when the same payload
 * goes to several streams or is ringed for replay: the envelope record is
 * assembled around `json` ({@link encodeEnvelopeAround}) so neither sizing,
 * validation, nor the per-stream seq stamp re-serializes it.
 */
export class PreEncodedPayload {
	readonly json: string;
	readonly bytes: number;
	constructor(json: string, bytes: number) {
		this.json = json;
		this.bytes = bytes;
	}
}

/**
 * Serialize `value` once into a {@link PreEncodedPayload}. Throws
 * CallbackError("invalid_request") for `undefined` (a payload is required) and
 * whatever JSON.stringify throws for a value that is not serializable.
 */
export function preEncodePayload(value: unknown): PreEncodedPayload {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new CallbackError("invalid_request", "invalid callback envelope: payload is required");
	}
	return new PreEncodedPayload(json, Buffer.byteLength(json, "utf8"));
}

/** Envelope fields other than the payload: what is stamped per emit. */
export type EnvelopeHead = Omit<CallbackEnvelope, "payload">;

/** Printable ASCII with no quote or backslash: serializes as itself between quotes. */
const PLAIN_JSON_STRING = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** JSON.stringify of a string, skipping the call for the plain-ASCII identifiers envelopes carry. */
function quote(value: string): string {
	return PLAIN_JSON_STRING.test(value) ? `"${value}"` : JSON.stringify(value);
}

/**
 * The canonical serialization of an envelope split around its payload:
 * `head + payloadJson + tail` equals `JSON.stringify(envelope)`. Key order is
 * the CallbackEnvelope field order, which every producer builds in.
 */
export function envelopeFraming(envelope: EnvelopeHead): { head: string; tail: string } {
	return {
		head:
			`{"version":${envelope.version},"workspaceId":${quote(envelope.workspaceId)}` +
			`,"generation":${envelope.generation},"connectionId":${quote(envelope.connectionId)}` +
			`,"streamId":${quote(envelope.streamId)},"seq":${envelope.seq}` +
			`,"kind":${quote(envelope.kind)},"payload":`,
		tail: `,"at":${envelope.at}}`,
	};
}

/**
 * One envelope as a pair-socket text message, assembled around an already
 * serialized payload: equals `JSON.stringify` of the envelope carrying the
 * payload `payloadJson` was serialized from.
 */
export function encodeEnvelopeAround(envelope: EnvelopeHead, payloadJson: string): string {
	const { head, tail } = envelopeFraming(envelope);
	return head + payloadJson + tail;
}

/**
 * The payload's own JSON text inside a pair-socket message, or undefined when
 * the message is not canonically framed. `envelope` is `decodeEnvelope(message)`:
 * the message must start with the canonical head of that envelope and end with
 * its canonical tail (what every producer emits, see {@link envelopeFraming}),
 * so the slice between them is the text the payload was parsed from. Padded or
 * re-keyed framing (extra whitespace, other key order) returns undefined.
 * Callers that forward the slice must still route and filter on the parsed
 * `envelope.payload`: both sides JSON.parse the same text.
 */
export function canonicalPayloadJson(message: string, envelope: EnvelopeHead): string | undefined {
	const { head, tail } = envelopeFraming(envelope);
	if (message.length < head.length + tail.length) return undefined;
	if (!message.startsWith(head) || !message.endsWith(tail)) return undefined;
	return message.slice(head.length, message.length - tail.length);
}

/**
 * Parse one pair-socket text message into a validated envelope. `wireBytes`
 * is the message's UTF-8 length when the receiver knows it: the canonical
 * form is never longer than the wire form, so a message within the cap skips
 * the re-serialization validateEnvelope would otherwise do to size it.
 */
export function decodeEnvelope(text: string, wireBytes?: number): CallbackEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new CallbackError("invalid_request", "callback envelope is not valid JSON", { cause });
	}
	return validateEnvelope(
		value,
		wireBytes !== undefined && wireBytes <= ENVELOPE_MAX_BYTES ? { bytes: wireBytes } : undefined,
	);
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
