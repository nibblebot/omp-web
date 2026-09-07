/**
 * Daemon-side wake materialization (P8.9; docs/clone-contracts.md "Wake").
 * When a session transcript is cold or missing in the agent dir and a fleet
 * callback pair is active, the daemon requests the stored lineage bytes from
 * the fleet log store over the bulk channel and writes them into the agent
 * sessions layout BEFORE the existing resume path runs.
 *
 * Layout contract: the fleet log store mirrors the AGENT SESSIONS ROOT
 * byte-for-byte under `logs/<workspaceId>/<sessionId>/<relpath>`; each
 * received file is written to `<sessionsDir>/<relpath>`, recreating the SDK
 * project dir that owns the session on demand. The restored tree is exactly
 * what the SessionLogTailer streams (its sessionKey = the relpath of the
 * session's main file minus `.jsonl`).
 *
 * Transfer model: one request/response pair is one 64 MiB correlation.
 * Larger session subtrees split across sequential correlations; only the
 * final file of a transfer may straddle the boundary. A straddled file is
 * accumulated in a same-dir temp file across transfers and committed only
 * when its declared size is reached, so memory stays bounded regardless of
 * file size. Every file record carries the FULL-file sha256; the daemon
 * re-hashes the accumulated bytes at completion and verifies size + digest
 * BEFORE the temp is renamed over the target. Files are fsynced before
 * rename; parents are fsynced on first creation.
 *
 * Safety: every received relpath is validated with the frozen manifest
 * predicate (isNormalizedPosixRelativePath — no `..`, no absolute, no `.`
 * segments) and the resolved target must stay inside the sessions dir BEFORE
 * any file is opened. Any hostile or malformed record aborts the WHOLE
 * materialization with nothing committed and all temps removed.
 *
 * Typed failures reuse the frozen vocabulary only: `unavailable` when there
 * is no ready callback pair or the fleet lacks the session; `invalid_request`
 * for malformed wire records (hostile relpaths, size/sha mismatch, chunk
 * gaps); `retryable` passes through for transport hiccups. No new error
 * names.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	renameSync,
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
}

const TEMP_PREFIX = ".omp-materialize-";
const HASH_BUFFER_BYTES = 256 * 1024;

function invalid(message: string, relpath?: string): MaterializeSessionError {
	return new MaterializeSessionError("invalid_request", message, relpath);
}

/**
 * Request, verify and commit one materialized session subtree. All sequential
 * correlations must succeed before every declared file is committed; a
 * hostile or malformed record aborts with nothing committed and temps
 * removed. Returns the committed file/byte counts.
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
	const realSessionsDir = resolveRealDir(sessionsDir);

	const pending = new Map<string, PendingFile>();
	let committed = 0;
	let bytesReceived = 0;
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
			const outcome = applyTransfer(realSessionsDir, result.records, sessionId, pending);
			committed += outcome.committed;
			bytesReceived += outcome.bytesReceived;
			if (!outcome.more) break;
			if (outcome.cursor === undefined) {
				throw new MaterializeSessionError(
					"invalid_request",
					`materialization end record for session ${sessionId} omitted its continuation cursor`,
				);
			}
			cursor = outcome.cursor;
		}
		return { files: committed, bytes: bytesReceived };
	} finally {
		for (const file of pending.values()) {
			try {
				rmSync(file.tempPath, { force: true });
			} catch {
				// Best effort cleanup.
			}
		}
	}
}

interface TransferOutcome {
	committed: number;
	/** Chunk payload bytes applied in this transfer. */
	bytesReceived: number;
	more: boolean;
	cursor: { path: string; offset: number } | undefined;
}

/**
 * Validate and apply ONE transfer's records against the pending map.
 * File declarations validate relpaths before any write; chunks append to the
 * declared file's temp with per-transfer offset contiguity; a file reaching
 * its declared size is fsynced, re-hashed, verified and renamed into place.
 */
function applyTransfer(
	realSessionsDir: string,
	records: MaterializeRecord[],
	expectedSessionId: string,
	pending: Map<string, PendingFile>,
): TransferOutcome {
	// Pass 1: file declarations (validate before any byte hits disk).
	let sawLead = false;
	for (const record of records) {
		if (record.type !== "file") continue;
		assertSafeRelpath(record.relpath, realSessionsDir);
		const existing = pending.get(record.relpath);
		if (existing !== undefined) {
			if (existing.size !== record.size || existing.sha256 !== record.sha256) {
				throw invalid(`file ${record.relpath} re-declared with a different size/sha256`);
			}
			if (record.offset !== existing.written) {
				throw invalid(
					`file ${record.relpath} re-declared at offset ${record.offset}, expected ${existing.written}`,
				);
			}
		} else {
			if (record.offset !== 0) {
				throw invalid(
					`file ${record.relpath} declared at offset ${record.offset} with no prior transfers`,
				);
			}
			const targetPath = join(realSessionsDir, record.relpath);
			const tempName = `${TEMP_PREFIX}${process.pid}-${record.relpath.replace(/\//g, "_")}.tmp`;
			pending.set(record.relpath, {
				relpath: record.relpath,
				size: record.size,
				sha256: record.sha256,
				kind: record.kind,
				written: 0,
				tempPath: join(dirname(targetPath), tempName),
				targetPath,
			});
		}
	}

	let more = false;
	let endCursor: { path: string; offset: number } | undefined;
	const committedRelpaths: string[] = [];
	let bytesReceived = 0;

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
					const file = pending.get(record.relpath);
					if (file === undefined) throw invalid(`chunk for undeclared file ${record.relpath}`);
					bytesReceived += Buffer.byteLength(record.data, "base64");
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
		throw error instanceof Error
			? new MaterializeSessionError("unavailable", error.message)
			: new MaterializeSessionError("unavailable", String(error));
	}

	// Commit every pending file that reached its declared size.
	for (const [relpath, file] of [...pending]) {
		if (file.written !== file.size) continue;
		commitPendingFile(file);
		pending.delete(relpath);
		committedRelpaths.push(relpath);
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

	return { committed: committedRelpaths.length, bytesReceived, more, cursor: endCursor };
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
	const fd = openSync(file.tempPath, "a");
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

/** Fsync + re-hash + verify + rename the completed temp into place. */
function commitPendingFile(file: PendingFile): void {
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
	renameSync(file.tempPath, file.targetPath);
	fsyncDir(dirname(file.targetPath));
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

/** Resolve the deepest existing ancestor of `dir` as a real absolute path. */
function resolveRealDir(dir: string): string {
	let current = dir;
	for (;;) {
		try {
			const stats = statSync(current);
			return stats.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

function assertSafeRelpath(relpath: string, realSessionsDir: string): void {
	if (typeof relpath !== "string" || !isNormalizedPosixRelativePath(relpath)) {
		throw invalid(`refused an unsafe relpath: ${JSON.stringify(relpath)}`, relpath);
	}
	const resolved = join(realSessionsDir, relpath);
	if (!isInside(realSessionsDir, resolved)) {
		throw invalid(`relpath escapes the sessions dir: ${JSON.stringify(relpath)}`, relpath);
	}
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
		const code = (error as Error & { code?: unknown }).code;
		if (code === "unavailable" || code === "invalid_request" || code === "retryable") {
			return new MaterializeSessionError(code as MaterializeSessionErrorCode, error.message);
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

/** True when the sessions tree already has ANY file for this session (main
 * file or artifact dir) — the daemon skips materialization when warm. */
export function sessionTreeExists(sessionsDir: string, sessionId: string): boolean {
	const probes = [join(sessionsDir, `${sessionId}.jsonl`), join(sessionsDir, sessionId)];
	let entries;
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return probes.some(probeExists);
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		probes.push(join(sessionsDir, entry.name, `${sessionId}.jsonl`));
		probes.push(join(sessionsDir, entry.name, sessionId));
	}
	return probes.some(probeExists);
}

/**
 * Resolve the absolute main-session JSONL of `sessionId` under a sessions
 * dir: `<sessionId>.jsonl` at depth 1 or `<proj>/<sessionId>.jsonl` at
 * depth 2 (the frozen layout; bounded scan, no traversal — mirrors the
 * fleet-side resolver in fleet/wake-materialize.ts so both halves agree).
 * Returns null when the session's main file is cold/missing.
 */
export function resolveSessionMainFile(sessionsDir: string, sessionId: string): string | null {
	if (typeof sessionsDir !== "string" || sessionsDir.length === 0) return null;
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
		return null;
	}
	const probe = (dir: string): string | null => {
		const candidate = join(dir, `${sessionId}.jsonl`);
		try {
			return statSync(candidate).isFile() ? candidate : null;
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
		if (!entry.isDirectory()) continue;
		const found = probe(join(sessionsDir, entry.name));
		if (found !== null) return found;
	}
	return null;
}

function probeExists(absolute: string): boolean {
	try {
		const stats = statSync(absolute);
		return stats.isFile() || stats.isDirectory();
	} catch {
		return false;
	}
}
