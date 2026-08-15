/**
 * Analytics routes.
 *
 * GET /ctl/stats/tools                → { tools: ToolGlobal[] }
 * GET /ctl/stats/sessions/:file/stats → SessionStats
 *
 * Per-session stats merge two sources:
 *   - stats.db — authoritative counts (works even when the session file is gone)
 *   - the session JSONL — durations / pending calls / title, cached by
 *     (mtimeMs, size) so repeated reads of large files are cheap.
 */
import { existsSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { json, errorJson } from "../http";
import { decodeFileParam, normDbFile, toAbs } from "../paths";
import { resolveContained } from "../lib/session-paths";
import {
  loadJsonl,
  entryTs,
  toolExecutionStart,
  isAssistant,
  isToolResult,
  toolCallsOf,
  resultText,
} from "../lib/jsonl";
import type { AppCtx, Route } from "../types";
import type { SessionStats, ToolStat, ToolGlobal, RawEntry, LongestCall } from "../../../shared/stats-types";

// ---------------------------------------------------------------------------
// GET /ctl/stats/tools — global tool breakdown across all sessions.
// ---------------------------------------------------------------------------

function toolsRoute(ctx: AppCtx): Route {
  return {
  method: "GET",
  pattern: /^\/ctl\/stats\/tools$/,
  handler: () => {
    const db = ctx.dbm.db();
    if (!db) return errorJson("stats.db unavailable", 503);
    const tools: ToolGlobal[] = [];
    try {
      const rows = db.query(
        `SELECT tool_name AS name, COUNT(*) AS calls,
                SUM(COALESCE(is_error, 0)) AS errors,
                COUNT(DISTINCT session_file) AS sessions
         FROM tool_calls
         GROUP BY tool_name
         ORDER BY calls DESC`
      ).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        tools.push({
          name: String(r.name),
          calls: Number(r.calls ?? 0),
          errors: Number(r.errors ?? 0),
          sessions: Number(r.sessions ?? 0),
        });
      }
    } catch (err) {
      console.error("[stats-db] tools query failed", { error: err });
      return errorJson("stats.db unavailable", 503);
    }
    return json({ tools });
  },
  };
}

// ---------------------------------------------------------------------------
// SQL half (stats.db).
// ---------------------------------------------------------------------------

interface SqlTool {
  name: string;
  calls: number;
  errors: number;
  argsChars: number;
  resultChars: number;
}

interface SqlStats {
  tools: SqlTool[];
  byName: Map<string, SqlTool>;
  turns: number;
  toolCalls: number;
  tokens: number;
  cost: number;
  firstTs: number | null;
  lastTs: number | null;
  durations: number[];
  errors: { timestamp: number; model: string; message: string | null }[];
  userCount: number;
  userChars: number;
}

function querySqlStats(db: Database, sessionAbs: string, sessionRel: string): SqlStats {
  // stats.db stores session_file as ABSOLUTE on this machine, but the schema
  // documents RELATIVE paths — match both forms so a session is never missed.
  const sessionFileArgs = [sessionAbs, sessionRel];
  const toolRows = db.query(
    `SELECT tool_name AS name, COUNT(*) AS calls,
            SUM(COALESCE(is_error, 0)) AS errors,
            SUM(args_chars) AS args_chars,
            SUM(COALESCE(result_chars, 0)) AS result_chars
     FROM tool_calls
     WHERE session_file IN (?, ?)
     GROUP BY tool_name
     ORDER BY calls DESC`
  ).all(...sessionFileArgs) as Array<Record<string, unknown>>;

  const tools: SqlTool[] = [];
  for (const r of toolRows) {
    tools.push({
      name: String(r.name),
      calls: Number(r.calls ?? 0),
      errors: Number(r.errors ?? 0),
      argsChars: Number(r.args_chars ?? 0),
      resultChars: Number(r.result_chars ?? 0),
    });
  }

  const agg = db.query(
    `SELECT COUNT(*) AS turns,
            SUM(total_tokens) AS tokens,
            SUM(cost_total) AS cost,
            MIN(timestamp) AS first_ts,
            MAX(timestamp) AS last_ts
     FROM messages
     WHERE session_file IN (?, ?)`
  ).get(...sessionFileArgs) as {
    turns?: unknown;
    tokens?: unknown;
    cost?: unknown;
    first_ts?: unknown;
    last_ts?: unknown;
  };

  const durationRows = db.query(
    `SELECT duration FROM messages WHERE session_file IN (?, ?) AND duration IS NOT NULL`
  ).all(...sessionFileArgs) as Array<{ duration: unknown }>;

  const errorRows = db.query(
    `SELECT timestamp, model, error_message AS message
     FROM messages
     WHERE session_file IN (?, ?) AND stop_reason = 'error'
     ORDER BY timestamp DESC
     LIMIT 100`
  ).all(...sessionFileArgs) as Array<{ timestamp: unknown; model: unknown; message: unknown }>;

  const userRow = db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(chars), 0) AS chars
     FROM user_messages
     WHERE session_file IN (?, ?)`
  ).get(...sessionFileArgs) as { count?: unknown; chars?: unknown };

  const durations: number[] = [];
  for (const r of durationRows) {
    if (typeof r.duration === "number" && Number.isFinite(r.duration)) durations.push(r.duration);
  }

  return {
    tools,
    byName: new Map(tools.map((t) => [t.name, t])),
    turns: Number(agg.turns ?? 0),
    toolCalls: tools.reduce((s, t) => s + t.calls, 0),
    tokens: Number(agg.tokens ?? 0),
    cost: Number(agg.cost ?? 0),
    firstTs: agg.first_ts == null ? null : Number(agg.first_ts),
    lastTs: agg.last_ts == null ? null : Number(agg.last_ts),
    durations,
    errors: errorRows.map((r) => ({
      timestamp: Number(r.timestamp),
      model: String(r.model ?? ""),
      message: r.message == null ? null : String(r.message),
    })),
    userCount: Number(userRow.count ?? 0),
    userChars: Number(userRow.chars ?? 0),
  };
}

// ---------------------------------------------------------------------------
// JSONL half (durations, pending calls, title). Cached per file.
// ---------------------------------------------------------------------------

interface JsonlTool {
  calls: number;
  errors: number;
  pending: number;
  /** Internal count of calls that produced a duration (has an execution-start marker). Not serialized. */
  timed: number;
  totalMs: number;
  avgMs: number | null;
  maxMs: number | null;
  argsChars: number;
  resultChars: number;
}

interface JsonlPass {
  title: string | null;
  spanMs: number | null;
  turns: number;
  toolCalls: number;
  tools: Map<string, JsonlTool>;
  longestCall: LongestCall | null;
}

const JSONL_CACHE_MAX = 100;
const jsonlCache = new Map<string, { mtimeMs: number; size: number; result: JsonlPass }>();

/** Run the JSONL pass, caching by (mtimeMs, size). Returns null when the file is missing/unreadable. */
async function cachedJsonlPass(abs: string): Promise<JsonlPass | null> {
  try {
    const st = statSync(abs);
    const hit = jsonlCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      jsonlCache.delete(abs); // refresh recency
      jsonlCache.set(abs, hit);
      return hit.result;
    }
    const result = await jsonlPass(abs);
    jsonlCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, result });
    if (jsonlCache.size > JSONL_CACHE_MAX) {
      const oldest = jsonlCache.keys().next().value;
      if (oldest !== undefined) jsonlCache.delete(oldest);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Duration pairing: tool result ts − tool_execution_start.startedAt (epoch ms).
 * Calls without an execution-start marker are untimed (counted, no duration).
 * Pending calls contribute none.
 */
async function jsonlPass(abs: string): Promise<JsonlPass> {
  const entries = (await loadJsonl(abs))?.entries ?? [];

  // Index tool results by toolCallId for O(1) pairing.
  const results = new Map<string, RawEntry>();
  for (const e of entries) {
    if (isToolResult(e)) results.set(e.message.toolCallId, e);
  }

  // Index tool-execution starts by toolCallId for O(1) pairing.
  const execStarts = new Map<string, number>();
  for (const e of entries) {
    const st = toolExecutionStart(e);
    if (st) execStarts.set(st.toolCallId, st.startedAtMs);
  }

  const tools = new Map<string, JsonlTool>();
  let longestCall: LongestCall | null = null;
  let bestMs = -1;
  let turns = 0;
  let toolCalls = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const e of entries) {
    const ts = entryTs(e);
    if (ts != null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (!isAssistant(e)) continue;
    turns++;
    const calls = toolCallsOf(e);
    if (calls.length === 0) continue;
    for (const c of calls) {
      toolCalls++;
      let agg = tools.get(c.name);
      if (!agg) {
        agg = {
          calls: 0,
          errors: 0,
          pending: 0,
          timed: 0,
          totalMs: 0,
          avgMs: null,
          maxMs: null,
          argsChars: 0,
          resultChars: 0,
        };
        tools.set(c.name, agg);
      }
      agg.calls++;
      agg.argsChars += c.argsChars;
      const r = results.get(c.id);
      if (!r) {
        agg.pending++;
        continue;
      }
      if (isErrorResult(r)) agg.errors++;
      agg.resultChars += resultText(r).length;
      const rTs = entryTs(r);
      if (rTs != null) {
        const startMs = execStarts.get(c.id);
        if (startMs === undefined) continue; // no execution-start marker → untimed; never fall back to LLM turn spans
        const dur = Math.max(0, rTs - startMs);
        agg.timed++;
        agg.totalMs += dur;
        if (agg.maxMs === null || dur > agg.maxMs) {
          agg.maxMs = dur;
        }
        if (dur > bestMs) {
          bestMs = dur;
          longestCall = {
            toolName: c.name,
            toolCallId: c.id,
            durationMs: dur,
            args: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
          };
        }
      }
    }
  }

  for (const agg of tools.values()) {
    agg.avgMs = agg.timed > 0 ? agg.totalMs / agg.timed : null;
  }

  return {
    title: await readTitle(abs),
    spanMs: firstTs != null && lastTs != null ? lastTs - firstTs : null,
    turns,
    toolCalls,
    tools,
    longestCall,
  };
}

/**
 * Title slot (line 1) → session header (line 2), read from the shared JSONL
 * layer's head. Scans the first four RAW lines (lineIndex < 4, corrupt lines
 * skipped) so behavior matches the old first-4KB-of-head scan.
 */
async function readTitle(abs: string): Promise<string | null> {
  const doc = await loadJsonl(abs);
  if (!doc) return null;
  for (let i = 0; i < doc.entries.length && doc.lineIndex[i]! < 4; i++) {
    const e = doc.entries[i]!;
    if (e.type === "title" && typeof e.title === "string" && e.title !== "") return e.title;
    if (e.type === "session" && typeof e.title === "string" && e.title !== "") return e.title;
  }
  return null;
}

/** True when a toolResult entry carries an error flag (message-level or content block). */
function isErrorResult(e: RawEntry): boolean {
  const m = e.message as { isError?: unknown; content?: Array<Record<string, unknown>> } | null | undefined;
  if (!m || typeof m !== "object") return false;
  if (m.isError === true) return true;
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && typeof b === "object" && b.type === "toolResult" && b.isError === true) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Merge + route.
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function buildStats(rel: string, sql: SqlStats | null, j: JsonlPass | null): SessionStats {
  const sqlHasData =
    !!sql && (sql.turns > 0 || sql.toolCalls > 0 || sql.errors.length > 0 || sql.userCount > 0);

  // Union of tool names: SQL ∪ JSONL.
  const names = new Set<string>();
  if (sql) for (const t of sql.tools) names.add(t.name);
  if (j) for (const n of j.tools.keys()) names.add(n);

  const tools: ToolStat[] = [];
  for (const name of names) {
    const s = sql?.byName.get(name);
    const jt = j?.tools.get(name);
    tools.push({
      name,
      calls: s ? s.calls : (jt?.calls ?? 0),
      errors: s ? s.errors : (jt?.errors ?? 0),
      pending: jt?.pending ?? 0,
      totalMs: jt?.totalMs ?? 0,
      avgMs: jt?.avgMs ?? null,
      maxMs: jt?.maxMs ?? null,
      argsChars: s ? s.argsChars : (jt?.argsChars ?? 0),
      resultChars: s ? s.resultChars : (jt?.resultChars ?? 0),
    });
  }
  tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const durations = (sql?.durations ?? []).slice().sort((a, b) => a - b);

  let spanMs: number | null = null;
  if (sql && sql.firstTs != null && sql.lastTs != null) spanMs = sql.lastTs - sql.firstTs;
  else if (j?.spanMs != null) spanMs = j.spanMs;

  return {
    file: rel,
    title: j?.title ?? null,
    synced: sqlHasData,
    spanMs,
    turns: sql && sqlHasData ? sql.turns : (j?.turns ?? 0),
    toolCalls: sql && sqlHasData ? sql.toolCalls : (j?.toolCalls ?? 0),
    tools,
    longestCall: j?.longestCall ?? null,
    latency: { p50: percentile(durations, 50), p90: percentile(durations, 90) },
    totals: { tokens: sql?.tokens ?? 0, cost: sql?.cost ?? 0 },
    errors: sql?.errors ?? [],
    user: { count: sql?.userCount ?? 0, chars: sql?.userChars ?? 0 },
  };
}

function statsRoute(ctx: AppCtx): Route {
  return {
  method: "GET",
  pattern: /^\/ctl\/stats\/sessions\/(.+)\/stats$/,
  handler: async ({ params }) => {
    const { cfg } = ctx;
    const db = ctx.dbm.db();
    const rel = decodeFileParam(cfg.sessionsDir, params[0] ?? "");
    if (!rel) return errorJson("session not found", 404);

    const abs = toAbs(cfg.sessionsDir, rel)!;
    // Missing-file semantics: a `:file` detail for a file that is not on disk
    // is 404 — even when stats.db still has rows for it (DB-only sessions stay
    // visible in the SESSIONS LIST with onDisk:false; their :file details are
    // gone). Symlinked paths that escape sessionsDir are also 404.
    if (!existsSync(abs)) return errorJson("session not found", 404);
    if (resolveContained(cfg.sessionsDir, rel) === null) {
      return errorJson("session not found", 404);
    }

    let sql: SqlStats | null = null;
    if (db) {
      try {
        sql = querySqlStats(db, normDbFile(cfg.sessionsDir, rel), rel);
      } catch {
        sql = null; // stats.db unusable for this query → JSONL-only
      }
    }

    const j = await cachedJsonlPass(abs);

    return json(buildStats(rel, sql, j));
  },
  };
}

export function register(ctx: AppCtx, routes: Route[]): void {
  routes.push(toolsRoute(ctx), statsRoute(ctx));
}
