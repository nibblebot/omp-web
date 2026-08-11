/**
 * DaemonConnector: the fleet's per-daemon WebSocket client.
 *
 * Dials the daemon's registered endpoint with the bearer token on the
 * upgrade (R14 — the token in the Authorization header means no hello frame
 * is needed) and drives the status machine:
 *
 *   connect → "connecting" → (hello_ok) "session" → (first state frame)
 *   "resolving" → (ready frame) "ready"
 *
 * An unexpected close (anything but 1000/1001, not connector-initiated)
 * → "reconnecting" with jittered exponential backoff (1s→30s by default)
 * and a fresh dial. A clean close → "asleep" (cwd + lastSessionFile kept).
 * A dial that never reached hello_ok additionally fires `onDialFailed` so
 * the server can respawn spawned daemons with a fresh token.
 *
 * Idle policy: when retain()/release() subscribers drop to zero, the socket
 * is dropped after idleDropMs (default 60s) — "disconnect", no status
 * change — letting the daemon's own idle timer fire (→ asleep) and making
 * the next promptEntry respawn/redial on demand.
 *
 * Liveness: every open socket is pinged every 15s (startSocketKeepalive,
 * shared with the edge's proxy pipes); a pong not observed within 10s of a
 * ping terminates the socket and the close path below drives reconnecting.
 */

import { OMP_PROTO } from "../src/protocol";
import type { ClientCommand, DaemonStatus, ServerFrame, WebSessionState } from "../src/protocol";
import type { Registry, RegistryEntry } from "./registry";

export interface ConnectorEvents {
	/** Every status transition (the registry entry is already updated). */
	onStatus?: (entry: RegistryEntry) => void;
	onHello?: (daemonId: string, hello: Extract<ServerFrame, { type: "hello_ok" }>) => void;
	/** Transport refused/unreachable — server.ts wires this to supervisor.respawn for mode "spawned". */
	onDialFailed?: (entry: RegistryEntry) => void;
}

const DEFAULT_BACKOFF_MIN_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_IDLE_DROP_MS = 60_000;
const DEFAULT_WAIT_READY_MS = 60_000;
/** LIVENESS: ping each open socket every 15s… */
export const DEFAULT_PING_INTERVAL_MS = 15_000;
/** …and treat 10s without a pong as a dead peer (terminate → reconnect). */
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

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
	socket: WebSocket | null;
	/** Connector-level intentional drop (disconnect/close): no status change, no redial. */
	closed: boolean;
	/** A disconnect() raced an in-flight dial; drop the socket as soon as it opens. */
	dropWhenOpen: boolean;
	sawHello: boolean;
	sawState: boolean;
	sawReady: boolean;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	redialAttempt: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	retainCount: number;
	/** Stops the socket keepalive (ping/pong liveness) for the current socket. */
	keepaliveStop: (() => void) | null;
	listeners: Set<(frame: ServerFrame) => void>;
	waiters: Waiter[];
}

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
}

/**
 * Normalize a registered endpoint for dialing: omp-session's OMP_SESSION|
 * listening line (and `add`-registered URLs) are pathless
 * (`ws://host:port`), but omp-session only upgrades `/ws`. Append it when
 * the path is empty or "/".
 */
export function daemonWsUrl(endpoint: string): string {
	const url = new URL(endpoint);
	if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
	return url.toString();
}

/**
 * Socket liveness (LIVENESS contract), shared by the connector's control
 * sockets and the edge's proxy pipes. Pings the peer every
 * `pingIntervalMs`; if no pong is observed within `pongTimeoutMs` of a ping,
 * the socket is terminated and the caller's existing close handler drives
 * reconnecting. Any pong — the server's automatic ping→pong response or an
 * unsolicited one — proves the peer's stack is alive and clears the
 * deadline.
 *
 * Pongs are observed via `addEventListener("pong", …)`: Bun 1.3.14's client
 * WebSocket surfaces received pong frames this way (scratch-verified — the
 * event fires with the pong payload for both auto-pongs and server-initiated
 * pongs). `ws.onpong` is NOT a real property on the client (`"onpong" in ws
 * === false`); assigning it creates a dead expando that never fires, and the
 * typed WebSocketEventMap only lists close/error/message/open, so the
 * listener registers through the untyped string overload.
 *
 * Returns an idempotent stop function (clears both timers and removes the
 * pong listener). Call it on every socket teardown path.
 */
export function startSocketKeepalive(
	ws: WebSocket,
	opts: { pingIntervalMs: number; pongTimeoutMs: number },
): () => void {
	// Bun's client WebSocket implements ping()/terminate(), but tsconfig's
	// DOM lib shadows the global with the DOM type, which lacks them — narrow
	// to the Bun type once (the runtime object is always Bun's).
	const bunWs = ws as unknown as Bun.WebSocket;
	let pingTimer: ReturnType<typeof setTimeout> | null = null;
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	const onPong = (): void => {
		if (pongTimer !== null) {
			clearTimeout(pongTimer);
			pongTimer = null;
		}
	};
	ws.addEventListener("pong", onPong);

	const sendPing = (): void => {
		if (stopped || ws.readyState !== WS_OPEN) return;
		try {
			bunWs.ping();
		} catch {
			return; // Socket died between check and send; the close handler owns the machine.
		}
		pongTimer = setTimeout(() => {
			pongTimer = null;
			if (stopped || ws.readyState !== WS_OPEN) return;
			// Silent peer: no pong within the deadline. Terminate and let the
			// close handler (1006 → reconnecting) drive the redial.
			try {
				bunWs.terminate();
			} catch {
				// Socket already gone; the close handler owns the machine.
			}
		}, opts.pongTimeoutMs);
		// Re-arm the interval AFTER the ping went out, so the loop is
		// continuous while the socket is open (and dies with it otherwise).
		pingTimer = setTimeout(sendPing, opts.pingIntervalMs);
	};

	pingTimer = setTimeout(sendPing, opts.pingIntervalMs);

	return () => {
		stopped = true;
		if (pingTimer !== null) {
			clearTimeout(pingTimer);
			pingTimer = null;
		}
		if (pongTimer !== null) {
			clearTimeout(pongTimer);
			pongTimer = null;
		}
		ws.removeEventListener("pong", onPong);
	};
}

export class DaemonConnector {
	#registry: Registry;
	#events: ConnectorEvents | undefined;
	#backoffMinMs: number;
	#backoffMaxMs: number;
	#idleDropMs: number;
	#pingIntervalMs: number;
	#pongTimeoutMs: number;
	#states = new Map<string, ConnState>();

	constructor(
		registry: Registry,
		events?: ConnectorEvents,
		opts?: {
			backoffMinMs?: number;
			backoffMaxMs?: number;
			idleDropMs?: number;
			/** LIVENESS: ping interval per open socket (default 15s). */
			pingIntervalMs?: number;
			/** LIVENESS: silence deadline after a ping before terminating (default 10s). */
			pongTimeoutMs?: number;
		},
	) {
		this.#registry = registry;
		this.#events = events;
		this.#backoffMinMs = opts?.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS;
		this.#backoffMaxMs = opts?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.#idleDropMs = opts?.idleDropMs ?? DEFAULT_IDLE_DROP_MS;
		this.#pingIntervalMs = opts?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
		this.#pongTimeoutMs = opts?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
	}

	/**
	 * Idempotent: dials entry.endpoint with Authorization: Bearer entry.token
	 * and drives the status machine. No-op when a socket is already open or a
	 * dial is in flight; cancels any scheduled reconnect and dials now.
	 */
	connect(daemonId: string): void {
		const entry = this.#registry.get(daemonId);
		if (!entry) return;
		const state = this.#ensure(daemonId);
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer);
			state.reconnectTimer = null;
		}
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
		state.closed = false;
		state.dropWhenOpen = false;
		state.redialAttempt = 0;
		if (state.socket && (state.socket.readyState === WS_CONNECTING || state.socket.readyState === WS_OPEN)) {
			return; // already connected or dialing
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
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = null;
		}
		if (state.keepaliveStop) {
			state.keepaliveStop();
			state.keepaliveStop = null;
		}
		const ws = state.socket;
		state.socket = null;
		if (!ws) return;
		if (ws.readyState === WS_OPEN) {
			try {
				ws.close(1000, "fleet disconnect");
			} catch {
				// Already closing; the close handler is guarded by state.closed.
			}
		} else if (ws.readyState === WS_CONNECTING) {
			state.dropWhenOpen = true;
		}
	}

	/** False when the socket is down (or the daemon is no longer registered). */
	send(daemonId: string, cmd: ClientCommand): boolean {
		if (!this.#registry.get(daemonId)) return false; // removed entries are down
		const state = this.#states.get(daemonId);
		if (!state?.socket || state.socket.readyState !== WS_OPEN || state.closed) return false;
		try {
			state.socket.send(JSON.stringify(cmd));
			return true;
		} catch {
			return false;
		}
	}

	isConnected(daemonId: string): boolean {
		const state = this.#states.get(daemonId);
		return state !== undefined && !state.closed && state.socket !== null && state.socket.readyState === WS_OPEN;
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
		if (state.retainCount === 0 && state.idleTimer === null) {
			state.idleTimer = setTimeout(() => {
				state.idleTimer = null;
				this.disconnect(daemonId);
			}, this.#idleDropMs);
		}
	}

	/** Subscribe to every frame from the daemon; returns the unsubscribe function. */
	onFrame(daemonId: string, fn: (frame: ServerFrame) => void): () => void {
		const state = this.#ensure(daemonId);
		state.listeners.add(fn);
		return () => {
			state.listeners.delete(fn);
		};
	}

	/** Resolves on status "ready"; rejects on status "error" or timeout (default 60s). */
	waitReady(daemonId: string, timeoutMs: number = DEFAULT_WAIT_READY_MS): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const entry = this.#registry.get(daemonId);
		if (entry?.status === "ready") {
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

	/** Drop every socket and cancel all timers. */
	async close(): Promise<void> {
		for (const state of this.#states.values()) {
			state.closed = true;
			if (state.reconnectTimer) {
				clearTimeout(state.reconnectTimer);
				state.reconnectTimer = null;
			}
			if (state.idleTimer) {
				clearTimeout(state.idleTimer);
				state.idleTimer = null;
			}
			if (state.keepaliveStop) {
				state.keepaliveStop();
				state.keepaliveStop = null;
			}
			const ws = state.socket;
			state.socket = null;
			if (ws && ws.readyState === WS_OPEN) {
				try {
					ws.close(1000, "fleet close");
				} catch {
					// Ignore; the close handler is guarded by state.closed.
				}
			}
		}
	}

	#ensure(daemonId: string): ConnState {
		let state = this.#states.get(daemonId);
		if (!state) {
			state = {
				daemonId,
				socket: null,
				closed: false,
				dropWhenOpen: false,
				sawHello: false,
				sawState: false,
				sawReady: false,
				reconnectTimer: null,
				redialAttempt: 0,
				idleTimer: null,
				retainCount: 0,
				keepaliveStop: null,
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
		// A stale keepalive (from a previous socket that never got its close
		// processed) must not outlive the new dial.
		if (state.keepaliveStop) {
			state.keepaliveStop();
			state.keepaliveStop = null;
		}
		const endpoint = entry.endpoint;
		if (!endpoint) {
			this.#transition(entry.daemonId, "error", "no endpoint registered");
			return;
		}
		let ws: WebSocket;
		try {
			// Bun's WebSocket accepts { headers } (Bun.WebSocketOptions); the DOM
			// type only allows protocols, hence the cast.
			ws = new WebSocket(daemonWsUrl(endpoint), { headers: { Authorization: `Bearer ${entry.token ?? ""}` } } as never);
		} catch (err) {
			this.#transition(entry.daemonId, "error", `dial failed: ${(err as Error).message}`);
			this.#events?.onDialFailed?.(this.#registry.get(entry.daemonId) ?? entry);
			return;
		}
		state.socket = ws;
		ws.onopen = () => {
			if (state.socket !== ws) return;
			if (state.closed || state.dropWhenOpen) {
				try {
					ws.close(1000, "fleet disconnect");
				} catch {
					// Ignore.
				}
				return;
			}
			// omp-session answers a valid hello with hello_ok on ANY socket
			// (R14); the Authorization header alone does NOT elicit a
			// proactive hello_ok.
			try {
				ws.send(JSON.stringify({ type: "hello", proto: OMP_PROTO, token: entry.token } satisfies ClientCommand));
			} catch {
				// Socket died between open and send; the close handler owns the machine.
			}
			// LIVENESS: ping every #pingIntervalMs, terminate on #pongTimeoutMs
			// of silence; the close handler below drives reconnecting.
			state.keepaliveStop = startSocketKeepalive(ws, {
				pingIntervalMs: this.#pingIntervalMs,
				pongTimeoutMs: this.#pongTimeoutMs,
			});
		};
		ws.onmessage = (ev) => {
			if (state.socket !== ws) return;
			this.#onMessage(state, String(ev.data));
		};
		ws.onerror = () => {
			// Bun fires onclose after onerror; the close handler owns the machine.
		};
		ws.onclose = (ev) => {
			if (state.socket !== ws) return;
			state.socket = null;
			this.#onClose(state, ev.code);
		};
	}

	#onMessage(state: ConnState, data: string): void {
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return; // non-JSON noise
		}
		// Boundary validation: a frame is an object with a string discriminator.
		if (typeof raw !== "object" || raw === null || !("type" in raw) || typeof raw.type !== "string") {
			return;
		}
		const frame = raw as unknown as ServerFrame;
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
			default:
				break;
		}
	}

	#onHello(state: ConnState, hello: Extract<ServerFrame, { type: "hello_ok" }>): void {
		if (!this.#registry.get(state.daemonId)) return;
		const entry = this.#registry.get(state.daemonId)!;
		if (!entry.cwd) {
			// `add`ed entries with an empty cwd adopt the daemon's real cwd.
			this.#registry.update(state.daemonId, { cwd: hello.cwd });
		} else if (entry.cwd !== hello.cwd) {
			this.#transition(
				state.daemonId,
				"error",
				`cwd mismatch: omp-session reports ${hello.cwd}, registered ${entry.cwd}`,
			);
			state.socket?.close(1000, "cwd mismatch");
			return;
		}
		if (hello.sessionFile) {
			this.#registry.update(state.daemonId, { lastSessionFile: hello.sessionFile });
		}
		state.sawHello = true;
		// Drivable only AFTER the validated hello (R8 + cwd sanity): state/ready
		// frames that arrived early only marked sawState/sawReady — replay the
		// furthest ladder position now that the handshake checked out.
		this.#transitionLadder(state.daemonId, state.sawReady ? "ready" : state.sawState ? "resolving" : "session");
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
	}

	#onClose(state: ConnState, code: number): void {
		if (state.keepaliveStop) {
			state.keepaliveStop();
			state.keepaliveStop = null;
		}
		if (state.closed) return; // disconnect()/close() — intentional, no status change
		const entry = this.#registry.get(state.daemonId);
		if (!entry) return;
		if (entry.status === "error") return; // error is terminal: never overwrite or redial
		if (code === 1000 || code === 1001) {
			// Clean close: the daemon went dormant; keep cwd + lastSessionFile.
			this.#transition(state.daemonId, "asleep");
			return;
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
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null;
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
		if (current && current in LADDER_RANK && LADDER_RANK[current as keyof typeof LADDER_RANK] > LADDER_RANK[status]) return;
		this.#transition(daemonId, status);
	}

	/** Central status transition: persist, flush waiters, notify. */
	#transition(daemonId: string, status: DaemonStatus, error?: string): void {		if (!this.#registry.get(daemonId)) return;
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
