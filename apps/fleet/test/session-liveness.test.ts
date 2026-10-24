import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectFileLock } from "#lib/platform/file-lock";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { RegistryEntry } from "../registry";
import { sessionLiveness } from "../session-liveness";

afterAll(cleanupTempDirs);

let deadPid: number;

beforeAll(async () => {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	expect(await child.exited).toBe(0);
	deadPid = child.pid;
	try {
		process.kill(deadPid, 0);
		throw new Error("exited child pid is unexpectedly alive");
	} catch (err) {
		expect(err).toHaveProperty("code", "ESRCH");
	}
});

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		daemonId: "d1",
		name: "local-session",
		cwd: "/tmp/local-project",
		project: "local-project",
		status: "ready",
		registeredAt: 1,
		...overrides,
	};
}

function sessionFile(): string {
	return join(tempDir("fleet-liveness-"), "session.jsonl");
}

function writeLock(file: string, pid: number): string {
	const contents = `${JSON.stringify({ pid, name: "session-holder", startedAt: 0 })}\n`;
	writeFileSync(`${file}.lock`, contents);
	return contents;
}

describe("sessionLiveness", () => {
	test("a held local session lock proves alive despite a dead recorded pid", () => {
		const lastSessionFile = sessionFile();
		const contents = writeLock(lastSessionFile, process.pid);
		expect(sessionLiveness(entry({ lastSessionFile, pid: deadPid }))).toBe("alive");
		expect(readFileSync(`${lastSessionFile}.lock`, "utf8")).toBe(contents);
	});

	test("a missing local session lock proves dead despite a live recorded pid", () => {
		const lastSessionFile = sessionFile();
		expect(sessionLiveness(entry({ lastSessionFile, pid: process.pid }))).toBe("dead");
		expect(existsSync(`${lastSessionFile}.lock`)).toBe(false);
	});

	test("a stale dead-pid local session lock proves dead without removing the lock", () => {
		const lastSessionFile = sessionFile();
		const contents = writeLock(lastSessionFile, deadPid);
		expect(sessionLiveness(entry({ lastSessionFile, pid: process.pid }))).toBe("dead");
		expect(readFileSync(`${lastSessionFile}.lock`, "utf8")).toBe(contents);
	});

	test("garbage and missing numeric pid session locks prove dead without changing them", () => {
		for (const contents of ["not-json", "null", "{}", '{"pid":"123","name":"bad-pid"}']) {
			const lastSessionFile = sessionFile();
			writeFileSync(`${lastSessionFile}.lock`, contents);
			expect(sessionLiveness(entry({ lastSessionFile, pid: process.pid }))).toBe("dead");
			expect(readFileSync(`${lastSessionFile}.lock`, "utf8")).toBe(contents);
		}
	});

	test("an unreadable session lock falls through to a dead recorded pid", () => {
		const lastSessionFile = sessionFile();
		mkdirSync(`${lastSessionFile}.lock`);
		expect(sessionLiveness(entry({ lastSessionFile, pid: deadPid }))).toBe("dead");
		expect(existsSync(`${lastSessionFile}.lock`)).toBe(true);
	});

	test("an unreadable session lock stays unknown with a live or absent recorded pid", () => {
		const lastSessionFile = sessionFile();
		mkdirSync(`${lastSessionFile}.lock`);
		for (const pid of [process.pid, undefined]) {
			expect(sessionLiveness(entry({ lastSessionFile, pid }))).toBe("unknown");
		}
	});

	test("a dead recorded pid proves dead without a session file", () => {
		expect(sessionLiveness(entry({ pid: deadPid }))).toBe("dead");
	});

	test("a live recorded pid without a session file is unknown because it may be reused", () => {
		expect(sessionLiveness(entry({ pid: process.pid }))).toBe("unknown");
	});

	test("absent and nonpositive recorded pids without a session file are unknown", () => {
		for (const pid of [undefined, 0, -1]) {
			expect(sessionLiveness(entry({ pid }))).toBe("unknown");
		}
	});

	test("empty and relative session paths are ignored in favor of recorded pid evidence", () => {
		for (const lastSessionFile of ["", "relative-session.jsonl"]) {
			expect(sessionLiveness(entry({ lastSessionFile, pid: deadPid }))).toBe("dead");
			expect(sessionLiveness(entry({ lastSessionFile, pid: process.pid }))).toBe("unknown");
			expect(sessionLiveness(entry({ lastSessionFile }))).toBe("unknown");
		}
	});
});

describe("inspectFileLock", () => {
	test("a missing lock is free and remains absent", () => {
		const path = `${sessionFile()}.lock`;
		expect(inspectFileLock(path)).toEqual({ state: "free" });
		expect(existsSync(path)).toBe(false);
	});

	test("a live lock reports its holder pid and name without changing its bytes", () => {
		const file = sessionFile();
		const contents = writeLock(file, process.pid);
		expect(inspectFileLock(`${file}.lock`)).toEqual({
			state: "held",
			holderPid: process.pid,
			holderName: "session-holder",
		});
		expect(readFileSync(`${file}.lock`, "utf8")).toBe(contents);
	});

	test("a live lock without a holder name reports unknown as its name", () => {
		const path = `${sessionFile()}.lock`;
		writeFileSync(path, JSON.stringify({ pid: process.pid }));
		expect(inspectFileLock(path)).toEqual({
			state: "held",
			holderPid: process.pid,
			holderName: "unknown",
		});
	});

	test("a dead-pid lock is stale and remains unchanged", () => {
		const file = sessionFile();
		const contents = writeLock(file, deadPid);
		expect(inspectFileLock(`${file}.lock`)).toEqual({
			state: "stale",
			holderPid: deadPid,
			holderName: "session-holder",
		});
		expect(readFileSync(`${file}.lock`, "utf8")).toBe(contents);
	});

	test("garbage and locks without a numeric pid are stale and remain unchanged", () => {
		for (const contents of ["not-json", "null", "{}", '{"pid":"123","name":"bad-pid"}']) {
			const path = `${sessionFile()}.lock`;
			writeFileSync(path, contents);
			expect(inspectFileLock(path).state).toBe("stale");
			expect(readFileSync(path, "utf8")).toBe(contents);
		}
	});

	test("a non-ENOENT read error reports unknown without removing the lock path", () => {
		const path = `${sessionFile()}.lock`;
		mkdirSync(path);
		expect(inspectFileLock(path)).toEqual({ state: "unknown" });
		expect(existsSync(path)).toBe(true);
	});
});
