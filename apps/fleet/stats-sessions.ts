/**
 * GET /ctl/stats/sessions returns the full session list with DB-enriched metrics.
 *
 * Disk is the primary source of which sessions exist; stats.db aggregates
 * (one pass per table) fill in the real numbers. Sessions with DB rows but
 * no file on disk (deleted/archived) are appended with onDisk:false so the
 * client can mark them missing (PLAN §6). Files on disk that were never
 * synced appear with zeroed metrics and synced:false.
 */
import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative } from "node:path";
import { json, errorJson } from "./stats-http";
import { loadJsonl } from "./stats-jsonl";
import { walkJsonl } from "./stats-sessions-index";
import { readStoredHead, storeFileKey } from "./stats-store-index";
import { SESSION_HEAD_BYTES, parseSessionHead } from "./session-head";
import type { AppCtx, Route } from "./stats-types";
import type { SessionHead } from "./session-head";
import type { RawEntry, SessionSummary } from "#lib/wire/stats-types";
import { ByteLru } from "#lib/platform/byte-lru";
import { normDbFile, isMainSession, folderOf } from "./stats-paths";
import type { StatsConfig } from "./stats-config";

const MAX_SESSIONS = 2000;

// ---------------------------------------------------------------------------
// Sessions list cache (2026-08 audit Phase 3; FPS-08).
//
// The computed list (disk walk + stats.db enrichment) is served from memory
// while the key is unchanged and within SESSIONS_CACHE_TTL_MS. The key is the
// sessions dir tree (one stat per directory, no file stats) plus the stats.db
// stat, so adds, removes, and stats.db swaps show on the next request. In-place
// file growth changes no dir stat and appears when the TTL expires. Entries are
// capped at 2 (current + previous key) so key churn cannot grow the cache.
// ---------------------------------------------------------------------------

/** Staleness bound for in-place file growth; adds and removes are caught by the tree key. */
export const SESSIONS_CACHE_TTL_MS = 3000;

const SESSIONS_CACHE_MAX_ENTRIES = 2;

interface ListCacheEntry {
	expiresAt: number;
	rows: SessionSummary[];
}

const sessionsListCache = new Map<string, ListCacheEntry>();

/** Test instrumentation: counts real disk-walk executions (cache hits skip). */
export const sessionsWalkCounter = { runs: 0 };

/** `mtimeMs:size` of a file, or "none" when it does not exist. */
export function fileStatKey(path: string): string {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "none";
	}
}

/**
 * Cache key: every directory stat under the sessions tree plus the stats.db
 * stat. A session added or removed changes a dir stat, so it appears on the
 * next request. In-place file growth changes no dir stat and is bounded by the TTL.
 */
function sessionsListKey(cfg: StatsConfig): string {
	return `${sessionsTreeStat(cfg.sessionsDir)}|${fileStatKey(cfg.statsDbPath)}`;
}

/** Stat of each directory under root (directories only, never files): "path:mtime:size" joined. */
function sessionsTreeStat(root: string): string {
	const parts: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const d = stack.pop()!;
		try {
			const st = statSync(d);
			parts.push(`${d}:${st.mtimeMs}:${st.size}`);
		} catch {
			continue;
		}
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) if (e.isDirectory()) stack.push(join(d, e.name));
	}
	return parts.sort().join("|");
}

function cacheSessionsList(key: string, rows: SessionSummary[]): void {
	if (!sessionsListCache.has(key) && sessionsListCache.size >= SESSIONS_CACHE_MAX_ENTRIES) {
		const oldest = sessionsListCache.keys().next().value;
		if (oldest !== undefined) sessionsListCache.delete(oldest);
	}
	sessionsListCache.set(key, { expiresAt: Date.now() + SESSIONS_CACHE_TTL_MS, rows });
}

/** Full list from cache; recomputes on key change, miss, or TTL expiry. */
async function cachedSessionsList(ctx: AppCtx): Promise<SessionSummary[]> {
	const key = sessionsListKey(ctx.cfg);
	const hit = sessionsListCache.get(key);
	if (hit && Date.now() < hit.expiresAt) return hit.rows;
	const rows = await computeSessionsList(ctx);
	cacheSessionsList(key, rows);
	return rows;
}

/** On-disk main sessions in the list: the /ctl/stats/health sessionsCount. */
export async function countOnDiskSessions(ctx: AppCtx): Promise<number> {
	return (await cachedSessionsList(ctx)).filter((s) => s.onDisk).length;
}

interface HeaderInfo {
	title: string | null;
	id: string | null;
	cwd: string | null;
	/** First user prompt (<= FIRST_PROMPT_MAX chars), shown as the row subtitle. */
	firstPrompt: string | null;
	/** Conversation text the `q` filter also searches; never sent to the client. */
	searchText: string;
}

const FIRST_PROMPT_MAX = 200;
/** Per-prompt and total caps for the searchable body text of one session. */
const SEARCH_PROMPT_MAX = 300;
const SEARCH_PROMPTS_TOTAL_MAX = 2000;
const SEARCH_TAIL_MAX = 600;

/** Searchable text per list row, kept off the wire (rows stay small). Keyed by the cached row object. */
const rowSearchText = new WeakMap<SessionSummary, string>();

/** Plain text of a user/assistant message entry; "" for every other entry. */
function conversationText(e: RawEntry): { role: "user" | "assistant"; text: string } | null {
	if (e.type !== "message") return null;
	const msg = e.message;
	if (typeof msg !== "object" || msg === null || !("role" in msg)) return null;
	const role = msg.role;
	if (role !== "user" && role !== "assistant") return null;
	const content = "content" in msg ? msg.content : undefined;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				parts.push(part.text);
			}
		}
		text = parts.join("\n");
	}
	text = text.trim();
	return text === "" ? null : { role, text };
}

/** First user prompt plus the text the body search covers (user prompts, then the conversation tail). */
function extractConversation(entries: readonly RawEntry[]): {
	firstPrompt: string | null;
	searchText: string;
} {
	let firstPrompt: string | null = null;
	const prompts: string[] = [];
	let promptsLen = 0;
	let tail = "";
	for (const e of entries) {
		const m = conversationText(e);
		if (m === null) continue;
		if (m.role === "user") {
			if (firstPrompt === null) firstPrompt = m.text.slice(0, FIRST_PROMPT_MAX);
			if (promptsLen < SEARCH_PROMPTS_TOTAL_MAX) {
				const piece = m.text.slice(0, SEARCH_PROMPT_MAX);
				prompts.push(piece);
				promptsLen += piece.length;
			}
		}
		// Rolling tail: only the last SEARCH_TAIL_MAX chars of conversation text survive.
		tail = `${tail}\n${m.text}`.slice(-SEARCH_TAIL_MAX);
	}
	return { firstPrompt, searchText: `${prompts.join("\n")}\n${tail}` };
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

/**
 * Header extraction cache keyed by (abs, mtimeMs, size). Byte-bounded so a
 * list recompute after one file changes re-parses only that file, not every
 * session beyond a count cap (FPS-06: a 100-entry cap over 3000 sessions
 * re-parsed the whole store on every list pass).
 */
const HEAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const HEAD_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const headCache = new ByteLru<HeaderInfo>({
	maxBytes: HEAD_CACHE_MAX_BYTES,
	maxEntryBytes: HEAD_CACHE_MAX_ENTRY_BYTES,
});

const EMPTY_HEAD: SessionHead = { title: null, cwd: null, id: null, firstTs: null, lastTs: null };

/** Title, cwd and id from the first SESSION_HEAD_BYTES of a transcript; empty when unreadable. */
async function readSessionHead(abs: string): Promise<SessionHead> {
	try {
		const fh = await open(abs, "r");
		try {
			const buf = Buffer.alloc(SESSION_HEAD_BYTES);
			const { bytesRead } = await fh.read(buf, 0, SESSION_HEAD_BYTES, 0);
			return parseSessionHead(buf.toString("utf8", 0, bytesRead));
		} finally {
			await fh.close();
		}
	} catch {
		return EMPTY_HEAD;
	}
}

/**
 * Header facts plus conversation text for one session file. Title, cwd and id
 * come from a bounded head read; the full doc is parsed only for the first
 * prompt and search text (FPS-06). Byte-bounded by HEAD_CACHE_MAX_BYTES.
 */
async function readHead(abs: string, mtimeMs: number, size: number): Promise<HeaderInfo> {
	const key = `${abs}\u0000${mtimeMs}\u0000${size}`;
	const hit = headCache.get(key);
	if (hit) return hit;
	const head = await readSessionHead(abs);
	const doc = await loadJsonl(abs);
	const convo = doc ? extractConversation(doc.entries) : { firstPrompt: null, searchText: "" };
	const info: HeaderInfo = {
		title: head.title || null,
		id: head.id || null,
		cwd: head.cwd || null,
		firstPrompt: convo.firstPrompt,
		searchText: convo.searchText,
	};
	const cost =
		abs.length +
		info.searchText.length +
		(info.title?.length ?? 0) +
		(info.firstPrompt?.length ?? 0) +
		(info.cwd?.length ?? 0) +
		(info.id?.length ?? 0) +
		128;
	headCache.set(key, info, cost);
	return info;
}

/**
 * `q` filter (lowercased): substring match on the row's header fields and,
 * for on-disk sessions, the body text captured at header-read time.
 */
function rowMatchesQuery(s: SessionSummary, q: string): boolean {
	const fields = [s.title, s.cwd, s.id, s.folder, s.firstPrompt, rowSearchText.get(s)];
	return fields.some((v) => (v ?? "").toLowerCase().includes(q));
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

			// Cached full list (disk walk + db enrichment). Copied before filtering because
			// the sort below is in-place and the cached array must stay pristine.
			let list = [...(await cachedSessionsList(ctx))];

			// 3. Tool filter: only sessions whose file has tool_calls of that name.
			// DB-backed and per-request (outside the cache) so db unavailability is
			// still detected per-request. It yields an explicit 503, never a stale
			// or falsely empty list.
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

			// 3 (cont). q filter: case-insensitive substring on title, cwd, id, or project folder.
			if (q) {
				list = list.filter((s) => rowMatchesQuery(s, q));
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
 * Full disk walk + db enrichment + fleet-store coverage (P8.6). Degrades to
 * disk-only rows (metrics zeroed, synced:false) on any stats.db trouble; db
 * failure must never 500 this endpoint. Walk count is exposed for tests
 * asserting cache behavior.
 */
async function computeSessionsList(ctx: AppCtx): Promise<SessionSummary[]> {
	const { cfg } = ctx;
	const db = ctx.dbm.db();
	// Any stats.db failure degrades to disk-only rows (metrics zeroed,
	// synced:false); db trouble must never 500 this endpoint.
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
		const row: SessionSummary = {
			file: rel,
			folder: folderOf(rel),
			title: h.title,
			id: h.id,
			cwd: h.cwd,
			firstPrompt: h.firstPrompt,
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
		};
		rowSearchText.set(row, h.searchText);
		byAbs.set(abs, row);
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

	// 2. SQL enrichment, one pass per table, merged by absolute path.
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

	// 3. Fleet log-store coverage (P8.6): store-only sessions surface as
	// rows with origin "fleet-store"; sessions that also exist on disk are
	// deduplicated by stable session identity (the store sessionId ↔ a
	// fleet-local header id), the local row carries the `stored` annotation
	// instead of duplicating. Unstreamed remote history is simply absent.
	if (cfg.stored !== undefined) {
		try {
			const store = cfg.stored.store;
			const storedById = new Map<string, SessionSummary>();
			for (const abs of byAbs.keys()) {
				const s = byAbs.get(abs)!;
				if (s.id !== null && s.id.length > 0 && storedById.has(s.id)) continue;
				if (s.id !== null && s.id.length > 0) storedById.set(s.id, s);
			}
			for (const ws of store.listStoredWorkspaces()) {
				for (const session of ws.sessions) {
					const mainRel = session.mainRelpath;
					const head = mainRel
						? readStoredHead(store, ws.workspaceId, session.sessionId, mainRel)
						: null;
					const id = head?.id ?? null;
					const local = id !== null && id.length > 0 ? storedById.get(id) : undefined;
					const orphaned = cfg.stored.provenance?.(ws.workspaceId) === undefined;
					const storedMeta = {
						workspaceId: ws.workspaceId,
						sessionId: session.sessionId,
						mainRelpath: mainRel ?? "",
						readOnly: ws.readOnly,
						orphaned,
					};
					if (local !== undefined) {
						local.origin = "fleet-local";
						local.stored = storedMeta;
						continue;
					}
					const key = `stored:${ws.workspaceId}/${session.sessionId}`;
					if (byAbs.has(key)) continue;
					const row: SessionSummary = {
						file: storeFileKey(session, mainRel),
						folder: ws.workspaceId,
						title: head?.title ?? null,
						id: head?.id ?? session.sessionId,
						cwd: head?.cwd ?? null,
						firstTs: head?.firstTs ?? null,
						lastTs: head?.lastTs ?? null,
						turns: 0,
						toolCalls: 0,
						totalTokens: 0,
						totalCost: 0,
						errorTurns: 0,
						modelCount: 0,
						userMessages: 0,
						userChars: 0,
						synced: false,
						onDisk: false,
						size: head?.bytes ?? session.bytes,
						mtimeMs: session.mtimeMs,
						origin: "fleet-store",
						stored: storedMeta,
					};
					byAbs.set(key, row);
				}
			}
		} catch (err) {
			// Store trouble must never 500 the session list; degrade silently.
			console.error("[stats-store] sessions: fleet store coverage failed", { error: err });
		}
	}

	return [...byAbs.values()];
}

export function register(ctx: AppCtx, routes: Route[]): void {
	routes.push(sessionsRoute(ctx));
}
