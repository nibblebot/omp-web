/**
 * Sync endpoint.
 *
 * POST /ctl/stats/sync → spawns `omp stats --summary`, re-probes the
 * stats.db handle after success, and reports what got synced.
 *
 *   200 { processed, files, totalMessages, durationMs }
 *   409 { error: "sync already in progress" }   (single-flight)
 *   504 { error: "sync timed out" }              (child killed after 10 min)
 *   502 { error: "omp stats failed", detail }    (nonzero exit)
 *   503 { error: "omp binary not found — …" }    (spawn ENOENT / bad config)
 *
 * A SyncRunner may be injected via createApp(cfg, { syncRunner }) — tests do
 * this so the harness never needs the real omp binary.
 *
 * omp quirk: pi-utils resolves the stats db as
 * `join(homedir(), PI_CONFIG_DIR, "stats.db")` — PI_CONFIG_DIR is a
 * home-relative NAME, not a literal path. The viewer's config.ts treats
 * statsDbPath as a literal path, so the child env is derived from cfg by
 * buildSyncEnv() (below) to make both sides agree on the same file.
 */
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Subprocess } from "bun";
import { json, errorJson } from "../http";
import type { StatsConfig } from "../config";
import type { AppCtx, Route, SyncOutcome } from "../types";

/** Timeout knobs — an object so tests can shrink the window without a rebuild. */
export const syncConfig = {
  /** how long to wait for the omp child before killing it (10 min) */
  timeoutMs: 10 * 60 * 1000,
};

/** Spawn failed because the omp binary is missing/unrunnable (ENOENT). */
export class SyncUnavailable extends Error {}

/**
 * The stats.db cannot be reached by omp: it lies outside $HOME, where omp's
 * home-relative config resolution cannot point. Surfaced as 503 with the
 * specific reason (vs. the generic install hint for SyncUnavailable).
 */
export class SyncConfigError extends SyncUnavailable {
  constructor(message: string) {
    super(message);
  }
}

/** The omp child exited nonzero. `detail` carries the tail of its stderr. */
export class SyncFailed extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

/** The omp child was killed after exceeding syncConfig.timeoutMs. */
export class SyncTimedOut extends Error {}

/**
 * Parses the `omp stats --summary` summary line.
 * Canonical form: `Synced 3 new entries from 2 files (10 total)`.
 * Any other output (or none) falls back to all-zero counts, matching the
 * success-if-exit-0 contract.
 */
export function parseSummary(stdout: string): SyncOutcome {
  const m = /Synced (\d+) new entries from (\d+) files \((\d+) total\)/.exec(stdout);
  if (!m) return { processed: 0, files: 0, totalMessages: 0 };
  return { processed: Number(m[1]), files: Number(m[2]), totalMessages: Number(m[3]) };
}

/**
 * Builds the child environment for `omp stats --summary` so the child writes
 * the SAME stats.db the viewer reads.
 *
 * omp resolves the stats db as `join(homedir(), PI_CONFIG_DIR, "stats.db")`
 * — PI_CONFIG_DIR is a home-relative NAME. Passing the viewer's absolute
 * statsDbPath through as PI_CONFIG_DIR would make omp write under $HOME
 * instead of the real location. Cases:
 *   - default stats.db (`$HOME/.omp/stats.db`): drop PI_CONFIG_DIR and
 *     PI_PROFILE so omp falls back to its built-in default target
 *   - any other stats.db under $HOME: pass the home-relative NAME of its
 *     directory (and drop PI_PROFILE, which would select a different profile)
 *   - stats.db outside $HOME: omp cannot be pointed at it — SyncConfigError
 * PI_CODING_AGENT_DIR is always set to the absolute sessions parent (omp
 * honors absolute agent dirs). All other env vars pass through unchanged;
 * PI_CONFIG_DIR / PI_PROFILE are only deleted when this function explicitly
 * overrides them.
 */
export function buildSyncEnv(cfg: StatsConfig, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const statsDir = dirname(cfg.statsDbPath);
  if (cfg.statsDbPath === join(home, ".omp", "stats.db")) {
    // Default target — let omp use its built-in default.
    delete env.PI_CONFIG_DIR;
    delete env.PI_PROFILE;
  } else if (statsDir === home || statsDir.startsWith(home + sep)) {
    env.PI_CONFIG_DIR = relative(home, statsDir);
    delete env.PI_PROFILE;
  } else {
    throw new SyncConfigError(
      "stats.db lies outside omp's config root (absolute PI_CONFIG_DIR) — omp stats cannot sync it; unset PI_CONFIG_DIR or use a home-relative config name",
    );
  }
  env.PI_CODING_AGENT_DIR = dirname(cfg.sessionsDir);
  return env;
}

/**
 * Default SyncRunner: spawns the real binary. Resolves with the parsed
 * outcome; throws SyncUnavailable (ENOENT), SyncFailed (nonzero exit),
 * or SyncTimedOut (child killed).
 */
export async function spawnSync(env: NodeJS.ProcessEnv): Promise<SyncOutcome> {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["omp", "stats", "--summary"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new SyncUnavailable("omp binary not found");
  }

  const aborter = new AbortController();
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Child already gone — nothing to kill.
        }
        reject(new SyncTimedOut("sync timed out"));
      }, syncConfig.timeoutMs);
      // Cancel the timer when the race settles so it never dangles.
      aborter.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
    const { code, stdout, stderr } = await Promise.race([
      (async () => {
        const [stdout, stderr] = await Promise.all([
          Bun.readableStreamToText(proc.stdout),
          Bun.readableStreamToText(proc.stderr),
        ]);
        const code = await proc.exited;
        return { code, stdout, stderr };
      })(),
      timeout,
    ]);

    if (code !== 0) throw new SyncFailed(stderr.slice(-500));
    return parseSummary(stdout);
  } finally {
    aborter.abort();
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
  }
}

/** Single-flight guard — module-scope per process (one app per process). */
let inflight: Promise<Response> | null = null;

const SYNC_ERROR_503 =
  "omp binary not found — install omp (`npm i -g @oh-my-pi/omp-stats`) or add it to PATH";

export function register(ctx: AppCtx, routes: Route[]): void {
  routes.push({
    method: "POST",
    pattern: /^\/ctl\/stats\/sync$/,
    handler: async () => {
      if (inflight) return errorJson("sync already in progress", 409);

      console.log("[sync] started");
      const started = Date.now();
      const task = (async (): Promise<Response> => {
        try {
          const runner =
            ctx.syncRunner ?? (() => spawnSync(buildSyncEnv(ctx.cfg, homedir())));
          const outcome = await runner(process.env);
          ctx.dbm.reprobe();
          const durationMs = Date.now() - started;
          console.log("[sync] finished", {
            processed: outcome.processed,
            files: outcome.files,
            durationMs,
          });
          return json({ ...outcome, durationMs });
        } catch (err) {
          console.log(
            "[sync] failed",
            err instanceof Error ? err.message : String(err),
          );
          if (err instanceof SyncConfigError) return errorJson(err.message, 503);
          if (err instanceof SyncUnavailable) return errorJson(SYNC_ERROR_503, 503);
          if (err instanceof SyncTimedOut) return errorJson("sync timed out", 504);
          if (err instanceof SyncFailed) {
            return json({ error: "omp stats failed", detail: err.detail }, 502);
          }
          throw err; // unknown — dispatch boundary turns it into JSON 500
        } finally {
          inflight = null;
        }
      })();
      inflight = task;
      return await task;
    },
  });
}
