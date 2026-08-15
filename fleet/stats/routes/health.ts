/**
 * GET /ctl/stats/health — liveness + data-source status.
 *
 * Ported from the standalone server's health route (minus static serving,
 * SPA fallback and the port field): each request re-stats stats.db so the
 * answer reflects rotations/appearances since the last probe (request-driven,
 * no interval timer). Displayed paths redact the $HOME prefix to "~".
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import { json } from "../http";
import { countMainSessions } from "../lib/sessions-index";
import type { Health } from "../../../shared/stats-types";
import type { AppCtx, Route } from "../types";

/** Replace the home-dir prefix with "~" for DISPLAY only (cfg stays intact). */
function redactHome(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
  return p;
}

function healthRoute(ctx: AppCtx): Route {
  return {
    method: "GET",
    pattern: /^\/ctl\/stats\/health$/,
    handler: () => {
      // Re-stat stats.db so health reflects rotations/appearances since the
      // last probe (request-driven — no interval timer).
      ctx.dbm.reprobe();
      const db = ctx.dbm.db();
      let statsDb: Health["statsDb"] = "missing";
      let dbCounts: Health["dbCounts"] = null;
      if (db) {
        statsDb = "ok";
        try {
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
        } catch {
          statsDb = "error";
        }
      }
      const body: Health = {
        ok: true,
        statsDb,
        statsDbPath: redactHome(ctx.dbm.path() ?? ctx.cfg.statsDbPath),
        statsDbFromCopy: ctx.dbm.fromCopy(),
        sessionsDir: redactHome(ctx.cfg.sessionsDir),
        // Reconciled with GET /ctl/stats/sessions: sessionsCount uses the same
        // walk the sessions list builds from (walkJsonl + isMainSession), so
        // it always equals the number of on-disk MAIN sessions that list
        // would show — subagent transcripts and DB-only rows are excluded.
        sessionsCount: countMainSessions(ctx.cfg.sessionsDir),
        dbCounts,
      };
      return json(body);
    },
  };
}

export function register(ctx: AppCtx, routes: Route[]): void {
  routes.push(healthRoute(ctx));
}
