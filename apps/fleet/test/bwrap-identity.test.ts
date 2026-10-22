import type { Subprocess } from "bun";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	BWRAP_PID_FILE,
	cmdlineOf,
	findTokenPid,
	identityLive,
	procIdentity,
	readLaunchRecord,
	type LaunchRecord,
} from "../bwrap-identity";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

const PROVIDER = join(import.meta.dir, "..", "bwrap-provider.ts");

type Child = Subprocess<"ignore", "ignore", "ignore">;
const children: Child[] = [];

/**
 * A long-lived host process whose argv carries `token` (as the shell's $0).
 * Returns once the child has exec'd, as the providers do (findTokenPid) before
 * recording an identity: between fork and exec its cmdline is still the test
 * runner's, so a record taken in that window never matches.
 */
function sleeper(token: string): Child {
	const child = Bun.spawn(["sh", "-c", "while :; do sleep 1; done", token], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.push(child);
	const deadline = Date.now() + 5000;
	while (!cmdlineOf(child.pid).includes(token)) {
		if (Date.now() > deadline) throw new Error("sleeper never exec'd");
		Bun.sleepSync(1);
	}
	return child;
}

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
});

function recordFor(child: Child, token: string, generation = 1): LaunchRecord {
	const identity = procIdentity(child.pid);
	if (identity === null) throw new Error("spawned process has no /proc identity");
	return {
		pid: child.pid,
		procStartTime: identity.startTime,
		generation,
		workspaceToken: token,
		startedAt: 1,
	};
}

function writeRecord(stateDir: string, value: unknown): void {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, BWRAP_PID_FILE), JSON.stringify(value));
}

describe("readLaunchRecord", () => {
	test("returns null for an absent, malformed, or invalid record", () => {
		const dir = tempDir("bwrap-identity-read-");
		expect(readLaunchRecord(dir)).toBeNull();
		writeFileSync(join(dir, BWRAP_PID_FILE), "{not json");
		expect(readLaunchRecord(dir)).toBeNull();
		const good = {
			pid: 42,
			procStartTime: 7,
			generation: 1,
			workspaceToken: "tok",
			startedAt: 1,
		};
		for (const bad of [
			{ ...good, pid: 0 },
			{ ...good, pid: -1 },
			{ ...good, pid: 1.5 },
			{ ...good, generation: 0 },
			{ ...good, workspaceToken: "" },
			{ ...good, procStartTime: "7" },
		]) {
			writeRecord(dir, bad);
			expect(readLaunchRecord(dir)).toBeNull();
		}
		writeRecord(dir, null);
		expect(readLaunchRecord(dir)).toBeNull();
	});

	test("round-trips a valid record", () => {
		const dir = tempDir("bwrap-identity-read-");
		const record: LaunchRecord = {
			pid: 42,
			procStartTime: 7,
			generation: 3,
			workspaceToken: "tok",
			startedAt: 99,
		};
		writeRecord(dir, record);
		expect(readLaunchRecord(dir)).toEqual(record);
	});
});

describe("identityLive (stop-proof, PID-reuse-rejecting)", () => {
	test("a live process with the recorded start time and token is live", () => {
		const token = "bwrap-identity-token-live";
		expect(identityLive(recordFor(sleeper(token), token))).toBe(true);
	});

	test("a missing record is never live", () => {
		expect(identityLive(null)).toBe(false);
	});

	test("a reused pid (same pid, different start time) never matches", () => {
		const token = "bwrap-identity-token-reuse";
		const record = recordFor(sleeper(token), token);
		expect(identityLive({ ...record, procStartTime: record.procStartTime + 1 })).toBe(false);
	});

	test("a live pid whose cmdline lost the token never matches", () => {
		const record = recordFor(sleeper("bwrap-identity-token-a"), "bwrap-identity-token-a");
		expect(identityLive({ ...record, workspaceToken: "bwrap-identity-token-b" })).toBe(false);
	});

	test("a terminated process is not live", async () => {
		const token = "bwrap-identity-token-dead";
		const child = sleeper(token);
		const record = recordFor(child, token);
		child.kill("SIGKILL");
		await child.exited;
		expect(procIdentity(record.pid)).toBeNull();
		expect(identityLive(record)).toBe(false);
	});

	test("procIdentity is null for a pid that does not exist", () => {
		expect(procIdentity(2 ** 22 + 12345)).toBeNull();
	});
});

describe("findTokenPid", () => {
	test("finds a descendant by its argv token and ignores unrelated trees", () => {
		const token = "bwrap-identity-token-walk";
		// The trailing `:` keeps each sh alive as the parent of its sleeping child.
		const parent = Bun.spawn(["sh", "-c", 'sh -c "sleep 3; :" "$0"; :', token], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		children.push(parent);
		let found: number | null = null;
		const deadline = Date.now() + 5000;
		while (found === null && Date.now() < deadline) found = findTokenPid(parent.pid, token);
		expect(found).not.toBeNull();
		expect(found).not.toBe(parent.pid);
		expect(findTokenPid(parent.pid, "bwrap-identity-token-absent")).toBeNull();
	});
});

/** Run one of the provider's real ops against a hand-written stateDir. */
async function runOp(op: "stop" | "inspect", stateDir: string): Promise<Record<string, unknown>> {
	const request = {
		op,
		workspaceId: "w1",
		generation: 1,
		workspaceDir: join(stateDir, "workspace"),
		homeDir: join(stateDir, "home"),
		profile: { id: "p", provider: "bwrap", executable: PROVIDER, tools: [] },
		stateDir,
	};
	const proc = Bun.spawn([process.execPath, PROVIDER, op], {
		stdin: new TextEncoder().encode(JSON.stringify(request)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return JSON.parse(out) as Record<string, unknown>;
}

const runStop = (stateDir: string): Promise<Record<string, unknown>> => runOp("stop", stateDir);

describe("bwrap provider stop", () => {
	test("stop kills the recorded process and proves termination by identity", async () => {
		const token = "bwrap-identity-token-stop";
		const stateDir = tempDir("bwrap-identity-stop-");
		const child = sleeper(token);
		const record = recordFor(child, token);
		writeRecord(stateDir, record);
		const response = await runStop(stateDir);
		expect(response).toMatchObject({ ok: true, observed: "stopped" });
		await child.exited;
		expect(identityLive(record)).toBe(false);
	});

	test("stop never signals a reused pid whose identity differs from the record", async () => {
		const token = "bwrap-identity-token-reuse-stop";
		const stateDir = tempDir("bwrap-identity-stop-");
		const bystander = sleeper(token);
		const record = recordFor(bystander, token);
		// The recorded pid now belongs to a different process incarnation.
		writeRecord(stateDir, { ...record, procStartTime: record.procStartTime + 1 });
		const response = await runStop(stateDir);
		expect(response).toMatchObject({ ok: true, observed: "stopped" });
		expect(identityLive(record)).toBe(true);
	});
});

describe("bwrap provider inspect of a sandbox that exited", () => {
	/** A dead launch record (its process was killed and reaped) in a fresh stateDir. */
	async function deadLaunch(token: string, generation = 1): Promise<string> {
		const stateDir = tempDir("bwrap-identity-inspect-");
		const child = sleeper(token);
		writeRecord(stateDir, recordFor(child, token, generation));
		child.kill("SIGKILL");
		await child.exited;
		return stateDir;
	}

	test("reports the supervisor's exit code and detail for this launch", async () => {
		const stateDir = await deadLaunch("bwrap-identity-token-exit");
		writeFileSync(
			join(stateDir, "exit.json"),
			JSON.stringify({
				generation: 1,
				workspaceToken: "bwrap-identity-token-exit",
				exitCode: 78,
				detail: "sandbox exited (rc 78): omp-session: --resume: session file not found",
			}),
		);
		expect(await runOp("inspect", stateDir)).toMatchObject({
			ok: true,
			observed: "stopped",
			exitCode: 78,
			detail: "sandbox exited (rc 78): omp-session: --resume: session file not found",
		});
	});

	test("ignores an exit record of another generation or token", async () => {
		const stateDir = await deadLaunch("bwrap-identity-token-stale");
		writeFileSync(
			join(stateDir, "exit.json"),
			JSON.stringify({ generation: 2, workspaceToken: "bwrap-identity-token-stale", exitCode: 78 }),
		);
		const stale = await runOp("inspect", stateDir);
		expect(stale).toMatchObject({ ok: true, observed: "stopped" });
		expect(stale).not.toHaveProperty("exitCode");
		writeFileSync(
			join(stateDir, "exit.json"),
			JSON.stringify({ generation: 1, workspaceToken: "someone-else", exitCode: 78 }),
		);
		expect(await runOp("inspect", stateDir)).not.toHaveProperty("exitCode");
	});

	test("reports nothing when the supervisor left no exit record", async () => {
		const stateDir = await deadLaunch("bwrap-identity-token-none");
		const response = await runOp("inspect", stateDir);
		expect(response).toMatchObject({ ok: true, observed: "stopped" });
		expect(response).not.toHaveProperty("exitCode");
		expect(response).not.toHaveProperty("detail");
	});
});
