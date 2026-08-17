/**
 * Server-internal contracts for the fleet/stats API (fleet/stats/*).
 *
 * Wire contracts (SessionSummary, SessionStats, TranscriptPage, Health,
 * SyncResult, …) live in shared/stats-types.ts — route modules and lib
 * import those from there. This module holds only shapes the server uses
 * internally.
 */
import type { Database } from "bun:sqlite";
import type { StatsConfig } from "./config";

export interface Route {
	method: "GET" | "POST";
	/** matched against the URL pathname */
	pattern: RegExp;
	handler: (ctx: { req: Request; url: URL; params: string[] }) => Response | Promise<Response>;
}

/**
 * Read-only stats.db handle with rotation-aware reprobing. The WAL-safe
 * fallback implementation lives in fleet/stats/lib/stats-db.ts — this is the
 * shape every route codes against.
 */
export interface StatsDbManager {
	/** current readable handle, or null when stats.db is unavailable */
	db(): Database | null;
	/** real stats.db path, or the temp-copy path when opened via WAL fallback */
	path(): string | null;
	/** true when the handle was opened from a temp copy (WAL fallback) */
	fromCopy(): boolean;
	/** re-stat (mtimeMs, size); reopen on missing→present or rotation; no-op when unchanged */
	reprobe(): void;
	/** close the handle + remove temp copies; idempotent */
	close(): void;
}

/** Outcome of one `omp stats --summary` run (POST /ctl/stats/sync). */
export type SyncOutcome = { processed: number; files: number; totalMessages: number };

/** Spawns the omp stats sync; resolves with the summary outcome. */
export type SyncRunner = (env: NodeJS.ProcessEnv) => Promise<SyncOutcome>;

/** Everything a route handler may need, closed over at registration time. */
export interface AppCtx {
	cfg: StatsConfig;
	dbm: StatsDbManager;
	syncRunner?: SyncRunner;
}
