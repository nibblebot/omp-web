// Fleet log store (P3.8): durable, append-only mirror of the session lineage
// logs that daemons continuously stream over the callback pair. Contracts are
// frozen in docs/clone-contracts.md under "Session log streaming", "Fleet log
// store" and "Retention":
//   - Layout under the fleet state dir: logs/<workspaceId>/<sessionId>/<relpath>
//     holds raw bytes, byte-identical to the streamed lineage file.
//   - Per-session sidecar index.json (atomic tmp -> rename -> parent fsync) is
//     updated in the same critical section as the append.
//   - fsync-before-ack: ingest() only returns after the appended bytes and the
//     index are durable, so the returned offset is the ackable/resume point.
//   - Offset continuity: offset == durable length appends; greater yields a gap
//     result (log_gap repair); lower is a post-reconnect resend and is dropped.
//   - Generations: per-file identity counter. An older generation is dropped;
//     a newer one truncates the stored bytes and resyncs from 0.
//   - Retention: explicit purgeSession/purgeWorkspace only, plus listOrphans
//     against a caller-supplied live workspace set. No garbage collection, no
//     timers; verified data is never deleted internally.
//
// Everything here runs on synchronous fs calls: a single ingest is one
// critical section by construction (Node/Bun executes sync code without
// interleaving), which is what "same critical section" requires.

import {
	closeSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Log chunk frame payload streamed by the daemon (frozen contract shape). */
export interface LogChunk {
	/** Byte offset of this chunk in the file at `generation`. */
	offset: number;
	/** Per-file identity counter; NOT the envelope's workspace generation. */
	generation: number;
	/** Base64 of raw chunk bytes, no line reinterpretation. */
	data: string;
	/** False while tailing; true on the final chunk of a closed session file. */
	eof: boolean;
}

/** Per-stream entry of the index.json sidecar (frozen contract shape). */
export interface LogStreamIndexEntry {
	/** Last chunk generation applied. */
	generation: number;
	/** Durable append offset; equals the last log_ack. */
	ackedOffset: number;
	/** Tail complete. */
	eof: boolean;
}

/** Sidecar index persisted atomically next to the stored stream bytes. */
export interface LogStoreIndex {
	version: 1;
	workspaceId: string;
	sessionId: string;
	/** Key: relpath inside the agent dir. */
	streams: Record<string, LogStreamIndexEntry>;
}

/**
 * Result of applying one log chunk. "acked" carries the durable offset to
 * acknowledge with a `log_ack` control; "gap" maps to a `log_gap` repair
 * request; "duplicate" (already-durable resend) and "obsolete" (older
 * generation) are dropped silently per the ledger.
 */
export type LogIngestResult =
	| { status: "acked"; offset: number }
	| { status: "gap"; from: number; to: number }
	| { status: "duplicate" }
	| { status: "obsolete" };

export type LogStoreErrorCode = "invalid_path" | "invalid_id" | "invalid_chunk" | "read_only";

/** Typed store rejection: traversal paths, malformed chunks, read-only flips. */
export class LogStoreError extends Error {
	constructor(
		readonly code: LogStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = "LogStoreError";
	}
}

export type LogStoreRepairKind =
	/** A torn trailing write was cut back to the last complete line. */
	| "truncated_partial_tail"
	/** Bytes appended+fsynced before the index rename were adopted. */
	| "file_longer_than_index"
	/** The stored file is shorter than the index claimed. */
	| "file_shorter_than_index"
	/** The stream file vanished; resume state reset to 0. */
	| "file_missing_reset"
	/** A file existed without an index entry (crash between append and index). */
	| "adopted_unindexed_file"
	/** index.json was missing or unparsable; state was rebuilt from files. */
	| "rebuilt_missing_index"
	/** Leftover `<name>.tmp` from an interrupted atomic rewrite was removed. */
	| "removed_stale_tmp"
	/** An index stream key was not a safe relpath; the entry was dropped. */
	| "dropped_invalid_stream"
	/** A directory name was not a safe id; the subtree was skipped. */
	| "skipped_invalid_dir";

/** One recovery action taken by load(), for the caller to log or surface. */
export interface LogStoreRepair {
	workspaceId: string;
	sessionId: string;
	relpath?: string;
	kind: LogStoreRepairKind;
	from?: number;
	to?: number;
}

/** Summary of a load(): how much state exists and what had to be repaired. */
export interface LogStoreLoadReport {
	sessions: number;
	streams: number;
	repairs: LogStoreRepair[];
}

/** A logs/<workspaceId>/ subtree with no live workspace in the registry. */
export interface LogOrphan {
	workspaceId: string;
	sessions: string[];
	/** True when the workspace passed deletion verification (read-only flip). */
	readOnly: boolean;
	bytes: number;
}

/**
 * Lineage role of one stored file, mirroring the frozen export-manifest
 * classification (shared/archive-manifest.ts ManifestFileKind) over the
 * streamed relpath layout (server/log-tailer.ts: relpath is POSIX-relative
 * to the SDK sessions dir).
 */
export type StoredFileKind = "main" | "subagent" | "advisor" | "metadata";

/** One stored file's availability against its durable sidecar entry. */
export type StoredFileStatus = "stored" | "missing";

/** One file of a stored session, as listed by the read-only store APIs. */
export interface StoredFileInfo {
	/** POSIX relpath of the file inside the session subtree. */
	relpath: string;
	kind: StoredFileKind;
	/** Main-session relpath of the artifact dir root (subagent/advisor/metadata). */
	parentPath?: string;
	/** Durable bytes on disk (0 for missing files). */
	bytes: number;
	/** Last durable append offset recorded in the index sidecar. */
	ackedBytes: number;
	/** True when the daemon closed the stream (final chunk with eof). */
	eof: boolean;
	status: StoredFileStatus;
}

/** One stored session as listed by the read-only store APIs. */
export interface StoredSessionInfo {
	workspaceId: string;
	sessionId: string;
	files: StoredFileInfo[];
	/** Total durable bytes across stored files (missing files contribute 0). */
	bytes: number;
	/** Total indexed bytes across files with an index entry (0 when the index was rebuilt). */
	ackedBytes: number;
	/** Count of indexed files whose bytes are absent on disk. */
	missingAssets: number;
	/** Main-session relpath, when one exists (`<sessionId>.jsonl` or `<proj>/<sessionId>.jsonl`). */
	mainRelpath?: string;
	/** Latest file mtime under the session subtree (recursive), or 0. */
	mtimeMs: number;
}

/** One stored workspace as listed by the read-only store APIs. */
export interface StoredWorkspaceInfo {
	workspaceId: string;
	sessions: StoredSessionInfo[];
	/** Total durable bytes across the workspace subtree (includes the sidecar). */
	bytes: number;
	/** True when the workspace passed deletion verification (read-only flip). */
	readOnly: boolean;
}

const INDEX_NAME = "index.json";
const TMP_SUFFIX = ".tmp";
/**
 * Workspace-level read-only marker. The frozen LogStoreIndex shape has no
 * read-only field and a per-session index cannot represent a workspace with
 * zero sessions, so the flip persists as one additive marker file per
 * workspace: logs/<workspaceId>/readonly.json.
 */
const READONLY_MARKER = "readonly.json";
/** Backward scan window when locating the last newline of a stream file. */
const SCAN_WINDOW = 64 * 1024;
/** Names an id may not take because they are store-reserved. */
const RESERVED_NAMES: Record<string, true> = {
	[INDEX_NAME]: true,
	[READONLY_MARKER]: true,
};

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface StreamState {
	generation: number;
	ackedOffset: number;
	eof: boolean;
}

interface SessionState {
	workspaceId: string;
	sessionId: string;
	dir: string;
	streams: Map<string, StreamState>;
}

function assertSafeComponent(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new LogStoreError("invalid_id", `${field} must be a non-empty string`);
	}
	if (value === "." || value === "..") {
		throw new LogStoreError("invalid_id", `${field} must not be "." or ".."`);
	}
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
		throw new LogStoreError("invalid_id", `${field} must be a single path component`);
	}
	if (RESERVED_NAMES[value]) {
		throw new LogStoreError("invalid_id", `${field} collides with a reserved store file name`);
	}
}

/**
 * Validates a stream relpath: POSIX-relative, normalized, no traversal, and
 * clear of the store's own file conventions (sidecar name, tmp suffix).
 */
function assertSafeRelpath(relpath: string): string {
	if (typeof relpath !== "string" || relpath.length === 0) {
		throw new LogStoreError("invalid_path", "relpath must be a non-empty string");
	}
	if (relpath.includes("\0")) {
		throw new LogStoreError("invalid_path", "relpath must not contain NUL");
	}
	if (relpath.includes("\\")) {
		throw new LogStoreError("invalid_path", "relpath must use POSIX separators");
	}
	if (relpath.startsWith("/")) {
		throw new LogStoreError("invalid_path", "relpath must be relative");
	}
	if (/^[A-Za-z]:/.test(relpath)) {
		throw new LogStoreError("invalid_path", "relpath must not be drive-qualified");
	}
	if (relpath === INDEX_NAME) {
		throw new LogStoreError("invalid_path", "relpath collides with the index sidecar");
	}
	if (relpath.endsWith(TMP_SUFFIX)) {
		throw new LogStoreError("invalid_path", "relpath must not use the store tmp suffix");
	}
	for (const segment of relpath.split("/")) {
		if (segment.length === 0) {
			throw new LogStoreError("invalid_path", `relpath must be normalized: ${relpath}`);
		}
		if (segment === "." || segment === "..") {
			throw new LogStoreError("invalid_path", `relpath must not traverse: ${relpath}`);
		}
	}
	return relpath;
}

function assertChunkShape(chunk: LogChunk): void {
	if (chunk === null || typeof chunk !== "object") {
		throw new LogStoreError("invalid_chunk", "chunk must be an object");
	}
	if (!Number.isInteger(chunk.offset) || chunk.offset < 0) {
		throw new LogStoreError("invalid_chunk", "chunk.offset must be a non-negative integer");
	}
	if (!Number.isInteger(chunk.generation) || chunk.generation < 1) {
		throw new LogStoreError("invalid_chunk", "chunk.generation must be a positive integer");
	}
	if (typeof chunk.eof !== "boolean") {
		throw new LogStoreError("invalid_chunk", "chunk.eof must be a boolean");
	}
	if (typeof chunk.data !== "string" || (chunk.data.length > 0 && !BASE64_RE.test(chunk.data))) {
		throw new LogStoreError("invalid_chunk", "chunk.data must be a base64 string");
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Classification of a stored file relpath. The store mirrors the SDK
 * sessions dir, so the export-manifest rule applies verbatim: main =
 * `<sessionId>.jsonl` (depth 1) or `<proj>/<sessionId>.jsonl` (depth 2);
 * every other file belongs to the artifact subtree of the main session its
 * directory nests under, with `__advisor*.jsonl` = advisor and other
 * `.jsonl` = subagent. Any other shape (no sessionId match at depth ≤ 2,
 * artifacts whose parent is not a main file) classifies `metadata`.
 */
export function classifyStoredRelpath(sessionId: string, relpath: string): StoredFileKind {
	const norm = relpath.split("/");
	if (norm[norm.length - 1] === `${sessionId}.jsonl` && (norm.length === 1 || norm.length === 2)) {
		return "main";
	}
	if (norm.length === 1) return "metadata";
	const name = norm[norm.length - 1]!;
	if (name.startsWith(ADVISOR_STEM)) return "advisor";
	if (name.endsWith(".jsonl")) return "subagent";
	return "metadata";
}

/** Advisor transcript name stem, mirroring runtime/export-sessions.ts. */
const ADVISOR_STEM = "__advisor";

/** Main-first + depth-then-name ordering for a stored session's files. */
function sortLineage(files: StoredFileInfo[]): StoredFileInfo[] {
	return [...files].sort((a, b) => {
		const ak = rankKind(a);
		const bk = rankKind(b);
		if (ak !== bk) return ak - bk;
		const ad = a.relpath.split("/").length;
		const bd = b.relpath.split("/").length;
		if (ad !== bd) return ad - bd;
		return a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0;
	});
}

function rankKind(file: StoredFileInfo): number {
	switch (file.kind) {
		case "main":
			return 0;
		case "subagent":
			return 1;
		case "advisor":
			return 2;
		case "metadata":
			return 3;
	}
}

/**
 * Parent main-session relpath of an artifact file: the artifact's dir chain
 * nests under the main's stem dir (`<main>.jsonl` ↔ `<main>/`), so the
 * parent is the known main whose stem prefixes the artifact's relpath
 * (longest stem wins when sessions nest).
 */
function parentMainOf(mainRels: readonly string[], relpath: string): string | undefined {
	let best: { len: number; main: string } | undefined;
	for (const m of mainRels) {
		const stem = m.endsWith(".jsonl") ? m.slice(0, -".jsonl".length) : m;
		if (relpath.startsWith(`${stem}/`) && (best === undefined || stem.length > best.len)) {
			best = { len: stem.length, main: m };
		}
	}
	return best?.main;
}

/** Validates a component the same way as assertSafeComponent, without throwing. */
function assertSafeComponentOrNull(value: string): boolean {
	try {
		assertSafeComponent(value, "id");
		return true;
	} catch {
		return false;
	}
}

function fileSize(path: string): number | undefined {
	try {
		const stats = statSync(path);
		return stats.isFile() ? stats.size : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort directory fsync; some filesystems refuse directory fds. */
function fsyncDir(path: string): void {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return;
	}
	try {
		fsyncSync(fd);
	} catch {
		// Directory fsync is unsupported on some filesystems; file fsync above
		// remains the strict guarantee.
	} finally {
		closeSync(fd);
	}
}

function truncateFile(path: string, length: number): void {
	const fd = openSync(path, "r+");
	try {
		ftruncateSync(fd, length);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Writes a whole buffer, looping because a single writeSync may be short. */
function writeAllSync(fd: number, buffer: Buffer): void {
	let written = 0;
	while (written < buffer.length) {
		const n = writeSync(fd, buffer, written);
		if (n <= 0) throw new Error(`short write: ${n} of ${buffer.length} bytes`);
		written += n;
	}
}

/** Returns the file's last byte, or -1 for an empty/unreadable file. */
function lastByte(path: string, size: number): number {
	if (size < 1) return -1;
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(1);
		readSync(fd, buf, 0, 1, size - 1);
		return buf[0] ?? -1;
	} finally {
		closeSync(fd);
	}
}

/** Offset of the last 0x0a in the file, or -1; scans backward in windows. */
function findLastNewlineOffset(path: string, size: number): number {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(SCAN_WINDOW);
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - SCAN_WINDOW);
			const read = readSync(fd, buf, 0, end - start, start);
			for (let i = read - 1; i >= 0; i--) {
				if (buf[i] === 0x0a) return start + i;
			}
			end = start;
		}
		return -1;
	} finally {
		closeSync(fd);
	}
}

/**
 * Recovery rule (frozen): file length wins for complete lines; a torn trailing
 * write is cut back to the last newline. Returns the trusted length.
 */
function reconcileTail(path: string, size: number, indexAcked: number): number {
	if (size === indexAcked) return size;
	if (size < indexAcked) return size;
	if (lastByte(path, size) === 0x0a) return size;
	return findLastNewlineOffset(path, size) + 1;
}

interface RepairSink {
	(
		workspaceId: string,
		sessionId: string,
		repair: Omit<LogStoreRepair, "workspaceId" | "sessionId">,
	): void;
}

function walkTree(dir: string, visit: (path: string, entry: Dirent) => void): void {
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else visit(path, entry);
		}
	}
}

function treeBytes(dir: string): number {
	let total = 0;
	walkTree(dir, (path, entry) => {
		if (entry.isFile()) total += fileSize(path) ?? 0;
	});
	return total;
}

/**
 * Durable store of daemon-streamed session logs. See the module header for
 * the frozen contract. One FleetLogStore instance owns the whole logs/ tree
 * under `rootDir`; process state lives in memory and is rebuilt by load().
 */
export class FleetLogStore {
	readonly rootDir: string;
	/** Repairs applied by the most recent load(); empty when nothing drifted. */
	readonly loadReport: LogStoreLoadReport = { sessions: 0, streams: 0, repairs: [] };

	#sessions = new Map<string, Map<string, SessionState>>();
	#readOnly = new Set<string>();

	constructor(options: { rootDir: string }) {
		this.rootDir = options.rootDir;
	}

	/**
	 * Rebuilds offset state from index.json sidecars and file lengths, repairs
	 * disagreement (file length wins for full lines, torn tails truncated to
	 * the last newline), adopts files the index never recorded, and persists
	 * the corrections. Safe to call on an empty or missing rootDir.
	 */
	static load(rootDir: string): FleetLogStore {
		const store = new FleetLogStore({ rootDir });
		store.#restore();
		return store;
	}

	/**
	 * Applies one streamed log chunk and returns the ackable durable offset on
	 * success. Throws LogStoreError for unsafe paths/ids, malformed chunks, and
	 * read-only workspaces; continuity and generation mismatches are results,
	 * not throws, because they map to log_gap / silence on the wire.
	 */
	ingest(
		workspaceId: string,
		sessionId: string,
		relpath: string,
		chunk: LogChunk,
	): LogIngestResult {
		assertSafeComponent(workspaceId, "workspaceId");
		assertSafeComponent(sessionId, "sessionId");
		const cleanRelpath = assertSafeRelpath(relpath);
		assertChunkShape(chunk);
		if (this.isReadOnly(workspaceId)) {
			throw new LogStoreError("read_only", `log store for workspace ${workspaceId} is read-only`);
		}
		let bytes = Buffer.from(chunk.data, "base64");
		// Durable end of this chunk regardless of re-send splicing below.
		const chunkEnd = chunk.offset + bytes.length;
		const session = this.#ensureSession(workspaceId, sessionId);
		const file = join(session.dir, cleanRelpath);

		let stream = session.streams.get(cleanRelpath);
		if (!stream) {
			stream = { generation: chunk.generation, ackedOffset: 0, eof: false };
			session.streams.set(cleanRelpath, stream);
		} else if (chunk.generation < stream.generation) {
			// Older generation: bytes of a dead file identity, dropped.
			return { status: "obsolete" };
		} else if (chunk.generation > stream.generation) {
			// Atomic daemon-side rewrite replaced the file: stored bytes are
			// stale. Truncate and resync from 0 under the new generation.
			if (existsSync(file)) truncateFile(file, 0);
			stream.generation = chunk.generation;
			stream.ackedOffset = 0;
			stream.eof = false;
			this.#persistIndex(session);
		}

		// The live file is authoritative for the durable length; heals any
		// drift exactly like recovery does.
		let diskSize = 0;
		let existed = false;
		try {
			const stats = statSync(file);
			if (stats.isFile()) {
				diskSize = stats.size;
				existed = true;
			}
		} catch {
			// Not created yet.
		}
		if (existed && diskSize !== stream.ackedOffset) stream.ackedOffset = diskSize;

		if (chunk.offset > stream.ackedOffset) {
			return { status: "gap", from: stream.ackedOffset, to: chunk.offset };
		}
		if (chunk.offset < stream.ackedOffset) {
			// Post-reconnect resend of a chunk whose start lies below the durable
			// offset. Bytes up to the acked offset are already on disk and are
			// ignored; recovery can heal the file forward past the daemon's last
			// ack (torn tail cut to the last newline), so a chunk may extend past
			// ackedOffset. Same generation means the same file identity, so the
			// suffix is exactly the file's continuation and is appended.
			const skip = stream.ackedOffset - chunk.offset;
			if (bytes.length <= skip) return { status: "duplicate" };
			bytes = Buffer.from(bytes.subarray(skip));
		}

		if (bytes.length > 0 || !existed) {
			if (!existed) mkdirSync(dirname(file), { recursive: true });
			const fd = openSync(file, "a");
			try {
				if (bytes.length > 0) writeAllSync(fd, bytes);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			if (!existed) fsyncDir(dirname(file));
		}
		stream.ackedOffset = chunkEnd;
		stream.eof = chunk.eof;
		this.#persistIndex(session);
		return { status: "acked", offset: stream.ackedOffset };
	}

	/**
	 * Flips the workspace's logs subtree to read-only (post verification).
	 * Persisted durably; idempotent. Subsequent ingests are rejected typed.
	 */
	markWorkspaceReadOnly(workspaceId: string): void {
		assertSafeComponent(workspaceId, "workspaceId");
		if (this.#readOnly.has(workspaceId)) return;
		const wsDir = join(this.rootDir, workspaceId);
		mkdirSync(wsDir, { recursive: true });
		const marker = JSON.stringify({ version: 1, workspaceId, markedAt: Date.now() });
		const tmp = join(wsDir, READONLY_MARKER + TMP_SUFFIX);
		const fd = openSync(tmp, "w");
		try {
			writeAllSync(fd, Buffer.from(marker, "utf8"));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, join(wsDir, READONLY_MARKER));
		fsyncDir(wsDir);
		this.#readOnly.add(workspaceId);
	}

	isReadOnly(workspaceId: string): boolean {
		assertSafeComponent(workspaceId, "workspaceId");
		if (this.#readOnly.has(workspaceId)) return true;
		if (existsSync(join(this.rootDir, workspaceId, READONLY_MARKER))) {
			this.#readOnly.add(workspaceId);
			return true;
		}
		return false;
	}

	/**
	 * Removes one session's log subtree (workspace-wins: the workspace deleted
	 * the session, the fleet copy follows). Returns false when nothing was
	 * stored. Refuses read-only workspaces; explicit purgeWorkspace is the
	 * manual path for those.
	 */
	purgeSession(workspaceId: string, sessionId: string): boolean {
		assertSafeComponent(workspaceId, "workspaceId");
		assertSafeComponent(sessionId, "sessionId");
		if (this.isReadOnly(workspaceId)) {
			throw new LogStoreError(
				"read_only",
				`workspace ${workspaceId} is verified read-only; use purgeWorkspace for explicit removal`,
			);
		}
		const dir = join(this.rootDir, workspaceId, sessionId);
		const existed = existsSync(dir);
		if (existed) {
			rmSync(dir, { recursive: true, force: true });
			fsyncDir(join(this.rootDir, workspaceId));
		}
		this.#sessions.get(workspaceId)?.delete(sessionId);
		return existed;
	}

	/**
	 * Manual purge of a whole workspace's logs. Never called automatically:
	 * orphaned logs are kept until this is invoked explicitly.
	 */
	purgeWorkspace(workspaceId: string): { sessions: number } {
		assertSafeComponent(workspaceId, "workspaceId");
		const wsDir = join(this.rootDir, workspaceId);
		let sessions = 0;
		if (existsSync(wsDir)) {
			sessions = readdirSync(wsDir, { withFileTypes: true }).filter((entry) =>
				entry.isDirectory(),
			).length;
			rmSync(wsDir, { recursive: true, force: true });
			fsyncDir(this.rootDir);
		}
		this.#sessions.delete(workspaceId);
		this.#readOnly.delete(workspaceId);
		return { sessions };
	}

	/**
	 * Lists logs/<workspaceId>/ subtrees whose workspaceId is not in the live
	 * registry set (the registry belongs to the caller). readOnly distinguishes
	 * verified (retention-governed) from unverified (manual purge only) leftovers.
	 */
	listOrphans(liveWorkspaceIds: ReadonlySet<string> | readonly string[]): LogOrphan[] {
		const live = liveWorkspaceIds instanceof Set ? liveWorkspaceIds : new Set(liveWorkspaceIds);
		const orphans: LogOrphan[] = [];
		if (!isDirectory(this.rootDir)) return orphans;
		for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || live.has(entry.name)) continue;
			let workspaceId: string;
			try {
				assertSafeComponent(entry.name, "workspaceId");
				workspaceId = entry.name;
			} catch {
				continue; // Outside the id namespace; not an addressable orphan.
			}
			const wsDir = join(this.rootDir, workspaceId);
			const sessions = readdirSync(wsDir, { withFileTypes: true })
				.filter((child) => child.isDirectory())
				.map((child) => child.name)
				.sort();
			orphans.push({
				workspaceId,
				sessions,
				readOnly: this.isReadOnly(workspaceId),
				bytes: treeBytes(wsDir),
			});
		}
		return orphans.sort((a, b) =>
			a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
		);
	}

	// -------------------------------------------------------------------------
	// Read-only surface (P8.5/P8.6). Every method below is a pure disk read:
	// never mutates, never repairs, never touches a daemon or the SDK, and
	// never throws across the API boundary. Sessions not present in the
	// in-memory map are restored from disk on demand (constructor-only usage).
	// -------------------------------------------------------------------------

	/**
	 * Absolute session dir, or null when the workspace/session is absent or
	 * the ids are outside the store's namespace. The safe materialization
	 * entry point: never construct store paths by hand.
	 */
	storedSessionDir(workspaceId: string, sessionId: string): string | null {
		if (!assertSafeComponentOrNull(workspaceId) || !assertSafeComponentOrNull(sessionId)) {
			return null;
		}
		const dir = join(this.rootDir, workspaceId, sessionId);
		if (!isDirectory(dir)) return null;
		return dir;
	}

	/**
	 * Absolute path of one stored file that exists on disk, or null when
	 * absent or the ids/relpath are unsafe. Enables streaming reads without
	 * whole-file buffering. Read-only.
	 */
	storedFilePath(workspaceId: string, sessionId: string, relpath: string): string | null {
		if (!assertSafeComponentOrNull(workspaceId) || !assertSafeComponentOrNull(sessionId)) {
			return null;
		}
		let clean: string;
		try {
			clean = assertSafeRelpath(relpath);
		} catch {
			return null;
		}
		const dir = this.storedSessionDir(workspaceId, sessionId);
		if (dir === null) return null;
		const file = join(dir, clean);
		try {
			const st = statSync(file);
			if (!st.isFile()) return null;
			return file;
		} catch {
			return null;
		}
	}

	/**
	 * Reads at most `maxBytes` from the START of a stored file (missing /
	 * unsafe → null). Bounded transcript browsing parses only a prefix of
	 * oversized files, mirroring the stats jsonl parse-cap convention; the
	 * caller compares against the file's real size to set `truncated`.
	 */
	readStoredPrefix(
		workspaceId: string,
		sessionId: string,
		relpath: string,
		maxBytes: number,
	): Buffer | null {
		const file = this.storedFilePath(workspaceId, sessionId, relpath);
		if (file === null) return null;
		try {
			const st = statSync(file);
			const want = Math.max(0, Math.min(st.size, maxBytes));
			if (want === 0) return null;
			const fd = openSync(file, "r");
			try {
				const buf = Buffer.alloc(want);
				let got = 0;
				while (got < want) {
					const n = readSync(fd, buf, got, want - got, got);
					if (n <= 0) break;
					got += n;
				}
				return got === want ? buf : Buffer.from(buf.subarray(0, got));
			} finally {
				closeSync(fd);
			}
		} catch {
			return null;
		}
	}

	/**
	 * Reads one stored file's bytes, or null when the file is absent or the
	 * ids/relpath are unsafe. Bytes are exactly what the daemon streamed
	 * (the store never rewrites). Read-only: never repairs or truncates.
	 */
	readStored(workspaceId: string, sessionId: string, relpath: string): Buffer | null {
		if (!assertSafeComponentOrNull(workspaceId) || !assertSafeComponentOrNull(sessionId)) {
			return null;
		}
		let clean: string;
		try {
			clean = assertSafeRelpath(relpath);
		} catch {
			return null;
		}
		const dir = this.storedSessionDir(workspaceId, sessionId);
		if (dir === null) return null;
		const file = join(dir, clean);
		try {
			const st = statSync(file);
			if (!st.isFile() || st.size === 0) return null;
			return readFileSync(file);
		} catch {
			return null;
		}
	}

	/**
	 * Ordered stored lineage of one session (main files first, then their
	 * artifact subtrees; metadata last), each file with kind, parentPath,
	 * durable/indexed bytes, eof, and availability. Returns null for an
	 * unknown workspace/session. Every file status is reconciled against
	 * disk at call time, so "missing" reflects reality, not a stale index.
	 * Materialization consumers (daemon-transport bulk downloads, resume-
	 * onto-fresh-clone) copy files with status "stored" in this order.
	 */
	storedLineage(workspaceId: string, sessionId: string): StoredSessionInfo | null {
		const dir = this.storedSessionDir(workspaceId, sessionId);
		if (dir === null) return null;
		// In-memory stream state when the store loaded this session; disk walk
		// covers everything else. Deliberately NO #restoreSession here: restore
		// repairs/adopts/rewrites the index; this is the read-only surface.
		const streams = this.#sessions.get(workspaceId)?.get(sessionId)?.streams;
		const raw: Array<{
			relpath: string;
			bytes: number;
			ackedBytes: number;
			eof: boolean;
			kind: StoredFileKind;
			status: StoredFileStatus;
		}> = [];
		const indexed = new Set<string>();
		const mainRels: string[] = [];

		const push = (
			relpath: string,
			bytes: number,
			ackedBytes: number,
			eof: boolean,
			kind: StoredFileKind,
			status: StoredFileStatus,
		): void => {
			if (kind === "main") mainRels.push(relpath);
			raw.push({ relpath, bytes, ackedBytes, eof, kind, status });
		};

		// Indexed entries first (authoritative: stream state, eof, ackedBytes).
		if (streams !== undefined) {
			for (const relpath of [...streams.keys()].sort()) {
				const stream = streams.get(relpath)!;
				const abs = join(dir, relpath);
				let size = 0;
				let onDisk = false;
				try {
					const st = statSync(abs);
					if (st.isFile()) {
						size = st.size;
						onDisk = true;
					}
				} catch {
					// Missing on disk; the indexed entry stays visible as "missing".
				}
				indexed.add(relpath);
				push(
					relpath,
					size,
					stream.ackedOffset,
					stream.eof,
					classifyStoredRelpath(sessionId, relpath),
					onDisk ? "stored" : "missing",
				);
			}
		}

		// Files on disk with no in-memory index entry (unloaded store, or a
		// crash between append and index). Read-only listing shows them; it
		// never adopts or repairs.
		this.#collectStoredFiles(dir, "", sessionId, indexed, push);

		if (raw.length === 0) return null;
		const fileInfo: StoredFileInfo[] = raw.map((f) => ({
			relpath: f.relpath,
			kind: f.kind,
			...(f.kind !== "main" ? { parentPath: parentMainOf(mainRels, f.relpath) } : {}),
			bytes: f.bytes,
			ackedBytes: f.ackedBytes,
			eof: f.eof,
			status: f.status,
		}));
		const sorted = sortLineage(fileInfo);
		const bytes = sorted.reduce((sum, f) => sum + f.bytes, 0);
		const ackedBytes = sorted.reduce((sum, f) => (f.ackedBytes > 0 ? sum + f.ackedBytes : sum), 0);
		const missingAssets = sorted.filter((f) => f.status === "missing").length;
		const main = sorted.find((f) => f.kind === "main");
		let mtimeMs = 0;
		try {
			const st = statSync(dir);
			if (st.isDirectory()) mtimeMs = st.mtimeMs;
		} catch {
			// Directory vanished between the guard and now.
		}
		return {
			workspaceId,
			sessionId,
			files: sorted,
			bytes,
			ackedBytes,
			missingAssets,
			...(main ? { mainRelpath: main.relpath } : {}),
			mtimeMs,
		};
	}

	/** Recursive file walk of the session dir, excluding the sidecar and tmp files. */
	#collectStoredFiles(
		dir: string,
		prefix: string,
		sessionId: string,
		indexed: ReadonlySet<string>,
		push: (
			relpath: string,
			bytes: number,
			ackedBytes: number,
			eof: boolean,
			kind: StoredFileKind,
			status: StoredFileStatus,
		) => void,
	): void {
		const abs = prefix ? join(dir, prefix) : dir;
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === INDEX_NAME || entry.name.endsWith(TMP_SUFFIX)) continue;
			const relpath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const fileAbs = join(dir, relpath);
			let st;
			try {
				st = lstatSync(fileAbs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				this.#collectStoredFiles(dir, relpath, sessionId, indexed, push);
				continue;
			}
			if (!st.isFile() || indexed.has(relpath)) continue;
			push(
				relpath,
				st.size,
				0,
				false,
				classifyStoredRelpath(sessionId, relpath),
				st.size > 0 ? "stored" : "missing",
			);
		}
	}

	/**
	 * Every stored session of one workspace (sorted by sessionId), or an
	 * empty array for an unknown workspace. Never throws.
	 */
	listStoredSessions(workspaceId: string): StoredSessionInfo[] {
		if (!assertSafeComponentOrNull(workspaceId)) return [];
		const wsDir = join(this.rootDir, workspaceId);
		if (!isDirectory(wsDir)) return [];
		const out: StoredSessionInfo[] = [];
		for (const child of readdirSync(wsDir, { withFileTypes: true })) {
			if (!child.isDirectory()) continue;
			if (!assertSafeComponentOrNull(child.name)) continue;
			const info = this.storedLineage(workspaceId, child.name);
			if (info !== null) out.push(info);
		}
		return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
	}

	/**
	 * Every stored workspace under the store root (sorted by workspaceId),
	 * each with its full session list, durable bytes and read-only state.
	 * Never throws.
	 */
	listStoredWorkspaces(): StoredWorkspaceInfo[] {
		if (!isDirectory(this.rootDir)) return [];
		const out: StoredWorkspaceInfo[] = [];
		for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!assertSafeComponentOrNull(entry.name)) continue;
			const sessions = this.listStoredSessions(entry.name);
			if (sessions.length === 0) continue;
			out.push({
				workspaceId: entry.name,
				sessions,
				bytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
				readOnly: this.isReadOnly(entry.name),
			});
		}
		return out.sort((a, b) =>
			a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
		);
	}

	#restore(): void {
		if (!isDirectory(this.rootDir)) {
			mkdirSync(this.rootDir, { recursive: true });
			return;
		}
		const repair: RepairSink = (workspaceId, sessionId, entry) => {
			this.loadReport.repairs.push({ workspaceId, sessionId, ...entry });
		};
		for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const workspaceId = entry.name;
			try {
				assertSafeComponent(workspaceId, "workspaceId");
			} catch {
				repair(workspaceId, "", { kind: "skipped_invalid_dir" });
				continue;
			}
			const wsDir = join(this.rootDir, workspaceId);
			if (existsSync(join(wsDir, READONLY_MARKER))) this.#readOnly.add(workspaceId);
			for (const child of readdirSync(wsDir, { withFileTypes: true })) {
				if (!child.isDirectory()) continue;
				try {
					assertSafeComponent(child.name, "sessionId");
				} catch {
					repair(workspaceId, child.name, { kind: "skipped_invalid_dir" });
					continue;
				}
				this.#restoreSession(workspaceId, child.name, repair);
			}
		}
		let sessions = 0;
		let streams = 0;
		for (const bySession of this.#sessions.values()) {
			sessions += bySession.size;
			for (const state of bySession.values()) streams += state.streams.size;
		}
		this.loadReport.sessions = sessions;
		this.loadReport.streams = streams;
	}

	#restoreSession(workspaceId: string, sessionId: string, repair: RepairSink): SessionState {
		const dir = join(this.rootDir, workspaceId, sessionId);
		let dirty = false;
		const record = (entry: Omit<LogStoreRepair, "workspaceId" | "sessionId">) => {
			repair(workspaceId, sessionId, entry);
			dirty = true;
		};

		let index: LogStoreIndex | undefined;
		try {
			const parsed = JSON.parse(readFileSync(join(dir, INDEX_NAME), "utf8")) as LogStoreIndex;
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				parsed.version === 1 &&
				parsed.workspaceId === workspaceId &&
				parsed.sessionId === sessionId &&
				parsed.streams !== null &&
				typeof parsed.streams === "object" &&
				!Array.isArray(parsed.streams)
			) {
				index = parsed;
			}
		} catch {
			index = undefined;
		}
		if (!index) record({ kind: "rebuilt_missing_index" });

		// Leftover temp files from an interrupted atomic index rewrite.
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(TMP_SUFFIX)) {
				try {
					unlinkSync(join(dir, entry.name));
					record({ relpath: entry.name, kind: "removed_stale_tmp" });
				} catch {
					// Already gone; harmless.
				}
			}
		}

		const streams = new Map<string, StreamState>();
		const seen = new Set<string>();
		if (index) {
			for (const [relpath, entry] of Object.entries(index.streams)) {
				let clean: string;
				try {
					clean = assertSafeRelpath(relpath);
				} catch {
					record({ relpath, kind: "dropped_invalid_stream" });
					continue;
				}
				seen.add(clean);
				const state: StreamState = {
					generation:
						Number.isInteger(entry?.generation) && entry.generation >= 1 ? entry.generation : 1,
					ackedOffset:
						Number.isInteger(entry?.ackedOffset) && entry.ackedOffset >= 0 ? entry.ackedOffset : 0,
					eof: entry?.eof === true,
				};
				const file = join(dir, clean);
				const size = fileSize(file);
				if (size === undefined) {
					if (state.ackedOffset !== 0) {
						record({ relpath: clean, kind: "file_missing_reset", from: state.ackedOffset, to: 0 });
						state.ackedOffset = 0;
					}
				} else if (size !== state.ackedOffset) {
					const trusted = reconcileTail(file, size, state.ackedOffset);
					if (trusted !== size) truncateFile(file, trusted);
					record({
						relpath: clean,
						kind:
							trusted < size
								? "truncated_partial_tail"
								: trusted > state.ackedOffset
									? "file_longer_than_index"
									: "file_shorter_than_index",
						from: state.ackedOffset,
						to: trusted,
					});
					state.ackedOffset = trusted;
				}
				streams.set(clean, state);
			}
		}

		// Files on disk without an index entry: a crash between the append fsync
		// and the index rename. Adopt them at full-line length so the daemon's
		// resends below the adopted offset are dropped, never double-applied.
		const adopt = (prefix: string): void => {
			const abs = prefix ? join(dir, prefix) : dir;
			let entries: Dirent[];
			try {
				entries = readdirSync(abs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const relpath = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					adopt(relpath);
					continue;
				}
				if (!entry.isFile()) continue;
				if (relpath === INDEX_NAME || relpath.endsWith(TMP_SUFFIX) || seen.has(relpath)) continue;
				const file = join(dir, relpath);
				const size = fileSize(file) ?? 0;
				const trusted = size > 0 ? reconcileTail(file, size, 0) : 0;
				if (trusted !== size) truncateFile(file, trusted);
				streams.set(relpath, { generation: 1, ackedOffset: trusted, eof: false });
				record({ relpath, kind: "adopted_unindexed_file", from: size, to: trusted });
			}
		};
		adopt("");

		const state: SessionState = { workspaceId, sessionId, dir, streams };
		let bySession = this.#sessions.get(workspaceId);
		if (!bySession) {
			bySession = new Map();
			this.#sessions.set(workspaceId, bySession);
		}
		bySession.set(sessionId, state);
		if (dirty) this.#persistIndex(state);
		return state;
	}

	#ensureSession(workspaceId: string, sessionId: string): SessionState {
		const existing = this.#sessions.get(workspaceId)?.get(sessionId);
		if (existing) return existing;
		const dir = join(this.rootDir, workspaceId, sessionId);
		if (isDirectory(dir)) {
			// Session exists on disk but was not loaded (constructor-only usage).
			return this.#restoreSession(workspaceId, sessionId, (ws, sid, repair) => {
				this.loadReport.repairs.push({ workspaceId: ws, sessionId: sid, ...repair });
			});
		}
		const state: SessionState = { workspaceId, sessionId, dir, streams: new Map() };
		let bySession = this.#sessions.get(workspaceId);
		if (!bySession) {
			bySession = new Map();
			this.#sessions.set(workspaceId, bySession);
		}
		bySession.set(sessionId, state);
		return state;
	}

	/**
	 * Atomically rewrites the session index inside the ingest critical section:
	 * temp file + fsync, rename, parent dir fsync.
	 */
	#persistIndex(session: SessionState): void {
		mkdirSync(session.dir, { recursive: true });
		const streams: Record<string, LogStreamIndexEntry> = {};
		for (const relpath of [...session.streams.keys()].sort()) {
			const state = session.streams.get(relpath)!;
			streams[relpath] = {
				generation: state.generation,
				ackedOffset: state.ackedOffset,
				eof: state.eof,
			};
		}
		const index: LogStoreIndex = {
			version: 1,
			workspaceId: session.workspaceId,
			sessionId: session.sessionId,
			streams,
		};
		const target = join(session.dir, INDEX_NAME);
		const tmp = target + TMP_SUFFIX;
		const fd = openSync(tmp, "w");
		try {
			writeAllSync(fd, Buffer.from(JSON.stringify(index), "utf8"));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, target);
		fsyncDir(session.dir);
	}
}
