import { randomUUID } from "node:crypto";
import {
	BULK_FINAL_HEADER,
	BULK_MAX_BYTES,
	BULK_PART_HEADER,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_DOWN_PATH,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	CONNECTION_MAX_BYTES,
	ENVELOPE_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	OMP_CALLBACK_PROTO,
	PAIR_READY_TIMEOUT_MS,
	PAIR_RENEWAL_MS,
	RECONNECT_BACKOFF_MAX_MS,
	RECONNECT_BACKOFF_MIN_MS,
	SILENCE_DEADLINE_MS,
	STREAM_MAX_BYTES,
	CallbackError,
	callbackError,
	encodeNdjsonLine,
	parseSseEnvelope,
	validateEnvelope,
	type CallbackEnvelope,
	type CallbackErrorCode,
	type CallbackKind,
} from "../shared/callback-protocol";
import {
	parseMaterializeRecord,
	type MaterializeRecord,
	type MaterializeRequest,
} from "../shared/wake-materialize";
import { isLoopbackHost } from "./config";

/**
 * Callback transport, daemon half (P3.2; docs/clone-contracts.md "Callback
 * transport"). The daemon dials OUT to the fleet and keeps one long-lived
 * pair of connections per workspace+generation:
 *
 *   up:   POST /callback/up    NDJSON streaming writer (incremental enqueue)
 *   down: GET  /callback/down  SSE reader (parseSseEnvelope)
 *
 * Identity and the enrollment credential ride request HEADERS (frozen by
 * Main): x-omp-workspace-id, x-omp-generation, x-omp-connection-id, plus
 * `authorization: Bearer <credential>`. Never query params or path segments;
 * the connection id stays out of URL logs. A fresh `connectionId`
 * (crypto.randomUUID()) is minted per pair and both halves of one pair share
 * it.
 *
 * Up establishment (Bun.serve constraint, agreed with the fleet half): the
 * fleet reads the /callback/up body to COMPLETION inside its handler, so the
 * up HTTP response arrives only when the upload ENDS, never while the pair
 * lives. The daemon therefore treats the up half as established when the POST
 * is launched and still pending; any settled up response (or a rejected
 * upload) means the up half ended and the pair is replaced. Pair readiness is
 * confirmed IN-BAND: once both halves for a connectionId are live the fleet
 * emits a `control` envelope on the down stream with
 * payload {type:"pair_ready", connectionId, generation} and
 * streamId "transport". start() resolves on that (PAIR_READY_TIMEOUT_MS).
 *
 * Pair lifecycle:
 *   - start() resolves only when the pair is READY (up launched + down open +
 *     pair_ready observed), within the pair-ready timeout.
 *   - Either half failing, down stream ended/errored, up response settled,
 *     up body cancelled by the peer, 30 s down silence, or an outbound
 *     backlog that never drained within the silence deadline, replaces
 *     BOTH halves after jittered 1 s → 30 s backoff (the connector's
 *     backoffDelay pattern).
 *   - The fleet emits 15 s `heartbeat` envelopes (streamId "transport") that
 *     keep the 30 s down silence deadline alive; the daemon mirrors 15 s
 *     heartbeats up (streamId "control") while idle.
 *   - Every 5 min the pair is voluntarily renewed (fresh connectionId); down
 *     envelopes are never resumed across a replacement because a fresh
 *     connectionId starts a fresh per-connection seq space.
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
 * unless `allowHttp` is set AND the host is loopback. An explicit
 * `proxy` (http/https) is passed to every fetch; there is no silent
 * fallback to a direct connection, and an unsupported scheme is a
 * construction-time error.
 */

/** Header names binding a callback pair (frozen by Main). */
export const CALLBACK_IDENTITY_HEADERS = {
	workspaceId: "x-omp-workspace-id",
	generation: "x-omp-generation",
	connectionId: "x-omp-connection-id",
} as const;

// The control-plane wire literals (transport streamId, daemon heartbeat
// streamId, pair_ready payload type) live in shared/callback-protocol.ts;
// re-export so the FleetCallback public surface for Main's wiring is stable.
export { CALLBACK_TRANSPORT_STREAM_ID, CALLBACK_CONTROL_STREAM_ID, CALLBACK_PAIR_READY_TYPE };

export type FleetCallbackState = "idle" | "connecting" | "ready" | "reconnecting" | "stopped";

/** Outbound envelope the daemon hands the pair; identity/seq/at are stamped at emit. */
export interface CallbackSendInput {
	/** Logical per-browser/control stream within the connection. */
	streamId: string;
	kind: CallbackKind;
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
	/** Enrollment credential; sent as `authorization: Bearer <token>` on both halves. */
	token?: string;
	/** Explicit http(s) streaming proxy; absent = direct. Never silently bypassed. */
	proxy?: string;
	/** Explicit loopback-HTTP exception; honored only for loopback callback hosts. */
	allowHttp?: boolean;
	// Timing / limits: production defaults are the ledger constants; tests
	// shrink them to observe cadence deterministically.
	heartbeatMs?: number;
	silenceMs?: number;
	/** Pair renewal interval; 0 disables voluntary renewal. */
	renewalMs?: number;
	readyTimeoutMs?: number;
	backoffMinMs?: number;
	backoffMaxMs?: number;
	connectionBufferBytes?: number;
	streamBufferBytes?: number;
	maxEnvelopeBytes?: number;
}

export interface FleetCallbackErrorContext {
	phase: "send" | "up" | "down" | "pair";
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
	 * stream): stream_open/stream_close on `browser/<connId>` streams,
	 * log_ack/log_gap/quiesce_begin on the transport stream. Distinct from
	 * onEnvelope so the transport's own control traffic is routed without
	 * touching the raw frame forwarding path.
	 */
	onControl?: (envelope: CallbackEnvelope) => void;
}

export interface FleetCallbackStatus {
	state: FleetCallbackState;
	workspaceId: string;
	generation: number;
	/** Live pair connection id; null while idle/stopped. */
	connectionId: string | null;
	/** Up seq of the current pair (last assigned). */
	seq: number;
	/** Envelopes actually written to the wire. */
	sent: number;
	/** Non-heartbeat envelopes read from the down stream. */
	received: number;
	/** Envelopes dropped because the outbound buffer was full. */
	drops: number;
	/** Envelopes rejected before queueing (oversize / not JSON-serializable / bad shape). */
	rejected: number;
	/** Failure-driven pair replacements. */
	reconnects: number;
	/** Voluntary pair renewals. */
	renewals: number;
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

/** True when `value` names a frozen callback error code. */
function isCallbackErrorCode(value: string): value is CallbackErrorCode {
	switch (value) {
		case "invalid_request":
		case "invalid_identity":
		case "unauthorized":
		case "forbidden":
		case "unavailable":
		case "conflict":
		case "generation_obsolete":
		case "writer_active":
		case "archive_pending":
		case "archive_conflict":
		case "provider_failed":
		case "retryable":
			return true;
		default:
			return false;
	}
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

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50% (fleet/connector pattern). */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
}

interface PendingItem {
	streamId: string;
	kind: CallbackKind;
	payload: unknown;
	/** Projected wire bytes (canonical JSON with the current identity), for buffer accounting. */
	bytes: number;
	/** Transport-internal (heartbeat): dropped silently, never counted or reported. */
	internal: boolean;
	/** Called with the final wire seq the moment this envelope is actually written. */
	onEmittedSeq?: (seq: number) => void;
}

interface PairEnd {
	kind: "failure" | "renewal" | "stopped";
	error?: CallbackError;
}

interface PairHandle {
	connectionId: string;
	/** Last assigned up envelope seq (per-connection monotonic). */
	seq: number;
	/** False once torn down / superseded / stopped. */
	open: boolean;
	upAbort: AbortController;
	downAbort: AbortController;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	silenceTimer: ReturnType<typeof setTimeout> | null;
	stallTimer: ReturnType<typeof setTimeout> | null;
	renewalTimer: ReturnType<typeof setTimeout> | null;
	/** Resolved exactly once, by finishPair (failure/renewal) or teardown (stopped). */
	end: Deferred<PairEnd>;
	/** Resolved when the fleet's pair_ready envelope arrives for this pair. */
	readyWaiter: Deferred<void>;
	readyArrived: boolean;
}

const HTTP_ERROR_CODE: Record<number, CallbackErrorCode> = {
	400: "invalid_request",
	401: "unauthorized",
	403: "forbidden",
	404: "invalid_identity",
	409: "conflict",
	410: "generation_obsolete",
	429: "retryable",
	503: "unavailable",
};

function errMsg(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export class FleetCallback {
	readonly #base: string;
	readonly #workspaceId: string;
	readonly #generation: number;
	readonly #token: string | undefined;
	readonly #proxy: string | undefined;
	readonly #heartbeatMs: number;
	readonly #silenceMs: number;
	readonly #renewalMs: number;
	readonly #readyTimeoutMs: number;
	readonly #backoffMinMs: number;
	readonly #backoffMaxMs: number;
	readonly #connectionBufferBytes: number;
	readonly #streamBufferBytes: number;
	readonly #maxEnvelopeBytes: number;
	readonly #events: FleetCallbackEvents | undefined;
	readonly #enc = new TextEncoder();

	#state: FleetCallbackState = "idle";
	#started = false;
	#stopped = false;
	#everReady = false;
	#startDeferred: Deferred<void> | null = null;
	#startedAt: number | null = null;
	#readyAt: number | null = null;

	#pair: PairHandle | null = null;
	#upController: ReadableStreamDefaultController<Uint8Array> | null = null;

	/** Outbound queue; bytes are capped, so this doubles as the 8 MiB/4 MiB hold. */
	#pending: PendingItem[] = [];
	#pendingHead = 0;
	#pendingBytes = 0;
	#streamBytes = new Map<string, number>();

	#sent = 0;
	#received = 0;
	#drops = 0;
	#rejected = 0;
	#reconnects = 0;
	#renewals = 0;
	#readyCount = 0;
	#backoffAttempt = 0;
	#backoffTimer: ReturnType<typeof setTimeout> | null = null;
	#backoffResolve: ((stopped: boolean) => void) | null = null;
	#reconnectAt: number | null = null;
	#lastError: { code: CallbackErrorCode; message: string; at: number } | null = null;

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
		if (options.proxy !== undefined) {
			let proxy: URL;
			try {
				proxy = new URL(options.proxy);
			} catch (cause) {
				throw new Error(`invalid callback proxy "${options.proxy}" (not a URL)`, { cause });
			}
			if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
				throw new Error(
					`unsupported callback proxy scheme "${proxy.protocol}" ("${options.proxy}"); only http/https proxies are supported and there is no direct fallback`,
				);
			}
		}
		this.#base = options.url.replace(/\/+$/, "");
		this.#workspaceId = options.workspaceId;
		this.#generation = options.generation;
		this.#token = options.token;
		this.#proxy = options.proxy;
		this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
		this.#silenceMs = options.silenceMs ?? SILENCE_DEADLINE_MS;
		this.#renewalMs = options.renewalMs ?? PAIR_RENEWAL_MS;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? PAIR_READY_TIMEOUT_MS;
		this.#backoffMinMs = options.backoffMinMs ?? RECONNECT_BACKOFF_MIN_MS;
		this.#backoffMaxMs = options.backoffMaxMs ?? RECONNECT_BACKOFF_MAX_MS;
		this.#connectionBufferBytes = options.connectionBufferBytes ?? CONNECTION_MAX_BYTES;
		this.#streamBufferBytes = options.streamBufferBytes ?? STREAM_MAX_BYTES;
		this.#maxEnvelopeBytes = options.maxEnvelopeBytes ?? ENVELOPE_MAX_BYTES;
		this.#events = events;
	}

	/**
	 * Start the pair. Resolves when the pair is READY (up launched, down open,
	 * pair_ready observed); rejects only if stop() runs first. Safe to call
	 * once; a stopped instance rejects.
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
		void this.#supervise(startDeferred);
		return startDeferred.promise;
	}

	/** Terminal: tears down both halves, cancels timers/backoff; no reconnects after. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
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
	 * Queue one envelope for the up half. Identity (workspaceId/generation/
	 * connectionId), seq, and at are stamped at emit, so envelopes queued
	 * while a pair is down replay on the fresh pair (the fleet keeps no
	 * offline queue). Returns "sent" when accepted into the bounded queue,
	 * "dropped" when a buffer cap is hit (counted + retryable onError),
	 * "rejected" when the envelope is invalid or over the 1 MiB cap
	 * (invalid_request onError), or "stopped" when not started / stopped.
	 */
	send(input: CallbackSendInput): CallbackSendResult {
		if (!this.#started || this.#stopped) return "stopped";
		return this.#enqueue({
			streamId: input.streamId,
			kind: input.kind,
			payload: input.payload,
			internal: false,
			...(input.onEmittedSeq !== undefined ? { onEmittedSeq: input.onEmittedSeq } : {}),
		});
	}

	/**
	 * POST a materialization request over the bulk channel (P8.9 wake): the
	 * daemon mints a fresh correlation id and asks the fleet to serve the
	 * workspace's stored session lineage bytes as NDJSON. Requires a READY
	 * pair (a reconnecting or stopped pair has no live identity headers).
	 * Returns null when the fleet lacks the session, and throws
	 * {@link CallbackError} on transport failures or malformed responses.
	 */
	async requestBulkMaterialize(request: MaterializeRequest): Promise<MaterializeResult | null> {
		const pair = this.#pair;
		if (!this.#started || this.#stopped || pair === null || !pair.open || this.#state !== "ready") {
			throw callbackError("unavailable", "materialization unavailable: no ready callback pair", {
				detail: "the daemon has no live fleet pair to request the stored session from",
			});
		}
		const correlationId = randomUUID();
		const headers: Record<string, string> = {
			...this.#identityHeaders(pair),
			"content-type": "application/json",
		};
		const init: RequestInit = {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		};
		if (this.#proxy !== undefined) (init as RequestInit & { proxy?: string }).proxy = this.#proxy;
		let res: Response;
		try {
			res = await fetch(`${this.#base}${CALLBACK_BULK_PATH_PREFIX}${correlationId}`, init);
		} catch (cause) {
			throw callbackError("retryable", "materialization request failed", { cause });
		}
		const text = await res.text();
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
		// (HTTP 503 via the frozen status map); the daemon reports it typed
		// and the caller decides.
		let errorBody: { error?: unknown; message?: unknown; detail?: unknown } = {};
		try {
			errorBody = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
		} catch {
			// Non-JSON error body: fall through to the HTTP-status mapping.
		}
		const code =
			typeof errorBody.error === "string" && isCallbackErrorCode(errorBody.error)
				? errorBody.error
				: (HTTP_ERROR_CODE[res.status] ?? "retryable");
		const message =
			typeof errorBody.message === "string" && errorBody.message.length > 0
				? errorBody.message
				: `materialization refused: HTTP ${res.status}`;
		throw callbackError(code, message, {
			...(typeof errorBody.detail === "string" ? { detail: errorBody.detail } : {}),
		});
	}

	/**
	 * Upload one file to the fleet as strictly-sequential multi-part raw bytes
	 * over the bulk channel (Transport/Lifecycle 2026-09-06 contract). The
	 * daemon streams each part via `readable` to
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
				detail: "the daemon has no live fleet pair to upload to",
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
			const init: RequestInit = this.#fetchInit(new AbortController(), {
				method: "POST",
				headers,
				// BodyInit under the DOM lib rejects plain Uint8Array; a
				// single-part ReadableStream is accepted and streams the exact
				// bytes (matches the up-half's streamed NDJSON body).
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
				let errorBody: { error?: unknown; message?: unknown; detail?: unknown } = {};
				try {
					errorBody = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
				} catch {
					// Non-JSON error body: fall through to the HTTP-status mapping.
				}
				const code =
					typeof errorBody.error === "string" && isCallbackErrorCode(errorBody.error)
						? errorBody.error
						: (HTTP_ERROR_CODE[res.status] ?? "retryable");
				const message =
					typeof errorBody.message === "string" && errorBody.message.length > 0
						? errorBody.message
						: `bulk upload part ${part} refused: HTTP ${res.status}`;
				throw callbackError(code, message, {
					detail: `part ${part} of ${partCount} for correlation ${input.correlationId}`,
				});
			}
		}
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
			reconnects: this.#reconnects,
			renewals: this.#renewals,
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

	async #supervise(start: Deferred<void>): Promise<void> {
		try {
			while (this.#started && !this.#stopped) {
				const pair = await this.#establishPair();
				if (pair === null) {
					if (this.#stopped) break;
					const stopped = await this.#scheduleBackoff();
					if (stopped) break;
					continue;
				}
				this.#backoffAttempt = 0;
				this.#state = "ready";
				this.#readyAt = Date.now();
				this.#readyCount++;
				if (!this.#everReady) {
					this.#everReady = true;
					if (this.#startDeferred !== null && this.#startDeferred === start) {
						this.#startDeferred = null;
						start.resolve();
					}
				}
				this.#armHeartbeat(pair);
				// A backlog carried into ready must start its drain clock now:
				// if the fleet never pulls, the stall fires after the silence
				// window and the pair is replaced.
				if (this.#pendingBytes > 0) this.#armStall(pair);
				this.#emitStatus();
				const end = await this.#livePair(pair);
				if (end.kind === "stopped" || this.#stopped) break;
				if (end.kind === "renewal") {
					this.#renewals++;
					continue; // voluntary: fresh pair, no backoff
				}
				this.#reconnects++;
				if (end.error) this.#reportError("pair", end.error);
				const stopped = await this.#scheduleBackoff();
				if (stopped) break;
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
	 * Open one fresh pair: launch the up POST (fire-and-forget; the fleet
	 * reads the body to completion, so its response only arrives when the up
	 * half ends), open the down GET, then wait for the in-band pair_ready
	 * envelope. Returns the ready pair, or null when establishment failed
	 * (the failure was reported; the caller backs off and retries).
	 */
	async #establishPair(): Promise<PairHandle | null> {
		this.#state = "connecting";
		this.#emitStatus();
		const pair = this.#newPair();
		this.#pair = pair;
		// Any end while we are still establishing (up settled early, stop(),
		// teardown) must abort the down dial and the ready wait.
		const endValue: { end: PairEnd | null } = { end: null };
		pair.end.promise.then((end) => {
			endValue.end = end;
		});
		this.#launchUp(pair);
		const deadline = Date.now() + this.#readyTimeoutMs;
		const downOk = await this.#dialDown(pair, deadline);
		if (!downOk) {
			this.#teardownPair(pair);
			return null;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			this.#reportError(
				"pair",
				callbackError("retryable", "callback pair not ready", {
					detail: `no pair_ready within ${this.#readyTimeoutMs}ms`,
				}),
			);
			this.#teardownPair(pair);
			return null;
		}
		const readyTimer = setTimeout(() => {
			if (this.#isCurrent(pair)) {
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError("retryable", "callback pair not ready", {
						detail: `no pair_ready within ${this.#readyTimeoutMs}ms`,
					}),
				});
			}
		}, remaining);
		const readyWaiter = pair.readyWaiter;
		const outcome = await Promise.race([
			readyWaiter.promise.then(() => "ready" as const),
			pair.end.promise.then(() => "end" as const),
		]);
		clearTimeout(readyTimer);
		if (outcome === "ready" && this.#isCurrent(pair)) {
			return pair; // ready; end is consumed by #livePair
		}
		if (endValue.end?.error) this.#reportError("pair", endValue.end.error);
		this.#teardownPair(pair);
		return null;
	}

	#newPair(): PairHandle {
		return {
			connectionId: crypto.randomUUID(),
			seq: 0,
			open: true,
			upAbort: new AbortController(),
			downAbort: new AbortController(),
			heartbeatTimer: null,
			silenceTimer: null,
			stallTimer: null,
			renewalTimer: null,
			end: deferred<PairEnd>(),
			readyWaiter: deferred<void>(),
			readyArrived: false,
		};
	}

	async #livePair(pair: PairHandle): Promise<PairEnd> {
		this.#armRenewal(pair);
		const end = await pair.end.promise;
		this.#teardownPair(pair);
		return end;
	}

	// ── dialing ───────────────────────────────────────────────────────────────

	#identityHeaders(pair: PairHandle): Record<string, string> {
		const headers: Record<string, string> = {
			[CALLBACK_IDENTITY_HEADERS.workspaceId]: this.#workspaceId,
			[CALLBACK_IDENTITY_HEADERS.generation]: String(this.#generation),
			[CALLBACK_IDENTITY_HEADERS.connectionId]: pair.connectionId,
		};
		if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
		return headers;
	}

	/**
	 * Launch the up POST and watch it. The fleet reads the NDJSON body to
	 * completion, so a settled response is the END-of-up signal: any settle
	 * while the pair is current ends the pair (the fleet refused it, stopped
	 * reading, or the connection died).
	 */
	#launchUp(pair: PairHandle): void {
		const init = this.#fetchInit(pair.upAbort, {
			method: "POST",
			headers: this.#identityHeaders(pair),
			body: this.#makeUpBody(pair),
			duplex: "half",
		});
		void fetch(`${this.#base}${CALLBACK_UP_PATH}`, init)
			.then((res) => {
				if (!this.#isCurrent(pair)) {
					res.body?.cancel().catch(() => {});
					return;
				}
				res.body?.cancel().catch(() => {});
				const code = res.ok ? "retryable" : (HTTP_ERROR_CODE[res.status] ?? "retryable");
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError(
						code,
						res.ok
							? "callback up ended (the fleet stopped reading)"
							: `callback up refused: HTTP ${res.status}`,
						{ detail: res.ok ? undefined : `the fleet ended the up half` },
					),
				});
			})
			.catch((cause) => {
				if (!this.#isCurrent(pair)) return; // intentional teardown abort
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError("retryable", "callback up failed", {
						detail: errMsg(cause),
						cause,
					}),
				});
			});
	}

	async #dialDown(pair: PairHandle, deadline: number): Promise<boolean> {
		const headers = this.#identityHeaders(pair);
		headers.Accept = "text/event-stream";
		try {
			const res = await this.#fetchWithDeadline(
				`${this.#base}${CALLBACK_DOWN_PATH}`,
				this.#fetchInit(pair.downAbort, { method: "GET", headers }),
				pair.downAbort,
				deadline,
			);
			if (!this.#isCurrent(pair)) {
				res.body?.cancel().catch(() => {});
				return false;
			}
			if (!res.ok) {
				const bodyText = await res.text().catch(() => "");
				this.#reportError(
					"down",
					callbackError(
						HTTP_ERROR_CODE[res.status] ?? "retryable",
						`callback down refused: HTTP ${res.status}`,
						{ detail: bodyText.length > 0 ? bodyText.slice(0, 300) : undefined },
					),
				);
				res.body?.cancel().catch(() => {});
				return false;
			}
			if (!res.body) {
				this.#reportError("down", callbackError("unavailable", "callback down has no body"));
				return false;
			}
			this.#armSilence(pair);
			void this.#consumeDown(pair, res);
			return true;
		} catch (cause) {
			if (!this.#isCurrent(pair)) return false;
			this.#reportError(
				"down",
				callbackError("retryable", "callback down dial failed", {
					detail: errMsg(cause),
					cause,
				}),
			);
			return false;
		}
	}

	/** fetch with a hard deadline (used for the down dial / pair-ready wait). */
	async #fetchWithDeadline(
		url: string,
		init: RequestInit,
		abort: AbortController,
		deadline: number,
	): Promise<Response> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			abort.abort();
			throw new Error(`dial timed out after ${this.#readyTimeoutMs}ms`);
		}
		let timedOut = false;
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				timedOut = true;
				abort.abort();
			}
		}, remaining);
		try {
			const res = await fetch(url, init);
			done = true;
			clearTimeout(timer);
			return res;
		} catch (cause) {
			done = true;
			clearTimeout(timer);
			if (timedOut) throw new Error(`dial timed out after ${this.#readyTimeoutMs}ms`);
			throw cause;
		}
	}

	#fetchInit(abort: AbortController, extra: Record<string, unknown>): RequestInit {
		const init: RequestInit = { ...extra, signal: abort.signal };
		if (this.#proxy !== undefined) (init as RequestInit & { proxy?: string }).proxy = this.#proxy;
		return init;
	}

	// ── up half: NDJSON writer ────────────────────────────────────────────────

	#makeUpBody(pair: PairHandle): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (this.#isCurrent(pair)) {
					this.#upController = controller;
					this.#pump();
				}
			},
			pull: () => {
				if (this.#isCurrent(pair)) this.#pump();
			},
			cancel: (reason) => {
				// The peer stopped reading / the socket died while we were not
				// the ones tearing down; the up half is gone.
				if (!this.#isCurrent(pair)) return;
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError("retryable", "callback up body cancelled", {
						detail: errMsg(reason),
					}),
				});
			},
		});
	}

	#pumping = false;

	#pump(): void {
		const controller = this.#upController;
		const pair = this.#pair;
		if (controller === null || pair === null || !pair.open) return;
		// Reentrancy guard: controller.enqueue can synchronously trigger the
		// fetch consumer's read, which fires pull() → #pump() while this loop
		// is mid-flight. Without the guard both invocations emit the same
		// pending head (double-send + a corrupted byte ledger).
		if (this.#pumping) return;
		this.#pumping = true;
		let progressed = false;
		try {
			while (this.#pendingHead < this.#pending.length && (controller.desiredSize ?? 0) > 0) {
				const item = this.#pending[this.#pendingHead]!;
				const emitted = this.#emit(pair, item);
				const line = encodeNdjsonLine(emitted);
				controller.enqueue(this.#enc.encode(line));
				this.#pendingHead++;
				this.#pendingBytes -= item.bytes;
				const left = (this.#streamBytes.get(item.streamId) ?? 0) - item.bytes;
				if (left > 0) this.#streamBytes.set(item.streamId, left);
				else this.#streamBytes.delete(item.streamId);
				this.#sent++;
				progressed = true;
				// The wire seq is now exact; surface it to ring keepers.
				if (item.onEmittedSeq !== undefined) {
					try {
						item.onEmittedSeq(emitted.seq);
					} catch {
						// Listener failures never break the transport.
					}
				}
			}
		} finally {
			this.#pumping = false;
		}
		// Compact the deque occasionally so shift-by-index never degrades.
		if (this.#pendingHead > 1024 && this.#pendingHead * 2 > this.#pending.length) {
			this.#pending = this.#pending.slice(this.#pendingHead);
			this.#pendingHead = 0;
		}
		// A backlog that never drains while the pair is live means the fleet
		// stopped reading: after a silence window with NO progress the pair is
		// replaced. Progress (the fleet drained at least one envelope) rolls
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

	#enqueue(item: Omit<PendingItem, "bytes">): CallbackSendResult {
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
		let bytes: number;
		try {
			validateEnvelope(candidate, { maxBytes: this.#maxEnvelopeBytes });
			bytes = this.#enc.encode(JSON.stringify(candidate)).length;
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
		this.#pending.push({ ...item, bytes });
		this.#pendingBytes += bytes;
		this.#streamBytes.set(item.streamId, streamBytes + bytes);
		this.#pump();
		return "sent";
	}

	#emit(pair: PairHandle, item: PendingItem): CallbackEnvelope {
		return {
			version: OMP_CALLBACK_PROTO,
			workspaceId: this.#workspaceId,
			generation: this.#generation,
			connectionId: pair.connectionId,
			streamId: item.streamId,
			seq: ++pair.seq,
			kind: item.kind,
			payload: item.payload,
			at: Date.now(),
		};
	}

	// ── down half: SSE reader ─────────────────────────────────────────────────

	async #consumeDown(pair: PairHandle, res: Response): Promise<void> {
		try {
			for await (const envelope of parseSseEnvelope(res.body!)) {
				if (!this.#isCurrent(pair)) return;
				this.#resetSilence(pair);
				if (envelope.connectionId !== pair.connectionId) {
					this.#finishPair(pair, {
						kind: "failure",
						error: callbackError("conflict", "callback down envelope has a foreign connectionId", {
							detail: `stream ${envelope.connectionId}, expected ${pair.connectionId}`,
						}),
					});
					return;
				}
				if (envelope.kind === "control" && isPairReadyEnvelope(envelope)) {
					this.#markReady(pair, envelope);
					continue; // transport control, not user traffic
				}
				if (envelope.kind === "heartbeat") continue; // liveness only
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
					continue; // control traffic does not hit the raw frame path
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
			if (this.#isCurrent(pair)) {
				this.#finishPair(pair, {
					kind: "failure",
					error: callbackError("retryable", "callback down stream ended", {
						detail: "the fleet closed the down stream",
					}),
				});
			}
		} catch (cause) {
			if (!this.#isCurrent(pair)) return;
			this.#finishPair(pair, {
				kind: "failure",
				error:
					cause instanceof CallbackError
						? cause
						: callbackError("retryable", "callback down stream failed", { cause }),
			});
		}
	}

	#markReady(pair: PairHandle, envelope: CallbackEnvelope): void {
		if (pair.readyArrived) return;
		pair.readyArrived = true;
		pair.readyWaiter.resolve();
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
				error: callbackError("retryable", "callback down stream silent", {
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
				error: callbackError("retryable", "callback up stalled", {
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

	#armRenewal(pair: PairHandle): void {
		if (this.#renewalMs <= 0 || pair.renewalTimer !== null) return;
		pair.renewalTimer = setTimeout(() => {
			pair.renewalTimer = null;
			if (!this.#isCurrent(pair)) return;
			this.#finishPair(pair, { kind: "renewal" });
		}, this.#renewalMs);
	}

	#clearPairTimers(pair: PairHandle): void {
		if (pair.heartbeatTimer !== null) {
			clearInterval(pair.heartbeatTimer);
			pair.heartbeatTimer = null;
		}
		this.#clearSilence(pair);
		this.#clearStall(pair);
		if (pair.renewalTimer !== null) {
			clearTimeout(pair.renewalTimer);
			pair.renewalTimer = null;
		}
	}

	// ── pair teardown / finish ────────────────────────────────────────────────

	#isCurrent(pair: PairHandle): boolean {
		return pair.open && this.#pair === pair && !this.#stopped;
	}

	#finishPair(pair: PairHandle, end: PairEnd): void {
		if (!pair.open || this.#pair !== pair || pair.end.settled) return;
		pair.end.resolve(end);
	}

	#teardownPair(pair: PairHandle): void {
		if (!pair.open) return;
		pair.open = false;
		if (this.#pair === pair) {
			this.#pair = null;
			this.#upController = null;
		}
		this.#clearPairTimers(pair);
		// Idempotent: end may already be settled (finishPair ran first).
		pair.end.resolve({ kind: "stopped" });
		try {
			pair.upAbort.abort();
		} catch {
			// Ignore; already aborted.
		}
		try {
			pair.downAbort.abort();
		} catch {
			// Ignore; already aborted.
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
		phase: "send" | "up" | "down" | "pair",
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
