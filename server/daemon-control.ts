import { callbackError } from "../shared/callback-protocol";
import type {
	CallbackEnvelope,
	CallbackErrorCode,
	CallbackKind,
} from "../shared/callback-protocol";
import type {
	CommandAckPayload,
	ControlAckPayload,
	FlushBoundary,
	QuiesceWriterEntry,
	StreamResyncControl,
} from "../shared/callback-protocol";
import type { WriterFlushResult } from "./writer-flush";
import { isRingedDeltaType } from "./sse-delivery";

/**
 * Daemon control broker: virtual streams + quiesce over the callback pair
 * (P3.3/P3.5/P4.5/P6/P7; Transport/Lifecycle 2026-09-06 contracts).
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
 *   also flips stream_resync. stream_close drops the stream. Each pair
 *   replacement (onPairChange) clears every still-open stream's ring, the
 *   per-connection wire seq space restarts, and re-primes it fresh
 *   instead of streaming into the void.
 * - Command routing: kind:"command" payloads on a browser/control stream are
 *   acked (command_ack receipt) then dispatched through the mounted
 *   handleCommand; answers (call_result/unicast) flow as frames on the same
 *   stream. Dedup is the daemon's existing 60 s / 64-entry window; a
 *   duplicate is acked but not re-dispatched.
 * - Control mirror: every session-scoped frame the direct /events path
 *   broadcasts is mirrored as a kind:"frame" envelope on streamId "control"
 *   (payload verbatim) while the pair lives, so the fleet derives activity +
 *   fanout correlation exactly like the direct control-socket tap.
 * - Quiesce (P4.5/P7.3): transport-stream {type:"quiesce_begin", requestId}
 *   raises the admission barrier (every new command is rejected with an
 *   explicit writer_active ack), runs the fail-closed writer gate, explicitly
 *   flushes every reachable SessionManager, disposes the session cascade,
 *   finalizes the tailer (torn tails verbatim + per-stream eof) and WAITS for
 *   the fleet's log_acks to cover the final flush boundary, structurally
 *   verifies every declared JSONL, collects Git evidence with writers
 *   stopped, then answers {type:"quiesce_result"} on the transport stream.
 *
 * Every control received is acknowledged kind:"ack" on the same stream with
 * the original type + requestId and ok:true/false; nothing is silently
 * discarded.
 */

// ── deps ───────────────────────────────────────────────────────────────────

export interface LineageVerification {
	manifestFiles: unknown[];
	provenance: {
		workspaceId: string;
		workspaceName: string;
		resolvedCommit: string;
		generatedAt: number;
	};
}

export interface GitEvidenceResult {
	ok: boolean;
	git?: unknown;
	error?: { code: string; message: string };
}

/** Outcome of the explicit all-writer flush at quiesce. */
export interface DaemonControlDeps {
	/** Resolve the attached session entry; undefined before boot / after close. */
	getEntry: () => { disposeQuiesce(): Promise<void> } | undefined;
	/** Mounted command dispatch; returns the answer payload or undefined. */
	handleCommand: (command: unknown) => Promise<unknown>;
	/** Explicit flush of every reachable writer (main + descendants + advisors). */
	flushWriters: () => Promise<WriterFlushResult>;
	/** Finalize the tailer: torn tails verbatim + per-stream eof; returns the final flush boundary. */
	finalizeTailer: () => Promise<FlushBoundary>;
	/** Wait until fleet log_acks cover every stream of `boundary`; throws on timeout. */
	waitForAckedBoundary: (boundary: FlushBoundary, timeoutMs: number) => Promise<void>;
	/** Structural verification of every declared JSONL + manifest files/provenance. */
	verifyLineage: () => Promise<LineageVerification>;
	/** Git evidence with writers stopped; must fail closed on any probe failure. */
	collectGitEvidence: () => Promise<GitEvidenceResult>;
	/** Re-prime burst for one stream: the same frames the direct SSE prime sends. */
	primeStream: (streamId: string) => void;
	/** Send leg to the callback pair (the transport stamps identity/seq). */
	send: (
		streamId: string,
		kind: CallbackKind,
		payload: unknown,
		onEmittedSeq?: (seq: number) => void,
	) => unknown;
	/** Live callback pair present. */
	pairLive: () => boolean;
	mainSessionFile: string | null;
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
	entries: RingEntry[];
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
}

export interface DaemonControlStatus {
	quiescing: boolean;
	admissionBarrier: boolean;
	streams: Array<{ streamId: string; lastSeq: number; ringEntries: number; ringBytes: number }>;
	lastQuiesce: { requestId: string; ok: boolean; at: number; error?: string } | null;
}

/** Per-browser replay ring: 10k entries / 4 MiB, byte-first eviction. */
const RING_CAP = 10_000;
const RING_MAX_BYTES = 4 * 1024 * 1024;
const QUIESCE_DEFAULT_TIMEOUT_MS = 30_000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code-string narrowing to the ledger vocabulary (acks carry typed codes). */
function ledgerCode(value: unknown): CallbackErrorCode {
	const code = typeof value === "string" ? value : "retryable";
	switch (code) {
		case "invalid_request":
		case "invalid_identity":
		case "unauthorized":
		case "forbidden":
		case "unavailable":
		case "conflict":
		case "generation_obsolete":
		case "writer_active":
		case "archive_pending":
		case "archive_conflict":
		case "provider_failed":
		case "retryable":
			return code;
		default:
			return "retryable";
	}
}

export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
	const streams = new Map<string, BrowserStream>();
	let quiescing = false;
	let admissionBarrier = false;
	let lastQuiesce: DaemonControlStatus["lastQuiesce"] = null;
	let stopped = false;

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
		const isBrowser = streamId.startsWith("browser/");
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
						const bytes = JSON.stringify(payload).length;
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
							stream.bytes -= dropped.bytes;
							stream.head++;
							// The frontier is the highest evicted wire seq: a
							// reconnect floor BELOW it needs entries the ring
							// no longer holds (ring MISS).
							if (dropped.seq > stream.evictedSeq) stream.evictedSeq = dropped.seq;
						}
					}
				: undefined,
		);
		if (result === "dropped" && isBrowser) {
			const resync: StreamResyncControl = { type: "stream_resync" };
			deps.send(streamId, "control", resync);
		}
	};

	const ack = (
		streamId: string,
		controlType: string,
		requestId: string | undefined,
		ok: boolean,
		code?: string,
		message?: string,
	): void => {
		const payload: ControlAckPayload = {
			type: controlType,
			...(requestId !== undefined ? { requestId } : {}),
			ok,
			...(ok
				? {}
				: {
						error: {
							code: ledgerCode(code ?? "retryable"),
							message: message ?? `${controlType} failed`,
						},
					}),
		};
		emit(streamId, "ack", payload);
	};

	const ringAfter = (stream: BrowserStream, after: number): RingEntry[] => {
		const out: RingEntry[] = [];
		for (let i = stream.head; i < stream.entries.length; i++) {
			const entry = stream.entries[i]!;
			if (entry.seq > after) out.push(entry);
		}
		return out;
	};

	const openStream = (streamId: string, lastSeq?: number): void => {
		if (stopped || !streamId.startsWith("browser/")) return;
		let stream = streams.get(streamId);
		const newStream = stream === undefined;
		if (newStream) {
			stream = { streamId, lastSeq: 0, entries: [], head: 0, bytes: 0, evictedSeq: 0 };
			streams.set(streamId, stream);
		}
		if (lastSeq !== undefined) stream!.lastSeq = lastSeq;
		const replay = ringAfter(stream!, stream!.lastSeq);
		// Ring MISS: the reconnect floor is BELOW the eviction frontier, so
		// the client never consumed a ringed delta the ring already dropped;
		// entries it still needs were evicted. Never honor a partial tail;
		// resync + full re-prime (P3.10: only a miss re-primes). A floor at
		// or above the frontier (the client consumed every evicted entry) is
		// a HIT below. A brand-new stream has no frontier and primes below.
		if (!newStream && stream!.lastSeq > 0 && stream!.lastSeq < stream!.evictedSeq) {
			emit(streamId, "control", { type: "stream_resync" } satisfies StreamResyncControl);
			// The retained tail is stale: its content is superseded by the
			// fresh prime's snapshots, and replaying it later would double-
			// deliver. Clear the ring so the prime starts the stream clean.
			stream!.entries = [];
			stream!.head = 0;
			stream!.bytes = 0;
			stream!.evictedSeq = 0;
			deps.primeStream(streamId);
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
		if (newStream) deps.primeStream(streamId);
	};

	const handleControl = (envelope: CallbackEnvelope): void => {
		if (!isObject(envelope.payload)) return;
		const payload = envelope.payload;
		const type = typeof payload.type === "string" ? payload.type : "";
		const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
		const lastSeq = typeof payload.lastSeq === "number" ? payload.lastSeq : undefined;
		switch (type) {
			case "stream_open":
				openStream(envelope.streamId, lastSeq);
				ack(envelope.streamId, "stream_open", undefined, true);
				break;
			case "stream_close":
				streams.delete(envelope.streamId);
				ack(envelope.streamId, "stream_close", undefined, true);
				break;
			case "log_ack":
			case "log_gap":
				// Log controls belong to the log tailer (mounted by index.ts
				// before this broker); acknowledge receipt only.
				ack(envelope.streamId, type, undefined, true);
				break;
			case "quiesce_begin":
				beginQuiesce(
					requestId,
					typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined,
				);
				break;
			default:
				ack(
					envelope.streamId,
					type,
					requestId,
					false,
					"invalid_request",
					`unknown control type "${type}"`,
				);
				break;
		}
	};

	const handleCommand = (envelope: CallbackEnvelope): void => {
		const command = envelope.payload;
		const id = isObject(command) && typeof command.id === "string" ? command.id : undefined;
		if (id !== undefined) {
			const receipt: CommandAckPayload = { type: "command_ack", id };
			emit(envelope.streamId, "ack", receipt);
		}
		if (admissionBarrier) {
			// Receipt above, then the explicit typed rejection.
			ack(
				envelope.streamId,
				"command_ack",
				undefined,
				false,
				"writer_active",
				"command rejected: quiesce admission barrier",
			);
			return;
		}
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

	const beginQuiesce = (requestId: string | undefined, timeoutMs: number | undefined): void => {
		if (requestId === undefined) {
			ack(
				"transport",
				"quiesce_begin",
				undefined,
				false,
				"invalid_request",
				"quiesce_begin requires requestId",
			);
			return;
		}
		if (quiescing) {
			ack(
				"transport",
				"quiesce_begin",
				requestId,
				false,
				"conflict",
				"quiesce already in progress",
			);
			return;
		}
		quiescing = true;
		admissionBarrier = true;
		ack("transport", "quiesce_begin", requestId, true);
		const timeout = timeoutMs ?? QUIESCE_DEFAULT_TIMEOUT_MS;
		void runQuiesce(requestId, timeout);
	};

	const runQuiesce = async (requestId: string, timeoutMs: number): Promise<void> => {
		let ok = true;
		let failure: { code: string; message: string } | null = null;
		let result: {
			boundary?: FlushBoundary;
			manifestFiles?: unknown[];
			provenance?: LineageVerification["provenance"];
			writers?: {
				main: "flushed";
				descendants: QuiesceWriterEntry[];
				advisors: "caught_up" | "inactive";
				note?: string;
			};
			git?: unknown;
		} = {};
		try {
			const entry = deps.getEntry();
			if (entry === undefined) {
				throw callbackError("writer_active", "no attached session to quiesce");
			}
			// 1. Explicit flush of every reachable writer BEFORE dispose.
			const flush = await deps.flushWriters();
			if (!flush.ok) {
				throw callbackError("unavailable", flush.error ?? "writer flush failed");
			}
			// 2. Dispose cascade.
			await entry.disposeQuiesce();
			// 3. Tailer finalize: torn tails verbatim + per-stream eof, then
			//    wait for fleet durability (log_acks) over the final boundary.
			const boundary = await deps.finalizeTailer();
			await deps.waitForAckedBoundary(boundary, timeoutMs);
			// 4. Structural verification + manifest (writers stopped).
			const lineage = await deps.verifyLineage();
			// 5. Git evidence with writers stopped (fail closed on any probe failure).
			const git = await deps.collectGitEvidence();
			if (!git.ok) {
				throw callbackError("conflict", git.error?.message ?? "git evidence unavailable");
			}
			result = {
				boundary,
				manifestFiles: lineage.manifestFiles,
				provenance: lineage.provenance,
				writers: {
					main: "flushed",
					descendants: flush.descendants,
					advisors: flush.advisors,
					...(flush.note !== undefined ? { note: flush.note } : {}),
				},
				git: git.git,
			};
		} catch (cause) {
			ok = false;
			const err = cause instanceof Error ? cause : new Error(String(cause));
			failure = {
				code: ledgerCode(isObject(cause) ? cause.code : undefined),
				message: err.message,
			};
		}
		emit("transport", "control", {
			type: "quiesce_result",
			requestId,
			ok,
			...(ok ? result : { error: failure }),
		});
		lastQuiesce = { requestId, ok, at: Date.now(), ...(ok ? {} : { error: failure?.message }) };
		quiescing = false;
		admissionBarrier = false; // Resume normal operation on any outcome.
	};

	const mirror = (frame: Record<string, unknown>): void => {
		if (stopped || !deps.pairLive()) return;
		// Session-scoped frame: forward verbatim to the fleet's activity
		// mirror stream AND every open browser stream (ringed-delta frames
		// ring on the browser stream for reconnect replay).
		emit("control", "frame", frame);
		for (const stream of streams.values()) emit(stream.streamId, "frame", frame);
	};

	const stop = (): void => {
		stopped = true;
		quiescing = false;
		admissionBarrier = false;
		streams.clear();
	};

	const status = (): DaemonControlStatus => ({
		quiescing,
		admissionBarrier,
		streams: [...streams.values()].map((s) => ({
			streamId: s.streamId,
			lastSeq: s.lastSeq,
			ringEntries: s.entries.length - s.head,
			ringBytes: s.bytes,
		})),
		lastQuiesce,
	});

	return {
		handleEnvelope: (envelope) => {
			if (envelope.kind === "command") handleCommand(envelope);
			else if (envelope.kind === "control") handleControl(envelope);
		},
		// The callback pair was replaced: every connection's per-stream wire
		// seq space RESTARTS (new connectionId). Retained ring entries carry
		// seqs from the dead pair; replaying them on the fresh pair would
		// deliver frames whose seqs mean nothing in the new space (new-pair
		// emits reuse the same numbers). Clear each stream's ring and
		// re-prime fresh; the edge replays its OWN browser ring
		// independently, so the browser loses nothing the edge had ringed.
		onPairChange: () => {
			if (stopped) return;
			for (const stream of streams.values()) {
				stream.entries = [];
				stream.head = 0;
				stream.bytes = 0;
				stream.evictedSeq = 0;
				stream.lastSeq = 0;
				deps.primeStream(stream.streamId);
			}
		},
		mirror,
		publish: (streamId, frame) => emit(streamId, "frame", frame),
		beginQuiesce,
		abort: () => {
			if (!quiescing) return;
			quiescing = false;
			admissionBarrier = false;
		},
		stop,
		status,
	};
}

export interface DaemonControl {
	/** Route one down-half envelope (kind command/control) to its handler. */
	handleEnvelope(envelope: CallbackEnvelope): void;
	/** Pair replaced: re-announce every still-open browser stream. */
	onPairChange(): void;
	/** Mirror a session-scoped frame onto streamId "control" + browser streams (verbatim payload). */
	mirror(frame: Record<string, unknown>): void;
	/** Publish a frame directly to one browser stream (prime bursts); ringed deltas ring. */
	publish(streamId: string, frame: Record<string, unknown>): void;
	/** Begin quiesce (transport control). */
	beginQuiesce(requestId: string, timeoutMs?: number): void;
	/** Abort an in-flight quiesce (pair teardown/shutdown). */
	abort(): void;
	stop(): void;
	status(): DaemonControlStatus;
}
