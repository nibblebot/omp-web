/**
 * Test harness: drives an in-process StatsApp (fleet/stats) through a real
 * Bun.serve on an ephemeral port, against the generated fixture.
 *
 * Config resolution (fleet/stats/config.ts): stats.db = $PI_CONFIG_DIR/
 * stats.db, sessions = $PI_CODING_AGENT_DIR/sessions — so the fixture keeps
 * stats.db at test/.fixture/stats.db and sessions under
 * test/.fixture/agent/sessions, passed explicitly to createStatsApp.
 */
import { join } from "node:path";
import type { Server } from "bun";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";

export const repoRoot = join(import.meta.dir, "..");
export const fixtureRoot = join(import.meta.dir, ".fixture");
export let baseUrl = "";

let app: StatsApp | null = null;
let server: Server | null = null;

export async function startServer(): Promise<void> {
	if (server) return;
	app = createStatsApp({
		configRoot: fixtureRoot,
		statsDbPath: join(fixtureRoot, "stats.db"),
		sessionsDir: join(fixtureRoot, "agent", "sessions"),
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0, // ephemeral — no fixed port to collide with
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/ctl/stats")) {
				const r = await app!.handleFetch(req, url);
				if (r !== null) return r;
			}
			// Anything the stats app does not own is the fleet control plane's
			// 404 — mirrored here so HTTP-level tests stay end-to-end.
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
