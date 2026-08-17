import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { shrinkForReplication } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import {
	SSE_BACKPRESSURE_BYTES,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_KEEPALIVE_MS,
	SSE_RING_CAP,
	SSE_RING_BYTES,
	type ServerFrame,
	type SessionScopedFrame,
} from "../shared/protocol";
import { encodeSseEvent, SSE_PING_BLOCK, SseRing } from "../shared/sse";
import type { SessionEntry } from "./session-entry";

// ---------------------------------------------------------------------------
// SSE delivery (OMP_PROTO 2). Live deltas carry daemon-global seqs
// (≥ SSE_DELTA_SEQ_START) and are kept in a bounded ring so a reconnecting
// stream can resume from its Last-Event-ID. Priming frames and unicast
// answers are NOT ringed: priming is always re-derived fresh on open, and a
// lost answer is retried by re-POSTing the command (deduped by id).
// ---------------------------------------------------------------------------

/**
 * One live GET /events consumer (OMP_PROTO 2 transport). Each stream is a
 * connection: it primes on open (hello_ok → attached → …), then receives live
 * deltas (daemon-global seqs ≥ SSE_DELTA_SEQ_START) and unicast answers. It is
 * also the per-connection key for pending code inputs and UI requests.
 * Relay sockets are typed {@link RelaySocketData} and are NEVER added to `streams`.
 */
export interface SseConsumer {
	/** Stable identity; keys pending code inputs and ui_request targets. */
	id: number;
	controller: ReadableStreamDefaultController<Uint8Array>;
	/** Attached session handle ("s1"); streams attach at open. */
	attached: string | null;
	/**
	 * Bytes enqueued while no reader is attached (desiredSize is null then).
	 * Reset once a reader becomes visible and desiredSize reports the truth.
	 */
	unreadEstimate: number;
}

/** Every live /events stream. The daemon boot (index.ts) adds/removes consumers and reads the size. */
export const streams = new Set<SseConsumer>();

/**
 * Pending login code inputs, keyed per connection (the streams live at
 * dispatch time) and rejected on login settle, on every owning stream
 * closing, on the attached session's close, and on shutdown.
 */
export const pendingCodeInputs = new Map<
	string,
	{ streams: Set<SseConsumer>; resolve: (code: string) => void; reject: (err: Error) => void }
>();

const ring = new SseRing<string>(SSE_RING_CAP, SSE_RING_BYTES);
let nextDeltaSeq = SSE_DELTA_SEQ_START;
const sseEncoder = new TextEncoder();

/**
 * Byte budget per `history` frame (mirrors collab-host's SNAPSHOT_CHUNK_BYTES).
 * Each chunk stays well under SSE_BACKPRESSURE_BYTES so priming of a
 * >4 MiB transcript (base64 image payloads inside messages) never trips the
 * stream's drop-and-resume termination — a terminated prime is a permanent
 * connect → terminate → reconnect loop, since priming is never ringed.
 */
const HISTORY_CHUNK_BYTES = 512 * 1024;
/**
 * Headroom the paced priming loop keeps below the hard cap: a slow reader
 * mid-prime hovers near the cap, and a concurrent keepalive ping or small
 * delta (which still use the terminating enqueueTo) must not kill the stream.
 */
const PRIMING_QUEUE_MARGIN = 256 * 1024;

/** Frames that are deltas (ringed + streamed); everything else is priming-only or a unicast answer. */
const RING_DELTAS: Record<string, true> = {
	state: true,
	event: true,
	bash_chunk: true,
	python_chunk: true,
	ephemeral_delta: true,
	settings_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	// #18: subagent_event is NOT ringed — the subagent mirror broadcasts only
	// lifecycle/progress frames (see the mirror comment below); the raw event
	// channel was never relayed, so the frame type never reaches broadcastTo.
	ui_request: true,
	// Finding #16: a settled dialog must invalidate the ringed ui_request it
	// answers, so a resume replays request → end (dismissed), never a stale
	// dialog whose ui_response would silently no-op.
	ui_request_end: true,
	collab_status: true,
	ready: true,
	daemons: true,
	error: true,
};

/** Bytes currently buffered on a stream (the queue is byte-sized via the stream's queuing strategy). */
function bufferedBytes(stream: SseConsumer): number {
	const desired = stream.controller.desiredSize;
	if (desired === null) return stream.unreadEstimate;
	if (stream.unreadEstimate > 0) stream.unreadEstimate = 0;
	return Math.max(0, SSE_BACKPRESSURE_BYTES - desired);
}

/** Enqueue one pre-encoded block; past the backpressure cap the stream is terminated (drop-and-resume). */
export function enqueueTo(stream: SseConsumer, block: string): void {
	try {
		if (bufferedBytes(stream) + block.length > SSE_BACKPRESSURE_BYTES) {
			terminateStream(stream, "backpressure");
			return;
		}
		stream.unreadEstimate += block.length;
		stream.controller.enqueue(sseEncoder.encode(block));
	} catch {
		// Stream already closed/cancelled: dropped (removal happens on cancel/terminate).
	}
}

/**
 * End a stream (buffered data is still delivered; the client resumes via
 * Last-Event-ID). A backpressure drop is signaled IN-BAND: Bun's HTTP layer
 * writes the chunked terminator for both controller.close() and
 * controller.error() (scratch-verified — an errored body stream reads as a
 * clean EOF to fetch clients), so the wire cannot carry the distinction. The
 * `stream_reset` frame enqueued ahead of the close is what the fleet
 * connector maps to "reconnecting" (drop-and-resume); the browser ignores it
 * and native-reconnects. Termination that is genuinely terminal (shutdown —
 * which detaches without closing) keeps the bare clean-close semantics →
 * connector "asleep".
 */
export function terminateStream(stream: SseConsumer, reason: string): void {
	if (reason === "backpressure") {
		try {
			// The frame takes a fresh delta-range seq so the consumer's
			// Last-Event-ID advances past the buffered overflow (read in order
			// before EOF); it is never ringed — only the dying stream sees it.
			stream.controller.enqueue(
				sseEncoder.encode(
					encodeSseEvent(SSE_EVENT_NAME, { type: "stream_reset", reason }, nextDeltaSeq++),
				),
			);
		} catch {
			// Already closed or errored; detach below still cleans up.
		}
	}
	try {
		stream.controller.close();
	} catch {
		// already closed or errored; detach below still cleans up.
	}
	detachConsumer(stream, reason);
}

/**
 * Enqueue one priming block, pacing to the consumer's drain so the 4 MiB cap
 * never trips. Unlike enqueueTo (deltas: drop-and-resume via the ring),
 * priming MUST complete — a terminated prime is a permanent
 * connect → terminate → reconnect loop for transcripts over the cap — so this
 * waits for room instead of terminating. The wait holds the queue
 * PRIMING_QUEUE_MARGIN below the cap so a concurrent keepalive ping or small
 * delta never kills a slow reader mid-prime. A detached consumer (cancel,
 * keepalive/delta termination) ends the wait.
 */
export async function enqueuePaced(stream: SseConsumer, block: string): Promise<void> {
	while (bufferedBytes(stream) + block.length > SSE_BACKPRESSURE_BYTES - PRIMING_QUEUE_MARGIN) {
		if (!streams.has(stream)) return; // consumer detached/cancelled
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	enqueueTo(stream, block);
}

/**
 * Return a copy of `message` with image content blocks dropped (the collab
 * welcome degrades oversized entries the same way — stripImagesFromMessage —
 * but that helper mutates in place, and the session's live transcript must
 * stay untouched: only the wire copy is stripped).
 */
function messageWithoutImages(message: AgentMessage): AgentMessage {
	// Some AgentMessage members (bash/python execution messages) carry no
	// content array — they cannot hold image blocks and pass through.
	if (!("content" in message)) return message;
	const content = message.content;
	if (
		typeof content === "string" ||
		!Array.isArray(content) ||
		content.every((c) => c.type !== "image")
	)
		return message;
	return { ...message, content: content.filter((c) => c.type !== "image") } as AgentMessage;
}

/**
 * Slice `messages` into byte-bounded `history` frames (mirrors collab-host's
 * #sendSnapshotChunks). A transcript whose single frame fits one chunk keeps
 * the original shape — one frame, no `final` field (back-compatible with
 * pre-chunking clients); a larger transcript ships as sequential frames the
 * client accumulates until the `final: true` chunk. A single message bigger
 * than one chunk degrades in place of shipping an oversized frame: image
 * blocks are stripped, then long strings are shrunk like collab replication,
 * so the stream survives regardless.
 */
export function chunkHistory(
	messages: AgentMessage[],
): Array<{ messages: AgentMessage[]; final?: boolean }> {
	const whole = JSON.stringify({ type: "history", messages });
	if (whole.length <= HISTORY_CHUNK_BYTES) return [{ messages }];
	const frames: Array<{ messages: AgentMessage[]; final?: boolean }> = [];
	let batch: AgentMessage[] = [];
	let batchBytes = 0;
	const flush = (final: boolean): void => {
		frames.push({ messages: batch, final });
		batch = [];
		batchBytes = 0;
	};
	for (const message of messages) {
		let wire: AgentMessage = message;
		let bytes = JSON.stringify(wire).length;
		if (bytes > HISTORY_CHUNK_BYTES) {
			wire = messageWithoutImages(wire);
			bytes = JSON.stringify(wire).length;
			if (bytes > HISTORY_CHUNK_BYTES) {
				wire = shrinkForReplication(wire);
				bytes = JSON.stringify(wire).length;
			}
		}
		if (batch.length > 0 && batchBytes + bytes > HISTORY_CHUNK_BYTES) flush(false);
		batch.push(wire);
		batchBytes += bytes;
	}
	if (batch.length > 0) flush(true);
	else frames[frames.length - 1].final = true;
	return frames;
}

/**
 * Deliver `messages` to one stream as history frame(s), each paced under the
 * cap: the single back-compatible frame when the transcript fits one chunk,
 * otherwise sequential byte-bounded frames. Every frame takes a fresh seq
 * from `nextSeq` (priming's per-stream counter or the daemon-global delta
 * counter for live broadcasts).
 */
export async function sendHistoryPaced(
	stream: SseConsumer,
	messages: AgentMessage[],
	nextSeq: () => number,
): Promise<void> {
	for (const frame of chunkHistory(messages)) {
		await enqueuePaced(
			stream,
			encodeSseEvent(SSE_EVENT_NAME, { type: "history", ...frame }, nextSeq()),
		);
	}
}

/** Global frames (error, daemons roster, ready): ringed deltas to every stream. */
export function broadcast(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
	ring.push(seq, block);
	for (const stream of streams) enqueueTo(stream, block);
}

/**
 * Unicast answers (call_result, sessions, files, login_url, …): every live
 * stream of this single-session daemon — the SSE stream is the one answer
 * channel. NOT ringed; a lost answer is re-POSTed by the client.
 */
export function broadcastAnswer(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
	for (const stream of streams) enqueueTo(stream, block);
}

/**
 * Deliver a session-scoped frame to every stream attached to the handle.
 * Delta types get a ring entry (resumable); priming-style frames (history,
 * available_commands) are re-derivable from fresh priming, so live streams
 * only.
 */
export function broadcastTo(handle: string, frame: SessionScopedFrame): void {
	const seq = nextDeltaSeq++;
	const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
	if (RING_DELTAS[frame.type]) ring.push(seq, block);
	for (const stream of streams) {
		if (stream.attached === handle) enqueueTo(stream, block);
	}
}

/**
 * History resync after a transcript-replacing call (newSession/switchSession/
 * branch/fork/handoff): chunked + paced exactly like priming, because a
 * replaced transcript can also exceed the 4 MiB cap — a single-frame
 * broadcast would terminate every attached stream (the same permanent-reconnect
 * bug as priming). History is not ringed; a reconnect re-primes instead.
 */
export async function broadcastHistory(entry: SessionEntry): Promise<void> {
	const frames = chunkHistory(entry.session.messages);
	for (const stream of streams) {
		if (stream.attached !== entry.handle) continue;
		for (const frame of frames) {
			await enqueuePaced(
				stream,
				encodeSseEvent(SSE_EVENT_NAME, { type: "history", ...frame }, nextDeltaSeq++),
			);
		}
	}
}

/**
 * Remove a stream from every bookkeeping structure (stream close, backpressure
 * termination, or shutdown). Sessions outlive streams: pending code inputs
 * and UI requests that only this stream could answer are rejected. The
 * stream-owned UI-request rejection runs in the boot-registered
 * onConsumerDetached hook (the requests live on the daemon's session state).
 */
export function detachConsumer(stream: SseConsumer, reason: string): void {
	streams.delete(stream);
	if (streams.size === 0) {
		onStreamsEmpty();
		stopKeepalive();
	}
	stream.attached = null;
	for (const [id, p] of pendingCodeInputs) {
		if (p.streams.delete(stream) && p.streams.size === 0) {
			p.reject(new Error(reason));
			pendingCodeInputs.delete(id);
		}
	}
	onConsumerDetached(stream, reason);
}

/** Surface operator-facing text as the existing notice event frame. */
export function notifyEvent(
	entry: SessionEntry,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	broadcastTo(entry.handle, { type: "event", event: { type: "notice", level, message } });
}

// Phase 11: AbortControllers for in-flight runEphemeralTurn calls, keyed by
// (session, streamId). abortEphemeral cancels via the SDK signal — the same
// side-channel pattern bash/python use, but those have dedicated SDK aborters.
export const ephemeralAborts = new Map<SessionEntry, Map<number, AbortController>>();

export function setEphemeralAbort(
	entry: SessionEntry,
	streamId: number,
	controller: AbortController,
): void {
	let byStream = ephemeralAborts.get(entry);
	if (!byStream) ephemeralAborts.set(entry, (byStream = new Map()));
	byStream.set(streamId, controller);
}

export function clearEphemeralAbort(entry: SessionEntry, streamId: number): void {
	ephemeralAborts.get(entry)?.delete(streamId);
}

// Keepalive: a named ping event block (SSE_PING_BLOCK — deliberately no id
// field, so it never advances a consumer's resume counter) on every open
// /events stream every SSE_KEEPALIVE_MS; consumers treat >
// SSE_SILENCE_DEADLINE_MS of total silence as a dead peer and reconnect.
// Runs only while streams are live.
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

export function startKeepalive(): void {
	if (keepaliveTimer) return;
	keepaliveTimer = setInterval(() => {
		for (const stream of streams) enqueueTo(stream, SSE_PING_BLOCK);
	}, SSE_KEEPALIVE_MS);
}

export function stopKeepalive(): void {
	if (!keepaliveTimer) return;
	clearInterval(keepaliveTimer);
	keepaliveTimer = undefined;
}

// Daemon-boot wiring (index.ts registers these once): the delivery module
// stays free of daemon-level state (the daemon-roster poll, the attached
// session's pending UI requests) while preserving detach ordering.
let onStreamsEmpty: () => void = () => {};
export function setOnStreamsEmpty(fn: () => void): void {
	onStreamsEmpty = fn;
}

let onConsumerDetached: (stream: SseConsumer, reason: string) => void = () => {};
export function setOnConsumerDetached(fn: (stream: SseConsumer, reason: string) => void): void {
	onConsumerDetached = fn;
}

/** Snapshot the delta high-water mark BEFORE priming (the replay floor). */
export function snapshotDeltaSeq(): number {
	return nextDeltaSeq;
}

/** Ring entries with seq > `from`, oldest first (priming replay). */
export function ringAfter(from: number): Array<{ seq: number; value: string }> {
	return ring.after(from);
}
