/**
 * /ctl/stats/sessions `q` matches conversation body text (ANA-06): the first
 * user prompt and the message tail, not just title/cwd/id/folder. Rows carry
 * `firstPrompt` as their subtitle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { SessionSummary } from "#lib/wire/stats-types";
import { createStatsApp, type StatsApp } from "../stats-app";
import type { StatsConfig } from "../stats-config";
import { handleFetch } from "./stats.testkit";

afterAll(cleanupTempDirs);

const userMsg = (text: string): string =>
	JSON.stringify({ type: "message", message: { role: "user", content: text } });
const assistantMsg = (text: string): string =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});

describe("sessions list: q searches body text", () => {
	let cfg: StatsConfig;
	let app: StatsApp;

	beforeAll(() => {
		const tmp = tempDir("omp-search-");
		cfg = {
			configRoot: join(tmp, "config"),
			statsDbPath: join(tmp, "config", "stats.db"),
			sessionsDir: join(tmp, "agent", "sessions"),
		};
		mkdirSync(join(cfg.sessionsDir, "proj"), { recursive: true });
		mkdirSync(cfg.configRoot, { recursive: true });
		writeFileSync(
			join(cfg.sessionsDir, "proj", "alpha.jsonl"),
			[
				JSON.stringify({ type: "title", title: "Alpha" }),
				JSON.stringify({ type: "session", id: "sess-alpha", cwd: "/tmp/a", title: "Alpha" }),
				userMsg("how do I parse the widget config"),
				assistantMsg("use the parseWidgetFile helper for that"),
				"",
			].join("\n"),
		);
		writeFileSync(
			join(cfg.sessionsDir, "proj", "beta.jsonl"),
			[
				JSON.stringify({ type: "title", title: "Beta" }),
				JSON.stringify({ type: "session", id: "sess-beta", cwd: "/tmp/b", title: "Beta" }),
				userMsg("unrelated question about deploys"),
				"",
			].join("\n"),
		);
		app = createStatsApp(cfg);
	});

	afterAll(() => app.close());

	const search = async (q: string): Promise<SessionSummary[]> => {
		const res = await handleFetch(app, `/ctl/stats/sessions?q=${encodeURIComponent(q)}`);
		if (!res) throw new Error("expected response");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: SessionSummary[] };
		return body.sessions;
	};

	test("matches the first user prompt", async () => {
		const rows = await search("widget config");
		expect(rows.map((r) => r.file)).toEqual(["proj/alpha.jsonl"]);
	});

	test("matches assistant message tail text", async () => {
		const rows = await search("parsewidgetfile");
		expect(rows.map((r) => r.file)).toEqual(["proj/alpha.jsonl"]);
	});

	test("matches case-insensitively and excludes unrelated sessions", async () => {
		const rows = await search("DEPLOYS");
		expect(rows.map((r) => r.file)).toEqual(["proj/beta.jsonl"]);
	});

	test("title/id still match and no match returns empty", async () => {
		expect((await search("sess-beta")).map((r) => r.file)).toEqual(["proj/beta.jsonl"]);
		expect(await search("no-such-text-anywhere")).toEqual([]);
	});

	test("rows expose firstPrompt as the subtitle", async () => {
		const rows = await search("");
		const alpha = rows.find((r) => r.file === "proj/alpha.jsonl");
		expect(alpha?.firstPrompt).toBe("how do I parse the widget config");
	});
});
