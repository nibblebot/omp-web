/**
 * DaemonConnector: the fleet's per-daemon SSE client.
 *
 * Dials the daemon's registered endpoint over HTTP (R14 — the bearer token
 * rides the Authorization header, so there is no hello handshake) and drives
 * the status machine off the /events stream:
 *
 *   connect → "connecting" → (hello_ok event) "session" → (first state frame)
 *   "resolving" → (ready frame) "ready"
 *
 * Every ServerFrame arrives as an SSE `frame` event with a monotonic id;
 * the keepalive ping event — and any other unit, including comments — resets
 * the silence deadline. A stream
 * that ends cleanly after a validated hello → "asleep" (cwd +
 * lastSessionFile kept) — the daemon went dormant. A stream that ends in
 * error, or a dial that never opened, → "reconnecting" with jittered
 * exponential backoff (1s→30s by default) and a fresh dial. A
 * `stream_reset` frame immediately before a clean end marks a daemon-side
 * backpressure drop (the daemon is alive, the stream was too slow): the
 * clean end is then treated as "reconnecting" too — drop-and-resume via
 * Last-Event-ID, never "asleep". A dial that
 * never reached hello_ok additionally fires `onDialFailed` so the server can
 * respawn spawned daemons with a fresh token. A 401 (wrong token) is
 * terminal: status "error", no reconnect loop — only a respawn can refresh
 * the credential.
 *
 * Commands are POST /command (fire-and-forget accept; answers ride /events).
 * On redial the connector resumes from the last event id seen on the
 * previous stream: `Last-Event-ID: <lastSeq>` — the daemon replays ring
 * deltas with seqs strictly greater than it, so a dropped stream never loses
 * frames.
 *
 * Idle policy: the idle-drop timer is armed when a connection reaches
 * "ready" with no retain() subscribers (never-attached dials — supervisor
 * endpoint resolution, /ctl add/provision) and re-armed whenever
 * retain()/release() subscribers drop to zero. On fire the stream is
 * aborted after idleDropMs (default 60s) — "disconnect", no status
 * change — letting the daemon's own idle timer fire (→ asleep) and making
 * the next promptEntry respawn/redial on demand.
 *
 * Liveness: no unit at all (frame event, keepalive ping, or comment) for
 * silenceDeadlineMs (default 30s) means the peer is dead → abort the stream,
 * and the reader error drives the same reconnect path an unexpected close
 * takes.
 */

import {
	OMP_PROTO,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_SILENCE_DEADLINE_MS,
	type ClientCommand,
	type DaemonStatus,
	type ServerFrame,
	type WebSessionState,
} from "../shared/protocol";
import { parseSseUnits } from "../shared/sse";
import type { Registry, RegistryEntry } from "./registry";

export interface ConnectorEvents {
	/** Every status transition (the registry entry is already updated). */
	onStatus?: (entry: RegistryEntry) => void;
	onHello?: (daemonId: string, hello: Extract<ServerFrame, { type: "hello_ok" }>) => void;
	/** Transport refused/unreachable — server.ts wires this to supervisor.respawn for mode "spawned". */
	onDialFailed?: (entry: RegistryEntry) => void;
	/** A reconnect was scheduled: attempt is 1-based, delayMs the backoff wait. */
	onReconnect?: (daemonId: string, attempt: number, delayMs: number) => void;
}

const DEFAULT_BACKOFF_MIN_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_IDLE_DROP_MS = 60_000;
const DEFAULT_WAIT_READY_MS = 60_000;

/** Readiness ladder ranks for #transitionLadder (monotonic upgrades only). */
const LADDER_RANK = { connecting: 0, session: 1, resolving: 2, ready: 3 } as const;

/** A pending waitReady() subscriber. */
interface Waiter {
	resolve: () => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ConnState {
	daemonId: string;
	/** AbortController for the in-flight /events fetch — the socket handle. */
	abort: AbortController | null;
	/** True while a /events response is live (200 + body streaming). */
	streamOpen: boolean;
	/** Connector-level intentional drop (disconnect/close): no status change, no redial. */
	closed: boolean;
	sawHello: boolean;
	sawState: boolean;
	sawReady: boolean;
	/** A stream_reset frame was seen on this stream (backpressure drop ahead of the end). */
	sawReset: boolean;
	/** Last event id seen on the current/previous stream (Last-Event-ID resume). */
	lastSeq: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** Epoch ms when the scheduled redial will fire (null when none pending). */
	reconnectAt: number | null;
	redialAttempt: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	retainCount: number;
	/** Resets on every SSE unit (event or comment); on fire the stream is dead. */
	silenceTimer: ReturnType<typeof setTimeout> | null;
	listeners: Set<(frame: ServerFrame) => void>;
	waiters: Waiter[];
}

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
}

/**
 * Normalize a registered endpoint for HTTP use: omp-session's OMP_SESSION|
 * listening line (and `add`-registered URLs) are pathless
 * (`ws://host:port`), so the base is the origin with the scheme mapped
 * ws→http / wss→https and any path stripped (no trailing slash). Callers
 * append the route (`/events`, `/command`).
 */
export function daemonHttpBase(endpoint: string): string {
	const url = new URL(endpoint);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export class DaemonConnector {
	#registry: Registry;
	#events: ConnectorEvents | undefined;
	#backoffMinMs: number;
	#backoffMaxMs: number;
	#idleDropMs: number;
	#silenceDeadlineMs: number;
	#states = new Map<string, ConnState>();

	constructor(
		registry: Registry,
		events?: ConnectorEvents,
		opts?: {
			backoffMinMs?: number;
			backoffMaxMs?: number;
			idleDropMs?: number;
			/** LIVENESS: total silence (no event, no comment) before the stream is treated as dead (default 30s). */
			silenceDeadlineMs?: number;
		},
	) {
		this.#registry = registry;
		this.#events = events;
		this.#backoffMinMs = opts?.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS;
		this.#backoffMaxMs = opts?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.#idleDropMs = opts?.idleDropMs ?? DEFAULT_IDLE_DROP_MS;
		this.#silenceDeadlineMs = opts?.silenceDeadlineMs ?? SSE_SILENCE_DEADLINE_MS;
	}

	/**
	 * Idempotent: dials entry.endpoint's /events with Authorization: Bearer
	 * entry.token and drives the status machine. No-op when a stream is
	 * already open or a dial is in flight; cancels any scheduled reconnect
	 * and dials now.
	 */
	connect(daemonId: string): void {
		const entry = this.#registry.get(daemonId);
		if (!entry) return;
		const state = this.#ensure(daemonId);
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer);
			state.reconnectTimer = null;
		}
		state.reconnectAt = null;
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
		state.closed = false;
		state.redialAttempt = 0;
		if (state.abort) {
			return; // already dialing or streaming
		}
		this.#transition(daemonId, "connecting");
		this.#dial(state, entry);
	}

	/** Intentional drop: no reconnect, no status change (idle policy / stop of attached|remote). */
	disconnect(daemonId: string): void {
		const state = this.#states.get(daemonId);
		if (!state) return;
		state.closed = true;
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer);
			state.reconnectTimer = null;
		}
		state.reconnectAt = null;
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
		this.#clearSilenceTimer(state);
		const abort = state.abort;
		state.abort = null;
		state.streamOpen = false;
		if (abort) {
			try {
				abort.abort();
			} catch {
				// Already aborted; the consume loop is guarded by state.closed.
			}
		}
	}

	/**
	 * Removal-time teardown (#24): superset of disconnect() — abort the
	 * stream, cancel every timer, reject outstanding waitReady() waiters
	 * immediately ("daemon removed"), and drop the per-daemon state
	 * (listeners, waiters, retain count) entirely. A removed daemon must not
	 * leak state behind a gone registry entry, and its waiters must not hang
	 * until their timeout — the registry removal makes #transition's waiter
	 * flush unreachable, so drop() owns the rejection.
	 */
	drop(daemonId: string): void {
		const state = this.#states.get(daemonId);
		if (!state) return;
		this.disconnect(daemonId);
		for (const waiter of state.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`daemon ${daemonId} removed`));
		}
		state.listeners.clear();
		this.#states.delete(daemonId);
	}

	/** False when the stream is down (or the daemon is no longer registered). */
	send(daemonId: string, cmd: ClientCommand): boolean {
		const entry = this.#registry.get(daemonId);
		if (!entry?.endpoint) return false; // removed entries are down
		const state = this.#states.get(daemonId);
		if (!state?.abort || !state.streamOpen || state.closed) return false;
		// Fire-and-forget accept: answers ride /events; a dropped POST is
		// recovered by the daemon-side dedup window + replay.
		fetch(daemonHttpBase(entry.endpoint) + "/command", {
			method: "POST",
			headers: { Authorization: `Bearer ${entry.token ?? ""}`, "Content-Type": "application/json" },
			body: JSON.stringify(cmd),
		}).catch(() => {
			// Ignore: the stream's reconnect path owns liveness; the daemon
			// dedups by command id if this POST is retried after replay.
		});
		return true;
	}

	isConnected(daemonId: string): boolean {
		const state = this.#states.get(daemonId);
		return state !== undefined && !state.closed && state.abort !== null && state.streamOpen;
	}

	/** +1 subscriber (proxied browser / in-flight prompt); cancels the idle-drop timer. */
	retain(daemonId: string): void {
		const state = this.#ensure(daemonId);
		state.retainCount++;
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
	}

	/** -1 subscriber; at 0 starts the idle-drop timer (default 60s) → disconnect. */
	release(daemonId: string): void {
		const state = this.#states.get(daemonId);
		if (!state) return;
		if (state.retainCount > 0) state.retainCount--;
		this.#armIdleDrop(state);
	}

	/**
	 * Arm the idle-drop timer: fires only with zero retain() subscribers and
	 * no timer already pending. Called from release() (last subscriber left)
	 * and from the ready transition, so a connection that was NEVER retained
	 * (supervisor endpoint resolution, /ctl add/provision) still drops its
	 * control socket instead of pinning the daemon's idle auto-exit forever.
	 */
	#armIdleDrop(state: ConnState): void {
		if (state.retainCount > 0 || state.idleTimer !== null) return;
		state.idleTimer = setTimeout(() => {
			state.idleTimer = null;
			this.disconnect(state.daemonId);
		}, this.#idleDropMs);
	}

	/** Subscribe to every frame from the daemon; returns the unsubscribe function. */
	onFrame(daemonId: string, fn: (frame: ServerFrame) => void): () => void {
		const state = this.#ensure(daemonId);
		state.listeners.add(fn);
		return () => {
			state.listeners.delete(fn);
		};
	}

	/**
	 * Resolves on status "ready" WITH a live stream; rejects on status "error"
	 * or timeout (default 60s). A stale "ready" registry status alone is NOT
	 * enough — the stream may have been idle-dropped or killed behind the
	 * status's back, and send() would fail right after. Without a live stream
	 * we wait for a ready transition, which only a fresh dial can produce.
	 */
	waitReady(daemonId: string, timeoutMs: number = DEFAULT_WAIT_READY_MS): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const entry = this.#registry.get(daemonId);
		if (entry?.status === "ready" && this.isConnected(daemonId)) {
			resolve();
			return promise;
		}
		if (entry?.status === "error") {
			reject(new Error(entry.error ?? `daemon ${daemonId} is in error state`));
			return promise;
		}
		const state = this.#ensure(daemonId);
		const waiter: Waiter = {
			resolve,
			reject,
			timer: setTimeout(() => {
				const index = state.waiters.indexOf(waiter);
				if (index !== -1) state.waiters.splice(index, 1);
				reject(new Error(`timed out waiting for ${daemonId} to become ready (${timeoutMs}ms)`));
			}, timeoutMs),
		};
		state.waiters.push(waiter);
		return promise;
	}

	/** Number of per-daemon states currently tracked (diagnostics/tests; 0 = nothing retained). */
	stateCount(): number {
		return this.#states.size;
	}

	/**
	 * Per-daemon connector state for /ctl/debug: the live transport state
	 * ("closed" | "streaming" | "reconnecting" | "dialing" | "idle"), the
	 * redial-attempt counter, and the pending retry countdown (absent when no
	 * redial is scheduled). Never includes tokens.
	 */
	snapshot(): Record<string, { state: string; attempts: number; nextRetryInMs?: number }> {
		const out: Record<string, { state: string; attempts: number; nextRetryInMs?: number }> = {};
		for (const [daemonId, state] of this.#states) {
			const info: { state: string; attempts: number; nextRetryInMs?: number } = {
				state: state.closed
					? "closed"
					: state.streamOpen
						? "streaming"
						: state.reconnectTimer
							? "reconnecting"
							: state.abort
								? "dialing"
								: "idle",
				attempts: state.redialAttempt,
			};
			if (state.reconnectTimer && state.reconnectAt !== null) {
				info.nextRetryInMs = Math.max(0, state.reconnectAt - Date.now());
			}
			out[daemonId] = info;
		}
		return out;
	}

	/** Drop every stream and cancel all timers. */
	async close(): Promise<void> {
		for (const state of this.#states.values()) {
			state.closed = true;
			if (state.reconnectTimer) {
				clearTimeout(state.reconnectTimer);
				state.reconnectTimer = null;
			}
			state.reconnectAt = null;
			if (state.idleTimer) {
				clearTimeout(state.idleTimer);
				state.idleTimer = null;
			}
			this.#clearSilenceTimer(state);
			const abort = state.abort;
			state.abort = null;
			state.streamOpen = false;
			if (abort) {
				try {
					abort.abort();
				} catch {
					// Ignore; the consume loop is guarded by state.closed.
				}
			}
		}
	}

	#ensure(daemonId: string): ConnState {
		let state = this.#states.get(daemonId);
		if (!state) {
			state = {
				daemonId,
				abort: null,
				streamOpen: false,
				closed: false,
				sawHello: false,
				sawState: false,
				sawReady: false,
				sawReset: false,
				lastSeq: 0,
				reconnectTimer: null,
				reconnectAt: null,
				redialAttempt: 0,
				idleTimer: null,
				retainCount: 0,
				silenceTimer: null,
				listeners: new Set(),
				waiters: [],
			};
			this.#states.set(daemonId, state);
		}
		return state;
	}

	#dial(state: ConnState, entry: RegistryEntry): void {
		state.sawHello = false;
		state.sawState = false;
		state.sawReady = false;
		state.sawReset = false;
		// A stale silence timer from a previous stream must not outlive the new dial.
		this.#clearSilenceTimer(state);
		const endpoint = entry.endpoint;
		if (!endpoint) {
			this.#transition(entry.daemonId, "error", "no endpoint registered");
			return;
		}
		const headers: Record<string, string> = {};
		if (entry.token) headers.Authorization = `Bearer ${entry.token}`;
		// Resume from the last event id seen. Priming already carries full
		// current state, so only delta-range seqs (≥ SSE_DELTA_SEQ_START)
		// warrant a replay request.
		if (state.lastSeq >= SSE_DELTA_SEQ_START) headers["Last-Event-ID"] = String(state.lastSeq);
		const abort = new AbortController();
		state.abort = abort;
		fetch(daemonHttpBase(endpoint) + "/events", { headers, signal: abort.signal })
			.then((res) => {
				if (state.abort !== abort) return; // superseded by a newer dial / drop
				if (state.closed) {
					abort.abort();
					return;
				}
				if (res.status === 401) {
					// Wrong credential: terminal. No reconnect loop — a respawn
					// (via onDialFailed) refreshes the token.
					res.body?.cancel().catch(() => {});
					this.#transition(
						entry.daemonId,
						"error",
						"unauthorized (401): daemon rejected the token",
					);
					this.#events?.onDialFailed?.(this.#registry.get(entry.daemonId) ?? entry);
					this.#onStreamEnded(state, { clean: false });
					return;
				}
				if (!res.ok) {
					// HTTP-level refusal — the dial never reached hello_ok.
					this.#onStreamEnded(state, { clean: false });
					return;
				}
				if (!res.body) {
					this.#onStreamEnded(state, { clean: true });
					return;
				}
				state.streamOpen = true;
				this.#armSilenceTimer(state);
				this.#consume(state, abort, res);
			})
			.catch(() => {
				if (state.abort !== abort) return; // superseded
				if (state.closed) return; // intentional abort (disconnect/close/idle)
				this.#onStreamEnded(state, { clean: false });
			});
	}

	async #consume(state: ConnState, abort: AbortController, res: Response): Promise<void> {
		try {
			for await (const unit of parseSseUnits(res.body!)) {
				if (state.abort !== abort) return; // superseded or dropped
				// Any unit — frame event, keepalive ping, or comment — proves the
				// peer lives and resets the deadline.
				this.#armSilenceTimer(state);
				// Keepalive pings (and any other non-frame event) carry no
				// ServerFrame; skip before dispatch.
				if (unit.kind !== "event" || unit.event !== SSE_EVENT_NAME) continue;
				const seq = Number(unit.id);
				if (Number.isFinite(seq) && seq > state.lastSeq) state.lastSeq = seq;
				const frame = this.#parseFrame(unit.data);
				if (!frame) continue; // non-JSON noise
				this.#onFrame(state, frame);
			}
		} catch {
			if (state.abort !== abort) return; // superseded
			if (state.closed) return; // intentional abort raced the read
			this.#onStreamEnded(state, { clean: false });
			return;
		}
		if (state.abort !== abort) return;
		// Normal end of stream: the daemon closed it cleanly (dormant).
		this.#onStreamEnded(state, { clean: true });
	}

	#parseFrame(data: string): ServerFrame | null {
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return null; // non-JSON noise
		}
		// Boundary validation: a frame is an object with a string discriminator.
		if (
			typeof raw !== "object" ||
			raw === null ||
			!("type" in raw) ||
			typeof raw.type !== "string"
		) {
			return null;
		}
		return raw as unknown as ServerFrame;
	}

	#onFrame(state: ConnState, frame: ServerFrame): void {
		// Fan out first so correlation listeners see every frame; a throwing
		// listener must not break the status machine.
		for (const fn of [...state.listeners]) {
			try {
				fn(frame);
			} catch {
				// Ignore listener failures.
			}
		}
		switch (frame.type) {
			case "hello_ok":
				this.#onHello(state, frame);
				break;
			case "state":
				this.#onState(state, frame);
				break;
			case "ready":
				this.#onReady(state, frame);
				break;
			case "stream_reset":
				// Daemon-side backpressure drop: the end that follows is a
				// drop-and-resume, not a dormant close. #onStreamEnded treats
				// the clean end as "reconnecting" (Last-Event-ID redial).
				state.sawReset = true;
				break;
			default:
				break;
		}
	}

	#onHello(state: ConnState, hello: Extract<ServerFrame, { type: "hello_ok" }>): void {
		if (!this.#registry.get(state.daemonId)) return;
		const entry = this.#registry.get(state.daemonId)!;
		// Proto gate: a daemon speaking a newer/older OMP_PROTO is not drivable;
		// the mismatch is terminal until a compatible daemon is respawned.
		if (hello.proto !== OMP_PROTO) {
			this.#transition(
				state.daemonId,
				"error",
				`proto mismatch: daemon speaks OMP_PROTO ${hello.proto}, expected ${OMP_PROTO}`,
			);
			state.abort?.abort();
			return;
		}
		if (!entry.cwd) {
			// `add`ed entries with an empty cwd adopt the daemon's real cwd.
			this.#registry.update(state.daemonId, { cwd: hello.cwd });
		} else if (entry.cwd !== hello.cwd) {
			this.#transition(
				state.daemonId,
				"error",
				`cwd mismatch: omp-session reports ${hello.cwd}, registered ${entry.cwd}`,
			);
			state.abort?.abort();
			return;
		}
		if (hello.sessionFile) {
			this.#registry.update(state.daemonId, { lastSessionFile: hello.sessionFile });
		}
		state.sawHello = true;
		// Drivable only AFTER the validated hello (R8 + cwd sanity): state/ready
		// frames that arrived early only marked sawState/sawReady — replay the
		// furthest ladder position now that the handshake checked out.
		this.#transitionLadder(
			state.daemonId,
			state.sawReady ? "ready" : state.sawState ? "resolving" : "session",
		);
		this.#events?.onHello?.(state.daemonId, hello);
	}

	#onState(state: ConnState, frame: Extract<ServerFrame, { type: "state" }>): void {
		const session = frame.state as WebSessionState;
		if (typeof session?.sessionFile === "string" && session.sessionFile) {
			this.#registry.update(state.daemonId, { lastSessionFile: session.sessionFile });
		}
		if (!state.sawState) {
			state.sawState = true;
			// Pre-hello frames only mark progress; the validated hello replays it.
			if (state.sawHello) this.#transitionLadder(state.daemonId, "resolving");
		}
	}

	#onReady(state: ConnState, frame: Extract<ServerFrame, { type: "ready" }>): void {
		if (typeof frame.readyAt === "number") {
			this.#registry.update(state.daemonId, { readyAt: frame.readyAt });
		}
		state.sawReady = true;
		if (state.sawHello) this.#transitionLadder(state.daemonId, "ready");
		// A ready connection nobody retained keeps no control socket open:
		// arm the idle-drop so the daemon's own idle auto-exit can fire.
		this.#armIdleDrop(state);
	}

	/** The stream (or its fetch) ended: clean → asleep, else reconnect. */
	#onStreamEnded(state: ConnState, opts: { clean: boolean }): void {
		state.streamOpen = false;
		this.#clearSilenceTimer(state);
		state.abort = null;
		if (state.closed) return; // disconnect()/close() — intentional, no status change
		const entry = this.#registry.get(state.daemonId);
		if (!entry) return;
		if (entry.status === "error") return; // error is terminal: never overwrite or redial
		if (opts.clean) {
			// A stream_reset frame just before EOF marks a backpressure drop:
			// the daemon is alive and the stream was too slow — drop-and-resume
			// (reconnecting + Last-Event-ID), never dormant.
			const reset = state.sawReset;
			state.sawReset = false;
			if (!reset) {
				// Clean end: the daemon went dormant; keep cwd + lastSessionFile.
				this.#transition(state.daemonId, "asleep");
				return;
			}
		}
		const dialFailed = !state.sawHello;
		this.#transition(state.daemonId, "reconnecting");
		if (dialFailed) {
			this.#events?.onDialFailed?.(this.#registry.get(state.daemonId) ?? entry);
		}
		this.#scheduleRedial(state);
	}

	#scheduleRedial(state: ConnState): void {
		if (state.closed) return;
		if (state.reconnectTimer) return;
		const attempt = state.redialAttempt++;
		const delay = backoffDelay(attempt, this.#backoffMinMs, this.#backoffMaxMs);
		state.reconnectAt = Date.now() + delay;
		this.#events?.onReconnect?.(state.daemonId, attempt + 1, delay);
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null;
			state.reconnectAt = null;
			if (state.closed) return;
			const entry = this.#registry.get(state.daemonId);
			if (!entry) return;
			this.#dial(state, entry);
		}, delay);
	}

	/**
	 * Readiness-ladder transitions are monotonic: connecting < session <
	 * resolving < ready, and "error" is never overwritten. A real
	 * omp-session sends its attach priming (state, and ready when the gate
	 * already cleared) BEFORE it answers our hello — an out-of-order
	 * hello_ok/state must not downgrade an already-ready daemon.
	 */
	#transitionLadder(daemonId: string, status: "session" | "resolving" | "ready"): void {
		const current = this.#registry.get(daemonId)?.status;
		if (current === "error") return;
		if (
			current &&
			current in LADDER_RANK &&
			LADDER_RANK[current as keyof typeof LADDER_RANK] > LADDER_RANK[status]
		)
			return;
		this.#transition(daemonId, status);
	}

	/** Reset the silence deadline; every SSE unit (event or comment) re-arms it. */
	#armSilenceTimer(state: ConnState): void {
		this.#clearSilenceTimer(state);
		state.silenceTimer = setTimeout(() => {
			state.silenceTimer = null;
			if (state.closed || !state.abort) return;
			// Dead peer: no event/comment within the deadline. Abort the stream;
			// the reader error drives the same reconnect path as an unexpected close.
			state.abort.abort();
		}, this.#silenceDeadlineMs);
	}

	#clearSilenceTimer(state: ConnState): void {
		if (state.silenceTimer) {
			clearTimeout(state.silenceTimer);
			state.silenceTimer = null;
		}
	}

	/** Central status transition: persist, flush waiters, notify. */
	#transition(daemonId: string, status: DaemonStatus, error?: string): void {
		if (!this.#registry.get(daemonId)) return;
		this.#registry.setStatus(daemonId, status, error);
		const state = this.#states.get(daemonId);
		if (state && state.waiters.length > 0) {
			if (status === "ready") {
				for (const waiter of state.waiters.splice(0)) {
					clearTimeout(waiter.timer);
					waiter.resolve();
				}
			} else if (status === "error") {
				const message = error ?? `daemon ${daemonId} entered error state`;
				for (const waiter of state.waiters.splice(0)) {
					clearTimeout(waiter.timer);
					waiter.reject(new Error(message));
				}
			}
		}
		this.#events?.onStatus?.(this.#registry.get(daemonId)!);
	}
}
