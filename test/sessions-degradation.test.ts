/**
 * Degradation tests: /ctl/stats/sessions and /ctl/stats/tools must survive
 * stats.db trouble with JSON responses — never a 500.
 *
 *   - missing stats.db        → /ctl/stats/tools 503, sessions 200 disk-only rows
 *   - corrupt stats.db        → same (garbage bytes)
 *   - schema-mismatched db    → same (valid SQLite, wrong tables/columns)
 *
 * createStatsApp is one-per-process, so a single app is created against a
 * tmpdir and the stats.db file is swapped between phases. The stats app has
 * no ctx surface — reprobing is triggered the same way production does it:
 * a GET /ctl/stats/health (the health route re-probes per request).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { StatsConfig } from "../fleet/stats/config";

interface SessionRow {
	file: string;
	folder: string;
	firstTs: number | null;
	synced: boolean;
	onDisk: boolean;
	turns: number;
	toolCalls: number;
	totalTokens: number;
	totalCost: number;
	errorTurns: number;
	modelCount: number;
	userMessages: number;
	userChars: number;
	size: number;
}

interface SessionsResponse {
	sessions: SessionRow[];
	total: number;
	truncated: boolean;
}

describe("stats.db degradation", () => {
	let tmp: string;
	let cfg: StatsConfig;
	let app: StatsApp;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "omp-degrad-"));
		const sessionsDir = join(tmp, "agent", "sessions");
		mkdirSync(join(sessionsDir, "proj"), { recursive: true });
		writeFileSync(
			join(sessionsDir, "proj", "demo.jsonl"),
			[
				JSON.stringify({ type: "title", title: "Degraded Session" }),
				JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp", title: "Demo" }),
				JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
				"",
			].join("\n"),
		);
		cfg = {
			configRoot: join(tmp, "config"),
			statsDbPath: join(tmp, "config", "stats.db"),
			sessionsDir,
		};
		mkdirSync(cfg.configRoot, { recursive: true });
		// No stats.db yet — the manager starts with a null handle.
		app = createStatsApp(cfg);
	});

	afterAll(() => {
		app.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	const get = (path: string): Promise<Response | null> =>
		app.handleFetch(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));

	const expectDbUnavailable = async (res: Response): Promise<void> => {
		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: "stats.db unavailable" });
	};

	const expectDegradedSessions = async (res: Response): Promise<void> => {
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as SessionsResponse;
		expect(body.sessions).toHaveLength(1);
		const row = body.sessions[0]!;
		expect(row.file).toBe("proj/demo.jsonl");
		expect(row.folder).toBe("proj");
		expect(row.onDisk).toBe(true);
		expect(row.synced).toBe(false);
		expect(row.turns).toBe(0);
		expect(row.toolCalls).toBe(0);
		expect(row.totalTokens).toBe(0);
		expect(row.totalCost).toBe(0);
		expect(row.errorTurns).toBe(0);
		expect(row.modelCount).toBe(0);
		expect(row.userMessages).toBe(0);
		expect(row.userChars).toBe(0);
		expect(row.size).toBeGreaterThan(0);
	};

	test("missing stats.db → tools 503, sessions 200 with disk-only rows", async () => {
		await expectDbUnavailable(await get("/ctl/stats/tools"));
		await expectDegradedSessions(await get("/ctl/stats/sessions"));
	});

	test("corrupt stats.db (garbage bytes) → same degradation, no 500", async () => {
		writeFileSync(
			cfg.statsDbPath,
			"this is definitely not a sqlite database, just garbage bytes\n".repeat(8),
		);
		await get("/ctl/stats/health"); // health re-probes stats.db (production reprobe path)
		await expectDbUnavailable(await get("/ctl/stats/tools"));
		await expectDegradedSessions(await get("/ctl/stats/sessions"));
		// Tool filter is db-backed; with a broken db it is an explicit 503 —
		// never a false "no sessions use this tool" empty list.
		await expectDbUnavailable(await get("/ctl/stats/sessions?tool=edit"));
	});

	test("schema-mismatched stats.db → same degradation, no 500", async () => {
		// Drop the corrupt file so SQLite creates a fresh db (a non-empty garbage
		// file can't be reinitialized in place). The health reprobe sees the new
		// stat and rotates the lazy corrupt-phase handle before reopening.
		rmSync(cfg.statsDbPath, { force: true });
		const db = new Database(cfg.statsDbPath);
		db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)"); // wrong columns, no tool_calls/user_messages
		db.exec("CREATE TABLE other (x INTEGER)");
		db.close();
		await get("/ctl/stats/health"); // health re-probes stats.db (production reprobe path)
		await expectDbUnavailable(await get("/ctl/stats/tools"));
		await expectDegradedSessions(await get("/ctl/stats/sessions"));
		await expectDbUnavailable(await get("/ctl/stats/sessions?tool=edit"));
	});

	test("valid stats.db → enrichment and tools still work (no regression)", async () => {
		// Prove the degradation guards did not change the healthy-db behavior:
		// same queries, same merge, full metrics + synced:true.
		rmSync(cfg.statsDbPath, { force: true });
		const abs = join(cfg.sessionsDir, "proj", "demo.jsonl");
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
		await get("/ctl/stats/health"); // health re-probes stats.db (production reprobe path)

		const tools = await get("/ctl/stats/tools");
		expect(tools.status).toBe(200);
		const toolsBody = (await tools.json()) as {
			tools: Array<{ name: string; calls: number; errors: number; sessions: number }>;
		};
		expect(toolsBody.tools).toHaveLength(1);
		expect(toolsBody.tools[0]).toEqual({ name: "edit", calls: 1, errors: 0, sessions: 1 });

		const sessions = await get("/ctl/stats/sessions");
		expect(sessions.status).toBe(200);
		const body = (await sessions.json()) as SessionsResponse;
		expect(body.sessions).toHaveLength(1);
		const row = body.sessions[0]!;
		expect(row.synced).toBe(true);
		expect(row.firstTs ?? row.turns).toBe(1); // firstTs present on SessionSummary
		expect(row.turns).toBe(1);
		expect(row.errorTurns).toBe(0);
		expect(row.totalTokens).toBe(15);
		expect(row.totalCost).toBe(0.5);
		expect(row.modelCount).toBe(1);
		expect(row.toolCalls).toBe(1);
		expect(row.userMessages).toBe(1);
		expect(row.userChars).toBe(42);

		// Tool filter happy path: matching tool keeps the session, non-matching gives empty.
		const matching = await get("/ctl/stats/sessions?tool=edit");
		expect(matching.status).toBe(200);
		expect(((await matching.json()) as SessionsResponse).sessions).toHaveLength(1);
		const none = await get("/ctl/stats/sessions?tool=nope");
		expect(none.status).toBe(200);
		const noneBody = (await none.json()) as SessionsResponse;
		expect(noneBody.sessions).toHaveLength(0);
		expect(noneBody.total).toBe(0);
		expect(noneBody.truncated).toBe(false);
	});

	test("sessions list caps at 2000 and signals truncation (truncated + total)", async () => {
		// 2000 new disk files + the existing demo.jsonl = 2001 total → 2000
		// returned, truncated: true, total: 2001.
		const sessionsDir = cfg.sessionsDir;
		for (let i = 0; i < 2000; i++) {
			writeFileSync(
				join(sessionsDir, "proj", `bulk-${i}.jsonl`),
				[
					JSON.stringify({ type: "title", title: `Bulk ${i}` }),
					JSON.stringify({ type: "session", id: `bulk-${i}`, cwd: "/tmp", title: `Bulk ${i}` }),
				].join("\n") + "\n",
			);
		}
		const res = await get("/ctl/stats/sessions");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionsResponse;
		expect(body.sessions).toHaveLength(2000);
		expect(body.total).toBe(2001);
		expect(body.truncated).toBe(true);
	});
});
