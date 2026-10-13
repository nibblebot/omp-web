import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireFileLock, LockHeldError } from "#lib/platform/file-lock";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

function tmpLockPath(name: string): string {
	const dir = tempDir("omp-file-lock-");
	return path.join(dir, name);
}

/** A pid that is guaranteed not to be running (Linux pid_max is well below this). */
const DEAD_PID = 999_999_999;

function writeStaleLock(lockPath: string, pid: number): void {
	writeFileSync(lockPath, `${JSON.stringify({ pid, name: "ghost", startedAt: 0 })}\n`);
}

function readLockFile(lockPath: string): { pid: number; name: string } | null {
	try {
		return JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; name: string };
	} catch {
		return null;
	}
}

const POLL_TIMEOUT_MS = 10_000;

/** Poll `predicate` until it holds, then return; throw after the timeout. */
async function waitFor(predicate: () => boolean, describe: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${describe}`);
}

/** Source of the child that grabs `lockPath` and holds it until killed. */
function childHolderScript(lockPath: string): string {
	const lockModule = new URL("../file-lock.ts", import.meta.url).href;
	return [
		`import { acquireFileLock } from ${JSON.stringify(lockModule)};`,
		`acquireFileLock(${JSON.stringify(lockPath)}, "child-holder");`,
		// Block on stdin: the parent keeps the pipe open, so we stay alive
		// holding the lock until it kills us (no release, i.e. a crash).
		"await Bun.stdin.text();",
		"",
	].join("\n");
}

describe("acquireFileLock", () => {
	test("a second acquire on the same path throws LockHeldError with the holder pid", () => {
		const lockPath = tmpLockPath("held.lock");
		const first = acquireFileLock(lockPath, "test-holder");
		try {
			let thrown: unknown;
			try {
				acquireFileLock(lockPath, "test-holder");
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(LockHeldError);
			const held = thrown as LockHeldError;
			expect(held.lockPath).toBe(lockPath);
			expect(held.holderPid).toBe(process.pid);
			expect(held.holderName).toBe("test-holder");
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
			expect(readLockFile(lockPath)).toMatchObject({ pid: process.pid, name: "test-holder" });
		} finally {
			lock.release();
		}
	});

	test("the parent directory is created when missing", () => {
		const dir = tempDir("omp-file-lock-");
		const lockPath = path.join(dir, "nested", "deep", "parent.lock");
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			lock.release();
		}
		expect(existsSync(lockPath)).toBe(false);
	});

	test("release after a crash-style stale file leaves a re-acquirable state", () => {
		const lockPath = tmpLockPath("crash.lock");
		// A holder that died without releasing leaves only its file behind:
		// dead pid and an ancient startedAt.
		writeStaleLock(lockPath, DEAD_PID);
		expect(readLockFile(lockPath)).toMatchObject({ pid: DEAD_PID, name: "ghost" });

		const broken = acquireFileLock(lockPath, "test-holder");
		try {
			// The stale-break replaced the crashed holder's file with ours.
			expect(readLockFile(lockPath)).toMatchObject({ pid: process.pid, name: "test-holder" });
		} finally {
			broken.release();
		}
		expect(existsSync(lockPath)).toBe(false);

		// Re-acquire now that the crashed holder's file is gone.
		const again = acquireFileLock(lockPath, "test-holder");
		again.release();
	});

	test("a live child process holding the lock blocks acquire until it exits", async () => {
		const dir = tempDir("omp-file-lock-");
		const lockPath = path.join(dir, "child.lock");
		const scriptPath = path.join(dir, "hold-lock.ts");
		writeFileSync(scriptPath, childHolderScript(lockPath));

		const child = Bun.spawn([process.execPath, scriptPath], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "inherit",
		});
		try {
			await waitFor(() => {
				if (child.exitCode !== null) {
					throw new Error(`child exited early with code ${child.exitCode}`);
				}
				// The child's pid is visible once its pidfile write completed.
				return readLockFile(lockPath)?.pid === child.pid;
			}, `child process ${child.pid} to take the lock`);

			// The holder is alive: our acquire must report its identity.
			let thrown: unknown;
			try {
				acquireFileLock(lockPath, "parent-holder");
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(LockHeldError);
			expect((thrown as LockHeldError).holderPid).toBe(child.pid);
		} finally {
			child.kill();
			await child.exited;
		}

		// The child died holding the lock: its stale file is broken and the
		// pendingslot is ours again.
		const lock = acquireFileLock(lockPath, "parent-holder");
		try {
			expect(readLockFile(lockPath)).toMatchObject({ pid: process.pid, name: "parent-holder" });
		} finally {
			lock.release();
		}
		expect(existsSync(lockPath)).toBe(false);
	});

	test("release does not remove a lock broken as stale and re-acquired by another holder", () => {
		const lockPath = tmpLockPath("break-release.lock");
		const a = acquireFileLock(lockPath, "holder-a");

		// Another process sees A's file naming a dead pid (crash leftovers) and
		// breaks it as stale; B's acquire unlinks it and creates its own.
		writeStaleLock(lockPath, DEAD_PID);
		const b = acquireFileLock(lockPath, "holder-b");
		try {
			a.release();
			// A's release must not unlink B's live lock.
			expect(readLockFile(lockPath)).toMatchObject({ pid: process.pid, name: "holder-b" });
			expect(() => acquireFileLock(lockPath, "holder-c")).toThrow(LockHeldError);
		} finally {
			b.release();
		}
		expect(existsSync(lockPath)).toBe(false);
	});
});
