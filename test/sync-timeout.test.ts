/**
 * POST /ctl/stats/sync — real-spawn paths only (own app; no injected runner).
 *
 * The app's stats.db lives under $HOME (buildSyncEnv case 2: absolute config
 * root, home-relative NAME handed to the child) so the default spawn path is
 * exercised:
 *   - a fake `omp` on PATH that sleeps forever records its pid, letting us
 *     assert the 10-minute timeout actually kills the child → 504
 *   - a PATH without omp exercises the ENOENT → 503 branch
 *   - a fake `omp` that mimics omp's join(homedir(), PI_CONFIG_DIR,
 *     "stats.db") resolution proves the child env derived from cfg makes the
 *     sync land in the REAL stats.db (never a $HOME-nested copy)
 * The injected-runner paths (200/409/502/503, parse) live in
 * test/sync.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStatsConfig } from "../fleet/stats/config";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import { syncConfig } from "../fleet/stats/routes/sync";

const SYNC_ERROR_503 =
	"omp binary not found — install omp (`npm i -g @oh-my-pi/omp-stats`) or add it to PATH";

/** Fake omp that mimics pi-utils' quirk: stats.db = join(homedir(), PI_CONFIG_DIR, "stats.db"). */
const FAKE_OMP = `#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
const target = join(homedir(), process.env.PI_CONFIG_DIR ?? ".omp", "stats.db");
const db = new Database(target, { create: true });
db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL, folder TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, api TEXT NOT NULL, timestamp INTEGER NOT NULL, stop_reason TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, premium_requests REAL NOT NULL, cost_total REAL NOT NULL, agent_type TEXT NOT NULL DEFAULT 'main', UNIQUE(session_file, entry_id))");
db.exec("CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, folder TEXT NOT NULL, tool_name TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, timestamp INTEGER NOT NULL, agent_type TEXT NOT NULL DEFAULT 'main')");
db.exec("CREATE TABLE IF NOT EXISTS user_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL, folder TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, api TEXT NOT NULL, timestamp INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, premium_requests REAL NOT NULL, cost_total REAL NOT NULL, agent_type TEXT NOT NULL DEFAULT 'main', UNIQUE(session_file, entry_id))");
db.run("INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, stop_reason, input_tokens, output_tokens, total_tokens, premium_requests, cost_total, agent_type) VALUES ('a.jsonl','e1','p','m','p','a',0,'done',1,1,2,0,0,'main')");
db.close();
console.log("Synced 1 new entries from 1 files (1 total)");
`;

let tmpDir: string;
let binDir: string; // sleeping omp (timeout test)
let syncBinDir: string; // quirk-mimicking omp (case-2 test)
let emptyDir: string;
let homeTmp: string; // stats.db lives here — under $HOME
let app: StatsApp;
let savedPath: string | undefined;
let savedTimeoutMs: number;

const postSync = (): Promise<Response> =>
	app.handleFetch(
		new Request("http://localhost/ctl/stats/sync", { method: "POST" }),
		new URL("http://localhost/ctl/stats/sync"),
	);
const getHealth = (): Promise<Response> =>
	app.handleFetch(
		new Request("http://localhost/ctl/stats/health"),
		new URL("http://localhost/ctl/stats/health"),
	);

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "sync-timeout-"));
	binDir = join(tmpDir, "bin");
	syncBinDir = join(tmpDir, "syncbin");
	emptyDir = join(tmpDir, "empty");
	mkdirSync(binDir);
	mkdirSync(syncBinDir);
	mkdirSync(emptyDir);

	// Sleeping omp: writes its pid to $OMP_PIDFILE, then sleeps long past any
	// realistic test window so only the timeout kill can end it.
	writeFileSync(join(binDir, "omp"), '#!/bin/sh\necho $$ > "$OMP_PIDFILE"\nsleep 30\n', {
		mode: 0o755,
	});
	writeFileSync(join(syncBinDir, "omp"), FAKE_OMP, { mode: 0o755 });

	// stats.db under $HOME (absolute config root → buildSyncEnv case 2).
	homeTmp = mkdtempSync(join(homedir(), ".sync-b-"));
	const cfg = resolveStatsConfig({
		PI_CONFIG_DIR: homeTmp,
		PI_CODING_AGENT_DIR: join(homeTmp, "agent"),
	});
	app = createStatsApp(cfg); // no syncRunner → default spawn path

	savedPath = process.env.PATH;
	savedTimeoutMs = syncConfig.timeoutMs;
});

afterAll(() => {
	app.close();
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	delete process.env.OMP_PIDFILE;
	syncConfig.timeoutMs = savedTimeoutMs;
	rmSync(tmpDir, { recursive: true, force: true });
	rmSync(homeTmp, { recursive: true, force: true });
});

describe("POST /ctl/stats/sync — default runner", () => {
	test("times out: kills the omp child and returns 504", async () => {
		syncConfig.timeoutMs = 400;
		const pidfile = join(tmpDir, "omp.pid");
		process.env.PATH = `${binDir}:${savedPath ?? ""}`;
		process.env.OMP_PIDFILE = pidfile;

		const res = await postSync();
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "sync timed out" });

		// The child was killed — its pid must be gone (allow a moment to reap).
		const pid = Number(readFileSync(pidfile, "utf8").trim());
		expect(Number.isInteger(pid) && pid > 0).toBe(true);
		const deadline = Date.now() + 2000;
		let gone = false;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
				await Bun.sleep(50);
			} catch {
				gone = true;
				break;
			}
		}
		expect(gone).toBe(true);
	});

	test("missing omp binary → 503 with install hint", async () => {
		process.env.PATH = emptyDir; // nothing named omp here
		const res = await postSync();
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: SYNC_ERROR_503 });
	});

	test("absolute config root under $HOME: sync lands in the real stats.db, never a $HOME-nested copy", async () => {
		syncConfig.timeoutMs = 5000; // generous — the fake omp is a bun script
		process.env.PATH = `${syncBinDir}:${savedPath ?? ""}`;

		const res = await postSync();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			processed: number;
			files: number;
			totalMessages: number;
			durationMs: number;
		};
		expect(body).toMatchObject({ processed: 1, files: 1, totalMessages: 1 });
		expect(typeof body.durationMs).toBe("number");

		// The REAL stats.db gained the row (visible through the post-sync reprobe).
		const health = await getHealth();
		expect(health.status).toBe(200);
		const h = (await health.json()) as {
			dbCounts: { messages: number };
		};
		expect(h.dbCounts.messages).toBe(1);

		// The old-bug location — join(homedir(), <absolute statsDbPath>) — must
		// NOT exist: the child got the home-relative NAME, not the literal path.
		const nested = join(homedir(), homeTmp.replace(/^\//, ""), "stats.db");
		expect(existsSync(nested)).toBe(false);
	});
});
