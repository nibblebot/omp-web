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
 *   503 { error: "omp binary not found. …" }    (spawn ENOENT / bad config)
 *
 * A SyncRunner may be injected via createApp(cfg, { syncRunner }); tests do
 * this so the harness never needs the real omp binary.
 *
 * omp quirk: pi-utils resolves the stats db as
 * `join(homedir(), PI_CONFIG_DIR, "stats.db")`, and PI_CONFIG_DIR is a
 * home-relative NAME. The child env is derived from cfg by buildSyncEnv()
 * (below) so the child and the viewer agree on the same file.
 */
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Subprocess } from "bun";
import { json, errorJson } from "./stats-http";
import type { StatsConfig } from "./stats-config";
import type { AppCtx, Route, SyncOutcome } from "./stats-types";

/** Timeout knobs, an object so tests can shrink the window without a rebuild. */
export const syncConfig = {
	/** how long to wait for the omp child before killing it (10 min) */
	timeoutMs: 10 * 60 * 1000,
};

/** Spawn failed because the omp binary is missing/unrunnable (ENOENT). */
export class SyncUnavailable extends Error {}

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
export function parseSummary(output: string): SyncOutcome {
	const m = /Synced (\d+) new entries from (\d+) files \((\d+) total\)/.exec(output);
	if (!m) return { processed: 0, files: 0, totalMessages: 0 };
	return { processed: Number(m[1]), files: Number(m[2]), totalMessages: Number(m[3]) };
}

/**
 * Builds the child environment for `omp stats --summary` so the child writes
 * the SAME stats.db the viewer reads and syncs the SAME sessions.
 *
 * omp resolves its stats db as `join(homedir(), PI_CONFIG_DIR, "stats.db")`,
 * where PI_CONFIG_DIR is a home-relative NAME, and its sessions from
 * PI_CODING_AGENT_DIR. Cases:
 *   - default stats.db (`$HOME/.omp/stats.db`): drop PI_CONFIG_DIR so omp uses
 *     its built-in default target
 *   - any other stats.db under $HOME: pass the home-relative NAME of its directory
 *   - anywhere else (an isolated agent dir, an XDG root outside $HOME): omp's
 *     config root is join(HOME, PI_CONFIG_DIR), so HOME is set to the stats
 *     directory and PI_CONFIG_DIR to "." Writes stay under that directory; the
 *     real ~/.omp is never touched.
 * PI_PROFILE / OMP_PROFILE / XDG_DATA_HOME are always dropped (cfg already chose
 * the target). PI_CODING_AGENT_DIR is always the absolute sessions parent.
 */
export function buildSyncEnv(cfg: StatsConfig, home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	// The SDK's XDG root takes precedence over PI_CONFIG_DIR when it exists.
	// cfg already chose the target; never let the child redirect it again.
	delete env.XDG_DATA_HOME;
	const statsDir = dirname(cfg.statsDbPath);
	if (cfg.statsDbPath === join(home, ".omp", "stats.db")) {
		// Default target, so omp uses its built-in default.
		delete env.PI_CONFIG_DIR;
	} else if (statsDir === home || statsDir.startsWith(home + sep)) {
		env.PI_CONFIG_DIR = relative(home, statsDir);
	} else {
		env.HOME = statsDir;
		env.PI_CONFIG_DIR = ".";
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
					// Child already gone, nothing to kill.
				}
				reject(new SyncTimedOut("sync timed out"));
			}, syncConfig.timeoutMs);
			// Cancel the timer when the race settles so it never dangles.
			aborter.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
		});
		const { code, stderr } = await Promise.race([
			(async () => {
				const [, stderr] = await Promise.all([
					Bun.readableStreamToText(proc.stdout),
					Bun.readableStreamToText(proc.stderr),
				]);
				const code = await proc.exited;
				return { code, stderr };
			})(),
			timeout,
		]);

		if (code !== 0) throw new SyncFailed(stderr.slice(-500));
		return parseSummary(stderr);
	} finally {
		aborter.abort();
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}
}

/** Single-flight guard, module-scope per process (one app per process). */
let inflight: Promise<Response> | null = null;

/** ISO time of the last successful sync in this process; null until one lands. */
let lastSyncedAt: string | null = null;

/** Sync status for GET /ctl/stats/health. */
export function syncStatus(): { lastSyncedAt: string | null; syncing: boolean } {
	return { lastSyncedAt, syncing: inflight !== null };
}

const SYNC_ERROR_503 =
	"omp binary not found. Install omp (`bun install -g @oh-my-pi/pi-coding-agent`) or add it to PATH";

export function register(ctx: AppCtx, routes: Route[]): void {
	routes.push({
		method: "POST",
		pattern: /^\/ctl\/stats\/sync$/,
		handler: async () => {
			if (inflight) return errorJson("sync already in progress", 409);

			const started = Date.now();
			const task = (async (): Promise<Response> => {
				try {
					const runner = ctx.syncRunner ?? (() => spawnSync(buildSyncEnv(ctx.cfg, homedir())));
					const outcome = await runner(process.env);
					ctx.dbm.reprobe();
					lastSyncedAt = new Date().toISOString();
					const durationMs = Date.now() - started;
					return json({ ...outcome, durationMs });
				} catch (err) {
					console.error("[sync] failed", err instanceof Error ? err.message : String(err));
					if (err instanceof SyncUnavailable) return errorJson(SYNC_ERROR_503, 503);
					if (err instanceof SyncTimedOut) return errorJson("sync timed out", 504);
					if (err instanceof SyncFailed) {
						return json({ error: "omp stats failed", detail: err.detail }, 502);
					}
					throw err; // unknown; the dispatch boundary turns it into JSON 500
				} finally {
					inflight = null;
				}
			})();
			inflight = task;
			return await task;
		},
	});
}
