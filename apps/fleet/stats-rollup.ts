/**
 * GET /ctl/stats/rollup?days=<1..365>&offset=<minutes east of UTC> → StatsRollup
 *
 * Aggregate spend, model and tool figures over time, read from stats.db. Buckets are
 * local calendar days: the client passes its UTC offset so day boundaries match what the
 * user sees. `buckets` is zero-filled and oldest first; each series aligns to it.
 * `errors` on a bucket, model or total counts error turns (messages.stop_reason = 'error');
 * tool errors are reported per tool.
 */
import type { Database } from "bun:sqlite";
import { errorJson, json } from "./stats-http";
import type { AppCtx, Route } from "./stats-types";
import type {
	RollupBucket,
	RollupModel,
	RollupProject,
	RollupSeries,
	RollupTool,
	StatsRollup,
} from "#lib/wire/stats-types";

const DAY_MS = 86_400_000;
const MAX_SERIES = 6;
const OTHER_SERIES = "(other)";
const MAX_LIST = 50;
const MAX_PROJECTS = 20;

function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
	const raw = url.searchParams.get(key);
	if (raw === null || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function rollupRoute(ctx: AppCtx): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stats\/rollup$/,
		handler: ({ url }) => {
			const db = ctx.dbm.db();
			if (!db) return errorJson("stats.db unavailable", 503);
			const days = intParam(url, "days", 30, 1, 365);
			const offsetMin = intParam(url, "offset", 0, -840, 840);
			try {
				return json(buildRollup(db, days, offsetMin, Date.now()));
			} catch (err) {
				console.error("[stats-db] rollup query failed", { error: err });
				return errorJson("stats.db unavailable", 503);
			}
		},
	};
}

interface DayRow {
	day: number;
	name: string;
	value: number;
}

/** Fold the per-day rows of one dimension into at most MAX_SERIES named series. */
function toSeries(rows: DayRow[], days: number, indexOf: Map<number, number>): RollupSeries[] {
	const totals = new Map<string, number>();
	for (const r of rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.value);
	const ranked = [...totals.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name]) => name);
	const top = new Set(ranked.slice(0, MAX_SERIES));
	const series = new Map<string, number[]>();
	for (const name of ranked.slice(0, MAX_SERIES)) series.set(name, new Array(days).fill(0));
	if (ranked.length > MAX_SERIES) series.set(OTHER_SERIES, new Array(days).fill(0));
	for (const r of rows) {
		const i = indexOf.get(r.day);
		if (i === undefined) continue;
		const values = series.get(top.has(r.name) ? r.name : OTHER_SERIES);
		if (values !== undefined) values[i] = (values[i] ?? 0) + r.value;
	}
	return [...series].map(([name, values]) => ({ name, values }));
}

export function buildRollup(
	db: Database,
	days: number,
	offsetMin: number,
	nowMs: number,
): StatsRollup {
	const offsetMs = offsetMin * 60_000;
	const todayKey = Math.floor((nowMs + offsetMs) / DAY_MS);
	const startKey = todayKey - (days - 1);
	const since = startKey * DAY_MS - offsetMs;
	// Integers only (offset is clamped and truncated by the caller): safe to inline.
	const dayExpr = `CAST((timestamp + ${offsetMs}) / ${DAY_MS} AS INTEGER)`;

	const buckets: RollupBucket[] = [];
	const indexOf = new Map<number, number>();
	for (let i = 0; i < days; i++) {
		const key = startKey + i;
		indexOf.set(key, i);
		buckets.push({
			ts: key * DAY_MS - offsetMs,
			cost: 0,
			tokens: 0,
			turns: 0,
			toolCalls: 0,
			errors: 0,
		});
	}

	const perDay = db
		.query(
			`SELECT ${dayExpr} AS day, COUNT(*) AS turns, SUM(COALESCE(total_tokens, 0)) AS tokens,
              SUM(COALESCE(cost_total, 0)) AS cost,
              SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS errors
       FROM messages WHERE timestamp >= ? GROUP BY day`,
		)
		.all(since) as Array<Record<string, unknown>>;
	for (const r of perDay) {
		const i = indexOf.get(Number(r.day));
		const b = i === undefined ? undefined : buckets[i];
		if (b === undefined) continue;
		b.turns = Number(r.turns ?? 0);
		b.tokens = Number(r.tokens ?? 0);
		b.cost = Number(r.cost ?? 0);
		b.errors = Number(r.errors ?? 0);
	}

	const toolPerDay = db
		.query(
			`SELECT ${dayExpr} AS day, COUNT(*) AS calls
       FROM tool_calls WHERE timestamp >= ? GROUP BY day`,
		)
		.all(since) as Array<Record<string, unknown>>;
	for (const r of toolPerDay) {
		const i = indexOf.get(Number(r.day));
		const b = i === undefined ? undefined : buckets[i];
		if (b !== undefined) b.toolCalls = Number(r.calls ?? 0);
	}

	const modelDayRows = db
		.query(
			`SELECT ${dayExpr} AS day, model AS name, SUM(COALESCE(cost_total, 0)) AS value
       FROM messages WHERE timestamp >= ? GROUP BY day, model`,
		)
		.all(since) as Array<Record<string, unknown>>;
	const toolDayRows = db
		.query(
			`SELECT ${dayExpr} AS day, tool_name AS name, COUNT(*) AS value
       FROM tool_calls WHERE timestamp >= ? GROUP BY day, tool_name`,
		)
		.all(since) as Array<Record<string, unknown>>;

	const models = (
		db
			.query(
				`SELECT model, provider, COUNT(*) AS turns, SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(COALESCE(cost_total, 0)) AS cost,
                SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS errors
         FROM messages WHERE timestamp >= ?
         GROUP BY model, provider ORDER BY cost DESC, turns DESC LIMIT ?`,
			)
			.all(since, MAX_LIST) as Array<Record<string, unknown>>
	).map((r): RollupModel => ({
		model: String(r.model),
		provider: String(r.provider ?? ""),
		turns: Number(r.turns ?? 0),
		tokens: Number(r.tokens ?? 0),
		cost: Number(r.cost ?? 0),
		errors: Number(r.errors ?? 0),
	}));

	const tools = (
		db
			.query(
				`SELECT tool_name AS name, COUNT(*) AS calls, SUM(COALESCE(is_error, 0)) AS errors
         FROM tool_calls WHERE timestamp >= ?
         GROUP BY tool_name ORDER BY calls DESC LIMIT ?`,
			)
			.all(since, MAX_LIST) as Array<Record<string, unknown>>
	).map((r): RollupTool => ({
		name: String(r.name),
		calls: Number(r.calls ?? 0),
		errors: Number(r.errors ?? 0),
	}));

	const projects = (
		db
			.query(
				`SELECT folder, COUNT(DISTINCT session_file) AS sessions,
                SUM(COALESCE(total_tokens, 0)) AS tokens, SUM(COALESCE(cost_total, 0)) AS cost
         FROM messages WHERE timestamp >= ?
         GROUP BY folder ORDER BY cost DESC LIMIT ?`,
			)
			.all(since, MAX_PROJECTS) as Array<Record<string, unknown>>
	).map((r): RollupProject => ({
		folder: String(r.folder),
		sessions: Number(r.sessions ?? 0),
		tokens: Number(r.tokens ?? 0),
		cost: Number(r.cost ?? 0),
	}));

	const total = db
		.query(
			`SELECT COUNT(DISTINCT session_file) AS sessions, COUNT(*) AS turns,
              SUM(COALESCE(total_tokens, 0)) AS tokens, SUM(COALESCE(cost_total, 0)) AS cost,
              SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS errors
       FROM messages WHERE timestamp >= ?`,
		)
		.get(since) as Record<string, unknown> | null;
	const toolTotal = db
		.query(
			`SELECT COUNT(*) AS calls, SUM(COALESCE(is_error, 0)) AS errors
       FROM tool_calls WHERE timestamp >= ?`,
		)
		.get(since) as Record<string, unknown> | null;

	return {
		days,
		since,
		buckets,
		modelSeries: toSeries(
			modelDayRows.map((r) => ({
				day: Number(r.day),
				name: String(r.name),
				value: Number(r.value ?? 0),
			})),
			days,
			indexOf,
		),
		toolSeries: toSeries(
			toolDayRows.map((r) => ({
				day: Number(r.day),
				name: String(r.name),
				value: Number(r.value ?? 0),
			})),
			days,
			indexOf,
		),
		models,
		tools,
		projects,
		totals: {
			sessions: Number(total?.sessions ?? 0),
			turns: Number(total?.turns ?? 0),
			tokens: Number(total?.tokens ?? 0),
			cost: Number(total?.cost ?? 0),
			toolCalls: Number(toolTotal?.calls ?? 0),
			errors: Number(total?.errors ?? 0),
		},
	};
}
