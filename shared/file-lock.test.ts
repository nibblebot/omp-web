import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireFileLock, LockHeldError } from "./file-lock";

function tmpLockPath(name: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "omp-file-lock-"));
	return path.join(dir, name);
}

/** A pid that is guaranteed not to be running (Linux pid_max is well below this). */
const DEAD_PID = 999_999_999;

function writeStaleLock(lockPath: string, pid: number): void {
	writeFileSync(lockPath, `${JSON.stringify({ pid, name: "ghost", startedAt: 0 })}\n`);
}

describe("acquireFileLock", () => {
	test("a second acquire on the same path throws LockHeldError with the holder pid", () => {
		const lockPath = tmpLockPath("held.lock");
		const first = acquireFileLock(lockPath, "test-holder");
		try {
			expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
			try {
				acquireFileLock(lockPath, "test-holder");
			} catch (err) {
				expect(err).toBeInstanceOf(LockHeldError);
				const held = err as LockHeldError;
				expect(held.lockPath).toBe(lockPath);
				expect(held.holderPid).toBe(process.pid);
				expect(held.holderName).toBe("test-holder");
			}
		} finally {
			first.release();
		}
	});

	test("release lets a re-acquire succeed", () => {
		const lockPath = tmpLockPath("reacquire.lock");
		const first = acquireFileLock(lockPath, "test-holder");
		first.release();
		const second = acquireFileLock(lockPath, "test-holder");
		second.release();
	});

	test("a stale lock from a dead pid is broken and re-acquired", () => {
		const lockPath = tmpLockPath("stale.lock");
		writeStaleLock(lockPath, DEAD_PID);
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			// Our pidfile replaced the stale one.
			const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
			expect(parsed.pid).toBe(process.pid);
		} finally {
			lock.release();
		}
	});

	test("the parent directory is created when missing", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-file-lock-"));
		const lockPath = path.join(dir, "nested", "deep", "parent.lock");
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
		} finally {
			lock.release();
		}
	});

	test("release after a crash-style stale file leaves a re-acquirable state", () => {
		const lockPath = tmpLockPath("crash.lock");
		// Simulate a holder that died without releasing: only the file remains.
		writeStaleLock(lockPath, DEAD_PID);
		mkdirSync(path.dirname(lockPath), { recursive: true });
		const broken = acquireFileLock(lockPath, "test-holder");
		broken.release();
		// Re-acquire now that the crashed holder's file is gone.
		const again = acquireFileLock(lockPath, "test-holder");
		again.release();
	});
});
