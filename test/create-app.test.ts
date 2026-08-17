/**
 * createStatsApp must support any number of apps per process: each app owns
 * a private route registry (threaded through register()), so registrations
 * can never collide — bare `bun test` runs every suite in ONE process and
 * the old module-global registry broke on the second createStatsApp call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { StatsConfig } from "../fleet/stats/config";

const scratch: string[] = [];

afterEach(() => {
	for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpCfg(overrides: Partial<StatsConfig> = {}): StatsConfig {
	const root = mkdtempSync(join(tmpdir(), "cap-"));
	scratch.push(root);
	return {
		configRoot: root,
		statsDbPath: join(root, "stats.db"),
		sessionsDir: join(root, "sessions"),
		...overrides,
	};
}

/** Drive a stats app with a constructed request; url derived from req.url. */
const call = (app: StatsApp, path: string, init?: RequestInit): Promise<Response | null> =>
	app.handleFetch(new Request(`http://x${path}`, init), new URL(`http://x${path}`));

describe("createStatsApp multi-instance isolation", () => {
	test("two apps in one process keep separate registries and config", async () => {
		const sessionsA = join(mkdtempSync(join(tmpdir(), "cap-a-")), "sessions");
		const sessionsB = join(mkdtempSync(join(tmpdir(), "cap-b-")), "sessions");
		scratch.push(sessionsA, sessionsB);
		mkdirSync(join(sessionsA, "proj-a"), { recursive: true });
		mkdirSync(sessionsB, { recursive: true });
		writeFileSync(
			join(sessionsA, "proj-a", "one.jsonl"),
			'{"type":"title","title":"Isolated","updatedAt":"2026-01-01T00:00:00.000Z"}\n',
		);

		const appA = createStatsApp(tmpCfg({ sessionsDir: sessionsA }));
		const appB = createStatsApp(tmpCfg({ sessionsDir: sessionsB }));
		try {
			// Health: each app answers with its own cfg.
			const healthA = await call(appA, "/ctl/stats/health");
			const healthB = await call(appB, "/ctl/stats/health");
			expect(healthA).not.toBeNull();
			expect(healthB).not.toBeNull();
			if (!healthA) throw new Error("expected response");
			if (!healthB) throw new Error("expected response");
			const a = (await healthA.json()) as { sessionsDir: string };
			const b = (await healthB.json()) as { sessionsDir: string };
			expect(a.sessionsDir).toBe(sessionsA);
			expect(b.sessionsDir).toBe(sessionsB);

			// Transcript handlers close over their own app's cfg: A sees the file,
			// B must 404 on the same :file param (proves no cross-app wiring).
			const ta = await call(appA, "/ctl/stats/sessions/proj-a%2Fone.jsonl/transcript");
			if (!ta) throw new Error("expected response");
			expect(ta.status).toBe(200);
			const body = (await ta.json()) as { entries: unknown[] };
			expect(body.entries.length).toBeGreaterThanOrEqual(1);
			const tb = await call(appB, "/ctl/stats/sessions/proj-a%2Fone.jsonl/transcript");
			if (!tb) throw new Error("expected response");
			expect(tb.status).toBe(404);

			// Sessions list reflects each app's own disk.
			const listRes = await call(appB, "/ctl/stats/sessions");
			if (!listRes) throw new Error("expected response");
			const listB = (await listRes.json()) as { sessions: unknown[] };
			expect(listB.sessions).toEqual([]);

			appA.close();
			appB.close();
			appA.close(); // idempotent
			appB.close();
		} finally {
			appA.close();
			appB.close();
		}
	});
});
