/**
 * Wake materialization wire contract.
 * A cold or missing session transcript is materialized from the
 * fleet log store into the session's agent dir BEFORE the existing resume path
 * runs. The transfer rides the bulk channel: the session initiates
 * `POST /callback/bulk/<correlationId>` with a small JSON
 * {@link MaterializeRequest} body under a fresh session-minted correlation id,
 * and the fleet serves the stored bytes as an `application/x-ndjson` response
 * of {@link MaterializeRecord}s under that correlation. One transfer is
 * bounded by BULK_MAX_BYTES (64 MiB); larger transcripts split across
 * sequential correlation ids via the cursor carried by the `end` record.
 *
 * Relpath semantics: the fleet log store mirrors the AGENT SESSIONS ROOT
 * (`<agentDir>/sessions`) byte-for-byte under
 * `logs/<workspaceId>/<sessionId>/<relpath>`. The session subtree roots at
 * the SDK project dir that owns the session: relpaths like
 * `<encoded-cwd-dir>/<session>.jsonl`, `<encoded-cwd-dir>/<session>/…`, or
 * `<session>/…` for session-root artifacts. The session writes each received
 * file to `<agentDir>/sessions/<relpath>`, recreating the owning project dir
 * on demand, so the store subtree maps 1:1 onto the tailer's sessionKey
 * layout (apps/session/log-tailer.ts). Materialization therefore restores exactly
 * the tree the tailer streams.
 *
 * Identity and credentials travel in the usual callback request headers; the
 * transport registry authenticates the POST exactly like a bulk upload before
 * the materialization branch runs.
 *
 * Typed failures reuse the frozen vocabulary only: `invalid_request` for
 * malformed requests/records, `unavailable` when the fleet lacks the session
 * (or no pair exists session-side). No new error names.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { isNormalizedPosixRelativePath, type ManifestFileKind } from "./archive-manifest";
import { BULK_MAX_BYTES, callbackError } from "#lib/wire/callback-protocol";

/** Request type literal for the materialization branch of the bulk route. */
export const MATERIALIZE_REQUEST_TYPE = "materialize_session";

/** Cap on the small JSON request body the session POSTs per transfer. */
export const MATERIALIZE_REQUEST_MAX_BYTES = 64 * 1024;

/**
 * Raw bytes per chunk record. Base64 inflates 4/3, so one serialized chunk
 * record stays well under the 1 MiB NDJSON parser cap both halves share with
 * the envelope parser.
 */
export const MATERIALIZE_CHUNK_RAW_BYTES = 512 * 1024;

/** Resume point for a transcript larger than one 64 MiB transfer. */
export interface MaterializeCursor {
	/** Relpath (sessions-root-relative, POSIX) of the file to resume at. */
	path: string;
	/** Byte offset within that file; 0 restarts the file (record re-emitted). */
	offset: number;
}

/** Session → fleet request body of one bulk transfer. */
export interface MaterializeRequest {
	type: typeof MATERIALIZE_REQUEST_TYPE;
	/** SDK SessionHeader.id whose stored lineage subtree is requested. */
	sessionId: string;
	/** Continuation from a previous transfer's `end` record. */
	cursor?: MaterializeCursor;
}

/** First record of every transfer; keeps each correlation self-describing. */
export interface MaterializeSessionRecord {
	type: "session";
	workspaceId: string;
	sessionId: string;
}

/**
 * File declaration. `relpath` is POSIX-relative to the requested session
 * subtree (normalized: no `..`, no absolute, no `.` segments); the session
 * validates it with isNormalizedPosixRelativePath and refuses anything else.
 * `sha256` covers the FULL file bytes; the session verifies it after
 * reassembling every chunk of the file (which may span transfers).
 */
export interface MaterializeFileRecord {
	type: "file";
	relpath: string;
	size: number;
	sha256: string;
	kind: ManifestFileKind;
	/** Byte offset the first chunk record of this file carries (resume point). */
	offset: number;
}

/** Raw bytes of one file at `offset`; `data` is base64, no reinterpretation. */
export interface MaterializeChunkRecord {
	type: "chunk";
	relpath: string;
	offset: number;
	data: string;
}

/** Terminal record of one transfer. `more` + `cursor` request continuation. */
export interface MaterializeEndRecord {
	type: "end";
	more: boolean;
	cursor?: MaterializeCursor;
}

export type MaterializeRecord =
	| MaterializeSessionRecord
	| MaterializeFileRecord
	| MaterializeChunkRecord
	| MaterializeEndRecord;

/**
 * Parse a bulk POST body as a materialization request. Returns null when the
 * body is NOT a materialization request (the caller falls back to the upload
 * path); throws `invalid_request` when it IS one but malformed.
 */
export function parseMaterializeRequest(value: unknown): MaterializeRequest | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (v.type !== MATERIALIZE_REQUEST_TYPE) return null;
	const fail = (detail: string): never => {
		throw callbackError("invalid_request", `invalid materialize request: ${detail}`);
	};
	if (typeof v.sessionId !== "string" || v.sessionId.length === 0) {
		fail("sessionId must be a non-empty string");
	}
	const sessionId = v.sessionId as string;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId.includes("..")) {
		fail(`sessionId ${JSON.stringify(sessionId)} is not a safe store component`);
	}
	let cursor: MaterializeCursor | undefined;
	if (v.cursor !== undefined) {
		if (v.cursor === null || typeof v.cursor !== "object" || Array.isArray(v.cursor)) {
			fail("cursor must be an object {path, offset}");
		}
		const c = v.cursor as Record<string, unknown>;
		if (typeof c.path !== "string" || !isNormalizedPosixRelativePath(c.path)) {
			fail("cursor.path must be a normalized POSIX-relative path");
		}
		if (typeof c.offset !== "number" || !Number.isSafeInteger(c.offset) || c.offset < 0) {
			fail("cursor.offset must be a non-negative integer");
		}
		cursor = { path: c.path as string, offset: c.offset as number };
	}
	return {
		type: MATERIALIZE_REQUEST_TYPE,
		sessionId,
		...(cursor !== undefined ? { cursor } : {}),
	};
}

/** Validate one NDJSON response record; throws `invalid_request` on any drift. */
export function parseMaterializeRecord(value: unknown): MaterializeRecord {
	const fail = (detail: string): never => {
		throw callbackError("invalid_request", `invalid materialize record: ${detail}`);
	};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail("record must be an object");
	}
	const v = value as Record<string, unknown>;
	switch (v.type) {
		case "session": {
			if (typeof v.workspaceId !== "string" || typeof v.sessionId !== "string") {
				fail("session record requires workspaceId and sessionId strings");
			}
			return {
				type: "session",
				workspaceId: v.workspaceId as string,
				sessionId: v.sessionId as string,
			};
		}
		case "file": {
			if (typeof v.relpath !== "string" || !isNormalizedPosixRelativePath(v.relpath)) {
				fail(`file relpath ${JSON.stringify(v.relpath)} is not a normalized POSIX-relative path`);
			}
			if (
				typeof v.size !== "number" ||
				!Number.isSafeInteger(v.size) ||
				v.size < 0 ||
				typeof v.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(v.sha256) ||
				typeof v.offset !== "number" ||
				!Number.isSafeInteger(v.offset) ||
				v.offset < 0
			) {
				fail(`file record for ${JSON.stringify(v.relpath)} has a bad size/sha256/offset`);
			}
			const kindValue = v.kind;
			if (
				kindValue !== "main" &&
				kindValue !== "subagent" &&
				kindValue !== "advisor" &&
				kindValue !== "metadata"
			) {
				fail(
					`file record for ${JSON.stringify(v.relpath)} has unknown kind ${JSON.stringify(kindValue)}`,
				);
			}
			const kind = kindValue as ManifestFileKind;
			return {
				type: "file",
				relpath: v.relpath as string,
				size: v.size as number,
				sha256: v.sha256 as string,
				kind,
				offset: v.offset as number,
			};
		}
		case "chunk": {
			if (typeof v.relpath !== "string" || !isNormalizedPosixRelativePath(v.relpath)) {
				fail(`chunk relpath ${JSON.stringify(v.relpath)} is not a normalized POSIX-relative path`);
			}
			if (
				typeof v.offset !== "number" ||
				!Number.isSafeInteger(v.offset) ||
				v.offset < 0 ||
				typeof v.data !== "string"
			) {
				fail(`chunk record for ${JSON.stringify(v.relpath)} has a bad offset/data`);
			}
			return {
				type: "chunk",
				relpath: v.relpath as string,
				offset: v.offset as number,
				data: v.data as string,
			};
		}
		case "end": {
			if (typeof v.more !== "boolean") fail("end record requires a boolean more");
			const more = v.more as boolean;
			let cursor: MaterializeCursor | undefined;
			if (v.cursor !== undefined) {
				if (v.cursor === null || typeof v.cursor !== "object" || Array.isArray(v.cursor)) {
					fail("end cursor must be an object {path, offset}");
				}
				const c = v.cursor as Record<string, unknown>;
				if (typeof c.path !== "string" || !isNormalizedPosixRelativePath(c.path)) {
					fail("end cursor.path must be a normalized POSIX-relative path");
				}
				if (typeof c.offset !== "number" || !Number.isSafeInteger(c.offset) || c.offset < 0) {
					fail("end cursor.offset must be a non-negative integer");
				}
				cursor = { path: c.path as string, offset: c.offset as number };
			}
			if (more === true && cursor === undefined) {
				fail("end record with more=true requires a cursor");
			}
			return { type: "end", more, ...(cursor !== undefined ? { cursor } : {}) };
		}
		default:
			fail(`unknown record type ${JSON.stringify(v.type)}`);
			break;
	}
	return fail(`record type ${JSON.stringify(v.type)} was not handled`);
}

/** Serialize one response record as a complete NDJSON line (trailing \n). */
export function encodeMaterializeRecord(record: MaterializeRecord): string {
	return `${JSON.stringify(record)}\n`;
}

/** Default per-transfer response budget: the frozen bulk cap. */
export const MATERIALIZE_TRANSFER_MAX_BYTES = BULK_MAX_BYTES;

// ---------------------------------------------------------------------------
// Fleet-side plan + transfer emission: the fleet half builds a sorted,
// validated file plan for a session subtree and emits one transfer's records
// honoring the request cursor and the byte budget. Shared with the transport
// registry and tests so the split semantics are byte-exact everywhere.
// ---------------------------------------------------------------------------

/** One stored file under the requested session subtree (validated). */
export interface StoredMaterializeFile {
	/** POSIX relpath relative to the session subtree root. */
	relpath: string;
	/** Absolute path of the file inside the store. */
	absolutePath: string;
	size: number;
	kind: ManifestFileKind;
}

/** Ordered, validated file set for one materialization request. */
export interface MaterializeFilePlan {
	/** Session subtree root (absolute, store side). */
	rootDir: string;
	/** Sorted by relpath; each file is a regular file inside rootDir. */
	files: StoredMaterializeFile[];
}

/**
 * Enumerate a session subtree from raw disk: walk every file under
 * `subtreeRoot`, reject symlinks/non-regular files, classify each relpath by
 * the manifest rules. Returns the sorted plan; a missing subtree resolves to
 * an empty plan (the caller reports unavailable).
 */
export function planMaterializeFiles(subtreeRoot: string): MaterializeFilePlan {
	const files: StoredMaterializeFile[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			let stats;
			try {
				// lstat, not stat: a symlink is never followed (the store is
				// written by this fleet, and a link must not pull host bytes
				// into a served transfer or recurse the walk).
				stats = lstatSync(absolute);
			} catch {
				continue;
			}
			if (stats.isSymbolicLink()) continue;
			if (stats.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!stats.isFile()) continue; // sockets/fifos/devices rejected
			const relpath = absolute.slice(subtreeRoot.length).replace(/^[/\\]/, "");
			if (!isNormalizedPosixRelativePath(relpath)) continue;
			files.push({ relpath, absolutePath: absolute, size: stats.size, kind: "metadata" });
		}
	};
	walk(subtreeRoot);
	// Main-session detection needs the full set (manifest rule): a `*.jsonl`
	// whose dir is NOT another jsonl's artifact dir is a main. Artifact roots
	// are `<main minus .jsonl>/` sibling dirs.
	const mainNames = new Set<string>();
	for (const file of files) {
		const dir = file.relpath.slice(0, file.relpath.lastIndexOf("/"));
		const dirBase = dir.slice(dir.lastIndexOf("/") + 1);
		if (dirBase.length === 0) {
			if (file.relpath.endsWith(".jsonl") && !isAdvisorName(file.relpath)) {
				mainNames.add(file.relpath);
			}
			continue;
		}
		// A project dir containing `<name>.jsonl`; the dir is a project dir,
		// so that jsonl is a main unless it sits under another main's dir.
		const parentIsArtifact = [...files].some(
			(f) => f.relpath === `${dir}.jsonl` && !isAdvisorName(f.relpath),
		);
		if (!parentIsArtifact && file.relpath.endsWith(".jsonl") && !isAdvisorName(file.relpath)) {
			mainNames.add(file.relpath);
		}
	}
	for (const file of files) {
		if (file.kind !== "metadata") continue;
		if (mainNames.has(file.relpath)) {
			file.kind = "main";
		} else if (isAdvisorName(file.relpath)) {
			file.kind = "advisor";
		} else if (file.relpath.endsWith(".jsonl")) {
			file.kind = "subagent";
		}
	}
	files.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
	return { rootDir: subtreeRoot, files };
}

function isAdvisorName(relpath: string): boolean {
	const base = relpath.split("/").pop() ?? "";
	return base === "__advisor.jsonl" || (base.startsWith("__advisor.") && base.endsWith(".jsonl"));
}

/** Memoized sha256 per stored file, bounded so a long-lived fleet cannot grow it without limit. */
const STORED_SHA_CACHE_MAX_ENTRIES = 512;
const STORED_SHA_RACY_WINDOW_MS = 2_000;
const storedShaCache = new Map<string, { identity: string; sha256: string }>();

function openStoredFile(absolutePath: string, relpath: string): number {
	try {
		return openSync(absolutePath, "r");
	} catch {
		throw callbackError("unavailable", `materialize read failed for ${relpath}`);
	}
}

function readStoredRange(fd: number, offset: number, length: number, relpath: string): Buffer {
	const buf = Buffer.allocUnsafe(length);
	if (readSync(fd, buf, 0, length, offset) !== length) {
		throw callbackError("unavailable", `materialize read failed for ${relpath}`);
	}
	return buf;
}

/**
 * sha256 of a whole stored file, streamed through bounded reads. The result
 * is memoized per path and fstat identity (size, mtime, ctime, inode), so a
 * resumed or repeated transfer of an unchanged file never re-hashes it.
 */
function storedFileSha256(
	absolutePath: string,
	fd: number,
	stats: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint },
	relpath: string,
): string {
	const identity = `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}`;
	const cached = storedShaCache.get(absolutePath);
	if (cached?.identity === identity) return cached.sha256;
	const hash = createHash("sha256");
	const size = Number(stats.size);
	const buf = Buffer.allocUnsafe(Math.min(MATERIALIZE_CHUNK_RAW_BYTES, size));
	for (let pos = 0; pos < size;) {
		const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
		if (n === 0) throw callbackError("unavailable", `materialize read failed for ${relpath}`);
		hash.update(buf.subarray(0, n));
		pos += n;
	}
	const sha256 = hash.digest("hex");
	// A file modified this recently can be rewritten within the same filesystem
	// timestamp tick, leaving its identity unchanged, so only settled files are memoized.
	if (Number(stats.mtimeNs / 1_000_000n) < Date.now() - STORED_SHA_RACY_WINDOW_MS) {
		storedShaCache.delete(absolutePath);
		storedShaCache.set(absolutePath, { identity, sha256 });
		if (storedShaCache.size > STORED_SHA_CACHE_MAX_ENTRIES) {
			const oldest = storedShaCache.keys().next().value;
			if (oldest !== undefined) storedShaCache.delete(oldest);
		}
	}
	return sha256;
}

/**
 * Emit one transfer's NDJSON records for a plan, honoring the request cursor
 * and the byte budget. Returns the serialized records for one correlation.
 * Splits only at record boundaries: when a file's declaration or a chunk
 * would exceed the budget, the transfer ends with `end {more:true, cursor}`
 * whose cursor resumes at the exact byte the next transfer continues from
 * (files already fully sent are skipped; the straddled file re-emits its
 * `file` record and resumes at `cursor.offset`). The session reassembles by
 * relpath+offset and verifies the sha256 after each file completes.
 * A record is admitted only while the terminal `end` record that would close
 * the transfer right after it still fits, so the stream always ends with an
 * explicit `end` and the consumer always learns whether more remains.
 */
export function* emitMaterializeTransfer(
	plan: MaterializeFilePlan,
	sessionId: string,
	cursor: MaterializeCursor | undefined,
	maxBytes: number = MATERIALIZE_TRANSFER_MAX_BYTES,
	workspaceId?: string,
): Generator<string, void, undefined> {
	let budget = maxBytes;
	const byteLength = (record: MaterializeRecord): number =>
		Buffer.byteLength(encodeMaterializeRecord(record), "utf8");
	// Upper bound on the terminal record at any stop point: `end {more:false}`,
	// or `end {more:true, cursor}` for any plan path at any offset.
	const terminalReserve = plan.files.reduce(
		(max, file) =>
			Math.max(
				max,
				byteLength({
					type: "end",
					more: true,
					cursor: { path: file.relpath, offset: Number.MAX_SAFE_INTEGER },
				}),
			),
		byteLength({ type: "end", more: false }),
	);
	// Bytes of the `end {more:true}` that stops the transfer exactly at `offset` in `relpath`.
	const stopReserve = (relpath: string, offset: number): number =>
		byteLength({ type: "end", more: true, cursor: { path: relpath, offset } });
	// Encodes a record and charges it to the budget, admitting it only while
	// `reserve` bytes remain for the terminal record that would follow it.
	const admit = (record: MaterializeRecord, reserve: number): string | undefined => {
		const line = encodeMaterializeRecord(record);
		const bytes = Buffer.byteLength(line, "utf8");
		if (budget - bytes - reserve < 0) return undefined;
		budget -= bytes;
		return line;
	};
	// Terminal records draw on the room the previous admission reserved, so they always fit.
	const endRecord = (record: MaterializeEndRecord): string => {
		const line = admit(record, 0);
		if (line === undefined) {
			throw callbackError(
				"invalid_request",
				"materialize transfer budget too small for an end record",
			);
		}
		return line;
	};

	const leadLine = admit(
		{
			type: "session",
			workspaceId: workspaceId ?? plan.rootDir.split("/").slice(-2, -1)[0] ?? "unknown",
			sessionId,
		},
		terminalReserve,
	);
	if (leadLine === undefined)
		throw callbackError(
			"invalid_request",
			"materialize transfer budget too small for the lead record",
		);
	yield leadLine;

	for (const file of plan.files) {
		if (cursor !== undefined && file.relpath < cursor.path) continue; // fully sent earlier
		const resume = cursor !== undefined && file.relpath === cursor.path ? cursor.offset : 0;
		const fd = openStoredFile(file.absolutePath, file.relpath);
		try {
			// Serve exactly the bytes hashed: size and identity come from the open fd.
			const stats = fstatSync(fd, { bigint: true });
			const size = Number(stats.size);
			if (resume > size) {
				throw callbackError(
					"invalid_request",
					`materialize cursor offset ${resume} exceeds the size of ${file.relpath}`,
				);
			}
			const sha256 = storedFileSha256(file.absolutePath, fd, stats, file.relpath);
			// Mid-file, the transfer may stop at `resume`; after a whole file, the next record opens a later file.
			const fileLine = admit(
				{
					type: "file",
					relpath: file.relpath,
					size,
					sha256,
					kind: file.kind,
					offset: resume,
				},
				resume < size ? stopReserve(file.relpath, resume) : terminalReserve,
			);
			if (fileLine === undefined) {
				yield endRecord({
					type: "end",
					more: true,
					cursor: { path: file.relpath, offset: resume },
				});
				return;
			}
			yield fileLine;
			let offset = resume;
			while (offset < size) {
				const take = Math.min(MATERIALIZE_CHUNK_RAW_BYTES, size - offset);
				const next = offset + take;
				const chunkLine = admit(
					{
						type: "chunk",
						relpath: file.relpath,
						offset,
						data: readStoredRange(fd, offset, take, file.relpath).toString("base64"),
					},
					next < size ? stopReserve(file.relpath, next) : terminalReserve,
				);
				if (chunkLine === undefined) {
					yield endRecord({ type: "end", more: true, cursor: { path: file.relpath, offset } });
					return;
				}
				yield chunkLine;
				offset = next;
			}
		} finally {
			closeSync(fd);
		}
	}
	yield endRecord({ type: "end", more: false });
}
