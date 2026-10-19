/**
 * Sessions-list header fields (FPS-10): title, cwd and id come from the
 * bounded head read through parseSessionHead, the single head parser the
 * list and the fleet store share. Empty strings normalize to null.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createStatsApp } from "../stats-app";
import type { StatsConfig } from "../stats-config";
import { parseSessionHead } from "../session-head";
import { handleFetch } from "./stats.testkit";

afterAll(cleanupTempDirs);

interface Row {
	title: string | null;
	cwd: string | null;
	id: string | null;
	firstPrompt: string | null;
}

/** Title slot: a fixed 256-byte line, as the transcript writer emits it. */
const titleSlot = (title: string): string =>
	`${JSON.stringify({ type: "title", title }).padEnd(256, " ")}\n`;
const sessionHeader = (fields: Record<string, string>): string =>
	`${JSON.stringify({ type: "session", ...fields })}\n`;
const userPrompt = (text: string): string =>
	`${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;

/** Writes one transcript as proj/s.jsonl, lists it, and returns its row. */
async function listedRow(prefix: string, text: string): Promise<Row> {
	const root = tempDir(prefix);
	const cfg: StatsConfig = {
		configRoot: join(root, "config"),
		statsDbPath: join(root, "config", "stats.db"),
		sessionsDir: join(root, "agent", "sessions"),
	};
	mkdirSync(join(cfg.sessionsDir, "proj"), { recursive: true });
	mkdirSync(cfg.configRoot, { recursive: true });
	writeFileSync(join(cfg.sessionsDir, "proj", "s.jsonl"), text);
	const app = createStatsApp(cfg);
	try {
		const res = await handleFetch(app, "/ctl/stats/sessions");
		if (!res) throw new Error("expected response");
		const body = (await res.json()) as { sessions: Row[] };
		expect(body.sessions).toHaveLength(1);
		return body.sessions[0]!;
	} finally {
		await app.close();
	}
}

describe("sessions list header fields (FPS-10)", () => {
	test("title, cwd and id match parseSessionHead on the transcript head", async () => {
		const text =
			titleSlot("Slot Title") +
			sessionHeader({ id: "sid-1", cwd: "/work/x" }) +
			userPrompt("find me");
		const row = await listedRow("omp-head-parity-", text);
		const head = parseSessionHead(text);
		expect(row.title).toBe(head.title);
		expect(row.cwd).toBe(head.cwd);
		expect(row.id).toBe(head.id);
		expect(row.title).toBe("Slot Title");
		expect(row.firstPrompt).toBe("find me");
	});

	test("header fields come from the head when the transcript is far larger than the head read", async () => {
		const bulk = `${JSON.stringify({
			type: "message",
			message: { role: "assistant", content: "y".repeat(200_000) },
		})}\n`;
		const text = titleSlot("Big") + sessionHeader({ id: "big-1", cwd: "/big" }) + bulk;
		const row = await listedRow("omp-head-big-", text);
		expect(row.title).toBe("Big");
		expect(row.id).toBe("big-1");
		expect(row.cwd).toBe("/big");
	});

	test("empty title and id normalize to null", async () => {
		const text = titleSlot("") + sessionHeader({ id: "", cwd: "/tmp" });
		const row = await listedRow("omp-head-empty-", text);
		expect(row.title).toBeNull();
		expect(row.id).toBeNull();
		expect(row.cwd).toBe("/tmp");
	});
});
