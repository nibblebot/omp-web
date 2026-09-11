import type { ManifestFile, ManifestFileKind } from "./archive-manifest";
import { isNormalizedPosixRelativePath } from "./archive-manifest";
import { encodeSseEvent, parseSseUnits, SSE_PING_EVENT } from "./sse";

/**
 * Callback transport protocol (OMP_CALLBACK_PROTO = 1), separately versioned
 * from OMP_PROTO (2). Encoding, parsing, and policy frozen by
 * docs/clone-contracts.md ("Callback transport" and "Typed errors").
 *
 * Pure module: no I/O, no ambient state beyond the explicit parser/dedup
 * objects this file creates. Shared by the fleet (server routes, edge) and
 * the daemon connector.
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
 * - CALLBACK_TRANSPORT_STREAM_ID — streamId the fleet uses for its own
 *   envelopes (pair_ready, heartbeats); rides the replay ring so a resuming
 *   redial re-delivers them.
 * - CALLBACK_CONTROL_STREAM_ID — streamId the daemon uses for its transport
 *   heartbeats on the up stream.
 * - CALLBACK_PAIR_READY_TYPE — payload.type of the single control envelope
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
 * at BULK_MAX_BYTES (64 MiB) — multi-part exists so neither side buffers the
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

/** fleet→daemon, kind "control", streamId `browser/<connId>`: a browser attached. */
export interface StreamOpenControl {
	type: "stream_open";
	/** Last envelope seq the edge consumed on this stream; absent = fresh prime. */
	lastSeq?: number;
}

/** fleet→daemon, kind "control", streamId `browser/<connId>`: the browser detached. */
export interface StreamCloseControl {
	type: "stream_close";
}

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
 * realpath jail + authorization rules as HTTP /download; failures are reported
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

/** fleet→daemon log controls on the down half (ledger "Session log streaming"). */
export interface LogAckControl {
	type: "log_ack";
	/** Durable (fsynced) append offset per streamId; may batch several streams. */
	offsets: Record<string, number>;
}
export interface LogGapControl {
	type: "log_gap";
	/** Repair request: re-stream bytes [from, to) of the named stream. */
	from: number;
	to: number;
	/** Affected stream; required when the control rides the reserved transport stream. */
	streamId?: string;
}

/** fleet→daemon, kind "control", streamId "transport": begin quiesce for the delete gate. */
export interface QuiesceBeginControl {
	type: "quiesce_begin";
	requestId: string;
	timeoutMs?: number;
}

/** Final per-stream flush boundary: the fleet store must reach exactly these offsets. */
export type FlushBoundary = Record<string, { offset: number; generation: number; eof: true }>;

/** Outcome of one captured writer's explicit flush at quiesce. */
export interface QuiesceWriterEntry {
	id: string;
	kind: "main" | "sub" | "advisor";
	sessionFile: string | null;
	/**
	 * flushed = SessionManager.flush() resolved without a latched failure;
	 * parked/disposed = the SDK had already released the writer before
	 * quiesce (flush state not re-checkable; covered by structural
	 * verification of the on-disk file).
	 */
	state: "flushed" | "parked" | "disposed";
}

/** Daemon-collected Git evidence for the verify-at-deletion guard (P7.4). */
export interface CloneGitEvidence {
	/** "unknown" blocks deletion; any probe failure lands here with unknownReason. */
	status: "clean" | "dirty" | "unknown";
	unknownReason?: string;
	head?: string;
	branch?: string | null;
	dirty?: { added: number; modified: number; deleted: number; untracked: number };
	stashes?: number;
	/** The configured remote (clone origin); null when none exists. */
	remote?: { name: string; url: string } | null;
	/** Local branch/tag tips + whether each is preserved on the configured remote. */
	refs?: Array<{ name: string; tip: string; preserved: boolean }>;
}

/** daemon→fleet, kind "control", streamId "transport": the quiesce outcome. */
export interface QuiesceResultControl {
	type: "quiesce_result";
	requestId: string;
	ok: boolean;
	/** Present on ok:true. */
	boundary?: FlushBoundary;
	/**
	 * Manifest file entries (shared/archive-manifest.ts ManifestFile[]),
	 * computed from the agent dir. projectId/source are registry facts the
	 * fleet fills before any exportId hashing.
	 */
	manifestFiles?: unknown[];
	/** Provenance the daemon can prove; projectId/source are registry facts the fleet fills. */
	provenance?: {
		workspaceId: string;
		workspaceName: string;
		resolvedCommit: string;
		generatedAt: number;
	};
	writers?: {
		main: "flushed";
		descendants: QuiesceWriterEntry[];
		advisors: "caught_up" | "inactive";
		note?: string;
	};
	git?: CloneGitEvidence;
	/** Present on ok:false. */
	error?: { code: CallbackErrorCode; message: string; path?: string };
}

/**
 * fleet→daemon, kind "control", streamId "transport": collect final evidence
 * for a Kubernetes-managed workspace and upload it as one {@link
 * QuiesceEvidence} JSON document over the bulk channel under `correlationId`.
 * Unlike `quiesce_begin`, the fleet already proved predecessor termination and
 * supplies the source facts the daemon must not re-derive.
 */
export interface QuiesceCloneControl {
	type: "quiesce_clone";
	requestId: string;
	/** Bulk correlation the evidence document is uploaded under. */
	correlationId: string;
	sourceRemote: string;
	pinnedRevision: string;
	branch: string;
}

/**
 * daemon→fleet, kind "control", streamId "transport": receipt for a
 * `quiesce_clone`. `ok:true` means the evidence document was fully uploaded;
 * the fleet still validates it against its own store before it authorizes
 * deletion.
 */
export type QuiesceCloneResultControl = {
	type: "quiesce_clone_result";
	requestId: string;
	correlationId: string;
} & ({ ok: true } | { ok: false; error: { code: CallbackErrorCode; message: string } });

/**
 * The single evidence document a daemon uploads for a `quiesce_clone`. Every
 * field is required, so a receipt can never be validated against a partial
 * proof: `mainSessionRelpath` is null only when neither the workspace volume
 * nor the fleet store holds a main transcript.
 */
export interface QuiesceEvidence {
	requestId: string;
	/** POSIX relpath of the main transcript under the agent sessions dir; null = none anywhere. */
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	manifestFiles: ManifestFile[];
	provenance: {
		workspaceId: string;
		workspaceName: string;
		resolvedCommit: string;
		generatedAt: number;
	};
	writers: {
		main: "flushed";
		descendants: QuiesceWriterEntry[];
		advisors: "caught_up" | "inactive";
		note?: string;
	};
	git: CloneGitEvidence;
}

/** Bound on the uploaded evidence document (16 MiB; bulk transfer caps at 64 MiB). */
export const QUIESCE_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;

/** Parse a `FlushBoundary`: every entry carries a finite offset, generation, and eof:true. */
function parseFlushBoundary(value: unknown): FlushBoundary | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const boundary: FlushBoundary = {};
	for (const [streamId, entry] of Object.entries(value as Record<string, unknown>)) {
		if (streamId.length === 0 || typeof entry !== "object" || entry === null) return null;
		const record = entry as Record<string, unknown>;
		const offset = record["offset"];
		const generation = record["generation"];
		if (
			typeof offset !== "number" ||
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			typeof generation !== "number" ||
			!Number.isSafeInteger(generation) ||
			generation < 0 ||
			record["eof"] !== true
		) {
			return null;
		}
		boundary[streamId] = { offset, generation, eof: true };
	}
	return boundary;
}

const MANIFEST_FILE_KINDS: readonly ManifestFileKind[] = [
	"main",
	"subagent",
	"advisor",
	"metadata",
];

/**
 * Parse an untrusted {@link QuiesceEvidence} document (byte-bound, strict).
 * Throws CallbackError("invalid_request") on any structural problem; the
 * fleet's semantic cross-checks against its own store live in
 * fleet/clone-quiesce.ts.
 */
export function parseQuiesceEvidence(raw: string): QuiesceEvidence {
	const reject: (why: string) => never = (why) => {
		throw new CallbackError("invalid_request", `quiesce evidence: ${why}`);
	};
	if (Buffer.byteLength(raw, "utf8") > QUIESCE_EVIDENCE_MAX_BYTES) {
		reject(`exceeds ${QUIESCE_EVIDENCE_MAX_BYTES} bytes`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch (cause) {
		reject(`is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		reject("must be an object");
	const record = value as Record<string, unknown>;
	const requestId = record["requestId"];
	if (typeof requestId !== "string" || requestId.length === 0) reject("requestId is missing");
	const mainRaw = record["mainSessionRelpath"];
	if (
		mainRaw !== null &&
		(typeof mainRaw !== "string" || !isNormalizedPosixRelativePath(mainRaw))
	) {
		reject("mainSessionRelpath must be null or a normalized POSIX relpath");
	}
	const boundary = parseFlushBoundary(record["boundary"]) ?? reject("boundary is missing");
	const filesRaw = record["manifestFiles"];
	if (!Array.isArray(filesRaw)) reject("manifestFiles must be an array");
	const manifestFiles = (filesRaw as unknown[]).map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			reject(`manifestFiles[${index}] must be an object`);
		}
		const file = entry as Record<string, unknown>;
		const path = file["path"];
		if (typeof path !== "string" || !isNormalizedPosixRelativePath(path)) {
			reject(`manifestFiles[${index}].path must be a normalized POSIX relpath`);
		}
		const size = file["size"];
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			reject(`manifestFiles[${index}].size must be a non-negative integer`);
		}
		const sha256 = file["sha256"];
		if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
			reject(`manifestFiles[${index}].sha256 must be lowercase hex sha256`);
		}
		const kind = file["kind"];
		if (typeof kind !== "string" || !MANIFEST_FILE_KINDS.includes(kind as ManifestFileKind)) {
			reject(`manifestFiles[${index}].kind must be one of ${MANIFEST_FILE_KINDS.join("|")}`);
		}
		const sessionId = file["sessionId"];
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			reject(`manifestFiles[${index}].sessionId is missing`);
		}
		const parentPath = file["parentPath"];
		if (
			parentPath !== undefined &&
			(typeof parentPath !== "string" || !isNormalizedPosixRelativePath(parentPath))
		) {
			reject(`manifestFiles[${index}].parentPath must be a normalized POSIX relpath`);
		}
		return {
			path,
			size,
			sha256,
			kind: kind as ManifestFileKind,
			sessionId,
			...(parentPath !== undefined ? { parentPath } : {}),
		} satisfies ManifestFile;
	});
	const provenanceRaw = record["provenance"];
	if (typeof provenanceRaw !== "object" || provenanceRaw === null || Array.isArray(provenanceRaw)) {
		reject("provenance must be an object");
	}
	const provenance = provenanceRaw as Record<string, unknown>;
	for (const field of ["workspaceId", "workspaceName", "resolvedCommit"] as const) {
		const fieldValue = provenance[field];
		if (typeof fieldValue !== "string" || fieldValue.length === 0) {
			reject(`provenance.${field} is missing`);
		}
	}
	const generatedAt = provenance["generatedAt"];
	if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt) || generatedAt < 0) {
		reject("provenance.generatedAt must be a non-negative number");
	}
	const writersRaw = record["writers"];
	if (typeof writersRaw !== "object" || writersRaw === null || Array.isArray(writersRaw)) {
		reject("writers must be an object");
	}
	const writers = writersRaw as Record<string, unknown>;
	if (writers["main"] !== "flushed") reject('writers.main must be "flushed"');
	if (writers["advisors"] !== "caught_up" && writers["advisors"] !== "inactive") {
		reject('writers.advisors must be "caught_up" or "inactive"');
	}
	const descendants = writers["descendants"];
	if (!Array.isArray(descendants)) reject("writers.descendants must be an array");
	const note = writers["note"];
	if (note !== undefined && typeof note !== "string") reject("writers.note must be a string");
	const gitRaw = record["git"];
	if (typeof gitRaw !== "object" || gitRaw === null || Array.isArray(gitRaw)) {
		reject("git must be an object");
	}
	const git = gitRaw as Record<string, unknown>;
	if (git["status"] !== "clean" && git["status"] !== "dirty" && git["status"] !== "unknown") {
		reject('git.status must be "clean", "dirty", or "unknown"');
	}
	return {
		requestId,
		mainSessionRelpath: mainRaw as string | null,
		boundary,
		manifestFiles,
		provenance: {
			workspaceId: provenance["workspaceId"] as string,
			workspaceName: provenance["workspaceName"] as string,
			resolvedCommit: provenance["resolvedCommit"] as string,
			generatedAt,
		},
		writers: {
			main: "flushed",
			descendants: descendants as QuiesceWriterEntry[],
			advisors: writers["advisors"] as "caught_up" | "inactive",
			...(note !== undefined ? { note } : {}),
		},
		git: git as unknown as CloneGitEvidence,
	};
}

/** Serialized envelope cap: one NDJSON record / one SSE data payload (1 MiB). */
export const ENVELOPE_MAX_BYTES = 1024 * 1024;
/** Per-connection buffered-envelope cap across all streams (8 MiB). */
export const CONNECTION_MAX_BYTES = 8 * 1024 * 1024;
/** Per-virtual-stream buffered cap (4 MiB); also bounds reassembled chunks. */
export const STREAM_MAX_BYTES = 4 * 1024 * 1024;
/** Replay ring entries kept for Last-Event-ID resume (10k). */
export const REPLAY_RING_ENTRIES = 10_000;
/** Daemon heartbeat cadence on the down stream (15 s). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Down-stream silence deadline (30 s): no envelope by then = dead pair. */
export const SILENCE_DEADLINE_MS = 30_000;
/** Pair credential renewal interval (5 min). */
export const PAIR_RENEWAL_MS = 5 * 60_000;
/** Wait for the daemon's pair-ready confirmation (60 s). */
export const PAIR_READY_TIMEOUT_MS = 60_000;
/** Wait for a parked/suspended daemon to wake (60 s). */
export const WAKE_TIMEOUT_MS = 60_000;
/** Reconnect backoff ramp, jittered (1 s → 30 s). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** Command dedup window: same command id within a workspace (60 s / 64 entries). */
export const DEDUP_WINDOW_MS = 60_000;
export const DEDUP_WINDOW_ENTRIES = 64;
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
};

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
	version: 1;
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

/** Parse one NDJSON record / SSE data payload into a validated envelope. */
export function decodeEnvelope(line: string): CallbackEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (cause) {
		throw new CallbackError("invalid_request", "callback envelope is not valid JSON", { cause });
	}
	return validateEnvelope(value);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b.slice();
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** Incremental NDJSON parser over raw HTTP chunks. */
export interface NdjsonParser {
	/** Feed one HTTP chunk; returns every record completed by it (may be empty). */
	push(chunk: Uint8Array | string): string[];
	/** Flush at end-of-body; a trailing non-blank record without a newline is legal. */
	end(): string[];
	/** Bytes buffered since the last record boundary (bounded by the record cap). */
	readonly bufferedBytes: number;
}

/**
 * Create an incremental NDJSON record parser for POST /callback/up bodies.
 * Bytes accumulate until a newline and only complete records are decoded, so
 * HTTP chunk boundaries are not message boundaries and multi-byte UTF-8
 * sequences split across chunks stay intact (0x0a can never occur inside a
 * UTF-8 multi-byte sequence). A record longer than `maxRecordBytes` (default
 * ENVELOPE_MAX_BYTES) or invalid UTF-8 throws CallbackError("invalid_request").
 * Blank lines are skipped; a trailing CR is tolerated.
 */
export function createNdjsonParser(opts?: { maxRecordBytes?: number }): NdjsonParser {
	const maxRecordBytes = opts?.maxRecordBytes ?? ENVELOPE_MAX_BYTES;
	let pending: Uint8Array = new Uint8Array(0);

	const overSize = (length: number): CallbackError =>
		new CallbackError(
			"invalid_request",
			`invalid ndjson stream: record is ${length} bytes, over the ${maxRecordBytes}-byte record limit`,
		);

	const decodeRecord = (): string | undefined => {
		if (pending.length === 0) return undefined;
		let line = pending;
		if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		pending = new Uint8Array(0);
		if (line.length === 0) return undefined;
		if (line.length > maxRecordBytes) throw overSize(line.length);
		try {
			return utf8Strict.decode(line);
		} catch (cause) {
			throw new CallbackError(
				"invalid_request",
				"invalid ndjson stream: record is not valid UTF-8",
				{ cause },
			);
		}
	};

	return {
		get bufferedBytes(): number {
			return pending.length;
		},
		push(chunk) {
			const bytes = typeof chunk === "string" ? utf8.encode(chunk) : chunk;
			const out: string[] = [];
			let start = 0;
			for (;;) {
				const nl = bytes.indexOf(0x0a, start);
				if (nl === -1) break;
				pending = concatBytes(pending, bytes.subarray(start, nl));
				const record = decodeRecord();
				if (record !== undefined) out.push(record);
				start = nl + 1;
			}
			if (start < bytes.length) {
				pending = concatBytes(pending, bytes.subarray(start));
				if (pending.length > maxRecordBytes) throw overSize(pending.length);
			}
			return out;
		},
		end() {
			const record = decodeRecord();
			return record === undefined ? [] : [record];
		},
	};
}

/**
 * Encode one envelope as a complete SSE event block on the down stream:
 * event name is the envelope kind, id is the envelope seq (Last-Event-ID
 * resume), data is the canonical JSON. Reuses shared/sse.ts conventions.
 */
export function encodeSseEnvelope(envelope: CallbackEnvelope): string {
	return encodeSseEvent(envelope.kind, envelope, envelope.seq);
}

/**
 * Async-iterate validated envelopes from a /callback/down response body.
 * Reuses parseSseUnits (partial-chunk, CRLF, multi-line-data handling).
 * Comments and the transport `ping` keepalive are consumed silently —
 * observable liveness comes from `heartbeat` envelopes (15 s cadence vs the
 * 30 s silence deadline). Malformed event data throws
 * CallbackError("invalid_request"). The event name mirrors the envelope kind
 * by convention but only the data is validated.
 */
export async function* parseSseEnvelope(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<CallbackEnvelope> {
	for await (const unit of parseSseUnits(body)) {
		if (unit.kind !== "event" || unit.event === SSE_PING_EVENT) continue;
		let value: unknown;
		try {
			value = JSON.parse(unit.data);
		} catch (cause) {
			throw new CallbackError("invalid_request", "sse event data is not valid JSON", { cause });
		}
		yield validateEnvelope(value);
	}
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
 * envelope's identity fields and seq — the sender assigns fresh monotonic
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

/**
 * Outcome of a dedup-gated command submission (ledger: "Dedup: command id
 * within workspace, existing 60 s / 64-entry window").
 *
 * - "accepted" — the id was fresh; the caller may submit it. The window
 *   records a pending entry until confirmAccepted is called.
 * - "not_submitted" — duplicate of a prior submission already confirmed
 *   accepted: safe to skip; do not resend.
 * - "unknown" — duplicate of a prior submission whose daemon acceptance was
 *   never confirmed (e.g. the connection died mid-flight): the caller must
 *   not assume either acceptance or loss.
 */
export type CommandSubmitOutcome = "not_submitted" | "accepted" | "unknown";

/**
 * Command-identity dedup window. Identity is the (workspaceId, commandId)
 * pair exactly — payloads are never fingerprinted, and a fresh id is always
 * "accepted" even if its payload matches an earlier different-id command.
 */
export interface DedupWindow {
	submit(workspaceId: string, commandId: string, now?: number): CommandSubmitOutcome;
	/** Mark a submission accepted by the daemon; duplicates within the window then report "not_submitted". Returns whether the entry existed. */
	confirmAccepted(workspaceId: string, commandId: string): boolean;
	/** Unrecord a submission that never left (transport failed before submit); a retry then reports "accepted" again. Returns whether an entry existed. */
	release(workspaceId: string, commandId: string): boolean;
	/** Live (unexpired) entry count for a workspace. */
	size(workspaceId: string, now?: number): number;
}

/**
 * Per-workspace command dedup window: DEDUP_WINDOW_MS since first sight, at
 * most DEDUP_WINDOW_ENTRIES ids per workspace (oldest evicted first).
 * Entries expire from first submission regardless of confirmation.
 */
export function createDedupWindow(opts?: { windowMs?: number; capacity?: number }): DedupWindow {
	const windowMs = opts?.windowMs ?? DEDUP_WINDOW_MS;
	const capacity = opts?.capacity ?? DEDUP_WINDOW_ENTRIES;
	interface Entry {
		at: number;
		accepted: boolean;
	}
	interface Bucket {
		order: string[];
		entries: Map<string, Entry>;
	}
	const workspaces = new Map<string, Bucket>();

	const evictExpired = (bucket: Bucket, now: number): void => {
		for (;;) {
			const oldest = bucket.order[0];
			if (oldest === undefined) break;
			const entry = bucket.entries.get(oldest);
			if (entry && now - entry.at < windowMs) break;
			bucket.order.shift();
			bucket.entries.delete(oldest);
		}
	};

	return {
		submit(workspaceId, commandId, now = Date.now()) {
			let bucket = workspaces.get(workspaceId);
			if (!bucket) {
				bucket = { order: [], entries: new Map() };
				workspaces.set(workspaceId, bucket);
			}
			evictExpired(bucket, now);
			const existing = bucket.entries.get(commandId);
			if (existing) return existing.accepted ? "not_submitted" : "unknown";
			bucket.entries.set(commandId, { at: now, accepted: false });
			bucket.order.push(commandId);
			while (bucket.order.length > capacity) {
				const oldest = bucket.order.shift();
				if (oldest !== undefined) bucket.entries.delete(oldest);
			}
			return "accepted";
		},
		confirmAccepted(workspaceId, commandId) {
			const entry = workspaces.get(workspaceId)?.entries.get(commandId);
			if (!entry) return false;
			entry.accepted = true;
			return true;
		},
		release(workspaceId, commandId) {
			const bucket = workspaces.get(workspaceId);
			if (!bucket?.entries.has(commandId)) return false;
			bucket.entries.delete(commandId);
			const at = bucket.order.indexOf(commandId);
			if (at !== -1) bucket.order.splice(at, 1);
			return true;
		},
		size(workspaceId, now = Date.now()) {
			const bucket = workspaces.get(workspaceId);
			if (!bucket) return 0;
			evictExpired(bucket, now);
			return bucket.entries.size;
		},
	};
}
