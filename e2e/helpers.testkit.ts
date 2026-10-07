/**
 * Narrow E2E setup helpers for the fleet/session cross-app suite.
 * NOT a test file: the `.testkit.ts` suffix keeps it out of Bun discovery.
 *
 * Deliberately minimal: hermetic per-suite stats locations only. No fake
 * daemons, no SDK singletons, no Bun-test imports — those stay in
 * apps/fleet/test/*.testkit.ts with the suites that need them.
 */
import { dirname, join } from "node:path";

/**
 * Hermetic stats config for the E2E fleet (bypasses the operator's real
 * $PI_CONFIG_DIR/stats.db and sessions dir). Derives both locations from
 * the suite's state path, so nothing touches operator state.
 */
export function hermeticStatsConfig(statePath: string): {
	statsDbPath: string;
	sessionsDir: string;
} {
	const dir = dirname(statePath);
	return { statsDbPath: join(dir, "stats.db"), sessionsDir: join(dir, "agent-sessions") };
}
