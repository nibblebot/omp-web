/**
 * Shared SSE helpers for the OMP_PROTO 2 transport (POST /command up,
 * GET /events down). Used by the daemon (server/index.ts), the fleet
 * connector and edge, and the test fakes. The browser uses native
 * EventSource instead (it cannot set headers, and loopback is exempt).
 *
 * Wire shape (see src/protocol.ts):
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
export type SseUnit = { kind: "event"; event: string; id: string | undefined; data: string } | { kind: "comment"; text: string };

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
 */
export class SseRing<T = unknown> {
	readonly #cap: number;
	#entries: Array<{ seq: number; value: T }> = [];

	constructor(cap: number) {
		this.#cap = cap;
	}

	get size(): number {
		return this.#entries.length;
	}

	push(seq: number, value: T): void {
		this.#entries.push({ seq, value });
		if (this.#entries.length > this.#cap) this.#entries.splice(0, this.#entries.length - this.#cap);
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
