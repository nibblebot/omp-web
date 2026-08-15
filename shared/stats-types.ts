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
  /** false when stats.db has no rows for this session — metrics below mix live-JSONL counts with empty DB columns */
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
}

/** POST /ctl/stats/sync success body. */
export interface SyncResult {
  processed: number;
  files: number;
  totalMessages: number;
  durationMs: number;
}
