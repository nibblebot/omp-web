/**
 * Daemon-side wake materialization (P8.9; docs/clone-contracts.md "Wake"):
 * pull a cold session's stored lineage over the bulk channel and write it into
 * the agent sessions root before the resume path runs. Only the session's MAIN
 * transcript (resolveSessionMainFile) makes a session warm; an assets-only
 * store cannot be resumed and is reported `unavailable`.
 *
 * Invariants:
 * - Fill-missing only: an existing volume file is never rewritten. The fleet
 *   store can lag the live volume, whose descendant/advisor/asset bytes may
 *   hold a newer unacknowledged tail.
 * - All-or-nothing: completed files are staged (fsynced, size + sha256
 *   verified) and linked into place only after the whole transfer, and only
 *   when the committed result holds a genuine regular non-empty main; on any
 *   failure every file this call linked is rolled back and every temp removed.
 * - No escape: each relpath's existing components are lstat-checked (no
 *   symlinked root/parent/leaf), temps open O_EXCL|O_NOFOLLOW, and commits use
 *   link(2), which cannot replace an existing target. This bounds — it does not
 *   promise immunity to — a hostile same-uid process racing those checks.
 *
 * Typed failures reuse the frozen vocabulary only: `unavailable` (no pair or
 * store, IO failure, no genuine main), `invalid_request` (hostile relpath or
 * symlinked path, size/sha mismatch, chunk gaps), `retryable` passthrough.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isNormalizedPosixRelativePath, type ManifestFileKind } from "../shared/archive-manifest";
import type { MaterializeChunkRecord, MaterializeRecord } from "../shared/wake-materialize";
import type { MaterializeResult } from "./fleet-callback";

export type MaterializeSessionErrorCode = "unavailable" | "invalid_request" | "retryable";

export class MaterializeSessionError extends Error {
	constructor(
		readonly code: MaterializeSessionErrorCode,
		message: string,
		readonly relpath?: string,
	) {
		super(message);
		this.name = "MaterializeSessionError";
	}
}

/** Transport seam for the wake transfer loop (injectable for tests). */
export interface MaterializeTransport {
	requestBulkMaterialize(request: {
		type: "materialize_session";
		sessionId: string;
		cursor?: { path: string; offset: number };
	}): Promise<MaterializeResult | null>;
}

/** One file's cross-transfer accumulation state. */
interface PendingFile {
	relpath: string;
	/** Declared full-file size (bytes). */
	size: number;
	/** Declared full-file sha256 (hex). */
	sha256: string;
	kind: ManifestFileKind;
	/** Bytes accumulated so far across transfers. */
	written: number;
	tempPath: string;
	targetPath: string;
	/** True once the O_EXCL create has seeded the temp. */
	started: boolean;
}

/** Result of validating one relpath and probing its resolved target. */
interface TargetProbe {
	targetPath: string;
	/** True when the leaf already exists as a regular file (never clobbered). */
	existsAsFile: boolean;
}

/** Inode identity of a file this call linked, used to roll back only our own. */
interface LinkedFile {
	path: string;
	dev: number;
	ino: number;
}

interface CommitOutcome {
	files: number;
	bytes: number;
	/** Every file this commit linked, for rollback on a later failure. */
	linked: LinkedFile[];
}

const TEMP_PREFIX = ".omp-materialize-";
const HASH_BUFFER_BYTES = 256 * 1024;

function invalid(message: string, relpath?: string): MaterializeSessionError {
	return new MaterializeSessionError("invalid_request", message, relpath);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True when `error` carries the frozen callback error vocabulary. */
function isFrozenErrorCode(value: unknown): value is MaterializeSessionErrorCode {
	return value === "unavailable" || value === "invalid_request" || value === "retryable";
}

/** Best-effort removal shared by the abort path, the commit skip and rollback. */
function removeTemp(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Best effort: a leaked temp beats failing a transfer that succeeded.
	}
}

/**
 * Request, verify and commit one materialized session subtree. Existing volume
 * files are preserved; a hostile, malformed or broken transfer aborts with
 * nothing committed; a commit that does not yield a genuine main is rolled
 * back. Returns the committed file/byte counts.
 */
export async function materializeSessionToDir(
	sessionsDir: string,
	sessionId: string,
	transport: MaterializeTransport,
): Promise<{ files: number; bytes: number }> {
	if (typeof sessionsDir !== "string" || sessionsDir.length === 0) {
		throw new MaterializeSessionError("invalid_request", "requires a sessions dir");
	}
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new MaterializeSessionError("invalid_request", "requires a sessionId");
	}
	mkdirSync(sessionsDir, { recursive: true });
	const sessionsRoot = requireSessionsRoot(sessionsDir);

	// Files receiving bytes but not yet complete (the single transfer
	// straddle); completed + hash-verified files awaiting commit; and volume
	// files preserved untouched.
	const pending = new Map<string, PendingFile>();
	const staged = new Map<string, PendingFile>();
	const skipped = new Set<string>();
	let cursor: { path: string; offset: number } | undefined;
	try {
		for (;;) {
			let result: MaterializeResult | null;
			try {
				result = await transport.requestBulkMaterialize({
					type: "materialize_session",
					sessionId,
					...(cursor !== undefined ? { cursor } : {}),
				});
			} catch (error) {
				throw transferError(error, sessionId);
			}
			if (result === null) {
				throw new MaterializeSessionError(
					"unavailable",
					`materialization unavailable: the fleet has no stored transcripts for session ${sessionId}`,
				);
			}
			if (result.records.length === 0) {
				throw new MaterializeSessionError(
					"invalid_request",
					`materialization returned an empty transfer for session ${sessionId}`,
				);
			}
			const outcome = applyTransfer(
				sessionsRoot,
				result.records,
				sessionId,
				pending,
				staged,
				skipped,
			);
			if (!outcome.more) break;
			if (outcome.cursor === undefined) {
				throw new MaterializeSessionError(
					"invalid_request",
					`materialization end record for session ${sessionId} omitted its continuation cursor`,
				);
			}
			cursor = outcome.cursor;
		}
		const commit = commitStagedFiles(sessionsRoot, staged);
		// Success is a genuine main on the volume, not merely a staged byte
		// stream: an assets-only (or wrong-layout) transfer must leave nothing.
		if (resolveSessionMainFile(sessionsRoot, sessionId) === null) {
			rollbackLinked(commit.linked);
			throw new MaterializeSessionError(
				"unavailable",
				`materialization restored no regular non-empty main transcript for session ${sessionId}`,
			);
		}
		return { files: commit.files, bytes: commit.bytes };
	} finally {
		for (const file of [...pending.values(), ...staged.values()]) removeTemp(file.tempPath);
	}
}

interface TransferOutcome {
	more: boolean;
	cursor: { path: string; offset: number } | undefined;
}

/**
 * Validate and apply ONE transfer: declarations validate every relpath/target
 * (and skip existing volume files) before any write; chunks append with
 * per-transfer offset contiguity; a file reaching its declared size is
 * fsynced, re-hashed, verified and moved to `staged`, never linked yet.
 */
function applyTransfer(
	sessionsRoot: string,
	records: MaterializeRecord[],
	expectedSessionId: string,
	pending: Map<string, PendingFile>,
	staged: Map<string, PendingFile>,
	skipped: Set<string>,
): TransferOutcome {
	// Pass 1: file declarations (validate before any byte hits disk).
	let sawLead = false;
	for (const record of records) {
		if (record.type !== "file") continue;
		const probe = assertSafeTarget(record.relpath, sessionsRoot);
		const existing = pending.get(record.relpath) ?? staged.get(record.relpath);
		if (existing !== undefined) {
			if (existing.size !== record.size || existing.sha256 !== record.sha256) {
				throw invalid(`file ${record.relpath} re-declared with a different size/sha256`);
			}
			if (record.offset !== existing.written) {
				throw invalid(
					`file ${record.relpath} re-declared at offset ${record.offset}, expected ${existing.written}`,
				);
			}
			continue;
		}
		if (skipped.has(record.relpath)) continue;
		if (probe.existsAsFile) {
			// Fill-missing only: the volume copy may be newer than the store.
			skipped.add(record.relpath);
			continue;
		}
		if (record.offset !== 0) {
			throw invalid(
				`file ${record.relpath} declared at offset ${record.offset} with no prior transfers`,
			);
		}
		const tempName = `${TEMP_PREFIX}${process.pid}-${record.relpath.replace(/\//g, "_")}.tmp`;
		pending.set(record.relpath, {
			relpath: record.relpath,
			size: record.size,
			sha256: record.sha256,
			kind: record.kind,
			written: 0,
			tempPath: join(dirname(probe.targetPath), tempName),
			targetPath: probe.targetPath,
			started: false,
		});
	}

	let more = false;
	let endCursor: { path: string; offset: number } | undefined;
	try {
		for (const record of records) {
			switch (record.type) {
				case "session": {
					if (record.sessionId !== expectedSessionId) {
						throw invalid(
							`materialization lead names session ${record.sessionId}, expected ${expectedSessionId}`,
						);
					}
					sawLead = true;
					break;
				}
				case "file":
					break; // Pass 1 handled declarations.
				case "chunk": {
					if (!sawLead) throw invalid("chunk arrived before the session lead record");
					if (skipped.has(record.relpath)) break; // Preserved file: ignore its bytes.
					const file = pending.get(record.relpath);
					if (file === undefined) throw invalid(`chunk for undeclared file ${record.relpath}`);
					appendChunk(file, record);
					break;
				}
				case "end": {
					more = record.more;
					endCursor = record.cursor;
					break;
				}
			}
		}
	} catch (error) {
		if (error instanceof MaterializeSessionError) throw error;
		throw new MaterializeSessionError("unavailable", errorMessage(error));
	}

	// Stage (never commit) every pending file that reached its declared size.
	for (const [relpath, file] of [...pending]) {
		if (file.written !== file.size) continue;
		verifyPendingFile(file);
		pending.delete(relpath);
		staged.set(relpath, file);
	}

	// A leftover pending file must be the single straddle the end cursor names.
	if (pending.size > 0) {
		if (pending.size > 1) {
			throw invalid("multiple files straddle the transfer boundary");
		}
		const [relpath, file] = [...pending][0]!;
		if (!more || endCursor === undefined) {
			throw invalid(`file ${relpath} is incomplete but the transfer did not request continuation`);
		}
		if (endCursor.path !== relpath || endCursor.offset !== file.written) {
			throw invalid(
				`continuation cursor ${endCursor.path}@${endCursor.offset} does not match pending file ${relpath}@${file.written}`,
			);
		}
	}

	return { more, cursor: endCursor };
}

function appendChunk(file: PendingFile, chunk: MaterializeChunkRecord): void {
	if (chunk.offset !== file.written) {
		throw invalid(
			`chunk gap for ${file.relpath}: expected offset ${file.written}, got ${chunk.offset}`,
		);
	}
	const data = Buffer.from(chunk.data, "base64");
	if (data.length === 0) return;
	if (file.written + data.length > file.size) {
		throw invalid(`chunk overruns declared size for ${file.relpath}`, file.relpath);
	}
	mkdirSync(dirname(file.tempPath), { recursive: true });
	// O_EXCL seeds the temp once (a pre-existing/symlinked temp fails loudly);
	// later appends never create or follow one.
	const flags = file.started
		? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
		: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
	const fd = openSync(file.tempPath, flags);
	file.started = true;
	try {
		let offset = 0;
		while (offset < data.length) {
			const written = writeSync(fd, data, offset, data.length - offset);
			if (written <= 0) throw new Error("short write during materialization");
			offset += written;
		}
	} finally {
		closeSync(fd);
	}
	file.written += data.length;
}

/** Fsync + re-hash + verify the completed temp (staged, not yet linked). */
function verifyPendingFile(file: PendingFile): void {
	const fd = openSync(file.tempPath, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const size = statSync(file.tempPath).size;
	if (size !== file.size) {
		throw invalid(`size mismatch for ${file.relpath}: declared ${file.size}, received ${size}`);
	}
	if (sha256FileSync(file.tempPath) !== file.sha256) {
		throw invalid(`sha256 mismatch for ${file.relpath}`, file.relpath);
	}
}

/**
 * Link every staged temp into place. A target re-checked as an existing regular
 * file — or one that appears as a regular file (EEXIST) — is preserved; an
 * unsafe target/parent or any other link failure is typed and propagates after
 * the files this call already linked are rolled back.
 */
function commitStagedFiles(sessionsRoot: string, staged: Map<string, PendingFile>): CommitOutcome {
	const linked: LinkedFile[] = [];
	let files = 0;
	let bytes = 0;
	try {
		for (const file of staged.values()) {
			const probe = assertSafeTarget(file.relpath, sessionsRoot);
			if (probe.existsAsFile) {
				removeTemp(file.tempPath);
				continue;
			}
			try {
				linkSync(file.tempPath, file.targetPath);
			} catch (error) {
				if (
					!(
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "EEXIST"
					)
				) {
					throw linkError(error, file.relpath);
				}
				// link(2) lost the race: preserve only a genuine regular file.
				const appeared = assertSafeTarget(file.relpath, sessionsRoot);
				if (!appeared.existsAsFile) {
					throw invalid(
						`materialization target appeared but is not a regular file: ${file.relpath}`,
						file.relpath,
					);
				}
				removeTemp(file.tempPath);
				continue;
			}
			const stats = lstatSync(file.tempPath);
			linked.push({ path: file.targetPath, dev: stats.dev, ino: stats.ino });
			removeTemp(file.tempPath);
			fsyncDir(dirname(file.targetPath));
			files += 1;
			bytes += file.size;
		}
	} catch (error) {
		rollbackLinked(linked);
		throw error;
	}
	return { files, bytes, linked };
}

/** Unlink only files this call linked: a replacement keeps its inode, so it survives. */
function rollbackLinked(linked: LinkedFile[]): void {
	for (const entry of linked) {
		let stats;
		try {
			stats = lstatSync(entry.path);
		} catch {
			continue;
		}
		if (stats.dev === entry.dev && stats.ino === entry.ino) removeTemp(entry.path);
	}
}

/** Map a link(2) failure onto the typed vocabulary (IO conditions are unavailable). */
function linkError(error: unknown, relpath: string): MaterializeSessionError {
	if (error instanceof MaterializeSessionError) return error;
	if (error instanceof Error && "code" in error && isFrozenErrorCode(error.code)) {
		return new MaterializeSessionError(error.code, error.message, relpath);
	}
	return new MaterializeSessionError(
		"unavailable",
		`materialization link failed for ${relpath}: ${errorMessage(error)}`,
		relpath,
	);
}

/** Streaming sync sha256 over a file (bounded memory). */
function sha256FileSync(absolutePath: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absolutePath, "r");
	const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
	try {
		let offset = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, offset);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
			offset += read;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** Refuse a symlinked/non-directory sessions root (it would redirect writes). */
function requireSessionsRoot(sessionsDir: string): string {
	let stats;
	try {
		stats = lstatSync(sessionsDir);
	} catch (error) {
		throw new MaterializeSessionError(
			"unavailable",
			`sessions dir is unavailable: ${errorMessage(error)}`,
		);
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw invalid(`refusing a non-directory sessions root: ${sessionsDir}`);
	}
	return sessionsDir;
}

/**
 * Validate a wire relpath and its resolved target before any write: reject a
 * hostile relpath; every existing component must be a real directory and an
 * existing leaf a regular file (a symlinked parent/leaf could redirect a
 * write outside the root). Returns whether the leaf already exists as a file.
 */
function assertSafeTarget(relpath: string, sessionsRoot: string): TargetProbe {
	if (typeof relpath !== "string" || !isNormalizedPosixRelativePath(relpath)) {
		throw invalid(`refused an unsafe relpath: ${JSON.stringify(relpath)}`, relpath);
	}
	const targetPath = join(sessionsRoot, relpath);
	if (!isInside(sessionsRoot, targetPath)) {
		throw invalid(`relpath escapes the sessions dir: ${JSON.stringify(relpath)}`, relpath);
	}
	const parts = relpath.split("/");
	let current = sessionsRoot;
	for (let i = 0; i < parts.length; i += 1) {
		current = join(current, parts[i]!);
		const leaf = i === parts.length - 1;
		let stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return { targetPath, existsAsFile: false };
			}
			throw invalid(
				`cannot inspect materialization target ${relpath}: ${errorMessage(error)}`,
				relpath,
			);
		}
		if (leaf) {
			if (stats.isSymbolicLink()) throw invalid(`refused a symlinked target: ${relpath}`, relpath);
			if (!stats.isFile()) {
				throw invalid(`materialization target is not a regular file: ${relpath}`, relpath);
			}
			return { targetPath, existsAsFile: true };
		}
		if (stats.isSymbolicLink()) throw invalid(`refused a symlinked parent of ${relpath}`, relpath);
		if (!stats.isDirectory()) {
			throw invalid(`materialization parent is not a directory: ${relpath}`, relpath);
		}
	}
	return { targetPath, existsAsFile: false };
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function fsyncDir(dir: string): void {
	let fd: number;
	try {
		fd = openSync(dir, "r");
	} catch {
		return; // Best effort.
	}
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function transferError(error: unknown, sessionId: string): MaterializeSessionError {
	if (error instanceof MaterializeSessionError) return error;
	if (error instanceof Error) {
		if ("code" in error && isFrozenErrorCode(error.code)) {
			return new MaterializeSessionError(error.code, error.message);
		}
		return new MaterializeSessionError(
			"unavailable",
			`materialization request failed for session ${sessionId}: ${error.message}`,
		);
	}
	return new MaterializeSessionError(
		"unavailable",
		`materialization request failed for session ${sessionId}: ${String(error)}`,
	);
}

/**
 * Resolve the absolute main-session JSONL of `sessionId` under a sessions dir:
 * `<sessionId>.jsonl` at depth 1 or `<proj>/<sessionId>.jsonl` at depth 2 (the
 * frozen layout). Only a real, regular, non-empty file counts — a symlinked
 * root, project dir or main is never warm proof. Returns null when cold.
 */
export function resolveSessionMainFile(sessionsDir: string, sessionId: string): string | null {
	if (typeof sessionsDir !== "string" || sessionsDir.length === 0) return null;
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
		return null;
	}
	let rootStats;
	try {
		rootStats = lstatSync(sessionsDir);
	} catch {
		return null;
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return null;
	const probe = (dir: string): string | null => {
		const candidate = join(dir, `${sessionId}.jsonl`);
		try {
			const stats = lstatSync(candidate);
			return stats.isFile() && stats.size > 0 ? candidate : null;
		} catch {
			return null;
		}
	};
	const root = probe(sessionsDir);
	if (root !== null) return root;
	let entries;
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		// A symlinked project dir is never an ancestor for warm proof.
		if (!entry.isDirectory()) continue;
		const found = probe(join(sessionsDir, entry.name));
		if (found !== null) return found;
	}
	return null;
}
