/**
 * Fleet log-store read model + HTTP surface (P8.5). Everything here is a
 * pure disk read over FleetLogStore: never touches a daemon, the SDK, or
 * compute, so browsing fleet-stored history can never wake a workspace.
 *
 * Layering: imports only fleet/log-store.ts, lib/wire/stats-types.ts, node
 * builtins and ./. Reuses the stats app's route
 * registry convention (Route + dispatchRequest + json) so the fleet control
 * plane can mount it with one line beside /ctl/stats.
 *
 * Route contract (frozen with Lifecycle + Frontend):
 *   GET /ctl/stored/workspaces
 *   GET /ctl/stored/sessions?workspaceId=<id>        (omit for all)
 *   GET /ctl/stored/sessions/:workspaceId/:sessionId
 *   GET /ctl/stored/sessions/:workspaceId/:sessionId/transcript
 *         ?file=<relpath>&format=parsed|raw&offset=&limit=
 *
 * Error body: { error: { code, message, detail? } } with the frozen typed
 * vocabulary: invalid_request (400) for unsafe ids/relpaths/params,
 * unavailable (404) for unknown workspaces/sessions/files. Responses never
 * contain credentials or private endpoints; provenance is secret-free
 * (source paths/URLs are never serialized).
 */
import { json, dispatchRequest } from "./stats-http";
import type { Route } from "./stats-types";
import type { FleetLogStore, StoredFileInfo, StoredSessionInfo } from "./log-store";
import type {
	StoredFileKind,
	StoredSessionDetail,
	StoredSessionSummary,
	StoredWorkspaceProvenance,
	StoredWorkspaceSummary,
	TranscriptPage,
	RawEntry,
} from "#lib/wire/stats-types";
import { parseLine } from "./stats-jsonl";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { ByteLru } from "#lib/platform/byte-lru";
import type { ByteLruLimits } from "#lib/platform/byte-lru";
import { parseSessionHead, SESSION_HEAD_BYTES } from "./session-head";
import type { SessionHead } from "./session-head";

// ---------------------------------------------------------------------------
// Provenance projection (secret-free)
// ---------------------------------------------------------------------------

/** Minimal provenance source: a live RegistryEntry's WorkspaceRecord or an orphan marker. */
export interface ProvenanceLike {
	projectId: string;
	kind: "clone" | "worktree" | "direct";
	profileId?: string;
	branch?: string;
	pinnedRevision?: string;
	source?: { local?: string; remote?: string };
}

export type StoredAppDeps = {
	store: FleetLogStore;
	provenance?: (workspaceId: string) => ProvenanceLike | undefined;
};

/** The public secret-free provenance shape (frozen wire contract). */
export type PublicProvenance = StoredWorkspaceProvenance;

export function toPublicProvenance(p: ProvenanceLike): PublicProvenance {
	const sourceKind =
		p.source !== undefined ? (p.source.remote !== undefined ? "remote" : "local") : undefined;
	return {
		projectId: p.projectId,
		kind: p.kind,
		...(p.profileId ? { profileId: p.profileId } : {}),
		...(p.branch ? { branch: p.branch } : {}),
		...(p.pinnedRevision ? { pinnedRevision: p.pinnedRevision } : {}),
		...(sourceKind ? { sourceKind } : {}),
	};
}

function provenanceFor(deps: StoredAppDeps, workspaceId: string): PublicProvenance | undefined {
	const p = deps.provenance?.(workspaceId);
	return p ? toPublicProvenance(p) : undefined;
}

// ---------------------------------------------------------------------------
// Component validation (mirrors the store's id/relpath rules; decode first)
// ---------------------------------------------------------------------------

/** Decodes a URL path/query segment; null when not valid UTF-8 percent-encoding. */
function decodeSegment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/** A decoded single path component (no /, \, NUL, ., .., or store-reserved name). */
function isSafeComponent(value: string): boolean {
	if (value.length === 0 || value === "." || value === "..") return false;
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
	if (value === "index.json" || value === "readonly.json") return false;
	return true;
}

/** Decoded store-validated relpath, or null (invalid/missing file query). */
function decodeRelpathParam(raw: string): string | null {
	const decoded = decodeSegment(raw);
	if (decoded === null) return null;
	if (decoded.includes("\\") || decoded.includes("\0") || decoded.startsWith("/")) return null;
	if (decoded === "index.json" || decoded.endsWith(".tmp")) return null;
	const parts = decoded.split("/");
	for (const part of parts) {
		if (part.length === 0 || part === "." || part === "..") return null;
	}
	return decoded;
}

// ---------------------------------------------------------------------------
// Typed error envelope
// ---------------------------------------------------------------------------

/**
 * Frozen wire error body: { error: { code, message } }. The typed vocabulary
 * is invalid_request (400: unsafe ids/relpaths/params) and unavailable (404:
 * unknown workspaces/sessions/files); `detail` is reserved and never emitted
 * today. Deliberately NOT stats-http's errorJson, which emits { error: string }.
 *
 * Kept as one helper so every error return shares the envelope in lockstep:
 * the shape is a frozen client-facing contract (see
 * apps/web/store/fleet-api.ts errorMessageFromBody + ApiError.code).
 */
function typedError(
	code: "invalid_request" | "unavailable",
	message: string,
	status: number,
): Response {
	return json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------------------
// Wire-row assembly
// ---------------------------------------------------------------------------

/** readOnly is a workspace-level property; thread it onto each session row. */
function summaryRow(
	deps: StoredAppDeps,
	s: StoredSessionInfo,
	readOnly: boolean,
): StoredSessionSummary {
	const provenance = provenanceFor(deps, s.workspaceId);
	return {
		workspaceId: s.workspaceId,
		sessionId: s.sessionId,
		title: null,
		cwd: null,
		firstTs: null,
		lastTs: null,
		bytes: s.bytes,
		fileCount: s.files.length,
		kinds: {
			main: s.files.filter((f) => f.kind === "main").length,
			subagent: s.files.filter((f) => f.kind === "subagent").length,
			advisor: s.files.filter((f) => f.kind === "advisor").length,
			metadata: s.files.filter((f) => f.kind === "metadata").length,
		},
		...(s.mainRelpath ? { mainRelpath: s.mainRelpath } : {}),
		readOnly,
		orphaned: provenance === undefined,
		missingAssets: s.missingAssets,
		...(provenance ? { provenance } : {}),
	};
}

function workspaceRow(
	deps: StoredAppDeps,
	workspaceId: string,
	sessions: StoredSessionInfo[],
	readOnly: boolean,
): StoredWorkspaceSummary {
	const provenance = provenanceFor(deps, workspaceId);
	const orphaned = provenance === undefined;
	return {
		workspaceId,
		sessions: sessions.length,
		bytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
		readOnly,
		orphaned,
		viewOnly: true,
		...(provenance ? { provenance } : {}),
	};
}

function detailRow(
	deps: StoredAppDeps,
	s: StoredSessionInfo,
	readOnly: boolean,
): StoredSessionDetail {
	return {
		...summaryRow(deps, s, readOnly),
		files: s.files.map((f) => ({
			relpath: f.relpath,
			kind: f.kind,
			...(f.parentPath ? { parentPath: f.parentPath } : {}),
			bytes: f.bytes,
			ackedBytes: f.ackedBytes,
			eof: f.eof,
			status: f.status,
		})),
	};
}

// ---------------------------------------------------------------------------
// Display enrichment from stored JSONL heads (title/cwd/timestamps)
// ---------------------------------------------------------------------------

/** Head facts (title, session header, first/last timestamps) of a stored JSONL file. */
function headOf(
	store: FleetLogStore,
	workspaceId: string,
	sessionId: string,
	relpath: string,
): SessionHead | null {
	const prefix = store.readStoredPrefix(workspaceId, sessionId, relpath, SESSION_HEAD_BYTES);
	return prefix === null ? null : parseSessionHead(prefix.toString("utf8"));
}

// ---------------------------------------------------------------------------
// Transcript route (parsed + raw)
// ---------------------------------------------------------------------------

function transcriptRoute(deps: StoredAppDeps): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stored\/sessions\/([^/]+)\/([^/]+)\/transcript$/,
		handler: async ({ url, params }) => {
			const wsRaw = params[0]!;
			const sidRaw = params[1]!;
			const workspaceId = decodeSegment(wsRaw);
			const sessionId = decodeSegment(sidRaw);
			if (
				workspaceId === null ||
				sessionId === null ||
				!isSafeComponent(workspaceId) ||
				!isSafeComponent(sessionId)
			) {
				return typedError("invalid_request", "invalid session identity", 400);
			}
			const store = deps.store;
			const lineage = store.storedLineage(workspaceId, sessionId);
			if (lineage === null) {
				return typedError("unavailable", "session not found in fleet store", 404);
			}
			const fileParam = url.searchParams.get("file");
			let relpath: string | undefined;
			if (fileParam === null) {
				relpath = lineage.mainRelpath;
			} else {
				const decoded = decodeRelpathParam(fileParam);
				if (decoded === null) {
					return typedError("invalid_request", "invalid file relpath", 400);
				}
				relpath = decoded;
			}
			if (relpath === undefined || relpath.length === 0) {
				return typedError("unavailable", "no main transcript stored for this session", 404);
			}
			const format = (url.searchParams.get("format") ?? "parsed").toLowerCase();
			if (format === "raw") {
				// Stream the exact stored bytes without whole-file buffering.
				const file = store.storedFilePath(workspaceId, sessionId, relpath);
				if (file === null) return unavailableFile(relpath);
				const fileStream = Bun.file(file).stream();
				return new Response(fileStream, {
					status: 200,
					headers: { "content-type": "application/x-ndjson; charset=utf-8" },
				});
			}
			if (format !== "parsed") {
				return typedError("invalid_request", "invalid format (parsed|raw)", 400);
			}
			// Windowed parse: only this page's lines are read and parsed.
			const transcriptFile = store.storedFilePath(workspaceId, sessionId, relpath);
			const size = transcriptFile === null ? 0 : storedFileSize(transcriptFile);
			if (transcriptFile === null || size === 0) return unavailableFile(relpath);
			try {
				return parsedTranscript(transcriptFile, size, url);
			} catch {
				// The file was removed or rewritten between stat and read.
				return unavailableFile(relpath);
			}
		},
	};
}

const unavailableFile = (relpath: string): Response =>
	typedError("unavailable", `stored file ${relpath} is unavailable (missing on disk)`, 404);

/** Raw lines per sparse index checkpoint; a page seeks to the nearest one at or below its start. */
const LINE_INDEX_STRIDE = 1000;
/** Bytes of returned lines one page may read; the page ends at the next line boundary past this. */
const PAGE_BYTE_BUDGET = 4 * 1024 * 1024;
/** Streaming chunk size for the newline scan and page reads. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/** Byte offsets of every LINE_INDEX_STRIDE-th raw line of one stored file version. */
interface LineIndex {
	totalLines: number;
	/** starts[k] is the byte offset of raw line k * LINE_INDEX_STRIDE. */
	starts: number[];
}

/** One page of raw lines; `nextLine` is the cursor of the next page, or null at EOF. */
interface PageRead {
	lines: string[];
	nextLine: number | null;
	truncated: boolean;
}

const LINE_INDEX_CACHE_LIMITS: ByteLruLimits = {
	maxBytes: 4 * 1024 * 1024,
	maxEntryBytes: 1024 * 1024,
};
const lineIndexCache = new ByteLru<LineIndex>(LINE_INDEX_CACHE_LIMITS);

/** Size of a stored regular file; 0 when missing (treated as unavailable). */
function storedFileSize(file: string): number {
	try {
		const st = statSync(file);
		return st.isFile() ? st.size : 0;
	} catch {
		return 0;
	}
}

/** One streaming newline scan (no JSON parse) that records a checkpoint every stride. */
function buildLineIndex(file: string, size: number): LineIndex {
	const starts = [0];
	let newlines = 0;
	let endsWithNewline = false;
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
		let pos = 0;
		while (pos < size) {
			const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
			if (n <= 0) break;
			for (let i = 0; i < n; i++) {
				if (buf[i] !== 0x0a) continue;
				newlines += 1;
				if (newlines % LINE_INDEX_STRIDE === 0 && pos + i + 1 < size) starts.push(pos + i + 1);
			}
			endsWithNewline = buf[n - 1] === 0x0a;
			pos += n;
		}
	} finally {
		closeSync(fd);
	}
	return { totalLines: newlines + (endsWithNewline ? 0 : 1), starts };
}

/** Sparse line index for one (path, size) version, built once and cached. */
function lineIndexOf(file: string, size: number): LineIndex {
	const key = `${file}\0${size}`;
	const cached = lineIndexCache.get(key);
	if (cached !== undefined) return cached;
	const index = buildLineIndex(file, size);
	lineIndexCache.set(key, index, 8 * index.starts.length + 64);
	return index;
}

/**
 * Reads raw lines [startLine, startLine + limit): seeks to the nearest
 * checkpoint and scans forward in chunks. Lines before startLine are skipped
 * without copying; the page ends early at a line boundary once
 * PAGE_BYTE_BUDGET bytes of returned lines are collected.
 */
function readLinePage(
	file: string,
	size: number,
	index: LineIndex,
	startLine: number,
	limit: number,
): PageRead {
	const checkpoint = Math.floor(startLine / LINE_INDEX_STRIDE);
	const lines: string[] = [];
	let lineNo = checkpoint * LINE_INDEX_STRIDE;
	let collectedBytes = 0;
	let partial: Buffer[] = [];
	let full = false;
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
		let pos = index.starts[checkpoint]!;
		while (!full && pos < size) {
			const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
			if (n <= 0) break;
			let segStart = 0;
			for (let i = 0; i < n && !full; i++) {
				if (buf[i] !== 0x0a) continue;
				const seg = buf.subarray(segStart, i);
				segStart = i + 1;
				if (lineNo >= startLine) {
					const text = partial.length === 0 ? seg : Buffer.concat([...partial, seg]);
					lines.push(text.toString("utf8"));
					collectedBytes += text.length;
					full = lines.length >= limit || collectedBytes >= PAGE_BYTE_BUDGET;
				}
				partial = [];
				lineNo += 1;
			}
			if (!full && lineNo >= startLine && segStart < n) {
				partial.push(Buffer.from(buf.subarray(segStart, n)));
			}
			pos += n;
		}
		if (!full && partial.length > 0 && lineNo >= startLine) {
			lines.push(Buffer.concat(partial).toString("utf8"));
			lineNo += 1;
		}
	} finally {
		closeSync(fd);
	}
	const nextLine = lineNo < index.totalLines ? lineNo : null;
	return { lines, nextLine, truncated: full && lines.length < limit && nextLine !== null };
}

/**
 * Paginated parsed view of a stored JSONL file. Offsets are raw line indexes
 * (the same cursor as /ctl/stats), so a page reads and parses only its own
 * window. `truncated` marks a page that ended at PAGE_BYTE_BUDGET before its
 * line limit; `nextOffset` continues from there.
 */
function parsedTranscript(file: string, size: number, url: URL): Response {
	const rawOffset = url.searchParams.get("offset");
	const rawLimit = url.searchParams.get("limit");
	const offset = rawOffset === null ? 0 : Number.parseInt(rawOffset, 10);
	const limit = rawLimit === null ? 200 : Number.parseInt(rawLimit, 10);
	const startLine = Number.isFinite(offset) && offset >= 0 ? offset : 0;
	const pageLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200;
	const index = lineIndexOf(file, size);
	const page: PageRead =
		startLine < index.totalLines
			? readLinePage(file, size, index, startLine, pageLimit)
			: { lines: [], nextLine: null, truncated: false };
	const entries: RawEntry[] = [];
	for (const line of page.lines) {
		const e = parseLine(line);
		if (e) entries.push(e);
	}
	const body: TranscriptPage = {
		entries,
		nextOffset: page.nextLine,
		offset: startLine,
		limit: pageLimit,
		totalLines: index.totalLines,
		truncated: page.truncated,
	};
	return json(body);
}

// ---------------------------------------------------------------------------
// Detail route
// ---------------------------------------------------------------------------

function detailRoute(deps: StoredAppDeps): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stored\/sessions\/([^/]+)\/([^/]+)$/,
		handler: ({ params }) => {
			const workspaceId = decodeSegment(params[0]!);
			const sessionId = decodeSegment(params[1]!);
			if (
				workspaceId === null ||
				sessionId === null ||
				!isSafeComponent(workspaceId) ||
				!isSafeComponent(sessionId)
			) {
				return typedError("invalid_request", "invalid session identity", 400);
			}
			const info = deps.store.storedLineage(workspaceId, sessionId);
			if (info === null) {
				return typedError("unavailable", "session not found in fleet store", 404);
			}
			return json(detailRow(deps, info, deps.store.isReadOnly(workspaceId)));
		},
	};
}

// ---------------------------------------------------------------------------
// Sessions + workspaces routes
// ---------------------------------------------------------------------------

function sessionsRoute(deps: StoredAppDeps): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stored\/sessions$/,
		handler: ({ url }) => {
			const rawWs = url.searchParams.get("workspaceId");
			const ws = rawWs === null ? null : decodeSegment(rawWs);
			if (rawWs !== null && (ws === null || !isSafeComponent(ws))) {
				return typedError("invalid_request", "invalid workspaceId", 400);
			}
			let rows: StoredSessionInfo[];
			if (ws === null) {
				rows = deps.store.listStoredWorkspaces().flatMap((w) => w.sessions);
			} else {
				rows = deps.store.listStoredSessions(ws);
			}
			const sessions = rows.map((s) => summaryRow(deps, s, deps.store.isReadOnly(s.workspaceId)));
			// Enrich titles from stored main heads when present.
			for (let i = 0; i < sessions.length; i++) {
				const s = sessions[i]!;
				const mainRel = s.mainRelpath;
				if (mainRel === undefined) continue;
				const head = headOf(deps.store, s.workspaceId, s.sessionId, mainRel);
				if (head === null) continue;
				s.title = head.title;
				s.cwd = head.cwd;
				s.firstTs = head.firstTs;
				s.lastTs = head.lastTs;
			}
			sessions.sort(
				(a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || (a.sessionId < b.sessionId ? -1 : 1),
			);
			return json({ sessions });
		},
	};
}

function workspacesRoute(deps: StoredAppDeps): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stored\/workspaces$/,
		handler: () => {
			const workspaces = deps.store
				.listStoredWorkspaces()
				.map((w) => workspaceRow(deps, w.workspaceId, w.sessions, w.readOnly));
			return json({ workspaces });
		},
	};
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

export function createStoredApp(deps: StoredAppDeps): StoredApp {
	const routes: Route[] = [
		workspacesRoute(deps),
		sessionsRoute(deps),
		detailRoute(deps),
		transcriptRoute(deps),
	];
	return { handleFetch: (req, url) => dispatchRequest(req, routes, url) };
}

export interface StoredApp {
	handleFetch(req: Request, url: URL): Promise<Response | null>;
}

// Re-export the store's own read types so consumers import one module.
export type { StoredFileInfo, StoredFileKind };
