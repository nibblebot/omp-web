/**
 * Fleet-side callback transport (clone-plan P3.3): the fleet half of the
 * OMP_CALLBACK_PROTO 1 outbound callback pair. Contracts:
 * docs/clone-contracts.md "Callback transport" / "Typed errors"; wire
 * vocabulary from shared/callback-protocol.ts. Daemons dial OUT to the
 * fleet; the fleet never dials in, and there is NO durable offline command
 * queue: sendToDaemon with no live pair fails `unavailable`, never buffers.
 *
 * Routes (mounted by handleFetch; identity rides HEADERS ONLY; the URL
 * alone never enrolls, authenticates, or authorizes anything):
 *
 *   POST /callback/up                    Long-lived NDJSON upload of daemon
 *                                        envelopes, parsed incrementally;
 *                                        HTTP chunk boundaries are never
 *                                        record boundaries (createNdjsonParser
 *                                        over the raw byte chunks). Bounded:
 *                                        1 MiB per record (validateEnvelope),
 *                                        8 MiB total per connection, seq
 *                                        strictly monotonic (first record
 *                                        seq ≥ 1). The request body is read
 *                                        to completion inside the handler
 *                                        (Bun cancels a body on early
 *                                        Response), so the up Response is
 *                                        the END-of-up signal: 200
 *                                        {ok, received} = clean upload end;
 *                                        4xx/5xx typed JSON = rejection.
 *   GET  /callback/down                  Long-lived SSE downlink. Per-
 *                                        connection 10k-entry replay ring
 *                                        (byte-budgeted like every other
 *                                        ring); Last-Event-ID resumes by the
 *                                        registry-assigned down seq (starts
 *                                        at 1). 15 s heartbeat envelopes.
 *   POST /callback/bulk/<correlationId>  Daemon-initiated bounded bulk
 *                                        transfer (64 MiB cap) correlated to
 *                                        a fleet-issued id from
 *                                        createBulkCorrelation. Completion
 *                                        is transport receipt, state
 *                                        "received", NEVER archive
 *                                        acceptance.
 *
 * Pair establishment: once both halves for a connectionId are live, the
 * fleet emits ONE control envelope on the down half (streamId "transport",
 * payload {type:"pair_ready", connectionId, generation}); a daemon resolves
 * start() on it (PAIR_READY_TIMEOUT_MS deadline). It rides the replay ring,
 * so a resuming redial re-delivers it; idempotent by connectionId. All
 * transport-generated envelopes (pair_ready, heartbeats) carry streamId
 * "transport" so they pass validateEnvelope on the daemon side.
 *
 * Auth on every route: x-omp-workspace-id, x-omp-generation,
 * x-omp-connection-id (up may also establish it from the first envelope),
 * and `authorization: Bearer <enrollment credential>`. Enrollment is
 * explicit (enrollWorkspace): ONLY the SHA-256 digest of the 256-bit
 * credential is stored, scoped to workspace+generation; comparison is
 * timing-safe (crypto.timingSafeEqual over fixed-size digests). A verified
 * credential at a superseded generation is 409 `generation_obsolete`
 * (actionable for a stale daemon); anything unverified is 401 (no
 * existence oracle). Statuses come from the frozen
 * CALLBACK_ERROR_HTTP_STATUS map; the only non-map statuses are routing
 * responses (405 method mismatch, 404-shaped unknown-correlation
 * invalid_request).
 *
 * Virtual streams: a daemon envelope carries the logical streamId of its
 * consumer (one per browser/control client). attachVirtualStream binds a
 * sink per (workspaceId, streamId); queues are bounded at 4 MiB with an
 * explicit onBackpressure signal (excess drops oldest-frame-first and is
 * counted in pairStatus). The drain is fair: command/control/ack envelopes
 * ALWAYS dequeue before frame envelopes, and frames rotate round-robin
 * across streams, so a multi-MiB history transfer can never starve
 * command/control traffic or other clients. An envelope for a streamId with
 * no attached sink is dropped by design (bounded transport); the fleet
 * edge attaches sinks before letting traffic flow.
 *
 * Main (fleet/server.ts) mounts this as the first responder for the
 * /callback prefix:
 *
 *   fetch: (req) => transport.handleFetch(req) ?? nextRoutes(req)
 *
 * handleFetch resolves a Response for /callback/* paths (typed-error JSON
 * {error, message, detail?} on failures) and null for anything else;
 * non-callback paths are not this module's business.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
	BULK_MAX_BYTES,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_DOWN_PATH,
	CALLBACK_ERROR_HTTP_STATUS,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_UP_PATH,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_KINDS,
	type CallbackEnvelope,
	type CallbackError,
	callbackError,
	createNdjsonParser,
	encodeSseEnvelope,
	ENROLLMENT_KEY_BYTES,
	ENVELOPE_MAX_BYTES,
	CONNECTION_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	isCallbackError,
	REPLAY_RING_ENTRIES,
	SILENCE_DEADLINE_MS,
	STREAM_MAX_BYTES,
	type CallbackKind,
	validateEnvelope,
} from "#lib/wire/callback-protocol";
import type { FleetLogStore } from "./log-store";
import {
	MATERIALIZE_REQUEST_MAX_BYTES,
	MATERIALIZE_TRANSFER_MAX_BYTES,
	emitMaterializeTransfer,
	parseMaterializeRequest,
	planMaterializeFiles,
	type MaterializeRequest,
} from "#lib/session-files/wake-materialize";
import { SseRing } from "#lib/wire/sse";

/**
 * Byte budget for one down replay ring. The ledger bounds the ring at
 * REPLAY_RING_ENTRIES (10k); this mirrors the shared SSE ring convention as
 * the memory-safety secondary bound (a few 1 MiB frames must not balloon a
 * single ring).
 */
const REPLAY_RING_BYTES = 8 * 1024 * 1024;
/** Rings with no live connection and no activity for this long are dropped. */
const RING_IDLE_MS = 10 * 60_000;
/** Open bulk correlations older than this expire as failed; settled ones are reaped. */
const BULK_TTL_MS = 10 * 60_000;
/** Registry sweep cadence: up-connection silence, ring idleness, bulk expiry. */
const SWEEP_INTERVAL_MS = 5_000;

const utf8ByteLength = new TextEncoder();

function envelopeBytes(envelope: CallbackEnvelope): number {
	return utf8ByteLength.encode(JSON.stringify(envelope)).length;
}

/** Assemble a capture correlation's buffered parts (total bounded by BULK_MAX_BYTES). */
function concatBuffers(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Canonical 32-byte credential. Accepts 64-char hex, base64/base64url of
 * exactly 32 bytes, or raw bytes. Anything else throws (callers map that to
 * the ledger code they owe the caller). */
function parseCredential(raw: string | Uint8Array): Uint8Array {
	if (typeof raw === "string") {
		const text = raw.trim();
		if (/^[0-9a-fA-F]{64}$/.test(text)) return new Uint8Array(Buffer.from(text, "hex"));
		const decoded = new Uint8Array(Buffer.from(text, "base64"));
		if (decoded.length === ENROLLMENT_KEY_BYTES) return decoded;
	} else if (raw.length === ENROLLMENT_KEY_BYTES) {
		return raw;
	}
	throw new Error("credential must be exactly 32 bytes (64-char hex or base64)");
}

function sha256Digest(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

/** Timing-safe digest comparison; the equal-length guard first so a length
 * mismatch cannot throw timingSafeEqual (which would itself leak timing). */
function digestEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

const enrollmentKey = (workspaceId: string, generation: number): string =>
	`${workspaceId}\u0000${generation}`;

function parseLastEventId(raw: string | null): number {
	if (raw === null || raw === "") return 0;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw callbackError("invalid_request", `malformed Last-Event-ID ${JSON.stringify(raw)}`, {
			detail: "expected a non-negative integer seq",
		});
	}
	return value;
}

/** Typed-error JSON body {error, message, detail?} at the frozen status. */
function errorResponse(error: CallbackError): Response {
	return Response.json(
		{
			error: error.code,
			message: error.message,
			...(error.detail !== undefined ? { detail: error.detail } : {}),
		},
		{ status: CALLBACK_ERROR_HTTP_STATUS[error.code] },
	);
}

function routeResponse(method: string, path: string, allow: string): Response {
	return Response.json(
		{ error: "invalid_request", message: `method ${method} is not allowed for ${path}` },
		{ status: 405, headers: { allow } },
	);
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

interface Enrollment {
	workspaceId: string;
	generation: number;
	/** SHA-256 of the 256-bit credential; the raw credential is never stored. */
	credentialHash: Uint8Array;
	createdAt: number;
	revoked: boolean;
}

interface UpConnection {
	workspaceId: string;
	generation: number;
	/** The callback-pair id: from the header or the first envelope. */
	connectionId: string | null;
	lastSeq: number;
	bytesIn: number;
	envelopes: number;
	lastDataAt: number;
	silenceKilled: boolean;
	reader: ReadableStreamDefaultReader<Uint8Array> | null;
	pairAnnounced: boolean;
}

interface RingRecord {
	connectionId: string;
	workspaceId: string;
	generation: number;
	ring: SseRing<string>;
	/** Fleet-assigned down-side seq; strictly monotonic per connectionId. */
	nextSeq: number;
	lastActiveAt: number;
}

interface DownConnection {
	connectionId: string;
	workspaceId: string;
	generation: number;
	record: RingRecord;
	encoder: TextEncoder;
	controller: ReadableStreamDefaultController<Uint8Array>;
	/** Serializes wire writes so envelope order is preserved. */
	sendChain: Promise<void>;
	lastSendAt: number;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	closed: boolean;
	pairAnnounced: boolean;
}

interface VirtualStream {
	workspaceId: string;
	streamId: string;
	sink: VirtualStreamSink;
	/** command/control/ack: always drained before any frame. */
	high: CallbackEnvelope[];
	/** frame: exactly one per stream per round-robin rotation. */
	low: CallbackEnvelope[];
	bytes: number;
	dropped: number;
}

interface PumpState {
	running: boolean;
	pending: boolean;
	cursor: number;
}

interface BulkRecord {
	correlationId: string;
	workspaceId: string;
	createdAt: number;
	state: "open" | "received" | "failed";
	/** Aggregate bytes across every part of the transfer. */
	bytes: number;
	/** Capture correlations buffer the payload for the fleet requester (downloads). */
	capture: boolean;
	chunks: Uint8Array[];
	/** Next expected x-omp-bulk-part number (0-based, strictly sequential). */
	nextPart: number;
	resolve: (result: BulkResult) => void;
}

/** Consumer of one virtual stream. deliver is awaited by the registry; a
 * slow sink parks only its own workspace's pump, never the transport. */
export interface VirtualStreamSink {
	deliver(envelope: CallbackEnvelope): void | Promise<void>;
	/** Fired synchronously when the 4 MiB queue bound drops an envelope. */
	onBackpressure?(info: {
		workspaceId: string;
		streamId: string;
		queuedBytes: number;
		dropped: number;
	}): void;
}

export interface VirtualStreamStatus {
	streamId: string;
	queued: number;
	queuedBytes: number;
	dropped: number;
}

export interface PairStatus {
	workspaceId: string;
	enrolled: boolean;
	/** Highest non-revoked enrolled generation; null when never enrolled. */
	authorizedGeneration: number | null;
	paired: boolean;
	connectionId: string | null;
	/** Most recent pair's replay ring depth (Last-Event-ID resume supply). */
	replayDepth: number;
	lastEnvelopeAt: number | null;
	lastDownSendAt: number | null;
	envelopesReceived: number;
	upBytesIn: number;
	streams: VirtualStreamStatus[];
}

/** Registry-issued bulk transfer handle. `done` never rejects: a failed
 * upload (cap exceeded, aborted, expired) settles as state "failed". */
export interface BulkCorrelation {
	correlationId: string;
	done: Promise<BulkResult>;
}

export interface BulkResult {
	correlationId: string;
	workspaceId: string;
	/** "received" is transport receipt only; NEVER archive acceptance. */
	state: "received" | "failed";
	/** Aggregate bytes across all parts of the transfer. */
	bytes: number;
	error?: string;
	/** Buffered payload, present only on received capture correlations. */
	data?: Uint8Array<ArrayBuffer>;
}

/** sendToDaemon input: streamId/kind/payload required; version, workspaceId,
 * generation, connectionId, seq and at are owned by the registry (supplied
 * values for those are ignored). */
export type CallbackEnvelopeInput = Partial<CallbackEnvelope> &
	Pick<CallbackEnvelope, "streamId" | "kind" | "payload">;

export class DaemonTransportRegistry {
	readonly #enrollments = new Map<string, Enrollment>();
	readonly #upConnections = new Set<UpConnection>();
	readonly #downConnections = new Map<string, DownConnection>();
	readonly #rings = new Map<string, RingRecord>();
	readonly #virtualStreams = new Map<string, Map<string, VirtualStream>>();
	readonly #taps = new Map<string, Set<(envelope: CallbackEnvelope) => void>>();
	readonly #pumps = new Map<string, PumpState>();
	readonly #bulk = new Map<string, BulkRecord>();
	/** Pair-ready/teardown observers per workspace (edge stream_open re-sends). */
	readonly #pairListeners = new Map<string, Set<(status: PairStatus) => void>>();
	/** P8.9 wake materialization: log-store source for bulk materialization
	 * transfers, wired by the fleet server after the store loads. Null =
	 * no store (the fleet rejects materialization requests typed
	 * `unavailable`). */
	#materializeStore: FleetLogStore | null = null;
	readonly #sweepTimer: ReturnType<typeof setInterval>;

	constructor() {
		this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
		unrefTimer(this.#sweepTimer);
	}

	// --- enrollment -----------------------------------------------------------

	/** Store ONLY the SHA-256 digest of the 256-bit credential, scoped to
	 * workspace+generation. Idempotent for the same digest; a different
	 * digest for an already-enrolled, non-revoked generation is a `conflict`.
	 * Knowing a callback URL enrolls nothing. Returns the sha-256 hex digest
	 * of the enrolled credential so callers can persist it (never the
	 * credential itself). */
	enrollWorkspace(
		workspaceId: string,
		generation: number,
		credential: string | Uint8Array,
	): string {
		if (!workspaceId)
			throw callbackError("invalid_request", "enrollWorkspace requires a workspaceId");
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw callbackError(
				"invalid_request",
				`enrollWorkspace requires a positive integer generation, got ${generation}`,
			);
		}
		let digest: Uint8Array;
		try {
			digest = sha256Digest(parseCredential(credential));
		} catch (cause) {
			throw callbackError(
				"invalid_request",
				`enrollment credential for workspace ${workspaceId} generation ${generation} is not a usable 256-bit secret`,
				{ cause },
			);
		}
		const key = enrollmentKey(workspaceId, generation);
		const existing = this.#enrollments.get(key);
		if (existing && !existing.revoked) {
			if (!digestEqual(digest, existing.credentialHash)) {
				throw callbackError(
					"conflict",
					`workspace ${workspaceId} generation ${generation} is already enrolled with a different credential`,
				);
			}
			return Buffer.from(digest).toString("hex");
		}
		this.#enrollments.set(key, {
			workspaceId,
			generation,
			credentialHash: digest,
			createdAt: Date.now(),
			revoked: false,
		});
		return Buffer.from(digest).toString("hex");
	}

	/** Boot re-enrollment from a persisted binding: like
	 * {@link enrollWorkspace} but the credential is ALREADY the sha-256
	 * digest (a persisted hex hash), so nothing is hashed or re-derived
	 * here; the raw credential is never available at boot. Validates the
	 * 64-char hex shape, then stores the same in-memory record issuance
	 * would. Idempotent: re-loading the same binding is a no-op; a
	 * different hash for the same non-revoked workspace+generation is a
	 * `conflict` (the state file and transport disagree; refuse rather
	 * than silently override). */
	enrollPersisted(workspaceId: string, generation: number, credentialHash: string): void {
		if (!workspaceId)
			throw callbackError("invalid_request", "enrollPersisted requires a workspaceId");
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw callbackError(
				"invalid_request",
				`enrollPersisted requires a positive integer generation, got ${generation}`,
			);
		}
		if (typeof credentialHash !== "string" || !/^[0-9a-f]{64}$/.test(credentialHash)) {
			throw callbackError(
				"invalid_request",
				`persisted enrollment hash for workspace ${workspaceId} generation ${generation} is not a sha-256 hex digest`,
			);
		}
		const digest = new Uint8Array(Buffer.from(credentialHash, "hex"));
		const key = enrollmentKey(workspaceId, generation);
		const existing = this.#enrollments.get(key);
		if (existing && !existing.revoked) {
			if (!digestEqual(digest, existing.credentialHash)) {
				throw callbackError(
					"conflict",
					`workspace ${workspaceId} generation ${generation} is already enrolled with a different credential`,
				);
			}
			return;
		}
		this.#enrollments.set(key, {
			workspaceId,
			generation,
			credentialHash: digest,
			createdAt: Date.now(),
			revoked: false,
		});
	}

	/** Revoke one generation (or all generations of the workspace). Live
	 * callback pairs in the revoked scope are torn down immediately. */
	revokeEnrollment(workspaceId: string, generation?: number): void {
		for (const record of this.#enrollments.values()) {
			if (record.workspaceId !== workspaceId) continue;
			if (generation !== undefined && record.generation !== generation) continue;
			record.revoked = true;
		}
		const inScope = (conn: UpConnection | DownConnection): boolean =>
			generation === undefined ? true : conn.generation === generation;
		for (const conn of [...this.#upConnections]) {
			if (conn.workspaceId === workspaceId && inScope(conn)) this.#killUp(conn);
		}
		for (const conn of [...this.#downConnections.values()]) {
			if (conn.workspaceId === workspaceId && inScope(conn)) this.#teardownDown(conn);
		}
	}

	#maxEnrolledGeneration(workspaceId: string): number | null {
		let max: number | null = null;
		for (const record of this.#enrollments.values()) {
			if (record.workspaceId !== workspaceId || record.revoked) continue;
			if (max === null || record.generation > max) max = record.generation;
		}
		return max;
	}

	/** Workspaces with at least one non-revoked enrolled generation. */
	enrolledWorkspaceIds(): string[] {
		const ids = new Set<string>();
		for (const record of this.#enrollments.values()) {
			if (!record.revoked) ids.add(record.workspaceId);
		}
		return [...ids];
	}

	#verifyEnrollment(workspaceId: string, generation: number, credential: Uint8Array): void {
		const record = this.#enrollments.get(enrollmentKey(workspaceId, generation));
		const verified =
			record !== undefined &&
			!record.revoked &&
			digestEqual(sha256Digest(credential), record.credentialHash);
		if (!verified) {
			throw callbackError(
				"unauthorized",
				`enrollment credential rejected for workspace ${workspaceId} generation ${generation}`,
			);
		}
		// Verified but superseded: the actionable 409 lets a stale daemon die
		// with a reason instead of retrying forever.
		const maxGeneration = this.#maxEnrolledGeneration(workspaceId);
		if (maxGeneration !== null && generation < maxGeneration) {
			throw callbackError(
				"generation_obsolete",
				`workspace ${workspaceId} is authorized at generation ${maxGeneration}; this connection claimed ${generation}`,
				{
					detail: `authorizedGeneration=${maxGeneration} claimedGeneration=${generation}`,
				},
			);
		}
	}

	#authenticate(
		req: Request,
		opts: { requireConnectionId?: boolean } = {},
	): { workspaceId: string; generation: number; connectionId?: string } {
		const workspaceId = req.headers.get("x-omp-workspace-id") ?? "";
		const generationRaw = req.headers.get("x-omp-generation") ?? "";
		const connectionId = req.headers.get("x-omp-connection-id") ?? undefined;
		const authorization = req.headers.get("authorization") ?? "";
		const bearer = /^bearer\s+(.+)$/i.exec(authorization);
		const credentialRaw = bearer?.[1]?.trim() ?? "";
		if (!workspaceId) throw callbackError("invalid_identity", "missing x-omp-workspace-id header");
		if (!generationRaw) throw callbackError("invalid_identity", "missing x-omp-generation header");
		const generation = Number(generationRaw);
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw callbackError(
				"invalid_identity",
				`malformed x-omp-generation ${JSON.stringify(generationRaw)}`,
				{
					detail: "expected a positive integer",
				},
			);
		}
		let credential: Uint8Array;
		try {
			credential = parseCredential(credentialRaw);
		} catch (cause) {
			throw callbackError("unauthorized", "missing or malformed enrollment credential", {
				detail:
					"expected a 256-bit credential in authorization: Bearer (hex or base64); it is never taken from the URL",
				cause,
			});
		}
		this.#verifyEnrollment(workspaceId, generation, credential);
		if (opts.requireConnectionId && !connectionId) {
			throw callbackError("invalid_identity", "missing x-omp-connection-id header");
		}
		return { workspaceId, generation, connectionId };
	}

	// --- routing ---------------------------------------------------------------

	/** Fleet-server mount: resolves a Response for /callback/* paths and null
	 * for anything else. */
	async handleFetch(req: Request): Promise<Response | null> {
		const path = new URL(req.url).pathname;
		try {
			if (path === CALLBACK_UP_PATH) {
				return req.method === "POST"
					? await this.#handleUp(req)
					: routeResponse(req.method, path, "POST");
			}
			if (path === CALLBACK_DOWN_PATH) {
				return req.method === "GET"
					? this.#handleDown(req)
					: routeResponse(req.method, path, "GET");
			}
			if (path.startsWith(CALLBACK_BULK_PATH_PREFIX)) {
				if (req.method !== "POST") return routeResponse(req.method, path, "POST");
				const rawId = path.slice(CALLBACK_BULK_PATH_PREFIX.length);
				let correlationId = rawId;
				try {
					correlationId = decodeURIComponent(rawId);
				} catch {
					// Malformed escape: keep the raw segment; the correlation
					// lookup rejects unless it matches a fleet-issued id verbatim.
				}
				if (!correlationId || correlationId.includes("/")) {
					return errorResponse(
						callbackError("invalid_request", `malformed bulk correlation path ${path}`, {
							detail: `expected ${CALLBACK_BULK_PATH_PREFIX}<correlationId>`,
						}),
					);
				}
				// P8.9 wake materialization: a bulk POST whose body is a small
				// MaterializeRequest is a DOWNLOAD request; the daemon mints
				// the correlation id (never issued by the fleet, so no bulk
				// record exists) and the fleet serves the workspace's stored
				// session bytes as an NDJSON response. Fleet-issued upload
				// correlations always HAVE a bulk record. The record map is
				// therefore the discriminator, checked BEFORE any body read:
				// a known upload correlation goes straight to #handleBulk
				// (never peeked, never cancelled); only an UNKNOWN correlation
				// (daemon-minted materialize id) reads its small bounded body
				// to confirm the request. Authentication is the same
				// enrollment as any callback request, so unknown correlations
				// cannot be probed.
				if (!this.#bulk.has(correlationId)) {
					const materialized = await this.#maybeHandleMaterialize(req);
					if (materialized !== null) return materialized;
				}
				return await this.#handleBulk(req, correlationId);
			}
			return null;
		} catch (error) {
			// Auth/enrollment/correlation rejections surface as typed JSON,
			// never an uncaught 500; the frozen status map owns the status.
			if (isCallbackError(error)) return errorResponse(error);
			throw error;
		}
	}

	// --- up: POST /callback/up --------------------------------------------------

	/**
	 * Long-lived NDJSON upload. The body is consumed to completion (Bun
	 * cancels the body on early Response), so the Response is the END-of-up
	 * signal: 200 {ok, received} = clean end; typed error = rejection; the
	 * pair-ready signal rides the DOWN half, never this response.
	 */
	async #handleUp(req: Request): Promise<Response> {
		const auth = this.#authenticate(req);
		const conn: UpConnection = {
			workspaceId: auth.workspaceId,
			generation: auth.generation,
			connectionId: auth.connectionId ?? null,
			lastSeq: 0,
			bytesIn: 0,
			envelopes: 0,
			lastDataAt: Date.now(),
			silenceKilled: false,
			reader: null,
			pairAnnounced: false,
		};
		this.#upConnections.add(conn);
		// Header-borne connectionId: the up half may complete the pair (down
		// dialed first), announce without waiting for the first envelope.
		this.#maybeAnnouncePairReady(conn);
		if (req.body === null) {
			this.#upConnections.delete(conn);
			return Response.json({ ok: true, received: 0 });
		}
		const parser = createNdjsonParser();
		try {
			conn.reader = req.body.getReader();
			for (;;) {
				const { done, value } = await conn.reader.read();
				if (done) break;
				conn.lastDataAt = Date.now();
				conn.bytesIn += value.byteLength;
				if (conn.bytesIn > CONNECTION_MAX_BYTES) {
					throw callbackError(
						"invalid_request",
						`callback up connection buffered past the ${CONNECTION_MAX_BYTES}-byte connection cap`,
						{
							detail: `bytesIn=${conn.bytesIn}`,
						},
					);
				}
				for (const record of parser.push(value)) this.#acceptUpRecord(conn, record);
			}
			for (const record of parser.end()) this.#acceptUpRecord(conn, record);
			if (conn.silenceKilled) {
				throw callbackError(
					"unavailable",
					`callback up connection silent past the ${SILENCE_DEADLINE_MS} ms silence deadline`,
				);
			}
			return Response.json({ ok: true, received: conn.envelopes });
		} catch (error) {
			if (isCallbackError(error)) return errorResponse(error);
			// The platform aborted the body (daemon dropped the upload); any
			// status is unobservable; respond typed for symmetry.
			return Response.json(
				{ error: "unavailable", message: "callback up connection aborted" },
				{ status: 503 },
			);
		} finally {
			this.#upConnections.delete(conn);
			this.#emitPairChange(conn.workspaceId);
		}
	}

	#acceptUpRecord(conn: UpConnection, record: string): void {
		let value: unknown;
		try {
			value = JSON.parse(record);
		} catch (cause) {
			throw callbackError("invalid_request", "callback record is not valid JSON", { cause });
		}
		const envelope = validateEnvelope(value);
		if (envelope.workspaceId !== conn.workspaceId || envelope.generation !== conn.generation) {
			throw callbackError(
				"forbidden",
				"callback envelope identity does not match the authenticated connection",
				{
					detail: `envelope=${envelope.workspaceId}@${envelope.generation} connection=${conn.workspaceId}@${conn.generation}`,
				},
			);
		}
		if (conn.connectionId === null) {
			conn.connectionId = envelope.connectionId;
			this.#maybeAnnouncePairReady(conn);
		} else if (envelope.connectionId !== conn.connectionId) {
			throw callbackError(
				"invalid_request",
				"callback envelope connectionId changed mid-connection",
			);
		}
		if (envelope.seq <= conn.lastSeq) {
			throw callbackError(
				"invalid_request",
				`callback envelope seq ${envelope.seq} is not monotonic (connection last seq ${conn.lastSeq})`,
			);
		}
		conn.lastSeq = envelope.seq;
		conn.envelopes += 1;
		this.#dispatchUpEnvelope(conn, envelope);
	}

	#dispatchUpEnvelope(conn: UpConnection, envelope: CallbackEnvelope): void {
		if (envelope.kind === "heartbeat") return; // transport liveness only
		for (const tap of this.#taps.get(conn.workspaceId) ?? []) {
			try {
				tap(envelope);
			} catch {
				// a fleet tap must never break the transport
			}
		}
		const stream = this.#virtualStreams.get(conn.workspaceId)?.get(envelope.streamId);
		if (stream) this.#enqueueVirtual(stream, envelope);
		// No sink for this streamId: dropped by design (bounded transport).
	}

	/** Emit the single pair_ready control once BOTH halves of a connectionId
	 * are live. Called from up-open/first-envelope and down-open. */
	#maybeAnnouncePairReady(candidate: UpConnection | DownConnection): void {
		const connectionId = candidate.connectionId;
		if (!connectionId) return;
		const up = [...this.#upConnections].find((c) => c.connectionId === connectionId);
		const down = this.#downConnections.get(connectionId);
		if (!up || !down || (up.pairAnnounced && down.pairAnnounced)) return;
		up.pairAnnounced = true;
		down.pairAnnounced = true;
		this.#sendDownEnvelope(down, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: { type: CALLBACK_PAIR_READY_TYPE, connectionId, generation: down.generation },
		});
		this.#emitPairChange(down.workspaceId);
	}

	// --- down: GET /callback/down -------------------------------------------------

	/** Long-lived SSE downlink with 10k-entry replay ring and 15 s heartbeats. */
	#handleDown(req: Request): Response {
		const auth = this.#authenticate(req, { requireConnectionId: true });
		const lastEventId = parseLastEventId(req.headers.get("last-event-id"));
		const connectionId = auth.connectionId as string;
		const record = this.#ringFor(connectionId, auth.workspaceId, auth.generation);
		const replaced = this.#downConnections.get(connectionId);
		if (replaced) this.#teardownDown(replaced);
		const encoder = new TextEncoder();
		const conn: DownConnection = {
			connectionId,
			workspaceId: auth.workspaceId,
			generation: auth.generation,
			record,
			encoder,
			controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
			sendChain: Promise.resolve(),
			lastSendAt: Date.now(),
			heartbeatTimer: null,
			closed: false,
			pairAnnounced: false,
		};
		const body = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					conn.controller = controller;
				},
				cancel: () => {
					this.#teardownDown(conn);
				},
			},
			// Byte-counted queuing strategy (finding: a default chunk-counted
			// strategy made desiredSize a CHUNK count, never below the
			// byte budget regardless of how many unread bytes accumulated,
			// so #writeDown's drop-and-resume could not trip and a stalled
			// daemon buffered unbounded bytes). Mirroring the browser edge's
			// byte strategy, desiredSize is now a true byte fill level and
			// the frozen per-connection CONNECTION_MAX_BYTES bound holds.
			{
				highWaterMark: CONNECTION_MAX_BYTES,
				size: (chunk) => (chunk as Uint8Array).byteLength,
			},
		);
		// Replay BEFORE live registration; sendToDaemon only sees live
		// connections and there is no await between the two, so a fresh
		// command can never interleave into the replay window.
		for (const entry of record.ring.after(lastEventId)) {
			conn.controller.enqueue(encoder.encode(entry.value));
		}
		this.#downConnections.set(connectionId, conn);
		conn.heartbeatTimer = setInterval(() => {
			if (!conn.closed) {
				this.#sendDownEnvelope(conn, {
					streamId: CALLBACK_TRANSPORT_STREAM_ID,
					kind: "heartbeat",
					payload: {},
				});
			}
		}, HEARTBEAT_INTERVAL_MS);
		unrefTimer(conn.heartbeatTimer);
		this.#maybeAnnouncePairReady(conn);
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
		});
	}

	#ringFor(connectionId: string, workspaceId: string, generation: number): RingRecord {
		const existing = this.#rings.get(connectionId);
		if (existing) {
			if (existing.workspaceId !== workspaceId) {
				throw callbackError(
					"unauthorized",
					`connection ${connectionId} is not enrolled to workspace ${workspaceId}`,
				);
			}
			existing.generation = generation;
			return existing;
		}
		const record: RingRecord = {
			connectionId,
			workspaceId,
			generation,
			ring: new SseRing<string>(REPLAY_RING_ENTRIES, REPLAY_RING_BYTES),
			nextSeq: 0,
			lastActiveAt: Date.now(),
		};
		this.#rings.set(connectionId, record);
		return record;
	}

	/** Fleet → daemon envelope. Returns the registry-stamped envelope (down
	 * seq assigned, rung for Last-Event-ID resume) once the write is queued.
	 * No live pair: throws `unavailable`; never queues offline work. */
	async sendToDaemon(workspaceId: string, draft: CallbackEnvelopeInput): Promise<CallbackEnvelope> {
		const conn = this.#liveDownFor(workspaceId);
		if (!conn) {
			throw callbackError(
				"unavailable",
				`workspace ${workspaceId} has no live callback pair; the fleet does not queue offline work`,
				{
					detail: `workspaceId=${workspaceId}`,
				},
			);
		}
		const envelope = this.#sendDownEnvelope(conn, draft);
		await conn.sendChain;
		return envelope;
	}

	#liveDownFor(workspaceId: string): DownConnection | null {
		let found: DownConnection | null = null;
		for (const conn of this.#downConnections.values()) {
			if (conn.workspaceId === workspaceId) found = conn; // most recent pair wins
		}
		return found;
	}

	#sendDownEnvelope(conn: DownConnection, draft: CallbackEnvelopeInput): CallbackEnvelope {
		const record = conn.record;
		record.nextSeq += 1;
		const envelope: CallbackEnvelope = {
			version: 1,
			workspaceId: conn.workspaceId,
			generation: conn.generation,
			connectionId: conn.connectionId,
			streamId: draft.streamId,
			seq: record.nextSeq,
			kind: draft.kind,
			payload: draft.payload,
			at: draft.at ?? Date.now(),
		};
		const block = encodeSseEnvelope(envelope);
		record.ring.push(envelope.seq, block);
		record.lastActiveAt = Date.now();
		conn.sendChain = conn.sendChain.then(() => {
			if (conn.closed) return;
			try {
				this.#writeDown(conn, block);
			} catch {
				this.#teardownDown(conn);
			}
		});
		return envelope;
	}

	#writeDown(conn: DownConnection, block: string): void {
		conn.controller.enqueue(conn.encoder.encode(block));
		conn.lastSendAt = Date.now();
		// Byte-counted strategy (#handleDown): desiredSize = highWaterMark −
		// buffered, so a stalled reader that lets buffered bytes exceed the
		// frozen per-connection cap (CONNECTION_MAX_BYTES) drives desiredSize
		// below zero: the genuine drop-and-resume signal. The ring survives;
		// the daemon redials with Last-Event-ID when it notices the closed
		// stream.
		const desired = conn.controller.desiredSize;
		if (desired !== null && desired < 0) {
			this.#teardownDown(conn);
		}
	}

	#teardownDown(conn: DownConnection): void {
		if (conn.closed) return;
		conn.closed = true;
		if (conn.heartbeatTimer !== null) clearInterval(conn.heartbeatTimer);
		if (this.#downConnections.get(conn.connectionId) === conn)
			this.#downConnections.delete(conn.connectionId);
		conn.record.lastActiveAt = Date.now();
		this.#emitPairChange(conn.workspaceId);
		try {
			conn.controller.close();
		} catch {
			// already closed or errored
		}
	}

	// --- virtual streams ---------------------------------------------------------

	/** Bind the consumer sink for (workspaceId, streamId). Rebinding an
	 * existing stream keeps its queued envelopes. */
	attachVirtualStream(workspaceId: string, streamId: string, sink: VirtualStreamSink): void {
		if (!workspaceId || !streamId) {
			throw callbackError(
				"invalid_request",
				"attachVirtualStream requires non-empty workspaceId and streamId",
			);
		}
		let streams = this.#virtualStreams.get(workspaceId);
		if (!streams) {
			streams = new Map();
			this.#virtualStreams.set(workspaceId, streams);
		}
		const existing = streams.get(streamId);
		if (existing) {
			existing.sink = sink;
			return;
		}
		streams.set(streamId, { workspaceId, streamId, sink, high: [], low: [], bytes: 0, dropped: 0 });
	}

	/** Unbind a sink; queued envelopes for the stream are dropped (the
	 * consumer is gone by definition). */
	detachVirtualStream(workspaceId: string, streamId: string): void {
		const streams = this.#virtualStreams.get(workspaceId);
		if (!streams?.delete(streamId)) return;
		if (streams.size === 0) this.#virtualStreams.delete(workspaceId);
	}

	#enqueueVirtual(stream: VirtualStream, envelope: CallbackEnvelope): void {
		const size = envelopeBytes(envelope);
		let dropped = false;
		// Bound: 4 MiB per stream. Room-making order drops the oldest FRAME
		// first, then the oldest high-priority envelope; bounded memory wins,
		// and every drop fires the backpressure signal + pairStatus counter.
		while (
			stream.bytes + size > STREAM_MAX_BYTES &&
			(stream.low.length > 0 || stream.high.length > 0)
		) {
			const queue = stream.low.length > 0 ? stream.low : stream.high;
			stream.bytes -= envelopeBytes(queue.shift() as CallbackEnvelope);
			stream.dropped += 1;
			dropped = true;
		}
		if (stream.bytes + size > STREAM_MAX_BYTES) {
			// A single envelope larger than the whole budget cannot fit even
			// in empty queues (up records are ≤ 1 MiB; kept as a hard bound).
			stream.dropped += 1;
			dropped = true;
		} else {
			(envelope.kind === "frame" ? stream.low : stream.high).push(envelope);
			stream.bytes += size;
		}
		if (dropped) this.#signalBackpressure(stream);
		this.#schedulePump(stream.workspaceId);
	}

	#signalBackpressure(stream: VirtualStream): void {
		try {
			stream.sink.onBackpressure?.({
				workspaceId: stream.workspaceId,
				streamId: stream.streamId,
				queuedBytes: stream.bytes,
				dropped: stream.dropped,
			});
		} catch {
			// sink callbacks must never break the transport
		}
	}

	#schedulePump(workspaceId: string): void {
		let state = this.#pumps.get(workspaceId);
		if (!state) {
			state = { running: false, pending: false, cursor: 0 };
			this.#pumps.set(workspaceId, state);
		}
		if (state.running) {
			state.pending = true;
			return;
		}
		state.running = true;
		void this.#drainLoop(workspaceId, state);
	}

	/**
	 * The drain is where starvation is prevented. Phase 1 drains EVERY
	 * command/control/ack envelope (round-robin across streams, so one
	 * stream's control flood cannot starve another's); phase 2 delivers
	 * exactly ONE frame per stream per rotation, then re-checks phase 1; a
	 * control arriving mid-drain preempts the remaining frames. A slow sink
	 * parks only its own workspace's pump.
	 */
	async #drainLoop(workspaceId: string, state: PumpState): Promise<void> {
		try {
			for (;;) {
				state.pending = false;
				const streams = [...(this.#virtualStreams.get(workspaceId)?.values() ?? [])];
				if (streams.length === 0) break;
				let worked = false;
				for (;;) {
					let deliveredHigh = false;
					for (let i = 0; i < streams.length; i++) {
						const stream = streams[(state.cursor + i) % streams.length];
						const envelope = stream.high.shift();
						if (!envelope) continue;
						deliveredHigh = true;
						worked = true;
						stream.bytes -= envelopeBytes(envelope);
						await this.#deliverVirtual(workspaceId, stream, envelope);
					}
					if (!deliveredHigh) break;
				}
				for (let i = 0; i < streams.length; i++) {
					const stream = streams[(state.cursor + i) % streams.length];
					const envelope = stream.low.shift();
					if (!envelope) continue;
					worked = true;
					stream.bytes -= envelopeBytes(envelope);
					await this.#deliverVirtual(workspaceId, stream, envelope);
				}
				state.cursor = (state.cursor + 1) % streams.length;
				if (!worked && !state.pending) break;
			}
		} finally {
			state.running = false;
			if (state.pending) this.#schedulePump(workspaceId);
		}
	}

	async #deliverVirtual(
		workspaceId: string,
		stream: VirtualStream,
		envelope: CallbackEnvelope,
	): Promise<void> {
		if (this.#virtualStreams.get(workspaceId)?.get(stream.streamId) !== stream) return; // detached mid-drain
		try {
			await stream.sink.deliver(envelope);
		} catch {
			// sink errors never kill the transport
		}
	}

	// --- bulk: POST /callback/bulk/<correlationId> ---------------------------------

	/** Issue a workspace-scoped correlation id for one daemon-initiated bulk
	 * transfer (single- or multi-part; unused correlations expire as failed).
	 * `capture: true` (fleet download requests) buffers the received payload
	 * into the BulkResult so the fleet can serve it; aggregate bytes stay
	 * capped at BULK_MAX_BYTES either way. */
	createBulkCorrelation(workspaceId: string, opts?: { capture?: boolean }): BulkCorrelation {
		if (!workspaceId)
			throw callbackError("invalid_request", "createBulkCorrelation requires a workspaceId");
		const correlationId = randomUUID();
		let resolve!: (result: BulkResult) => void;
		const done = new Promise<BulkResult>((res) => {
			resolve = res;
		});
		this.#bulk.set(correlationId, {
			correlationId,
			workspaceId,
			createdAt: Date.now(),
			state: "open",
			bytes: 0,
			capture: opts?.capture === true,
			chunks: [],
			nextPart: 0,
			resolve,
		});
		return { correlationId, done };
	}

	async #handleBulk(req: Request, correlationId: string): Promise<Response> {
		const auth = this.#authenticate(req);
		const record = this.#bulk.get(correlationId);
		if (!record || record.workspaceId !== auth.workspaceId) {
			throw callbackError("invalid_request", `unknown bulk correlation ${correlationId}`, {
				detail: "correlation ids are single-use and workspace-scoped",
			});
		}
		if (record.state !== "open") {
			throw callbackError(
				"conflict",
				`bulk correlation ${correlationId} is already ${record.state}`,
			);
		}
		if (req.body === null) {
			this.#failBulk(record, record.bytes, "bulk upload had no body");
			throw callbackError("invalid_request", "bulk upload requires a body");
		}
		// Multi-part transfers (P3.4 downloads): a daemon streams one logical
		// payload as sequential POSTs to the SAME correlation: headers
		// x-omp-bulk-part:<n> (0-based, strictly sequential, no gaps/overlaps)
		// and x-omp-bulk-final:1 on the last part. Neither side buffers the
		// whole body at once; the AGGREGATE across parts stays capped at
		// BULK_MAX_BYTES. A part-less POST is the single-shot form (part 0,
		// implicitly final) and cannot follow a started part sequence.
		const partRaw = req.headers.get("x-omp-bulk-part");
		const finalRaw = req.headers.get("x-omp-bulk-final");
		let isFinal = true;
		if (partRaw !== null || record.nextPart > 0) {
			const part = partRaw === null ? NaN : Number(partRaw);
			if (!Number.isSafeInteger(part) || part < 0 || part !== record.nextPart) {
				this.#failBulk(record, record.bytes, "bulk part sequence broken");
				throw callbackError(
					"conflict",
					`bulk correlation ${correlationId} expected part ${record.nextPart}, got ${partRaw ?? "none"}`,
					{
						detail:
							"parts are 0-based and strictly sequential; any failure fails the whole transfer",
					},
				);
			}
			isFinal = finalRaw === "1" || finalRaw === "true";
		}
		let partBytes = 0;
		try {
			const reader = req.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				partBytes += value.byteLength;
				if (record.bytes + partBytes > BULK_MAX_BYTES) {
					void reader.cancel().catch(() => {});
					this.#failBulk(
						record,
						record.bytes + partBytes,
						`bulk upload exceeds the ${BULK_MAX_BYTES}-byte aggregate cap`,
					);
					throw callbackError(
						"invalid_request",
						`bulk upload exceeds the ${BULK_MAX_BYTES}-byte aggregate cap`,
					);
				}
				if (record.capture) record.chunks.push(value);
			}
		} catch (error) {
			if (isCallbackError(error)) throw error;
			this.#failBulk(record, record.bytes + partBytes, "bulk upload aborted");
			throw callbackError("unavailable", "bulk upload connection aborted", { cause: error });
		}
		record.bytes += partBytes;
		record.nextPart += 1;
		if (!isFinal) {
			// Intermediate part: the correlation stays open for the next POST.
			return Response.json({
				status: "part_received",
				correlationId,
				part: record.nextPart - 1,
				bytes: record.bytes,
			});
		}
		record.state = "received";
		const result: BulkResult = {
			correlationId,
			workspaceId: record.workspaceId,
			state: "received",
			bytes: record.bytes,
		};
		if (record.capture) {
			result.data = concatBuffers(record.chunks, record.bytes);
			record.chunks = [];
		}
		record.resolve(result);
		// Transport receipt ONLY; archive acceptance is the archive store's
		// durable receipt (manifest verify + atomic rename), never this 200.
		return Response.json({ status: "received", correlationId, bytes: record.bytes });
	}

	// --- materialization (P8.9 wake: bulk download from the log store) --------

	/**
	 * Wires the fleet log store as the source for bulk materialization
	 * transfers. Called by the fleet server once the store loads; a null
	 * store leaves materialization rejected typed `unavailable`. Never
	 * rewired after the store closes.
	 */
	setMaterializeStore(store: FleetLogStore): void {
		this.#materializeStore = store;
	}

	/**
	 * Serve one workspace's stored session lineage bytes as an NDJSON
	 * response under a bulk correlation (P8.9). Called for EVERY bulk POST
	 * whose correlation id is NOT fleet-issued (a daemon-minted materialize
	 * pull; fleet-issued upload correlations are routed to #handleBulk
	 * before any body read). Reads at most MATERIALIZE_REQUEST_MAX_BYTES:
	 * when the body parses as a MaterializeRequest the fleet answers with
	 * the transfer; ANY other body is drained to completion and reported as
	 * "not a request" so the caller can handle it as an upload; the reader
	 * is never left locked and the stream is never cancelled mid-body.
	 * Authentication is the SAME enrollment as any callback request; a
	 * materialization request is authenticated before its body is read, so
	 * unknown correlations cannot be probed. The log store is the
	 * authority: a missing workspace/session resolves to typed
	 * `unavailable`, never an approximation. One transfer is bounded by
	 * MATERIALIZE_TRANSFER_MAX_BYTES; larger transcripts split across
	 * sequential correlation ids via the `end` cursor (see
	 * shared/wake-materialize.ts emitMaterializeTransfer). The daemon's own
	 * verifier (size + sha256, carried per file) is the acceptance check.
	 */
	async #maybeHandleMaterialize(req: Request): Promise<Response | null> {
		// Authenticate against the enrollment FIRST (identity headers carry
		// the credential; the body is never trusted without them).
		const auth = this.#authenticate(req);
		if (req.body === null) return null;
		const head = await this.#readBoundedBody(req, MATERIALIZE_REQUEST_MAX_BYTES);
		if (head === null) return null; // Empty or over-cap body: not a request.
		let parsed: unknown;
		try {
			parsed = JSON.parse(head);
		} catch {
			return null; // Not JSON: not our request.
		}
		const request = parseMaterializeRequest(parsed); // Throws typed when it IS one but malformed.
		if (request === null) return null;
		if (request.sessionId.length === 0) {
			throw callbackError("invalid_request", "materialize request requires a sessionId");
		}

		const store = this.#materializeStore;
		if (store === null) {
			throw callbackError(
				"unavailable",
				"materialization is unavailable: the fleet has no log store",
			);
		}
		const sessionDir = join(store.rootDir, auth.workspaceId, request.sessionId);
		const plan = planMaterializeFiles(sessionDir);
		if (plan.files.length === 0) {
			throw callbackError(
				"unavailable",
				`materialization unavailable: the fleet has no stored transcripts for session ${request.sessionId}`,
				{ detail: "the workspace never streamed this session, or it was purged" },
			);
		}

		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				try {
					const lines = emitMaterializeTransfer(
						plan,
						request.sessionId,
						request.cursor,
						MATERIALIZE_TRANSFER_MAX_BYTES,
						auth.workspaceId,
					);
					for (const line of lines) {
						controller.enqueue(Buffer.from(line, "utf8"));
					}
					// The fleet-issued bulk record never exists for this
					// correlation (the daemon minted it), so there is no
					// record to settle; the HTTP 200 with the full NDJSON
					// body IS the transport receipt.
				} catch (error) {
					controller.error(error instanceof Error ? error : new Error(String(error)));
				} finally {
					controller.close();
				}
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "application/x-ndjson" },
		});
	}

	/**
	 * Read a POST body up to `maxBytes`, returning the decoded text, or null
	 * when the body is empty or exceeds the cap. A body at or under the cap
	 * is DRAINED to completion so the reader is never left locked. An
	 * over-cap body is canceled: safe because the caller routes fleet-issued
	 * upload correlations BEFORE this function (no valid upload is ever
	 * truncated here), and an over-cap body to an unknown correlation is
	 * rejected by the upload handler regardless.
	 */
	async #readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
		const reader = req.body!.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength === 0) continue;
			chunks.push(value);
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return null;
			}
		}
		if (chunks.length === 0) return null;
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return Buffer.from(merged).toString("utf8");
	}

	#failBulk(record: BulkRecord, bytes: number, error: string): void {
		if (record.state !== "open") return;
		record.state = "failed";
		record.bytes = bytes;
		record.resolve({
			correlationId: record.correlationId,
			workspaceId: record.workspaceId,
			state: "failed",
			bytes,
			error,
		});
	}

	// --- observation ---------------------------------------------------------------

	/** Observe every non-heartbeat daemon envelope for a workspace (raw tap,
	 * independent of virtual stream attachment). Returns an unsubscribe. */
	onDaemonEnvelope(workspaceId: string, cb: (envelope: CallbackEnvelope) => void): () => void {
		let taps = this.#taps.get(workspaceId);
		if (!taps) {
			taps = new Set();
			this.#taps.set(workspaceId, taps);
		}
		taps.add(cb);
		return () => {
			const set = this.#taps.get(workspaceId);
			if (!set?.delete(cb)) return;
			if (set.size === 0) this.#taps.delete(workspaceId);
		};
	}

	/** Observe pair-ready announcements and pair teardowns for one workspace.
	 * Fires with the CURRENT PairStatus after either transition: a consumer
	 * re-sends its per-stream open controls on every paired:true (the daemon
	 * re-primes each still-open stream) and learns pair loss via paired:false.
	 * Returns an unsubscribe. */
	onPairChange(workspaceId: string, cb: (status: PairStatus) => void): () => void {
		let listeners = this.#pairListeners.get(workspaceId);
		if (!listeners) {
			listeners = new Set();
			this.#pairListeners.set(workspaceId, listeners);
		}
		listeners.add(cb);
		return () => {
			const set = this.#pairListeners.get(workspaceId);
			if (!set?.delete(cb)) return;
			if (set.size === 0) this.#pairListeners.delete(workspaceId);
		};
	}

	#emitPairChange(workspaceId: string): void {
		const listeners = this.#pairListeners.get(workspaceId);
		if (!listeners || listeners.size === 0) return;
		const status = this.pairStatus(workspaceId);
		for (const cb of [...listeners]) {
			try {
				cb(status);
			} catch {
				// a broken observer must never take the transport down
			}
		}
	}

	/** Point-in-time pair/stream/enrollment view for the fleet edge. */
	pairStatus(workspaceId: string): PairStatus {
		const authorizedGeneration = this.#maxEnrolledGeneration(workspaceId);
		let down: DownConnection | null = null;
		for (const conn of this.#downConnections.values()) {
			if (conn.workspaceId === workspaceId) down = conn;
		}
		let upBytesIn = 0;
		let envelopesReceived = 0;
		let lastEnvelopeAt: number | null = null;
		for (const conn of this.#upConnections) {
			if (conn.workspaceId !== workspaceId) continue;
			upBytesIn += conn.bytesIn;
			envelopesReceived += conn.envelopes;
			if (lastEnvelopeAt === null || conn.lastDataAt > lastEnvelopeAt)
				lastEnvelopeAt = conn.lastDataAt;
		}
		let ring: RingRecord | null = down?.record ?? null;
		if (!ring) {
			for (const record of this.#rings.values()) {
				if (record.workspaceId !== workspaceId) continue;
				if (!ring || record.lastActiveAt > ring.lastActiveAt) ring = record;
			}
		}
		const streams = [...(this.#virtualStreams.get(workspaceId)?.values() ?? [])].map((stream) => ({
			streamId: stream.streamId,
			queued: stream.high.length + stream.low.length,
			queuedBytes: stream.bytes,
			dropped: stream.dropped,
		}));
		return {
			workspaceId,
			enrolled: authorizedGeneration !== null,
			authorizedGeneration,
			paired: down !== null,
			connectionId: down?.connectionId ?? null,
			replayDepth: ring?.ring.size ?? 0,
			lastEnvelopeAt,
			lastDownSendAt: down?.lastSendAt ?? null,
			envelopesReceived,
			upBytesIn,
			streams,
		};
	}

	#sweep(): void {
		const now = Date.now();
		for (const conn of [...this.#upConnections]) {
			if (now - conn.lastDataAt > SILENCE_DEADLINE_MS) this.#killUp(conn);
		}
		for (const [connectionId, record] of this.#rings) {
			if (this.#downConnections.has(connectionId)) continue;
			if (now - record.lastActiveAt > RING_IDLE_MS) this.#rings.delete(connectionId);
		}
		for (const [correlationId, record] of this.#bulk) {
			if (now - record.createdAt <= BULK_TTL_MS) continue;
			if (record.state === "open") this.#failBulk(record, record.bytes, "bulk correlation expired");
			else this.#bulk.delete(correlationId);
		}
	}

	#killUp(conn: UpConnection): void {
		conn.silenceKilled = true;
		conn.reader?.cancel().catch(() => {});
	}

	/** Tear everything down (fleet shutdown / tests). Open bulk correlations
	 * settle failed; live pairs close; rings and enrollments are cleared. */
	close(): void {
		clearInterval(this.#sweepTimer);
		for (const conn of [...this.#upConnections]) this.#killUp(conn);
		for (const conn of [...this.#downConnections.values()]) this.#teardownDown(conn);
		for (const record of this.#bulk.values())
			this.#failBulk(record, record.bytes, "transport closed");
		this.#upConnections.clear();
		this.#rings.clear();
		this.#bulk.clear();
		this.#virtualStreams.clear();
		this.#taps.clear();
		this.#pumps.clear();
		this.#enrollments.clear();
	}
}
