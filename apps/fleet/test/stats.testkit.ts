/**
 * Test harness: drives an in-process StatsApp (fleet/stats) through a real
 * Bun.serve on an ephemeral port, against the generated fixture.
 *
 * Config resolution (fleet/stats/config.ts): stats.db = $PI_CONFIG_DIR/
 * stats.db, sessions = $PI_CODING_AGENT_DIR/sessions, so the fixture keeps
 * stats.db at test/.fixture/stats.db and sessions under
 * test/.fixture/agent/sessions, passed explicitly to createStatsApp.
 */
import { join } from "node:path";
import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { createStatsApp, type StatsApp } from "../stats-app";

export const repoRoot = join(import.meta.dir, "..", "..", "..");
export const fixtureRoot = join(import.meta.dir, ".fixture");
export let baseUrl = "";

let app: StatsApp | null = null;
let server: Server<undefined> | null = null;

export async function startServer(): Promise<void> {
	if (server) return;
	app = createStatsApp({
		configRoot: fixtureRoot,
		statsDbPath: join(fixtureRoot, "stats.db"),
		sessionsDir: join(fixtureRoot, "agent", "sessions"),
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0, // ephemeral, no fixed port to collide with
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/ctl/stats")) {
				const r = await app!.handleFetch(req, url);
				if (r !== null) return r;
			}
			// Anything the stats app does not own is the fleet control plane's
			// 404, mirrored here so HTTP-level tests stay end-to-end.
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
}

export async function stopServer(): Promise<void> {
	const s = server;
	server = null;
	if (s) s.stop(true);
	const a = app;
	app = null;
	if (a) a.close();
}

export async function api(path: string): Promise<Response> {
	return fetch(`${baseUrl}${path}`);
}

/**
 * Drive a stats app with a constructed request; the URL is derived from the
 * path. Routes match on method + pathname only, so the origin is irrelevant.
 */
export function handleFetch(
	app: StatsApp,
	path: string,
	init?: RequestInit,
): Promise<Response | null> {
	const url = `http://localhost${path}`;
	return app.handleFetch(new Request(url, init), new URL(url));
}

/** POST /ctl/stats/sync (the sync route reprobes once before responding). */
export function postSync(app: StatsApp): Promise<Response | null> {
	return handleFetch(app, "/ctl/stats/sync", { method: "POST" });
}

/** GET /ctl/stats/health: reprobes stats.db the way production does. */
export function getHealth(app: StatsApp): Promise<Response | null> {
	return handleFetch(app, "/ctl/stats/health");
}

/**
 * Write the minimal stats.db schema (messages/tool_calls/user_messages) with
 * one enrichment row per table attributed to `sessionFile`, as the sessions
 * cache and degradation tests need for the db-backed paths.
 */
export function writeMinimalStatsDb(statsDbPath: string, sessionFile: string): void {
	const db = new Database(statsDbPath);
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
	).run(sessionFile);
	db.query("INSERT INTO tool_calls (tool_name, is_error, session_file) VALUES ('edit', 0, ?)").run(
		sessionFile,
	);
	db.query("INSERT INTO user_messages (chars, session_file) VALUES (42, ?)").run(sessionFile);
	db.close();
}
