/**
 * readSessionTitle tests: title-slot extraction, header fallback, untitled
 * and missing files, the (path, mtimeMs, size) cache, and head-bounded reads
 * on gigantic files. Uses only real files in tempDir() — no fixtures.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { readSessionInfo, readSessionTitle } from "./session-title";

afterAll(cleanupTempDirs);

/** A fixed-256-byte title slot line, padding with spaces after the JSON. */
function titleLine(title: string): string {
	const json = JSON.stringify({ type: "title", title });
	if (json.length > 256) throw new Error("test title too long for the 256-byte slot");
	return json.padEnd(256, " ") + "\n";
}

const headerLine = (title?: string): string =>
	JSON.stringify({ type: "session", id: "s1", cwd: "/tmp/proj", ...(title ? { title } : {}) }) +
	"\n";

describe("readSessionTitle", () => {
	test("title comes from the 256-byte title slot when present", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "a.jsonl");
		writeFileSync(path, titleLine("Slot wins") + headerLine("Header loses"));

		await expect(readSessionTitle(path)).resolves.toBe("Slot wins");
	});

	test("falls back to the session-header title when the file has no title slot", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "old.jsonl");
		// Older files: the session header is line 0.
		writeFileSync(path, headerLine("Header title"));

		await expect(readSessionTitle(path)).resolves.toBe("Header title");
	});

	test("untitled files resolve to undefined", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "untitled.jsonl");
		// Title slot without a title; header without a title either.
		writeFileSync(path, titleLine("") + headerLine());

		await expect(readSessionTitle(path)).resolves.toBeUndefined();
	});

	test("missing files resolve to undefined (never cached, so reappearing files re-read)", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "gone.jsonl");

		await expect(readSessionTitle(path)).resolves.toBeUndefined();
		writeFileSync(path, titleLine("Back"));
		await expect(readSessionTitle(path)).resolves.toBe("Back");
		unlinkSync(path);
		await expect(readSessionTitle(path)).resolves.toBeUndefined();
	});

	test("cache: same (path, mtime, size) serves the old title without re-reading; a new mtime invalidates", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "cached.jsonl");
		const first = titleLine("First") + headerLine();
		const second = titleLine("Second") + headerLine(); // same byte length
		writeFileSync(path, first);

		await expect(readSessionTitle(path)).resolves.toBe("First");

		// Overwrite with DIFFERENT content of the same size, then restore the
		// original mtime exactly (float seconds keep stat's sub-ms mtimeMs).
		const original = statSync(path);
		writeFileSync(path, second);
		utimesSync(path, original.atimeMs / 1000, original.mtimeMs / 1000);
		expect(statSync(path).mtimeMs).toBe(original.mtimeMs);

		// Same (path, mtimeMs, size) key → the cached first read is served,
		// proving unchanged files are never re-parsed on the poll loop.
		await expect(readSessionTitle(path)).resolves.toBe("First");

		// A real modification bumps the mtime: the stale entry is bypassed
		// and the new title is read from disk.
		writeFileSync(path, second);
		await expect(readSessionTitle(path)).resolves.toBe("Second");
	});

	test("head-bounded: a huge file with a 5MB third line still yields the head title", async () => {
		const dir = tempDir("omp-session-title-");
		const path = join(dir, "huge.jsonl");
		// 5MB of invalid JSON on line 3 — a whole-file parser would pull the
		// whole transcript; the reader must only touch the head chunk.
		writeFileSync(path, titleLine("Huge") + headerLine() + "x".repeat(5 * 1024 * 1024) + "\n");

		await expect(readSessionTitle(path)).resolves.toBe("Huge");
	}, 5000);
});

describe("readSessionInfo", () => {
	const msgLine = (): string =>
		JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n";

	test("missing files are empty with no title (never cached)", async () => {
		const dir = tempDir("omp-session-info-");
		const path = join(dir, "gone.jsonl");

		await expect(readSessionInfo(path)).resolves.toEqual({ title: undefined, empty: true });
		writeFileSync(path, titleLine("Back"));
		await expect(readSessionInfo(path)).resolves.toEqual({ title: "Back", empty: true });
	});

	test("untitled header-only files are empty (new session)", async () => {
		const dir = tempDir("omp-session-info-");
		const path = join(dir, "empty.jsonl");
		writeFileSync(path, titleLine("") + headerLine());

		await expect(readSessionInfo(path)).resolves.toEqual({ title: undefined, empty: true });
	});

	test("untitled files with a message are NOT empty", async () => {
		const dir = tempDir("omp-session-info-");
		const path = join(dir, "real.jsonl");
		writeFileSync(path, titleLine("") + headerLine() + msgLine());

		await expect(readSessionInfo(path)).resolves.toEqual({ title: undefined, empty: false });
	});

	test("titled files report their file truth for emptiness independently", async () => {
		const dir = tempDir("omp-session-info-");
		const emptyPath = join(dir, "titled-empty.jsonl");
		writeFileSync(emptyPath, titleLine("Slow start") + headerLine());
		await expect(readSessionInfo(emptyPath)).resolves.toEqual({
			title: "Slow start",
			empty: true,
		});

		const realPath = join(dir, "titled-real.jsonl");
		writeFileSync(realPath, titleLine("Done") + headerLine() + msgLine());
		await expect(readSessionInfo(realPath)).resolves.toEqual({ title: "Done", empty: false });
	});

	test("a large file with no marker in the head is never labeled empty", async () => {
		const dir = tempDir("omp-session-info-");
		const path = join(dir, "big.jsonl");
		// Messages only far past the 8KiB head (e.g. a giant first message
		// that starts beyond the head window) → safe default: NOT empty.
		writeFileSync(path, titleLine("") + headerLine() + "y".repeat(10 * 1024 * 1024) + "\n");

		await expect(readSessionInfo(path)).resolves.toEqual({ title: undefined, empty: false });
	}, 5000);
});
