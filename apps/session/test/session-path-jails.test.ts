/**
 * Path-jail unit tests for the two adapters that hand a caller-supplied path to
 * the SDK: resume-adapter's resume resolver (realpath jail to the
 * session dir, then membership against KNOWN session journals — recoverable
 * files are never invented) and lifecycle-adapter's durable deletion
 * (`canonical !== path`: a journal symlinked out of the owned sessions root is
 * refused before any SDK call). Real filesystem fixtures; the wire behavior is
 * covered by the session suite.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	createLifecycleMethods,
	type LifecycleDeps,
	validateSessionJournal,
} from "../lifecycle-adapter";
import { resolveResumeTarget } from "../resume-adapter";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

/** A genuinely listable session journal (header + one user turn). */
function sessionJournal(dir: string, fileName: string, id: string): string {
	const file = join(dir, fileName);
	const now = new Date().toISOString();
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: now })}\n` +
			`${JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: [{ type: "text", text: "jail fixture" }] },
			})}\n`,
	);
	return file;
}

/** Resume query scoped to one throwaway session + agent dir. */
function resumeQuery(sessionsDir: string, agentDir: string) {
	return { cwd: sessionsDir, sessionDir: sessionsDir, agentDir };
}

describe("resume-adapter path jails", () => {
	test("a resume path outside the session directory is refused", async () => {
		const sessionsDir = tempDir("omp-jail-resume-");
		const outsideDir = tempDir("omp-jail-resume-out-");
		const agentDir = tempDir("omp-jail-resume-agent-");
		// A real, listable journal: the refusal is about location, not content.
		const outside = sessionJournal(outsideDir, "outside.jsonl", crypto.randomUUID());

		const result = await resolveResumeTarget(outside, resumeQuery(sessionsDir, agentDir));
		if (result.kind !== "refused") throw new Error(`expected refused, got ${result.kind}`);
		expect(result.reason).toBe("unauthorized-path");
		expect(result.message).toContain("session directory");
	});

	test("an unknown journal inside the session directory is missing, never invented", async () => {
		const sessionsDir = tempDir("omp-jail-unknown-");
		const agentDir = tempDir("omp-jail-unknown-agent-");
		const known = sessionJournal(sessionsDir, "known.jsonl", crypto.randomUUID());
		writeFileSync(join(sessionsDir, "ghost.jsonl"), "not a session journal\n");
		const query = resumeQuery(sessionsDir, agentDir);

		const ghost = await resolveResumeTarget(join(sessionsDir, "ghost.jsonl"), query);
		expect(ghost).toEqual({ kind: "missing", scopeChecked: "local", searched: 1 });

		// Control: the same directory resolves its real journal, so the miss
		// above is membership, not a broken listing fixture.
		const real = await resolveResumeTarget(known, query);
		if (real.kind !== "unique") throw new Error(`expected unique, got ${real.kind}`);
		expect(real.session.sessionFile).toBe(known);
	});

	test("a resume symlink resolving outside the session directory is refused", async () => {
		const sessionsDir = tempDir("omp-jail-link-");
		const outsideDir = tempDir("omp-jail-link-out-");
		const agentDir = tempDir("omp-jail-link-agent-");
		const outside = sessionJournal(outsideDir, "outside.jsonl", crypto.randomUUID());
		const linked = join(sessionsDir, "linked.jsonl");
		symlinkSync(outside, linked);

		const result = await resolveResumeTarget(linked, resumeQuery(sessionsDir, agentDir));
		if (result.kind !== "refused") throw new Error(`expected refused, got ${result.kind}`);
		expect(result.reason).toBe("unauthorized-path");
	});
});

/** Deletion entry double covering only what stop()/deletionTarget() touch. */
function deletionEntry(sessionFile: string, sessionId: string) {
	let flushes = 0;
	return {
		entry: {
			session: {
				sessionFile,
				sessionId,
				abort: async () => {},
				waitForIdle: async () => {},
				isBashRunning: false,
				isEvalRunning: false,
				isCompacting: false,
				sessionManager: {
					flush: async () => {
						flushes++;
					},
				},
			},
		} as unknown as SessionEntry,
		flushes: () => flushes,
	};
}

/** Unpaired, mirror-less lifecycle deps: the deletion path stops at the jail. */
function lifecycleMethods(sessionsDir: string) {
	const deps: LifecycleDeps = {
		sessionsDir,
		hasCallbackPair: () => false,
		assertWritable: async () => {},
		settleHostWork: async () => {},
		settleWorkers: async () => {},
		broadcastAvailableCommands: async () => {},
	};
	return createLifecycleMethods(deps);
}

describe("lifecycle-adapter deletion jails", () => {
	test("a session journal symlinked outside sessionsDir is refused", async () => {
		const sessionsDir = tempDir("omp-jail-lifecycle-");
		const outsideDir = tempDir("omp-jail-lifecycle-out-");
		const outside = sessionJournal(outsideDir, "elsewhere.jsonl", crypto.randomUUID());
		const linked = join(sessionsDir, "linked.jsonl");
		symlinkSync(outside, linked);
		const { entry, flushes } = deletionEntry(linked, crypto.randomUUID());

		await expect(lifecycleMethods(sessionsDir).deleteSession(entry, [])).rejects.toThrow(
			/refuses a journal outside the owned sessions root/,
		);
		// The refusal is deletionTarget's jail, reached after the outgoing
		// writer was flushed — not an earlier lifecycle gate.
		expect(flushes()).toBe(1);
	});

	test("a regular in-jail journal passes the symlink gate and fails on identity", async () => {
		const sessionsDir = tempDir("omp-jail-identity-");
		const plain = join(sessionsDir, "plain.jsonl");
		writeFileSync(plain, "not a session journal\n");
		const { entry } = deletionEntry(plain, crypto.randomUUID());

		await expect(lifecycleMethods(sessionsDir).deleteSession(entry, [])).rejects.toThrow(
			/journal identity does not match/,
		);
	});
});

describe("validateSessionJournal header prefix", () => {
	test("a header after a non-session line still validates when the tail is huge and malformed", async () => {
		const root = tempDir("omp-jail-header-tail-");
		const id = crypto.randomUUID();
		const file = join(root, `${id}.jsonl`);
		const message = JSON.stringify({ type: "message", id: "m0" });
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: root,
			timestamp: new Date().toISOString(),
		});
		writeFileSync(file, `${message}\n${header}\nnot json ${"x".repeat(2 * 1024 * 1024)}\n`);

		expect(await validateSessionJournal(root, file, id)).toEqual({
			sessionId: id,
			sessionFile: file,
		});
	});

	test("a journal without a session header fails identity", async () => {
		const root = tempDir("omp-jail-header-bad-");
		const file = join(root, "bad.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "message", id: "m0" })}\n`);

		await expect(validateSessionJournal(root, file)).rejects.toThrow(
			/journal identity does not match/,
		);
	});

	test("a session header past the 16 KiB prefix is not searched for", async () => {
		const root = tempDir("omp-jail-header-far-");
		const id = crypto.randomUUID();
		const file = join(root, `${id}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: root,
			timestamp: new Date().toISOString(),
		});
		writeFileSync(file, `${"x".repeat(20 * 1024)}\n${header}\n`);

		await expect(validateSessionJournal(root, file, id)).rejects.toThrow(
			/journal identity does not match/,
		);
	});
});
