/**
 * `sse+post` transport adapter: the production browser<->fleet transport
 * (GET /events SSE down, POST /command 202 up) driven from Bun.
 *
 * Receive timestamps are taken when the network chunk carrying a frame is
 * read (before parsing), so several frames in one chunk share the arrival
 * stamp and parse cost never inflates latency. `bytesDown` counts raw body
 * bytes (framing and keepalive pings included); `ReceivedFrame.bytes` is the
 * exact SSE block of that frame.
 */
import { parseSseUnits, SSE_PING_EVENT } from "#lib/wire/sse";
import { monotonicNs } from "../clock";
import type { ReceivedFrame, TransportAdapter, TransportConnection, TransportOpen } from "../types";

type Ended = "closed" | "dropped" | "error";

class SseConnection implements TransportConnection {
	bytesDown = 0;
	bytesUp = 0;
	lastSeq: string | undefined;
	readonly ended: Promise<Ended>;
	readonly #controller = new AbortController();
	readonly #listeners: Array<(received: ReceivedFrame) => void> = [];
	/** Frames that arrive before the first onFrame registration (the open() -> onFrame gap). */
	#backlog: ReceivedFrame[] | null = [];
	#dropped = false;
	readonly #baseUrl: string;
	readonly #clientId: string;

	constructor(baseUrl: string, clientId: string, body: ReadableStream<Uint8Array>) {
		this.#baseUrl = baseUrl;
		this.#clientId = clientId;
		this.ended = this.#pump(body);
	}

	async #pump(body: ReadableStream<Uint8Array>): Promise<Ended> {
		let chunkNs = monotonicNs();
		const counted = body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform: (chunk, controller) => {
					chunkNs = monotonicNs();
					this.bytesDown += chunk.byteLength;
					controller.enqueue(chunk);
				},
			}),
		);
		try {
			for await (const unit of parseSseUnits(counted)) {
				if (unit.kind !== "event" || unit.event === SSE_PING_EVENT) continue;
				const frame = JSON.parse(unit.data) as ReceivedFrame["frame"];
				const bytes = Buffer.byteLength(
					`event: ${unit.event}\n${unit.id !== undefined ? `id: ${unit.id}\n` : ""}data: ${unit.data}\n\n`,
				);
				if (unit.id !== undefined) this.lastSeq = unit.id;
				const received: ReceivedFrame = { frame, recvNs: chunkNs, bytes };
				if (unit.id !== undefined) received.seq = unit.id;
				if (this.#backlog !== null) this.#backlog.push(received);
				else for (const cb of this.#listeners) cb(received);
			}
			return this.#dropped ? "dropped" : "closed";
		} catch {
			return this.#dropped ? "dropped" : "error";
		}
	}

	onFrame(cb: (received: ReceivedFrame) => void): void {
		this.#listeners.push(cb);
		if (this.#backlog !== null) {
			const pending = this.#backlog;
			this.#backlog = null;
			for (const received of pending) for (const l of this.#listeners) l(received);
		}
	}

	async send(command: Record<string, unknown>): Promise<void> {
		const body = JSON.stringify(command);
		this.bytesUp += Buffer.byteLength(body);
		const res = await fetch(`${this.#baseUrl}/command`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-client-id": this.#clientId },
			body,
		});
		await res.arrayBuffer();
		if (res.status !== 202) throw new Error(`POST /command -> ${res.status}`);
	}

	drop(): void {
		this.#dropped = true;
		this.#controller.abort();
	}

	async close(): Promise<void> {
		this.drop();
		await this.ended;
	}

	/** Wire the abort signal into the fetch that produced the body. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}
}

export const ssePostAdapter: TransportAdapter = {
	name: "sse+post",
	async open(opts: TransportOpen): Promise<TransportConnection> {
		const controller = new AbortController();
		const headers: Record<string, string> = {};
		if (opts.resumeFrom !== undefined) headers["last-event-id"] = opts.resumeFrom;
		const res = await fetch(`${opts.baseUrl}/events?client=${encodeURIComponent(opts.clientId)}`, {
			headers,
			signal: controller.signal,
		});
		if (!res.ok || res.body === null) throw new Error(`GET /events -> ${res.status}`);
		const conn = new SseConnection(opts.baseUrl, opts.clientId, res.body);
		conn.signal.addEventListener("abort", () => controller.abort());
		return conn;
	},
};
