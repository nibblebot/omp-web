import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
		const leftover = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
		expect(leftover.pid).not.toBe(process.pid);
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

	test("two concurrent stale recoveries yield exactly one owner", async () => {
		const lockPath = tmpLockPath("race.lock");
		// JSON whitespace is legal padding, and the 1 MiB record keeps both
		// recoverers inside their read-to-rename window at once. A small
		// record closes that window in microseconds, so the interleaving
		// below would almost never be raced.
		const pad = " ".repeat(1024 * 1024);
		writeFileSync(lockPath, `${pad}${JSON.stringify(staleLockRecord(DEAD_PID))}\n`);
		// Both recoverers must judge the same file stale and commit together:
		// released one after the other, the first can acquire before the
		// second even starts, and the read-to-rename window is never raced.
		const script = writeLockChildScript(
			"race",
			lockPath,
			[
				`const stdin = Bun.stdin.stream().getReader();`,
				`console.log("READY");`,
				`await stdin.read(); // Go: the parent releases both recoverers at once.`,
				`try {`,
				`	const lock = acquireFileLock(lockPath, "child");`,
				`	console.log("ACQUIRED");`,
				`	await stdin.read(); // Hold until the parent kills us: keep the owner live.`,
				`	lock.release();`,
				`} catch (err) {`,
				`	console.log(err instanceof Error && err.name === "LockHeldError" ? "HELD" : "ERROR " + String(err));`,
				`}`,
			].join("\n"),
		);
		const children = [
			Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
			Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		];
		try {
			const readers = children.map((child) => lineReader(child.stdout));
			const ready = await Promise.all(readers.map((next) => next()));
			expect(ready).toEqual(["READY", "READY"]);
			for (const child of children) {
				child.stdin.write("go\n");
				child.stdin.flush();
			}
			const lines = await Promise.all(readers.map((next) => next()));
			expect(lines.filter((line) => line === "ACQUIRED")).toHaveLength(1);
			expect(lines.filter((line) => line === "HELD")).toHaveLength(1);
			// The one winner's fresh record is what the file carries.
			const survivor = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
			expect(survivor.name).toBe("child");
			expect(survivor.token).not.toBe(staleLockRecord(DEAD_PID).token);
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
		}
	});

	test("release after a replacement owner took the lock preserves its file", () => {
		const lockPath = tmpLockPath("replaced.lock");
		const first = acquireFileLock(lockPath, "first");
		// A stale-breaker replaced our record with its own owner record.
		const replacement: LockFileContents = {
			pid: process.pid,
			procStartTime: selfStartTime(),
			name: "second",
			token: "f".repeat(32),
		};
		writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
		first.release();
		expect(existsSync(lockPath)).toBe(true);
		const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
		expect(parsed).toEqual(replacement);
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
