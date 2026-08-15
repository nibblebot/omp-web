/**
 * Stats config resolution (fleet/stats). Resolved once at startup.
 *
 * Precedence:
 * - stats DB:    $PI_CONFIG_DIR/stats.db  (default ~/.omp/stats.db)
 * - sessions:    $PI_CODING_AGENT_DIR/sessions
 *                else $XDG_DATA_HOME/omp/agent/sessions
 *                else ~/.omp/agent/sessions
 *
 * NOTE: real-world stats.db rows store ABSOLUTE session_file paths
 * (e.g. /home/u/.omp/agent/sessions/<proj>/<file>.jsonl), not the
 * relative paths the DB schema comment implies. Everything is normalized
 * through fleet/stats/paths.ts.
 *
 * The fleet control plane owns the listen port — no port/host here.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface StatsConfig {
  configRoot: string;
  statsDbPath: string;
  sessionsDir: string;
}

export function resolveStatsConfig(
  env: Record<string, string | undefined> = process.env,
): StatsConfig {
  const home = homedir();
  const configRoot = env.PI_CONFIG_DIR || join(home, ".omp");

  let sessionsDir: string;
  if (env.PI_CODING_AGENT_DIR) {
    sessionsDir = join(env.PI_CODING_AGENT_DIR, "sessions");
  } else if (env.XDG_DATA_HOME) {
    sessionsDir = join(env.XDG_DATA_HOME, "omp", "agent", "sessions");
  } else {
    sessionsDir = join(configRoot, "agent", "sessions");
  }

  return {
    configRoot,
    statsDbPath: join(configRoot, "stats.db"),
    sessionsDir,
  };
}
