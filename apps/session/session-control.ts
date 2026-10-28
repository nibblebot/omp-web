import {
	CALLBACK_BROWSER_STREAM_PREFIX,
	CONNECTION_MAX_BYTES,
	ENVELOPE_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	STREAM_ACK_WINDOW_BYTES,
	STREAM_MAX_BYTES,
	preEncodePayload,
	type PreEncodedPayload,
} from "#lib/wire/callback-protocol";
import type { CallbackEnvelope, CallbackKind } from "#lib/wire/callback-protocol";
import type { StreamResyncControl } from "#lib/wire/callback-protocol";
import { isRingedFrameType } from "#lib/wire/protocol";

/**
 * Session control broker: virtual streams over the callback pair
 * (Transport/Lifecycle 2026-09-06 contracts).
 *
 * The session dials the callback pair; the fleet manages per-browser virtual
 * streams and fleet-to-session controls. This module owns the session half:
 *
 * - Browser streams: per `browser/<connId>` replay ring of emitted frame
 *   envelopes. stream_open (lastSeq = replay floor) replays ring frames with
 *   wire seq > lastSeq (ring HIT, never a re-prime); a floor below the
 *   ring's eviction frontier (ring MISS) flips stream_resync followed
 *   by a full re-prime burst, never a silent partial replay; a caught-up
 *   floor replays nothing and does not re-prime. An outbound buffer drop
 *   also flips stream_resync. stream_close drops the stream. A pair
 *   replacement arrives as a stream_open with no lastSeq (the fleet's re-open
 *   on the new pair): the stream's ring is cleared, the per-connection wire
 *   seq space restarts, and it is re-primed fresh instead of streaming into
 *   the void. A browser stream the fleet does not re-open on the new pair is
 *   an orphan (its stream_close was lost) and is dropped after a grace window
 *   (SXP-02, SXP-03).
 * - Command routing: kind:"command" payloads on a browser/control stream are
 *   dispatched through the mounted handleCommand; answers (call_result/unicast)
 *   flow as frames on the same stream. Re-submitted command ids are deduped by
 *   the session's command handler (index.ts), not by this broker.
 * - Control mirror: the session-scoped frames the direct /ws path
 *   broadcasts are mirrored as kind:"frame" envelopes on streamId "control"
 *   (payload verbatim) while the pair lives, so the fleet derives activity +
 *   fanout correlation exactly like the direct control-socket tap. Streaming
 *   deltas no fleet consumer reads (message_update, tool_execution_update,
 *   bash_chunk, python_chunk) skip the control stream and ride browser streams
 *   only. Each mirrored frame is serialized once and shared by every stream.
 *
 * Controls are not acknowledged on the wire, except that the fleet's stream_ack
 * (see StreamAckControl in callback-protocol.ts) releases credit on a browser
 * stream. An unknown control type is logged to stderr and otherwise ignored.
 */

// ── deps ───────────────────────────────────────────────────────────────────

export interface SessionControlDeps {
	/** Mounted command dispatch; returns the answer payload or undefined. */
	handleCommand: (command: unknown) => Promise<unknown>;
	/**
	 * Async half of a browser-stream prime (anything that must be awaited, such
	 * as building the slash-command list). Resolves to the synchronous half,
	 * which snapshots the session into the full priming frame list (the same
	 * frames the direct /ws prime sends) at the moment it is called.
	 */
	preparePriming: () => Promise<() => Record<string, unknown>[]>;
	/** Send leg to the callback pair (the transport stamps identity/seq). */
	send: (
		streamId: string,
		kind: CallbackKind,
		payload: unknown,
		onEmittedSeq?: (seq: number) => void,
	) => unknown;
	/** Bytes queued on the pair's outbound buffer for one stream and the whole connection. */
	bufferedBytes: (streamId: string) => { stream: number; connection: number };
	/** Subscribe to the pair's outbound drain; returns the unsubscribe. Paced sends wait on it. */
	onDrain: (listener: () => void) => () => void;
	/** Live callback pair present. */
	pairLive: () => boolean;
	/** Fleet ShutdownControl: the caller runs the graceful exit. */
	onShutdown: (reason: string | undefined) => void;
	/**
	 * Notified with the live browser-stream count whenever it changes: after a
	 * NEW `browser/<connId>` stream opens, after `stream_close` removes one, and
	 * from `stop()` (always 0). Ring-hit reopens of an existing stream do not
	 * fire it. Lets the host run work (the daemon roster poll) that must live
	 * exactly as long as callback-pair browsers do, since these virtual streams
	 * never join the local /ws consumer set.
	 */
	onBrowserStreamsChange?: (count: number) => void;
	/**
	 * Grace window after a new callback pair's first envelope before browser
	 * streams the fleet did not re-open on that pair are dropped (SXP-03).
	 * Defaults to two heartbeat intervals: a live pipe's stream_open lands
	 * well inside one.
	 */
	streamConfirmMs?: number;
}

interface RingEntry {
	seq: number;
	kind: CallbackKind;
	/** The payload serialized once; replay re-sends it under a fresh wire seq without re-serializing. */
	encoded: PreEncodedPayload;
	bytes: number;
}

interface BrowserStream {
	streamId: string;
	lastSeq: number;
	/** Slots before `head` are evicted and cleared to `undefined` so their frames can be collected. */
	entries: Array<RingEntry | undefined>;
	head: number;
	bytes: number;
	/**
	 * Ring eviction frontier: the highest wire seq ever dropped from the
	 * ring head. A reconnect floor BELOW this frontier is a ring MISS,
	 * entries the client still needs were evicted, and must full re-prime
	 * (never a silent partial tail). A floor at or above the frontier means
	 * the client consumed every evicted entry. 0 while nothing was evicted.
	 */
	evictedSeq: number;
	/** Bumped by every prime; a paced send from an older prime or resync stops. */
	epoch: number;
	/**
	 * Frames mirrored while the prime is in flight, delivered after it in
	 * order. Non-null from the priming snapshot until the prime finishes, so
	 * frames already reflected in the snapshot are never delivered twice and
	 * later frames never land before the history they extend.
	 */
	deferred: Array<{
		frame: Record<string, unknown>;
		encoded: PreEncodedPayload | undefined;
		bytes: number;
	}> | null;
	deferredBytes: number;
	/**
	 * connectionId of the callback pair that last sent this stream an envelope.
	 * A stream whose pairId is not the live pair was not re-opened by the
	 * fleet on the current pair, so it is an orphan (SXP-03).
	 */
	pairId: string | null;
	/** Paced frames sent on this stream and not yet acknowledged, in wire-seq order (slots before `inflightHead` are consumed). */
	inflight: Array<{ seq: number; bytes: number } | undefined>;
	inflightHead: number;
	inflightBytes: number;
	/** Paced senders asleep on credit or drain; woken by an ack, a re-prime, or the stream ending. */
	roomWaiters: Set<() => void>;
	/**
	 * Set from stream_pause to stream_resume: the fleet parked this stream (its
	 * browser dropped). Nothing is sent meanwhile; the ringed deltas that follow
	 * are held here in order. `dirty`: a replay cannot restore the stream (a hold
	 * past the ring budget, or a priming/history frame passed), so resume re-primes.
	 */
	paused: { frames: HeldFrame[]; bytes: number; dirty: boolean } | null;
}

interface HeldFrame {
	frame: Record<string, unknown>;
	encoded: PreEncodedPayload | undefined;
}

export interface SessionControlStatus {
	streams: Array<{ streamId: string; lastSeq: number; ringEntries: number; ringBytes: number }>;
}

/** Per-browser replay ring: 10k entries / 4 MiB, byte-first eviction. */
const RING_CAP = 10_000;
const RING_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Paced sends (priming, history resync) wait until the pair's outbound buffer
 * can take one maximal envelope plus this margin, so concurrent live frames
 * still fit and a large transcript never trips the buffer's drop.
 */
const PACE_MARGIN_BYTES = 256 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize a payload once, or undefined when it cannot be serialized: the
 * transport then sees the raw value and rejects it with its usual error, and
 * the mirror tap never throws into delivery.
 */
function tryEncode(payload: unknown): PreEncodedPayload | undefined {
	try {
		return preEncodePayload(payload);
	} catch {
		return undefined;
	}
}

/**
 * Frames the control mirror does not carry (browser streams still do). The
 * fleet reads the control stream for exactly: `state` (activity: isStreaming and
 * pendingUiRequestIds, the authoritative open-dialog set; lastSessionFile),
 * `daemons`, `ui_request`/`ui_request_end` (blocked deltas between states), and prompt-fanout
 * correlation (`call_result`, `error`, and `event` message_end/agent_end/abort),
 * plus `event` agent_start (activity: turn start, which publishes no state).
 * Streaming deltas carry nothing any of them reads, and dominate the bytes; the
 * jobs' widget snapshots (`job_widgets`, up to one a second) are for browsers alone.
 */
function isUnmirroredToControl(frame: Record<string, unknown>): boolean {
	switch (frame.type) {
		case "bash_chunk":
		case "python_chunk":
		case "job_widgets":
			return true;
		case "event": {
			const event = frame.event;
			if (!isObject(event)) return false;
			return event.type === "message_update" || event.type === "tool_execution_update";
		}
		default:
			return false;
	}
}

export function createSessionControl(deps: SessionControlDeps): SessionControl {
	const streams = new Map<string, BrowserStream>();
	let stopped = false;
	/** connectionId of the callback pair the fleet is currently driving. */
	let livePairId: string | null = null;
	let orphanSweep: Timer | undefined;

	/**
	 * Emit one envelope. On a browser stream, ringed-delta kind:"frame"
	 * envelopes are ringed keyed on the REAL wire seq (reported by the
	 * transport at emit) so a reconnect re-sends exactly what the edge is
	 * missing; acks/controls and non-ringed frames (priming bursts, unicast
	 * answers) are never ringed; priming is re-derived on stream_open and a
	 * lost answer is re-sent by the client, matching the direct /ws ring
	 * semantics. Ring memory is byte-bounded (4 MiB) per stream. A "dropped"
	 * send on a browser stream flips stream_resync, no silent gap ever.
	 */
	const emit = (
		streamId: string,
		kind: CallbackKind,
		payload: unknown,
		record = true,
		encoded?: PreEncodedPayload,
		paced = false,
	): void => {
		const isBrowser = streamId.startsWith(CALLBACK_BROWSER_STREAM_PREFIX);
		const stream = isBrowser ? streams.get(streamId) : undefined;
		const isDelta =
			kind === "frame" &&
			isObject(payload) &&
			typeof payload.type === "string" &&
			isRingedFrameType(payload.type);
		const ringFrame = isBrowser && stream !== undefined && record && isDelta;
		// A ringed frame needs its JSON and byte size for the ring: serialize it
		// here once and hand the same encoding to the transport, so the send
		// does not serialize it again.
		// A paced frame counts against the fleet's credit window from the moment
		// its wire seq is known (stream_ack releases it), so it needs its byte
		// size too.
		const track = paced && stream !== undefined;
		const wire = encoded ?? (ringFrame || track ? tryEncode(payload) : undefined);
		const result = deps.send(
			streamId,
			kind,
			wire ?? payload,
			ringFrame || track
				? (seq) => {
						if (track && stream !== undefined) {
							const bytes = wire?.bytes ?? 0;
							stream.inflight.push({ seq, bytes });
							stream.inflightBytes += bytes;
						}
						if (!ringFrame || stream === undefined) return;
						const entryEncoded = wire ?? preEncodePayload(payload);
						const bytes = entryEncoded.bytes;
						stream.entries.push({ seq, kind, encoded: entryEncoded, bytes });
						stream.bytes += bytes;
						// The client has been sent this delta: keep the floor at
						// the highest delivered wire seq so any later open
						// without an explicit lastSeq never re-delivers it.
						stream.lastSeq = seq;
						while (
							(stream.entries.length - stream.head > RING_CAP || stream.bytes > RING_MAX_BYTES) &&
							stream.entries.length - stream.head > 1
						) {
							const dropped = stream.entries[stream.head]!;
							stream.entries[stream.head] = undefined;
							stream.bytes -= dropped.bytes;
							stream.head++;
							// The frontier is the highest evicted wire seq: a
							// reconnect floor BELOW it needs entries the ring
							// no longer holds (ring MISS).
							if (dropped.seq > stream.evictedSeq) stream.evictedSeq = dropped.seq;
						}
						// Reclaim the dead prefix once it dominates the backing array.
						if (stream.head > 1024 && stream.head * 2 > stream.entries.length) {
							stream.entries = stream.entries.slice(stream.head);
							stream.head = 0;
						}
					}
				: undefined,
		);
		if (result === "dropped" && isBrowser) {
			const resync: StreamResyncControl = { type: "stream_resync" };
			deps.send(streamId, "control", resync);
		}
	};

	const ringAfter = (stream: BrowserStream, after: number): RingEntry[] => {
		const out: RingEntry[] = [];
		for (let i = stream.head; i < stream.entries.length; i++) {
			const entry = stream.entries[i]!;
			if (entry.seq > after) out.push(entry);
		}
		return out;
	};

	/** Wake every paced sender asleep on this stream so it re-checks its epoch, credit and room. */
	const wakeRoomWaiters = (stream: BrowserStream): void => {
		for (const wake of [...stream.roomWaiters]) wake();
	};

	/** Release credit: the fleet acknowledged every frame up to wire seq `seq`. */
	const ackStream = (stream: BrowserStream, seq: number): void => {
		let released = false;
		while (stream.inflightHead < stream.inflight.length) {
			const entry = stream.inflight[stream.inflightHead]!;
			if (entry.seq > seq) break;
			stream.inflight[stream.inflightHead++] = undefined;
			stream.inflightBytes -= entry.bytes;
			released = true;
		}
		if (stream.inflightHead > 1024 && stream.inflightHead * 2 > stream.inflight.length) {
			stream.inflight = stream.inflight.slice(stream.inflightHead);
			stream.inflightHead = 0;
		}
		if (released) wakeRoomWaiters(stream);
	};

	/**
	 * Wait until the pair's outbound buffer can take one maximal envelope for
	 * this stream and the fleet's unacknowledged window can too. False when the
	 * stream closed, the broker stopped, or a newer prime superseded `epoch`:
	 * the caller's remaining frames are obsolete.
	 */
	const waitForRoom = async (stream: BrowserStream, epoch: number): Promise<boolean> => {
		for (;;) {
			if (stopped || streams.get(stream.streamId) !== stream || stream.epoch !== epoch)
				return false;
			const queued = deps.bufferedBytes(stream.streamId);
			if (
				queued.stream + ENVELOPE_MAX_BYTES + PACE_MARGIN_BYTES <= STREAM_MAX_BYTES &&
				queued.connection + ENVELOPE_MAX_BYTES + PACE_MARGIN_BYTES <= CONNECTION_MAX_BYTES &&
				queued.stream + stream.inflightBytes + ENVELOPE_MAX_BYTES <= STREAM_ACK_WINDOW_BYTES
			)
				return true;
			// Sleep until the pair drains (a pump pass that sent bytes) or the fleet
			// acknowledges, then the room check runs again.
			const { promise, resolve } = Promise.withResolvers<void>();
			const wake = (): void => {
				off();
				stream.roomWaiters.delete(wake);
				resolve();
			};
			const off = deps.onDrain(wake);
			stream.roomWaiters.add(wake);
			await promise;
		}
	};

	/**
	 * A paused stream's frame: ringed deltas are held for the resume (past the
	 * ring budget the hold gives up and the resume re-primes); a frame a replay
	 * cannot repeat (priming, a history resync, a reset) makes the stream dirty;
	 * the rest (answers to commands nobody is waiting on) is dropped.
	 */
	const holdWhilePaused = (
		stream: BrowserStream,
		frame: Record<string, unknown>,
		encoded: PreEncodedPayload | undefined,
	): void => {
		const held = stream.paused!;
		if (held.dirty) return;
		const type = typeof frame.type === "string" ? frame.type : "";
		if (!isRingedFrameType(type)) {
			if (
				type === "hello_ok" ||
				type === "attached" ||
				type === "history" ||
				type === "available_commands"
			) {
				held.dirty = true;
				held.frames = [];
				held.bytes = 0;
			}
			return;
		}
		held.frames.push({ frame, encoded });
		held.bytes += encoded?.bytes ?? 0;
		if (held.bytes > RING_MAX_BYTES) {
			held.dirty = true;
			held.frames = [];
			held.bytes = 0;
		}
	};

	/**
	 * Deliver one live frame to a browser stream, or hold it while that
	 * stream's prime is in flight. A held backlog past the ring budget restarts
	 * the prime in place, which supersedes the held frames (bounded memory).
	 * Nothing is reset on the client.
	 */
	const deliver = (
		stream: BrowserStream,
		frame: Record<string, unknown>,
		encoded: PreEncodedPayload | undefined = tryEncode(frame),
	): void => {
		if (stream.paused !== null) {
			holdWhilePaused(stream, frame, encoded);
			return;
		}
		if (stream.deferred === null) {
			emit(stream.streamId, "frame", frame, true, encoded);
			return;
		}
		const bytes = encoded?.bytes ?? 0;
		stream.deferred.push({ frame, encoded, bytes });
		stream.deferredBytes += bytes;
		if (stream.deferredBytes <= RING_MAX_BYTES) return;
		// Supersede the backlog: a fresh prime rebuilds the snapshot from current
		// state, which covers every held delta, so the held frames are dropped rather
		// than replayed. Its hello_ok replaces the partial burst on this same stream:
		// no stream_resync and no client reconnect.
		prime(stream);
	};

	/**
	 * Prime one browser stream: the full priming frame list (hello_ok →
	 * attached → history → state → collab_status → available_commands →
	 * ready), paced against the pair's outbound buffer so a multi-MiB
	 * transcript never trips its drop. Live frames mirrored after the snapshot
	 * are held and delivered after the prime, in order.
	 */
	const prime = (stream: BrowserStream): void => {
		const epoch = ++stream.epoch;
		// A sender of the previous prime asleep on credit now sees its epoch moved on.
		wakeRoomWaiters(stream);
		stream.deferred = null;
		stream.deferredBytes = 0;
		const run = async (): Promise<void> => {
			const build = await deps.preparePriming();
			if (stopped || streams.get(stream.streamId) !== stream || stream.epoch !== epoch) return;
			const held: NonNullable<BrowserStream["deferred"]> = [];
			stream.deferred = held;
			for (const frame of build()) {
				if (!(await waitForRoom(stream, epoch))) return;
				emit(stream.streamId, "frame", frame, true, undefined, true);
			}
			// Drained entries leave the backlog and its byte count, so the budget bounds
			// what is still outstanding, not everything the prime has ever seen.
			while (held.length > 0) {
				if (!(await waitForRoom(stream, epoch))) return;
				const entry = held.shift()!;
				stream.deferredBytes -= entry.bytes;
				emit(stream.streamId, "frame", entry.frame, true, entry.encoded, true);
			}
			stream.deferred = null;
			stream.deferredBytes = 0;
		};
		run().catch((err: unknown) => {
			console.error(`omp-session: priming ${stream.streamId} failed:`, err);
		});
	};

	const openStream = (streamId: string, lastSeq?: number): void => {
		if (stopped || !streamId.startsWith(CALLBACK_BROWSER_STREAM_PREFIX)) return;
		let stream = streams.get(streamId);
		const newStream = stream === undefined;
		if (newStream) {
			stream = {
				streamId,
				lastSeq: 0,
				entries: [],
				head: 0,
				bytes: 0,
				evictedSeq: 0,
				epoch: 0,
				deferred: null,
				deferredBytes: 0,
				pairId: null,
				inflight: [],
				inflightHead: 0,
				inflightBytes: 0,
				roomWaiters: new Set(),
				paused: null,
			};
			streams.set(streamId, stream);
			deps.onBrowserStreamsChange?.(streams.size);
		}
		// Every stream_open restarts the credit ledger: the fleet resets its side
		// when it sends one, so frames sent before it will never be acknowledged.
		stream!.paused = null; // a re-open supersedes a park (the pair changed, or the fleet re-primes)
		stream!.inflight = [];
		stream!.inflightHead = 0;
		stream!.inflightBytes = 0;
		wakeRoomWaiters(stream!);
		if (lastSeq !== undefined) stream!.lastSeq = lastSeq;
		const replay = ringAfter(stream!, stream!.lastSeq);
		// Ring MISS: the reconnect floor is BELOW the eviction frontier, so
		// the client never consumed a ringed delta the ring already dropped;
		// entries it still needs were evicted. Never honor a partial tail;
		// resync + full re-prime (only a miss re-primes). A floor at
		// or above the frontier (the client consumed every evicted entry) is
		// a HIT below. A brand-new stream has no frontier and primes below.
		// A stream_open with NO lastSeq on an existing stream is the fleet's
		// re-open after a pair replacement: the edge omits lastSeq on a fresh
		// pair (its floor belongs to the old pair), so this stream's ring and
		// floor describe a dead seq space. Resync and re-prime (SXP-02). An
		// edge pipe that delivered nothing also omits lastSeq; the resync and
		// prime are still correct there. Wire seqs stay monotonic across pairs,
		// so the floor itself is not reset.
		if (
			!newStream &&
			(lastSeq === undefined || (stream!.lastSeq > 0 && stream!.lastSeq < stream!.evictedSeq))
		) {
			emit(streamId, "control", { type: "stream_resync" } satisfies StreamResyncControl);
			// The retained tail is stale: its content is superseded by the
			// fresh prime's snapshots, and replaying it later would double-
			// deliver. Clear the ring so the prime starts the stream clean.
			stream!.entries = [];
			stream!.head = 0;
			stream!.bytes = 0;
			stream!.evictedSeq = 0;
			prime(stream!);
			// The prime burst's ringed-delta frames (state/ready/collab_status)
			// advance the floor themselves via emit; do NOT force lastSeq here;
			// that could regress the floor below the just-primed frames and
			// re-deliver them on the next open.
			return;
		}
		// Ring HIT: replay the retained entries newer than the floor with a
		// FRESH wire seq; never re-record them.
		for (const entry of replay) {
			emit(streamId, entry.kind, entry.encoded, false);
			stream!.lastSeq = entry.seq;
		}
		// A caught-up ring hit (an existing stream whose floor is at or past
		// the newest entry) replays nothing and must NOT re-prime; the
		// client has everything. Only a brand-new stream (no ring history)
		// primes fresh.
		if (newStream) prime(stream!);
	};

	const handleControl = (envelope: CallbackEnvelope): void => {
		if (!isObject(envelope.payload)) return;
		const payload = envelope.payload;
		const type = typeof payload.type === "string" ? payload.type : "";
		const lastSeq = typeof payload.lastSeq === "number" ? payload.lastSeq : undefined;
		switch (type) {
			case "stream_open":
				openStream(envelope.streamId, lastSeq);
				break;
			case "stream_pause": {
				const stream = streams.get(envelope.streamId);
				// A stream mid-prime keeps going: its priming frames reach the parked
				// fleet side, which then lets the stream go (the browser re-attaches).
				if (stream !== undefined && stream.deferred === null && stream.paused === null) {
					stream.paused = { frames: [], bytes: 0, dirty: false };
				}
				break;
			}
			case "stream_resume": {
				const stream = streams.get(envelope.streamId);
				const held = stream?.paused;
				if (stream === undefined || held === null || held === undefined) break;
				stream.paused = null;
				if (held.dirty) {
					emit(stream.streamId, "control", { type: "stream_resync" } satisfies StreamResyncControl);
					stream.entries = [];
					stream.head = 0;
					stream.bytes = 0;
					stream.evictedSeq = 0;
					prime(stream);
				} else {
					for (const { frame, encoded } of held.frames) deliver(stream, frame, encoded);
				}
				break;
			}
			case "stream_ack": {
				const stream = streams.get(envelope.streamId);
				if (stream !== undefined && typeof payload.seq === "number") {
					ackStream(stream, payload.seq);
				}
				break;
			}
			case "stream_close": {
				const stream = streams.get(envelope.streamId);
				if (streams.delete(envelope.streamId)) {
					deps.onBrowserStreamsChange?.(streams.size);
					if (stream !== undefined) wakeRoomWaiters(stream);
				}
				break;
			}
			case "log_ack":
			case "log_gap":
				// Log controls belong to the log tailer (mounted by index.ts
				// before this broker); nothing to do here.
				break;
			case "shutdown":
				deps.onShutdown(typeof payload.reason === "string" ? payload.reason : undefined);
				break;
			default:
				console.error(`omp-session: unknown callback control "${type}"`);
				break;
		}
	};

	const handleCommand = (envelope: CallbackEnvelope): void => {
		const command = envelope.payload;
		const id = isObject(command) && typeof command.id === "string" ? command.id : undefined;
		deps
			.handleCommand(command)
			.then((answer) => {
				if (answer !== undefined && answer !== null) emit(envelope.streamId, "frame", answer);
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				emit(envelope.streamId, "frame", {
					type: "error",
					...(id !== undefined ? { id } : {}),
					error: message,
				});
				console.error(`omp-session: callback command failed: ${message}`);
			});
	};

	const mirror = (frame: Record<string, unknown>): void => {
		if (stopped || !deps.pairLive()) return;
		// Session-scoped frame: serialized once and shared by every recipient.
		// It goes verbatim to the fleet's activity mirror stream (minus the
		// types in isUnmirroredToControl) AND every open browser stream
		// (ringed-delta frames ring on the browser stream for reconnect replay).
		const encoded = tryEncode(frame);
		if (!isUnmirroredToControl(frame)) emit("control", "frame", frame, true, encoded);
		for (const stream of streams.values()) deliver(stream, frame, encoded);
	};

	/**
	 * History resync for every browser stream (the counterpart of the direct
	 * path's broadcastHistory). Never on the control stream: the fleet's
	 * activity mirror has no use for a transcript. A stream mid-prime holds the
	 * frames like any live frame, so they land after its older snapshot.
	 */
	const publishHistory = async (frames: Record<string, unknown>[]): Promise<void> => {
		if (stopped || !deps.pairLive()) return;
		await Promise.all(
			[...streams.values()].map(async (stream) => {
				if (stream.paused !== null) {
					for (const frame of frames) holdWhilePaused(stream, frame, undefined);
					return;
				}
				if (stream.deferred !== null) {
					for (const frame of frames) deliver(stream, frame);
					return;
				}
				const epoch = stream.epoch;
				for (const frame of frames) {
					if (!(await waitForRoom(stream, epoch))) return;
					emit(stream.streamId, "frame", frame, true, undefined, true);
				}
			}),
		);
	};

	const stop = (): void => {
		stopped = true;
		clearTimeout(orphanSweep);
		for (const stream of streams.values()) wakeRoomWaiters(stream);
		streams.clear();
		deps.onBrowserStreamsChange?.(0);
	};

	const status = (): SessionControlStatus => ({
		streams: [...streams.values()].map((s) => ({
			streamId: s.streamId,
			lastSeq: s.lastSeq,
			ringEntries: s.entries.length - s.head,
			ringBytes: s.bytes,
		})),
	});

	/** Drop every browser stream the live pair did not re-open (SXP-03). */
	const dropOrphans = (): void => {
		if (stopped) return;
		let dropped = false;
		for (const [streamId, stream] of streams) {
			if (stream.pairId === livePairId) continue;
			streams.delete(streamId);
			wakeRoomWaiters(stream);
			dropped = true;
		}
		if (dropped) deps.onBrowserStreamsChange?.(streams.size);
	};
	const armOrphanSweep = (): void => {
		clearTimeout(orphanSweep);
		orphanSweep = setTimeout(
			() => {
				orphanSweep = undefined;
				dropOrphans();
			},
			deps.streamConfirmMs ?? 2 * HEARTBEAT_INTERVAL_MS,
		);
	};

	return {
		handleEnvelope: (envelope) => {
			// A new connectionId is a new callback pair: its wire seq space
			// restarts and every live pipe re-opens its streams on it, so a
			// stream that stays silent past the grace window is an orphan.
			if (envelope.connectionId !== livePairId) {
				livePairId = envelope.connectionId;
				armOrphanSweep();
			}
			if (envelope.kind === "command") handleCommand(envelope);
			else if (envelope.kind === "control") handleControl(envelope);
			const stream = streams.get(envelope.streamId);
			if (stream) stream.pairId = envelope.connectionId;
		},
		mirror,
		publishHistory,
		publish: (streamId, frame) => emit(streamId, "frame", frame),
		stop,
		status,
		browserStreamCount: () => (deps.pairLive() ? streams.size : 0),
	};
}

export interface SessionControl {
	/** Route one fleet-to-session envelope (kind command/control) to its handler. */
	handleEnvelope(envelope: CallbackEnvelope): void;
	/** Mirror a session-scoped frame onto streamId "control" + browser streams (verbatim payload). */
	mirror(frame: Record<string, unknown>): void;
	/** Paced history resync onto every browser stream (never the control stream). */
	publishHistory(frames: Record<string, unknown>[]): Promise<void>;
	/** Publish a frame directly to one stream; ringed deltas ring on browser streams. */
	publish(streamId: string, frame: Record<string, unknown>): void;
	stop(): void;
	status(): SessionControlStatus;
	/**
	 * Live callback-pair browser streams (virtual; not ClientConsumers). 0 while
	 * the pair is down: the streams survive a drop and re-prime on the new
	 * pair, but the mirror drops every frame meanwhile, so nothing could
	 * receive a dialog opened in that window.
	 */
	browserStreamCount(): number;
}
