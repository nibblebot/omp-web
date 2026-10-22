/**
 * `ws` transport adapter: the browser socket (OMP_PROTO 5, `GET /ws`) driven
 * from Bun's client WebSocket, the same wire apps/web speaks.
 *
 * Dial: `browserSocketUrl(baseUrl, { clientId, after, proto: OMP_PROTO, token: null })`.
 * The harness talks to a loopback fleet, so no token and no cookie.
 *
 * What the edge must provide (the adapter and its fake-server test assume exactly this):
 * - `GET /ws` upgrades; `client` keys the replay ring, `after` resumes it.
 * - every text message is one object of `parseServerMessage`: `{"seq":N,"frame":F}`,
 *   `{"frame":F}`, `{"ping":ms}`, `{"ack":id}` or `{"nack":id,"status":S,"error":E}`.
 * - a client message `{"cmd":C}` (C carries a string `id`) is answered by one `ack`/`nack`
 *   for that id, and later by the id-keyed answer frame (`call_result`, `attach_result`).
 *   A re-sent id is acked again.
 * - a refusal at dial time is an upgrade followed by an immediate typed close
 *   (4401/4403/4426); a slow consumer is closed 4503 and resumes with `after`.
 *
 * Measurements:
 * - A frame's receive time (`recvNs`) is `monotonicNs()` taken at the top of the
 *   message handler, before the message is parsed, so parse cost never inflates
 *   latency. Each WebSocket message is its own event, so frames never share a stamp.
 * - `ReceivedFrame.bytes` is the UTF-8 length of the frame's message (envelope
 *   included). `bytesDown`/`bytesUp` count message bytes, keepalive pings and
 *   acks included; WebSocket frame headers and TCP/TLS overhead are not visible
 *   to a client socket (the sampler's `ss` counters cover those).
 * - `send()` resolves on the ack, not on the answer: command RTT is measured by
 *   the client from send to the answer frame, as it was over POST + SSE.
 *
 * Not implemented, on purpose: the browser's silence deadline (30 s without any
 * message closes and redials). A harness that redialed on silence would hide the
 * edge failing its keepalive; the run's own waits time out instead.
 */
import { OMP_PROTO, type ClientCommand } from "#lib/wire/protocol";
import {
	browserSocketUrl,
	browserCloseFor,
	commandMessage,
	parseServerMessage,
} from "#lib/wire/browser-socket";
import { monotonicNs } from "../clock";
import type { ReceivedFrame, TransportAdapter, TransportConnection, TransportOpen } from "../types";

type Ended = "closed" | "dropped" | "error";

interface TerminableWebSocket extends WebSocket {
	/** Destroy the connection without a close handshake. */
	terminate(): void;
}

/** The abnormal-closure code a client reports when no close frame arrived. */
const CLOSE_ABNORMAL = 1006;

class WsConnection implements TransportConnection {
	bytesDown = 0;
	bytesUp = 0;
	lastSeq: number | undefined;
	closeInfo: string | undefined;
	/** Resolves when the socket opened; rejects when it closed first (refused dial, no listener). */
	readonly opened: Promise<void>;
	readonly ended: Promise<Ended>;
	readonly #ws: TerminableWebSocket;
	readonly #listeners: Array<(received: ReceivedFrame) => void> = [];
	/** Frames that arrive before the first onFrame registration (the open() -> onFrame gap). */
	#backlog: ReceivedFrame[] | null = [];
	/** Commands sent and not yet acked, per command id, oldest first (a re-sent id queues behind itself). */
	readonly #pending = new Map<string, Array<PromiseWithResolvers<void>>>();
	#dropped = false;
	#violation: string | undefined;
	#isOpen = false;

	constructor(url: string, after: number | undefined) {
		this.lastSeq = after;
		// Bun's client WebSocket has terminate() (ws-package compatible) but bun-types omits it.
		const ws = new WebSocket(url) as TerminableWebSocket;
		this.#ws = ws;
		const opened = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<Ended>();
		this.opened = opened.promise;
		this.ended = ended.promise;
		ws.addEventListener("open", () => {
			this.#isOpen = true;
			opened.resolve();
		});
		ws.addEventListener("message", (event) => {
			const recvNs = monotonicNs();
			this.#onMessage(event.data, recvNs);
		});
		ws.addEventListener("close", (event) => {
			this.closeInfo = `${event.code}${event.reason === "" ? "" : ` ${event.reason}`}`;
			const how: Ended = this.#dropped
				? "dropped"
				: this.#violation !== undefined || event.code === CLOSE_ABNORMAL
					? "error"
					: "closed";
			if (!this.#isOpen) {
				opened.reject(new Error(`GET /ws failed before the upgrade completed (${this.closeInfo})`));
			}
			this.#failPending(
				new Error(`socket closed before the command was acked (${this.closeInfo})`),
			);
			ended.resolve(how);
		});
	}

	#onMessage(data: unknown, recvNs: bigint): void {
		if (this.#violation !== undefined) return;
		const bytes = typeof data === "string" ? Buffer.byteLength(data) : 0;
		this.bytesDown += bytes;
		const message = parseServerMessage(data);
		if (message === null) {
			this.#violation = "unparseable server message";
			const { code, reason } = browserCloseFor("protocol_violation", this.#violation);
			this.#ws.close(code, reason);
			return;
		}
		switch (message.kind) {
			case "ping":
				return;
			case "ack":
				this.#settle(message.id)?.resolve();
				return;
			case "nack":
				this.#settle(message.id)?.reject(
					new Error(`command ${message.id} nacked ${message.status}: ${message.error}`),
				);
				return;
			case "frame": {
				const received: ReceivedFrame = {
					frame: message.frame as ReceivedFrame["frame"],
					recvNs,
					bytes,
				};
				if (message.seq !== null) {
					received.seq = message.seq;
					if (this.lastSeq === undefined || message.seq > this.lastSeq) this.lastSeq = message.seq;
				}
				if (this.#backlog !== null) this.#backlog.push(received);
				else for (const cb of this.#listeners) cb(received);
				return;
			}
		}
	}

	#settle(id: string): PromiseWithResolvers<void> | undefined {
		const queue = this.#pending.get(id);
		const next = queue?.shift();
		if (queue?.length === 0) this.#pending.delete(id);
		return next;
	}

	#failPending(err: Error): void {
		for (const queue of this.#pending.values()) for (const waiter of queue) waiter.reject(err);
		this.#pending.clear();
	}

	onFrame(cb: (received: ReceivedFrame) => void): void {
		this.#listeners.push(cb);
		if (this.#backlog !== null) {
			const pending = this.#backlog;
			this.#backlog = null;
			for (const received of pending) for (const l of this.#listeners) l(received);
		}
	}

	send(command: Record<string, unknown>): Promise<void> {
		const id = command.id;
		if (typeof id !== "string") {
			return Promise.reject(new Error("browser socket commands carry a string id"));
		}
		if (this.#ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(
				new Error(
					`socket is not open${this.closeInfo === undefined ? "" : ` (${this.closeInfo})`}`,
				),
			);
		}
		// ProfileClient builds every command in the ClientCommand shape; the transport interface only sees a record.
		const wireCommand = command as unknown as ClientCommand;
		const text = commandMessage(wireCommand);
		this.bytesUp += Buffer.byteLength(text);
		const waiter = Promise.withResolvers<void>();
		const queue = this.#pending.get(id);
		if (queue === undefined) this.#pending.set(id, [waiter]);
		else queue.push(waiter);
		this.#ws.send(text);
		return waiter.promise;
	}

	drop(): void {
		this.#dropped = true;
		this.#ws.terminate();
	}

	async close(): Promise<void> {
		this.drop();
		await this.ended;
	}
}

export const wsAdapter: TransportAdapter = {
	name: "ws",
	async open(opts: TransportOpen): Promise<TransportConnection> {
		const url = browserSocketUrl(opts.baseUrl, {
			clientId: opts.clientId,
			after: opts.after ?? null,
			proto: OMP_PROTO,
			token: null,
		});
		const conn = new WsConnection(url, opts.after);
		await conn.opened;
		return conn;
	},
};
