import { SSE_RING_BYTES } from "./protocol";

/**
 * Shared SSE helpers for the OMP_PROTO 2 transport (POST /command up,
 * GET /events down). Used by the daemon (server/index.ts), the fleet
 * connector and edge, and the test fakes. The browser uses native
 * EventSource instead (it cannot set headers, and loopback is exempt).
 *
 * Wire shape (see protocol.ts):
 *
 *   event: frame
 *   id: <seq>
 *   data: <JSON ServerFrame>
 *
 * Keepalive is a named `ping` event (NO id field — it must not advance the
 * consumer's lastEventId/resume counter) written every SSE_KEEPALIVE_MS.
 * A named event instead of the idiomatic `: ping` comment because native
 * EventSource (the browser consumer) drops comments without surfacing them,
 * and the browser needs observable liveness for its silence deadline.
 * parseSseUnits still surfaces comments for spec completeness.
 */

/** One parsed unit from an SSE stream: either an event or a comment. */
export type SseUnit =
	| { kind: "event"; event: string; id: string | undefined; data: string }
	| { kind: "comment"; text: string };

/** Keepalive event name; servers emit SSE_PING_BLOCK every SSE_KEEPALIVE_MS. */
export const SSE_PING_EVENT = "ping";
/** The keepalive block: named event, empty-object data, deliberately no id. */
export const SSE_PING_BLOCK = "event: ping\ndata: {}\n\n";

/** Encode one payload (a ServerFrame) as a complete SSE event block. */
export function encodeSseEvent(eventName: string, payload: unknown, seq: number): string {
	return `event: ${eventName}\nid: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Async-iterate SSE units from a fetch Response body. Handles partial chunk
 * boundaries, CRLF, and multi-line data (joined with "\n" per the SSE spec).
 * Comment lines yield `{ kind: "comment" }` so callers can feed a silence
 * deadline. Ends when the body ends; throws if the reader errors.
 */
export async function* parseSseUnits(body: ReadableStream<Uint8Array>): AsyncGenerator<SseUnit> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let id: string | undefined;
	let dataLines: string[] = [];
	const dispatch = (): SseUnit | null => {
		if (dataLines.length === 0 && event === "") return null;
		const unit: SseUnit = { kind: "event", event, id, data: dataLines.join("\n") };
		event = "";
		id = undefined;
		dataLines = [];
		return unit;
	};
	const processLine = (raw: string): SseUnit | null => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") return dispatch();
		if (line.startsWith(":")) return { kind: "comment", text: line.slice(1).trimStart() };
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") dataLines.push(value);
		return null;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const unit = processLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (unit) yield unit;
			}
		}
		buffer += decoder.decode();
		if (buffer !== "") {
			const unit = processLine(buffer);
			if (unit) yield unit;
		}
		const tail = dispatch();
		if (tail) yield tail;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Bounded replay ring of recent deltas. The server stamps each delta with a
 * monotonic seq (≥ SSE_DELTA_SEQ_START) and keeps the last `cap` entries so a
 * reconnecting consumer can resume from its Last-Event-ID.
 *
 * Bounds are byte-first, entry-count second: `maxBytes` (default
 * SSE_RING_BYTES) evicts from the head so a few multi-megabyte deltas cannot
 * balloon memory even far below `cap` (finding #5); the entry cap remains as
 * a secondary bound for many-small-delta bursts. Sizes are the stored
 * values' string lengths in UTF-16 code units — the same proxy the daemon's
 * chunkHistory uses for HISTORY_CHUNK_BYTES. For ASCII-heavy payloads
 * (base64 image blocks — the unbounded-memory culprit) that overestimates
 * UTF-8 wire bytes ~2×, the conservative direction; a single entry larger
 * than the whole budget still lands (the newest delta is the one a resuming
 * consumer needs most, and `cap` still bounds the count). Eviction is from
 * the head only, so `after()` stays correct: a resumed consumer simply sees
 * older entries missing, which callers treat as re-derivable (drop-and-
 * resume), never as a corrupted tail.
 */
export class SseRing<T = unknown> {
	readonly #cap: number;
	readonly #maxBytes: number;
	#entries: Array<{ seq: number; value: T; bytes: number }> = [];
	#bytes = 0;

	constructor(cap: number, maxBytes?: number) {
		this.#cap = cap;
		this.#maxBytes = maxBytes ?? SSE_RING_BYTES;
	}

	get size(): number {
		return this.#entries.length;
	}

	/** Total byte estimate of the ringed values (string lengths; 0 for non-strings). */
	get bytes(): number {
		return this.#bytes;
	}

	push(seq: number, value: T): void {
		const bytes = typeof value === "string" ? value.length : 0;
		this.#entries.push({ seq, value, bytes });
		this.#bytes += bytes;
		// Byte budget first: evict from the head while over budget. The
		// newest entry is never evicted (a single frame larger than the whole
		// budget still lands); `drop` counts from the head so one splice does
		// all the work.
		let drop = 0;
		while (drop < this.#entries.length - 1 && this.#bytes > this.#maxBytes) {
			this.#bytes -= this.#entries[drop].bytes;
			drop++;
		}
		// Entry cap second (secondary bound for many-small-delta bursts).
		if (this.#entries.length - drop > this.#cap) {
			const capDrop = this.#entries.length - drop - this.#cap;
			for (let i = 0; i < capDrop; i++) this.#bytes -= this.#entries[drop + i].bytes;
			drop += capDrop;
		}
		if (drop > 0) this.#entries.splice(0, drop);
	}

	/** Entries with seq > `after`, oldest first. */
	after(after: number): Array<{ seq: number; value: T }> {
		let lo = 0;
		let hi = this.#entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#entries[mid].seq <= after) lo = mid + 1;
			else hi = mid;
		}
		return this.#entries.slice(lo);
	}
}
