import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentTranscript } from "../subagent-mirror";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function transcript(lines: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "omp-worker-page-"));
	directories.push(directory);
	const path = join(directory, "worker.jsonl");
	await writeFile(path, lines.join("\n"));
	return path;
}

function message(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	});
}

describe("bounded worker transcript pages", () => {
	test("complete UTF-8 records retain IDs across pages and do not duplicate anchors", async () => {
		const lines = [
			message("first", "é".repeat(280)),
			message("second", "second"),
			message("third", "z".repeat(700)),
			"",
		];
		const path = await transcript(lines);
		const first = await readSubagentTranscript(path, 0, 1024);
		expect(first.hasMore).toBe(true);
		expect(first.entries.map((entry) => entry.id)).toEqual(["first", "second"]);
		const second = await readSubagentTranscript(path, first.nextByte, 1024);
		expect(second.entries.map((entry) => entry.id)).toEqual(["third"]);
		expect(second.hasMore).toBe(false);
		expect(first.messages[0]).toMatchObject({ content: [{ type: "text", text: "é".repeat(280) }] });
	});

	test("incomplete trailing record remains unread until its newline arrives", async () => {
		const firstLine = message("first", "complete");
		const tail = message("tail", "partial");
		const path = await transcript([firstLine, tail]);
		const first = await readSubagentTranscript(path);
		expect(first.entries.map((entry) => entry.id)).toEqual(["first"]);
		await writeFile(path, `${firstLine}\n${tail}\n`);
		const next = await readSubagentTranscript(path, first.nextByte);
		expect(next.entries.map((entry) => entry.id)).toEqual(["tail"]);
	});

	test("truncation resets the byte cursor rather than returning a false empty history", async () => {
		const path = await transcript([message("new", "replacement"), ""]);
		const page = await readSubagentTranscript(path, 100000);
		expect(page.reset).toBe(true);
		expect(page.fromByte).toBe(0);
		expect(page.entries.map((entry) => entry.id)).toEqual(["new"]);
	});

	test("missing history and an oversized record are explicit refusals", async () => {
		const path = await transcript([message("large", "x".repeat(2000)), ""]);
		await expect(readSubagentTranscript(path, 0, 1024)).rejects.toThrow("record exceeds page size");
		await expect(readSubagentTranscript(`${path}.missing`)).rejects.toThrow("artifact unavailable");
		await expect(readSubagentTranscript(path, 0, 0)).rejects.toThrow("page size");
	});
});
