/**
 * Stream-latency join: fake-model send log x client receive records.
 *
 * ## Wire mapping (how the client derives the join key)
 *
 * The fake model (`./fake-model/server.ts`) writes one NDJSON line per streamed
 * text chunk to its send log: `{ route, req, contentIndex, offset, sendNs }`.
 * A client observing the browser wire (`GET /ws` frames, see `lib/wire/browser-socket.ts`
 * and `toWireEvent` in `apps/session/`) derives the same key from frames
 * it already sees, with no markers in model text:
 *
 * - `route`: the label the scenario passed to the directive builder
 *   (`textTurn({ route, ... })` in `./fake-model/directives.ts`) for the session
 *   it prompted, usually the daemon id. The client knows it because it chose it.
 * - `req`: 0-based ordinal of the assistant message in the session transcript.
 *   The fake model computes it from the request as the number of assistant
 *   messages already in `messages`. The client counts assistant messages the
 *   same way: the assistant messages in the `history` frame it was primed with,
 *   plus one per wire `event` frame `{ type: "message_start", message: { role:
 *   "assistant" } }`, minus one so the first assistant message is 0. A client
 *   that attaches to a fresh session before prompting starts the count at 0.
 *   `message_start` for `role: "user"` / tool results does not count. The
 *   counter belongs to the session, not to a turn: it keeps climbing across
 *   prompts and across tool-call round trips (each tool round is one assistant
 *   message, hence one `req`).
 * - `contentIndex`: `assistantMessageEvent.contentIndex` of the wire frame
 *   `{ type: "event", event: { type: "message_update", assistantMessageEvent: {
 *   type: "text_delta", contentIndex, delta } } }`.
 * - `offset`: cumulative `delta.length` (UTF-16 units; fake text is ASCII) of
 *   the `text_delta` frames for that (req, contentIndex) up to and including
 *   this one. A delta that arrives coalesced from several sent chunks yields an
 *   offset equal to the last chunk's offset, so it still matches that chunk.
 * - `recvNs`: `monotonicNs()` (`./clock.ts`) stamped by the client when the socket
 *   message carrying the frame arrived (before it was parsed). Bun's own `process.hrtime.bigint()` is
 *   relative to process start and must not be used here. The send log uses the
 *   same CLOCK_MONOTONIC reading, so the difference is the end-to-end stream latency
 *   (model write -> session -> fleet -> client). A Chromium client stamps wall
 *   clock (`performance.timeOrigin + performance.now()`) instead; label the
 *   clock source in any output that mixes them.
 *
 * Only the main session's text deltas are joinable. Subagent text is logged by
 * the fake model under `<route>/a<k>` but never reaches the browser wire (the
 * wire carries `subagent_progress` frames, not subagent `message_update`s), and
 * tool-call chunks have no wire delta, so neither is logged for joining nor
 * expected in `recv`. Those lines surface as `sendOnly`.
 */
import { readFileSync } from "node:fs";

/** One text delta observed by the client. */
export interface RecvRecord {
	route: string;
	req: number;
	contentIndex: number;
	offset: number;
	recvNs: bigint;
}

export interface LatencySamples {
	/** `recvNs - sendNs` per matched delta, in `recv` order. Nanoseconds. */
	ns: bigint[];
	/** Received deltas with no send-log line at or before their receive time. */
	unmatched: number;
	/** Send-log lines no received delta matched: coalesced chunks and subagent routes. */
	sendOnly: number;
}

function key(route: string, req: number, contentIndex: number, offset: number): string {
	return `${route}\u0000${req}\u0000${contentIndex}\u0000${offset}`;
}

/** Parse the send log into send times grouped by join key. A retried request repeats keys; all sends are kept. */
function readSendLog(sendLog: string): Map<string, bigint[]> {
	const sends = new Map<string, bigint[]>();
	for (const line of readFileSync(sendLog, "utf8").split("\n")) {
		if (line === "") continue;
		const entry: unknown = JSON.parse(line);
		if (typeof entry !== "object" || entry === null)
			throw new Error(`send log line is not an object: ${line}`);
		const { route, req, contentIndex, offset, sendNs } = entry as Record<string, unknown>;
		if (
			typeof route !== "string" ||
			typeof req !== "number" ||
			typeof contentIndex !== "number" ||
			typeof offset !== "number" ||
			typeof sendNs !== "string"
		) {
			throw new Error(`malformed send log line: ${line}`);
		}
		const k = key(route, req, contentIndex, offset);
		const list = sends.get(k);
		if (list === undefined) sends.set(k, [BigInt(sendNs)]);
		else list.push(BigInt(sendNs));
	}
	return sends;
}

/**
 * Join received deltas to the fake model's send log. A receive record matches
 * the latest send of its key that is not after the receive time; sends consumed
 * this way are not counted as `sendOnly`.
 */
export function joinLatency(sendLog: string, recv: RecvRecord[]): LatencySamples {
	const sends = readSendLog(sendLog);
	const matchedKeys = new Set<string>();
	const ns: bigint[] = [];
	let unmatched = 0;
	for (const record of recv) {
		const k = key(record.route, record.req, record.contentIndex, record.offset);
		const list = sends.get(k);
		let best: bigint | undefined;
		if (list !== undefined) {
			for (const sendNs of list) {
				if (sendNs <= record.recvNs && (best === undefined || sendNs > best)) best = sendNs;
			}
		}
		if (best === undefined) {
			unmatched++;
			continue;
		}
		matchedKeys.add(k);
		ns.push(record.recvNs - best);
	}
	let sendOnly = 0;
	for (const k of sends.keys()) if (!matchedKeys.has(k)) sendOnly++;
	return { ns, unmatched, sendOnly };
}
