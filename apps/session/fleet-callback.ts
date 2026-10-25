import { randomUUID } from "node:crypto";
import {
	BULK_FINAL_HEADER,
	BULK_MAX_BYTES,
	BULK_PART_HEADER,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	CONNECTION_MAX_BYTES,
	ENVELOPE_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	OMP_CALLBACK_PROTO,
	PAIR_CREDIT_WINDOW_BYTES,
	PAIR_READY_TIMEOUT_MS,
	RECONNECT_BACKOFF_MAX_MS,
	RECONNECT_BACKOFF_MIN_MS,
	SILENCE_DEADLINE_MS,
	STREAM_MAX_BYTES,
	WAKE_TIMEOUT_MS,
	CallbackError,
	callbackError,
	callbackErrorFromClose,
	codeFromHttpStatus,
	decodeEnvelope,
	envelopeFraming,
	PreEncodedPayload,
	preEncodePayload,
	isCallbackErrorCode,
	isPairCreditControl,
	isChunkPayload,
	reassembleChunks,
	validateEnvelope,
	type CallbackEnvelope,
	type CallbackErrorCode,
	type CallbackKind,
	type ChunkEnvelopePayload,
} from "#lib/wire/callback-protocol";
import { assertCallbackProxy, callbackWsUrl, environmentProxy } from "#lib/wire/callback-endpoint";
import { MAX_COMMAND_BYTES } from "#lib/wire/command-limits";
import {
	parseMaterializeRecord,
	type MaterializeRecord,
	type MaterializeRequest,
} from "#lib/session-files/wake-materialize";
import { isLoopbackHost } from "#lib/platform/hosts";

/**
 * Callback transport, session half (OMP_CALLBACK_PROTO 2). The session dials OUT
 * to the fleet and keeps one WebSocket per workspace+generation:
 *
 *   GET <base>/callback/ws   upgrade; one text message = one canonical-JSON envelope
 *
 * The base URL scheme maps http to ws and https to wss (http only for an
 * explicit loopback exception, enforced at construction). Identity, the
 * enrollment credential and the protocol version ride the upgrade request
 * HEADERS (x-omp-workspace-id, x-omp-generation, x-omp-connection-id,
 * x-omp-callback-proto, `authorization: Bearer <credential>`), never the URL.
 * A fresh connectionId (crypto.randomUUID()) is minted per socket; it also
 * names the live pair on bulk requests (POST /callback/bulk/<id>), which stay
 * plain HTTP on their own requests so a 64 MiB transfer never blocks the pair.
 *
 * Refusal: a WebSocket client cannot read a non-101 status, so the fleet
 * upgrades a refused dial and closes it at once with a typed refusal code
 * (callbackErrorFromClose). A credential rejection (unauthorized,
 * invalid_identity, generation_obsolete) or proto_unsupported is terminal: the
 * instance stops, onRejected fires, and nothing redials. Every other close, and
 * a dial that fails outright (a socket error with no status), is retryable.
 *
 * Pair lifecycle:
 *   - start() resolves when the fleet's in-band `pair_ready` control envelope
 *     (streamId "transport", the first message on an accepted socket) arrives,
 *     within the pair-ready timeout. The backlog is held until then.
 *   - A socket close or error, a refusal close, 30 s without an inbound
 *     envelope, or an outbound backlog that never drains within the silence
 *     deadline replaces the pair after jittered 1 s to 30 s backoff.
 *   - The fleet emits 15 s `heartbeat` envelopes (streamId "transport"); the
 *     session mirrors 15 s heartbeats (streamId "control") while idle. Liveness
 *     is this envelope deadline, never WebSocket ping/pong.
 *   - A fresh socket is a fresh connectionId and a fresh inbound seq space;
 *     nothing is resumed. The session's own seq stays monotonic across pairs so
 *     the fleet floor and the session replay rings share one space.
 *   - A message that is binary or fails envelope validation is dropped,
 *     counted (status.badMessages) and reported through onError; it never ends
 *     the pair.
 *
 * Flow control: an envelope is handed to the socket only while its send
 * buffer (`bufferedAmount`) is at or below CALLBACK_WS_SEND_HIGH_WATER_BYTES.
 * Bun's client WebSocket fires no drain event (probed on 1.4.2: only
 * open/message/error/close), so a blocked pump re-checks on a short timer
 * (SEND_RECHECK_MS) while the unsent envelopes wait in the bounded queue below.
 *
 * Credit: on top of that gate, a message is handed to the socket only while
 * the bytes sent beyond the fleet's last pair_credit grant (cumulative, see
 * PairCreditControl), plus this message, fit PAIR_CREDIT_WINDOW_BYTES. Bytes
 * are the UTF-8 length of the text message, assembled exactly from the
 * framing and the payload length known at enqueue (no scan of the payload).
 * A pump that waits for credit sets no timer: a grant wakes it (a fleet that
 * never grants is replaced by the stall timer like any non-reading peer). The
 * window is per pair; a fresh socket starts from zero.
 *
 * Outbound envelopes are held in a bounded queue (8 MiB per connection,
 * 4 MiB per virtual stream; the ledger caps). The fleet keeps no offline
 * queue, so envelopes queued while a pair is down are replayed on the fresh
 * pair; when the buffer is full a send is DROPPED, counted, and surfaced as
 * a typed retryable error via onError. Single envelopes over the 1 MiB cap
 * are rejected the same way (invalid_request). This module never throws
 * after start(): every failure reaches onError / onStatus.
 *
 * HTTPS is enforced at construction (matching config.ts): http is refused
 * unless `allowHttp` is set AND the host is loopback. An http/https proxy is
 * passed to every dial and every bulk fetch: the explicit `proxy` option, else
 * the HTTP(S)_PROXY / NO_PROXY environment, which Bun's fetch honors on its
 * own but its WebSocket client ignores, so it is resolved here for both. There
 * is no silent fallback to a direct connection, and an unsupported proxy
 * scheme is a construction-time error.
 */

/** Header names binding a callback pair (frozen by Main). */
export const CALLBACK_IDENTITY_HEADERS = {
	workspaceId: "x-omp-workspace-id",
	generation: "x-omp-generation",
	connectionId: "x-omp-connection-id",
} as const;

// The control-plane wire literals (transport streamId, session heartbeat
// streamId, pair_ready payload type) live in lib/wire/callback-protocol.ts;
// re-export so the FleetCallback public surface for Main's wiring is stable.
export { CALLBACK_TRANSPORT_STREAM_ID, CALLBACK_CONTROL_STREAM_ID, CALLBACK_PAIR_READY_TYPE };

/** Re-check interval while the socket's send buffer is above the high-water mark (no client drain event exists). */
const SEND_RECHECK_MS = 10;

/**
 * Bun's WebSocket client constructor. The tsconfig loads the DOM lib, whose
 * WebSocket type hides Bun's upgrade `headers`, `proxy` and `perMessageDeflate`
 * options and `terminate()`; this is the same global under its Bun typings.
 */
const BunWebSocket = WebSocket as unknown as new (
	url: string | URL,
	options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

/** Refusals that end the instance for good: the credential or generation is dead, or the fleet speaks another protocol. */
const TERMINAL_REFUSALS: Record<string, true> = {
	unauthorized: true,
	invalid_identity: true,
	generation_obsolete: true,
	proto_unsupported: true,
};

export type FleetCallbackState = "idle" | "connecting" | "ready" | "reconnecting" | "stopped";

/** Outbound envelope the session hands the pair; identity/seq/at are stamped at emit. */
export interface CallbackSendInput {
	/** Logical per-browser/control stream within the connection. */
	streamId: string;
	kind: CallbackKind;
	/**
	 * The payload value, or a {@link PreEncodedPayload} the sender serialized
	 * once and shares across streams or keeps for replay (never re-serialized).
	 */
	payload: unknown;
	/**
	 * Called with the FINAL envelope seq the moment the envelope is written
	 * to the wire (seq is assigned at pump time on the live pair, so this is
	 * the only exact source). Used by the control broker to keep per-stream
	 * replay rings keyed on the real seqs the fleet observed.
	 */
	onEmittedSeq?: (seq: number) => void;
}

export type CallbackSendResult = "sent" | "dropped" | "rejected" | "stopped";

export interface FleetCallbackOptions {
	/** Fleet callback base URL (https; http only with allowHttp on a loopback host). */
	url: string;
	/** Roster workspace this pair is bound to. */
	workspaceId: string;
	/** Authorized generation this pair speaks for. */
	generation: number;
	/** Enrollment credential; sent as `authorization: Bearer <token>` on the upgrade and every bulk request. */
	token?: string;
	/** Explicit http(s) proxy for the pair socket and bulk requests; absent = the HTTP(S)_PROXY / NO_PROXY environment, else direct. Never silently bypassed. */
	proxy?: string;
	/** Explicit loopback-HTTP exception; honored only for loopback callback hosts. */
	allowHttp?: boolean;
	// Timing / limits: production defaults are the ledger constants; tests
	// shrink them to observe cadence deterministically.
	heartbeatMs?: number;
	silenceMs?: number;
	readyTimeoutMs?: number;
	/** Deadline for one bulk-channel request (materialize or upload part); past it the caller gets a retryable error. */
	bulkTimeoutMs?: number;
	backoffMinMs?: number;
	backoffMaxMs?: number;
	connectionBufferBytes?: number;
	streamBufferBytes?: number;
	maxEnvelopeBytes?: number;
}

export interface FleetCallbackErrorContext {
	phase: "send" | "receive" | "pair";
	streamId?: string;
	kind?: CallbackKind;
}

export interface FleetCallbackEvents {
	onStatus?: (status: FleetCallbackStatus) => void;
	onError?: (error: CallbackError, context: FleetCallbackErrorContext) => void;
	/** Down traffic: every validated non-heartbeat, non-pair-ready envelope the fleet sent. */
	onEnvelope?: (envelope: CallbackEnvelope) => void;
	/**
	 * Down control envelopes (kind "control" on the transport or a browser
	 * stream_open/stream_close on `browser/<connId>` streams, and
	 * log_ack/log_gap on the transport stream. Distinct from
	 * onEnvelope so the transport's own control traffic is routed without
	 * touching the raw frame forwarding path.
	 */
	onControl?: (envelope: CallbackEnvelope) => void;
	/**
	 * Terminal refusal: the fleet rejected this credential (`unauthorized`,
	 * `invalid_identity`), superseded its generation (`generation_obsolete`) or
	 * speaks another callback protocol (`proto_unsupported`). The instance is
	 * already stopped when this fires; no reconnect follows.
	 */
	onRejected?: (error: CallbackError) => void;
}

export interface FleetCallbackStatus {
	state: FleetCallbackState;
	workspaceId: string;
	generation: number;
	/** Live pair connection id; null while idle/stopped. */
	connectionId: string | null;
	/** Seq of the current pair (last assigned). */
	seq: number;
	/** Envelopes actually written to the wire. */
	sent: number;
	/** Non-heartbeat envelopes read from the socket. */
	received: number;
	/** Envelopes dropped because the outbound buffer was full. */
	drops: number;
	/** Envelopes rejected before queueing (oversize / not JSON-serializable / bad shape). */
	rejected: number;
	/** Inbound messages dropped as binary or as invalid envelopes. */
	badMessages: number;
	/** Failure-driven pair replacements. */
	reconnects: number;
	/** Times the pair reached ready (fresh after every replacement). */
	readyCount: number;
	pendingEnvelopes: number;
	pendingBytes: number;
	/** Epoch ms of the next re-dial attempt while reconnecting. */
	reconnectAt: number | null;
	lastError: { code: CallbackErrorCode; message: string; at: number } | null;
	startedAt: number | null;
	readyAt: number | null;
}

/** Outcome of one {@link FleetCallback.requestBulkMaterialize} transfer. */
export interface MaterializeResult {
	/** Correlation id the fleet served this transfer under. */
	correlationId: string;
	/** Validated NDJSON records of the transfer (lead session, files, chunks, end). */
	records: MaterializeRecord[];
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	readonly settled: boolean;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	let settled = false;
	const promise = new Promise<T>((res, rej) => {
		resolve = (value: T) => {
			if (!settled) {
				settled = true;
				res(value);
			}
		};
		reject = (reason?: unknown) => {
			if (!settled) {
				settled = true;
				rej(reason);
			}
		};
	});
	return {
		promise,
		resolve,
		reject,
		get settled() {
			return settled;
		},
	};
}

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
}

interface PendingItem {
	streamId: string;
	kind: CallbackKind;
	/** The payload's canonical JSON, serialized once at enqueue (or shared by the sender). */
	payloadJson: string;
	/** The payload's UTF-8 byte length (known at enqueue): a message's exact wire size is its framing plus this. */
	payloadBytes: number;
	/** Projected wire bytes (canonical JSON with the current identity), for buffer accounting. */
	bytes: number;
	/** Transport-internal (heartbeat): dropped silently, never counted or reported. */
	internal: boolean;
	/** Called with the final wire seq the moment this envelope is actually written. */
	onEmittedSeq?: (seq: number) => void;
}

interface PairEnd {
	/** `drained`: the shutdown drain closed the socket; the supervisor dials no replacement. */
	kind: "failure" | "drained" | "stopped";
	error?: CallbackError;
}

interface PairHandle {
	connectionId: string;
	socket: Bun.WebSocket;
	/** Last assigned envelope seq. */
	seq: number;
	/** Wire bytes handed to this socket (UTF-8 length of every text message). */
	sentBytes: number;
	/** Highest cumulative `consumed` the fleet granted on this socket (never above sentBytes). */
	grantedBytes: number;
	/** False once torn down / superseded / stopped. */
	open: boolean;
	/** Chunked commands in flight on this socket, keyed by chunkId. */
	chunks: Map<string, CallbackEnvelope[]>;
	/** Last socket `error` event text, folded into the close failure's detail. */
	socketError: string | undefined;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	silenceTimer: ReturnType<typeof setTimeout> | null;
	stallTimer: ReturnType<typeof setTimeout> | null;
	/** Pending re-check of a send buffer above high water. */
	sendTimer: ReturnType<typeof setTimeout> | null;
	/** Resolved exactly once, by finishPair (failure/drained) or teardown (stopped). */
	end: Deferred<PairEnd>;
	/** Resolved when the socket's close event fires, whoever ended it. */
	closed: Deferred<void>;
	/** Resolved when the fleet's pair_ready envelope arrives for this pair. */
	readyWaiter: Deferred<void>;
	readyArrived: boolean;
}

/**
 * Typed refusal of a non-2xx fleet response: the body's `error`, `message`, and
 * `detail` when present. The code falls back to the HTTP status when the body
 * carries no frozen error code.
 */
function parseRefusal(
	status: number,
	text: string,
): { code: CallbackErrorCode; message: string | undefined; detail: string | undefined } {
	let body: { error?: unknown; message?: unknown; detail?: unknown } | null = null;
	try {
		body = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown } | null;
	} catch {
		// Non-JSON body: fall through to the HTTP-status mapping.
	}
	const error = body?.error;
	const message = body?.message;
	const detail = body?.detail;
	return {
		code:
			typeof error === "string" && isCallbackErrorCode(error) ? error : codeFromHttpStatus(status),
		message: typeof message === "string" && message.length > 0 ? message : undefined,
		detail: typeof detail === "string" ? detail : undefined,
	};
}

function errMsg(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export class FleetCallback {
	readonly #base: string;
	readonly #wsUrl: string;
	readonly #workspaceId: string;
	readonly #generation: number;
	readonly #token: string | undefined;
	readonly #proxy: string | undefined;
	readonly #heartbeatMs: number;
	readonly #silenceMs: number;
	readonly #readyTimeoutMs: number;
	readonly #backoffMinMs: number;
	readonly #backoffMaxMs: number;
	readonly #connectionBufferBytes: number;
	readonly #streamBufferBytes: number;
	readonly #maxEnvelopeBytes: number;
	readonly #events: FleetCallbackEvents | undefined;

	#state: FleetCallbackState = "idle";
	#started = false;
	#stopped = false;
	#everReady = false;
	#startDeferred: Deferred<void> | null = null;
	#startedAt: number | null = null;
	#readyAt: number | null = null;

	/** The live pair: carries writes and is read for commands. */
	#pair: PairHandle | null = null;

	/** Outbound queue; bytes are capped, so this doubles as the 8 MiB/4 MiB hold. */
	#pending: Array<PendingItem | undefined> = [];
	#pendingHead = 0;
	#pendingBytes = 0;
	#streamBytes = new Map<string, number>();

	#sent = 0;
	#received = 0;
	#drops = 0;
	#rejected = 0;
	#badMessages = 0;
	#reconnects = 0;
	#readyCount = 0;
	/** Highest seq assigned on any pair. Seq stays monotonic across pair replacements so the fleet floor and the session ring share one space. */
	#seqHigh = 0;
	#backoffAttempt = 0;
	#backoffTimer: ReturnType<typeof setTimeout> | null = null;
	#backoffResolve: ((stopped: boolean) => void) | null = null;
	#reconnectAt: number | null = null;
	#lastError: { code: CallbackErrorCode; message: string; at: number } | null = null;
	/** Aborts every in-flight bulk request (materialize, upload part) on stop(). */
	#bulkAbort = new AbortController();
	#bulkTimeoutMs: number;
	/** Set by drain(): the supervisor ends the pair without dialing a replacement. */
	#draining = false;

	constructor(options: FleetCallbackOptions, events?: FleetCallbackEvents) {
		let url: URL;
		try {
			url = new URL(options.url);
		} catch (cause) {
			throw new Error(`invalid callback url "${options.url}" (not a URL)`, { cause });
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error(`invalid callback url "${options.url}" (${url.protocol} is not http/https)`);
		}
		if (url.protocol === "http:") {
			if (options.allowHttp !== true) {
				throw new Error(
					`callback url uses http ("${options.url}"): https is required; pass allowHttp only for an explicit loopback exception`,
				);
			}
			if (!isLoopbackHost(url.hostname)) {
				throw new Error(`callback http is only allowed for loopback hosts, got "${url.hostname}"`);
			}
		}
		if (typeof options.workspaceId !== "string" || options.workspaceId.length === 0) {
			throw new Error("callback workspaceId is required");
		}
		if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
			throw new Error(
				`invalid callback generation ${options.generation} (positive integer required)`,
			);
		}
		const proxyUrl = options.proxy ?? environmentProxy(url);
		if (proxyUrl !== undefined) assertCallbackProxy(proxyUrl);
		this.#base = options.url.replace(/\/+$/, "");
		this.#wsUrl = callbackWsUrl(this.#base);
		this.#workspaceId = options.workspaceId;
		this.#generation = options.generation;
		this.#token = options.token;
		this.#proxy = proxyUrl;
		this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
		this.#silenceMs = options.silenceMs ?? SILENCE_DEADLINE_MS;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? PAIR_READY_TIMEOUT_MS;
		this.#bulkTimeoutMs = options.bulkTimeoutMs ?? WAKE_TIMEOUT_MS;
		this.#backoffMinMs = options.backoffMinMs ?? RECONNECT_BACKOFF_MIN_MS;
		this.#backoffMaxMs = options.backoffMaxMs ?? RECONNECT_BACKOFF_MAX_MS;
		this.#connectionBufferBytes = options.connectionBufferBytes ?? CONNECTION_MAX_BYTES;
		this.#streamBufferBytes = options.streamBufferBytes ?? STREAM_MAX_BYTES;
		this.#maxEnvelopeBytes = options.maxEnvelopeBytes ?? ENVELOPE_MAX_BYTES;
		this.#events = events;
	}

	/**
	 * Start the pair. Resolves when the pair is READY (socket open, pair_ready
	 * observed); rejects only if stop() runs first. Safe to call once; a
	 * stopped instance rejects.
	 */
	start(): Promise<void> {
		if (this.#stopped) {
			return Promise.reject(new Error("FleetCallback is stopped"));
		}
		if (this.#started) {
			return this.#startDeferred?.promise ?? Promise.resolve();
		}
		this.#started = true;
		this.#startedAt = Date.now();
		this.#startDeferred = deferred<void>();
		const startDeferred = this.#startDeferred;
		this.#state = "connecting";
		this.#emitStatus();
		void this.#supervise();
		return startDeferred.promise;
	}

	/** Terminal: closes the socket, cancels timers/backoff; no reconnects after. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#bulkAbort.abort();
		this.#state = "stopped";
		this.#cancelBackoff();
		if (this.#pair) this.#teardownPair(this.#pair);
		if (this.#startDeferred) {
			const start = this.#startDeferred;
			this.#startDeferred = null;
			start.reject(new Error("FleetCallback stopped before the pair became ready"));
		}
		this.#emitStatus();
	}

	/**
	 * Shutdown drain. Waits up to `timeoutMs` for every queued envelope to be
	 * written to the socket and its send buffer to empty, then closes the socket
	 * with a normal close (the supervisor dials no replacement). Bun's client
	 * reports the close as soon as it is initiated, and the closing frame follows
	 * the buffered data on the wire, so nothing queued is lost. Never throws; a
	 * pair that is not ready has nothing to hand off and returns at once.
	 */
	async drain(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (
			this.#state === "ready" &&
			Date.now() < deadline &&
			(this.#pendingHead < this.#pending.length || (this.#pair?.socket.bufferedAmount ?? 0) > 0)
		) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		const pair = this.#pair;
		if (this.#stopped || pair === null || !pair.open || this.#state !== "ready") return;
		this.#draining = true;
		try {
			pair.socket.close(1000, "session shutting down");
		} catch {
			// Already closing; the close event still settles `closed`.
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		});
		try {
			await Promise.race([pair.closed.promise, bound]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Queue one envelope for the pair. Identity (workspaceId/generation/
	 * connectionId), seq, and at are stamped at emit, so envelopes queued
	 * while a pair is down replay on the fresh pair (the fleet keeps no
	 * offline queue). Returns "sent" when accepted into the bounded queue,
	 * "dropped" when a buffer cap is hit (counted + retryable onError),
	 * "rejected" when the envelope is invalid or over the 1 MiB cap
	 * (invalid_request onError), or "stopped" when not started, stopped, or draining.
	 */
	send(input: CallbackSendInput): CallbackSendResult {
		if (!this.#started || this.#stopped || this.#draining) return "stopped";
		return this.#enqueue({
			streamId: input.streamId,
			kind: input.kind,
			payload: input.payload,
			internal: false,
			...(input.onEmittedSeq !== undefined ? { onEmittedSeq: input.onEmittedSeq } : {}),
		});
	}

	/**
	 * POST a materialization request over the bulk channel (wake): the
	 * session mints a fresh correlation id and asks the fleet to serve the
	 * workspace's stored session lineage bytes as NDJSON. Requires a READY
	 * pair (a reconnecting or stopped pair has no live identity headers).
	 * Returns null when the fleet lacks the session, and throws
	 * {@link CallbackError} on transport failures or malformed responses.
	 */
	async requestBulkMaterialize(request: MaterializeRequest): Promise<MaterializeResult | null> {
		const pair = this.#pair;
		if (!this.#started || this.#stopped || pair === null || !pair.open || this.#state !== "ready") {
			throw callbackError("unavailable", "materialization unavailable: no ready callback pair", {
				detail: "the session has no live fleet pair to request the stored session from",
			});
		}
		const correlationId = randomUUID();
		const headers: Record<string, string> = {
			...this.#identityHeaders(pair),
			"content-type": "application/json",
		};
		const init = this.#fetchInit(
			AbortSignal.any([this.#bulkAbort.signal, AbortSignal.timeout(this.#bulkTimeoutMs)]),
			{ method: "POST", headers, body: JSON.stringify(request) },
		);
		let res: Response;
		try {
			res = await fetch(`${this.#base}${CALLBACK_BULK_PATH_PREFIX}${correlationId}`, init);
		} catch (cause) {
			throw callbackError("retryable", "materialization request failed", { cause });
		}
		let text: string;
		try {
			text = await res.text();
		} catch (cause) {
			throw callbackError("retryable", "materialization response failed", { cause });
		}
		if (res.status === 200) {
			const lines = text.split("\n").filter((line) => line.trim() !== "");
			const records: MaterializeRecord[] = [];
			for (const line of lines) {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					throw callbackError(
						"invalid_request",
						"materialization response carried malformed NDJSON",
						{
							detail: line.slice(0, 200),
						},
					);
				}
				records.push(parseMaterializeRecord(value));
			}
			return { correlationId, records };
		}
		// Typed fleet error body ({error, message, detail?}) or the HTTP
		// status mapping. A missing stored session surfaces as `unavailable`
		// (HTTP 503 via the frozen status map); the session reports it typed
		// and the caller decides.
		const { code, message, detail } = parseRefusal(res.status, text);
		throw callbackError(code, message ?? `materialization refused: HTTP ${res.status}`, {
			...(detail !== undefined ? { detail } : {}),
		});
	}

	/**
	 * Upload one file to the fleet as strictly-sequential multi-part raw bytes
	 * over the bulk channel (Transport/Lifecycle 2026-09-06 contract). The
	 * session streams each part via `readable` to
	 * POST /callback/bulk/<correlationId> with the usual identity headers plus
	 * `x-omp-bulk-part: <n>` (0-based) and `x-omp-bulk-final: 1` on the last
	 * part. The AGGREGATE stays capped at the ledger's BULK_MAX_BYTES (64 MiB);
	 * multi-part exists so neither side buffers the whole body at once.
	 *
	 * Requires a READY pair. Throws {@link CallbackError}: `unavailable` with
	 * no transport/parts rejected, `invalid_request` when the fleet reports a
	 * malformed part, `conflict` when the fleet refuses the correlation
	 * (wrong state/expired), `retryable` on transport/HTTP failures. Any
	 * failure fails the whole correlation; the caller reports it via
	 * DownloadBulkFailedControl.
	 */
	async requestBulkUploadParts(input: {
		correlationId: string;
		/** Total bytes across all parts; must not exceed BULK_MAX_BYTES. */
		totalBytes: number;
		/** Stream the body of part `part` (0-based). Must yield exactly the declared bytes. */
		readPart: (part: number, partSize: number) => Promise<Uint8Array>;
		/** Chunk size per part (default 4 MiB). */
		partSize?: number;
	}): Promise<void> {
		const pair = this.#pair;
		if (!this.#started || this.#stopped || pair === null || !pair.open || this.#state !== "ready") {
			throw callbackError("unavailable", "bulk upload unavailable: no ready callback pair", {
				detail: "the session has no live fleet pair to upload to",
			});
		}
		if (input.totalBytes < 0 || input.totalBytes > BULK_MAX_BYTES) {
			throw callbackError(
				"invalid_request",
				`bulk upload of ${input.totalBytes} bytes exceeds the 64 MiB bulk cap`,
			);
		}
		const partSize = Math.max(1, Math.floor(input.partSize ?? 4 * 1024 * 1024));
		const partCount = Math.max(1, Math.ceil(input.totalBytes / partSize));
		for (let part = 0; part < partCount; part++) {
			const start = part * partSize;
			const size = Math.min(partSize, input.totalBytes - start);
			let body: Uint8Array;
			try {
				body = await input.readPart(part, size);
			} catch (cause) {
				throw callbackError("retryable", `bulk upload part ${part} read failed`, { cause });
			}
			const headers: Record<string, string> = {
				...this.#identityHeaders(pair),
				"content-type": "application/octet-stream",
				[BULK_PART_HEADER]: String(part),
				...(part === partCount - 1 ? { [BULK_FINAL_HEADER]: "1" } : {}),
			};
			const signal = AbortSignal.any([
				this.#bulkAbort.signal,
				AbortSignal.timeout(this.#bulkTimeoutMs),
			]);
			const init: RequestInit = this.#fetchInit(signal, {
				method: "POST",
				headers,
				// BodyInit under the DOM lib rejects plain Uint8Array; a
				// single-part ReadableStream is accepted and streams the exact
				// bytes.
				body: new ReadableStream<Uint8Array>({
					start: (controller) => {
						controller.enqueue(body);
						controller.close();
					},
				}),
				duplex: "half",
			});
			let res: Response;
			try {
				res = await fetch(`${this.#base}${CALLBACK_BULK_PATH_PREFIX}${input.correlationId}`, init);
			} catch (cause) {
				throw callbackError("retryable", `bulk upload part ${part} failed`, { cause });
			}
			const text = await res.text().catch(() => "");
			if (!res.ok) {
				const { code, message } = parseRefusal(res.status, text);
				throw callbackError(
					code,
					message ?? `bulk upload part ${part} refused: HTTP ${res.status}`,
					{
						detail: `part ${part} of ${partCount} for correlation ${input.correlationId}`,
					},
				);
			}
		}
	}

	/** Bytes waiting in the outbound buffer for one stream and across the connection (send pacing). */
	bufferedBytes(streamId: string): { stream: number; connection: number } {
		return { stream: this.#streamBytes.get(streamId) ?? 0, connection: this.#pendingBytes };
	}

	/** Subscribe to outbound drain: called after each pump pass that sent bytes. Returns the unsubscribe. */
	onDrain(listener: () => void): () => void {
		this.#drainListeners.add(listener);
		return () => {
			this.#drainListeners.delete(listener);
		};
	}

	status(): FleetCallbackStatus {
		const pair = this.#pair;
		const lastError = this.#lastError;
		return {
			state: this.#state,
			workspaceId: this.#workspaceId,
			generation: this.#generation,
			connectionId: pair !== null && pair.open ? pair.connectionId : null,
			seq: pair?.seq ?? 0,
			sent: this.#sent,
			received: this.#received,
			drops: this.#drops,
			rejected: this.#rejected,
			badMessages: this.#badMessages,
			reconnects: this.#reconnects,
			readyCount: this.#readyCount,
			pendingEnvelopes: this.#pending.length - this.#pendingHead,
			pendingBytes: this.#pendingBytes,
			reconnectAt: this.#reconnectAt,
			lastError: lastError ? { ...lastError } : null,
			startedAt: this.#startedAt,
			readyAt: this.#readyAt,
		};
	}

	// ── supervisor ────────────────────────────────────────────────────────────

	async #supervise(): Promise<void> {
		try {
			while (this.#started && !this.#stopped) {
				const pair = await this.#establishPair();
				if (pair === null) {
					if (this.#stopped) break;
					const stopped = await this.#scheduleBackoff();
					if (stopped) break;
					continue;
				}
				if (!(await this.#servePair(pair))) break;
			}
		} catch (cause) {
			if (!this.#stopped) {
				this.#reportError(
					"pair",
					cause instanceof CallbackError
						? cause
						: callbackError("retryable", "callback pair supervisor failed", { cause }),
				);
			}
		} finally {
			if (this.#startDeferred !== null) {
				const pending = this.#startDeferred;
				this.#startDeferred = null;
				pending.reject(new Error("FleetCallback supervisor exited before the pair became ready"));
			}
		}
	}

	/**
	 * Serve a ready pair until it ends. Returns false when the supervisor must
	 * exit (stopped, or the shutdown drain closed the pair), true to redial
	 * after the backoff the failure owes.
	 */
	async #servePair(pair: PairHandle): Promise<boolean> {
		// Readiness itself was applied synchronously by #markReady.
		const end = await pair.end.promise;
		this.#teardownPair(pair);
		if (end.kind === "stopped" || end.kind === "drained" || this.#stopped || this.#draining) {
			return false;
		}
		// Only a pair that stayed up a full heartbeat interval proves the fleet is
		// healthy; one that ends sooner keeps growing the backoff.
		if (this.#readyAt !== null && Date.now() - this.#readyAt > this.#heartbeatMs) {
			this.#backoffAttempt = 0;
		}
		this.#reconnects++;
		if (end.error) this.#reportError("pair", end.error);
		return !(await this.#scheduleBackoff());
	}

	/**
	 * Dial one fresh socket and wait for the in-band pair_ready envelope.
	 * Returns the ready pair, or null when establishment failed (the failure was
	 * reported; the caller backs off and retries). The pair-ready deadline
	 * covers the whole dial: a hung connect and a missing pair_ready both end it.
	 */
	async #establishPair(): Promise<PairHandle | null> {
		if (this.#state !== "ready") {
			this.#state = "connecting";
			this.#emitStatus();
		}
		const connectionId = randomUUID();
		let socket: Bun.WebSocket;
		try {
			socket = new BunWebSocket(this.#wsUrl, {
				headers: this.#upgradeHeaders(connectionId),
				perMessageDeflate: false,
				...(this.#proxy !== undefined ? { proxy: this.#proxy } : {}),
			});
		} catch (cause) {
			this.#reportError(
				"pair",
				callbackError("retryable", "callback socket dial failed", {
					detail: errMsg(cause),
					cause,
				}),
			);
			return null;
		}
		const pair: PairHandle = {
			connectionId,
			socket,
			seq: this.#seqHigh,
			sentBytes: 0,
			grantedBytes: 0,
			open: true,
			chunks: new Map(),
			socketError: undefined,
			heartbeatTimer: null,
			silenceTimer: null,
			stallTimer: null,
			sendTimer: null,
			end: deferred<PairEnd>(),
			closed: deferred<void>(),
			readyWaiter: deferred<void>(),
			readyArrived: false,
		};
		this.#pair = pair;
		socket.addEventListener("open", () => {
			if (this.#isCurrent(pair)) this.#armSilence(pair);
		});
		// Bun's typings resolve its message event to the constructor value; narrow `data` at runtime instead.
		socket.addEventListener("message", (event: Event) =>
			this.#onMessage(pair, "data" in event ? event.data : undefined),
		);
		socket.addEventListener("error", (event) => {
			const detail = "message" in event && typeof event.message === "string" ? event.message : "";
			pair.socketError = detail === "" ? "socket error" : detail;
		});
		socket.addEventListener("close", (event) => this.#onClose(pair, event));
		const readyTimer = setTimeout(() => {
			if (this.#isCurrent(pair)) {
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError("retryable", "callback pair not ready", {
						detail: `no pair_ready within ${this.#readyTimeoutMs}ms`,
					}),
				});
			}
		}, this.#readyTimeoutMs);
		const outcome = await Promise.race([
			pair.readyWaiter.promise.then(() => "ready" as const),
			pair.end.promise.then(() => "end" as const),
		]);
		clearTimeout(readyTimer);
		if (outcome === "ready" && this.#isCurrent(pair)) return pair; // ready; end is consumed by #servePair
		const end = await pair.end.promise;
		if (end.error) this.#reportError("pair", end.error);
		this.#teardownPair(pair);
		return null;
	}

	// ── dialing ───────────────────────────────────────────────────────────────

	#identityHeaders(pair: { connectionId: string }): Record<string, string> {
		const headers: Record<string, string> = {
			[CALLBACK_IDENTITY_HEADERS.workspaceId]: this.#workspaceId,
			[CALLBACK_IDENTITY_HEADERS.generation]: String(this.#generation),
			[CALLBACK_IDENTITY_HEADERS.connectionId]: pair.connectionId,
		};
		if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
		return headers;
	}

	#upgradeHeaders(connectionId: string): Record<string, string> {
		return {
			...this.#identityHeaders({ connectionId }),
			[CALLBACK_PROTO_HEADER]: String(OMP_CALLBACK_PROTO),
		};
	}

	/** Init for a bulk fetch: the abort signal plus the explicit proxy. */
	#fetchInit(signal: AbortSignal, extra: Record<string, unknown>): RequestInit {
		const init: RequestInit = { ...extra, signal };
		if (this.#proxy !== undefined) (init as RequestInit & { proxy?: string }).proxy = this.#proxy;
		return init;
	}

	// ── outbound pump ─────────────────────────────────────────────────────────

	#pumping = false;
	/** Subscribers to outbound drain (see onDrain). */
	readonly #drainListeners = new Set<() => void>();

	#pump(): void {
		const pair = this.#pair;
		// Hold the backlog until the fleet confirms this pair with pair_ready.
		// Envelopes written to a pair that never becomes ready would be consumed
		// from the queue and lost with the closed socket.
		if (pair === null || !pair.open || !pair.readyArrived) return;
		// Reentrancy guard: an onEmittedSeq listener may send, which pumps again
		// while this loop is mid-flight. Without the guard both invocations emit
		// the same pending head (double-send + a corrupted byte ledger).
		if (this.#pumping) return;
		this.#pumping = true;
		const socket = pair.socket;
		let progressed = false;
		let blocked = false;
		try {
			while (this.#pendingHead < this.#pending.length) {
				// A closing socket ends the pair through its close event; the item
				// stays queued for the next pair.
				if (socket.readyState !== WebSocket.OPEN) break;
				// Never hand the socket more while it holds a high-water backlog: the
				// envelope waits in the bounded queue instead of growing the socket buffer.
				if (socket.bufferedAmount > CALLBACK_WS_SEND_HIGH_WATER_BYTES) {
					blocked = true;
					break;
				}
				const item = this.#pending[this.#pendingHead]!;
				// The wire size is exact before anything is committed: framing (a few
				// hundred bytes) plus the payload length known since enqueue.
				const seq = this.#seqHigh + 1;
				const { head, tail } = envelopeFraming({
					version: OMP_CALLBACK_PROTO,
					workspaceId: this.#workspaceId,
					generation: this.#generation,
					connectionId: pair.connectionId,
					streamId: item.streamId,
					seq,
					kind: item.kind,
					at: Date.now(),
				});
				const wireBytes =
					Buffer.byteLength(head, "utf8") + item.payloadBytes + Buffer.byteLength(tail, "utf8");
				// Out of credit: wait for the fleet's next grant (it calls #pump). No
				// timer, and no seq is consumed.
				if (pair.sentBytes - pair.grantedBytes + wireBytes > PAIR_CREDIT_WINDOW_BYTES) break;
				this.#seqHigh = seq;
				pair.seq = seq;
				try {
					socket.send(head + item.payloadJson + tail);
				} catch (cause) {
					this.#finishPair(pair, {
						kind: "failure",
						error: callbackError("retryable", "callback socket send failed", {
							detail: errMsg(cause),
							cause,
						}),
					});
					break;
				}
				pair.sentBytes += wireBytes;
				// Release the consumed slot: its payload JSON would otherwise live until the
				// deque compacts (1024 consumed items), megabytes per large history frame.
				this.#pending[this.#pendingHead++] = undefined;
				this.#pendingBytes -= item.bytes;
				const left = (this.#streamBytes.get(item.streamId) ?? 0) - item.bytes;
				if (left > 0) this.#streamBytes.set(item.streamId, left);
				else this.#streamBytes.delete(item.streamId);
				this.#sent++;
				progressed = true;
				// The wire seq is now exact; surface it to ring keepers.
				if (item.onEmittedSeq !== undefined) {
					try {
						item.onEmittedSeq(pair.seq);
					} catch {
						// Listener failures never break the transport.
					}
				}
			}
		} finally {
			this.#pumping = false;
		}
		// Snapshot: a listener that re-registers must wait for the next drain, not run again now.
		if (progressed) for (const listener of Array.from(this.#drainListeners)) listener();
		// Compact the deque occasionally so shift-by-index never degrades.
		if (this.#pendingHead > 1024 && this.#pendingHead * 2 > this.#pending.length) {
			this.#pending = this.#pending.slice(this.#pendingHead);
			this.#pendingHead = 0;
		}
		// The client socket has no drain event: poll the buffer until it clears.
		if (blocked && pair.sendTimer === null && pair.open) {
			pair.sendTimer = setTimeout(() => {
				pair.sendTimer = null;
				this.#pump();
			}, SEND_RECHECK_MS);
		}
		// A backlog that never drains while the pair is live means the fleet
		// stopped reading: after a silence window with NO progress the pair is
		// replaced. Progress (the socket took at least one envelope) rolls
		// the window so a slow-but-live reader is not replaced; while
		// connecting/reconnecting a backlog is expected (it replays on the
		// fresh pair), so no stall fires then.
		if (this.#state !== "ready") return;
		if (this.#pendingBytes === 0) {
			this.#clearStall(pair);
		} else if (progressed) {
			this.#clearStall(pair);
			this.#armStall(pair);
		} else {
			this.#armStall(pair);
		}
	}

	#enqueue(
		item: Omit<PendingItem, "bytes" | "payloadJson" | "payloadBytes"> & { payload: unknown },
	): CallbackSendResult {
		const pair = this.#pair;
		// While no pair is live (initial dial / mid-reconnect) the send is held
		// for the fresh pair. UUIDs are fixed-width (36 chars), so validating
		// and sizing against a placeholder connection id is byte-exact for the
		// real emit, and lets the queue accept work during reconnects.
		const placeholderConnectionId = pair?.connectionId ?? "00000000-0000-4000-8000-000000000000";
		const candidate: CallbackEnvelope = {
			version: OMP_CALLBACK_PROTO,
			workspaceId: this.#workspaceId,
			generation: this.#generation,
			connectionId: placeholderConnectionId,
			streamId: item.streamId,
			seq: (pair?.seq ?? 0) + 1,
			kind: item.kind,
			payload: item.payload,
			at: Date.now(),
		};
		let encoded: PreEncodedPayload;
		let bytes: number;
		try {
			// The payload is serialized at most once (never when the sender shares a
			// PreEncodedPayload), and the envelope's canonical size is the framing
			// around it plus the payload bytes: no whole-envelope stringify.
			encoded =
				item.payload instanceof PreEncodedPayload ? item.payload : preEncodePayload(item.payload);
			const { head, tail } = envelopeFraming(candidate);
			bytes = Buffer.byteLength(head, "utf8") + encoded.bytes + Buffer.byteLength(tail, "utf8");
			validateEnvelope(candidate, { maxBytes: this.#maxEnvelopeBytes, bytes });
		} catch (cause) {
			if (item.internal) return "rejected"; // transport keepalive cannot be invalid
			const err =
				cause instanceof CallbackError
					? cause
					: callbackError("invalid_request", "invalid callback envelope", { cause });
			this.#rejected++;
			this.#reportError("send", err, { streamId: item.streamId, kind: item.kind });
			return "rejected";
		}
		const streamBytes = this.#streamBytes.get(item.streamId) ?? 0;
		const connFull = this.#pendingBytes + bytes > this.#connectionBufferBytes;
		const streamFull = streamBytes + bytes > this.#streamBufferBytes;
		if (connFull || streamFull) {
			if (!item.internal) {
				this.#drops++;
				this.#reportError(
					"send",
					callbackError("retryable", "callback send dropped: outbound buffer full", {
						detail: connFull ? "connection_buffer_full" : "stream_buffer_full",
					}),
					{ streamId: item.streamId, kind: item.kind },
				);
			}
			return "dropped";
		}
		this.#pending.push({
			streamId: item.streamId,
			kind: item.kind,
			payloadJson: encoded.json,
			payloadBytes: encoded.bytes,
			bytes,
			internal: item.internal,
			...(item.onEmittedSeq !== undefined ? { onEmittedSeq: item.onEmittedSeq } : {}),
		});
		this.#pendingBytes += bytes;
		this.#streamBytes.set(item.streamId, streamBytes + bytes);
		this.#pump();
		return "sent";
	}

	// ── inbound ───────────────────────────────────────────────────────────────

	/** One message from the fleet: validate, then liveness, chunk reassembly, readiness, routing. */
	#onMessage(pair: PairHandle, data: unknown): void {
		if (!this.#isCurrent(pair)) return;
		let envelope: CallbackEnvelope;
		try {
			if (typeof data !== "string") {
				throw callbackError("invalid_request", "callback binary message dropped", {
					detail: "pair messages are text envelopes",
				});
			}
			envelope = decodeEnvelope(data, Buffer.byteLength(data, "utf8"));
		} catch (cause) {
			this.#badMessages++;
			this.#events?.onError?.(
				cause instanceof CallbackError
					? cause
					: callbackError("invalid_request", "invalid callback message", { cause }),
				{ phase: "receive" },
			);
			return;
		}
		this.#resetSilence(pair);
		if (envelope.connectionId !== pair.connectionId) {
			this.#finishPair(pair, {
				kind: "failure",
				error: callbackError("conflict", "callback envelope has a foreign connectionId", {
					detail: `message ${envelope.connectionId}, expected ${pair.connectionId}`,
				}),
			});
			return;
		}
		if (envelope.kind === "control" && isChunkPayload(envelope.payload)) {
			const command = this.#reassemble(pair.chunks, envelope, envelope.payload);
			if (command !== undefined) this.#deliver(pair, command);
			return;
		}
		this.#deliver(pair, envelope);
	}

	/** The socket closed: a refusal close is typed, anything else is a retryable loss (an orderly drain close is no loss). */
	#onClose(pair: PairHandle, event: CloseEvent): void {
		pair.closed.resolve();
		if (!this.#isCurrent(pair)) return;
		if (this.#draining) {
			this.#finishPair(pair, { kind: "drained" });
			return;
		}
		const refusal = callbackErrorFromClose(event.code, event.reason);
		this.#finishPair(pair, {
			kind: "failure",
			error:
				refusal ??
				callbackError("retryable", "callback socket closed", {
					detail: [`close ${event.code}`, event.reason, pair.socketError]
						.filter((part) => part !== undefined && part !== "")
						.join(": "),
				}),
		});
	}

	/** Hand one validated envelope to the session: readiness, liveness, control, raw frames. */
	#deliver(pair: PairHandle, envelope: CallbackEnvelope): void {
		if (envelope.kind === "control" && isPairReadyEnvelope(envelope)) {
			this.#markReady(pair);
			return; // transport control, not user traffic
		}
		if (
			envelope.kind === "control" &&
			envelope.streamId === CALLBACK_TRANSPORT_STREAM_ID &&
			isPairCreditControl(envelope.payload)
		) {
			this.#grant(pair, envelope.payload.consumed);
			return; // transport control, not user traffic
		}
		if (envelope.kind === "heartbeat") return; // liveness only
		this.#received++;
		if (envelope.kind === "control") {
			const onControl = this.#events?.onControl;
			if (onControl) {
				try {
					onControl(envelope);
				} catch {
					// Listener failures never break the transport.
				}
			}
			return; // control traffic does not hit the raw frame path
		}
		const onEnvelope = this.#events?.onEnvelope;
		if (onEnvelope) {
			try {
				onEnvelope(envelope);
			} catch {
				// Listener failures never break the transport.
			}
		}
	}

	/**
	 * The fleet consumed `consumed` bytes of this pair's uploads (cumulative).
	 * A stale value changes nothing; one above what was sent is clamped (the
	 * fleet cannot have consumed more than arrived). New credit wakes the pump.
	 */
	#grant(pair: PairHandle, consumed: number): void {
		const granted = Math.min(consumed, pair.sentBytes);
		if (granted <= pair.grantedBytes) return;
		pair.grantedBytes = granted;
		this.#pump();
	}

	/**
	 * Collect one slice of a chunked command. Returns the rebuilt command once
	 * every slice of its chunkId has arrived. A group that fails to reassemble
	 * is reported and dropped; the pair stays up.
	 */
	#reassemble(
		pending: Map<string, CallbackEnvelope[]>,
		slice: CallbackEnvelope,
		chunk: ChunkEnvelopePayload,
	): CallbackEnvelope | undefined {
		const group = [...(pending.get(chunk.chunkId) ?? []), slice];
		if (group.length < chunk.total) {
			pending.set(chunk.chunkId, group);
			return undefined;
		}
		pending.delete(chunk.chunkId);
		try {
			const payload = reassembleChunks(group, { streamMaxBytes: MAX_COMMAND_BYTES });
			return { ...group[0], kind: "command", payload };
		} catch (cause) {
			this.#events?.onError?.(
				cause instanceof CallbackError
					? cause
					: callbackError("invalid_request", "chunked command failed to reassemble", { cause }),
				{ phase: "receive" },
			);
			return undefined;
		}
	}

	/**
	 * The fleet's pair_ready arrived: the pair becomes the live ready pair in
	 * this very message. A command the fleet wrote right behind pair_ready may
	 * already sit in the same socket read, so readiness (state, pairLive, the
	 * backlog) cannot wait for the supervisor's promise continuations.
	 */
	#markReady(pair: PairHandle): void {
		if (pair.readyArrived) return;
		pair.readyArrived = true;
		this.#state = "ready";
		this.#readyAt = Date.now();
		this.#readyCount++;
		this.#armHeartbeat(pair);
		pair.readyWaiter.resolve();
		if (!this.#everReady) {
			this.#everReady = true;
			const start = this.#startDeferred;
			this.#startDeferred = null;
			start?.resolve();
		}
		// The backlog held for this pair (see #pump) starts flowing now; a backlog
		// left over starts its drain clock there: if the fleet never reads, the
		// stall fires after the silence window and the pair is replaced.
		this.#pump();
		this.#emitStatus();
	}

	// ── timers ────────────────────────────────────────────────────────────────

	#armHeartbeat(pair: PairHandle): void {
		if (pair.heartbeatTimer !== null) return;
		pair.heartbeatTimer = setInterval(() => {
			if (!this.#isCurrent(pair) || this.#pendingBytes > 0) return; // busy; skip keepalive
			this.#enqueue({
				streamId: CALLBACK_CONTROL_STREAM_ID,
				kind: "heartbeat",
				payload: {},
				internal: true,
			});
		}, this.#heartbeatMs);
	}

	#armSilence(pair: PairHandle): void {
		this.#clearSilence(pair);
		pair.silenceTimer = setTimeout(() => {
			pair.silenceTimer = null;
			if (!this.#isCurrent(pair)) return;
			this.#finishPair(pair, {
				kind: "failure",
				error: callbackError("retryable", "callback socket silent", {
					detail: `no envelope for ${this.#silenceMs}ms`,
				}),
			});
		}, this.#silenceMs);
	}

	#resetSilence(pair: PairHandle): void {
		if (pair.silenceTimer === null) return;
		clearTimeout(pair.silenceTimer);
		pair.silenceTimer = null;
		this.#armSilence(pair);
	}

	#armStall(pair: PairHandle): void {
		if (pair.stallTimer !== null) return;
		pair.stallTimer = setTimeout(() => {
			pair.stallTimer = null;
			if (!this.#isCurrent(pair)) return;
			this.#finishPair(pair, {
				kind: "failure",
				error: callbackError("retryable", "callback send stalled", {
					detail: `outbound backlog did not drain within ${this.#silenceMs}ms`,
				}),
			});
		}, this.#silenceMs);
	}

	#clearStall(pair: PairHandle): void {
		if (pair.stallTimer === null) return;
		clearTimeout(pair.stallTimer);
		pair.stallTimer = null;
	}

	#clearSilence(pair: PairHandle): void {
		if (pair.silenceTimer === null) return;
		clearTimeout(pair.silenceTimer);
		pair.silenceTimer = null;
	}

	#clearPairTimers(pair: PairHandle): void {
		if (pair.heartbeatTimer !== null) {
			clearInterval(pair.heartbeatTimer);
			pair.heartbeatTimer = null;
		}
		if (pair.sendTimer !== null) {
			clearTimeout(pair.sendTimer);
			pair.sendTimer = null;
		}
		this.#clearSilence(pair);
		this.#clearStall(pair);
	}

	// ── pair teardown / finish ────────────────────────────────────────────────

	#isCurrent(pair: PairHandle): boolean {
		return pair.open && !this.#stopped && this.#pair === pair;
	}

	#finishPair(pair: PairHandle, end: PairEnd): void {
		if (!pair.open || this.#pair !== pair || pair.end.settled) return;
		pair.end.resolve(end);
	}

	#teardownPair(pair: PairHandle): void {
		if (!pair.open) return;
		pair.open = false;
		if (this.#pair === pair) this.#pair = null;
		this.#clearPairTimers(pair);
		// Idempotent: end may already be settled (finishPair ran first).
		pair.end.resolve({ kind: "stopped" });
		try {
			pair.socket.terminate();
		} catch {
			// Already closed.
		}
	}

	#scheduleBackoff(): Promise<boolean> {
		if (this.#stopped) return Promise.resolve(true);
		const attempt = this.#backoffAttempt++;
		const delay = backoffDelay(attempt, this.#backoffMinMs, this.#backoffMaxMs);
		this.#state = "reconnecting";
		this.#reconnectAt = Date.now() + delay;
		this.#emitStatus();
		return new Promise<boolean>((resolve) => {
			this.#backoffResolve = resolve;
			this.#backoffTimer = setTimeout(() => {
				this.#backoffTimer = null;
				this.#backoffResolve = null;
				this.#reconnectAt = null;
				resolve(this.#stopped);
			}, delay);
		});
	}

	#cancelBackoff(): void {
		if (this.#backoffTimer !== null) {
			clearTimeout(this.#backoffTimer);
			this.#backoffTimer = null;
		}
		if (this.#backoffResolve !== null) {
			const resolve = this.#backoffResolve;
			this.#backoffResolve = null;
			resolve(true);
		}
		this.#reconnectAt = null;
	}

	// ── status / errors ───────────────────────────────────────────────────────

	#reportError(
		phase: FleetCallbackErrorContext["phase"],
		error: CallbackError,
		item?: { streamId?: string; kind?: CallbackKind },
	): void {
		this.#lastError = { code: error.code, message: error.message, at: Date.now() };
		const onError = this.#events?.onError;
		if (onError) {
			try {
				onError(error, { phase, streamId: item?.streamId, kind: item?.kind });
			} catch {
				// Listener failures never break the transport.
			}
		}
		if (TERMINAL_REFUSALS[error.code] === true) this.#refuse(error);
	}

	/** Terminal fleet refusal (credential rejected or superseded, protocol unsupported): stop for good, no re-dial. */
	#refuse(error: CallbackError): void {
		if (this.#stopped) return;
		this.stop();
		const onRejected = this.#events?.onRejected;
		if (onRejected) {
			try {
				onRejected(error);
			} catch {
				// Listener failures never break the transport.
			}
		}
	}

	#emitStatus(): void {
		const onStatus = this.#events?.onStatus;
		if (onStatus) {
			try {
				onStatus(this.status());
			} catch {
				// Listener failures never break the transport.
			}
		}
	}
}

function isPairReadyEnvelope(envelope: CallbackEnvelope): boolean {
	if (envelope.kind !== "control") return false;
	if (typeof envelope.payload !== "object" || envelope.payload === null) return false;
	const payload = envelope.payload as Record<string, unknown>;
	return payload.type === CALLBACK_PAIR_READY_TYPE;
}
