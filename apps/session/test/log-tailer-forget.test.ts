/**
 * SessionLogTailer.forgetSession (acknowledged purge fence): a deleted session
 * stops tracking with no eof marker, its restore entries are dropped, and other
 * sessions keep streaming.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { CallbackSendResult } from "../fleet-callback";
import { type LogChunk, SessionLogTailer } from "../log-tailer";

afterAll(cleanupTempDirs);

function seed(dir: string, sessionId: string): void {
	writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ id: sessionId })}\nbody\n`);
}

describe("SessionLogTailer.forgetSession", () => {
	test("drops the session's streams without an eof and leaves other sessions tracked", () => {
		const dir = tempDir("omp-tailer-forget-");
		seed(dir, "sessA");
		seed(dir, "sessB");
		const sent: Array<{ streamId: string; payload: LogChunk }> = [];
		const send = (streamId: string, payload: LogChunk): CallbackSendResult => {
			sent.push({ streamId, payload });
			return "sent";
		};
		const tailer = new SessionLogTailer({ sessionsDir: dir, send });
		tailer.start();
		expect(
			tailer
				.status()
				.sessions.map((s) => s.sessionId)
				.sort(),
		).toEqual(["sessA", "sessB"]);

		const mark = sent.length;
		tailer.forgetSession("sessA");

		expect(tailer.status().sessions.map((s) => s.sessionId)).toEqual(["sessB"]);
		expect(sent.slice(mark).filter((c) => c.streamId.startsWith("logs/sessA/"))).toEqual([]);
		tailer.stop();
	});

	test("prunes the restore map entries of the forgotten session only", () => {
		const dir = tempDir("omp-tailer-forget-restore-");
		seed(dir, "sessC");
		seed(dir, "sessD");
		const restore = new Map([
			["logs/sessC/sessC.jsonl", { offset: 4, generation: 1 }],
			["logs/sessD/sessD.jsonl", { offset: 4, generation: 1 }],
		]);
		const tailer = new SessionLogTailer({ sessionsDir: dir, send: () => "sent", restore });

		tailer.forgetSession("sessC");

		expect([...restore.keys()]).toEqual(["logs/sessD/sessD.jsonl"]);
	});
});
