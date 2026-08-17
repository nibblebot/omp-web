/**
 * Regression tests for the Phase 3 /ctl/stats/sessions list cache.
 *
 * The full list (disk walk + db enrichment) is cached keyed on the
 * recursive sessions-tree dir stats + stats.db stat, with a short TTL:
 *   - two sequential GETs → identical list, but the disk walk runs once
 *     (instrumented via sessionsWalkCounter);
 *   - a file GROWING in place changes no dir stat → stale within TTL, and
 *     only after TTL expiry does the response reflect the new size;
 *   - a stats.db swap changes the key immediately → recomputed on the next
 *     request without waiting for the TTL;
 *   - ?tool= filtering runs per-request on the cached list (db-backed, 503
 *     semantics preserved).
 *
 * Reprobes are triggered the production way: GET /ctl/stats/health (the
 * health route re-probes per request).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { StatsConfig } from "../fleet/stats/config";
import { SESSIONS_CACHE_TTL_MS, sessionsWalkCounter } from "../fleet/stats/routes/sessions";

interface SessionRow {
	file: string;
	size: number;
	synced: boolean;
	turns: number;
	toolCalls: number;
}

interface SessionsResponse {
	sessions: SessionRow[];
}

describe("sessions list cache", () => {
	let tmp: string;
	let cfg: StatsConfig;
	let app: StatsApp;

	const jsonlPath = (): string => join(cfg.sessionsDir, "proj", "demo.jsonl");

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "omp-cache-"));
		cfg = {
			configRoot: join(tmp, "config"),
			statsDbPath: join(tmp, "config", "stats.db"),
			sessionsDir: join(tmp, "agent", "sessions"),
		};
		mkdirSync(join(cfg.sessionsDir, "proj"), { recursive: true });
		mkdirSync(cfg.configRoot, { recursive: true });
		writeFileSync(
			jsonlPath(),
			[
				JSON.stringify({ type: "title", title: "Cached Session" }),
				JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp", title: "Cached" }),
				"",
			].join("\n"),
		);
		app = createStatsApp(cfg);
	});

	afterAll(() => {
		app.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	const get = (path: string): Promise<Response | null> =>
		app.handleFetch(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));

	const sessionsOf = async (res: Response): Promise<SessionRow[]> =>
		((await res.json()) as SessionsResponse).sessions;

	test("sequential GETs serve the same list; the disk walk runs once", async () => {
		const start = sessionsWalkCounter.runs;
		const res1 = await get("/ctl/stats/sessions");
		expect(res1.status).toBe(200);
		const list1 = await sessionsOf(res1);
		expect(list1).toHaveLength(1);
		expect(list1[0]!.file).toBe("proj/demo.jsonl");
		expect(sessionsWalkCounter.runs).toBe(start + 1); // one walk for the miss

		const res2 = await get("/ctl/stats/sessions");
		expect(res2.status).toBe(200);
		expect(await sessionsOf(res2)).toEqual(list1);
		expect(sessionsWalkCounter.runs).toBe(start + 1); // cache hit — no second walk
	});

	test("in-place file growth is stale within TTL, visible after expiry", async () => {
		// Ensure a fresh cache entry exists before probing staleness.
		await Bun.sleep(SESSIONS_CACHE_TTL_MS + 150);
		let res = await get("/ctl/stats/sessions");
		let list = await sessionsOf(res);
		const size0 = list[0]!.size;
		const runsAfterRecompute = sessionsWalkCounter.runs;
		expect(size0).toBeGreaterThan(0);

		// Grow the file in place: no dir stat changes, so within the TTL the
		// cached (stale) size is served and the walk is NOT re-run.
		appendFileSync(
			jsonlPath(),
			JSON.stringify({ type: "assistant", message: { content: [] } }) + "\n",
		);
		res = await get("/ctl/stats/sessions");
		list = await sessionsOf(res);
		expect(sessionsWalkCounter.runs).toBe(runsAfterRecompute);
		expect(list[0]!.size).toBe(size0);

		// After TTL expiry the recompute sees the grown file.
		await Bun.sleep(SESSIONS_CACHE_TTL_MS + 150);
		res = await get("/ctl/stats/sessions");
		list = await sessionsOf(res);
		expect(sessionsWalkCounter.runs).toBe(runsAfterRecompute + 1);
		expect(list[0]!.size).toBeGreaterThan(size0);
	}, 15000); // two TTL sleeps (6.3s) exceed bun's 5s default test timeout

	test("stats.db swap changes the key → immediate recompute; tool filter stays per-request", async () => {
		const abs = jsonlPath();
		const db = new Database(cfg.statsDbPath);
		db.exec(
			`CREATE TABLE messages (
         timestamp INTEGER, stop_reason TEXT, model TEXT,
         input_tokens INTEGER, output_tokens INTEGER,
         cache_read_tokens INTEGER, cache_write_tokens INTEGER,
         cost_total REAL, session_file TEXT)`,
		);
		db.exec("CREATE TABLE tool_calls (tool_name TEXT, is_error INTEGER, session_file TEXT)");
		db.exec("CREATE TABLE user_messages (chars INTEGER, session_file TEXT)");
		db.query(
			"INSERT INTO messages (timestamp, stop_reason, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, session_file) VALUES (1, 'done', 'gpt-x', 10, 5, 0, 0, 0.5, ?)",
		).run(abs);
		db.query(
			"INSERT INTO tool_calls (tool_name, is_error, session_file) VALUES ('edit', 0, ?)",
		).run(abs);
		db.query("INSERT INTO user_messages (chars, session_file) VALUES (42, ?)").run(abs);
		db.close();
		// The manager opened with no stats.db; a health request (as production
		// does per-request) reprobes and picks up the newly present file so
		// db() returns a live handle.
		await get("/ctl/stats/health");

		// Key changed (db stat now in the key) → recompute immediately, no TTL wait.
		const res = await get("/ctl/stats/sessions");
		expect(res.status).toBe(200);
		const list = await sessionsOf(res);
		expect(list).toHaveLength(1);
		expect(list[0]!.synced).toBe(true);
		expect(list[0]!.turns).toBe(1);
		expect(list[0]!.toolCalls).toBe(1);

		// Subsequent GET is a cache hit.
		const runsBefore = sessionsWalkCounter.runs;
		const res2 = await get("/ctl/stats/sessions");
		expect(sessionsWalkCounter.runs).toBe(runsBefore);
		expect(await sessionsOf(res2)).toEqual(list);

		// Tool filter runs per-request on the cached list (no extra walk).
		const matching = await get("/ctl/stats/sessions?tool=edit");
		expect(matching.status).toBe(200);
		expect(await sessionsOf(matching)).toHaveLength(1);
		expect(sessionsWalkCounter.runs).toBe(runsBefore);

		const none = await get("/ctl/stats/sessions?tool=nope");
		expect(none.status).toBe(200);
		expect(await sessionsOf(none)).toHaveLength(0);
		expect(sessionsWalkCounter.runs).toBe(runsBefore);
	});
});
