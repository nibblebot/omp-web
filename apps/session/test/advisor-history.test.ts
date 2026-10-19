import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { readAdvisorHistory } from "../advisor-history";
import type { SessionEntry } from "../session-entry";

afterEach(() => cleanupTempDirs());

const HEADER = `${JSON.stringify({ type: "session", id: "adv-1" })}\n`;
const record = (content: string) =>
	`${JSON.stringify({ type: "message", message: { role: "user", content } })}\n`;

async function durableEntry(): Promise<{ transcript: string; entry: SessionEntry }> {
	const dir = tempDir("omp-advisor-history-");
	const sessionFile = join(dir, "sess-1.jsonl");
	const root = join(dir, "sess-1");
	await mkdir(root);
	const transcript = join(root, "__advisor.jsonl");
	await writeFile(transcript, HEADER + record("What about the cache?") + record("Second question"));
	const entry = {
		session: {
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "sess-1" },
			getAdvisorAgent: () => undefined,
		},
	} as unknown as SessionEntry;
	return { transcript, entry };
}

describe("readAdvisorHistory durable paging", () => {
	test("pages reassemble the full transcript and reuse one render until the advisor file changes", async () => {
		const { transcript, entry } = await durableEntry();
		const full = await readAdvisorHistory(entry, { compact: true, maxBytes: 1 << 20 });
		expect(full.available).toBe(true);
		expect(full.source).toBe("durable");
		expect(full.text).toContain("What about the cache?");

		let page = await readAdvisorHistory(entry, { compact: true, maxBytes: 64 });
		let collected = page.text ?? "";
		while (page.hasMore) {
			page = await readAdvisorHistory(entry, {
				compact: true,
				maxBytes: 64,
				fromByte: page.nextByte,
				sourceId: page.sourceId,
			});
			collected += page.text ?? "";
		}
		expect(collected.length).toBeGreaterThan(0);
		expect(collected).toBe(full.text ?? "");
		expect(page.sourceId).toBe(full.sourceId);

		// A same-size rewrite that keeps the original mtime and inode hits the
		// cached render: the fingerprint (name, size, mtime, inode) is unchanged.
		const before = await stat(transcript);
		await writeFile(
			transcript,
			HEADER + record("What about the cachx?") + record("Second question"),
		);
		await utimes(transcript, before.atimeMs / 1000, before.mtimeMs / 1000);
		const reused = await readAdvisorHistory(entry, { compact: true, maxBytes: 1 << 20 });
		expect(reused.text).toBe(full.text);
		expect(reused.sourceId).toBe(full.sourceId);

		// Appending changes the size, so the render and sourceId are rebuilt and
		// a cursor from the old identity is refused.
		await appendFile(transcript, record("Appended after paging"));
		const grown = await readAdvisorHistory(entry, { compact: true, maxBytes: 1 << 20 });
		expect(grown.text).toContain("Appended after paging");
		expect(grown.sourceId).not.toBe(full.sourceId);
		const stale = await readAdvisorHistory(entry, {
			compact: true,
			maxBytes: 64,
			sourceId: full.sourceId,
		});
		expect(stale.available).toBe(false);
		expect(stale.reason).toBe("advisor history changed; restart paging");
	});
});
