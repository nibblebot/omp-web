import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLock, LockHeldError, type LockFileContents } from "./file-lock";
import { cleanupTempDirs, tempDir } from "./testkit";

afterAll(cleanupTempDirs);

function tmpLockPath(name: string): string {
	const dir = tempDir("omp-file-lock-");
	return path.join(dir, name);
}

/** A pid that is guaranteed not to be running (Linux pid_max is well below this). */
const DEAD_PID = 999_999_999;

/** Our own /proc start time, for asserting the on-disk identity. */
function selfStartTime(): number {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const tail = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
	return Number(tail[19]);
}

const LOCK_MODULE_URL = pathToFileURL(path.join(import.meta.dir, "file-lock.ts")).href;

/** A full owner record left behind by a crashed holder. */
function staleLockRecord(pid: number): LockFileContents {
	return { pid, procStartTime: 0, name: "ghost", token: "0".repeat(32) };
}

function writeStaleLock(lockPath: string, pid: number): void {
	writeFileSync(lockPath, `${JSON.stringify(staleLockRecord(pid))}\n`);
}

/** Throwaway child script that imports the lock module and runs `body`. */
function writeLockChildScript(name: string, lockPath: string, body: string): string {
	const file = path.join(tempDir("omp-file-lock-child-"), `${name}.ts`);
	writeFileSync(
		file,
		[
			`import { acquireFileLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
			`const lockPath = ${JSON.stringify(lockPath)};`,
			body,
			"",
		].join("\n"),
	);
	return file;
}

/** The pidfile's owner token, validated rather than asserted. */
function readLockToken(lockPath: string): string {
	const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"token" in parsed &&
		typeof parsed.token === "string"
	) {
		return parsed.token;
	}
	throw new Error(`${lockPath} carries no owner token`);
}

/** Incremental stdout reader; each call resolves the next line. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async () => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				return line;
			}
			const { done, value } = await reader.read();
			if (done) return buffer.trim();
			buffer += decoder.decode(value, { stream: true });
		}
	};
}

describe("acquireFileLock", () => {
	test("a second acquire on the same path throws LockHeldError with the holder pid", () => {
		const lockPath = tmpLockPath("held.lock");
		const first = acquireFileLock(lockPath, "test-holder");
		try {
			const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(onDisk.pid).toBe(process.pid);
			expect(onDisk.procStartTime).toBe(selfStartTime());
			expect(onDisk.name).toBe("test-holder");
			expect(onDisk.token).toMatch(/^[0-9a-f]{32}$/);
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
		expect(existsSync(lockPath)).toBe(false);
	});

	test("a stale lock from a dead pid is broken and re-acquired", () => {
		const lockPath = tmpLockPath("stale.lock");
		writeStaleLock(lockPath, DEAD_PID);
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			// Our pidfile replaced the stale one.
			const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(parsed.pid).toBe(process.pid);
			expect(parsed.token).not.toBe(staleLockRecord(DEAD_PID).token);
		} finally {
			lock.release();
		}
	});

	test("a live pid whose start time changed (pid reuse) is broken", () => {
		const lockPath = tmpLockPath("reuse.lock");
		const reused: LockFileContents = {
			pid: process.pid,
			procStartTime: selfStartTime() + 1,
			name: "reused",
			token: "a".repeat(32),
		};
		writeFileSync(lockPath, `${JSON.stringify(reused)}\n`);
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(parsed.token).not.toBe(reused.token);
		} finally {
			lock.release();
		}
	});

	test("a holder that dies while holding is broken and re-acquired", () => {
		const lockPath = tmpLockPath("died.lock");
		const holderScript = writeLockChildScript(
			"died",
			lockPath,
			[
				`acquireFileLock(lockPath, "child");`,
				`process.exit(3); // Die while holding: no release, only the file remains.`,
			].join("\n"),
		);
		const child = spawnSync(process.execPath, [holderScript], { encoding: "utf8" });
		expect(child.status).toBe(3);
		// Death released the child's advisory guard. If it had not, the acquire
		// below would block on a guard no live process holds.
		expect(existsSync(`${lockPath}.guard`)).toBe(true);
		const leftover = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
		expect(leftover.pid).not.toBe(process.pid);
		expect(typeof leftover.token).toBe("string");
		// The dead holder's identity is stale, so the next acquire breaks it.
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(parsed.pid).toBe(process.pid);
			expect(parsed.name).toBe("test-holder");
		} finally {
			lock.release();
		}
	});

	test("three concurrent stale recoveries yield exactly one live owner", async () => {
		const lockPath = tmpLockPath("race.lock");
		// One valid dead owner for all three contenders to judge stale; the
		// guard then serializes them, so the winner's record is installed before
		// either loser reads the pidfile.
		writeStaleLock(lockPath, DEAD_PID);
		const script = writeLockChildScript(
			"race",
			lockPath,
			[
				`const stdin = Bun.stdin.stream().getReader();`,
				`console.log("READY");`,
				`await stdin.read(); // Barrier: the parent releases all contenders at once.`,
				`let lock;`,
				`try {`,
				`	lock = acquireFileLock(lockPath, "child");`,
				`} catch (err) {`,
				`	console.log(err instanceof Error && err.name === "LockHeldError" ? "HELD" : "ERROR " + String(err));`,
				`	await stdin.read(); // Park until the parent reaps us.`,
				`	process.exit(0);`,
				`}`,
				`const onDisk = JSON.parse(await Bun.file(lockPath).text());`,
				`console.log("ACQUIRED " + onDisk.token);`,
				`await stdin.read(); // Hold the lock until the parent asks for the release.`,
				`lock.release();`,
				`console.log("RELEASED");`,
			].join("\n"),
		);
		const children = [0, 1, 2].map(() =>
			Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		);
		try {
			const readers = children.map((child) => lineReader(child.stdout));
			const ready = await Promise.all(readers.map((next) => next()));
			expect(ready).toEqual(["READY", "READY", "READY"]);
			for (const child of children) {
				child.stdin.write("go\n");
				child.stdin.flush();
			}
			const outcomes = await Promise.all(readers.map((next) => next()));
			const winnerIndex = outcomes.findIndex((line) => line.startsWith("ACQUIRED "));
			expect(outcomes.filter((line) => line.startsWith("ACQUIRED "))).toHaveLength(1);
			expect(outcomes.filter((line) => line === "HELD")).toHaveLength(2);
			const winnerToken = outcomes[winnerIndex]!.slice("ACQUIRED ".length);
			expect(readLockToken(lockPath)).toBe(winnerToken);
			// The losers die without ever owning the record, and the survivor's
			// record is untouched by their exit.
			for (const [index, child] of children.entries()) {
				if (index === winnerIndex) continue;
				child.kill("SIGKILL");
				await child.exited;
			}
			expect(readLockToken(lockPath)).toBe(winnerToken);
			// Only the winner's release frees the path for a fourth contender.
			children[winnerIndex]!.stdin.write("release\n");
			children[winnerIndex]!.stdin.flush();
			expect(await readers[winnerIndex]!()).toBe("RELEASED");
			expect(existsSync(lockPath)).toBe(false);
			const fourth = acquireFileLock(lockPath, "fourth");
			fourth.release();
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
		}
	});

	test("release after a replacement owner took the lock preserves its file", () => {
		const lockPath = tmpLockPath("replaced.lock");
		const first = acquireFileLock(lockPath, "first");
		// A stale-breaker removed our record and installed its own (a different
		// inode, created by a second acquire), which first.release must preserve.
		unlinkSync(lockPath);
		const second = acquireFileLock(lockPath, "second");
		const replacement = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
		try {
			first.release();
			const afterRelease = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(afterRelease).toEqual(replacement);
			expect(() => acquireFileLock(lockPath, "third")).toThrow(LockHeldError);
		} finally {
			second.release();
		}
		expect(existsSync(lockPath)).toBe(false);
	});

	test("a crash between removing a stale record and installing the new one recovers", () => {
		const lockPath = tmpLockPath("crash-mid.lock");
		// The exact state a stale breaker leaves if it dies after removing the
		// dead owner's record but before link(2) installs its own: no pidfile,
		// plus the prewritten candidate it never made visible.
		writeStaleLock(lockPath, DEAD_PID);
		unlinkSync(lockPath);
		const orphanToken = "e".repeat(32);
		writeFileSync(
			`${lockPath}.new.${orphanToken}`,
			`${JSON.stringify(staleLockRecord(DEAD_PID))}\n`,
		);
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(parsed.pid).toBe(process.pid);
			expect(parsed.name).toBe("test-holder");
			// The orphaned candidate is a private file, never the lock record.
			expect(parsed.token).not.toBe(orphanToken);
		} finally {
			lock.release();
		}
	});

	test("unreadable ownership is busy, never broken", () => {
		const lockPath = tmpLockPath("garbage.lock");
		writeFileSync(lockPath, "{not-json");
		expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
		// The unattributable file is left exactly as found.
		expect(readFileSync(lockPath, "utf8")).toBe("{not-json");
	});

	test("a recorded start time that was never readable is busy, never broken", () => {
		const lockPath = tmpLockPath("unverified.lock");
		// The old `?? 0` fallback: this holder could not read its own start
		// time, so its identity can never be matched or disproved. Its pid is
		// live (ours), so breaking the lock would hand it to a second owner.
		const unverifiable: LockFileContents = {
			pid: process.pid,
			procStartTime: 0,
			name: "legacy",
			token: "b".repeat(32),
		};
		const raw = `${JSON.stringify(unverifiable)}\n`;
		writeFileSync(lockPath, raw);
		expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
		expect(readFileSync(lockPath, "utf8")).toBe(raw);
	});

	test("an owner record missing the token is busy, never broken", () => {
		const lockPath = tmpLockPath("old-shape.lock");
		writeFileSync(lockPath, `${JSON.stringify({ pid: DEAD_PID, name: "ghost", startedAt: 0 })}\n`);
		const before = readFileSync(lockPath, "utf8");
		expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
		expect(readFileSync(lockPath, "utf8")).toBe(before);
	});

	test("the parent directory is created when missing", () => {
		const dir = tempDir("omp-file-lock-");
		const lockPath = path.join(dir, "nested", "deep", "parent.lock");
		const lock = acquireFileLock(lockPath, "test-holder");
		try {
			expect(() => acquireFileLock(lockPath, "test-holder")).toThrow(LockHeldError);
		} finally {
			lock.release();
		}
	});

	test("the guard inode is created once and never unlinked", () => {
		const lockPath = tmpLockPath("guard.lock");
		const guardPath = `${lockPath}.guard`;
		const lock = acquireFileLock(lockPath, "test-holder");
		// Unlinking the guard would let the next opener lock a fresh inode while
		// a peer still holds the old one, putting two processes in the pidfile.
		expect(existsSync(guardPath)).toBe(true);
		lock.release();
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(guardPath)).toBe(true);
		const again = acquireFileLock(lockPath, "test-holder");
		again.release();
	});

	test("release is a no-op after the lock's directory was removed", () => {
		const lockPath = path.join(tempDir("omp-file-lock-"), "state", "lock");
		const lock = acquireFileLock(lockPath, "test-holder");
		// bwrap-provider's delete removes the whole stateDir, guard included,
		// while it still holds the lock; release must not throw on the gone guard.
		rmSync(path.dirname(lockPath), { recursive: true, force: true });
		lock.release();
		expect(existsSync(lockPath)).toBe(false);
		// The directory can be rebuilt for a fresh owner.
		const again = acquireFileLock(lockPath, "test-holder");
		again.release();
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
