/**
 * listDaemonSessions tests: newest-first ordering, friendly display names
 * (title → first message → timestamp), the size limit, and hermeticity —
 * the agent dir is injected through the module's optional seam so the tests
 * never depend on (or mutate) the process environment. The session dir is
 * computed with the SDK's own getDefaultSessionDir so the test never
 * reimplements the cwd encoding.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { listDaemonSessions } from "./daemon-sessions";

afterAll(cleanupTempDirs);

/** A fixed-256-byte title slot line, padding with spaces after the JSON. */
function titleLine(title: string): string {
	const json = JSON.stringify({ type: "title", title });
	if (json.length > 256) throw new Error("test title too long for the 256-byte slot");
	return json.padEnd(256, " ") + "\n";
}

const headerLine = (title?: string): string =>
	JSON.stringify({ type: "session", id: "s1", cwd: "/srv/proj", ...(title ? { title } : {}) }) +
	"\n";

const msgLine = (role: string, content: string): string =>
	JSON.stringify({ type: "message", message: { role, content } }) + "\n";

/** Session dir the SDK would use for `cwd` under `agentDir` (created). */
function sessionDirFor(agentDir: string, cwd: string): string {
	return SessionManager.getDefaultSessionDir(cwd, agentDir, new FileSessionStorage());
}

describe("listDaemonSessions", () => {
	test("returns sessions newest-first with friendly names, capped at the limit", async () => {
		const agentDir = tempDir("omp-session-list-agent-");
		const cwd = join(agentDir, "repo");
		const dir = sessionDirFor(agentDir, cwd);
		// 12 files with distinct mtimes; the two oldest fall outside the 10-cap.
		for (let i = 0; i < 12; i++) {
			const file = join(dir, `s${i}.jsonl`);
			writeFileSync(file, titleLine(`Task ${i}`) + headerLine(`Task ${i}`));
			const ts = 1_700_000_000_000 + i * 60_000;
			utimesSync(file, new Date(ts), new Date(ts));
		}

		const result = await listDaemonSessions(cwd, 10, agentDir);
		expect(result).toHaveLength(10);
		// Newest (highest mtime) first: Task 11 is the newest, then Task 10.
		expect(result[0]).toMatchObject({ name: "Task 11" });
		expect(result[1]).toMatchObject({ name: "Task 10" });
		// The ten newest are Tasks 2..11.
		expect(result.map((s) => s.name)).toEqual(
			Array.from({ length: 10 }, (_, i) => `Task ${11 - i}`),
		);
	});

	test("display names fall back to first message then to a timestamp", async () => {
		const agentDir = tempDir("omp-session-list-agent-");
		const cwd = join(agentDir, "repo2");
		const dir = sessionDirFor(agentDir, cwd);
		const untitled = join(dir, "untitled.jsonl");
		writeFileSync(untitled, headerLine() + msgLine("user", "fix the sidebar crash"));
		utimesSync(untitled, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, headerLine());
		utimesSync(empty, new Date(1_700_000_000_000 + 120_000), new Date(1_700_000_000_000 + 120_000));

		const result = await listDaemonSessions(cwd, 10, agentDir);
		// Timestamp rendering is locale/timezone dependent — assert the prefix.
		expect(result[0].name).toMatch(/^Untitled · /);
		expect(result[1].name).toBe("fix the sidebar crash");
		expect(result[1].messageCount).toBe(1);
	});

	test("missing session dirs degrade to an empty list, never throw", async () => {
		const agentDir = tempDir("omp-session-list-agent-missing-");
		const cwd = join(agentDir, "never-used");
		const result = await listDaemonSessions(cwd, 10, agentDir);
		expect(result).toEqual([]);
	});
});
