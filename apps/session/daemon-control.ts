import {
	CALLBACK_BROWSER_STREAM_PREFIX,
	CONNECTION_MAX_BYTES,
	ENVELOPE_MAX_BYTES,
	HEARTBEAT_INTERVAL_MS,
	STREAM_MAX_BYTES,
} from "#lib/wire/callback-protocol";
import type { CallbackEnvelope, CallbackKind } from "#lib/wire/callback-protocol";
import type { StreamResyncControl } from "#lib/wire/callback-protocol";
import { isRingedDeltaType } from "./sse-delivery";

/**
 * Daemon control broker: virtual streams over the callback pair
 * (P3.3/P3.5/P6; Transport/Lifecycle 2026-09-06 contracts).
 *
 * The daemon dials the callback pair; the fleet manages per-browser virtual
 * streams and down-half controls. This module owns the daemon half:
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
 * - Control mirror: every session-scoped frame the direct /events path
 *   broadcasts is mirrored as a kind:"frame" envelope on streamId "control"
 *   (payload verbatim) while the pair lives, so the fleet derives activity +
 *   fanout correlation exactly like the direct control-socket tap.
 *
 * Controls are not acknowledged on the wire. An unknown control type is logged
 * to stderr and otherwise ignored.
 */

// ── deps ───────────────────────────────────────────────────────────────────

export interface DaemonControlDeps {
	/** Mounted command dispatch; returns the answer payload or undefined. */
	handleCommand: (command: unknown) => Promise<unknown>;
	/**
	 * Async half of a browser-stream prime (anything that must be awaited, such
	 * as building the slash-command list). Resolves to the synchronous half,
	 * which snapshots the session into the full priming frame list (the same
	 * frames the direct SSE prime sends) at the moment it is called.
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
	 * never join the local SSE consumer set.
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
	payload: unknown;
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
	deferred: Array<{ frame: Record<string, unknown>; bytes: number }> | null;
	deferredBytes: number;
	/**
	 * connectionId of the callback pair that last sent this stream an envelope.
	 * A stream whose pairId is not the live pair was not re-opened by the
	 * fleet on the current pair, so it is an orphan (SXP-03).
	 */
	pairId: string | null;
}

export interface DaemonControlStatus {
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

export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
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
	 * lost answer is re-POSTed by the client, matching the direct SSE ring
	 * semantics. Ring memory is byte-bounded (4 MiB) per stream. A "dropped"
	 * send on a browser stream flips stream_resync, no silent gap ever.
	 */
	const emit = (streamId: string, kind: CallbackKind, payload: unknown, record = true): void => {
		const isBrowser = streamId.startsWith(CALLBACK_BROWSER_STREAM_PREFIX);
		const stream = isBrowser ? streams.get(streamId) : undefined;
		const isDelta =
			kind === "frame" &&
			isObject(payload) &&
			typeof payload.type === "string" &&
			isRingedDeltaType(payload.type);
		const ringFrame = isBrowser && stream !== undefined && record && isDelta;
		const result = deps.send(
			streamId,
			kind,
			payload,
			ringFrame
				? (seq) => {
						const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
						stream.entries.push({ seq, kind, payload, bytes });
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

	/**
	 * Wait until the pair's outbound buffer can take one maximal envelope for
	 * this stream. False when the stream closed, the broker stopped, or a newer
	 * prime superseded `epoch`: the caller's remaining frames are obsolete.
	 */
	const waitForRoom = async (stream: BrowserStream, epoch: number): Promise<boolean> => {
		for (;;) {
			if (stopped || streams.get(stream.streamId) !== stream || stream.epoch !== epoch)
				return false;
			const queued = deps.bufferedBytes(stream.streamId);
			if (
				queued.stream + ENVELOPE_MAX_BYTES + PACE_MARGIN_BYTES <= STREAM_MAX_BYTES &&
				queued.connection + ENVELOPE_MAX_BYTES + PACE_MARGIN_BYTES <= CONNECTION_MAX_BYTES
			)
				return true;
			// Sleep until the pair drains: a pump pass that sent bytes wakes this
			// one-shot listener, then the room check runs again.
			await new Promise<void>((resolve) => {
				const off = deps.onDrain(() => {
					off();
					resolve();
				});
			});
		}
	};

	/**
	 * Deliver one live frame to a browser stream, or hold it while that
	 * stream's prime is in flight. A held backlog past the ring budget restarts
	 * the prime in place, which supersedes the held frames (bounded memory).
	 * Nothing is reset on the client.
	 */
	const deliver = (stream: BrowserStream, frame: Record<string, unknown>): void => {
		if (stream.deferred === null) {
			emit(stream.streamId, "frame", frame);
			return;
		}
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		stream.deferred.push({ frame, bytes });
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
		stream.deferred = null;
		stream.deferredBytes = 0;
		const run = async (): Promise<void> => {
			const build = await deps.preparePriming();
			if (stopped || streams.get(stream.streamId) !== stream || stream.epoch !== epoch) return;
			const held: NonNullable<BrowserStream["deferred"]> = [];
			stream.deferred = held;
			for (const frame of build()) {
				if (!(await waitForRoom(stream, epoch))) return;
				emit(stream.streamId, "frame", frame);
			}
			// Drained entries leave the backlog and its byte count, so the budget bounds
			// what is still outstanding, not everything the prime has ever seen.
			while (held.length > 0) {
				if (!(await waitForRoom(stream, epoch))) return;
				const entry = held.shift()!;
				stream.deferredBytes -= entry.bytes;
				emit(stream.streamId, "frame", entry.frame);
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
			};
			streams.set(streamId, stream);
			deps.onBrowserStreamsChange?.(streams.size);
		}
		if (lastSeq !== undefined) stream!.lastSeq = lastSeq;
		const replay = ringAfter(stream!, stream!.lastSeq);
		// Ring MISS: the reconnect floor is BELOW the eviction frontier, so
		// the client never consumed a ringed delta the ring already dropped;
		// entries it still needs were evicted. Never honor a partial tail;
		// resync + full re-prime (P3.10: only a miss re-primes). A floor at
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
			emit(streamId, entry.kind, entry.payload, false);
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
			case "stream_close":
				if (streams.delete(envelope.streamId)) deps.onBrowserStreamsChange?.(streams.size);
				break;
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
		// Session-scoped frame: forward verbatim to the fleet's activity
		// mirror stream AND every open browser stream (ringed-delta frames
		// ring on the browser stream for reconnect replay).
		emit("control", "frame", frame);
		for (const stream of streams.values()) deliver(stream, frame);
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
				if (stream.deferred !== null) {
					for (const frame of frames) deliver(stream, frame);
					return;
				}
				const epoch = stream.epoch;
				for (const frame of frames) {
					if (!(await waitForRoom(stream, epoch))) return;
					emit(stream.streamId, "frame", frame);
				}
			}),
		);
	};

	const stop = (): void => {
		stopped = true;
		clearTimeout(orphanSweep);
		streams.clear();
		deps.onBrowserStreamsChange?.(0);
	};

	const status = (): DaemonControlStatus => ({
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

export interface DaemonControl {
	/** Route one down-half envelope (kind command/control) to its handler. */
	handleEnvelope(envelope: CallbackEnvelope): void;
	/** Mirror a session-scoped frame onto streamId "control" + browser streams (verbatim payload). */
	mirror(frame: Record<string, unknown>): void;
	/** Paced history resync onto every browser stream (never the control stream). */
	publishHistory(frames: Record<string, unknown>[]): Promise<void>;
	/** Publish a frame directly to one stream; ringed deltas ring on browser streams. */
	publish(streamId: string, frame: Record<string, unknown>): void;
	stop(): void;
	status(): DaemonControlStatus;
	/**
	 * Live callback-pair browser streams (virtual; not SseConsumers). 0 while
	 * the pair is down: the streams survive a drop and re-prime on the new
	 * pair, but the mirror drops every frame meanwhile, so nothing could
	 * receive a dialog opened in that window.
	 */
	browserStreamCount(): number;
}
