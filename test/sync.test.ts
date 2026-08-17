/**
 * POST /ctl/stats/sync tests with an injected fake SyncRunner.
 *
 * The fake runner's behavior is switched per-test via a mode variable. The
 * success case writes a real row into a tmpdir stats.db from inside the
 * runner, so /ctl/stats/health dbCounts prove the post-sync reprobe picked
 * it up (health is the reprobe-observing surface; the sync route itself
 * reprobes once before responding). The real-spawn paths (timeout kill →
 * 504, ENOENT → 503) live in test/sync-timeout.test.ts, which needs its own
 * app without a runner.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStatsConfig, type StatsConfig } from "../fleet/stats/config";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import {
	buildSyncEnv,
	parseSummary,
	SyncConfigError,
	SyncFailed,
	SyncUnavailable,
} from "../fleet/stats/routes/sync";
import type { SyncRunner } from "../fleet/stats/types";

type Mode = "success" | "slow" | "unavailable" | "failed";
let mode: Mode = "success";

let tmpDir: string;
let app: StatsApp;

const statsDbPath = (): string => join(tmpDir, "stats.db");
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

const fakeRunner: SyncRunner = async () => {
	switch (mode) {
		case "slow":
			await Bun.sleep(1500);
			return { processed: 1, files: 1, totalMessages: 1 };
		case "unavailable":
			throw new SyncUnavailable("nope");
		case "failed":
			throw new SyncFailed("boom");
		default: {
			// success — write a row into stats.db the way `omp stats` would, then
			// close (checkpoint) so the main file changes and reprobe must reopen.
			const db = new Database(statsDbPath());
			db.run(
				`INSERT INTO messages
           (session_file, entry_id, folder, model, provider, api, timestamp,
            stop_reason, input_tokens, output_tokens, total_tokens,
            premium_requests, cost_total, agent_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["proj/a.jsonl", "e1", "proj", "m", "p", "a", 0, "done", 1, 1, 2, 0, 0, "main"],
			);
			db.close();
			return { processed: 3, files: 2, totalMessages: 10 };
		}
	}
};

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "sync-test-"));
	// Minimal stats.db schema (health only runs COUNT(*) per table).
	const db = new Database(statsDbPath());
	db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      stop_reason TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      UNIQUE(session_file, entry_id)
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE user_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      UNIQUE(session_file, entry_id)
    );
  `);
	db.close();

	const cfg = resolveStatsConfig({
		PI_CONFIG_DIR: tmpDir,
		PI_CODING_AGENT_DIR: join(tmpDir, "agent"),
	});
	app = createStatsApp({ ...cfg, syncRunner: fakeRunner });
});

afterAll(() => {
	app.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /ctl/stats/sync", () => {
	test("success: 200 outcome shape, and health reflects the synced row", async () => {
		mode = "success";

		const res = await postSync();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			processed: 3,
			files: 2,
			totalMessages: 10,
			durationMs: expect.any(Number),
		});

		// The row written by the fake runner is visible only after the sync
		// handler's post-success reprobe — if that reprobe were missing, the
		// app's original handle (opened before the row existed) would still
		// report 0.
		const health = await getHealth();
		expect(health.status).toBe(200);
		const body = (await health.json()) as {
			dbCounts: { messages: number; toolCalls: number; userMessages: number };
		};
		expect(body.dbCounts).toEqual({ messages: 1, toolCalls: 0, userMessages: 0 });
	});

	test("concurrent POST during an in-flight sync → 409", async () => {
		mode = "slow";
		const first = postSync();
		await Bun.sleep(100); // first request is mid-flight now

		const second = await postSync();
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ error: "sync already in progress" });

		const firstRes = await first; // completes normally afterwards
		expect(firstRes.status).toBe(200);
	});

	test("runner throws SyncUnavailable → 503 with install hint", async () => {
		mode = "unavailable";
		const res = await postSync();
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error:
				"omp binary not found — install omp (`npm i -g @oh-my-pi/omp-stats`) or add it to PATH",
		});
	});

	test("runner throws SyncFailed → 502 with stderr detail", async () => {
		mode = "failed";
		const res = await postSync();
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({
			error: "omp stats failed",
			detail: "boom",
		});
	});
});

describe("buildSyncEnv", () => {
	const HOME = "/home/u";
	const baseCfg = (statsDbPath: string): StatsConfig => ({
		configRoot: "/home/u/repos/app",
		statsDbPath,
		sessionsDir: "/home/u/repos/app/agent/sessions",
	});

	test("default stats.db: drops PI_CONFIG_DIR and PI_PROFILE so omp uses its default", () => {
		const savedConfig = process.env.PI_CONFIG_DIR;
		const savedProfile = process.env.PI_PROFILE;
		process.env.PI_CONFIG_DIR = "stale";
		process.env.PI_PROFILE = "stale";
		try {
			const out = buildSyncEnv(baseCfg(join(HOME, ".omp", "stats.db")), HOME);
			expect("PI_CONFIG_DIR" in out).toBe(false);
			expect("PI_PROFILE" in out).toBe(false);
			expect(out.PI_CODING_AGENT_DIR).toBe("/home/u/repos/app/agent");
			// untouched vars pass through
			expect(out.PORT).toBe(process.env.PORT);
		} finally {
			if (savedConfig === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = savedConfig;
			if (savedProfile === undefined) delete process.env.PI_PROFILE;
			else process.env.PI_PROFILE = savedProfile;
		}
	});

	test("stats.db under $HOME: PI_CONFIG_DIR becomes the home-relative name", () => {
		const savedProfile = process.env.PI_PROFILE;
		process.env.PI_PROFILE = "stale";
		try {
			const out = buildSyncEnv(
				baseCfg(join(HOME, "repos/omp-fleet/test/.fixture", "stats.db")),
				HOME,
			);
			expect(out.PI_CONFIG_DIR).toBe("repos/omp-fleet/test/.fixture");
			expect("PI_PROFILE" in out).toBe(false);
			expect(out.PI_CODING_AGENT_DIR).toBe("/home/u/repos/app/agent");
		} finally {
			if (savedProfile === undefined) delete process.env.PI_PROFILE;
			else process.env.PI_PROFILE = savedProfile;
		}
	});

	test("stats.db outside $HOME: refuses with SyncConfigError", () => {
		expect(() => buildSyncEnv(baseCfg("/tmp/xyz/stats.db"), HOME)).toThrow(SyncConfigError);
		try {
			buildSyncEnv(baseCfg("/tmp/xyz/stats.db"), HOME);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SyncUnavailable);
			expect((err as Error).message).toContain("outside omp's config root");
		}
	});
});

describe("parseSummary", () => {
	test("parses the canonical summary line", () => {
		expect(parseSummary("Synced 3 new entries from 2 files (10 total)")).toEqual({
			processed: 3,
			files: 2,
			totalMessages: 10,
		});
	});

	test("parses zeros explicitly", () => {
		expect(parseSummary("Synced 0 new entries from 0 files (0 total)")).toEqual({
			processed: 0,
			files: 0,
			totalMessages: 0,
		});
	});

	test("falls back to zeros on any parse miss", () => {
		expect(parseSummary("")).toEqual({ processed: 0, files: 0, totalMessages: 0 });
		expect(parseSummary("nothing synced this run")).toEqual({
			processed: 0,
			files: 0,
			totalMessages: 0,
		});
		expect(parseSummary("Synced X new entries from Y files (Z total)")).toEqual({
			processed: 0,
			files: 0,
			totalMessages: 0,
		});
	});
});
