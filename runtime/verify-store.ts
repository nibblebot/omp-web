import { createHash } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
	ExportError,
	type ArchiveManifest,
	type ManifestFile,
	type ManifestProvenance,
	computeExportId,
	isNormalizedPosixRelativePath,
	validateManifest,
} from "../shared/archive-manifest";
import {
	JSONL_SUFFIX,
	MAX_EXPORT_BYTES,
	MAX_EXPORT_FILES,
	classifyLineageEntry,
	isMainRelpath,
	verifyJsonlStructure,
} from "./export-sessions";

// ---------------------------------------------------------------------------
// Verify-at-deletion gate (P7.1/P7.2 core): runtime/verify-store.ts.
//
// Frozen contract (docs/clone-contracts.md "Fleet log store"/"Typed errors";
// docs/clone-design.md "Workspace deletion: verify-at-deletion contract"):
//
//   verifyWorkspaceLogs({ logsRoot, workspaceId }) →
//     { ok: true; sessions: VerifiedSession[] }
//   | { ok: false; code: <ledger error>; message: string; path?: string }
//
// P4.5 (additive): when `registry` provenance is supplied, the success arm
// additionally carries `manifest` (ArchiveManifest per shared/archive-manifest
// schema: every verified file's path/size/sha256/kind/sessionId/parentPath,
// plus projectId/workspaceId/workspaceName/source/resolvedCommit/generatedAt
// provenance from the registry record) and `exportId` (content-addressed via
// computeExportId). The manifest is computed, never used to copy or stage;
// persisting it on the roster entry is the deletion lane's consumption.
//
// Workspace deletion is gated on fleet store completeness for every session:
// offset-contiguous streams (index ackedOffset equals the stored file size,
// no gap markers) AND structurally verified JSONL under the manifest rules
// (title slot, header, newline-terminated entries, no trailing partial),
// against the store layout logs/<workspaceId>/<sessionId>/<relpath> plus the
// per-session index.json sidecar. Path/type validation is independent of
// daemon trust: traversal, symlinks, non-regular files, and an index
// inconsistent with the stored tree are rejected. The daemon streams every
// lineage file (main JSONL plus its artifact subtree, subagent/advisor
// transcripts and raw blobs) under one session id, so a session directory is
// one self-contained lineage tree and index↔disk equality over that tree IS
// the artifact-lineage completeness check.
//
// This gate is deliberately stricter than FleetLogStore.load()'s
// self-repair: load() adopts unindexed files and reconciles torn tails at
// boot, while verification must PROVE completeness, so any state a repair
// would have healed (missing/partial index, a file without an index entry,
// a length disagreement) fails the gate. Failures always retain the logs.
//
// No staging, rename, receipt, or archive copy is produced anywhere; this is
// a pure read-only snapshot. Deletion-lane wiring (P7.3/P7.5/P7.6) consumes
// exactly this exported signature.
//
// Error-code mapping (frozen ledger vocabulary):
//   invalid_request: malformed caller arguments (logsRoot/workspaceId).
//   unavailable    : fs/environment failures and resource bounds (10k files
//                     / 16 GiB, shared with the export gate), plus the JSONL
//                     predicate's own unavailable verdicts.
//   conflict       : stored content contradicting the contract: offset
//                     disagreement, gap/inconsistent index, unsafe stream
//                     key, symlink/non-regular file, declared file missing,
//                     unindexed file, malformed JSONL (ExportError conflict).
// ---------------------------------------------------------------------------

/** One verified session's inventory: tracked stream files and their bytes. */
export interface VerifiedSession {
	sessionId: string;
	files: number;
	bytes: number;
}

/**
 * Typed verify result; failure codes are the frozen ledger vocabulary.
 *
 * The success arm carries the additive P4.5 verification manifest (built
 * only when provenance is supplied via {@link VerifyWorkspaceLogsOptions}):
 * an {@link ArchiveManifest} over every verified file, plus its
 * content-addressed export id. Verify-only semantics are preserved: the
 * manifest is computed, never used to copy or stage anything; persisting it
 * on the roster entry is the deletion lane's consumption (out of scope).
 */
export type VerifyResult =
	| {
			ok: true;
			sessions: VerifiedSession[];
			/** Verification manifest (P4.5), present iff registry provenance was provided. */
			manifest?: ArchiveManifest;
			/** `computeExportId(manifest)`; present iff `manifest` is. */
			exportId?: string;
	  }
	| {
			ok: false;
			code: "invalid_request" | "unavailable" | "conflict";
			message: string;
			path?: string;
	  };

export interface VerifyWorkspaceLogsOptions {
	/** Fleet state dir that owns the logs/ tree (the logs root itself). */
	logsRoot: string;
	/** Workspace id whose logs/<workspaceId>/ subtree is verified. */
	workspaceId: string;
	/**
	 * Additive P4.5 registry provenance. When supplied, the success result
	 * additionally carries `manifest` + `exportId`. Partial records are
	 * allowed: absent optional fields are omitted from provenance (they are
	 * not required by the frozen manifest schema).
	 */
	registry?: {
		projectId?: string;
		workspaceName?: string;
		/** Clone sources, forwarded to provenance.source. */
		source?: { local?: string; remote?: string };
		/** The workspace's resolved commit (fleet WorkspaceRecord.pinnedRevision). */
		resolvedCommit?: string;
	};
	/**
	 * The daemon's quiesce manifest (P4.5 quiesce_result control envelope).
	 * When supplied, the gate ALSO proves the fleet store matches it exactly:
	 * every declared file present in the store with equal size/sha256/kind/
	 * sessionId/parentPath, and no store file outside the declared set, on
	 * top of the offset-contiguity/structural checks. `generatedAt` is
	 * excluded from equality; `provenance.workspaceId` must equal
	 * `workspaceId` (a drifted manifest is a conflict).
	 */
	expectedManifest?: ArchiveManifest;
}

/** Workspace-level reserved store files (sidecar name, read-only marker). */
const WORKSPACE_RESERVED: Record<string, true> = {
	"index.json": true,
	"readonly.json": true,
};

const INDEX_NAME = "index.json";
const TMP_SUFFIX = ".tmp";

/** Top-level sidecar fields (frozen LogStoreIndex shape). */
const INDEX_FIELDS: Record<string, true> = {
	version: true,
	workspaceId: true,
	sessionId: true,
	streams: true,
};

/** Per-stream fields (frozen LogStreamIndexEntry shape). */
const ENTRY_FIELDS: Record<string, true> = {
	generation: true,
	ackedOffset: true,
	eof: true,
};

/** Hard bounds shared with the export gate (clone-plan P4.6). */
const MAX_FILES = MAX_EXPORT_FILES;
const MAX_BYTES = MAX_EXPORT_BYTES;

/** Hashing read buffer (bounded: same 10k-file / 16 GiB budget as the walk). */
const HASH_BUFFER_BYTES = 256 * 1024;

function fail(
	code: "invalid_request" | "unavailable" | "conflict",
	message: string,
	path?: string,
): VerifyResult {
	return path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };
}

/** Store id rules (mirror assertSafeComponent): single normalized component. */
function isSafeId(name: string): boolean {
	if (name.length === 0 || name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
	return !WORKSPACE_RESERVED[name];
}

/**
 * Stream-relpath safety independent of daemon trust: manifest path rules via
 * the shared predicate (normalized POSIX-relative, no traversal) plus the
 * store's own conventions (no NUL, no sidecar collision, no tmp suffix).
 */
function isSafeStreamRelpath(relpath: string): boolean {
	if (relpath.includes("\0")) return false;
	if (relpath === INDEX_NAME) return false;
	if (relpath.endsWith(TMP_SUFFIX)) return false;
	return isNormalizedPosixRelativePath(relpath);
}

/** POSIX relpath of an absolute path below `sessionDir` (manifest rules). */
function toPosixRelpath(sessionDir: string, absolute: string): string {
	return relative(sessionDir, absolute).split(sep).join("/");
}

/** A data file discovered under a session dir (sidecar excluded). */
interface SessionDataFile {
	absolute: string;
	/** POSIX relpath inside the session dir. */
	relpath: string;
	size: number;
}

/** Per-session walk result: data files plus directory relpaths seen. */
interface SessionTree {
	files: Map<string, SessionDataFile>;
	dirs: Set<string>;
}

/** Shape-checked per-session sidecar content. */
interface SessionIndex {
	streams: Map<string, { generation: number; ackedOffset: number; eof: boolean }>;
}

type IndexRead = SessionIndex | VerifyResult;
type TreeWalk = SessionTree | VerifyResult;

/**
 * Parse and shape-validate the session sidecar against the frozen
 * LogStoreIndex shape. Unknown top-level or per-stream fields are rejected
 * (a gap marker or drifted schema is exactly an inconsistent index).
 */
function readSessionIndex(sessionDir: string, workspaceId: string, sessionId: string): IndexRead {
	const indexPath = join(sessionDir, INDEX_NAME);
	let info;
	try {
		info = lstatSync(indexPath, { throwIfNoEntry: false });
	} catch (error) {
		return fail(
			"unavailable",
			`cannot stat ${INDEX_NAME} for session ${sessionId}: ${(error as Error).message}`,
			sessionId,
		);
	}
	if (info === undefined) {
		return fail("conflict", `missing ${INDEX_NAME} sidecar for session ${sessionId}`, sessionId);
	}
	if (info.isSymbolicLink()) {
		return fail("conflict", `${INDEX_NAME} sidecar is a symlink`, sessionId);
	}
	if (!info.isFile()) {
		return fail("conflict", `${INDEX_NAME} sidecar is not a regular file`, sessionId);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(indexPath, "utf8"));
	} catch (error) {
		return fail(
			"conflict",
			`unparsable ${INDEX_NAME} sidecar for session ${sessionId}: ${(error as Error).message}`,
			sessionId,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail("conflict", `${INDEX_NAME} for session ${sessionId} is not an object`, sessionId);
	}
	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!INDEX_FIELDS[key]) {
			return fail(
				"conflict",
				`${INDEX_NAME} for session ${sessionId} has unknown field ${key} (gap/inconsistent index)`,
				sessionId,
			);
		}
	}
	if (record.version !== 1) {
		return fail(
			"conflict",
			`${INDEX_NAME} for session ${sessionId} has version ${String(record.version)}`,
			sessionId,
		);
	}
	if (record.workspaceId !== workspaceId || record.sessionId !== sessionId) {
		return fail(
			"conflict",
			`${INDEX_NAME} for session ${sessionId} names ${String(record.workspaceId)}/${String(record.sessionId)}`,
			sessionId,
		);
	}
	const rawStreams = record.streams;
	if (rawStreams === null || typeof rawStreams !== "object" || Array.isArray(rawStreams)) {
		return fail(
			"conflict",
			`${INDEX_NAME} for session ${sessionId} has no streams object`,
			sessionId,
		);
	}
	const streams = new Map<string, { generation: number; ackedOffset: number; eof: boolean }>();
	for (const [relpath, rawEntry] of Object.entries(rawStreams as Record<string, unknown>)) {
		if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			return fail(
				"conflict",
				`stream ${relpath} of session ${sessionId} is not an object`,
				relpath,
			);
		}
		const entry = rawEntry as Record<string, unknown>;
		for (const key of Object.keys(entry)) {
			if (!ENTRY_FIELDS[key]) {
				return fail(
					"conflict",
					`stream ${relpath} of session ${sessionId} has unknown field ${key} (gap marker)`,
					relpath,
				);
			}
		}
		if (!Number.isInteger(entry.generation) || (entry.generation as number) < 1) {
			return fail(
				"conflict",
				`stream ${relpath} of session ${sessionId} has bad generation`,
				relpath,
			);
		}
		if (!Number.isInteger(entry.ackedOffset) || (entry.ackedOffset as number) < 0) {
			return fail(
				"conflict",
				`stream ${relpath} of session ${sessionId} has bad ackedOffset`,
				relpath,
			);
		}
		if (typeof entry.eof !== "boolean") {
			return fail("conflict", `stream ${relpath} of session ${sessionId} has bad eof`, relpath);
		}
		streams.set(relpath, {
			generation: entry.generation as number,
			ackedOffset: entry.ackedOffset as number,
			eof: entry.eof as boolean,
		});
	}
	return { streams };
}

/**
 * Walk one session's subtree, rejecting symlinks and non-regular files and
 * enforcing the workspace-wide traversal bounds. Session-root store internals
 * (the index.json sidecar and stale *.tmp rewrite leftovers) are skipped;
 * nested `.tmp` names are never legitimate lineage and fail relpath safety.
 */
function walkSessionTree(
	sessionDir: string,
	sessionReal: string,
	bounds: { files: number; bytes: number },
): TreeWalk {
	const files = new Map<string, SessionDataFile>();
	const dirs = new Set<string>();
	const stack: string[] = [sessionDir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch (error) {
			return fail(
				"unavailable",
				`workspace logs unreadable: ${(error as Error).message}`,
				toPosixRelpath(sessionDir, current),
			);
		}
		for (const entry of entries) {
			const absolute = join(current, entry.name);
			let info;
			try {
				info = lstatSync(absolute, { throwIfNoEntry: false });
			} catch (error) {
				return fail(
					"unavailable",
					`cannot stat ${toPosixRelpath(sessionDir, absolute)}: ${(error as Error).message}`,
					toPosixRelpath(sessionDir, absolute),
				);
			}
			if (info === undefined) continue; // Vanished mid-walk; index comparison rechecks.
			const relpath = toPosixRelpath(sessionDir, absolute);
			if (info.isSymbolicLink()) {
				return fail("conflict", `symlink rejected: ${relpath}`, relpath);
			}
			if (info.isDirectory()) {
				dirs.add(relpath);
				stack.push(absolute);
				continue;
			}
			if (!info.isFile()) {
				return fail("conflict", `non-regular file rejected: ${relpath}`, relpath);
			}
			if (relpath === INDEX_NAME || (current === sessionDir && entry.name.endsWith(TMP_SUFFIX))) {
				continue; // Store internals at the session root.
			}
			if (!isSafeStreamRelpath(relpath)) {
				return fail("conflict", `unsafe stored path: ${relpath}`, relpath);
			}
			let real: string;
			try {
				real = realpathSync(absolute);
			} catch (error) {
				return fail(
					"unavailable",
					`cannot resolve ${relpath}: ${(error as Error).message}`,
					relpath,
				);
			}
			if (real !== sessionReal && !real.startsWith(`${sessionReal}/`)) {
				return fail("conflict", `path escapes session directory: ${relpath}`, relpath);
			}
			bounds.files += 1;
			if (bounds.files > MAX_FILES) {
				return fail("unavailable", `verification exceeds ${MAX_FILES} files`, relpath);
			}
			bounds.bytes += info.size;
			if (bounds.bytes > MAX_BYTES) {
				return fail("unavailable", `verification exceeds ${MAX_BYTES} bytes total`, relpath);
			}
			files.set(relpath, { absolute, relpath, size: info.size });
		}
	}
	return { files, dirs };
}

/**
 * Reconcile the sidecar against the walked tree (offset-contiguity, complete
 * declared set, no unindexed files) and run the retained structural JSONL
 * verification on every declared `.jsonl`. Returns the session inventory.
 */
function verifySession(
	sessionDir: string,
	sessionReal: string,
	workspaceId: string,
	sessionId: string,
	bounds: { files: number; bytes: number },
): VerifiedSession | VerifyResult {
	const indexRead = readSessionIndex(sessionDir, workspaceId, sessionId);
	if (!("streams" in indexRead)) return indexRead;
	const { streams } = indexRead;
	const treeWalk = walkSessionTree(sessionDir, sessionReal, bounds);
	if (!("files" in treeWalk)) return treeWalk;
	const { files, dirs } = treeWalk;

	let bytes = 0;
	for (const [relpath, entry] of streams) {
		if (!isSafeStreamRelpath(relpath)) {
			return fail("conflict", `index stream key is not a safe relpath: ${relpath}`, relpath);
		}
		if (dirs.has(relpath)) {
			return fail("conflict", `index stream ${relpath} is a directory on disk`, relpath);
		}
		const dataFile = files.get(relpath);
		if (dataFile === undefined) {
			return fail(
				"conflict",
				`declared stream file missing: ${relpath} (session ${sessionId})`,
				relpath,
			);
		}
		if (dataFile.size !== entry.ackedOffset) {
			return fail(
				"conflict",
				`stream ${relpath} of session ${sessionId} is not offset-contiguous: index ackedOffset ${entry.ackedOffset} != stored size ${dataFile.size}`,
				relpath,
			);
		}
		if (relpath.endsWith(JSONL_SUFFIX)) {
			// Each lineage file is its own SDK session with its own header id
			// (subagent/advisor transcripts carry their own ids inside the
			// main's artifact dir). Expected id = the file's basename stem.
			const base = relpath.slice(relpath.lastIndexOf("/") + 1);
			const stem = base.slice(0, -JSONL_SUFFIX.length);
			try {
				verifyJsonlStructure(dataFile.absolute, stem);
			} catch (error) {
				if (error instanceof ExportError) {
					return fail(
						error.code === "unavailable" ? "unavailable" : "conflict",
						`session ${sessionId}: ${error.message}`,
						relpath,
					);
				}
				return fail(
					"unavailable",
					`session ${sessionId}: structural verification failed: ${(error as Error).message}`,
					relpath,
				);
			}
		}
		bytes += dataFile.size;
	}
	// Files on disk without an index entry: a crash between the append fsync
	// and the index rename. load() adopts them at boot; verification must not.
	for (const relpath of files.keys()) {
		if (!streams.has(relpath)) {
			return fail(
				"conflict",
				`file has no index entry: ${relpath} (session ${sessionId})`,
				relpath,
			);
		}
	}
	return { sessionId, files: streams.size, bytes };
}

/**
 * Build the manifest entry list for one session from its verified tree.
 *
 * Kind classification and lineage parentPath follow the shared rule
 * (export-sessions.classifyLineageEntry) applied to the store's relpaths:
 * the session-dir root IS the lineage subtree of the session's main JSONL
 * (the daemon streams one session id per subtree); mains at depth 1
 * (`<sessionId>.jsonl`), artifacts nested below. Entries are sorted by
 * relpath for deterministic export ids.
 *
 * Hashing each file streams it once in bounded chunks under the same
 * 10k-file / 16 GiB budget the walk already enforced (the manifest only
 * covers files the gate verified; a mid-hash fs failure surfaces typed).
 */
async function buildSessionManifestFiles(
	sessionDir: string,
	verified: VerifiedSession,
): Promise<ManifestFile[]> {
	const walked = walkSessionTree(sessionDir, sessionDir, { files: 0, bytes: 0 });
	if (!("files" in walked)) {
		// Only store hazards can fail the walk (walkSessionTree returns typed
		// failures, never an ok result); surface typed, never fabricate a
		// manifest over a tree that failed re-verification.
		if (walked.ok) {
			throw new ExportError("unavailable", "session tree walk returned an unexpected result");
		}
		throw new ExportError(walked.code, walked.message, walked.path);
	}
	const files = walked.files;
	// The store's session dir is the lineage tree of ONE session key
	// (verified.sessionId). The daemon names the main file `<sessionId>.jsonl`
	// at depth 1 (root) or `<proj>/<sessionId>.jsonl` at depth 2 (project),
	// so the key's main relpath is the file whose basename is
	// `<sessionId>.jsonl` and whose depth is ≤ 2.
	const ordered = [...files.keys()].sort();
	const mainRels = new Set<string>();
	for (const relpath of ordered) {
		if (isMainRelpath(relpath, verified.sessionId)) mainRels.add(relpath);
	}
	const manifestFiles: ManifestFile[] = [];
	for (const relpath of ordered) {
		const entry = files.get(relpath)!;
		let sha256: string;
		try {
			sha256 = await sha256File(entry.absolute);
		} catch (error) {
			throw new ExportError(
				"unavailable",
				`cannot hash ${relpath} of session ${verified.sessionId}: ${(error as Error).message}`,
			);
		}
		const classified = classifyLineageEntry(relpath, mainRels);
		const file: ManifestFile = {
			path: relpath,
			size: entry.size,
			sha256,
			kind: classified.kind,
			sessionId: classified.sessionId,
		};
		if (classified.parentPath !== undefined) file.parentPath = classified.parentPath;
		manifestFiles.push(file);
	}
	return manifestFiles;
}

/**
 * sha256 of a file streamed in fixed-size chunks (never whole-file buffered),
 * mirroring the export pipeline's copyFileHashed read loop. Caller maps
 * failures (incl. mid-read ENOENT on a vanished file) onto the verify error
 * vocabulary.
 */
function sha256File(absolute: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absolute, "r");
	const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * Verify the fleet log store for one workspace: every session offset-
 * contiguous and structurally complete, every session reported in
 * deterministic order. A workspace with no session directories (or no logs
 * subtree at all) resolves ok with an empty inventory: nothing was ever
 * streamed, so nothing gates deletion. Bounds failures return `unavailable`.
 */
export async function verifyWorkspaceLogs(opts: VerifyWorkspaceLogsOptions): Promise<VerifyResult> {
	if (opts === null || typeof opts !== "object") {
		return fail("invalid_request", "verifyWorkspaceLogs requires an options object");
	}
	const { logsRoot, workspaceId } = opts;
	if (typeof logsRoot !== "string" || logsRoot.length === 0) {
		return fail("invalid_request", "logsRoot must be a non-empty string");
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		return fail("invalid_request", "workspaceId must be a non-empty string");
	}
	if (!isSafeId(workspaceId)) {
		return fail("invalid_request", `workspaceId is not a safe component: ${workspaceId}`);
	}
	const workspaceDir = join(logsRoot, workspaceId);

	let wsInfo;
	try {
		wsInfo = lstatSync(workspaceDir, { throwIfNoEntry: false });
	} catch (error) {
		return fail(
			"unavailable",
			`cannot stat logs for workspace ${workspaceId}: ${(error as Error).message}`,
			workspaceId,
		);
	}
	if (wsInfo === undefined) {
		return { ok: true, sessions: [] }; // Nothing streamed: nothing to gate.
	}
	if (wsInfo.isSymbolicLink()) {
		return fail("conflict", `workspace logs dir is a symlink: ${workspaceDir}`, workspaceId);
	}
	if (!wsInfo.isDirectory()) {
		return fail("conflict", `workspace logs path is not a directory: ${workspaceDir}`, workspaceId);
	}

	let entries;
	try {
		entries = readdirSync(workspaceDir, { withFileTypes: true });
	} catch (error) {
		return fail(
			"unavailable",
			`workspace logs unreadable: ${(error as Error).message}`,
			workspaceId,
		);
	}
	const sessionIds: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (isSafeId(entry.name)) sessionIds.push(entry.name);
			continue; // Reserved/invalid dir names are outside the id namespace.
		}
		if (WORKSPACE_RESERVED[entry.name]) continue; // readonly.json marker etc.
		return fail(
			"conflict",
			`unexpected non-directory in workspace logs: ${entry.name}`,
			entry.name,
		);
	}
	sessionIds.sort();

	const bounds = { files: 0, bytes: 0 };
	const verified: VerifiedSession[] = [];
	for (const sessionId of sessionIds) {
		const sessionDir = join(workspaceDir, sessionId);
		let sessionInfo;
		try {
			sessionInfo = lstatSync(sessionDir, { throwIfNoEntry: false });
		} catch (error) {
			return fail(
				"unavailable",
				`cannot stat session ${sessionId}: ${(error as Error).message}`,
				sessionId,
			);
		}
		if (sessionInfo === undefined) continue; // Vanished between readdir and verify.
		if (sessionInfo.isSymbolicLink()) {
			return fail("conflict", `session dir is a symlink: ${sessionId}`, sessionId);
		}
		if (!sessionInfo.isDirectory()) {
			return fail("conflict", `session path is not a directory: ${sessionId}`, sessionId);
		}
		let sessionReal: string;
		try {
			sessionReal = realpathSync(sessionDir);
		} catch (error) {
			return fail(
				"unavailable",
				`cannot resolve session ${sessionId}: ${(error as Error).message}`,
				sessionId,
			);
		}
		const result = verifySession(sessionDir, sessionReal, workspaceId, sessionId, bounds);
		if (!("sessionId" in result)) return result;
		verified.push(result);
	}
	const expectedFiles: ManifestFile[] = [];
	for (const session of verified) {
		expectedFiles.push(
			...(await buildSessionManifestFiles(join(workspaceDir, session.sessionId), session)),
		);
	}
	const workspaceIdForCompare = workspaceId;
	if (opts.expectedManifest !== undefined) {
		let expected: ArchiveManifest;
		try {
			expected = validateManifest(opts.expectedManifest);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail("invalid_request", `expectedManifest is malformed: ${message}`);
		}
		if (expected.provenance.workspaceId !== workspaceIdForCompare) {
			return fail(
				"conflict",
				`expectedManifest targets workspace ${expected.provenance.workspaceId}, verifying ${workspaceIdForCompare}`,
			);
		}
		const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
		const storeByPath = new Map(expectedFiles.map((file) => [file.path, file]));
		// Complete declared set: every expected file present and identical.
		for (const [relpath, expectedFile] of expectedByPath) {
			const storeFile = storeByPath.get(relpath);
			if (storeFile === undefined) {
				return fail(
					"conflict",
					`expected manifest file missing from the store: ${relpath}`,
					relpath,
				);
			}
			const mismatch = manifestFileMismatch(expectedFile, storeFile);
			if (mismatch !== undefined) {
				return fail(
					"conflict",
					`stored ${relpath} does not match the expected manifest: ${mismatch}`,
					relpath,
				);
			}
		}
		// No undeclared store files: the store holds exactly the declared set.
		for (const relpath of storeByPath.keys()) {
			if (!expectedByPath.has(relpath)) {
				return fail(
					"conflict",
					`store holds a file the expected manifest does not declare: ${relpath}`,
					relpath,
				);
			}
		}
		return { ok: true, sessions: verified, manifest: expected };
	}
	if (opts.registry !== undefined) {
		const provenance: ManifestProvenance = {
			projectId: opts.registry.projectId ?? "",
			workspaceId,
			workspaceName: opts.registry.workspaceName ?? workspaceId,
			resolvedCommit: opts.registry.resolvedCommit ?? "",
			generatedAt: new Date().toISOString(),
		};
		const manifest: ArchiveManifest = { provenance, files: expectedFiles };
		// exportId is content-addressed for idempotent retries (ledger), so it
		// must not cover the wall-clock generatedAt: hash the manifest with the
		// timestamp blanked, while the returned manifest keeps the real value.
		const { generatedAt: _generatedAt, ...stableProvenance } = provenance;
		void _generatedAt;
		const idInput: ArchiveManifest = {
			provenance: { ...stableProvenance, generatedAt: "" },
			files: expectedFiles,
		};
		return { ok: true, sessions: verified, manifest, exportId: computeExportId(idInput) };
	}
	return { ok: true, sessions: verified };
}

/**
 * First field where `stored` disagrees with `expected`, or undefined when
 * they match field-for-field (undefined parentPath === absent). generatedAt
 * lives in provenance and is handled by the caller.
 */
function manifestFileMismatch(expected: ManifestFile, stored: ManifestFile): string | undefined {
	if (stored.size !== expected.size) return `size ${stored.size}, expected ${expected.size}`;
	if (stored.sha256 !== expected.sha256) return "sha256 mismatch";
	if (stored.kind !== expected.kind) return `kind ${stored.kind}, expected ${expected.kind}`;
	if (stored.sessionId !== expected.sessionId) {
		return `sessionId ${stored.sessionId}, expected ${expected.sessionId}`;
	}
	if ((stored.parentPath ?? undefined) !== (expected.parentPath ?? undefined)) {
		return `parentPath ${stored.parentPath ?? "(none)"}, expected ${expected.parentPath ?? "(none)"}`;
	}
	return undefined;
}
