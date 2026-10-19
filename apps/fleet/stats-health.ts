/**
 * GET /ctl/stats/health returns liveness + data-source status.
 *
 * Ported from the standalone server's health route (minus static serving,
 * SPA fallback and the port field): each request re-stats stats.db so the
 * answer reflects rotations/appearances since the last probe (request-driven,
 * no interval timer). Displayed paths redact the $HOME prefix to "~".
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import { json } from "./stats-http";
import { countOnDiskSessions, fileStatKey } from "./stats-sessions";
import { storeCoverage } from "./stats-store-index";
import { syncStatus } from "./stats-sync";
import type { Health } from "#lib/wire/stats-types";
import type { AppCtx, Route } from "./stats-types";

/** Replace the home-dir prefix with "~" for DISPLAY only (cfg stays intact). */
function redactHome(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
	return p;
}

/** COUNT(*) memo: recomputed only when stats.db or its WAL changes (FPS-08). */
let dbCountsMemo: { key: string; counts: NonNullable<Health["dbCounts"]> } | null = null;

function healthRoute(ctx: AppCtx): Route {
	return {
		method: "GET",
		pattern: /^\/ctl\/stats\/health$/,
		handler: async () => {
			// Re-stat stats.db so health reflects rotations/appearances since the
			// last probe (request-driven, no interval timer).
			ctx.dbm.reprobe();
			const db = ctx.dbm.db();
			let statsDb: Health["statsDb"] = "missing";
			let dbCounts: Health["dbCounts"] = null;
			if (db) {
				statsDb = "ok";
				const path = ctx.dbm.path() ?? ctx.cfg.statsDbPath;
				const key = `${path}|${fileStatKey(path)}|${fileStatKey(`${path}-wal`)}`;
				try {
					if (dbCountsMemo?.key === key) {
						dbCounts = dbCountsMemo.counts;
					} else {
						// COUNT(*) always returns one row with a scalar `c` column.
						const q = (sql: string): number => {
							const row = db.query(sql).get();
							if (row !== null && typeof row === "object" && "c" in row) return row.c as number;
							return 0;
						};
						dbCounts = {
							messages: q("SELECT COUNT(*) c FROM messages"),
							toolCalls: q("SELECT COUNT(*) c FROM tool_calls"),
							userMessages: q("SELECT COUNT(*) c FROM user_messages"),
						};
						dbCountsMemo = { key, counts: dbCounts };
					}
				} catch {
					statsDb = "error";
				}
			}
			const body: Health = {
				ok: true,
				statsDb,
				statsDbPath: redactHome(ctx.dbm.path() ?? ctx.cfg.statsDbPath),
				statsDbFromCopy: ctx.dbm.fromCopy(),
				isolated: ctx.cfg.isolated === true,
				sessionsDir: redactHome(ctx.cfg.sessionsDir),
				// Reconciled with GET /ctl/stats/sessions: sessionsCount is read from the
				// same cached list, so it equals the on-disk MAIN sessions that list
				// shows; subagent transcripts and DB-only rows are excluded.
				sessionsCount: await countOnDiskSessions(ctx),
				dbCounts,
				...syncStatus(),
				// P8.6: fleet-store coverage (excluded from sessionsCount above).
				...(ctx.cfg.stored ? { fleetStore: storeCoverage(ctx.cfg.stored.store) ?? undefined } : {}),
			};
			return json(body);
		},
	};
}

export function register(ctx: AppCtx, routes: Route[]): void {
	routes.push(healthRoute(ctx));
}
