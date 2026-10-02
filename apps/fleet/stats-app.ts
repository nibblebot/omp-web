/**
 * Stats API composition root for the read-only transcripts/stats routes
 * (historical sessions, per-session analytics, transcripts, subagents,
 * sync + health), mounted by fleet/server.ts under /ctl/stats.
 *
 * Layering: this module (and everything under fleet/stats) imports only
 * shared/stats-types.ts, bun/node builtins, and ./, never server/ or src/.
 *
 * createStatsApp returns a fetch handler that answers /ctl/stats paths and
 * returns null for everything else (fleet's own control-plane routing owns
 * the 404/405 for unknown paths). close() releases the stats.db handle and
 * any WAL-fallback temp copies.
 */
import { resolveStatsConfig, type StatsConfig } from "./stats-config";
import { dispatchRequest } from "./stats-http";
import { StatsDbManagerImpl } from "./stats-db";
import { register as registerSessions } from "./stats-sessions";
import { register as registerStats } from "./stats-routes";
import { register as registerTranscript } from "./stats-transcript";
import { register as registerSync } from "./stats-sync";
import { register as registerHealth } from "./stats-health";
import type { AppCtx, Route, SyncRunner } from "./stats-types";

export type { StatsConfig };
export { resolveStatsConfig };

export interface StatsApp {
	handleFetch(req: Request, url: URL): Promise<Response | null>;
	close(): void;
}

export function createStatsApp(cfg?: Partial<StatsConfig> & { syncRunner?: SyncRunner }): StatsApp {
	const defaults = resolveStatsConfig();
	const config: StatsConfig = {
		configRoot: cfg?.configRoot ?? defaults.configRoot,
		statsDbPath: cfg?.statsDbPath ?? defaults.statsDbPath,
		sessionsDir: cfg?.sessionsDir ?? defaults.sessionsDir,
		...(cfg?.stored
			? {
					stored: {
						store: cfg.stored.store,
						...(cfg.stored.provenance ? { provenance: cfg.stored.provenance } : {}),
					},
				}
			: {}),
	};
	const dbm = new StatsDbManagerImpl(config.statsDbPath);
	const ctx: AppCtx = {
		cfg: config,
		dbm,
		...(cfg?.syncRunner === undefined ? {} : { syncRunner: cfg.syncRunner }),
	};

	// Each app owns a private registry: route modules push onto the array
	// threaded into register(), so any number of apps can coexist in one
	// process (bare `bun test` runs every suite in a single process).
	const routes: Route[] = [];
	registerSessions(ctx, routes);
	registerStats(ctx, routes);
	registerTranscript(ctx, routes);
	registerSync(ctx, routes);
	registerHealth(ctx, routes);

	return {
		handleFetch: (req, url) => dispatchRequest(req, routes, url),
		close: () => dbm.close(),
	};
}
