/**
 * GET /ctl/stats/sessions/:file/stats takes its title from readSessionTitle
 * (FPS-10): the title slot wins, the session header is the fallback, and an
 * untitled transcript reports null.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createStatsApp } from "../stats-app";
import type { StatsConfig } from "../stats-config";
import { handleFetch, writeMinimalStatsDb } from "./stats.testkit";

afterAll(cleanupTempDirs);

const titleSlot = (title: string): string =>
	`${JSON.stringify({ type: "title", title }).padEnd(256, " ")}\n`;
const sessionHeader = (fields: Record<string, string>): string =>
	`${JSON.stringify({ type: "session", ...fields })}\n`;

/** Writes proj/t.jsonl with `text`, requests its stats, and returns the title. */
async function statsTitle(prefix: string, text: string): Promise<string | null> {
	const root = tempDir(prefix);
	const cfg: StatsConfig = {
		configRoot: join(root, "config"),
		statsDbPath: join(root, "config", "stats.db"),
		sessionsDir: join(root, "agent", "sessions"),
	};
	mkdirSync(join(cfg.sessionsDir, "proj"), { recursive: true });
	mkdirSync(cfg.configRoot, { recursive: true });
	const abs = join(cfg.sessionsDir, "proj", "t.jsonl");
	writeFileSync(abs, text);
	writeMinimalStatsDb(cfg.statsDbPath, abs);
	const app = createStatsApp(cfg);
	try {
		const res = await handleFetch(
			app,
			`/ctl/stats/sessions/${encodeURIComponent("proj/t.jsonl")}/stats`,
		);
		if (!res) throw new Error("expected response");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title: string | null };
		return body.title;
	} finally {
		await app.close();
	}
}

describe("per-session stats title (FPS-10)", () => {
	test("the title slot wins over the session header", async () => {
		const text = titleSlot("Slot") + sessionHeader({ title: "Header", id: "t" });
		await expect(statsTitle("omp-route-title-slot-", text)).resolves.toBe("Slot");
	});

	test("the session header title is the fallback when there is no title slot", async () => {
		const text = sessionHeader({ title: "Header only", id: "o" });
		await expect(statsTitle("omp-route-title-header-", text)).resolves.toBe("Header only");
	});

	test("an untitled transcript reports null", async () => {
		const text = sessionHeader({ id: "n" });
		await expect(statsTitle("omp-route-title-none-", text)).resolves.toBeNull();
	});
});
