/**
 * /ctl/stats/health (FPS-08):
 *   - sessionsCount is read from the cached sessions list: a probe after a
 *     list GET runs no list recompute, and a new session directory shows on
 *     the next probe (the list key covers every directory stat);
 *   - sessionsCount counts on-disk MAIN sessions only (subagent transcripts
 *     excluded), the same rows the list marks onDisk;
 *   - dbCounts are memoized on the stats.db stat and refresh after a write.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createStatsApp, type StatsApp } from "../stats-app";
import type { StatsConfig } from "../stats-config";
import { sessionsWalkCounter } from "../stats-sessions";
import { handleFetch, writeMinimalStatsDb } from "./stats.testkit";

afterAll(cleanupTempDirs);

interface HealthBody {
	sessionsCount: number;
	dbCounts: { messages: number; toolCalls: number; userMessages: number } | null;
}

interface SessionsBody {
	sessions: Array<{ onDisk: boolean }>;
}

const sessionLine = (id: string): string => `${JSON.stringify({ type: "session", id })}\n`;

const jsonOf = async <T>(res: Response | null): Promise<T> => {
	if (!res) throw new Error("expected response");
	return (await res.json()) as T;
};

function setup(prefix: string): StatsConfig {
	const root = tempDir(prefix);
	const cfg: StatsConfig = {
		configRoot: join(root, "config"),
		statsDbPath: join(root, "config", "stats.db"),
		sessionsDir: join(root, "agent", "sessions"),
	};
	mkdirSync(join(cfg.sessionsDir, "proj", "a"), { recursive: true });
	mkdirSync(cfg.configRoot, { recursive: true });
	writeFileSync(join(cfg.sessionsDir, "proj", "a.jsonl"), sessionLine("a"));
	writeFileSync(join(cfg.sessionsDir, "proj", "b.jsonl"), sessionLine("b"));
	// Subagent transcript (three segments): not a main session, not counted.
	writeFileSync(join(cfg.sessionsDir, "proj", "a", "sub.jsonl"), sessionLine("sub"));
	return cfg;
}

describe("/ctl/stats/health sessionsCount (FPS-08)", () => {
	test("counts on-disk main sessions from the cached list with no extra walk", async () => {
		const cfg = setup("omp-health-count-");
		const app: StatsApp = createStatsApp(cfg);
		try {
			const rows = (await jsonOf<SessionsBody>(await handleFetch(app, "/ctl/stats/sessions")))
				.sessions;
			const walks = sessionsWalkCounter.runs;
			const health = await jsonOf<HealthBody>(await handleFetch(app, "/ctl/stats/health"));
			expect(health.sessionsCount).toBe(2);
			expect(health.sessionsCount).toBe(rows.filter((r) => r.onDisk).length);
			expect(sessionsWalkCounter.runs).toBe(walks);
		} finally {
			await app.close();
		}
	});

	test("a new session directory shows in the next probe with exactly one list recompute", async () => {
		const cfg = setup("omp-health-ttl-");
		const app: StatsApp = createStatsApp(cfg);
		try {
			await jsonOf(await handleFetch(app, "/ctl/stats/sessions"));
			const walks = sessionsWalkCounter.runs;
			mkdirSync(join(cfg.sessionsDir, "proj2"), { recursive: true });
			writeFileSync(join(cfg.sessionsDir, "proj2", "c.jsonl"), sessionLine("c"));
			const health = await jsonOf<HealthBody>(await handleFetch(app, "/ctl/stats/health"));
			expect(health.sessionsCount).toBe(3);
			expect(sessionsWalkCounter.runs).toBe(walks + 1);
		} finally {
			await app.close();
		}
	});
});

describe("/ctl/stats/health dbCounts (FPS-08)", () => {
	test("dbCounts are memoized per stats.db stat and refresh after a write", async () => {
		const cfg = setup("omp-health-db-");
		const abs = join(cfg.sessionsDir, "proj", "a.jsonl");
		writeMinimalStatsDb(cfg.statsDbPath, abs);
		const app: StatsApp = createStatsApp(cfg);
		try {
			const first = await jsonOf<HealthBody>(await handleFetch(app, "/ctl/stats/health"));
			expect(first.dbCounts?.messages).toBe(1);
			const repeat = await jsonOf<HealthBody>(await handleFetch(app, "/ctl/stats/health"));
			expect(repeat.dbCounts).toEqual(first.dbCounts);

			const db = new Database(cfg.statsDbPath);
			db.query(
				"INSERT INTO messages (timestamp, stop_reason, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, session_file) VALUES (2, 'done', 'gpt-x', 1, 1, 0, 0, 0, ?)",
			).run(abs);
			db.close();

			const after = await jsonOf<HealthBody>(await handleFetch(app, "/ctl/stats/health"));
			expect(after.dbCounts?.messages).toBe(2);
		} finally {
			await app.close();
		}
	});
});
