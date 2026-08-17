/**
 * Untimed-call contract test (audit Phase 7).
 *
 * Calls whose toolResult has NO `tool_execution_start` marker are still
 * counted (calls / errors / resultChars) but contribute no duration:
 * avgMs/maxMs stay null and totalMs is unaffected. Timed calls (with the
 * marker) still pair start → result normally, and unpaired calls remain
 * pending. Uses a tmpdir JSONL + a db-less stats app (stats.db absent →
 * JSONL-only stats).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { StatsConfig } from "../fleet/stats/config";

interface ToolStatLike {
	name: string;
	calls: number;
	errors: number;
	pending: number;
	totalMs: number;
	avgMs: number | null;
	maxMs: number | null;
}

interface StatsLike {
	turns: number;
	toolCalls: number;
	synced: boolean;
	tools: ToolStatLike[];
	longestCall: { toolName: string; toolCallId: string; durationMs: number; args: string } | null;
}

describe("untimed tool calls (no tool_execution_start marker)", () => {
	let tmp: string;
	let app: StatsApp;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "omp-untimed-"));
		const sessionsDir = join(tmp, "agent", "sessions");
		mkdirSync(join(sessionsDir, "proj"), { recursive: true });

		// call-untimed: result present, NO execution-start marker → counted, no duration.
		// call-timed:   execution-start marker at 20_000, result at 25_000 → 5_000 ms.
		// call-pending: no result at all → pending.
		const lines = [
			JSON.stringify({ type: "title", title: "Untimed Contract" }),
			JSON.stringify({ type: "session", id: "sess-u1", cwd: "/tmp", title: "Untimed" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				timestamp: "2026-02-01T10:00:00.000Z",
				message: {
					role: "assistant",
					timestamp: 10_000,
					content: [
						{ type: "toolCall", id: "call-untimed", name: "read", arguments: { path: "a" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				timestamp: "2026-02-01T10:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-untimed",
					timestamp: 10_000,
					content: [{ type: "text", text: "ok" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m3",
				timestamp: "2026-02-01T10:00:02.000Z",
				message: {
					role: "assistant",
					timestamp: 20_000,
					content: [{ type: "toolCall", id: "call-timed", name: "read", arguments: { path: "b" } }],
				},
			}),
			JSON.stringify({
				type: "custom",
				customType: "tool_execution_start",
				id: "m4",
				timestamp: "2026-02-01T10:00:02.000Z",
				data: { toolCallId: "call-timed", startedAt: 20_000 },
			}),
			JSON.stringify({
				type: "message",
				id: "m5",
				timestamp: "2026-02-01T10:00:07.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-timed",
					timestamp: 25_000,
					content: [{ type: "text", text: "ok" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m6",
				timestamp: "2026-02-01T10:00:08.000Z",
				message: {
					role: "assistant",
					timestamp: 30_000,
					content: [
						{ type: "toolCall", id: "call-pending", name: "edit", arguments: { path: "c" } },
					],
				},
			}),
		].join("\n");
		writeFileSync(join(sessionsDir, "proj", "untimed.jsonl"), lines + "\n");

		const cfg: StatsConfig = {
			configRoot: join(tmp, "config"),
			statsDbPath: join(tmp, "config", "stats.db"), // never created → db-less
			sessionsDir,
		};
		mkdirSync(cfg.configRoot, { recursive: true });
		app = createStatsApp(cfg);
	});

	afterAll(() => {
		app.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	const getStats = async (): Promise<StatsLike> => {
		const path = "/ctl/stats/sessions/proj/untimed.jsonl/stats";
		const res = await app.handleFetch(
			new Request(`http://localhost${path}`),
			new URL(`http://localhost${path}`),
		);
		expect(res!.status).toBe(200);
		return (await res!.json()) as StatsLike;
	};

	test("untimed call is counted but contributes no duration", async () => {
		const s = await getStats();
		expect(s.synced).toBe(false); // no stats.db → JSONL-only provenance
		const byName = new Map(s.tools.map((t) => [t.name, t]));

		const read = byName.get("read");
		expect(read).toBeDefined();
		expect(read!.calls).toBe(2); // untimed + timed both counted
		expect(read!.errors).toBe(0);
		expect(read!.pending).toBe(0); // both results linked
		expect(read!.totalMs).toBe(5_000); // only the timed call contributes
		expect(read!.avgMs).toBe(5_000);
		expect(read!.maxMs).toBe(5_000);

		const edit = byName.get("edit");
		expect(edit).toBeDefined();
		expect(edit!.calls).toBe(1);
		expect(edit!.pending).toBe(1); // no result → pending, not untimed
		expect(edit!.avgMs).toBeNull();
		expect(edit!.maxMs).toBeNull();
		expect(edit!.totalMs).toBe(0);

		expect(s.toolCalls).toBe(3);
		expect(s.longestCall).toEqual({
			toolName: "read",
			toolCallId: "call-timed",
			durationMs: 5_000,
			args: JSON.stringify({ path: "b" }),
		});
	});
});
