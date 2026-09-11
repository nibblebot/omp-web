import { open, type FileHandle } from "node:fs/promises";
import {
	BULK_MAX_BYTES,
	callbackError,
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_TRANSPORT_STREAM_ID,
} from "../shared/callback-protocol";
import type {
	CallbackEnvelope,
	CallbackErrorCode,
	CallbackKind,
	CloneGitEvidence,
	CommandAckPayload,
	ControlAckPayload,
	DownloadBulkFailedControl,
	FlushBoundary,
	QuiesceCloneResultControl,
	QuiesceEvidence,
	QuiesceWriterEntry,
	StreamResyncControl,
} from "../shared/callback-protocol";
import type { ManifestFile } from "../shared/archive-manifest";
import { validateKubernetesSource } from "../shared/provider-protocol";
import { validateWorkspaceRef } from "../runtime/prepare-workspace";
import { resolveJailedFile, type JailedFileResolution } from "./download-jail";
import { serializeQuiesceEvidence } from "./quiesce-evidence";
import type { ReachableWriterFlushReport, WriterFlushResult } from "./writer-flush";
import { isRingedDeltaType } from "./sse-delivery";

/**
 * Daemon control broker: the daemon half of the callback pair — per-browser
 * virtual streams plus the quiesce controls the fleet drives.
 *
 * - Browser streams: per `browser/<connId>` replay ring (10k entries / 4 MiB).
 *   stream_open (lastSeq = replay floor) replays retained frames with wire seq
 *   > lastSeq (HIT — never a re-prime); a floor below the ring's eviction
 *   frontier is a MISS → stream_resync + ring clear + full re-prime (never a
 *   silent partial replay); a caught-up floor replays nothing. An outbound
 *   buffer drop also flips stream_resync. A pair replacement clears every ring
 *   and re-primes it: the per-connection wire seq space restarts.
 * - Command routing: kind:"command" payloads are acked (command_ack receipt)
 *   then dispatched through the mounted handleCommand; answers flow back as
 *   kind:"frame". Duplicate commands are acked but not re-dispatched.
 * - Control mirror: every session-scoped broadcast is mirrored verbatim to
 *   streamId "control" and every open browser stream while the pair lives.
 * - Clone download (P3.4): a `download_bulk` command resolves its path through
 *   the SAME realpath jail HTTP /download enforces ({@link resolveJailedFile})
 *   and streams the file over the multi-part bulk channel in bounded 4 MiB
 *   parts — never read whole. Acceptance/failure is acked; every failure also
 *   emits a typed download_bulk_failed control naming the path and never
 *   carrying file contents.
 * - Quiesce: transport-stream {type:"quiesce_begin"} raises the admission
 *   barrier (new commands get an explicit writer_active ack), runs the
 *   fail-closed writer flush, disposes the session cascade, finalizes the
 *   tailer, waits for the fleet's log_acks over the final boundary, verifies
 *   lineage, collects Git evidence with writers stopped, then answers
 *   quiesce_result. Any legacy quiesce outcome resumes admission.
 * - Quiesce clone (Kubernetes only): {type:"quiesce_clone"} validates the
 *   envelope identity and the fleet's source/pin/branch, runs the same
 *   fail-closed flush → dispose → finalize → ack sequence, then uploads one
 *   QuiesceEvidence document under the control's correlationId. Command
 *   admission stays CLOSED once accepted — including on failure — until the Pod
 *   terminates. The outcome and its exact document are cached by requestId for
 *   the daemon's lifetime: a duplicate replays without re-collecting, and a
 *   duplicate with a fresh capture correlation re-uploads the SAME bytes.
 *
 * Every control received is acknowledged kind:"ack" on the same stream with
 * the original type + requestId and ok:true/false; nothing is silently
 * discarded. A failed ack carries its reason only in the nested
 * ControlAckPayload.error, never as top-level fields.
 */

// ── deps ───────────────────────────────────────────────────────────────────

export interface LineageVerification {
	manifestFiles: unknown[];
	/** The canonical evidence provenance (shared/callback-protocol), never a local duplicate. */
	provenance: QuiesceEvidence["provenance"];
}

export interface GitEvidenceResult {
	ok: boolean;
	git?: CloneGitEvidence;
	error?: { code: string; message: string };
}

/** Fleet-supplied facts for the Kubernetes quiesce_clone Git probe. */
export interface QuiesceCloneGitInput {
	/** Stored source URL; the checkout's raw origin is compared against it. */
	sourceRemote: string;
	/** Preserved pin (full lowercase commit id) that must be on the source. */
	pinnedRevision: string;
	/** Branch the checkout was prepared on. */
	branch: string;
}

/**
 * Kubernetes quiesce_clone support for the daemon half: the extra evidence the
 * branch gathers beyond the shared quiesce deps, plus the bulk upload the
 * daemon half performs under the fleet's correlation id. Absent on a
 * non-Kubernetes workspace, where a quiesce_clone control is rejected typed.
 */
export interface DaemonQuiesceCloneDeps {
	/** The daemon's own authenticated pair identity; the control envelope must match it. */
	identity: () => { workspaceId: string; generation: number; connectionId: string | null };
	/** POSIX relpath of the main transcript under the sessions dir, or null when none exists. */
	mainSessionRelpath: () => string | null;
	/**
	 * Upload the serialized evidence document under `correlationId`; throws on
	 * failure. A duplicate quiesce_clone replays through here with the fleet's
	 * fresh capture correlation, so it must re-send the given bytes under the
	 * given correlation rather than assume the document went through once.
	 */
	uploadEvidence: (correlationId: string, document: string) => Promise<void>;
	/**
	 * Preferred fail-closed flush that reports every reachable writer (main
	 * first, including a failed one). Falls back to `flushWriters` when not
	 * wired, so a minimal daemon still runs the branch.
	 */
	flushReachableWriters?: () => Promise<ReachableWriterFlushReport>;
}

/**
 * Clone-download support for the daemon half (fleet/edge.ts
 * GET /ctl/sessions/{id}/download): the `download_bulk` command streams a
 * server-side file back over the pair's bulk channel under a fleet-issued
 * capture correlation. The path jail is the HTTP /download jail shared
 * verbatim through {@link resolveJailedFile}; the transfer is the same
 * FleetCallback.requestBulkUploadParts the quiesce evidence upload uses.
 * Absent only on a daemon with no bulk channel, where the command is
 * answered with the typed unsupported error.
 */
export interface DaemonDownloadBulkDeps {
	/** The daemon's own authenticated pair identity; the command envelope must match it. */
	identity: () => { workspaceId: string; generation: number; connectionId: string | null };
	/**
	 * Canonical jail roots — the same set HTTP /download enforces (system temp
	 * dir, agent cwd, process cwd, a live session file's directory).
	 */
	jailRoots: () => Promise<string[]>;
	/** Base a relative path resolves against, exactly like HTTP /download (`config.cwd`). */
	cwd: () => string;
	/**
	 * Stream exactly `totalBytes` under `correlationId` as strictly-sequential
	 * parts of at most `partSize` bytes, pulling each part through `readPart`
	 * (FleetCallback.requestBulkUploadParts). Throws on any failure; the
	 * caller reports it as a typed download_bulk_failed control.
	 */
	uploadParts: (input: {
		correlationId: string;
		totalBytes: number;
		partSize: number;
		readPart: (part: number, size: number) => Promise<Uint8Array>;
	}) => Promise<void>;
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
	/**
	 * Git evidence with writers stopped; must fail closed on any probe failure.
	 * `input` is supplied by the Kubernetes quiesce_clone branch (stored
	 * source/pin/branch); the legacy quiesce path calls it bare.
	 */
	collectGitEvidence: (input?: QuiesceCloneGitInput) => Promise<GitEvidenceResult>;
	/**
	 * Kubernetes quiesce_clone support. Absent on a non-Kubernetes workspace:
	 * a quiesce_clone control is then rejected with the typed unsupported
	 * error, never silently ignored.
	 */
	quiesceClone?: DaemonQuiesceCloneDeps;
	/**
	 * Clone-download lane. Absent on a daemon with no bulk channel: a
	 * download_bulk command is then answered with the typed unsupported
	 * error, never silently discarded.
	 */
	downloadBulk?: DaemonDownloadBulkDeps;
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
	 * ring head. A reconnect floor BELOW this frontier is a ring MISS —
	 * entries the client still needs were evicted — and must full re-prime
	 * (never a silent partial tail). A floor at or above the frontier means
	 * the client consumed every evicted entry. 0 while nothing was evicted.
	 */
	evictedSeq: number;
}

export interface DaemonControlStatus {
	quiescing: boolean;
	admissionBarrier: boolean;
	/** Command admission latched closed by a quiesce_clone; it never reopens. */
	admissionClosed: boolean;
	streams: Array<{ streamId: string; lastSeq: number; ringEntries: number; ringBytes: number }>;
	lastQuiesce: { requestId: string; ok: boolean; at: number; error?: string } | null;
	lastQuiesceClone: { requestId: string; ok: boolean; at: number; error?: string } | null;
}

/** Per-browser replay ring: 10k entries / 4 MiB, byte-first eviction. */
const RING_CAP = 10_000;
const RING_MAX_BYTES = 4 * 1024 * 1024;
const QUIESCE_DEFAULT_TIMEOUT_MS = 30_000;
/** Kubernetes quiesce_clone bound (P3.5 stage-4 budget: 30 s). */
const QUIESCE_CLONE_TIMEOUT_MS = 30_000;

/**
 * Clone-download part size: at most 4 MiB per POST /callback/bulk part —
 * the quiesce evidence upload's sizing and the FleetCallback default, so
 * neither side ever buffers a whole file.
 */
const DOWNLOAD_BULK_PART_BYTES = 4 * 1024 * 1024;

/**
 * Adapt the legacy {@link WriterFlushResult} into a full per-writer report so
 * the Kubernetes branch has one shape whether or not `flushReachableWriters`
 * is wired. On failure the main writer is reported failed; the branch refuses
 * before reading writer states in that case.
 */
function writerFlushReport(
	result: WriterFlushResult,
	mainSessionFile: string | null,
): ReachableWriterFlushReport {
	return {
		ok: result.ok,
		writers: [
			{
				id: "s1",
				kind: "main",
				sessionFile: mainSessionFile,
				state: result.ok ? "flushed" : "failed",
			},
			...result.descendants.map((writer) => ({
				id: writer.id,
				kind: writer.kind,
				sessionFile: writer.sessionFile,
				state: writer.state,
			})),
		],
		advisors: result.advisors,
		...(result.error !== undefined ? { error: result.error } : {}),
		...(result.note !== undefined ? { note: result.note } : {}),
	};
}

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

/**
 * Cached quiesce_clone outcome keyed by requestId for the daemon's lifetime.
 * The serialized evidence document rides along so a replay under a fresh
 * fleet capture correlation re-uploads the SAME bytes; nothing is
 * re-collected (no second flush, dispose, lineage, or Git probe).
 */
interface QuiesceCloneCacheEntry {
	result: QuiesceCloneResultControl;
	/**
	 * The exact document that was uploaded, present whenever the evidence pass
	 * assembled one (even if the first upload itself failed): a replay is the
	 * retry for that transfer, never for the collection.
	 */
	document?: string;
}

export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
	const streams = new Map<string, BrowserStream>();
	let quiescing = false;
	let admissionBarrier = false;
	let admissionClosed = false;
	let lastQuiesce: DaemonControlStatus["lastQuiesce"] = null;
	let lastQuiesceClone: DaemonControlStatus["lastQuiesceClone"] = null;
	/** Kubernetes quiesce_clone outcomes + their evidence, cached by requestId for the daemon's lifetime. */
	const quiesceCloneOutcomes = new Map<string, QuiesceCloneCacheEntry>();
	let stopped = false;

	/**
	 * Emit one envelope. On a browser stream, ringed-delta kind:"frame"
	 * envelopes are ringed keyed on the REAL wire seq (reported by the
	 * transport at emit) so a reconnect re-sends exactly what the edge is
	 * missing; acks/controls and non-ringed frames (priming bursts, unicast
	 * answers) are never ringed — priming is re-derived on stream_open and a
	 * lost answer is re-POSTed by the client, matching the direct SSE ring
	 * semantics. Ring memory is byte-bounded (4 MiB) per stream. A "dropped"
	 * send on a browser stream flips stream_resync — no silent gap ever.
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
		// the client never consumed a ringed delta the ring already dropped —
		// entries it still needs were evicted. Never honor a partial tail —
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
			// advance the floor themselves via emit; do NOT force lastSeq here
			// — that could regress the floor below the just-primed frames and
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
		// the newest entry) replays nothing and must NOT re-prime — the
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
			case "quiesce_clone":
				beginQuiesceClone(envelope, payload);
				break;
			case "download_bulk":
				beginDownloadBulk(envelope, payload);
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
		// The clone-download lane is not a ClientCommand: fleet/edge.ts rides
		// download_bulk as kind:"command" on the reserved control stream, so
		// intercept it here instead of handing it to the session command
		// dispatcher (which would answer "Unknown command").
		if (isObject(command) && command.type === "download_bulk") {
			beginDownloadBulk(envelope, command);
			return;
		}
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
		if (admissionClosed) {
			ack(
				"transport",
				"quiesce_begin",
				requestId,
				false,
				"conflict",
				"command admission is permanently closed",
			);
			return;
		}
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

	/**
	 * Kubernetes quiesce_clone admission (P3.5): validate the authenticated
	 * envelope against the daemon's own pair identity, validate the
	 * fleet-supplied source/pin/branch, then latch command admission closed
	 * for the rest of the Pod's life and run the evidence pass. Rejected
	 * controls get the explicit typed ack; nothing is silently discarded.
	 */
	const beginQuiesceClone = (
		envelope: CallbackEnvelope,
		payload: Record<string, unknown>,
	): void => {
		const streamId = envelope.streamId;
		const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
		const correlationId =
			typeof payload.correlationId === "string" ? payload.correlationId : undefined;
		/** Typed rejection on the canonical ControlAckPayload (nested error only). */
		const reject = (code: CallbackErrorCode, message: string): void =>
			ack(streamId, "quiesce_clone", requestId, false, code, message);
		const cloneDeps = deps.quiesceClone;
		if (cloneDeps === undefined) {
			reject("invalid_request", "quiesce_clone is not supported by this workspace");
			return;
		}
		if (streamId !== CALLBACK_TRANSPORT_STREAM_ID) {
			reject("invalid_request", `quiesce_clone must ride the transport stream, got "${streamId}"`);
			return;
		}
		if (requestId === undefined || requestId.length === 0) {
			reject("invalid_request", "quiesce_clone requires requestId");
			return;
		}
		if (correlationId === undefined || correlationId.length === 0) {
			reject("invalid_request", "quiesce_clone requires correlationId");
			return;
		}
		let identity: { workspaceId: string; generation: number; connectionId: string | null };
		try {
			identity = cloneDeps.identity();
		} catch (cause) {
			reject("unavailable", cause instanceof Error ? cause.message : String(cause));
			return;
		}
		if (envelope.workspaceId !== identity.workspaceId) {
			reject("invalid_identity", "quiesce_clone workspace does not match the authenticated pair");
			return;
		}
		if (envelope.generation !== identity.generation) {
			reject("generation_obsolete", "quiesce_clone generation does not match the authorized pair");
			return;
		}
		if (identity.connectionId !== null && envelope.connectionId !== identity.connectionId) {
			reject("invalid_request", "quiesce_clone connection does not match the live pair");
			return;
		}
		// Duplicate requestId: replay the cached outcome, never re-collect. The
		// evidence was uploaded once at collection time, but the fleet opens a
		// fresh single-use capture correlation per attempt, so a replay under a
		// DIFFERENT correlation re-uploads the cached document under it and
		// answers with it (see replayQuiesceClone).
		const cached = quiesceCloneOutcomes.get(requestId);
		if (cached !== undefined) {
			ack(streamId, "quiesce_clone", requestId, true);
			void replayQuiesceClone(streamId, requestId, correlationId, cached);
			return;
		}
		if (admissionClosed) {
			reject("conflict", "workspace already quiesced; command admission is permanently closed");
			return;
		}
		if (quiescing) {
			reject("conflict", "quiesce already in progress");
			return;
		}
		let sourceRemote: string;
		try {
			sourceRemote = validateKubernetesSource(payload.sourceRemote);
		} catch (cause) {
			reject(
				"invalid_request",
				cause instanceof Error ? cause.message : "quiesce_clone sourceRemote is invalid",
			);
			return;
		}
		const pinnedRevision =
			typeof payload.pinnedRevision === "string" ? payload.pinnedRevision.trim().toLowerCase() : "";
		if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(pinnedRevision)) {
			reject("invalid_request", "quiesce_clone pinnedRevision must be a full lowercase commit id");
			return;
		}
		let branch: string;
		try {
			branch = validateWorkspaceRef(typeof payload.branch === "string" ? payload.branch : "");
		} catch (cause) {
			reject(
				"invalid_request",
				cause instanceof Error ? cause.message : "quiesce_clone branch is invalid",
			);
			return;
		}
		// Stop admission checks passed: close command admission for good. It
		// stays closed after disposal until the Pod terminates.
		quiescing = true;
		admissionBarrier = true;
		admissionClosed = true;
		ack(streamId, "quiesce_clone", requestId, true);
		void runQuiesceClone({ requestId, correlationId, sourceRemote, pinnedRevision, branch });
	};

	const runQuiesceClone = async (request: {
		requestId: string;
		correlationId: string;
		sourceRemote: string;
		pinnedRevision: string;
		branch: string;
	}): Promise<void> => {
		let result: QuiesceCloneResultControl = {
			type: "quiesce_clone_result",
			requestId: request.requestId,
			correlationId: request.correlationId,
			ok: false,
			error: { code: "unavailable", message: "quiesce_clone did not complete" },
		};
		// The one document this request ever assembles; cached with the outcome
		// so a replay can re-upload the same bytes under its own correlation.
		let document: string | undefined;
		try {
			const cloneDeps = deps.quiesceClone!;
			const entry = deps.getEntry();
			if (entry === undefined) {
				throw callbackError("writer_active", "no attached session to quiesce");
			}
			// 1. Flush every reachable writer, with per-writer results.
			const flush =
				cloneDeps.flushReachableWriters !== undefined
					? await cloneDeps.flushReachableWriters()
					: writerFlushReport(await deps.flushWriters(), deps.mainSessionFile);
			if (!flush.ok) {
				throw callbackError("unavailable", flush.error ?? "writer flush failed");
			}
			const mainWriter = flush.writers.find((writer) => writer.kind === "main");
			if (mainWriter === undefined || mainWriter.state !== "flushed") {
				throw callbackError("unavailable", "main writer flush was not proven");
			}
			const descendants: QuiesceWriterEntry[] = flush.writers
				.filter((writer) => writer.kind !== "main")
				.map((writer) => ({
					id: writer.id,
					kind: writer.kind,
					sessionFile: writer.sessionFile,
					state:
						writer.state === "disposed"
							? "disposed"
							: writer.state === "parked"
								? "parked"
								: "flushed",
				}));
			// 2. Dispose the session cascade.
			await entry.disposeQuiesce();
			// 3. Finalize the tailer, then wait for the fleet's log_acks.
			const boundary = await deps.finalizeTailer();
			await deps.waitForAckedBoundary(boundary, QUIESCE_CLONE_TIMEOUT_MS);
			// 4. Structural lineage + manifest, writers stopped.
			const lineage = await deps.verifyLineage();
			// 5. Git evidence against the fleet-supplied source/pin/branch.
			const git = await deps.collectGitEvidence({
				sourceRemote: request.sourceRemote,
				pinnedRevision: request.pinnedRevision,
				branch: request.branch,
			});
			if (!git.ok || git.git === undefined) {
				throw callbackError("conflict", git.error?.message ?? "git evidence unavailable");
			}
			// 6. Assemble, bound, and upload the single evidence document.
			document = serializeQuiesceEvidence({
				requestId: request.requestId,
				mainSessionRelpath: cloneDeps.mainSessionRelpath(),
				boundary,
				manifestFiles: lineage.manifestFiles as ManifestFile[],
				provenance: lineage.provenance,
				writers: {
					main: "flushed",
					descendants,
					advisors: flush.advisors,
					...(flush.note !== undefined ? { note: flush.note } : {}),
				},
				git: git.git,
			});
			await cloneDeps.uploadEvidence(request.correlationId, document);
			result = {
				type: "quiesce_clone_result",
				requestId: request.requestId,
				correlationId: request.correlationId,
				ok: true,
			};
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			result = {
				type: "quiesce_clone_result",
				requestId: request.requestId,
				correlationId: request.correlationId,
				ok: false,
				error: {
					code:
						isObject(cause) && typeof cause.code === "string"
							? ledgerCode(cause.code)
							: "unavailable",
					message: error.message,
				},
			};
		}
		// Cached by requestId for the daemon's lifetime: a duplicate control
		// replays this outcome without re-collecting anything, re-uploading the
		// cached document when it carries a fresh capture correlation.
		quiesceCloneOutcomes.set(request.requestId, {
			result,
			...(document !== undefined ? { document } : {}),
		});
		emit("transport", "control", result);
		lastQuiesceClone = {
			requestId: request.requestId,
			ok: result.ok,
			at: Date.now(),
			...(result.ok ? {} : { error: result.error.message }),
		};
		lastQuiesce = {
			requestId: request.requestId,
			ok: result.ok,
			at: Date.now(),
			...(result.ok ? {} : { error: result.error.message }),
		};
		quiescing = false;
		// admissionBarrier stays true: command admission remains closed after
		// disposal until the Pod terminates.
	};

	/**
	 * Replay a cached quiesce_clone outcome for a duplicate requestId.
	 *
	 * The evidence pass ran exactly once: no flush, dispose, lineage or Git
	 * probe happens here. The document was uploaded once, but the fleet opens a
	 * fresh single-use capture correlation per attempt and ignores a result
	 * whose correlationId differs, so a replay under a DIFFERENT correlation
	 * re-uploads the cached bytes under that correlation and answers with it;
	 * a replay repeating the original correlation needs no transfer (the bytes
	 * are already in the fleet's channel) and replays the receipt verbatim. A
	 * cached failure before document assembly replays its typed error under the
	 * current correlation, and a replay upload failure answers ok:false so the
	 * fleet retries instead of waiting out its evidence timeout.
	 */
	const replayQuiesceClone = async (
		streamId: string,
		requestId: string,
		correlationId: string,
		cached: QuiesceCloneCacheEntry,
	): Promise<void> => {
		const document = cached.document;
		if (document === undefined) {
			const result: QuiesceCloneResultControl = { ...cached.result, correlationId };
			emit(streamId, "control", result);
			return;
		}
		if (cached.result.correlationId === correlationId) {
			emit(streamId, "control", cached.result);
			return;
		}
		try {
			await deps.quiesceClone!.uploadEvidence(correlationId, document);
			emit(streamId, "control", {
				type: "quiesce_clone_result",
				requestId,
				correlationId,
				ok: true,
			} satisfies QuiesceCloneResultControl);
		} catch (cause) {
			emit(streamId, "control", {
				type: "quiesce_clone_result",
				requestId,
				correlationId,
				ok: false,
				error: {
					code:
						isObject(cause) && typeof cause.code === "string"
							? ledgerCode(cause.code)
							: "unavailable",
					message: cause instanceof Error ? cause.message : String(cause),
				},
			} satisfies QuiesceCloneResultControl);
		}
	};

	/**
	 * Typed download_bulk receipt on the caller's own stream (canonical
	 * ControlAckPayload: failure reason only in the nested error). A transfer
	 * that fails after acceptance is reported by its download_bulk_failed
	 * control instead — the fleet settles the correlation on that — so a
	 * single receipt is emitted.
	 */
	const downloadBulkAck = (
		streamId: string,
		code: CallbackErrorCode | undefined,
		message: string | undefined,
	): void => {
		ack(streamId, "download_bulk", undefined, code === undefined, code, message);
	};

	/**
	 * Clone-download admission (P3.4): validate the authenticated envelope
	 * against the daemon's own pair identity, then hand the path to the
	 * transfer. Every rejection is answered typed on the envelope's own
	 * stream; a correlationId named by a mismatched envelope is NOT ours to
	 * fail, so no failure control is emitted for it. The optional sessionId is
	 * informational only: the HTTP /download rule set this lane mirrors is
	 * jail-based, with no per-session scoping.
	 */
	const beginDownloadBulk = (
		envelope: CallbackEnvelope,
		payload: Record<string, unknown>,
	): void => {
		const streamId = envelope.streamId;
		const correlationId =
			typeof payload.correlationId === "string" ? payload.correlationId : undefined;
		const requested = typeof payload.path === "string" ? payload.path : undefined;
		const reject = (code: CallbackErrorCode, message: string): void =>
			downloadBulkAck(streamId, code, message);
		const bulk = deps.downloadBulk;
		if (bulk === undefined) {
			reject("invalid_request", "download_bulk is not supported by this daemon");
			return;
		}
		if (correlationId === undefined || correlationId.length === 0) {
			reject("invalid_request", "download_bulk requires correlationId");
			return;
		}
		if (requested === undefined || requested.length === 0) {
			reject("invalid_request", "download_bulk requires path");
			return;
		}
		let identity: { workspaceId: string; generation: number; connectionId: string | null };
		try {
			identity = bulk.identity();
		} catch (cause) {
			reject("unavailable", cause instanceof Error ? cause.message : String(cause));
			return;
		}
		if (envelope.workspaceId !== identity.workspaceId) {
			reject("invalid_identity", "download_bulk workspace does not match the authenticated pair");
			return;
		}
		if (envelope.generation !== identity.generation) {
			reject("generation_obsolete", "download_bulk generation does not match the authorized pair");
			return;
		}
		if (identity.connectionId !== null && envelope.connectionId !== identity.connectionId) {
			reject("invalid_request", "download_bulk connection does not match the live pair");
			return;
		}
		void runDownloadBulk(streamId, correlationId, requested);
	};

	/**
	 * Stream one jailed file to the fleet under `correlationId`. Resolution is
	 * whole-or-nothing (a path outside the jail is never partially read), the
	 * aggregate stays under the ledger's 64 MiB bulk cap, and reads are bounded
	 * to one 4 MiB part at a time through a single open handle.
	 */
	const runDownloadBulk = async (
		streamId: string,
		correlationId: string,
		requested: string,
	): Promise<void> => {
		const bulk = deps.downloadBulk!;
		/** Fail the whole correlation with a typed, path-naming (content-free) reason. */
		const fail = (code: CallbackErrorCode, message: string): void => {
			emit(CALLBACK_CONTROL_STREAM_ID, "control", {
				type: "download_bulk_failed",
				correlationId,
				error: { code, message },
			} satisfies DownloadBulkFailedControl);
		};
		let resolution: JailedFileResolution;
		try {
			resolution = await resolveJailedFile({
				requested,
				cwd: bulk.cwd(),
				roots: await bulk.jailRoots(),
			});
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			const code =
				isObject(cause) && typeof cause.code === "string" ? ledgerCode(cause.code) : "unavailable";
			downloadBulkAck(streamId, code, `download of ${requested} failed: ${error.message}`);
			fail(code, `download of ${requested} failed: ${error.message}`);
			return;
		}
		if (!resolution.ok) {
			downloadBulkAck(streamId, resolution.code, resolution.message);
			fail(resolution.code, resolution.message);
			return;
		}
		const canonical = resolution.canonical;
		const totalBytes = resolution.size;
		if (totalBytes > BULK_MAX_BYTES) {
			const message = `download of ${canonical} is ${totalBytes} bytes, over the ${BULK_MAX_BYTES}-byte bulk cap`;
			downloadBulkAck(streamId, "invalid_request", message);
			fail("invalid_request", message);
			return;
		}
		// Accepted: the target resolved inside the jail. Receipt before the
		// transfer so a long upload never withholds the acknowledgment.
		downloadBulkAck(streamId, undefined, undefined);
		let file: FileHandle;
		try {
			file = await open(canonical, "r");
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			fail("unavailable", `cannot read ${canonical}: ${error.message}`);
			return;
		}
		const partSize = DOWNLOAD_BULK_PART_BYTES;
		try {
			await bulk.uploadParts({
				correlationId,
				totalBytes,
				partSize,
				readPart: async (part, size) => {
					// One bounded buffer per part via a positional read: the file
					// is never slurped to compute a part.
					const buffer = new Uint8Array(size);
					const { bytesRead } = await file.read(buffer, 0, size, part * partSize);
					if (bytesRead !== size) {
						throw callbackError(
							"unavailable",
							`download of ${canonical} ended after ${part * partSize + bytesRead} of ${totalBytes} bytes`,
						);
					}
					return buffer;
				},
			});
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			const code =
				isObject(cause) && typeof cause.code === "string" ? ledgerCode(cause.code) : "unavailable";
			fail(code, `bulk upload of ${canonical} failed: ${error.message}`);
		} finally {
			await file.close().catch(() => {});
		}
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
		admissionClosed,
		streams: [...streams.values()].map((s) => ({
			streamId: s.streamId,
			lastSeq: s.lastSeq,
			ringEntries: s.entries.length - s.head,
			ringBytes: s.bytes,
		})),
		lastQuiesce,
		lastQuiesceClone,
	});

	return {
		handleEnvelope: (envelope) => {
			if (envelope.kind === "command") handleCommand(envelope);
			else if (envelope.kind === "control") handleControl(envelope);
		},
		// The callback pair was replaced: every connection's per-stream wire
		// seq space RESTARTS (new connectionId). Retained ring entries carry
		// seqs from the dead pair — replaying them on the fresh pair would
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
			// A Kubernetes quiesce_clone closes admission for the Pod's whole
			// life: an abort must never reopen it.
			if (!quiescing || admissionClosed) return;
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
