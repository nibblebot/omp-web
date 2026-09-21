/**
 * Fleet log-store read model + HTTP surface (P8.5). Everything here is a
 * pure disk read over FleetLogStore: never touches a daemon, the SDK, or
 * compute, so browsing fleet-stored history can never wake a workspace.
 *
 * Layering: imports only fleet/log-store.ts, shared/stats-types.ts, node
 * builtins and ./: never server/ or src/. Reuses the stats app's route
 * registry convention (Route + dispatchRequest + json/errorJson) so the
 * fleet control plane can mount it with one line beside /ctl/stats.
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
import { json, errorJson, dispatchRequest } from "./stats/http";
import type { Route } from "./stats/types";
import type { FleetLogStore, StoredFileInfo, StoredSessionInfo } from "./log-store";
import type {
	StoredFileKind,
	StoredSessionDetail,
	StoredSessionSummary,
	StoredWorkspaceProvenance,
	StoredWorkspaceSummary,
	TranscriptPage,
	RawEntry,
} from "../shared/stats-types";
import { parseLine } from "./stats/lib/jsonl";

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
// Wire-row assembly
// ---------------------------------------------------------------------------

function publicProvenanceOf(
	deps: StoredAppDeps,
	workspaceId: string,
): PublicProvenance | undefined {
	return provenanceFor(deps, workspaceId);
}

/** readOnly is a workspace-level property; thread it onto each session row. */
function summaryRow(
	deps: StoredAppDeps,
	s: StoredSessionInfo,
	readOnly: boolean,
): StoredSessionSummary {
	const provenance = publicProvenanceOf(deps, s.workspaceId);
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
	const provenance = publicProvenanceOf(deps, workspaceId);
	const orphaned = provenance === undefined;
	return {
		workspaceId,
		sessions: sessions.length,
		bytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
		readOnly,
		orphaned,
		viewOnly: true,
		...(provenance ? { provenance } : {}),
		...(orphaned ? { resumeClonePath: `/ctl/workspaces/${workspaceId}/resume-clone` } : {}),
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

/** Title slot (line 1) + session header (line 2) of a stored JSONL file. */
function headOf(
	store: FleetLogStore,
	workspaceId: string,
	sessionId: string,
	relpath: string,
): {
	title: string | null;
	cwd: string | null;
	id: string | null;
	firstTs: number | null;
	lastTs: number | null;
} | null {
	const bytes = store.readStored(workspaceId, sessionId, relpath);
	if (bytes === null) return null;
	// The fixed 256 B title slot precedes the header; read up to the first
	// few newline-terminated records without parsing the whole file.
	let text: string;
	try {
		text = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString("utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n").slice(0, 4);
	const entries: RawEntry[] = [];
	for (const line of lines) {
		const e = parseLine(line);
		if (e) entries.push(e);
	}
	const first = entries[0];
	const second = entries[1];
	const head = first?.type === "session" ? first : second?.type === "session" ? second : undefined;
	const title =
		first?.type === "title" && typeof first.title === "string"
			? first.title
			: head && typeof head.title === "string"
				? head.title
				: null;
	const cwd = head && typeof head.cwd === "string" ? head.cwd : null;
	const id = head && typeof head.id === "string" ? head.id : null;
	let firstTs: number | null = null;
	let lastTs: number | null = null;
	for (const e of entries) {
		if (typeof e.timestamp === "number") {
			if (firstTs === null) firstTs = e.timestamp;
			lastTs = e.timestamp;
		}
	}
	if (id !== null && id !== sessionId) {
		// Header id mismatch: still a real stored file; surface the head.
	}
	return { title, cwd, id, firstTs, lastTs };
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
				return errorJson("invalid session identity", 400);
			}
			const store = deps.store;
			const lineage = store.storedLineage(workspaceId, sessionId);
			if (lineage === null) {
				return errorJson("session not found in fleet store", 404);
			}
			const fileParam = url.searchParams.get("file");
			let relpath: string | undefined;
			if (fileParam === null) {
				relpath = lineage.mainRelpath;
			} else {
				const decoded = decodeRelpathParam(fileParam);
				if (decoded === null) {
					return errorJson("invalid file relpath", 400);
				}
				relpath = decoded;
			}
			if (relpath === undefined || relpath.length === 0) {
				return errorJson("no main transcript stored for this session", 404);
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
			if (format !== "parsed") return errorJson("invalid format (parsed|raw)", 400);
			// Bounded parse: never buffer or parse more than the cap; the
			// prefix is line-truncated at the cap so `truncated` is honest.
			const bytes = store.readStoredPrefix(workspaceId, sessionId, relpath, MAX_PARSE_BYTES);
			if (bytes === null) return unavailableFile(relpath);
			return parsedTranscript(bytes, url, MAX_PARSE_BYTES);
		},
	};
}

const unavailableFile = (relpath: string): Response =>
	json(
		{
			error: {
				code: "unavailable",
				message: `stored file ${relpath} is unavailable (missing on disk)`,
			},
		},
		404,
	);

/** Parse cap for one stored transcript (mirrors the stats jsonl convention). */
const MAX_PARSE_BYTES = 256 * 1024 * 1024;

/**
 * Paginated parsed view of a stored JSONL file's bytes. `readBytes` is the
 * cap the prefix was read at; when the real file is larger, the page is
 * marked truncated and the line count is "as parsed", which the UI reports
 * honestly instead of a wrong total.
 */
async function parsedTranscript(bytes: Buffer, url: URL, readBytes: number): Promise<Response> {
	const rawOffset = url.searchParams.get("offset");
	const rawLimit = url.searchParams.get("limit");
	const offset = rawOffset === null ? 0 : Number.parseInt(rawOffset, 10);
	const limit = rawLimit === null ? 200 : Number.parseInt(rawLimit, 10);
	const startLine = Number.isFinite(offset) && offset >= 0 ? offset : 0;
	const pageLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200;
	const text = bytes.toString("utf8");
	const rawLines = text.split("\n");
	// A trailing newline must not count as an extra empty line.
	const totalLines = text.endsWith("\n") ? rawLines.length - 1 : rawLines.length;
	const entries: RawEntry[] = [];
	const lineIndex: number[] = [];
	let lineNo = 0;
	for (const line of rawLines) {
		const e = parseLine(line);
		if (e) {
			entries.push(e);
			lineIndex.push(lineNo);
		}
		lineNo += 1;
	}
	const truncated = text.length >= readBytes && !text.endsWith("\n");
	const pageStart = startLine;
	const pageEnd = Math.min(pageStart + pageLimit, entries.length);
	const page = entries.slice(pageStart, pageEnd);
	const body: TranscriptPage = {
		entries: page,
		nextOffset: pageEnd < entries.length ? pageEnd : null,
		offset: pageStart,
		limit: pageLimit,
		totalLines,
		truncated,
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
				return errorJson("invalid session identity", 400);
			}
			const info = deps.store.storedLineage(workspaceId, sessionId);
			if (info === null) return errorJson("session not found in fleet store", 404);
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
				return errorJson("invalid workspaceId", 400);
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
