/**
 * Wire contracts for the read-only transcripts/stats API (fleet/stats).
 * Server (fleet/stats/*) implements; client (src/tx/api.ts) consumes.
 * Leaf module: no in-repo imports. Ported from the standalone
 * omp-transcripts.theme "session-viewer" app.
 */

/** One raw JSONL line object, unmodified. */
export type RawEntry = Record<string, unknown>;

export interface SessionSummary {
	/** relative path from sessionsDir, `/`-separated; use as the :file route param */
	file: string;
	/** project dir name (lossy; display only) */
	folder: string;
	title: string | null;
	id: string | null;
	cwd: string | null;
	firstTs: number | null;
	lastTs: number | null;
	turns: number;
	toolCalls: number;
	totalTokens: number;
	totalCost: number;
	errorTurns: number;
	modelCount: number;
	userMessages: number;
	userChars: number;
	/** false when the file has no stats.db rows (not yet synced) */
	synced: boolean;
	/** true when the file exists on disk */
	onDisk: boolean;
	size: number;
	mtimeMs: number;
	/**
	 * Coverage label (P8.6). "fleet-local" (default, omitted) = the row came
	 * from the fleet-local sessions dir walk + stats.db; "fleet-store" = the
	 * session lives in the fleet transcript store (deleted/stopped workspace,
	 * compute absent). A "fleet-store" row's `file` is a display key only;
	 * read its bytes through the /ctl/stored routes, never /ctl/stats.
	 */
	origin?: "fleet-local" | "fleet-store";
	/** Store provenance when the session also exists in the fleet log store. */
	stored?: {
		workspaceId: string;
		sessionId: string;
		mainRelpath: string;
		readOnly: boolean;
		orphaned: boolean;
	};
}

export interface ToolStat {
	name: string;
	calls: number;
	errors: number;
	/** calls with no linked toolResult yet (JSONL pass) */
	pending: number;
	totalMs: number;
	avgMs: number | null;
	maxMs: number | null;
	argsChars: number;
	resultChars: number;
}

export interface LongestCall {
	toolName: string;
	toolCallId: string;
	durationMs: number;
	args: string;
}

export interface SessionStats {
	file: string;
	title: string | null;
	/** false when stats.db has no rows for this session; metrics below mix
	 *  live-JSONL counts with empty DB columns */
	synced: boolean;
	spanMs: number | null;
	turns: number;
	toolCalls: number;
	tools: ToolStat[];
	longestCall: LongestCall | null;
	latency: { p50: number | null; p90: number | null };
	totals: { tokens: number; cost: number };
	errors: { timestamp: number; model: string; message: string | null }[];
	user: { count: number; chars: number };
}

export interface ToolGlobal {
	name: string;
	calls: number;
	errors: number;
	sessions: number;
}

export interface SubagentInfo {
	/** relative path from sessionsDir */
	file: string;
	/** basename, e.g. "NoteFootprintAudit.jsonl" or "__advisor.jsonl" */
	name: string;
	size: number;
	mtimeMs: number;
}

/** GET /ctl/stats/sessions envelope. `total` is the count before the 2000 cap; `truncated` true when the cap cut the list. */
export interface SessionsResponse {
	sessions: SessionSummary[];
	total: number;
	truncated: boolean;
}

export interface TranscriptPage {
	entries: RawEntry[];
	nextOffset: number | null;
	offset: number;
	limit: number;
	/** Raw line count including corrupt lines (page progress "N of M"). */
	totalLines: number;
	/** True when the file exceeded the byte cap and was parsed only up to it. */
	truncated: boolean;
}

export interface Health {
	ok: boolean;
	statsDb: "ok" | "missing" | "error";
	statsDbPath: string;
	statsDbFromCopy: boolean;
	sessionsDir: string;
	sessionsCount: number;
	dbCounts: { messages: number; toolCalls: number; userMessages: number } | null;
	/** Fleet log-store coverage (P8.6); absent when no store is mounted. */
	fleetStore?: {
		workspaces: number;
		sessions: number;
		bytes: number;
	};
}

/** POST /ctl/stats/sync success body. */
export interface SyncResult {
	processed: number;
	files: number;
	totalMessages: number;
	durationMs: number;
}

// ---------------------------------------------------------------------------
// Fleet log-store read surface (P8.5). Server: fleet/log-store.ts + fleet/
// stored-sessions.ts. Client: src/tx reads these through /ctl/stored.
// Browsing is fleet-owned and read-only and never wakes compute.
// ---------------------------------------------------------------------------

export type StoredFileKind = "main" | "subagent" | "advisor" | "metadata";

export type StoredFileStatus = "stored" | "missing";

/** One file of a stored session (raw bytes are byte-identical to the stream). */
export interface StoredFileInfo {
	/** POSIX relpath of the file inside the session subtree (manifest base). */
	relpath: string;
	kind: StoredFileKind;
	/** Main-session relpath this file's artifact subtree nests under. */
	parentPath?: string;
	/** Durable bytes on disk (0 when status is "missing"). */
	bytes: number;
	/** Last durable append offset recorded in the index sidecar. */
	ackedBytes: number;
	/** True when the daemon closed the stream. */
	eof: boolean;
	/** "missing" = indexed but absent on disk; unavailable, never a broken link. */
	status: StoredFileStatus;
}

/** Secret-free source/workspace provenance for a stored workspace. */
export interface StoredWorkspaceProvenance {
	projectId: string;
	kind: "clone" | "worktree" | "direct";
	profileId?: string;
	branch?: string;
	pinnedRevision?: string;
	/** Present only when the clone source was a single remote URL. */
	sourceKind?: "local" | "remote";
}

/** GET /ctl/stored/workspaces row. */
export interface StoredWorkspaceSummary {
	workspaceId: string;
	sessions: number;
	/** Durable bytes across the workspace subtree. */
	bytes: number;
	/** True when the workspace passed deletion verification. */
	readOnly: boolean;
	/** True when no live roster entry owns this workspace (deleted). */
	orphaned: boolean;
	viewOnly: boolean;
	provenance?: StoredWorkspaceProvenance;
	/** Present only on orphaned workspaces: the ONLY resume affordance. */
	resumeClonePath?: string;
}

/** GET /ctl/stored/sessions row (files omitted; fetch the detail for them). */
export interface StoredSessionSummary {
	workspaceId: string;
	sessionId: string;
	title: string | null;
	cwd: string | null;
	firstTs: number | null;
	lastTs: number | null;
	bytes: number;
	fileCount: number;
	kinds: { main: number; subagent: number; advisor: number; metadata: number };
	mainRelpath?: string;
	readOnly: boolean;
	orphaned: boolean;
	missingAssets: number;
	provenance?: StoredWorkspaceProvenance;
}

/** GET /ctl/stored/sessions/:workspaceId/:sessionId response. */
export interface StoredSessionDetail extends StoredSessionSummary {
	files: StoredFileInfo[];
}

/** GET /ctl/stored/workspaces response. */
export interface StoredWorkspacesResponse {
	workspaces: StoredWorkspaceSummary[];
}

/** GET /ctl/stored/sessions response. */
export interface StoredSessionsResponse {
	sessions: StoredSessionSummary[];
}
