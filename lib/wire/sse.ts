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
 * consumer's lastEventId/resume counter) written every CLIENT_KEEPALIVE_MS.
 * A named event instead of the idiomatic `: ping` comment because native
 * EventSource (the browser consumer) drops comments without surfacing them,
 * and the browser needs observable liveness for its silence deadline.
 * parseSseUnits still surfaces comments for spec completeness.
 */

/** One parsed unit from an SSE stream: either an event or a comment. */
export type SseUnit =
	| { kind: "event"; event: string; id: string | undefined; data: string }
	| { kind: "comment"; text: string };

/** Keepalive event name; servers emit SSE_PING_BLOCK every CLIENT_KEEPALIVE_MS. */
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
