/**
 * GET /ctl/stats/sessions — full session list with DB-enriched metrics.
 *
 * Disk is the primary source of which sessions exist; stats.db aggregates
 * (one pass per table) fill in the real numbers. Sessions with DB rows but
 * no file on disk (deleted/archived) are appended with onDisk:false so the
 * client can mark them missing (PLAN §6). Files on disk that were never
 * synced appear with zeroed metrics and synced:false.
 */
import { statSync, readdirSync } from "node:fs";
import { relative, join } from "node:path";
import { json, errorJson } from "../http";
import { loadJsonl } from "../lib/jsonl";
import { walkJsonl } from "../lib/sessions-index";
import type { AppCtx, Route } from "../types";
import type { SessionSummary } from "../../../shared/stats-types";
import { normDbFile, isMainSession, folderOf } from "../paths";
import type { StatsConfig } from "../config";

const MAX_SESSIONS = 2000;

// ---------------------------------------------------------------------------
// Sessions list cache (2026-08 audit Phase 3).
//
// The computed list (disk walk + stats.db enrichment) is cached under a key
// of (recursive sessions-tree dir stats, stats.db mtimeMs+size when the file
// exists). File adds/removes anywhere invalidate the key immediately via the
// containing dir's stat; an existing transcript GROWING in place changes no
// dir stat, so without a TTL the row size/mtime columns would go stale
// indefinitely — the TTL bounds that staleness. Entries are capped at 2
// (current + previous key) so dir churn cannot grow the cache without bound.
// ---------------------------------------------------------------------------

/** Staleness bound for in-place transcript growth (dir stat unchanged). */
export const SESSIONS_CACHE_TTL_MS = 3000;

const SESSIONS_CACHE_MAX_ENTRIES = 2;

interface ListCacheEntry {
	expiresAt: number;
	rows: SessionSummary[];
}

const sessionsListCache = new Map<string, ListCacheEntry>();

/** Test instrumentation: counts real disk-walk executions (cache hits skip). */
export const sessionsWalkCounter = { runs: 0 };

/**
 * Recursive directory-stat signature: every directory's (mtimeMs, size) in
 * the tree. Detects file adds/removes/renames anywhere (the containing
 * dir's stat changes) — the root dir's own mtime does NOT move when a
 * subdirectory gains files, which a flat "sessionsDir mtime" key would
 * miss. In-place file GROWTH changes no dir stat, so that case stays
 * bounded by the TTL.
 */
function sessionsTreeStat(root: string): string {
	const parts: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const d = stack.pop()!;
		try {
			const st = statSync(d);
			parts.push(`${d}:${st.mtimeMs}:${st.size}`);
		} catch {
			continue; // Unreadable dir — the walk yields nothing for it either.
		}
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) stack.push(join(d, e.name));
		}
	}
	return parts.sort().join("|");
}

/** Cache key: sessions-tree dir stats + stats.db stat when the file exists. */
function sessionsListKey(cfg: StatsConfig): string {
	const dirStat = sessionsTreeStat(cfg.sessionsDir);
	let dbStat = "none";
	try {
		const st = statSync(cfg.statsDbPath);
		dbStat = `${st.mtimeMs}:${st.size}`;
	} catch {
		// No stats.db yet.
	}
	return `${dirStat}|${dbStat}`;
}

function cacheSessionsList(key: string, rows: SessionSummary[]): void {
	if (!sessionsListCache.has(key) && sessionsListCache.size >= SESSIONS_CACHE_MAX_ENTRIES) {
		const oldest = sessionsListCache.keys().next().value;
		if (oldest !== undefined) sessionsListCache.delete(oldest);
	}
	sessionsListCache.set(key, { expiresAt: Date.now() + SESSIONS_CACHE_TTL_MS, rows });
}

/** Full list from cache; computes + stores on key change or TTL expiry. */
async function cachedSessionsList(ctx: AppCtx): Promise<SessionSummary[]> {
	const key = sessionsListKey(ctx.cfg);
	const hit = sessionsListCache.get(key);
	if (hit && Date.now() < hit.expiresAt) return hit.rows;
	const rows = await computeSessionsList(ctx);
	cacheSessionsList(key, rows);
	return rows;
}

interface HeaderInfo {
	title: string | null;
	id: string | null;
	cwd: string | null;
}

interface MsgAggRow {
	session_file: string;
	first_ts: number | null;
	last_ts: number | null;
	turns: number;
	error_turns: number | null;
	total_tokens: number | null;
	total_cost: number | null;
	model_count: number;
}

interface CountRow {
	session_file: string;
	n: number;
}

interface UserRow {
	session_file: string;
	n: number;
	chars: number | null;
}

/** Header extraction cache keyed by (abs, mtimeMs, size) — cheap across requests. */
const headCache = new Map<string, HeaderInfo>();
const HEAD_CACHE_MAX = 100;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Title slot (line 1: {"type":"title",…}) + session header
 * (line 2: {"type":"session",…,"title"?,"id","cwd"}), read from the shared
 * JSONL layer's first parsed entries. Prefer the title-slot title, fall back
 * to the header title, else null. LRU-bounded by HEAD_CACHE_MAX.
 */
async function readHead(abs: string, mtimeMs: number, size: number): Promise<HeaderInfo> {
	const key = `${abs}\u0000${mtimeMs}\u0000${size}`;
	const hit = headCache.get(key);
	if (hit) {
		headCache.delete(key); // refresh recency
		headCache.set(key, hit);
		return hit;
	}
	let info: HeaderInfo = { title: null, id: null, cwd: null };
	const doc = await loadJsonl(abs);
	if (doc) {
		const first = doc.entries[0] ?? null;
		const second = doc.entries[1] ?? null;
		// Older files may lack the title slot — the session header can be line 1.
		const head = first?.type === "session" ? first : second?.type === "session" ? second : null;
		info = {
			title:
				first?.type === "title"
					? (str(first.title) ?? (head ? str(head.title) : null))
					: head
						? str(head.title)
						: null,
			id: head ? str(head.id) : null,
			cwd: head ? str(head.cwd) : null,
		};
	}
	headCache.set(key, info);
	if (headCache.size > HEAD_CACHE_MAX) {
		const oldest = headCache.keys().next().value;
		if (oldest !== undefined) headCache.delete(oldest);
	}
	return info;
}

function sessionsRoute(ctx: AppCtx): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stats\/sessions$/,
		handler: async ({ url }) => {
			const { cfg } = ctx;
			const db = ctx.dbm.db();
			const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
			const tool = (url.searchParams.get("tool") ?? "").trim();

			// Cached full list (disk walk + db enrichment). Copied before filtering —
			// the sort below is in-place and the cached array must stay pristine.
			let list = [...(await cachedSessionsList(ctx))];

			// 3. Tool filter: only sessions whose file has tool_calls of that name.
			// DB-backed and per-request (outside the cache) so db unavailability is
			// still detected per-request — an explicit 503, never a stale or falsely
			// empty list.
			if (tool) {
				if (!db) return errorJson("stats.db unavailable", 503);
				let rows: { session_file: string }[];
				try {
					rows = db
						.query("SELECT DISTINCT session_file FROM tool_calls WHERE tool_name = ?")
						.all(tool) as { session_file: string }[];
				} catch (err) {
					console.error("[stats-db] sessions: tool filter query failed; returning 503", {
						error: err,
					});
					return errorJson("stats.db unavailable", 503);
				}
				const keep = new Set(rows.map((r) => normDbFile(cfg.sessionsDir, r.session_file)));
				list = list.filter((s) => keep.has(normDbFile(cfg.sessionsDir, s.file)));
			}

			// 3 (cont). q filter: case-insensitive substring on title OR cwd.
			if (q) {
				list = list.filter(
					(s) => s.title?.toLowerCase().includes(q) || s.cwd?.toLowerCase().includes(q),
				);
			}

			// 4. Sort: on-disk sessions by mtimeMs desc, missing sessions by
			// (lastTs ?? 0) desc so they land among their era. Cap at 2000.
			const tsOf = (s: SessionSummary): number => (s.onDisk ? s.mtimeMs : (s.lastTs ?? 0));
			list.sort((a, b) => tsOf(b) - tsOf(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

			const total = list.length;
			const truncated = total > MAX_SESSIONS;
			return json({ sessions: list.slice(0, MAX_SESSIONS), total, truncated });
		},
	};
}

/**
 * Full disk walk + db enrichment. Degrades to disk-only rows (metrics
 * zeroed, synced:false) on any stats.db trouble — db failure must never 500
 * this endpoint. Walk count is exposed for tests asserting cache behavior.
 */
async function computeSessionsList(ctx: AppCtx): Promise<SessionSummary[]> {
	const { cfg } = ctx;
	const db = ctx.dbm.db();
	// Any stats.db failure degrades to disk-only rows (metrics zeroed,
	// synced:false) — db trouble must never 500 this endpoint.
	let dbBroken = false;
	sessionsWalkCounter.runs += 1;

	// 1. Disk scan: main-agent files only, newest-first sort comes later.
	const byAbs = new Map<string, SessionSummary>();
	for (const abs of walkJsonl(cfg.sessionsDir)) {
		const rel = relative(cfg.sessionsDir, abs);
		if (!isMainSession(rel)) continue;
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		const h = await readHead(abs, st.mtimeMs, st.size);
		byAbs.set(abs, {
			file: rel,
			folder: folderOf(rel),
			title: h.title,
			id: h.id,
			cwd: h.cwd,
			firstTs: null,
			lastTs: null,
			turns: 0,
			toolCalls: 0,
			totalTokens: 0,
			totalCost: 0,
			errorTurns: 0,
			modelCount: 0,
			userMessages: 0,
			userChars: 0,
			synced: false,
			onDisk: true,
			size: st.size,
			mtimeMs: st.mtimeMs,
		});
	}

	// 1b. DB-only sessions: files with stats.db rows but missing on disk
	// (deleted/archived). They appear so the client can mark rows missing.
	if (db && !dbBroken) {
		try {
			const dbRows = db
				.query(
					`SELECT session_file FROM messages
           UNION SELECT session_file FROM tool_calls
           UNION SELECT session_file FROM user_messages`,
				)
				.all() as { session_file: string }[];
			for (const r of dbRows) {
				const abs = normDbFile(cfg.sessionsDir, r.session_file);
				if (byAbs.has(abs)) continue;
				const rel = relative(cfg.sessionsDir, abs);
				if (rel.startsWith("..") || !isMainSession(rel)) continue;
				byAbs.set(abs, {
					file: rel,
					folder: folderOf(rel),
					title: null,
					id: null,
					cwd: null,
					firstTs: null,
					lastTs: null,
					turns: 0,
					toolCalls: 0,
					totalTokens: 0,
					totalCost: 0,
					errorTurns: 0,
					modelCount: 0,
					userMessages: 0,
					userChars: 0,
					synced: true,
					onDisk: false,
					size: 0,
					mtimeMs: 0,
				});
			}
		} catch (err) {
			dbBroken = true;
			console.error(
				"[stats-db] sessions: db-only session lookup failed; continuing with disk rows only",
				{ error: err },
			);
		}
	}

	// 2. SQL enrichment — one pass per table, merged by absolute path.
	// All queries run inside one guard so a broken/partial schema degrades
	// atomically: every disk row keeps zeroed metrics + synced:false.
	if (db && !dbBroken) {
		let agg: { msg: MsgAggRow[]; tc: CountRow[]; um: UserRow[] } | null = null;
		try {
			agg = {
				msg: db
					.query(
						`SELECT session_file,
                    MIN(timestamp) first_ts, MAX(timestamp) last_ts, COUNT(*) turns,
                    SUM(stop_reason='error') error_turns,
                    SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total_tokens,
                    SUM(cost_total) total_cost,
                    COUNT(DISTINCT model) model_count
             FROM messages GROUP BY session_file`,
					)
					.all() as MsgAggRow[],
				tc: db
					.query("SELECT session_file, COUNT(*) n FROM tool_calls GROUP BY session_file")
					.all() as CountRow[],
				um: db
					.query(
						"SELECT session_file, COUNT(*) n, SUM(chars) chars FROM user_messages GROUP BY session_file",
					)
					.all() as UserRow[],
			};
		} catch (err) {
			dbBroken = true;
			console.error("[stats-db] sessions: enrichment queries failed; returning disk-only metrics", {
				error: err,
			});
		}
		if (agg) {
			for (const r of agg.msg) {
				const s = byAbs.get(normDbFile(cfg.sessionsDir, r.session_file));
				if (!s) continue;
				s.firstTs = r.first_ts;
				s.lastTs = r.last_ts;
				s.turns = r.turns;
				s.errorTurns = r.error_turns ?? 0;
				s.totalTokens = r.total_tokens ?? 0;
				s.totalCost = r.total_cost ?? 0;
				s.modelCount = r.model_count;
				s.synced = true;
			}
			for (const r of agg.tc) {
				const s = byAbs.get(normDbFile(cfg.sessionsDir, r.session_file));
				if (s) s.toolCalls = r.n;
			}
			for (const r of agg.um) {
				const s = byAbs.get(normDbFile(cfg.sessionsDir, r.session_file));
				if (s) {
					s.userMessages = r.n;
					s.userChars = r.chars ?? 0;
				}
			}
		}
	}

	return [...byAbs.values()];
}

export function register(ctx: AppCtx, routes: Route[]): void {
	routes.push(sessionsRoute(ctx));
}
