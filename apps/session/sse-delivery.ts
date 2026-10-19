import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
import {
	SSE_BACKPRESSURE_BYTES,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_KEEPALIVE_MS,
	SSE_RING_CAP,
	SSE_RING_BYTES,
	type ServerFrame,
	type SessionScopedFrame,
	type WireSessionEvent,
} from "#lib/wire/protocol";
import { encodeSseEvent, SSE_PING_BLOCK, SseRing } from "#lib/wire/sse";
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
 * Pending login code inputs, keyed per connection. `owner` is the session
 * handle whose login opened the prompt; `streams` are the dispatch-time /events
 * consumers, empty when the browser rides the callback pair. Rejected on login
 * settle, on every owning stream closing, on the owning session's close, and on shutdown.
 */
export const pendingCodeInputs = new Map<
	string,
	{
		owner: string;
		streams: Set<SseConsumer>;
		resolve: (code: string) => void;
		reject: (err: Error) => void;
	}
>();

/** Reject and drop every pending code input the session `owner` opened (session close). */
export function rejectOwnedCodeInputs(owner: string, reason: string): void {
	for (const [id, p] of pendingCodeInputs) {
		if (p.owner !== owner) continue;
		p.reject(new Error(reason));
		pendingCodeInputs.delete(id);
	}
}

const ring = new SseRing<string>(SSE_RING_CAP, SSE_RING_BYTES);
let nextDeltaSeq = SSE_DELTA_SEQ_START;
const sseEncoder = new TextEncoder();

/**
 * Byte budget per `history` frame (mirrors collab-host's SNAPSHOT_CHUNK_BYTES),
 * in UTF-8 bytes. Each chunk stays well under SSE_BACKPRESSURE_BYTES so priming
 * of a >4 MiB transcript (base64 image payloads inside messages) never trips
 * the stream's drop-and-resume termination; a terminated prime is a permanent
 * connect → terminate → reconnect loop, since priming is never ringed.
 */
const HISTORY_CHUNK_BYTES = 512 * 1024;
/**
 * Room a callback envelope needs around one history frame: the envelope's
 * identity/seq fields plus the frame's own `type`/`final` keys.
 */
const HISTORY_ENVELOPE_HEADROOM_BYTES = 64 * 1024;
/**
 * Per-message ceiling for the history degrade pipeline, in UTF-8 bytes. A
 * message at or under this ceiling ships verbatim even when it exceeds the
 * frame batch target above: it takes a paced frame of its own. The ceiling
 * keeps that frame inside one callback envelope (ENVELOPE_MAX_BYTES), since
 * browser streams ride the callback pair and an oversized envelope is
 * rejected, never delivered. Only a message over the ceiling degrades: image
 * blocks first, then progressive clipping, and only until it is back under
 * the ceiling. Without this split, every large message would be clipped to
 * the first shrink pass and a transcript of large-but-legal messages would
 * collapse into one small frame.
 */
const MESSAGE_REPLICATION_CEILING_BYTES = ENVELOPE_MAX_BYTES - HISTORY_ENVELOPE_HEADROOM_BYTES;
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
	command_echo: true,
	settings_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	// #18: subagent_event is NOT ringed; the subagent mirror broadcasts only
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

/** True when `type` names a ringed delta frame (the callback virtual-stream
 *  replay ring mirrors the direct SSE ring semantics exactly). */
export function isRingedDeltaType(type: string): boolean {
	return RING_DELTAS[type] === true;
}

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
 * controller.error() (scratch-verified, since an errored body stream reads
 * as a clean EOF to fetch clients), so the wire cannot carry the
 * distinction. The `stream_reset` frame enqueued ahead of the close tells
 * direct /events clients to drop and resume (the browser ignores it and
 * native-reconnects). Termination that is genuinely terminal (shutdown, which
 * detaches without closing) keeps the bare clean-close semantics, which
 * clients read as a dormant close.
 */
export function terminateStream(stream: SseConsumer, reason: string): void {
	if (reason === "backpressure") {
		try {
			// The frame takes a fresh delta-range seq so the consumer's
			// Last-Event-ID advances past the buffered overflow (read in order
			// before EOF); it is never ringed, so only the dying stream sees it.
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
 * priming MUST complete. A terminated prime is a permanent
 * connect → terminate → reconnect loop for transcripts over the cap, so this
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
 * Return a copy of `message` with image content blocks dropped. The collab
 * welcome degrades oversized entries the same way (stripImagesFromMessage),
 * but that helper mutates in place, and the session's live transcript must
 * stay untouched: only the wire copy is stripped.
 */
function messageWithoutImages(message: AgentMessage): AgentMessage {
	// Some AgentMessage members (bash/python execution messages) carry no
	// content array, so they cannot hold image blocks and pass through.
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
 * Tightening passes for {@link shrinkMessageFrame}: each clamps every string
 * and array to a smaller budget, and the first pass whose output fits
 * {@link MESSAGE_REPLICATION_CEILING_BYTES} wins. The cadence mirrors the
 * collab replication shrink 17.1.8 applied here, kept local because 18.1.9
 * dropped that generic helper (session entries and agent events now own their
 * own bounds) and SSE history frames are omp-web's own wire.
 */
const MESSAGE_SHRINK_PASSES: ReadonlyArray<{ stringCap: number; arrayLimit: number }> = [
	{ stringCap: 64 * 1024, arrayLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64 },
	{ stringCap: 1 * 1024, arrayLimit: 32 },
	{ stringCap: 256, arrayLimit: 16 },
	{ stringCap: 64, arrayLimit: 1 },
];

const ELISION_RESERVE = 80;

/**
 * Deep-copy `value`, head-truncating strings longer than `stringCap` and
 * head-clipping arrays longer than `arrayLimit`, with elision markers the
 * client renders verbatim. Only string leaves and array tails change, so the
 * copy stays parseable as the AgentMessage it came from.
 */
function shrinkWalk(value: unknown, stringCap: number, arrayLimit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= stringCap) return value;
		const head = Math.max(0, stringCap - ELISION_RESERVE);
		return `${value.slice(0, head)}\n…[${value.length - head} chars elided for history frame]`;
	}
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, arrayLimit);
		const out: unknown[] = [];
		for (let i = 0; i < keep; i++) out.push(shrinkWalk(value[i], stringCap, arrayLimit));
		if (value.length > keep) out.push(`…[${value.length - keep} items elided for history frame]`);
		return out;
	}
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key in source) out[key] = shrinkWalk(source[key], stringCap, arrayLimit);
		return out;
	}
	return value;
}

/**
 * Bound one history message under {@link MESSAGE_REPLICATION_CEILING_BYTES},
 * preserving its shape. Returns the last pass's output when even the tightest
 * budget does not fit, mirroring the pre-18.1.9 helper: the frame still ships,
 * because a dropped message silently truncates the client's transcript.
 */
function shrinkMessageFrame(message: AgentMessage): AgentMessage {
	let shrunk: unknown = message;
	for (const pass of MESSAGE_SHRINK_PASSES) {
		shrunk = shrinkWalk(message, pass.stringCap, pass.arrayLimit);
		if (utf8Bytes(JSON.stringify(shrunk)) <= MESSAGE_REPLICATION_CEILING_BYTES) break;
	}
	return shrunk as AgentMessage;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export type HistoryFrame = Extract<SessionScopedFrame, { type: "history" }>;

/**
 * Slice `messages` into byte-bounded `history` frames (mirrors collab-host's
 * #sendSnapshotChunks). A transcript whose single frame fits one chunk keeps
 * the original shape, one frame with no `final` field (back-compatible with
 * pre-chunking clients); a larger transcript ships as sequential frames the
 * client accumulates until the `final: true` chunk. A single message over the
 * {@link MESSAGE_REPLICATION_CEILING_BYTES} degrades in place of shipping an
 * oversized frame: image blocks are stripped, then long strings and array
 * tails are clipped, so the stream survives regardless. A message between the
 * frame budget and that ceiling stays verbatim in a paced frame of its own.
 */
export function historyFrames(messages: AgentMessage[]): HistoryFrame[] {
	const whole = JSON.stringify({ type: "history", messages });
	if (utf8Bytes(whole) <= HISTORY_CHUNK_BYTES) return [{ type: "history", messages }];
	const frames: HistoryFrame[] = [];
	let batch: AgentMessage[] = [];
	let batchBytes = 0;
	const flush = (final: boolean): void => {
		frames.push({ type: "history", messages: batch, final });
		batch = [];
		batchBytes = 0;
	};
	for (const message of messages) {
		let wire: AgentMessage = message;
		let bytes = utf8Bytes(JSON.stringify(wire));
		if (bytes > MESSAGE_REPLICATION_CEILING_BYTES) {
			wire = messageWithoutImages(wire);
			bytes = utf8Bytes(JSON.stringify(wire));
			if (bytes > MESSAGE_REPLICATION_CEILING_BYTES) {
				wire = shrinkMessageFrame(wire);
				bytes = utf8Bytes(JSON.stringify(wire));
			}
		}
		// +1: the array separator each message adds to the frame.
		if (batch.length > 0 && batchBytes + bytes + 1 > HISTORY_CHUNK_BYTES) flush(false);
		batch.push(wire);
		batchBytes += bytes + 1;
	}
	if (batch.length > 0) flush(true);
	else frames[frames.length - 1].final = true;
	return frames;
}

/** Global frames (error, daemons roster, ready): ringed deltas to every stream. */
export function broadcast(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
	ring.push(seq, block);
	for (const stream of streams) enqueueTo(stream, block);
	tapFrame(frame);
}

/**
 * Unicast answers (call_result, sessions, files, login_url, …) go to every
 * live stream of this single-session daemon; the SSE stream is the one answer
 * channel. NOT ringed; a lost answer is re-POSTed by the client.
 */
export function broadcastAnswer(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
	for (const stream of streams) enqueueTo(stream, block);
	tapFrame(frame);
}

/**
 * The in-progress assistant message per session. Deltas carry no snapshot, so a
 * late joiner is primed with this one message, not one copy per token.
 */
const streamingAssistant = new WeakMap<SessionEntry, AssistantMessage>();

/** Track the in-progress assistant message from the raw SDK events (before slimming). */
export function trackStreamingAssistant(entry: SessionEntry, event: AgentSessionEvent): void {
	if (event.type === "message_start" || event.type === "message_update") {
		if (event.message.role === "assistant") streamingAssistant.set(entry, event.message);
	} else if (event.type === "message_end" || event.type === "agent_end") {
		streamingAssistant.delete(entry);
	}
}

/** Priming for a late joiner: the in-progress assistant message, when one is streaming. */
export function streamingPrimeFrames(
	entry: SessionEntry,
): Array<{ type: "event"; event: WireSessionEvent }> {
	const message = streamingAssistant.get(entry);
	return message === undefined
		? []
		: [{ type: "event", event: { type: "message_start", message } }];
}

/**
 * SDK session event to its wire form. The SDK's `message_update` carries the
 * cumulative assistant message twice (`message` and `assistantMessageEvent.partial`),
 * so shipping it verbatim costs O(n^2) bytes per reply across the SSE ring, the
 * control mirror and every browser stream. On the wire it is a delta keyed by
 * content block (see WireAssistantMessageEvent); the full message goes out once,
 * on `message_end`. Every other event is forwarded untouched.
 */
export function toWireEvent(event: AgentSessionEvent): WireSessionEvent {
	if (event.type !== "message_update") return event;
	const sub = event.assistantMessageEvent;
	if (sub.type === "text_delta" || sub.type === "thinking_delta") {
		return {
			type: "message_update",
			assistantMessageEvent: { type: sub.type, contentIndex: sub.contentIndex, delta: sub.delta },
		};
	}
	if (sub.type === "start" || sub.type === "done" || sub.type === "error") {
		return { type: "message_update", assistantMessageEvent: { type: sub.type } };
	}
	return {
		type: "message_update",
		assistantMessageEvent: { type: sub.type, contentIndex: sub.contentIndex },
	};
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
	tapFrame(frame);
}

/**
 * History resync after a transcript-replacing call (newSession/switchSession/
 * branch/fork/handoff): chunked + paced exactly like priming, because a
 * replaced transcript can also exceed the 4 MiB cap. A single-frame
 * broadcast would terminate every attached stream (the same permanent-reconnect
 * bug as priming). History is not ringed; a reconnect re-primes instead.
 * Callback-pair browser streams get the same frames through the history tap;
 * the frame tap is not used because it also feeds the fleet's control mirror,
 * which has no use for a transcript.
 */
export async function broadcastHistory(handle: string, frames: HistoryFrame[]): Promise<void> {
	for (const stream of streams) {
		if (stream.attached !== handle) continue;
		for (const frame of frames) {
			await enqueuePaced(stream, encodeSseEvent(SSE_EVENT_NAME, frame, nextDeltaSeq++));
		}
	}
	if (onHistoryTap !== null) await onHistoryTap(frames);
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

/**
 * Surface operator-facing text as the existing notice event frame. While a
 * slash command runs, its replies carry the command as `command` (CMD-09).
 */
export function notifyEvent(
	entry: SessionEntry,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	const command = entry.activeCommand;
	broadcastTo(entry.handle, {
		type: "event",
		event: { type: "notice", level, message, ...(command ? { command } : {}) },
	});
}

// Phase 11: AbortControllers for in-flight runEphemeralTurn calls, keyed by
// (session, streamId). abortEphemeral cancels via the SDK signal; it is the
// same side-channel pattern bash/python use, but those have dedicated SDK aborters.
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

// Keepalive: a named ping event block (SSE_PING_BLOCK, deliberately no id
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

// Callback mirror tap (P3.4): registered by apps/session/index.ts when a callback
// pair exists. Every broadcastTo/broadcastAnswer/broadcast frame is handed to
// the tap VERBATIM (payload only; seq/stream stamping is the transport's),
// so the fleet derives activity + fanout correlation exactly like the direct
// control-socket tap. The tap never throws into the delivery path.
let onFrameTap: ((frame: ServerFrame | SessionScopedFrame) => void) | null = null;
export function setOnFrameTap(
	fn: ((frame: ServerFrame | SessionScopedFrame) => void) | null,
): void {
	onFrameTap = fn;
}
function tapFrame(frame: ServerFrame | SessionScopedFrame): void {
	if (onFrameTap === null) return;
	try {
		onFrameTap(frame);
	} catch {
		// Listener failures never break delivery.
	}
}

// Callback history tap: registered by apps/session/index.ts when a callback
// pair exists. broadcastHistory hands it the resync frames for the pair's
// browser streams (paced there against the pair's outbound buffer).
let onHistoryTap: ((frames: HistoryFrame[]) => Promise<void>) | null = null;
export function setOnHistoryTap(fn: ((frames: HistoryFrame[]) => Promise<void>) | null): void {
	onHistoryTap = fn;
}

/** Snapshot the delta high-water mark BEFORE priming (the replay floor). */
export function snapshotDeltaSeq(): number {
	return nextDeltaSeq;
}

/** Ring entries with seq > `from`, oldest first (priming replay). */
export function ringAfter(from: number): Array<{ seq: number; value: string }> {
	return ring.after(from);
}
