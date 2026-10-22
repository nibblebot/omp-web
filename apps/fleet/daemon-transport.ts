/**
 * Fleet-side callback transport: the fleet half of the OMP_CALLBACK_PROTO 2
 * outbound callback pair. Wire vocabulary comes from lib/wire/callback-protocol.ts.
 * Daemons dial OUT to the fleet; the fleet never dials in, and there is NO
 * durable offline command queue: sendToDaemon with no live pair fails
 * `unavailable`, never buffers.
 *
 * Routes (mounted by handleFetch; identity rides HEADERS ONLY; the URL
 * alone never enrolls, authenticates, or authorizes anything):
 *
 *   GET  /callback/ws                    The pair: ONE daemon-dialed WebSocket
 *                                        carrying envelopes both ways. One
 *                                        text message is one canonical-JSON
 *                                        envelope of at most ENVELOPE_MAX_BYTES;
 *                                        every message is parsed; a message
 *                                        framed canonically also hands
 *                                        its sink the payload's own JSON text
 *                                        (VirtualStreamSink.deliver) so a
 *                                        relay need not re-serialize it;
 *                                        a binary message is dropped and
 *                                        counted. The socket mints its own
 *                                        connectionId (x-omp-connection-id,
 *                                        fresh per socket) and a seq space per
 *                                        direction (strictly monotonic, first
 *                                        daemon seq >= 1, the fleet's starts
 *                                        at 1); it is never resumed. It lives
 *                                        until either side closes it or its
 *                                        silence deadline passes: no byte
 *                                        budget, no renewal.
 *   POST /callback/bulk/<correlationId>  Daemon-initiated bounded bulk
 *                                        transfer (64 MiB cap) on its own
 *                                        HTTP request, so a transfer never
 *                                        blocks the pair, correlated to a
 *                                        fleet-issued id from
 *                                        createBulkCorrelation. Completion
 *                                        is transport receipt, state
 *                                        "received", NEVER archive
 *                                        acceptance.
 *
 * Upgrade and refusal: the upgrade request is authenticated exactly like
 * every other callback request (below) and must carry CALLBACK_PROTO_HEADER =
 * OMP_CALLBACK_PROTO. A WebSocket client cannot read a non-101 status, so a
 * refused dial is still upgraded and then closed at once with
 * callbackCloseFor(error): code 4000 + the ledger status, reason
 * `<code>: <message>`. A request that is not a WebSocket upgrade gets a typed
 * 400. Bun runs the handler's `open` inside `server.upgrade`, so the
 * enrollment verdict and the pair registration happen in one tick.
 *
 * Pair establishment: an accepted socket is registered as the workspace's
 * live pair and the fleet sends ONE control envelope first (streamId
 * "transport", payload {type:"pair_ready", connectionId, generation}); a daemon
 * resolves start() on it (PAIR_READY_TIMEOUT_MS deadline). Transport-generated
 * envelopes (pair_ready, heartbeats) carry streamId "transport" so they pass
 * validateEnvelope on the daemon side. A newer socket of a workspace replaces
 * its older pair as the live one (sends go to the newest); the older socket
 * lives until its own close or silence deadline.
 *
 * Liveness: envelope heartbeats both ways (the fleet sends one every
 * HEARTBEAT_INTERVAL_MS on "transport"); a socket that delivers no message for
 * SILENCE_DEADLINE_MS is closed by the registry sweep. WebSocket ping/pong is
 * not relied on.
 *
 * Flow control, never silent loss: Bun's server `send()` drops past
 * `backpressureLimit` and never reports it to the receiver, so the registry
 * hands the socket nothing while `getBufferedAmount()` is above
 * CALLBACK_WS_SEND_HIGH_WATER_BYTES. Unsent envelopes wait in the pair's own
 * outbox (bounded by CONNECTION_MAX_BYTES; past it the pair is closed
 * `retryable`) and flush on the socket's `drain`. A chunked command parks
 * until the outbox has room (DOWN_ROOM_STALL_MS). A `send()` that returns 0
 * (dropped) closes the pair. The receive side cannot pause a server socket:
 * envelopes reach their sinks strictly in arrival order per (pair, stream),
 * queued behind a sink of that stream that returns a promise (other streams
 * never wait on it). What a stuck stream can pile up is bounded by the upload
 * credit below.
 *
 * Upload credit: the daemon may have PAIR_CREDIT_WINDOW_BYTES of messages
 * outstanding beyond the credit the fleet granted (PairCreditControl on
 * "transport"). Every message received on a socket, dropped or binary ones
 * included, counts its UTF-8 bytes into `bytesIn`. Once at least
 * PAIR_CREDIT_STEP_BYTES more are consumed than were granted, the fleet sends
 * the cumulative consumed count; consumed is what arrived, was processed
 * (decoded, tapped, handed to its sink) and is not parked in a lane behind a
 * stuck sink. Credit is therefore issued only by this consumer, after whatever
 * sits in front of it (a forwarder, a reverse proxy, the kernel buffers). A
 * socket whose `bytesIn` runs more than the window ahead of the credit already
 * granted has ignored it: it is closed `invalid_request` (4400, retryable like
 * the other per-pair protocol violations; a redial starts a fresh window)
 * before the message is processed. No slack is needed: a daemon that obeys the
 * window has at most the window beyond the credit it SAW, which never exceeds
 * what the fleet granted. This one bound replaces a separate cap on lane backlog.
 *
 * Auth on every route: x-omp-workspace-id, x-omp-generation,
 * x-omp-connection-id (the socket's identity), and
 * `authorization: Bearer <enrollment credential>`. Enrollment is
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
 * sink per (workspaceId, streamId). Each envelope is handed to its sink in
 * arrival order. An envelope for a streamId with no attached sink is dropped
 * by design (bounded transport); the fleet edge attaches sinks before letting
 * traffic flow.
 *
 * Main (fleet/server.ts) mounts this as the first responder for the
 * /callback prefix and hands `websocket` to Bun.serve:
 *
 *   fetch: (req, server) => transport.handleFetch(req, server) ?? nextRoutes(req)
 *   websocket: transport.websocket
 *
 * handleFetch resolves a Response for /callback/* paths (typed-error JSON
 * {error, message, detail?} on failures), `undefined` once it upgraded the
 * socket (Bun then needs no Response), and null for anything else;
 * non-callback paths are not this module's business.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
	BULK_MAX_BYTES,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_ERROR_HTTP_STATUS,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CALLBACK_WS_PATH,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	PAIR_CREDIT_STEP_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	type PairCreditControl,
	type CallbackEnvelope,
	type CallbackError,
	callbackCloseFor,
	callbackError,
	CONNECTION_MAX_BYTES,
	canonicalPayloadJson,
	decodeEnvelope,
	ENROLLMENT_KEY_BYTES,
	ENVELOPE_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	isCallbackError,
	OMP_CALLBACK_PROTO,
	planOversizeSplit,
	SILENCE_DEADLINE_MS,
} from "#lib/wire/callback-protocol";
import { commandBytes, commandTooLargeMessage, MAX_COMMAND_BYTES } from "#lib/wire/command-limits";
import type { FleetLogStore } from "./log-store";
import {
	MATERIALIZE_REQUEST_MAX_BYTES,
	MATERIALIZE_TRANSFER_MAX_BYTES,
	emitMaterializeTransfer,
	parseMaterializeRequest,
	planMaterializeFiles,
} from "#lib/session-files/wake-materialize";

/** A chunked command waits this long for the socket to drain before the pair is dropped. */
const DOWN_ROOM_STALL_MS = 30_000;
/** Open bulk correlations with no payload progress for this long expire as failed; settled ones are reaped. */
const BULK_IDLE_MS = 60_000;
/** Capture (download) correlations open at once; each buffers up to BULK_MAX_BYTES, so this bounds fleet heap. */
const BULK_CAPTURE_MAX_OPEN = 2;
/** Registry sweep cadence: pair silence, bulk expiry. */
const SWEEP_INTERVAL_MS = 5_000;
/** Revoked enrollments are kept this long (diagnostics) before the sweep drops them. */
const ENROLLMENT_REVOKED_RETENTION_MS = 10 * 60_000;
/**
 * Bun's WebSocket idle timeout (seconds; any frame from the peer resets it).
 * Well above the 30 s silence deadline, which the sweep enforces on envelopes
 * alone, so Bun's own timer never decides first.
 */
const WS_IDLE_TIMEOUT_S = 120;
/**
 * Bun's per-socket send-buffer ceiling (`backpressureLimit`). The send gate
 * keeps the buffered amount at most the high-water mark plus one envelope, far
 * below this, so Bun never has to drop.
 */
const WS_BACKPRESSURE_LIMIT_BYTES = 4 * CALLBACK_WS_MAX_PAYLOAD_BYTES;

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

function unrefTimer(timer: Timer): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

interface Enrollment {
	workspaceId: string;
	generation: number;
	/** SHA-256 of the 256-bit credential; the raw credential is never stored. */
	credentialHash: Uint8Array;
	createdAt: number;
	revoked: boolean;
	/** Set on revoke; the sweep prunes the record after the retention window. */
	revokedAt?: number;
}

/** Plain FIFO with O(1) shift: a long outbox or backlog of small envelopes never pays Array#shift's copy. */
class Fifo<T> {
	#items: Array<T | undefined> = [];
	#head = 0;

	get length(): number {
		return this.#items.length - this.#head;
	}

	push(item: T): void {
		this.#items.push(item);
	}

	shift(): T | undefined {
		if (this.#head >= this.#items.length) return undefined;
		const item = this.#items[this.#head];
		this.#items[this.#head++] = undefined;
		if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
			this.#items = this.#items.slice(this.#head);
			this.#head = 0;
		}
		return item;
	}

	clear(): void {
		this.#items = [];
		this.#head = 0;
	}
}

/**
 * `ws.data` of a callback pair socket. A fleet server hosting other socket
 * kinds (the browser socket) dispatches on `kind` (fleet-websocket.ts).
 */
export interface CallbackSocketData {
	kind: "callback";
	/**
	 * Typed refusal decided at upgrade: a WebSocket client cannot read a non-101
	 * status, so `open` closes the upgraded socket with it instead.
	 */
	refusal: CallbackError | null;
	workspaceId: string;
	generation: number;
	connectionId: string;
}

/** One encoded down envelope waiting for the socket to take it. */
interface OutboxItem {
	text: string;
	bytes: number;
}

/** One daemon envelope waiting behind its stream's unsettled sink. */
interface PendingDelivery {
	sink: VirtualStreamSink;
	envelope: CallbackEnvelope;
	payloadJson: string | undefined;
	bytes: number;
}

/** One stream's envelopes queued, in arrival order, behind its unsettled sink promise. */
interface DeliveryLane {
	queue: Fifo<PendingDelivery>;
}

/** One live callback pair: a registered, authenticated WebSocket. */
interface PairConnection {
	connectionId: string;
	workspaceId: string;
	generation: number;
	ws: ServerWebSocket<CallbackSocketData>;
	/** Last fleet-assigned down seq; strictly monotonic per socket. */
	downSeq: number;
	/** Last accepted daemon seq. */
	lastSeq: number;
	/** UTF-8 bytes of every message received on this socket (the unit of the upload credit). */
	bytesIn: number;
	/** Cumulative `consumed` of the last pair_credit grant sent. */
	creditGranted: number;
	envelopes: number;
	/** Bad messages dropped on this socket (each logged; the socket stays up). */
	droppedMessages: number;
	/** Last message of any kind from the daemon: the silence deadline's clock. */
	lastDataAt: number;
	lastSendAt: number;
	heartbeatTimer: Timer;
	closed: boolean;
	/** Encoded envelopes the socket has not taken yet (it is above the high-water mark). */
	outbox: Fifo<OutboxItem>;
	outboxBytes: number;
	/** Chunked senders parked until the outbox has room (a flush wakes them). */
	roomWaiters: Array<() => void>;
	/** Streams whose sink returned a promise that has not settled; each holds its later envelopes in order. */
	lanes: Map<string, DeliveryLane>;
	/** Bytes queued across all lanes: the pair-wide undelivered backlog. */
	backlogBytes: number;
}

interface BulkRecord {
	correlationId: string;
	workspaceId: string;
	/** Last payload progress (creation, each part, each consumed chunk); idle expiry keys off it. */
	touchedAt: number;
	state: "open" | "received" | "failed";
	/** Aggregate bytes across every part of the transfer. */
	bytes: number;
	/** Capture correlations buffer the payload for the fleet requester (downloads). */
	capture: boolean;
	chunks: Uint8Array[];
	/** Upload reader in flight; cancelled when the transfer fails so the POST unwinds. */
	reader: ReadableStreamDefaultReader<Uint8Array> | null;
	/** Next expected x-omp-bulk-part number (0-based, strictly sequential). */
	nextPart: number;
	resolve: (result: BulkResult) => void;
}

/** Consumer of one virtual stream. The registry hands each envelope to
 * deliver as it arrives; a sink that needs flow control owns it.
 *
 * `payloadJson` is the payload's own JSON text, sliced from the wire message,
 * for an envelope that arrived canonically framed (see
 * canonicalPayloadJson); undefined otherwise. `envelope.payload` is always the
 * parse of that text: a sink that forwards the text must route and filter on
 * `envelope.payload`, so what it inspected is what the next JSON.parse sees. */
export interface VirtualStreamSink {
	deliver(envelope: CallbackEnvelope, payloadJson?: string): void | Promise<void>;
}

export interface PairStatus {
	workspaceId: string;
	enrolled: boolean;
	/** Highest non-revoked enrolled generation; null when never enrolled. */
	authorizedGeneration: number | null;
	paired: boolean;
	connectionId: string | null;
	lastEnvelopeAt: number | null;
	lastDownSendAt: number | null;
	envelopesReceived: number;
	upBytesIn: number;
}

/** Registry-issued bulk transfer handle. `done` never rejects: a failed
 * upload (cap exceeded, aborted, expired, cancelled, daemon-reported)
 * settles as state "failed". */
export interface BulkCorrelation {
	correlationId: string;
	done: Promise<BulkResult>;
	/** Fail the transfer (requester gave up); a no-op once it has settled. */
	cancel(reason: string): void;
}

export interface BulkResult {
	correlationId: string;
	workspaceId: string;
	/** "received" is transport receipt only; NEVER archive acceptance. */
	state: "received" | "failed";
	/** Aggregate bytes across all parts of the transfer. */
	bytes: number;
	error?: string;
	/** Buffered payload chunks in arrival order, present only on received capture correlations. */
	chunks?: Uint8Array[];
}

/** sendToDaemon input: streamId/kind/payload required; version, workspaceId,
 * generation, connectionId, seq and at are owned by the registry (supplied
 * values for those are ignored). */
export type CallbackEnvelopeInput = Partial<CallbackEnvelope> &
	Pick<CallbackEnvelope, "streamId" | "kind" | "payload">;

export class DaemonTransportRegistry {
	/**
	 * The pair's WebSocket handler: hand it to `Bun.serve({ websocket })` next
	 * to a `fetch` that calls {@link handleFetch}, or compose it with other
	 * socket kinds (fleet-websocket.ts). perMessageDeflate stays off and the
	 * message cap is CALLBACK_WS_MAX_PAYLOAD_BYTES, which `onMessage` also
	 * enforces itself because a composed server raises Bun's cap for the
	 * browser socket; `backpressureLimit` sits far above anything the send
	 * gate lets accumulate and never closes the socket (nothing here relies
	 * on Bun to drop or close for it).
	 */
	readonly websocket: WebSocketHandler<CallbackSocketData> = {
		maxPayloadLength: CALLBACK_WS_MAX_PAYLOAD_BYTES,
		perMessageDeflate: false,
		backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
		closeOnBackpressureLimit: false,
		idleTimeout: WS_IDLE_TIMEOUT_S,
		open: (ws) => this.#onOpen(ws),
		message: (ws, message) => this.#onMessage(ws, message),
		drain: (ws) => this.#onDrain(ws),
		close: (ws) => this.#onClose(ws),
	};
	readonly #enrollments = new Map<string, Enrollment>();
	/** Highest non-revoked enrolled generation per workspace; kept in step with #enrollments. */
	readonly #authorizedMax = new Map<string, number>();
	/** Live pair sockets by connectionId. */
	readonly #pairs = new Map<string, PairConnection>();
	/** Open pairs per workspace in registration order: the last is the workspace's live pair. */
	readonly #pairsByWorkspace = new Map<string, PairConnection[]>();
	readonly #virtualStreams = new Map<string, Map<string, VirtualStreamSink>>();
	readonly #taps = new Map<string, Set<(envelope: CallbackEnvelope) => void>>();
	readonly #bulk = new Map<string, BulkRecord>();
	/** Pair-ready/teardown observers per workspace (edge stream_open re-sends). */
	readonly #pairListeners = new Map<string, Set<(status: PairStatus) => void>>();
	/** Wake materialization: log-store source for bulk materialization
	 * transfers, wired by the fleet server after the store loads. Null =
	 * no store (the fleet rejects materialization requests typed
	 * `unavailable`). */
	#materializeStore: FleetLogStore | null = null;
	readonly #sweepTimer: Timer;
	/** Registry clock for every timestamp and sweep comparison. */
	readonly #now: () => number;
	/** Sink for dropped pair messages (one line each); defaults to console.warn. */
	readonly #onDroppedMessage: (message: string) => void;

	/**
	 * `now` and `sweepIntervalMs` exist so the sweep deadlines (pair silence,
	 * bulk expiry) are testable without wall-clock waits; production passes
	 * neither and uses the module constants + Date.now.
	 */
	constructor(
		opts: {
			now?: () => number;
			sweepIntervalMs?: number;
			onDroppedMessage?: (message: string) => void;
		} = {},
	) {
		this.#now = opts.now ?? Date.now;
		this.#onDroppedMessage = opts.onDroppedMessage ?? ((message) => console.warn(message));
		const sweepMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
		this.#sweepTimer = setInterval(() => this.#sweep(), sweepMs);
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
			createdAt: this.#now(),
			revoked: false,
		});
		const max = this.#authorizedMax.get(workspaceId);
		if (max === undefined || generation > max) this.#authorizedMax.set(workspaceId, generation);
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
			createdAt: this.#now(),
			revoked: false,
		});
		const max = this.#authorizedMax.get(workspaceId);
		if (max === undefined || generation > max) this.#authorizedMax.set(workspaceId, generation);
	}

	/** Revoke one generation (or all generations of the workspace). Live
	 * callback pairs in the revoked scope are torn down immediately. */
	revokeEnrollment(workspaceId: string, generation?: number): void {
		for (const record of this.#enrollments.values()) {
			if (record.workspaceId !== workspaceId) continue;
			if (generation !== undefined && record.generation !== generation) continue;
			record.revoked = true;
			record.revokedAt = this.#now();
		}
		let max: number | null = null;
		for (const record of this.#enrollments.values()) {
			if (record.workspaceId !== workspaceId || record.revoked) continue;
			if (max === null || record.generation > max) max = record.generation;
		}
		if (max === null) this.#authorizedMax.delete(workspaceId);
		else this.#authorizedMax.set(workspaceId, max);
		for (const pair of [...this.#pairs.values()]) {
			if (pair.workspaceId !== workspaceId) continue;
			if (generation !== undefined && pair.generation !== generation) continue;
			this.#teardownPair(pair, { code: 1000, reason: "enrollment revoked" });
		}
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
		const maxGeneration = this.#authorizedMax.get(workspaceId) ?? null;
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

	#authenticate(req: Request): {
		workspaceId: string;
		generation: number;
		connectionId: string | undefined;
	} {
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
		return { workspaceId, generation, connectionId };
	}

	// --- routing ---------------------------------------------------------------

	/** Fleet-server mount: resolves a Response for /callback/* paths, `undefined`
	 * once the request was upgraded to a pair socket (Bun then needs no
	 * Response), and null for anything else. */
	async handleFetch(
		req: Request,
		server: Server<CallbackSocketData>,
	): Promise<Response | null | undefined> {
		const path = new URL(req.url).pathname;
		try {
			if (path === CALLBACK_WS_PATH) {
				return req.method === "GET"
					? this.#upgrade(req, server)
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
				// Wake materialization: a bulk POST whose body is a small
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

	// --- pair: GET /callback/ws -----------------------------------------------------

	/**
	 * Authenticate the upgrade request, then upgrade. A refused dial is upgraded
	 * too, carrying its typed refusal in `ws.data`: `open` closes it at once with
	 * callbackCloseFor (a WebSocket client cannot read a non-101 status). Only a
	 * request that is no WebSocket upgrade at all gets an HTTP error.
	 */
	#upgrade(req: Request, server: Server<CallbackSocketData>): undefined {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw callbackError("invalid_request", `${CALLBACK_WS_PATH} requires a WebSocket upgrade`);
		}
		let data: CallbackSocketData;
		try {
			const auth = this.#authenticate(req);
			if (auth.connectionId === undefined) {
				throw callbackError("invalid_identity", "missing x-omp-connection-id header");
			}
			const claimed = req.headers.get(CALLBACK_PROTO_HEADER);
			if (claimed !== String(OMP_CALLBACK_PROTO)) {
				throw callbackError(
					"proto_unsupported",
					`callback protocol ${claimed ?? "(none)"} is not supported; this fleet speaks OMP_CALLBACK_PROTO ${OMP_CALLBACK_PROTO}`,
					{ detail: `send ${CALLBACK_PROTO_HEADER}: ${OMP_CALLBACK_PROTO}` },
				);
			}
			const owner = this.#pairs.get(auth.connectionId);
			if (owner !== undefined && owner.workspaceId !== auth.workspaceId) {
				throw callbackError(
					"unauthorized",
					`connection ${auth.connectionId} is not enrolled to workspace ${auth.workspaceId}`,
				);
			}
			data = {
				kind: "callback",
				refusal: null,
				workspaceId: auth.workspaceId,
				generation: auth.generation,
				connectionId: auth.connectionId,
			};
		} catch (error) {
			if (!isCallbackError(error)) throw error;
			data = { kind: "callback", refusal: error, workspaceId: "", generation: 0, connectionId: "" };
		}
		if (!server.upgrade(req, { data })) {
			throw callbackError("invalid_request", `${CALLBACK_WS_PATH} WebSocket upgrade failed`);
		}
	}

	/** The registered pair of a socket, or undefined for a refused, replaced or closed one. */
	#pairOf(ws: ServerWebSocket<CallbackSocketData>): PairConnection | undefined {
		const pair = this.#pairs.get(ws.data.connectionId);
		return pair !== undefined && pair.ws.data === ws.data ? pair : undefined;
	}

	/** Accepted upgrade: register the pair and announce it with pair_ready, the first message. */
	#onOpen(ws: ServerWebSocket<CallbackSocketData>): void {
		const { refusal, workspaceId, generation, connectionId } = ws.data;
		if (refusal !== null) {
			const { code, reason } = callbackCloseFor(refusal);
			ws.close(code, reason);
			return;
		}
		const replaced = this.#pairs.get(connectionId);
		if (replaced !== undefined) {
			this.#teardownPair(replaced, {
				code: 1000,
				reason: "replaced by a newer socket with the same connectionId",
			});
		}
		const now = this.#now();
		const pair: PairConnection = {
			connectionId,
			workspaceId,
			generation,
			ws,
			downSeq: 0,
			lastSeq: 0,
			bytesIn: 0,
			creditGranted: 0,
			envelopes: 0,
			droppedMessages: 0,
			lastDataAt: now,
			lastSendAt: now,
			heartbeatTimer: setInterval(() => {
				if (!pair.closed) {
					this.#sendDown(pair, {
						streamId: CALLBACK_TRANSPORT_STREAM_ID,
						kind: "heartbeat",
						payload: {},
					});
				}
			}, HEARTBEAT_INTERVAL_MS),
			closed: false,
			outbox: new Fifo(),
			outboxBytes: 0,
			roomWaiters: [],
			lanes: new Map(),
			backlogBytes: 0,
		};
		this.#pairs.set(connectionId, pair);
		this.#indexPair(pair);
		unrefTimer(pair.heartbeatTimer);
		this.#sendDown(pair, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: { type: CALLBACK_PAIR_READY_TYPE, connectionId, generation },
		});
		this.#emitPairChange(workspaceId);
	}

	/** The socket's buffer emptied: hand it the envelopes that waited for room. */
	#onDrain(ws: ServerWebSocket<CallbackSocketData>): void {
		const pair = this.#pairOf(ws);
		if (pair !== undefined) this.#flush(pair);
	}

	#onClose(ws: ServerWebSocket<CallbackSocketData>): void {
		const pair = this.#pairOf(ws);
		if (pair !== undefined) this.#teardownPair(pair);
	}

	// --- up: daemon -> fleet messages ---------------------------------------------------

	/**
	 * One daemon message. A bad message (binary, not JSON, over the envelope cap,
	 * failing validation) is dropped, counted and logged; identity and seq
	 * violations close the pair with their typed code: they are not bad bytes.
	 */
	#onMessage(ws: ServerWebSocket<CallbackSocketData>, message: string | Buffer): void {
		const pair = this.#pairOf(ws);
		if (pair === undefined) return;
		// The fleet's server-wide Bun `maxPayloadLength` is sized for the browser
		// socket's commands, so the pair's own cap is enforced here, with the close
		// Bun itself sends for an over-cap message (1009).
		const size =
			typeof message === "string" ? Buffer.byteLength(message, "utf8") : message.byteLength;
		if (size > CALLBACK_WS_MAX_PAYLOAD_BYTES) {
			ws.close(1009, `message exceeds ${CALLBACK_WS_MAX_PAYLOAD_BYTES} bytes`);
			return;
		}
		pair.lastDataAt = this.#now();
		const bytes =
			typeof message === "string" ? Buffer.byteLength(message, "utf8") : message.byteLength;
		pair.bytesIn += bytes;
		const outstanding = pair.bytesIn - pair.creditGranted;
		if (outstanding > PAIR_CREDIT_WINDOW_BYTES) {
			for (const parked of pair.lanes.values()) parked.queue.clear();
			pair.lanes.clear();
			pair.backlogBytes = 0;
			this.#failPair(
				pair,
				callbackError(
					"invalid_request",
					`callback pair ignored its credit window: ${outstanding} bytes beyond the granted credit, window ${PAIR_CREDIT_WINDOW_BYTES}`,
				),
			);
			return;
		}
		this.#acceptMessage(pair, message, bytes);
		this.#grantCredit(pair);
	}

	/** Decode and route one counted message; a bad one is dropped, an identity or seq violation closes the pair. */
	#acceptMessage(pair: PairConnection, message: string | Buffer, bytes: number): void {
		if (typeof message !== "string") {
			this.#dropMessage(
				pair,
				callbackError("invalid_request", "binary message: the pair carries text envelopes only"),
			);
			return;
		}
		let envelope: CallbackEnvelope;
		try {
			envelope = decodeEnvelope(message, bytes);
		} catch (error) {
			if (!isCallbackError(error)) throw error;
			this.#dropMessage(pair, error);
			return;
		}
		try {
			this.#acceptEnvelope(pair, envelope, bytes, message);
		} catch (error) {
			if (!isCallbackError(error)) throw error;
			this.#failPair(pair, error);
		}
	}

	/**
	 * Tell the daemon how much of its upload this fleet has consumed, once a step
	 * more than the last grant has been. Consumed is what was received less what
	 * still waits in a lane behind a stuck sink: credit comes back only from the
	 * real consumer, and a stream that cannot drain holds its share of the window.
	 * Monotonic: a byte joins the backlog only as it is received, and leaves it
	 * into consumed.
	 */
	#grantCredit(pair: PairConnection): void {
		const consumed = pair.bytesIn - pair.backlogBytes;
		if (pair.closed || consumed - pair.creditGranted < PAIR_CREDIT_STEP_BYTES) return;
		pair.creditGranted = consumed;
		const grant: PairCreditControl = { type: "pair_credit", consumed };
		this.#sendDown(pair, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: grant,
		});
	}

	#dropMessage(pair: PairConnection, error: CallbackError): void {
		pair.droppedMessages += 1;
		this.#onDroppedMessage(
			`callback pair ${pair.workspaceId}@${pair.generation}: dropped message: ${error.message}`,
		);
	}

	/** Identity and seq violations end the pair: they are not bad bytes. */
	#acceptEnvelope(
		pair: PairConnection,
		envelope: CallbackEnvelope,
		bytes: number,
		message: string,
	): void {
		if (envelope.workspaceId !== pair.workspaceId || envelope.generation !== pair.generation) {
			throw callbackError(
				"forbidden",
				"callback envelope identity does not match the authenticated connection",
				{
					detail: `envelope=${envelope.workspaceId}@${envelope.generation} connection=${pair.workspaceId}@${pair.generation}`,
				},
			);
		}
		if (envelope.connectionId !== pair.connectionId) {
			throw callbackError(
				"invalid_request",
				"callback envelope connectionId does not match the socket",
			);
		}
		if (envelope.seq <= pair.lastSeq) {
			throw callbackError(
				"invalid_request",
				`callback envelope seq ${envelope.seq} is not monotonic (connection last seq ${pair.lastSeq})`,
			);
		}
		pair.lastSeq = envelope.seq;
		pair.envelopes += 1;
		if (envelope.kind === "heartbeat") return; // transport liveness only
		if (envelope.kind === "control" && envelope.streamId === CALLBACK_CONTROL_STREAM_ID) {
			this.#applyDownloadBulkFailed(pair.workspaceId, envelope.payload);
		}
		for (const tap of this.#taps.get(pair.workspaceId) ?? []) {
			try {
				tap(envelope);
			} catch {
				// a fleet tap must never break the transport
			}
		}
		const sink = this.#virtualStreams.get(pair.workspaceId)?.get(envelope.streamId);
		// No sink for this streamId: dropped by design (bounded transport).
		if (sink === undefined) return;
		this.#deliver(pair, sink, envelope, canonicalPayloadJson(message, envelope), bytes);
	}

	// --- down: fleet -> daemon messages ---------------------------------------------------

	/** Fleet → daemon envelope. Returns the registry-stamped envelope (down
	 * seq assigned) once it is queued for the socket.
	 * No live pair: throws `unavailable`; never queues offline work. */
	async sendToDaemon(workspaceId: string, draft: CallbackEnvelopeInput): Promise<CallbackEnvelope> {
		const pair = this.#pairsByWorkspace.get(workspaceId)?.at(-1);
		if (!pair) {
			throw callbackError(
				"unavailable",
				`workspace ${workspaceId} has no live callback pair; the fleet does not queue offline work`,
				{
					detail: `workspaceId=${workspaceId}`,
				},
			);
		}
		const envelope = this.#downEnvelope(pair, draft, pair.downSeq + 1);
		const text = JSON.stringify(envelope);
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > ENVELOPE_MAX_BYTES) return this.#sendOversize(pair, envelope);
		this.#commit(pair, envelope, text, bytes);
		return envelope;
	}

	/** Oversize down envelope. A command goes out as ordered chunk slices (every
	 * proto-2 session reassembles), each sent once the outbox has room for it, so
	 * the byte budget never trips. Anything else fails only this call, with
	 * payload_too_large; the pair stays up. */
	async #sendOversize(pair: PairConnection, probe: CallbackEnvelope): Promise<CallbackEnvelope> {
		const chunked = probe.kind === "command";
		const bytes = commandBytes(probe.payload);
		if (!chunked || bytes > MAX_COMMAND_BYTES) {
			const limit = chunked ? MAX_COMMAND_BYTES : ENVELOPE_MAX_BYTES;
			throw callbackError("payload_too_large", commandTooLargeMessage(bytes, limit));
		}
		let envelope: CallbackEnvelope | undefined;
		for (const slice of planOversizeSplit(probe).envelopes) {
			await this.#awaitRoom(pair, ENVELOPE_MAX_BYTES);
			envelope = this.#sendDown(pair, {
				streamId: slice.streamId,
				kind: slice.kind,
				payload: slice.payload,
				at: slice.at,
			});
		}
		if (envelope === undefined) {
			throw callbackError("invalid_request", "oversize command split into no slices");
		}
		return envelope;
	}

	/** Resolves once the outbox can take `bytes` more. A socket that stops draining
	 * past DOWN_ROOM_STALL_MS is dropped like any stalled reader. */
	async #awaitRoom(pair: PairConnection, bytes: number): Promise<void> {
		while (!pair.closed && CONNECTION_MAX_BYTES - pair.outboxBytes < bytes) {
			const room = Promise.withResolvers<"room" | "stalled">();
			const stall = setTimeout(() => room.resolve("stalled"), DOWN_ROOM_STALL_MS);
			unrefTimer(stall);
			pair.roomWaiters.push(() => room.resolve("room"));
			const outcome = await room.promise;
			clearTimeout(stall);
			if (outcome === "stalled") {
				const error = callbackError(
					"unavailable",
					`callback socket for ${pair.connectionId} stopped draining`,
				);
				this.#failPair(pair, error);
				throw error;
			}
		}
		if (pair.closed) {
			throw callbackError(
				"unavailable",
				`callback socket for ${pair.connectionId} closed mid-command`,
			);
		}
	}

	#downEnvelope(pair: PairConnection, draft: CallbackEnvelopeInput, seq: number): CallbackEnvelope {
		return {
			version: OMP_CALLBACK_PROTO,
			workspaceId: pair.workspaceId,
			generation: pair.generation,
			connectionId: pair.connectionId,
			streamId: draft.streamId,
			seq,
			kind: draft.kind,
			payload: draft.payload,
			at: draft.at ?? this.#now(),
		};
	}

	/** Register a pair as its workspace's newest socket (the live pair). */
	#indexPair(pair: PairConnection): void {
		const siblings = this.#pairsByWorkspace.get(pair.workspaceId);
		if (siblings === undefined) this.#pairsByWorkspace.set(pair.workspaceId, [pair]);
		else siblings.push(pair);
	}

	/** Drop a pair from its workspace's index; an older open socket becomes live again. */
	#unindexPair(pair: PairConnection): void {
		const siblings = this.#pairsByWorkspace.get(pair.workspaceId);
		if (siblings === undefined) return;
		const at = siblings.indexOf(pair);
		if (at < 0) return;
		siblings.splice(at, 1);
		if (siblings.length === 0) this.#pairsByWorkspace.delete(pair.workspaceId);
	}

	/** Build, stamp and queue one transport-originated (or already sliced) envelope. */
	#sendDown(pair: PairConnection, draft: CallbackEnvelopeInput): CallbackEnvelope {
		const envelope = this.#downEnvelope(pair, draft, pair.downSeq + 1);
		const text = JSON.stringify(envelope);
		this.#commit(pair, envelope, text, Buffer.byteLength(text, "utf8"));
		return envelope;
	}

	/** Assign the envelope its seq and queue it; past CONNECTION_MAX_BYTES of unsent bytes the pair is closed. */
	#commit(pair: PairConnection, envelope: CallbackEnvelope, text: string, bytes: number): void {
		pair.downSeq = envelope.seq;
		if (pair.closed) return;
		pair.outbox.push({ text, bytes });
		pair.outboxBytes += bytes;
		this.#flush(pair);
		if (!pair.closed && pair.outboxBytes > CONNECTION_MAX_BYTES) {
			this.#failPair(
				pair,
				callbackError(
					"retryable",
					`callback socket for ${pair.connectionId} stopped draining: ${pair.outboxBytes} unsent bytes`,
				),
			);
		}
	}

	/**
	 * Hand the socket queued envelopes while its buffer is at or under the
	 * high-water mark; the rest waits for `drain`. `send()` returns the byte count
	 * (sent), -1 (enqueued under backpressure) or 0 (DROPPED): a drop must never
	 * go unnoticed, so it closes the pair.
	 */
	#flush(pair: PairConnection): void {
		let moved = false;
		while (
			!pair.closed &&
			pair.outbox.length > 0 &&
			pair.ws.getBufferedAmount() <= CALLBACK_WS_SEND_HIGH_WATER_BYTES
		) {
			const item = pair.outbox.shift()!;
			pair.outboxBytes -= item.bytes;
			moved = true;
			if (pair.ws.send(item.text) === 0) {
				this.#failPair(
					pair,
					callbackError("retryable", `callback socket for ${pair.connectionId} dropped a message`),
				);
				return;
			}
			pair.lastSendAt = this.#now();
		}
		if (moved) for (const wake of pair.roomWaiters.splice(0)) wake();
	}

	/** End a pair with a close frame (omitted when the peer already closed). */
	#teardownPair(pair: PairConnection, close?: { code: number; reason: string }): void {
		if (pair.closed) return;
		pair.closed = true;
		for (const wake of pair.roomWaiters.splice(0)) wake();
		clearInterval(pair.heartbeatTimer);
		if (this.#pairs.get(pair.connectionId) === pair) this.#pairs.delete(pair.connectionId);
		this.#unindexPair(pair);
		pair.outbox.clear();
		pair.outboxBytes = 0;
		this.#emitPairChange(pair.workspaceId);
		if (close !== undefined) {
			try {
				pair.ws.close(close.code, close.reason);
			} catch {
				// already closed
			}
		}
	}

	/** Close the pair with the typed refusal frame for `error`; the daemon redials. */
	#failPair(pair: PairConnection, error: CallbackError): void {
		this.#teardownPair(pair, callbackCloseFor(error));
	}

	// --- virtual streams ---------------------------------------------------------

	/** Bind the consumer sink for (workspaceId, streamId). Rebinding replaces the sink. */
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
		streams.set(streamId, sink);
	}

	/** Unbind a sink; later envelopes for the stream are dropped (the consumer
	 * is gone by definition). */
	detachVirtualStream(workspaceId: string, streamId: string): void {
		const streams = this.#virtualStreams.get(workspaceId);
		if (!streams?.delete(streamId)) return;
		if (streams.size === 0) this.#virtualStreams.delete(workspaceId);
	}

	/**
	 * Hand one envelope to its sink. Order is strict per (pair, streamId): while
	 * a stream's sink holds a promise, that stream's later envelopes wait in its
	 * lane in arrival order; other streams of the pair are delivered meanwhile
	 * and never wait on it. A sink returning void delivers inline and allocates
	 * nothing (a lane exists only while a stream has an unsettled promise). The
	 * receive side cannot pause a server socket, so what a stuck stream can pile
	 * up is bounded by the upload credit instead: bytes parked in a lane are not
	 * consumed (see #grantCredit), the daemon stops at PAIR_CREDIT_WINDOW_BYTES,
	 * and one that sends past it closes the pair. A sink error never fails the pair.
	 */
	#deliver(
		pair: PairConnection,
		sink: VirtualStreamSink,
		envelope: CallbackEnvelope,
		payloadJson: string | undefined,
		bytes: number,
	): void {
		const lane = pair.lanes.get(envelope.streamId);
		if (lane === undefined) {
			const pending = this.#invokeSink(sink, envelope, payloadJson);
			if (pending !== undefined) {
				const parked: DeliveryLane = { queue: new Fifo() };
				pair.lanes.set(envelope.streamId, parked);
				this.#parkLane(pair, envelope.streamId, parked, pending);
			}
			return;
		}
		lane.queue.push({ sink, envelope, payloadJson, bytes });
		pair.backlogBytes += bytes;
	}

	/** Run one sink; its promise when it returned one, else undefined (sink errors never kill the transport). */
	#invokeSink(
		sink: VirtualStreamSink,
		envelope: CallbackEnvelope,
		payloadJson: string | undefined,
	): Promise<void> | undefined {
		let pending: void | Promise<void>;
		try {
			pending = sink.deliver(envelope, payloadJson);
		} catch {
			return undefined;
		}
		return pending instanceof Promise ? pending : undefined;
	}

	/** The lane's sink returned `pending`: once it settles (either way) the lane drains. */
	#parkLane(
		pair: PairConnection,
		streamId: string,
		lane: DeliveryLane,
		pending: Promise<void>,
	): void {
		const settled = (): void => this.#drainLane(pair, streamId, lane);
		// a sink rejection never kills the transport
		void pending.then(settled, settled);
	}

	/** The lane's sink settled: deliver its queued envelopes in order until one goes async again, then retire the lane. */
	#drainLane(pair: PairConnection, streamId: string, lane: DeliveryLane): void {
		for (;;) {
			const next = lane.queue.shift();
			if (next === undefined) {
				if (pair.lanes.get(streamId) === lane) pair.lanes.delete(streamId);
				this.#grantCredit(pair);
				return;
			}
			pair.backlogBytes -= next.bytes;
			const pending = this.#invokeSink(next.sink, next.envelope, next.payloadJson);
			if (pending !== undefined) {
				this.#parkLane(pair, streamId, lane, pending);
				this.#grantCredit(pair);
				return;
			}
		}
	}

	// --- bulk: POST /callback/bulk/<correlationId> ---------------------------------

	/** Issue a workspace-scoped correlation id for one daemon-initiated bulk
	 * transfer (single- or multi-part; unused or stalled correlations expire as
	 * failed). `capture: true` (fleet download requests) keeps the received
	 * parts so the fleet can serve them without reassembling a second copy;
	 * aggregate bytes stay capped at BULK_MAX_BYTES either way. Throws
	 * `retryable` while BULK_CAPTURE_MAX_OPEN capture transfers are open. */
	createBulkCorrelation(workspaceId: string, opts?: { capture?: boolean }): BulkCorrelation {
		if (!workspaceId)
			throw callbackError("invalid_request", "createBulkCorrelation requires a workspaceId");
		const capture = opts?.capture === true;
		if (capture) {
			let open = 0;
			for (const existing of this.#bulk.values()) {
				if (existing.capture && existing.state === "open") open += 1;
			}
			if (open >= BULK_CAPTURE_MAX_OPEN) {
				throw callbackError(
					"retryable",
					`too many concurrent downloads (limit ${BULK_CAPTURE_MAX_OPEN})`,
				);
			}
		}
		const correlationId = randomUUID();
		let resolve!: (result: BulkResult) => void;
		const done = new Promise<BulkResult>((res) => {
			resolve = res;
		});
		this.#bulk.set(correlationId, {
			correlationId,
			workspaceId,
			touchedAt: this.#now(),
			state: "open",
			bytes: 0,
			capture,
			chunks: [],
			reader: null,
			nextPart: 0,
			resolve,
		});
		return {
			correlationId,
			done,
			cancel: (reason) => {
				const record = this.#bulk.get(correlationId);
				if (record) this.#failBulk(record, record.bytes, reason);
			},
		};
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
		// Multi-part transfers (downloads): a daemon streams one logical
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
		const reader = req.body.getReader();
		record.reader = reader;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || record.state !== "open") break;
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
				record.touchedAt = this.#now();
				if (record.capture) record.chunks.push(value);
			}
			if (record.state !== "open") {
				throw callbackError(
					"conflict",
					`bulk correlation ${correlationId} is already ${record.state}`,
				);
			}
		} catch (error) {
			if (isCallbackError(error)) throw error;
			this.#failBulk(record, record.bytes + partBytes, "bulk upload aborted");
			throw callbackError("unavailable", "bulk upload connection aborted", { cause: error });
		} finally {
			record.reader = null;
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
			result.chunks = record.chunks;
			record.chunks = [];
		}
		record.resolve(result);
		// Transport receipt ONLY; archive acceptance is the archive store's
		// durable receipt (manifest verify + atomic rename), never this 200.
		return Response.json({ status: "received", correlationId, bytes: record.bytes });
	}

	// --- materialization (wake: bulk download from the log store) --------

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
	 * response under a bulk correlation. Called for EVERY bulk POST
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
	 * lib/session-files/wake-materialize.ts emitMaterializeTransfer). The daemon's own
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

		const transfer = emitMaterializeTransfer(
			plan,
			request.sessionId,
			request.cursor,
			MATERIALIZE_TRANSFER_MAX_BYTES,
			auth.workspaceId,
		);
		// One record per pull: the body is produced as the daemon reads it, so
		// a slow reader holds at most one encoded record and the file fd stays
		// open only while the transfer is in flight (cancel closes it).
		// The fleet-issued bulk record never exists for this correlation (the
		// daemon minted it), so there is no record to settle; the HTTP 200 with
		// the full NDJSON body IS the transport receipt.
		const body = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				try {
					const next = transfer.next();
					if (next.done) {
						controller.close();
						return;
					}
					controller.enqueue(Buffer.from(next.value, "utf8"));
				} catch (error) {
					controller.error(error instanceof Error ? error : new Error(String(error)));
				}
			},
			cancel: () => {
				transfer.return(undefined);
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
		record.chunks = [];
		void record.reader?.cancel().catch(() => {});
		record.bytes = bytes;
		record.resolve({
			correlationId: record.correlationId,
			workspaceId: record.workspaceId,
			state: "failed",
			bytes,
			error,
		});
	}

	/** Daemon-reported transfer failure (download_bulk_failed control): fail that
	 * correlation now rather than waiting for the idle expiry. */
	#applyDownloadBulkFailed(workspaceId: string, payload: unknown): void {
		if (typeof payload !== "object" || payload === null) return;
		if (!("type" in payload) || payload.type !== "download_bulk_failed") return;
		if (!("correlationId" in payload) || typeof payload.correlationId !== "string") return;
		const record = this.#bulk.get(payload.correlationId);
		if (!record || record.workspaceId !== workspaceId) return;
		const message =
			"error" in payload &&
			typeof payload.error === "object" &&
			payload.error !== null &&
			"message" in payload.error &&
			typeof payload.error.message === "string"
				? payload.error.message.slice(0, 500)
				: "";
		this.#failBulk(record, record.bytes, message || "the daemon reported a failed transfer");
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

	/** Point-in-time pair/enrollment view for the fleet edge. */
	pairStatus(workspaceId: string): PairStatus {
		const authorizedGeneration = this.#authorizedMax.get(workspaceId) ?? null;
		const workspacePairs = this.#pairsByWorkspace.get(workspaceId);
		const live = workspacePairs?.at(-1) ?? null;
		let upBytesIn = 0;
		let envelopesReceived = 0;
		let lastEnvelopeAt: number | null = null;
		for (const pair of workspacePairs ?? []) {
			upBytesIn += pair.bytesIn;
			envelopesReceived += pair.envelopes;
			if (lastEnvelopeAt === null || pair.lastDataAt > lastEnvelopeAt)
				lastEnvelopeAt = pair.lastDataAt;
		}
		return {
			workspaceId,
			enrolled: authorizedGeneration !== null,
			authorizedGeneration,
			paired: live !== null,
			connectionId: live?.connectionId ?? null,
			lastEnvelopeAt,
			lastDownSendAt: live?.lastSendAt ?? null,
			envelopesReceived,
			upBytesIn,
		};
	}

	#sweep(): void {
		const now = this.#now();
		// The daemon's heartbeat is the fleet's liveness evidence for a socket: past
		// the silence deadline the pair is dead, and leaving it registered would
		// report a dead daemon as paired and accept commands into a zombie.
		for (const pair of [...this.#pairs.values()]) {
			if (now - pair.lastDataAt > SILENCE_DEADLINE_MS) {
				this.#failPair(
					pair,
					callbackError(
						"unavailable",
						`callback socket silent past the ${SILENCE_DEADLINE_MS} ms silence deadline`,
					),
				);
			}
		}
		for (const [correlationId, record] of this.#bulk) {
			if (now - record.touchedAt <= BULK_IDLE_MS) continue;
			if (record.state === "open") this.#failBulk(record, record.bytes, "bulk correlation expired");
			else this.#bulk.delete(correlationId);
		}
		for (const [key, record] of this.#enrollments) {
			if (
				record.revokedAt !== undefined &&
				now - record.revokedAt > ENROLLMENT_REVOKED_RETENTION_MS
			)
				this.#enrollments.delete(key);
		}
	}

	/** Tear everything down (fleet shutdown / tests). Open bulk correlations
	 * settle failed; live pairs close; enrollments are cleared. */
	close(): void {
		clearInterval(this.#sweepTimer);
		for (const pair of [...this.#pairs.values()]) {
			this.#teardownPair(pair, { code: 1001, reason: "fleet shutting down" });
		}
		for (const record of this.#bulk.values())
			this.#failBulk(record, record.bytes, "transport closed");
		this.#bulk.clear();
		this.#virtualStreams.clear();
		this.#taps.clear();
		this.#enrollments.clear();
		this.#authorizedMax.clear();
	}
}
