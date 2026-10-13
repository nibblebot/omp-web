/**
 * createStatsApp must support any number of apps per process: each app owns
 * a private route registry (threaded through register()), so registrations
 * can never collide. Bare `bun test` runs every suite in ONE process, and
 * the old module-global registry broke on the second createStatsApp call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createStatsApp } from "../stats-app";
import type { StatsConfig } from "../stats-config";
import { handleFetch } from "./stats.testkit";

afterAll(cleanupTempDirs);

function tmpCfg(overrides: Partial<StatsConfig> = {}): StatsConfig {
	const root = tempDir("cap-");
	return {
		configRoot: root,
		statsDbPath: join(root, "stats.db"),
		sessionsDir: join(root, "sessions"),
		...overrides,
	};
}

describe("createStatsApp multi-instance isolation", () => {
	test("two apps in one process keep separate registries and config", async () => {
		const sessionsA = join(tempDir("cap-a-"), "sessions");
		const sessionsB = join(tempDir("cap-b-"), "sessions");
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
			const healthA = await handleFetch(appA, "/ctl/stats/health");
			const healthB = await handleFetch(appB, "/ctl/stats/health");
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
			const ta = await handleFetch(appA, "/ctl/stats/sessions/proj-a%2Fone.jsonl/transcript");
			if (!ta) throw new Error("expected response");
			expect(ta.status).toBe(200);
			const body = (await ta.json()) as { entries: unknown[] };
			expect(body.entries.length).toBeGreaterThanOrEqual(1);
			const tb = await handleFetch(appB, "/ctl/stats/sessions/proj-a%2Fone.jsonl/transcript");
			if (!tb) throw new Error("expected response");
			expect(tb.status).toBe(404);

			// Sessions list reflects each app's own disk.
			const listRes = await handleFetch(appB, "/ctl/stats/sessions");
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
