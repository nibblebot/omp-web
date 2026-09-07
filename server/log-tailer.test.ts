/**
 * SessionLogTailer regression (P3.9): a fleet log_gap control whose envelope
 * streamId NAMES the affected log stream must repair that stream — the
 * daemon's handleControl requires the target when the control does not ride
 * the reserved transport stream (fleet sends log_gap on the target stream;
 * a missing target used to gap-lock mid-file holes permanently).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLogTailer, type LogChunk } from "./log-tailer";
import type { CallbackSendResult } from "./fleet-callback";

function seedSessionFile(dir: string, sessionId: string): { abs: string; bytes: Buffer } {
	const content = Buffer.from(
		JSON.stringify({ id: sessionId }) + "\n" + "line two\n" + "line three\n",
		"utf8",
	);
	const abs = join(dir, `${sessionId}.jsonl`);
	writeFileSync(abs, content);
	return { abs, bytes: content };
}

describe("SessionLogTailer log_gap repair", () => {
	test("log_gap on the envelope-named stream re-streams [from, EOF) instead of failing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-tailer-gap-"));
		try {
			const sessionId = "sessGap";
			const { bytes } = seedSessionFile(dir, sessionId);

			// The send leg records every emitted chunk (streamId, offset, data).
			const sent: Array<{ streamId: string; payload: LogChunk }> = [];
			const send = (streamId: string, payload: LogChunk): CallbackSendResult => {
				sent.push({ streamId, payload });
				return "sent";
			};
			const tailer = new SessionLogTailer({ sessionsDir: dir, send });
			tailer.start();

			const streamId = sent[0]?.streamId ?? "";
			expect(streamId).toBe(`logs/${sessionId}/${sessionId}.jsonl`);
			expect(sent[0]?.payload.eof).toBe(false);
			expect(sent[0]?.payload.data.length).toBeGreaterThan(0);
			// The whole file streams on start; acknowledge the first 8 bytes so
			// a later gap repair replays only [8, EOF).
			tailer.applyAck(streamId, 8);
			const sentAfterAck = sent.length;

			// A mid-file hole: the fleet observed a gap and sends log_gap with
			// the envelope streamId naming the target (the fixed contract).
			tailer.handleControl(streamId, { type: "log_gap", from: 8, to: bytes.length });
			// handleControl must NOT record an invalid_request failure.
			const status = tailer.status();
			expect(status.lastError).toBeNull();

			// The repair re-streams [8, EOF): at least one fresh chunk whose
			// offset is 8 (or a later continuation) — bytes already acked are
			// never re-sent.
			const replayed = sent.slice(sentAfterAck);
			expect(replayed.length).toBeGreaterThan(0);
			expect(replayed.some((c) => c.payload.offset >= 8)).toBe(true);
			expect(replayed.every((c) => c.payload.offset >= 8)).toBe(true);

			tailer.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
