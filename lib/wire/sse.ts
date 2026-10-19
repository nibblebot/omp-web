import { SSE_RING_BYTES } from "./protocol";

/**
 * Shared SSE helpers for the agent-driving transport (POST /command up,
 * GET /events down). Used by the daemon (session/), the fleet edge and daemon
 * transport, and the test fakes. The browser uses native EventSource
 * instead (it cannot set headers, and loopback is exempt).
 *
 * Wire shape (see protocol.ts):
 *
 *   event: frame
 *   id: <seq>
 *   data: <JSON ServerFrame>
 *
 * Keepalive is a named `ping` event (NO id field, so it must not advance the
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
	return encodeSseEventData(eventName, JSON.stringify(payload), seq);
}

/**
 * Encode an SSE event block whose data is already serialized JSON. Lets a
 * fan-out serialize a frame once and frame it per consumer (only `id` varies).
 */
export function encodeSseEventData(eventName: string, json: string, seq: number): string {
	return `event: ${eventName}\nid: ${seq}\ndata: ${json}\n\n`;
}

/** Longest SSE line (UTF-16 code units) buffered without a newline before the stream fails. */
export const SSE_MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Async-iterate SSE units from a fetch Response body. Handles partial chunk
 * boundaries, CRLF, and multi-line data (joined with "\n" per the SSE spec).
 * Comment lines yield `{ kind: "comment" }` so callers can feed a silence
 * deadline. Ends when the body ends; throws if the reader errors or a single
 * line exceeds SSE_MAX_LINE_CHARS code units (the stream is not resynchronized).
 * Only the newly arrived text is scanned for line breaks, and a partial line
 * is joined once when it closes, so a long event costs linear time.
 */
export async function* parseSseUnits(body: ReadableStream<Uint8Array>): AsyncGenerator<SseUnit> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	// Pieces of the current partial line, joined once when its newline arrives.
	let partial: string[] = [];
	let partialLength = 0;
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
			const text = decoder.decode(value, { stream: true });
			let start = 0;
			let newline = text.indexOf("\n");
			while (newline !== -1) {
				partial.push(text.slice(start, newline));
				const unit = processLine(partial.join(""));
				partial = [];
				partialLength = 0;
				if (unit) yield unit;
				start = newline + 1;
				newline = text.indexOf("\n", start);
			}
			if (start < text.length) {
				partial.push(text.slice(start));
				partialLength += text.length - start;
				if (partialLength > SSE_MAX_LINE_CHARS) {
					throw new Error(
						`invalid sse stream: line is over ${SSE_MAX_LINE_CHARS} code units without a newline`,
					);
				}
			}
		}
		const rest = decoder.decode();
		if (rest !== "") partial.push(rest);
		const line = partial.join("");
		if (line !== "") {
			const unit = processLine(line);
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
 * values' UTF-8 byte lengths, which is what the budget protects. A single
 * entry larger than the whole budget still lands (the newest delta is the one
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

	/** Total UTF-8 byte size of the ringed string values (0 for non-strings). */
	get bytes(): number {
		return this.#bytes;
	}

	push(seq: number, value: T): void {
		const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
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
