import { readdirSync, statSync, watch } from "node:fs";
import {
	closeSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import { join } from "node:path";
import { callbackError } from "../../lib/wire/callback-protocol";
import type { CallbackErrorCode } from "../../lib/wire/callback-protocol";
import type { CallbackSendResult } from "./fleet-callback";

/**
 * Continuous session-log tailer, daemon half (P3.7; docs/clone-contracts.md
 * "Session log streaming"). Tails the full session lineage subtree of an
 * agent sessions dir: main session JSONL, subagent/advisor recorders,
 * metadata JSONL and blobs, and streams raw bytes to the fleet as `frame`
 * envelopes on one virtual stream per lineage file, streamId
 * `logs/<sessionId>/<relpath>` with relpath POSIX-relative to the sessions
 * dir (manifest normalization).
 *
 * Discovery (matching the SDK layout verified in lib/session-files/export-sessions.ts
 * and the manifest isMainSession rule): main session files are `*.jsonl`
 * directly inside the sessions root AND directly inside one-level project
 * dirs (`<proj>/<file>.jsonl`); every file under the sibling artifact subtree
 * `<main minus .jsonl>/`, walked recursively, is lineage too, including
 * `__advisor.jsonl`, `__advisor.<slug>.jsonl`, subagent transcripts and
 * non-JSONL blobs. Transient SDK rewrite files (`.<name>.<snowflake>.tmp`,
 * `*.jsonl.<snowflake>.tmp`, EPERM `.bak` backups) are never discovered.
 * New files appearing mid-run are picked up by fs.watch (recursive) or the
 * periodic rescan.
 *
 * Wire contract (frozen, docs/clone-contracts.md "Session log streaming"):
 * - LogChunk payload `{offset, generation, data(base64), eof}`; `kind` stays
 *   `frame`; eof=true only on the final chunk of a closed session file.
 * - Fleet→daemon control on the down half: `{type:"log_ack", offsets}` (an
 *   ack is durability; the fleet fsynced before it) and
 *   `{type:"log_gap", from, to}` (repair request: re-stream `[from, to)` of
 *   the named stream). Both arrive via handleControl() from the connector's
 *   onEnvelope.
 * - Resume: after a daemon restart the acked watermarks come back through
 *   `opts.restore` and each file is streamed from its last acked offset; the
 *   fleet ignores re-sends below its acked offset.
 * - Generations: per-file identity counter. dev+ino change (the SDK's atomic
 *   temp+rename full rewrites, see FileSessionStorage.writeTextSync/Atomic)
 *   or size shrink bumps the generation and resyncs from offset 0; the fleet
 *   resets that stream's offset state on the first chunk of the new
 *   generation. (ctime is deliberately NOT watched: appends and the in-place
 *   title-slot rewrite touch ctime without changing file identity.)
 * - Ring: per-session 4 MiB unacked accounting window. Bytes are never
 *   buffered here; the file is source of truth and the connector's own
 *   replay ring covers recent redelivery, so overflow (acks lagging) simply
 *   rewinds every lagging stream of the session to its acked offset and
 *   re-streams that file region from disk, flagged as a gap for status until
 *   the acks catch up.
 * - Partial tails: while a JSONL file is live, only complete
 *   newline-terminated records stream (a torn trailing line is held back
 *   until its newline arrives, the generation changes, or the file closes);
 *   on close the remainder streams verbatim, exactly like the SDK loader
 *   tolerates it. A held partial past LOG_CHUNK_MAX_BYTES means the file
 *   carries an over-long record; its whole lines stream from the head with
 *   no partial hold. Non-JSONL blobs stream raw bytes with no line
 *   discipline.
 *
 * Chunk bounds: the connector rejects envelopes over ENVELOPE_MAX_BYTES
 * (1 MiB) as invalid_request, so raw chunk data is capped at 512 KiB;
 * ~683 KiB of base64, comfortably inside the cap with envelope overhead.
 *
 * Never throws after start(): every failure lands in status().lastError with
 * a ledger error code; constructor validation throws before start only.
 */

/** Frozen LogChunk frame payload (docs/clone-contracts.md "Session log streaming"). */
export interface LogChunk {
	/** Byte offset of this chunk in the file at `generation`. */
	offset: number;
	/** Per-file identity counter; NOT the envelope's workspace generation. */
	generation: number;
	/** base64 of raw chunk bytes, no line reinterpretation. */
	data: string;
	/** false while tailing; true on the final chunk of a closed session file. */
	eof: boolean;
}

/** Send leg handed in by the integration: one frame envelope per log chunk. */
export type LogTailerSend = (streamId: string, payload: LogChunk) => CallbackSendResult;

/** Acked watermark + generation for one stream, restored after a daemon restart. */
export interface LogTailerRestoreEntry {
	offset: number;
	generation: number;
}

/**
 * On-disk sidecar record (ACK_SIDECAR_NAME): the restore shape plus the file
 * identity (dev/ino) that produced the watermark, so the first post-restart
 * stat can detect a rewrite that happened while the daemon was down.
 */
interface AckSidecarEntry extends LogTailerRestoreEntry {
	dev?: number;
	ino?: number;
}

export interface LogTailerOptions {
	/** Agent sessions dir: `*.jsonl` at the root and one project level are main sessions. */
	sessionsDir: string;
	/** Frame-emitting send leg; identity/seq stamping stays in the connector. */
	send: LogTailerSend;
	/** Acked offsets per streamId to resume from after a daemon restart. */
	restore?: Map<string, LogTailerRestoreEntry>;
}

/** Max raw bytes per LogChunk (base64 stays far under the 1 MiB envelope cap). */
export const LOG_CHUNK_MAX_BYTES = 512 * 1024;
/** Per-session unacked window; overflow rewinds to the acked offset and re-streams. */
export const SESSION_RING_MAX_BYTES = 4 * 1024 * 1024;
/** Backup rescan/tick cadence; watch events drive the sub-second live path. */
const SCAN_INTERVAL_MS = 1_000;
/**
 * Ack-watermark persistence (P3.7 daemon half): an ack is fleet-side
 * durability, so a daemon restart resumes each lineage stream from its last
 * acked offset instead of re-streaming. Watermarks live in a sidecar next to
 * the sessions dir, a plain streamId → {offset, generation} map, rewritten
 * atomically (same-dir temp + rename). Writes are debounced (~1s, coalesced,
 * unref'd) while running and flushed synchronously on stop() so a graceful
 * shutdown never loses the final acks. dev/ino ride along in each entry so a
 * first stat after restart can detect a file the SDK rewrote while the daemon
 * was down (atomic full-file rewrite) and resync under a fresh generation
 * instead of splicing new content onto an old watermark.
 */
const ACK_SIDECAR_NAME = ".omp-log-tail.json";
const ACK_PERSIST_DEBOUNCE_MS = 1_000;
/** Transient SDK rewrite artifacts that never become lineage streams. */
const TRANSIENT_NAME = /\.(?:jsonl\.\d+\.tmp|tmp|bak)$/;

export interface LogTailerStreamStatus {
	streamId: string;
	relpath: string;
	generation: number;
	lastAcked: number;
	sentOffset: number;
	fileSize: number;
	unackedBytes: number;
	gap: { from: number; to: number } | null;
	closed: boolean;
	eofSent: boolean;
}

export interface LogTailerSessionStatus {
	sessionId: string;
	ringBytes: number;
	streams: LogTailerStreamStatus[];
}

export interface LogTailerStatus {
	running: boolean;
	/** true when fs.watch is unavailable and only the tick scanner drives discovery. */
	pollingOnly: boolean;
	sessions: LogTailerSessionStatus[];
	lastError: { code: CallbackErrorCode; message: string } | null;
}

interface TrackedStream {
	sessionKey: string;
	sessionId: string;
	relpath: string;
	streamId: string;
	absPath: string;
	isJsonl: boolean;
	generation: number;
	lastAcked: number;
	sentOffset: number;
	dev: number;
	ino: number;
	size: number;
	/** File identity that produced the acked watermark (sidecar restore). */
	watermarkDev: number;
	watermarkIno: number;
	closed: boolean;
	eofSent: boolean;
	gap: { from: number; to: number } | null;
}

interface TrackedSession {
	sessionId: string;
	streams: TrackedStream[];
}

function toPosix(p: string): string {
	return p.replaceAll("\\", "/");
}

function stripJsonl(name: string): string {
	return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

export class SessionLogTailer {
	readonly #sessionsDir: string;
	readonly #send: LogTailerSend;
	readonly #restore: Map<string, LogTailerRestoreEntry>;
	/** Full sidecar fidelity (offset/generation/dev/ino) for restore-time
	 *  rewrite detection; offset/generation merged into #restore. */
	readonly #sidecarRestore = new Map<string, AckSidecarEntry>();
	/** sessionKey (main relpath minus .jsonl) → session lineage tree. */
	readonly #sessions = new Map<string, TrackedSession>();
	/** streamId → stream (restore/ack lookup by frozen id). */
	readonly #streams = new Map<string, TrackedStream>();
	/** POSIX relpath from sessionsDir → stream (watch fast path, dedupe). */
	readonly #byRel = new Map<string, TrackedStream>();
	/** Last assigned generation per relpath: keeps the counter rising across drops. */
	readonly #assignedGen = new Map<string, number>();
	#watcher: FSWatcher | null = null;
	#tick: ReturnType<typeof setTimeout> | null = null;
	/** Pending debounced ack-sidecar flush (see ACK_PERSIST_DEBOUNCE_MS). */
	#sidecarTimer: ReturnType<typeof setTimeout> | null = null;
	#scanScheduled = false;
	#running = false;
	#pollingOnly = false;
	#lastError: { code: CallbackErrorCode; message: string } | null = null;

	constructor(opts: LogTailerOptions) {
		if (typeof opts.sessionsDir !== "string" || opts.sessionsDir.length === 0) {
			throw callbackError("invalid_request", "SessionLogTailer requires sessionsDir");
		}
		if (typeof opts.send !== "function") {
			throw callbackError("invalid_request", "SessionLogTailer requires a send function");
		}
		this.#sessionsDir = opts.sessionsDir;
		this.#send = opts.send;
		this.#restore = opts.restore ?? new Map();
		this.#loadSidecar(this.#restore);
	}

	// ---------------------------------------------------------------- lifecycle

	#sidecarPath(): string {
		return join(this.#sessionsDir, ACK_SIDECAR_NAME);
	}

	/**
	 * Load the ack sidecar and merge it under the explicit restore map
	 * (explicit opts.restore wins). Tolerates a missing/unreadable/corrupt
	 * sidecar, the tailer simply starts un-restored; the fleet's offset
	 * continuity check makes any re-stream safe.
	 */
	#loadSidecar(into: Map<string, LogTailerRestoreEntry>): void {
		let raw: string;
		try {
			raw = readFileSync(this.#sidecarPath(), "utf8");
		} catch {
			return; // Missing or unreadable, start un-restored.
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return; // Corrupt, start un-restored.
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		for (const [streamId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
			const entry = value as Record<string, unknown>;
			const offset = typeof entry.offset === "number" ? entry.offset : Number.NaN;
			const generation = typeof entry.generation === "number" ? entry.generation : Number.NaN;
			if (
				!Number.isInteger(offset) ||
				offset < 0 ||
				!Number.isInteger(generation) ||
				generation < 1
			) {
				continue;
			}
			this.#sidecarRestore.set(streamId, {
				offset,
				generation,
				...(typeof entry.dev === "number" ? { dev: entry.dev } : {}),
				...(typeof entry.ino === "number" ? { ino: entry.ino } : {}),
			});
			if (into.has(streamId)) continue; // Explicit opts.restore wins.
			into.set(streamId, { offset, generation });
		}
	}

	/** Async debounced persist; coalesces while the timer is pending. */
	#scheduleSidecarWrite(): void {
		if (!this.#running) return; // stop() owns the final flush.
		if (this.#sidecarTimer !== null) return; // A flush is already pending.
		this.#sidecarTimer = setTimeout(() => {
			this.#sidecarTimer = null;
			this.#writeSidecar();
		}, ACK_PERSIST_DEBOUNCE_MS);
		this.#sidecarTimer.unref?.();
	}

	/** One atomic rewrite (same-dir temp + rename) of every stream watermark. */
	#writeSidecar(): void {
		const record: Record<string, AckSidecarEntry> = {};
		for (const [streamId, stream] of this.#streams) {
			if (stream.lastAcked <= 0) continue;
			record[streamId] = {
				offset: stream.lastAcked,
				generation: stream.generation,
				...(stream.dev !== -1 && stream.ino !== -1 ? { dev: stream.dev, ino: stream.ino } : {}),
			};
		}
		const tmp = join(
			this.#sessionsDir,
			`.${ACK_SIDECAR_NAME}.${process.pid}.${Date.now().toString(36)}.tmp`,
		);
		try {
			writeFileSync(tmp, `${JSON.stringify(record)}\n`, "utf8");
			renameSync(tmp, this.#sidecarPath());
		} catch (err) {
			console.error(
				`omp-session: log-tail ack sidecar write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				unlinkSync(tmp);
			} catch {
				// Temp may never have been created, nothing to clean up.
			}
		}
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#scan();
		this.#drainAll();
		this.#installWatcher();
		this.#tick = setInterval(() => {
			this.#safe(() => {
				this.#scan();
				this.#drainAll();
			}, "tick scan failed");
		}, SCAN_INTERVAL_MS);
		this.#tick.unref?.();
	}

	stop(): void {
		this.#running = false;
		if (this.#sidecarTimer !== null) {
			clearTimeout(this.#sidecarTimer);
			this.#sidecarTimer = null;
		}
		this.#writeSidecar(); // Final flush: graceful stop never loses acks.
		if (this.#tick !== null) {
			clearInterval(this.#tick);
			this.#tick = null;
		}
		if (this.#watcher !== null) {
			try {
				this.#watcher.close();
			} catch {
				// Watcher already gone, nothing to clean up.
			}
			this.#watcher = null;
		}
	}

	/**
	 * Quiesce finalize (P4.5/P7.3): freeze discovery (stop the scan tick and
	 * watcher), mark every tracked stream closed so a subsequent drain
	 * releases any held-back torn tail VERBATIM (closed JSONL streams stream
	 * raw bytes to EOF, exactly like the SDK loader tolerates them) and emits
	 * the per-stream eof marker at the final offset. Returns the final flush
	 * boundary keyed by streamId, the offsets the fleet store must reach
	 * before the delete gate passes. Never throws: streams that fail to emit
	 * land in status().lastError and their boundary entry is omitted, which
	 * the caller treats as an explicit failure.
	 */
	finalizeForQuiesce(): Map<string, { offset: number; generation: number; eof: boolean }> {
		this.#running = false; // No further discovery or debounced sidecar writes.
		if (this.#sidecarTimer !== null) {
			clearTimeout(this.#sidecarTimer);
			this.#sidecarTimer = null;
		}
		if (this.#tick !== null) {
			clearInterval(this.#tick);
			this.#tick = null;
		}
		if (this.#watcher !== null) {
			try {
				this.#watcher.close();
			} catch {
				// Watcher already gone, nothing to clean up.
			}
			this.#watcher = null;
		}
		const boundary = new Map<string, { offset: number; generation: number; eof: boolean }>();
		for (const stream of [...this.#streams.values()]) {
			if (stream.closed && stream.eofSent) {
				boundary.set(stream.streamId, {
					offset: stream.sentOffset,
					generation: stream.generation,
					eof: true,
				});
				continue;
			}
			stream.closed = true;
			this.#drain(stream); // Releases the torn tail verbatim to EOF + eof marker.
			boundary.set(stream.streamId, {
				offset: stream.sentOffset,
				generation: stream.generation,
				eof: stream.eofSent,
			});
		}
		// Sidecar: the final boundary is the restart resume point if the
		// daemon dies before the fleet store confirms it.
		this.#writeSidecar();
		return boundary;
	}

	/** Current acked offset per stream (fleet durability watermarks). */
	ackedOffsets(): Map<string, number> {
		const out = new Map<string, number>();
		for (const stream of this.#streams.values()) out.set(stream.streamId, stream.lastAcked);
		return out;
	}

	status(): LogTailerStatus {
		const sessions: LogTailerSessionStatus[] = [];
		for (const session of this.#sessions.values()) {
			let ringBytes = 0;
			const streams: LogTailerStreamStatus[] = session.streams.map((stream) => {
				const unacked = Math.max(0, stream.sentOffset - stream.lastAcked);
				ringBytes += unacked;
				return {
					streamId: stream.streamId,
					relpath: stream.relpath,
					generation: stream.generation,
					lastAcked: stream.lastAcked,
					sentOffset: stream.sentOffset,
					fileSize: stream.size,
					unackedBytes: unacked,
					gap: stream.gap === null ? null : { ...stream.gap },
					closed: stream.closed,
					eofSent: stream.eofSent,
				};
			});
			sessions.push({
				sessionId: session.sessionId,
				ringBytes,
				streams,
			});
		}
		return {
			running: this.#running,
			pollingOnly: this.#pollingOnly,
			sessions,
			lastError: this.#lastError === null ? null : { ...this.#lastError },
		};
	}

	// ------------------------------------------------------------- control legs

	/**
	 * One fleet→daemon control envelope (down half). `log_ack` carries a batch
	 * of durable offsets keyed by streamId; `log_gap` requests re-streaming
	 * `[from, to)` of the stream named by the envelope's streamId. Malformed
	 * payloads are recorded as typed errors and ignored, never throws.
	 */
	handleControl(streamId: string, payload: unknown): void {
		this.#safe(() => {
			if (payload === null || typeof payload !== "object") {
				this.#fail("invalid_request", "log control payload is not an object");
				return;
			}
			const record = payload as Record<string, unknown>;
			if (record.type === "log_ack") {
				const offsets = record.offsets;
				if (offsets === null || typeof offsets !== "object" || Array.isArray(offsets)) {
					this.#fail("invalid_request", "log_ack offsets must be an object");
					return;
				}
				for (const [stream, off] of Object.entries(offsets as Record<string, unknown>)) {
					if (typeof off === "number" && Number.isFinite(off)) this.applyAck(stream, off);
				}
				return;
			}
			if (record.type === "log_gap") {
				const from = typeof record.from === "number" ? record.from : Number.NaN;
				const to = typeof record.to === "number" ? record.to : Number.NaN;
				if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
					this.#fail("invalid_request", "log_gap from/to out of range");
					return;
				}
				// Fleet controls ride the reserved transport stream, so the
				// affected stream is carried in the payload; envelope streamId
				// is the fallback for direct sends.
				const target =
					typeof record.streamId === "string" && record.streamId.length > 0
						? record.streamId
						: streamId === "transport" || streamId === "control"
							? ""
							: streamId;
				if (target.length === 0) {
					this.#fail("invalid_request", "log_gap without a target stream");
					return;
				}
				this.#repairRange(target, from);
				return;
			}
			// Other control types belong to other features, not ours to act on.
		}, "handleControl failed");
	}

	/** Advance one stream's durable watermark (an ack means fsynced fleet-side). */
	applyAck(streamId: string, offset: number): void {
		this.#safe(() => {
			if (!Number.isFinite(offset) || offset < 0) {
				this.#fail("invalid_request", `invalid ack offset ${offset}`);
				return;
			}
			const stream = this.#streams.get(streamId);
			if (stream === undefined) return; // Unknown/late stream, nothing to free.
			if (offset > stream.sentOffset) return; // Stale-generation ack; ignore.
			if (offset > stream.lastAcked) {
				stream.lastAcked = offset;
				this.#scheduleSidecarWrite();
			}
			if (stream.gap !== null && stream.lastAcked >= stream.gap.to) stream.gap = null;
			// The fleet acked (down-stream control, not a file event): if this
			// freed enough of the ring window, resume draining the stalled tail.
			if (this.#running) this.#drain(stream);
		}, "applyAck failed");
	}

	// ----------------------------------------------------------------- internal

	#fail(code: CallbackErrorCode, message: string): void {
		this.#lastError = { code, message };
	}

	#safe(fn: () => void, what: string): void {
		try {
			fn();
		} catch (err) {
			this.#fail("unavailable", `${what}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	#installWatcher(): void {
		try {
			this.#watcher = watch(this.#sessionsDir, { recursive: true }, (_event, filename) => {
				this.#onWatchEvent(filename);
			});
			this.#watcher.on("error", () => {
				this.#pollingOnly = true;
				this.#closeWatcher();
			});
			this.#pollingOnly = false;
		} catch {
			// Platform without recursive fs.watch: the tick scanner covers discovery.
			this.#pollingOnly = true;
			this.#watcher = null;
		}
	}

	#closeWatcher(): void {
		if (this.#watcher === null) return;
		try {
			this.#watcher.close();
		} catch {
			// Ignore; closing a dead watcher must not throw.
		}
		this.#watcher = null;
	}

	#onWatchEvent(filename: string | null): void {
		this.#safe(() => {
			if (filename !== null && filename !== "") {
				const known = this.#byRel.get(toPosix(String(filename)));
				if (known !== undefined) {
					// Fast path: an already-tracked file moved, drain it directly.
					this.#drain(known);
					this.#checkRing(known.sessionKey);
					return;
				}
			}
			// New/renamed/unknown path: rescan (coalesced), then drain everything.
			this.#scheduleScan();
		}, "watch event failed");
	}

	#scheduleScan(): void {
		if (this.#scanScheduled || !this.#running) return;
		this.#scanScheduled = true;
		queueMicrotask(() => {
			this.#scanScheduled = false;
			this.#safe(() => {
				this.#scan();
				this.#drainAll();
			}, "scan failed");
		});
	}

	// -------------------------------------------------------------- discovery

	/**
	 * Rebuild the tracked set from disk. Main sessions are `*.jsonl` at the
	 * sessions root and one level inside project dirs; the artifact subtree of
	 * a main lives at `<main relpath minus .jsonl>/` and is walked recursively.
	 * A root dir is a project dir unless it is the artifact dir of a root
	 * main. Existing streams are upserted by relpath so acked offsets and
	 * generations survive rescans.
	 */
	#scan(): void {
		let rootEntries: Dirent[];
		try {
			rootEntries = readdirSync(this.#sessionsDir, { withFileTypes: true });
		} catch {
			return; // Agent dir missing, nothing to track; tick retries.
		}

		const dirs: string[] = [];
		const rootMains: Array<{ name: string; key: string; id: string }> = [];
		for (const entry of rootEntries) {
			if (TRANSIENT_NAME.test(entry.name)) continue;
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				rootMains.push({
					name: entry.name,
					key: stripJsonl(entry.name),
					id: stripJsonl(entry.name),
				});
			} else if (entry.isDirectory()) {
				dirs.push(entry.name);
			}
		}

		const artifactRoots = new Set<string>();
		for (const main of rootMains) {
			this.#ensureSession(main.key, main.id);
			this.#trackFile(main.key, main.id, main.name);
			const artifactAbs = join(this.#sessionsDir, main.key);
			if (dirs.includes(main.key)) {
				this.#walkSubtree(main.key, main.id, artifactAbs, main.key);
				artifactRoots.add(main.key);
			}
		}

		// One-level project dirs (a root dir is a project dir unless it is a
		// root main's artifact dir). Direct `*.jsonl` children are mains; each
		// main's artifact subtree is the sibling dir named after the main
		// minus `.jsonl`, walked recursively.
		for (const dirName of dirs) {
			if (artifactRoots.has(dirName)) continue;
			let subEntries: Dirent[];
			try {
				subEntries = readdirSync(join(this.#sessionsDir, dirName), { withFileTypes: true });
			} catch {
				continue;
			}
			const subDirs = new Set<string>();
			for (const child of subEntries) {
				if (TRANSIENT_NAME.test(child.name)) continue;
				if (child.isFile() && child.name.endsWith(".jsonl")) {
					const key = `${dirName}/${stripJsonl(child.name)}`;
					const id = stripJsonl(child.name);
					this.#ensureSession(key, id);
					this.#trackFile(key, id, `${dirName}/${child.name}`);
				} else if (child.isDirectory()) {
					subDirs.add(child.name);
				}
			}
			// Artifact subtrees of this project dir's mains.
			for (const child of subEntries) {
				if (!child.isFile() || !child.name.endsWith(".jsonl") || TRANSIENT_NAME.test(child.name))
					continue;
				const key = `${dirName}/${stripJsonl(child.name)}`;
				const artifactName = stripJsonl(child.name);
				if (subDirs.has(artifactName)) {
					this.#walkSubtree(
						key,
						stripJsonl(child.name),
						join(this.#sessionsDir, dirName, artifactName),
						key,
					);
				}
			}
		}

		// Drop sessions that fully vanished (no main file and no tracked
		// streams left). True file deletions are handled in #drain (eof + drop);
		// this only reaps the empty session shells.
		for (const [key, session] of this.#sessions) {
			if (session.streams.length === 0) this.#sessions.delete(key);
		}
	}

	#ensureSession(sessionKey: string, sessionId: string): TrackedSession {
		let session = this.#sessions.get(sessionKey);
		if (session === undefined) {
			session = { sessionId, streams: [] };
			this.#sessions.set(sessionKey, session);
		}
		return session;
	}

	#trackFile(sessionKey: string, sessionId: string, rel: string): void {
		const posixRel = toPosix(rel);
		if (this.#byRel.has(posixRel)) return;
		// The streamId contract is `logs/<sessionId>/<relpath>` with
		// sessionId EXACTLY ONE SLASH-FREE segment; the fleet splits on the
		// first slash after logs/ (apps/fleet/server.ts #onLogEnvelope). A
		// slash-bearing sessionId (a project-nested main key like
		// `proj-x/sess-b`) would silently split into a wrong sessionDir +
		// relpath and never persist. The discovery path passes the BARE
		// filename stem (never the proj-prefixed sessionKey); this guard
		// makes any future caller that feeds a slash fail loudly instead of
		// silently dropping the session's logs.
		if (sessionId.length === 0 || sessionId.includes("/")) {
			throw new Error(
				`log tailer: sessionId must be a single slash-free segment for streamId logs/<sessionId>/<relpath>; got ${JSON.stringify(sessionId)} for ${posixRel}`,
			);
		}
		const absPath = join(this.#sessionsDir, posixRel);
		const streamId = `logs/${sessionId}/${posixRel}`;
		const previous = this.#assignedGen.get(posixRel);
		const restored = previous === undefined ? this.#restore.get(streamId) : undefined;
		const restoredSidecar = previous === undefined ? this.#sidecarRestore.get(streamId) : undefined;
		const generation = previous !== undefined ? previous + 1 : (restored?.generation ?? 1);
		this.#assignedGen.set(posixRel, generation);
		const session = this.#ensureSession(sessionKey, sessionId);
		const stream: TrackedStream = {
			sessionKey,
			sessionId,
			relpath: posixRel,
			streamId,
			absPath,
			isJsonl: posixRel.endsWith(".jsonl"),
			generation,
			lastAcked: restored?.offset ?? 0,
			sentOffset: restored?.offset ?? 0,
			dev: -1,
			ino: -1,
			size: 0,
			watermarkDev: restoredSidecar?.dev ?? -1,
			watermarkIno: restoredSidecar?.ino ?? -1,
			closed: false,
			eofSent: false,
			gap: null,
		};
		session.streams.push(stream);
		this.#streams.set(streamId, stream);
		this.#byRel.set(posixRel, stream);
	}

	#walkSubtree(sessionKey: string, sessionId: string, dirAbs: string, dirRel: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			return; // Subtree gone or unreadable, main file still tracked.
		}
		for (const entry of entries) {
			if (TRANSIENT_NAME.test(entry.name)) continue;
			const childRel = `${dirRel}/${entry.name}`;
			if (entry.isDirectory()) {
				this.#walkSubtree(sessionKey, sessionId, join(dirAbs, entry.name), childRel);
			} else if (entry.isFile()) {
				this.#trackFile(sessionKey, sessionId, childRel);
			}
		}
	}

	// ------------------------------------------------------------------ tailing

	#drainAll(): void {
		for (const stream of [...this.#streams.values()]) {
			this.#drain(stream);
			this.#checkRing(stream.sessionKey);
		}
	}

	/**
	 * Stream one file's new bytes. Sync throughout: stat → identity check →
	 * newline-terminated reads → frame emission, all inside one event-loop
	 * turn, so watch events and ticks can never interleave mid-drain.
	 */
	#drain(stream: TrackedStream): void {
		let st;
		try {
			st = statSync(stream.absPath);
		} catch {
			this.#dropStream(stream); // Deleted workspace-side, closure, untrack.
			return;
		}
		if (!st.isFile()) {
			this.#dropStream(stream);
			return;
		}

		// Identity: dev+ino change (SDK atomic temp+rename rewrite) or size
		// shrink bumps the generation and resyncs from offset 0. On the first
		// stat after a restart with a restore watermark, a file smaller than
		// the acked offset means it was rewritten while the daemon was down,
		// same divergence rule, resync under a fresh generation.
		const identityChanged = stream.dev !== -1 && (st.dev !== stream.dev || st.ino !== stream.ino);
		const shrunk = stream.size > 0 && st.size < stream.size;
		const restoredDivergent =
			stream.dev === -1 && stream.lastAcked > 0 && st.size < stream.sentOffset;
		if (identityChanged || shrunk || restoredDivergent) {
			stream.generation += 1;
			stream.lastAcked = 0;
			stream.sentOffset = 0;
			stream.gap = null;
			stream.closed = false;
			stream.eofSent = false;
		}
		stream.dev = st.dev;
		stream.ino = st.ino;
		stream.size = st.size;

		// Restored-watermark divergence (restart path): the sidecar recorded
		// the file identity that produced the acked offset. When that identity
		// differs from the file now on disk (an atomic rewrite while the daemon
		// was down, or a new file reusing a streamId after a clean close), the
		// watermark belongs to a dead file; resync from 0 under a fresh
		// generation. No-op when the sidecar carried no identity (watermarkDev
		// -1) or outside a restart (watermarkDev is refreshed every drain, so
		// it always equals dev/ino after the first).
		if (
			stream.watermarkDev !== -1 &&
			stream.lastAcked > 0 &&
			(stream.watermarkDev !== stream.dev || stream.watermarkIno !== stream.ino)
		) {
			stream.generation += 1;
			stream.lastAcked = 0;
			stream.sentOffset = 0;
			stream.gap = null;
			stream.closed = false;
			stream.eofSent = false;
		}
		stream.watermarkDev = stream.dev;
		stream.watermarkIno = stream.ino;

		if (stream.closed && stream.eofSent) return;

		let fd: number | undefined;
		try {
			fd = openSync(stream.absPath, "r");
		} catch (err) {
			this.#fail(
				"unavailable",
				`open ${stream.relpath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.#dropStream(stream);
			return;
		}

		try {
			const buf = Buffer.allocUnsafe(LOG_CHUNK_MAX_BYTES);
			while (stream.sentOffset < stream.size) {
				if (this.#ringExhausted(stream.sessionKey)) break; // Halt: ring full, acks lagging.
				const want = Math.min(LOG_CHUNK_MAX_BYTES, stream.size - stream.sentOffset);
				const got = readSync(fd, buf, 0, want, stream.sentOffset);
				if (got <= 0) break;
				if (!stream.isJsonl || stream.closed) {
					// Blob bytes or the torn tail of a closed JSONL: verbatim.
					const last = stream.sentOffset + got >= stream.size;
					if (!this.#emitChunk(stream, stream.sentOffset, buf, got, last && stream.closed)) return;
					stream.sentOffset += got;
					continue;
				}
				// Live JSONL: complete newline-terminated records only. A torn
				// trailing line is held back; if it ever fills a whole chunk the
				// file legitimately carries an over-long record, so stream the
				// chunk without a partial hold (next reads continue mid-record,
				// the fleet reassembles by offset continuity).
				let cut = buf.lastIndexOf(0x0a, got - 1) + 1;
				if (cut === 0) {
					if (got < LOG_CHUNK_MAX_BYTES) break; // Hold the torn tail.
					if (!this.#emitChunk(stream, stream.sentOffset, buf, got, false)) return;
					stream.sentOffset += got;
					continue;
				}
				if (!this.#emitChunk(stream, stream.sentOffset, buf, cut, false)) return;
				stream.sentOffset += cut;
			}

			if (stream.closed && !stream.eofSent && stream.sentOffset === stream.size) {
				// Final chunk of a closed session file: eof marker at EOF.
				if (this.#emitChunk(stream, stream.sentOffset, Buffer.alloc(0), 0, true)) {
					stream.eofSent = true;
				}
			}
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// fd already closed, nothing to do.
				}
			}
		}
	}

	#emitChunk(
		stream: TrackedStream,
		offset: number,
		buf: Buffer,
		length: number,
		eof: boolean,
	): boolean {
		const payload: LogChunk = {
			offset,
			generation: stream.generation,
			data: length === 0 ? "" : buf.subarray(0, length).toString("base64"),
			eof,
		};
		let result: CallbackSendResult;
		try {
			result = this.#send(stream.streamId, payload);
		} catch (err) {
			this.#fail(
				"retryable",
				`send threw for ${stream.streamId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
		if (result === "sent") return true;
		const code: CallbackErrorCode =
			result === "dropped" ? "retryable" : result === "stopped" ? "unavailable" : "invalid_request";
		this.#fail(code, `send ${result} for ${stream.streamId} at offset ${offset}`);
		return false;
	}

	/** A tracked file vanished: emit closure at the last streamed offset, untrack. */
	#dropStream(stream: TrackedStream): void {
		if (stream.closed && stream.eofSent) return;
		stream.closed = true;
		// Closure marker at the last streamed offset; a torn tail that never
		// made it to disk before the deletion is simply absent. Emit eof even
		// when nothing was streamed (empty/deleted-before-content file) so the
		// fleet flips the stream to complete.
		if (!stream.eofSent && this.#emitChunk(stream, stream.sentOffset, Buffer.alloc(0), 0, true)) {
			stream.eofSent = true;
		}
		this.#untrack(stream);
	}

	#untrack(stream: TrackedStream): void {
		this.#streams.delete(stream.streamId);
		this.#byRel.delete(stream.relpath);
		const session = this.#sessions.get(stream.sessionKey);
		if (session !== undefined) {
			const idx = session.streams.indexOf(stream);
			if (idx !== -1) session.streams.splice(idx, 1);
		}
	}

	// ------------------------------------------------------- ring / gap repair

	/** Unacked accounting bytes across one session's streams. */
	#ringBytes(sessionKey: string): number {
		const session = this.#sessions.get(sessionKey);
		if (session === undefined) return 0;
		let bytes = 0;
		for (const stream of session.streams)
			bytes += Math.max(0, stream.sentOffset - stream.lastAcked);
		return bytes;
	}

	/** True when the session's unacked window is at or over the 4 MiB budget. */
	#ringExhausted(sessionKey: string): boolean {
		return this.#ringBytes(sessionKey) >= SESSION_RING_MAX_BYTES;
	}

	#checkRing(sessionKey: string): void {
		const session = this.#sessions.get(sessionKey);
		if (session === undefined) return;
		const ringBytes = this.#ringBytes(sessionKey);
		if (ringBytes <= SESSION_RING_MAX_BYTES) return;
		if (session.streams.some((stream) => stream.gap !== null)) return; // Repair already in flight.

		// Ring overflow with acks lagging: drop the session's unacked buffered
		// bytes by rewinding every lagging stream to its acked offset, the
		// ledger allows the ring to drop and the file stays source of truth,
		// and flag the gap. #drain's ring gate then re-streams the region from
		// disk at most once; the gap clears when acks pass the rewound
		// watermark, after which fresh appends resume.
		for (const stream of session.streams) {
			if (stream.sentOffset <= stream.lastAcked) continue;
			stream.gap = { from: stream.lastAcked, to: stream.sentOffset };
			stream.sentOffset = stream.lastAcked;
			this.#drain(stream);
		}
	}

	/** Fleet-requested repair: re-stream from `from` (drain covers [from, EOF)). */
	#repairRange(streamId: string, from: number): void {
		const stream = this.#streams.get(streamId);
		if (stream === undefined) {
			this.#fail("unavailable", `log_gap for unknown stream ${streamId}`);
			return;
		}
		const target = Math.min(Math.max(0, Math.floor(from)), stream.sentOffset);
		if (target >= stream.sentOffset && stream.gap === null) return; // Nothing to replay.
		stream.gap = { from: target, to: stream.sentOffset };
		stream.sentOffset = target;
		this.#drain(stream);
	}
}
