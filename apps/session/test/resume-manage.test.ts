/**
 * Resume-picker rename/delete (resume-manage.ts). Real filesystem fixtures
 * under a temp sessions root; the lease is process-local on Linux, so holding
 * it in-test exercises the "owned by another writer" refusal. Wire behavior is
 * covered by the daemon suite.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	FileSessionStorage,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { LifecycleMirror } from "../lifecycle-adapter";
import {
	deleteResumeSession,
	normalizeResumeTitle,
	renameResumeSession,
	ResumeInputError,
} from "../resume-manage";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

/** A listable session journal (header + one user turn) under a project subdir. */
function journal(root: string, id: string): string {
	const dir = join(root, "project");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.jsonl`);
	const now = new Date().toISOString();
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: now })}\n` +
			`${JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: [{ type: "text", text: "picker fixture" }] },
			})}\n`,
	);
	return file;
}

/** Mirror stub recording call order; `purgeError` makes the purge step fail. */
function recordingMirror(
	calls: string[],
	options: { purgeError?: string; writableError?: string } = {},
): LifecycleMirror {
	return {
		assertWritable: async (sessionId) => {
			calls.push(`assertWritable:${sessionId}`);
			if (options.writableError) throw new Error(options.writableError);
		},
		purge: async (sessionId) => {
			calls.push(`purge:${sessionId}`);
			if (options.purgeError) throw new Error(options.purgeError);
		},
	};
}

describe("resume-manage delete", () => {
	test("removes the journal, its artifact dir, unpins, and fences then purges the fleet copy", async () => {
		const root = tempDir("omp-manage-delete-");
		const id = crypto.randomUUID();
		const file = journal(root, id);
		const artifacts = file.slice(0, -".jsonl".length);
		mkdirSync(artifacts);
		writeFileSync(join(artifacts, "artifact.txt"), "x");
		const calls: string[] = [];
		const unpinned: string[] = [];

		const result = await deleteResumeSession(
			{ sessionFile: file, sessionId: id },
			{
				sessionsRoot: root,
				mirror: recordingMirror(calls),
				unpin: async (sessionId) => {
					unpinned.push(sessionId);
				},
			},
		);

		expect(result).toEqual({ deleted: true, sessionId: id });
		expect(existsSync(file)).toBe(false);
		expect(existsSync(artifacts)).toBe(false);
		expect(unpinned).toEqual([id]);
		expect(calls).toEqual([`assertWritable:${id}`, `purge:${id}`]);
	});

	test("a journal outside the owned sessions root is refused and kept", async () => {
		const root = tempDir("omp-manage-outside-");
		const id = crypto.randomUUID();
		const outside = journal(tempDir("omp-manage-outside-src-"), id);

		await expect(
			deleteResumeSession(
				{ sessionFile: outside, sessionId: id },
				{ sessionsRoot: root, unpin: async () => {} },
			),
		).rejects.toThrow(/refuses a journal outside the owned sessions root/);
		expect(existsSync(outside)).toBe(true);
	});

	test("a header id that does not match the confirmed id is refused and kept", async () => {
		const root = tempDir("omp-manage-mismatch-");
		const file = journal(root, crypto.randomUUID());
		const confirmed = crypto.randomUUID();

		await expect(
			deleteResumeSession(
				{ sessionFile: file, sessionId: confirmed },
				{ sessionsRoot: root, unpin: async () => {} },
			),
		).rejects.toThrow(/journal identity does not match/);
		expect(existsSync(file)).toBe(true);
	});

	test("a symlink to a journal inside the root is refused and the target is kept", async () => {
		const root = tempDir("omp-manage-symlink-");
		const id = crypto.randomUUID();
		const file = journal(root, id);
		const link = join(root, "linked.jsonl");
		symlinkSync(file, link);

		await expect(
			deleteResumeSession(
				{ sessionFile: link, sessionId: id },
				{ sessionsRoot: root, unpin: async () => {} },
			),
		).rejects.toThrow();
		expect(existsSync(file)).toBe(true);
	});

	test("a session held by another writer is refused before any file is touched", async () => {
		const root = tempDir("omp-manage-lease-");
		const id = crypto.randomUUID();
		const file = journal(root, id);
		const held = tryAcquireSessionLease(id);
		expect(held).not.toBeNull();
		try {
			await expect(
				deleteResumeSession(
					{ sessionFile: file, sessionId: id },
					{ sessionsRoot: root, unpin: async () => {} },
				),
			).rejects.toThrow(/owned by another writer/);
			expect(existsSync(file)).toBe(true);
		} finally {
			held?.release();
		}
	});

	test("the attached session is refused with the /delete pointer", async () => {
		const root = tempDir("omp-manage-attached-");
		const id = crypto.randomUUID();
		const file = journal(root, id);
		const attached = { session: { sessionId: id } } as unknown as SessionEntry;

		await expect(
			deleteResumeSession(
				{ sessionFile: file, sessionId: id },
				{ sessionsRoot: root, attached, unpin: async () => {} },
			),
		).rejects.toThrow("Use /delete to delete the attached session");
		expect(existsSync(file)).toBe(true);
	});

	test("a failed fleet writability check keeps the local journal", async () => {
		const root = tempDir("omp-manage-notready-");
		const id = crypto.randomUUID();
		const file = journal(root, id);
		const calls: string[] = [];

		await expect(
			deleteResumeSession(
				{ sessionFile: file, sessionId: id },
				{
					sessionsRoot: root,
					mirror: recordingMirror(calls, { writableError: "fleet callback is not ready" }),
					unpin: async () => {},
				},
			),
		).rejects.toThrow("fleet callback is not ready");
		expect(existsSync(file)).toBe(true);
		expect(calls).toEqual([`assertWritable:${id}`]);
	});

	test("a failed fleet purge after the local delete reports the local deletion", async () => {
		const root = tempDir("omp-manage-purge-fail-");
		const id = crypto.randomUUID();
		const file = journal(root, id);

		await expect(
			deleteResumeSession(
				{ sessionFile: file, sessionId: id },
				{
					sessionsRoot: root,
					mirror: recordingMirror([], { purgeError: "notice rejected" }),
					unpin: async () => {},
				},
			),
		).rejects.toThrow(/deleted locally, but fleet cleanup failed: notice rejected/);
		expect(existsSync(file)).toBe(false);
	});
});

describe("resume-manage rename", () => {
	test("persists the trimmed title into the session listing", async () => {
		const root = tempDir("omp-manage-rename-");
		const id = crypto.randomUUID();
		const file = journal(root, id);

		const result = await renameResumeSession(
			{ sessionFile: file, title: "  Picker title  " },
			{ sessionsRoot: root, unpin: async () => {} },
		);

		expect(result).toEqual({ renamed: true, sessionId: id, title: "Picker title" });
		const listed = (await listAllSessions(new FileSessionStorage(), root)).find((s) => s.id === id);
		expect(listed?.title).toBe("Picker title");
	});

	test("a journal outside the one-level project layout is refused and kept", async () => {
		const root = tempDir("omp-manage-layout-");
		const id = crypto.randomUUID();
		const nested = join(root, "project", "nested");
		mkdirSync(nested, { recursive: true });
		const file = join(nested, `${id}.jsonl`);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: nested, timestamp: new Date().toISOString() })}\n`,
		);
		const before = readFileSync(file, "utf8");

		await expect(
			renameResumeSession(
				{ sessionFile: file, title: "Nested" },
				{ sessionsRoot: root, unpin: async () => {} },
			),
		).rejects.toThrow(/not in the session listing/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});

describe("normalizeResumeTitle", () => {
	test("accepts a trimmed single line of 1 to 200 characters", () => {
		expect(normalizeResumeTitle("  ok  ")).toBe("ok");
		expect(normalizeResumeTitle("x".repeat(200))).toBe("x".repeat(200));
	});

	test("rejects empty, over-long, and multi-line titles as invalid_request", () => {
		for (const bad of ["   ", "x".repeat(201), "a\nb", "a\u0000b"]) {
			expect(() => normalizeResumeTitle(bad)).toThrow(ResumeInputError);
		}
		expect(new ResumeInputError("x").code).toBe("invalid_request");
	});
});
