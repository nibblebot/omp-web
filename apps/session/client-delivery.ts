import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { ServerWebSocket } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { browserCloseFor, pingMessage, seqFrameMessage } from "#lib/wire/browser-socket";
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
import {
	type AvailableSlashCommand,
	type ImageArg,
	CLIENT_BACKPRESSURE_BYTES,
	CLIENT_STALL_MS,
	DELTA_SEQ_START,
	CLIENT_KEEPALIVE_MS,
	CLIENT_RING_CAP,
	CLIENT_RING_BYTES,
	type ServerFrame,
	type SessionScopedFrame,
	type WireSessionEvent,
	type WireToolLive,
} from "#lib/wire/protocol";
import { ReplayRing } from "#lib/wire/replay-ring";
import { sameToolLive, toolLiveOf } from "#lib/wire/tool-live";
import { extractText, scanImages } from "#lib/wire/tool-result";
import type { SessionEntry } from "./session-entry";

// ---------------------------------------------------------------------------
// Browser-socket delivery. Live deltas carry daemon-global seqs
// (≥ DELTA_SEQ_START) and are kept in a bounded ring so a reconnecting
// socket can resume from its `after` seq. Priming frames and unicast
// answers are NOT ringed: priming is always re-derived fresh on open, and a
// lost answer is recovered by re-sending the command (deduped by id).
// ---------------------------------------------------------------------------

/** Per-socket state of a direct client (`ws.data` of a `GET /ws` upgrade). */
export interface ClientSocketData {
	/** The registered consumer once `open` ran; null until then and for a refused dial. */
	consumer: ClientConsumer | null;
	/** Typed refusal decided at upgrade (a browser cannot read a non-101 status): `open` closes with it. */
	refusal: { code: number; reason: string } | null;
	/** Resume point from the dial (`after`), null = fresh priming. */
	after: number | null;
	/** Slash commands built before the upgrade so priming seqs stay contiguous (null = none built). */
	commands: AvailableSlashCommand[] | null;
}

/**
 * One live GET /ws consumer (agent-driving transport). Each consumer is a
 * connection: it primes on open (hello_ok → attached → …), then receives live
 * deltas (daemon-global seqs ≥ DELTA_SEQ_START) and unicast answers. It is
 * also the per-connection key for pending code inputs and UI requests.
 */
export interface ClientConsumer {
	/** Stable identity; keys pending code inputs and ui_request targets. */
	id: number;
	ws: ServerWebSocket<ClientSocketData>;
	/** Attached session handle ("s1"); consumers attach at open. */
	attached: string | null;
	/** Epoch ms of the last message sent; drives the idle keepalive. */
	lastSendAt: number;
	/** Resolves the priming wait in sendPaced; set only while that wait is parked. */
	drainWaiter?: () => void;
	/** Stall clock: the smallest buffered amount seen and since when; cleared by a drain. */
	stall?: { since: number; buffered: number };
}

/** Every live browser socket. The daemon boot (index.ts) adds/removes consumers and reads the size. */
export const streams = new Set<ClientConsumer>();

/**
 * Pending login code inputs, keyed per connection. `owner` is the session
 * handle whose login opened the prompt; `streams` are the dispatch-time /ws
 * consumers, empty when the browser rides the callback pair. Rejected on login
 * settle, on every owning stream closing, on the owning session's close, and on shutdown.
 */
export const pendingCodeInputs = new Map<
	string,
	{
		owner: string;
		streams: Set<ClientConsumer>;
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

const ring = new ReplayRing<string>(CLIENT_RING_CAP, CLIENT_RING_BYTES);
let nextDeltaSeq = DELTA_SEQ_START;
/** The socket whose command is being dispatched (see answeringTo); unset for the callback pair's dispatch. */
const answerOrigin = new AsyncLocalStorage<ClientConsumer>();

/**
 * Byte budget per `history` frame (mirrors collab-host's SNAPSHOT_CHUNK_BYTES),
 * in UTF-8 bytes. Each chunk stays well under CLIENT_BACKPRESSURE_BYTES so priming
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
 * delta (which still use the terminating sendTo) must not close the socket.
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
	skills_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	ui_request: true,
	// Finding #16: a settled dialog must invalidate the ringed ui_request it
	// answers, so a resume replays request → end (dismissed), never a stale
	// dialog whose ui_response would silently no-op.
	ui_request_end: true,
	collab_status: true,
	// Absolute snapshot of the running jobs' widget glances: a resumed or late client gets the latest one.
	job_widgets: true,
	ready: true,
	daemons: true,
	error: true,
};

/** True when `type` names a ringed delta frame (the callback virtual-stream
 *  replay ring mirrors the direct /ws ring semantics exactly). */
export function isRingedDeltaType(type: string): boolean {
	return RING_DELTAS[type] === true;
}

/** Bytes the socket holds unsent (0 for a consumer whose socket is gone). */
function bufferedBytes(consumer: ClientConsumer): number {
	try {
		return consumer.ws.getBufferedAmount();
	} catch {
		return 0;
	}
}

/**
 * Send one pre-built message; past the backpressure cap, or when the socket
 * dropped it, the socket is closed 4503 (drop-and-resume). A socket that is
 * no longer open is skipped (its removal happens on close).
 */
export function sendTo(consumer: ClientConsumer, message: string): void {
	try {
		const { ws } = consumer;
		if (ws.readyState !== 1) return;
		if (ws.getBufferedAmount() > CLIENT_BACKPRESSURE_BYTES || ws.send(message) === 0) {
			terminateConsumer(consumer, "backpressure");
			return;
		}
		consumer.lastSendAt = Date.now();
	} catch {
		// Socket already closed: dropped (removal happens on close/terminate).
	}
}

/**
 * Close a socket 4503 slow_consumer (buffered data is still delivered; the
 * client resumes with `after`). The typed close code carries the drop
 * distinction an in-band stream_reset frame would otherwise have to signal.
 */
export function terminateConsumer(consumer: ClientConsumer, reason: string): void {
	const { code, reason: text } = browserCloseFor("slow_consumer", reason);
	try {
		consumer.ws.close(code, text);
	} catch {
		// Already closed; detach below still cleans up.
	}
	detachConsumer(consumer, reason);
}

/**
 * Send one priming message, pacing to the socket's drain so the 4 MiB cap
 * never trips. Unlike sendTo (deltas: drop-and-resume via the ring),
 * priming MUST complete. A terminated prime is a permanent
 * connect → terminate → reconnect loop for transcripts over the cap, so this
 * waits for room instead of terminating. The wait holds the socket's buffer
 * PRIMING_QUEUE_MARGIN below the cap so a concurrent keepalive ping or small
 * delta never closes a slow reader mid-prime. An empty buffer always admits
 * the message (one message larger than the room would otherwise wait forever).
 * A detached consumer (close, keepalive/delta termination) ends the wait.
 */
export async function sendPaced(consumer: ClientConsumer, message: string): Promise<void> {
	const size = Buffer.byteLength(message, "utf8");
	for (;;) {
		const buffered = bufferedBytes(consumer);
		if (buffered === 0 || buffered + size <= CLIENT_BACKPRESSURE_BYTES - PRIMING_QUEUE_MARGIN)
			break;
		if (!streams.has(consumer)) return; // consumer detached/closed
		await new Promise<void>((resolve) => {
			consumer.drainWaiter = resolve;
		});
	}
	sendTo(consumer, message);
}

/**
 * Resume a priming wait parked in sendPaced. Called from the socket's drain
 * (the buffer emptied, so there is room, and the stall clock restarts) and from
 * detachConsumer (so a parked wait ends). A no-op when nothing is parked.
 */
export function wakeDrainWaiter(consumer: ClientConsumer): void {
	consumer.stall = undefined;
	const resolve = consumer.drainWaiter;
	if (resolve === undefined) return;
	consumer.drainWaiter = undefined;
	resolve();
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
 * own bounds) and history frames are omp-web's own wire.
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

/** Global frames (error, daemons roster, ready): ringed deltas to every socket. */
export function broadcast(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const message = seqFrameMessage(seq, JSON.stringify(frame));
	ring.push(seq, message);
	for (const consumer of streams) sendTo(consumer, message);
	tapFrame(frame);
}

/**
 * Run `fn` as the dispatch of one command from `consumer`: every answer it
 * produces (directly or from its async continuations) goes to that socket
 * only. Answers are routed by the AsyncLocalStorage context so deep emitters
 * (login, files, sessions) need no origin parameter; a dispatch with no
 * origin (the callback pair's, whose answers ride the frame tap) keeps the
 * all-sockets behavior.
 */
export function answeringTo<T>(consumer: ClientConsumer, fn: () => T): T {
	return answerOrigin.run(consumer, fn);
}

/**
 * Unicast answers (call_result, sessions, files, login_url, …) go only to the
 * socket whose command produced them (see answeringTo); with no originating
 * socket they go to every live socket. Sequenced but NOT ringed; a lost
 * answer is recovered by re-sending the command (deduped by id, the recorded
 * answer replays to the re-sending socket). The frame tap still sees every
 * answer, for the callback pair.
 */
export function broadcastAnswer(frame: ServerFrame): void {
	const seq = nextDeltaSeq++;
	const message = seqFrameMessage(seq, JSON.stringify(frame));
	const origin = answerOrigin.getStore();
	if (origin !== undefined) sendTo(origin, message);
	else for (const consumer of streams) sendTo(consumer, message);
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

/** What a running tool call's card shows on the browsers, as last sent on the wire. */
interface ToolProgress {
	toolName: string;
	output: string;
	/** Last non-empty image set sent: a partial without images never clears the card's. */
	images: ImageArg[];
	/** A history resync rebuilt the cards without their output: the next update is a full snapshot. */
	resync: boolean;
	/** Last live status sent (eval status events, wait job tiles); a partial without one keeps it. */
	live: WireToolLive | undefined;
}

/** Running tool calls per session handle, keyed by toolCallId; cleared at tool end and agent end. */
const runningTools = new Map<string, Map<string, ToolProgress>>();

/** Priming for a late joiner: the in-progress assistant message and every running tool's output so far. */
export function streamingPrimeFrames(
	entry: SessionEntry,
): Array<{ type: "event"; event: WireSessionEvent }> {
	const frames: Array<{ type: "event"; event: WireSessionEvent }> = [];
	const message = streamingAssistant.get(entry);
	if (message !== undefined)
		frames.push({ type: "event", event: { type: "message_start", message } });
	for (const [toolCallId, progress] of runningTools.get(entry.handle) ?? []) {
		if (progress.output === "" && progress.images.length === 0 && progress.live === undefined)
			continue;
		frames.push({
			type: "event",
			event: {
				type: "tool_execution_update",
				toolCallId,
				toolName: progress.toolName,
				output: progress.output,
				...(progress.images.length > 0 ? { images: progress.images } : {}),
				...(progress.live !== undefined ? { live: progress.live } : {}),
			},
		});
	}
	return frames;
}

function sameImages(a: readonly ImageArg[], b: readonly ImageArg[]): boolean {
	return (
		a.length === b.length &&
		a.every((img, i) => img.data === b[i].data && img.mimeType === b[i].mimeType)
	);
}

/**
 * A tool partial as the wire carries it: the text appended since the call's
 * previous update when the output grew, the whole text when it changed any
 * other way, nothing (null) when it changes nothing the card shows. An eval or
 * wait partial's live status (see `toolLiveOf`) rides along when it changed;
 * an update with no other news then carries an empty append.
 */
function toolUpdateFrame(
	handle: string,
	event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
): WireSessionEvent | null {
	let tools = runningTools.get(handle);
	if (tools === undefined) runningTools.set(handle, (tools = new Map()));
	const sent = tools.get(event.toolCallId);
	const output = extractText(event.partialResult);
	const scanned = scanImages(event.partialResult);
	const images =
		scanned.length > 0 && !sameImages(scanned, sent?.images ?? []) ? scanned : undefined;
	const previous = sent?.resync === true ? undefined : (sent?.output ?? "");
	const live = toolLiveOf(event.toolName, event.partialResult?.details);
	const liveChanged =
		live !== undefined && (sent?.resync === true || !sameToolLive(live, sent?.live));
	tools.set(event.toolCallId, {
		toolName: event.toolName,
		output,
		images: images ?? sent?.images ?? [],
		resync: false,
		live: live ?? sent?.live,
	});
	if (output === previous && images === undefined && !liveChanged) return null;
	const liveOnly = output === previous && images === undefined;
	const appended =
		previous !== undefined &&
		previous !== "" &&
		output.length > previous.length &&
		output.startsWith(previous)
			? output.slice(previous.length)
			: undefined;
	return {
		type: "tool_execution_update",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		output: liveOnly ? "" : (appended ?? output),
		...(appended !== undefined || liveOnly ? { append: true as const } : {}),
		...(images !== undefined ? { images } : {}),
		...(liveChanged ? { live } : {}),
	};
}

/**
 * SDK session event to its wire form, or null for an event that carries
 * nothing the consumers read. Every slimming below drops data a consumer
 * already received in another event (or never reads); see the wire types:
 *
 * - `message_update` is a delta keyed by content block (WireAssistantMessageEvent).
 *   The SDK's carries the cumulative assistant message twice (`message` and
 *   `assistantMessageEvent.partial`), O(n^2) bytes per reply across the
 *   ring, the control mirror and every browser stream. The full message goes
 *   out once, on `message_end`.
 * - `tool_execution_update` is the appended output (WireToolExecutionUpdate);
 *   the SDK repeats the whole output and args in each. An eval or wait partial's
 *   `details` never ship whole: only their slim `live` status (lib/wire/tool-live.ts),
 *   and only when it changed.
 * - Tool-result `message_start`/`message_end` are dropped: `tool_execution_end`
 *   carries the same result and no consumer reads the message events.
 * - `turn_end` and `agent_end` lose the messages and tool results they repeat.
 *
 * Every other event is forwarded untouched. Stateful: tool updates are
 * deltas against the call's previous update on this handle.
 */
export function toWireEvent(handle: string, event: AgentSessionEvent): WireSessionEvent | null {
	switch (event.type) {
		case "message_update": {
			const sub = event.assistantMessageEvent;
			if (sub.type === "text_delta" || sub.type === "thinking_delta") {
				return {
					type: "message_update",
					assistantMessageEvent: {
						type: sub.type,
						contentIndex: sub.contentIndex,
						delta: sub.delta,
					},
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
		case "message_start":
		case "message_end":
			return event.message.role === "toolResult" ? null : event;
		case "tool_execution_update":
			return toolUpdateFrame(handle, event);
		case "tool_execution_end":
			runningTools.get(handle)?.delete(event.toolCallId);
			return event;
		case "turn_end":
			return { type: "turn_end" };
		case "agent_end": {
			runningTools.delete(handle);
			const { messages, ...rest } = event;
			const last = messages.findLast((m): m is AssistantMessage => m.role === "assistant");
			return last === undefined
				? rest
				: {
						...rest,
						lastAssistant: {
							stopReason: last.stopReason,
							...(last.errorMessage !== undefined ? { errorMessage: last.errorMessage } : {}),
						},
					};
		}
		default:
			return event;
	}
}

/**
 * Deliver a session-scoped frame to every socket attached to the handle.
 * Delta types get a ring entry (resumable); priming-style frames (history,
 * available_commands) are re-derivable from fresh priming, so live sockets
 * only.
 */
export function broadcastTo(handle: string, frame: SessionScopedFrame): void {
	const seq = nextDeltaSeq++;
	const message = seqFrameMessage(seq, JSON.stringify(frame));
	if (RING_DELTAS[frame.type]) ring.push(seq, message);
	for (const consumer of streams) {
		if (consumer.attached === handle) sendTo(consumer, message);
	}
	tapFrame(frame);
}

/**
 * History resync after a transcript-replacing call (newSession/switchSession/
 * branch/fork/handoff): chunked + paced exactly like priming, because a
 * replaced transcript can also exceed the 4 MiB cap. A single-frame
 * broadcast would close every attached socket 4503 (the same permanent-reconnect
 * bug as priming). History is not ringed; a reconnect re-primes instead.
 * Callback-pair browser streams get the same frames through the history tap;
 * the frame tap is not used because it also feeds the fleet's control mirror,
 * which has no use for a transcript.
 */
export async function broadcastHistory(handle: string, frames: HistoryFrame[]): Promise<void> {
	for (const consumer of streams) {
		if (consumer.attached !== handle) continue;
		for (const frame of frames) {
			await sendPaced(consumer, seqFrameMessage(nextDeltaSeq++, JSON.stringify(frame)));
		}
	}
	if (onHistoryTap !== null) await onHistoryTap(frames);
	// The rebuilt cards of running tools hold no output: their next update must be a snapshot, not an append.
	for (const progress of runningTools.get(handle)?.values() ?? []) progress.resync = true;
}

/**
 * Remove a consumer from every bookkeeping structure (socket close, backpressure
 * termination, or shutdown). Sessions outlive sockets: pending code inputs
 * and UI requests that only this socket could answer are rejected. The
 * socket-owned UI-request rejection runs in the boot-registered
 * onConsumerDetached hook (the requests live on the daemon's session state).
 */
export function detachConsumer(consumer: ClientConsumer, reason: string): void {
	streams.delete(consumer);
	if (streams.size === 0) {
		onStreamsEmpty();
		stopKeepalive();
	}
	consumer.attached = null;
	wakeDrainWaiter(consumer);
	for (const [id, p] of pendingCodeInputs) {
		if (p.streams.delete(consumer) && p.streams.size === 0) {
			p.reject(new Error(reason));
			pendingCodeInputs.delete(id);
		}
	}
	onConsumerDetached(consumer, reason);
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

// Keepalive and stall sweep, every CLIENT_KEEPALIVE_MS while sockets are live.
//
// Keepalive: a `{"ping":ms}` message (pingMessage, deliberately unsequenced,
// so it never advances a client's resume counter) on every open browser
// socket that has been idle for half a CLIENT_KEEPALIVE_MS. A socket therefore
// hears from the daemon at least every 1.5 sweeps (22.5 s), inside
// CLIENT_SILENCE_DEADLINE_MS, the point where clients treat total silence as a
// dead peer and reconnect.
//
// Stall: a socket holding unsent bytes whose buffer has not shrunk for
// `stallMs` is a peer that stopped reading (it still answers Bun's pings, so
// idleTimeout never reaps it): closed 4503 like a cap overflow, so it resumes
// with `after` once it reads again. A drain (or an empty buffer) resets the clock.

/** Timing of the sweep; production passes none, tests shorten it. */
export interface KeepaliveOptions {
	/** Sweep interval (default CLIENT_KEEPALIVE_MS). */
	sweepMs?: number;
	/** Stall limit (default CLIENT_STALL_MS). */
	stallMs?: number;
}

let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

/** One stall check for one socket; closes it 4503 once its buffer sat undrained for `stallMs`. */
function checkStall(consumer: ClientConsumer, now: number, stallMs: number): void {
	const buffered = bufferedBytes(consumer);
	if (buffered === 0) {
		consumer.stall = undefined;
		return;
	}
	const mark = consumer.stall;
	if (mark === undefined || buffered < mark.buffered) {
		consumer.stall = { since: now, buffered };
		return;
	}
	if (now - mark.since >= stallMs) terminateConsumer(consumer, "stalled: no drain");
}

export function startKeepalive(options: KeepaliveOptions = {}): void {
	if (keepaliveTimer) return;
	const stallMs = options.stallMs ?? CLIENT_STALL_MS;
	keepaliveTimer = setInterval(() => {
		const now = Date.now();
		const idleSince = now - CLIENT_KEEPALIVE_MS / 2;
		for (const consumer of streams) {
			if (consumer.lastSendAt <= idleSince) sendTo(consumer, pingMessage(now));
			if (streams.has(consumer)) checkStall(consumer, now, stallMs);
		}
	}, options.sweepMs ?? CLIENT_KEEPALIVE_MS);
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

let onConsumerDetached: (stream: ClientConsumer, reason: string) => void = () => {};
export function setOnConsumerDetached(fn: (stream: ClientConsumer, reason: string) => void): void {
	onConsumerDetached = fn;
}

// Callback mirror tap: registered by apps/session/index.ts when a callback
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
