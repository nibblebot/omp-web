/**
 * ProjectSync tests: git-state polling, project sync, and backfillWorktrees
 * over a real Registry, a real WorkspaceLifecycle as the sync's host (it only
 * resolves template names for rows the sync registers asleep, plus the one
 * spawn-time probe through onSpawned), and a fake git runner injected through
 * startGitStatePolling. Covers probe cadence (change-only registry updates,
 * asleep rows once per 60s, bounded concurrency, single-flight), probe
 * failure isolation, session title/empty probing, the worktree-vanished hook,
 * registration of missing main/linked rows (asleep, templated, lock flag,
 * project.missing), and backfillWorktrees. Runtime behavior (spawn, respawn,
 * stop, exit policy) is covered by host-lifecycle.test.ts.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import type { GitResult, GitRunner } from "../discovery";
import { ProjectSync } from "../project-sync";
import { Registry, type RegistryEntry } from "../registry";
import type { WorkspaceLifecycle } from "../workspace-lifecycle";
import { makeHostLifecycle } from "./host-lifecycle.testkit";

afterAll(cleanupTempDirs);

// Every harness registers its teardown here so it runs even when a test fails
// mid-body (the spawn-time probe test launches a real child process).
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(25);
	}
}

/**
 * Spawn template over a fake child (sh) that drains the fleet stdin payload
 * and idles; only the spawn-time probe test ever launches it. The other
 * tests never spawn, so their rows would fail loudly if they did.
 */
function makeConfig(script: string, projectTemplates?: Record<string, string>): FleetConfig {
	return {
		templates: {
			test: { command: `sh ${script} {fleet} {resume}` },
			other: { command: `sh ${script} {fleet} {resume}` },
		},
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
		bind: "127.0.0.1",
		...(projectTemplates !== undefined ? { projectTemplates } : {}),
	};
}

interface Harness {
	registry: Registry;
	lifecycle: WorkspaceLifecycle;
	sync: ProjectSync;
	statePath: string;
}

/**
 * A ProjectSync over a real registry and a real host lifecycle. Teardown
 * stops every host row (killing a child the lifecycle spawned), then closes
 * the sync, the lifecycle, and the transport.
 */
async function makeHarness(
	config: FleetConfig,
	opts?: { onWorktreeRemoved?: (entry: RegistryEntry) => void },
): Promise<Harness> {
	const statePath = join(tempDir("omp-session-sync-state-"), "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new DaemonTransportRegistry();
	// The lifecycle's spawn hook probes the fresh row, as the server wires it.
	let sync: ProjectSync | undefined;
	const { lifecycle } = makeHostLifecycle({
		registry,
		config,
		transport,
		statePath,
		callbackUrl: () => "http://127.0.0.1:1/callback",
		runtime: { restartMax: 0 },
		onSpawned: (daemonId) => sync?.probeGitState(daemonId),
	});
	sync = new ProjectSync(registry, lifecycle, opts);
	cleanups.push(async () => {
		for (const entry of registry.list()) {
			if (entry.workspace?.kind !== "clone") await lifecycle.stop(entry.daemonId);
		}
		sync.close();
		lifecycle.close();
		transport.close();
	});
	return { registry, lifecycle, sync, statePath };
}

/** Harness whose template would fail to launch: polling and sync tests never spawn. */
function makeIdleHarness(opts?: {
	onWorktreeRemoved?: (entry: RegistryEntry) => void;
}): Promise<Harness> {
	return makeHarness(makeConfig("/nonexistent-child.sh"), opts);
}

/** Recorded git invocation for the fake exec. */
interface GitCall {
	args: string[];
	cwd: string;
}

/**
 * Fake git answering each POLL PASS from `phases`, indexed by status run: a
 * pass is a status run, then a numstat run only when that status is dirty.
 * Each element is [statusResult, numstatResult]; the LAST pass repeats.
 * Records every call so tests can pin the exact git args and cwds.
 */
function fakeGitPhases(phases: [GitResult, GitResult][]): { exec: GitRunner; calls: GitCall[] } {
	const calls: GitCall[] = [];
	let statusRuns = 0;
	let pass = phases[0]!;
	const exec: GitRunner = async (args, cwd) => {
		calls.push({ args, cwd });
		if (args[0] === "status") {
			pass = phases[Math.min(statusRuns, phases.length - 1)]!;
			statusRuns += 1;
			return pass[0];
		}
		return pass[1];
	};
	return { exec, calls };
}

/** Run a real git command, throwing on failure. */
function gitSync(args: string[], cwd: string): void {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
	if (proc.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString()}`);
}

/** Real git repo: main checkout + one linked worktree, both under `dir`. */
function makeWorktreeRepo(dir: string): { main: string; wt: string } {
	const main = join(dir, "main-repo");
	const wt = join(dir, "wt-feature");
	mkdirSync(main, { recursive: true });
	gitSync(["init", "-b", "main"], main);
	writeFileSync(join(main, "README.md"), "# main\n");
	gitSync(["add", "."], main);
	gitSync(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
		main,
	);
	gitSync(["worktree", "add", wt, "-b", "feature/x"], main);
	return { main, wt };
}

describe("backfillWorktrees", () => {
	test("tags untagged local entries and leaves the main checkout untagged", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-backfill-"));
		const { registry, sync } = await makeIdleHarness();
		const spawned = registry.create({
			name: "wt",
			cwd: wt,
			project: basename(wt),
			template: "test",
		});
		const mainEntry = registry.create({
			name: "m",
			cwd: main,
			project: "main-repo",
			template: "test",
		});

		await sync.backfillWorktrees();
		expect(registry.get(spawned.daemonId)!.worktreeOf).toBe("main-repo");
		expect(registry.get(mainEntry.daemonId)!.worktreeOf).toBeUndefined();
	});
});

describe("git-state polling", () => {
	test("probes local entries only on change; empty-cwd entries are never probed", async () => {
		const { registry, sync } = await makeIdleHarness();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			template: "test",
		});
		registry.create({
			name: "e",
			cwd: "",
			project: "",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};

		const dirty = ["## main", "?? new.txt", ""].join("\n");
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: dirty },
				{ exitCode: 0, stderr: "", stdout: "10\t2\tnew.txt\n" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 25 });

		await waitFor(
			() => (registry.get(local.daemonId)?.git !== undefined ? "probed" : null),
			5000,
			"first probe",
		);
		// Several more ticks with an unchanged state: no registry update, no
		// roster broadcast (every update fires onChange).
		await waitFor(() => (calls.length >= 4 ? "ticks" : null), 5000, "multiple ticks");
		expect(onChange).toBe(1);
		expect(registry.get(local.daemonId)).toMatchObject({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1, linesAdded: 10, linesDeleted: 2 },
		});
		// Empty-cwd entries are never probed with local git.
		expect(calls.length).toBeGreaterThanOrEqual(4);
		for (const call of calls) {
			expect(call.cwd).toBe("/srv/repos/acme");
			expect(call.args).toEqual(
				call.args[0] === "status"
					? ["status", "--porcelain=v1", "--branch"]
					: ["diff", "--numstat", "HEAD", "--"],
			);
		}
		expect(registry.get("d2")?.worktreeOf).toBeUndefined();
		expect(registry.get("d2")?.git).toBeUndefined();
	});

	test("a changed state updates the registry and persists to disk", async () => {
		const { registry, sync, statePath } = await makeIdleHarness();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			template: "test",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};

		// Clean for the first two passes (immediate tick + one interval
		// tick), then dirty from the third pass on.
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: "## main\n" },
				{ exitCode: 0, stderr: "", stdout: "" },
			],
			[
				{ exitCode: 0, stderr: "", stdout: "## main\n" },
				{ exitCode: 0, stderr: "", stdout: "" },
			],
			[
				{ exitCode: 0, stderr: "", stdout: ["## main", "?? new.txt", ""].join("\n") },
				{ exitCode: 0, stderr: "", stdout: "3\t1\tnew.txt\n" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 25 });

		await waitFor(
			() => (registry.get(local.daemonId)?.branch !== undefined ? "clean" : null),
			5000,
			"clean state",
		);
		expect(registry.get(local.daemonId)!.git).toEqual({
			added: 0,
			modified: 0,
			deleted: 0,
			untracked: 0,
			linesAdded: 0,
			linesDeleted: 0,
		});
		await waitFor(
			() => (registry.get(local.daemonId)?.git?.untracked === 1 ? "dirty" : null),
			5000,
			"dirty state",
		);
		expect(onChange).toBe(2);
		// Steady state: further ticks change nothing.
		const changedAt = calls.length;
		await waitFor(() => (calls.length >= changedAt + 3 ? "more ticks" : null), 5000, "more ticks");
		expect(onChange).toBe(2);
		// The polled fields persist (registry persists every update) and
		// reload cleanly (old state files without them load too).
		registry.flush();
		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { entries: RegistryEntry[] };
		expect(onDisk.entries[0]).toMatchObject({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1 },
		});
		const reloaded = new Registry(statePath);
		await reloaded.load();
		expect(reloaded.get(local.daemonId)).toMatchObject({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1 },
		});
	});

	test("git-poll probe fills sessionTitle from the last session file and clears it when the file is gone", async () => {
		const { registry, sync, statePath } = await makeIdleHarness();
		// Real session file with the fixed-256-byte title slot + header.
		const sessionDir = tempDir("omp-session-sup-titlefile-");
		const sessionFile = join(sessionDir, "session.jsonl");
		const titleLine = (title: string): string => {
			const json = JSON.stringify({ type: "title", title });
			if (json.length > 256) throw new Error("test title too long for the slot");
			return json.padEnd(256, " ") + "\n";
		};
		writeFileSync(
			sessionFile,
			titleLine("The dashboard title") +
				JSON.stringify({ type: "session", id: "s1", cwd: "/srv/repos/acme" }) +
				"\n",
		);
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			template: "test",
			lastSessionFile: sessionFile,
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};

		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: "## main\n" },
				{ exitCode: 0, stderr: "", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 25 });

		await waitFor(
			() =>
				registry.get(local.daemonId)?.sessionTitle === "The dashboard title" ? "filled" : null,
			5000,
			"sessionTitle filled",
		);
		// Two broadcasts: the git probe's branch fill (undefined → "main") and
		// the session-title fill; steady-state ticks change nothing.
		expect(onChange).toBe(2);
		const filledAt = calls.length;
		await waitFor(
			() => (calls.length >= filledAt + 3 ? "more ticks" : null),
			5000,
			"steady-state ticks",
		);
		expect(onChange).toBe(2); // no churn on unchanged titles
		// The title persists with the other entry fields.
		registry.flush();
		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { entries: RegistryEntry[] };
		expect(onDisk.entries[0].sessionTitle).toBe("The dashboard title");

		unlinkSync(sessionFile);
		await waitFor(
			() => (registry.get(local.daemonId)?.sessionTitle === undefined ? "cleared" : null),
			5000,
			"sessionTitle cleared",
		);
		expect(onChange).toBe(3); // branch fill, title fill, title clear; nothing else
	});

	test("probe flags a new/empty session (sessionEmpty) and clears it when a title appears", async () => {
		const { registry, sync, statePath } = await makeIdleHarness();
		// A fresh session: header present, NO title slot, NO messages.
		const sessionDir = tempDir("omp-session-sup-emptyfile-");
		const sessionFile = join(sessionDir, "session.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", id: "s1", cwd: "/srv/repos/acme" }) + "\n",
		);
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			template: "test",
			lastSessionFile: sessionFile,
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};

		const { exec } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: "## main\n" },
				{ exitCode: 0, stderr: "", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 25 });

		await waitFor(
			() => (registry.get(local.daemonId)?.sessionEmpty === true ? "empty" : null),
			5000,
			"sessionEmpty flagged",
		);
		// Untitled+empty: title stays undefined, empty flag true. Two
		// broadcasts total (branch fill + the empty flag), with no title churn.
		expect(registry.get(local.daemonId)?.sessionTitle).toBeUndefined();
		expect(onChange).toBe(2);
		registry.flush();
		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { entries: RegistryEntry[] };
		expect(onDisk.entries[0].sessionEmpty).toBe(true);

		// A title appears on the same file: the empty flag clears in ONE
		// update (the title fill), never a separate broadcast.
		const titleLine = (title: string): string => {
			const json = JSON.stringify({ type: "title", title });
			if (json.length > 256) throw new Error("test title too long for the slot");
			return json.padEnd(256, " ") + "\n";
		};
		writeFileSync(
			sessionFile,
			titleLine("Now titled") +
				JSON.stringify({ type: "session", id: "s1", cwd: "/srv/repos/acme" }) +
				"\n",
		);
		await waitFor(
			() => (registry.get(local.daemonId)?.sessionTitle === "Now titled" ? "titled" : null),
			5000,
			"title filled",
		);
		expect(registry.get(local.daemonId)?.sessionEmpty).toBeUndefined();
		expect(onChange).toBe(3); // branch fill, empty flag, title+clear-empty; one each
	});

	test("a probe failure clears previously-set fields, once", async () => {
		const { registry, sync } = await makeIdleHarness();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			template: "test",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};

		// First pass: dirty state (numstat succeeds). Then the repo
		// disappears: the status run itself fails (nonzero exit).
		// A slow interval keeps the transient set state observable between
		// the immediate tick (set) and the first interval tick (clear).
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: ["## main", " M x", ""].join("\n") },
				{ exitCode: 0, stderr: "", stdout: "5\t1\tx\n" },
			],
			[
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 250 });

		await waitFor(
			() => (registry.get(local.daemonId)?.git?.modified === 1 ? "set" : null),
			5000,
			"state set",
		);
		await waitFor(
			() => (registry.get(local.daemonId)?.git === undefined ? "cleared" : null),
			5000,
			"state cleared",
		);
		expect(registry.get(local.daemonId)!.branch).toBeUndefined();
		expect(onChange).toBe(2); // set, then clear
		// Repeated failures must not re-update (nothing stale left to clear).
		const clearedAt = calls.length;
		await waitFor(
			() => (calls.length >= clearedAt + 3 ? "more ticks" : null),
			5000,
			"more failure ticks",
		);
		expect(onChange).toBe(2);
	});

	test("a host spawn runs a one-off probe before the next poll tick", async () => {
		const projectDir = tempDir("omp-session-sync-gitone-");
		const script = join(projectDir, "child.sh");
		// Drain the fleet stdin payload, then idle until stop kills the child.
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				"cat >/dev/null",
				"while :; do sleep 0.05; done",
				"",
			].join("\n"),
		);
		const { registry, sync, lifecycle } = await makeHarness(makeConfig(script));

		const stdout = ["## main", "?? new.txt", ""].join("\n");
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout },
				{ exitCode: 0, stderr: "", stdout: "7\t4\tnew.txt\n" },
			],
		]);
		// A long interval: the immediate start tick runs before the entry
		// exists, so only the host spawn's one-off probe can run in this window.
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		const entry = await lifecycle.spawnHost({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.git !== undefined ? "probed" : null),
			5000,
			"one-off probe",
		);
		expect(registry.get(entry.daemonId)).toMatchObject({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1, linesAdded: 7, linesDeleted: 4 },
		});
		expect(calls).toHaveLength(2); // status + numstat for the one-off probe
	});

	test("a vanished tagged worktree fires onWorktreeRemoved and never clears branch/git", async () => {
		const ghost = join(tempDir("omp-session-sup-vanished-"), "gone-worktree");
		const fired: RegistryEntry[] = [];
		const { registry, sync } = await makeIdleHarness({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		// A TAGGED worktree entry (the detection gate: worktreeOf set) whose
		// cwd does NOT exist on disk, e.g. `git worktree remove` run outside
		// the fleet. Branch/git preset so the test can pin that the hook path
		// returns WITHOUT the stale-field clearing.
		const entry = registry.create({
			name: "wt",
			cwd: ghost,
			project: "acme",
			template: "test",
			worktreeOf: "acme",
			branch: "main",
		});
		// Every probe fails (the dir is gone); the injected exec never
		// touches the disk, so the FAILURE comes from the fake; existsSync
		// decides the gate.
		const { exec } = fakeGitPhases([
			[
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 250 });

		await waitFor(() => (fired.length > 0 ? "fired" : null), 5000, "worktree-removed hook");
		expect(fired[0]).toMatchObject({
			daemonId: entry.daemonId,
			name: "wt",
			cwd: ghost,
			worktreeOf: "acme",
		});
		// Detection only: the sync itself never removes the entry, and
		// the hook path returned BEFORE the branch/git clearing.
		expect(registry.get(entry.daemonId)).toBeDefined();
		expect(registry.get(entry.daemonId)?.branch).toBe("main");
		// Simulate the server's eviction (prune/drop + registry.remove): with
		// the entry gone, later poll ticks must NOT re-fire, since the hook is at
		// most meaningful once per entry. The polls keep ticking (250ms) but
		// the roster no longer contains the entry, so nothing is probed.
		registry.remove(entry.daemonId);
		await sleep(400); // well past the next interval tick
		expect(fired).toHaveLength(1);
	});

	test("a probe failure with the cwd still present keeps the clear path and never fires onWorktreeRemoved", async () => {
		// A REAL directory on disk (tempDir creates it); the fake exec fails,
		// but existsSync sees the dir present, a transient git failure. There is
		// no eviction, and branch/git are cleared exactly as before.
		const cwd = tempDir("omp-session-sup-present-");
		const fired: RegistryEntry[] = [];
		const { registry, sync } = await makeIdleHarness({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		const entry = registry.create({
			name: "wt",
			cwd,
			project: "acme",
			template: "test",
			worktreeOf: "acme",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};
		// First pass: dirty state. Then the repo is unreadable (nonzero
		// exit), but the dir is still on disk, so this is the classic clear path.
		const { exec } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout: ["## main", " M x", ""].join("\n") },
				{ exitCode: 0, stderr: "", stdout: "5\t1\tx\n" },
			],
			[
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 250 });

		await waitFor(
			() => (registry.get(entry.daemonId)?.git?.modified === 1 ? "set" : null),
			5000,
			"state set",
		);
		await waitFor(
			() => (registry.get(entry.daemonId)?.git === undefined ? "cleared" : null),
			5000,
			"state cleared",
		);
		expect(registry.get(entry.daemonId)!.branch).toBeUndefined();
		expect(onChange).toBe(2); // set, then clear
		expect(fired).toHaveLength(0);
		// The entry stays (no eviction without a vanished cwd).
		expect(registry.get(entry.daemonId)).toBeDefined();
	});

	test("a vanished cwd on an UNTAGGED entry never fires onWorktreeRemoved", async () => {
		const ghost = join(tempDir("omp-session-sup-untagged-"), "gone");
		const fired: RegistryEntry[] = [];
		const { registry, sync } = await makeIdleHarness({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		// No worktreeOf: a main checkout or untagged spawn. Such entries are
		// NEVER auto-evicted; only tagged linked worktrees qualify.
		registry.create({
			name: "main",
			cwd: ghost,
			project: "acme",
			template: "test",
		});
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
			],
		]);
		sync.startGitStatePolling({ exec, intervalMs: 25 });

		const startedAt = calls.length;
		await waitFor(() => (calls.length >= startedAt + 2 ? "ticks" : null), 5000, "poll ticks");
		expect(fired).toHaveLength(0);
		expect(registry.list().length).toBe(1); // still registered
	});
});

describe("project sync", () => {
	const okStatus: GitResult = { exitCode: 0, stderr: "", stdout: "## main\n" };
	const noDiff: GitResult = { exitCode: 0, stderr: "", stdout: "" };

	test("a pass registers the main checkout and each linked worktree", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-register-"));
		const { registry, sync } = await makeIdleHarness();
		const { project } = registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });

		await waitFor(() => (registry.list().length === 2 ? true : null), 5000, "sync registration");
		const mainRow = registry.list().find((e) => e.worktreeOf === undefined)!;
		const linked = registry.list().find((e) => e.worktreeOf !== undefined)!;
		expect(mainRow).toMatchObject({ projectId: project.projectId, workspace: { kind: "direct" } });
		expect(linked).toMatchObject({
			cwd: wt,
			projectId: project.projectId,
			worktreeOf: project.name,
			status: "asleep",
			workspace: { kind: "worktree", projectId: project.projectId },
		});
		expect(mainRow.template).toBe("test");
		expect(linked.template).toBe("test");
	});

	test("registered rows get their template through resolveTemplateName (projectTemplates override)", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-template-"));
		const { registry, sync } = await makeHarness(
			makeConfig("/nonexistent-child.sh", { [basename(wt)]: "other" }),
		);
		registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });

		await waitFor(() => (registry.list().length === 2 ? true : null), 5000, "sync registration");
		expect(registry.list().find((e) => e.cwd === wt)?.template).toBe("other");
		expect(registry.list().find((e) => e.cwd === main)?.template).toBe("test");
	});

	test("prunable linked worktrees are skipped", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-prunable-"));
		rmSync(wt, { recursive: true, force: true });
		const { registry, sync } = await makeIdleHarness();
		registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });

		// The main row's probe runs after the registration step of the same pass.
		await waitFor(
			() => (registry.list().some((e) => e.branch === "main") ? true : null),
			5000,
			"pass done",
		);
		expect(registry.list()).toHaveLength(1);
		expect(registry.list()[0]!.cwd).toBe(main);
	});

	test("a locked linked worktree mirrors worktreeLocked onto its row", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-locked-"));
		gitSync(["worktree", "lock", wt], main);
		const { registry, sync } = await makeIdleHarness();
		registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });

		await waitFor(
			() =>
				registry.list().some((e) => e.worktreeOf !== undefined && e.worktreeLocked === true)
					? true
					: null,
			5000,
			"locked row",
		);
	});

	test("a missing main checkout marks the project missing and keeps it registered", async () => {
		const { main } = makeWorktreeRepo(tempDir("omp-session-sync-missing-"));
		const { registry, sync } = await makeIdleHarness();
		registry.addProject(main);
		rmSync(main, { recursive: true, force: true });
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });

		await waitFor(
			() => (registry.projects()[0]?.missing === true ? true : null),
			5000,
			"missing flag",
		);
		expect(registry.projects()).toHaveLength(1);
	});

	test("syncNow coalesces requests that arrive during a pass into one follow-up pass", async () => {
		const dir = tempDir("omp-session-sync-coalesce-");
		const { registry, sync } = await makeIdleHarness();
		registry.create({ name: "r", cwd: dir, project: "r", status: "ready" });
		const { exec, calls } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		sync.syncNow();
		sync.syncNow();

		// One probe is one git call (clean status: no numstat): the first pass
		// plus exactly one follow-up.
		await waitFor(() => (calls.length >= 2 ? true : null), 5000, "two passes");
		await sleep(100);
		expect(calls).toHaveLength(2);
	});

	test("passes never overlap: git calls from one pass finish before the next pass starts", async () => {
		const dir = tempDir("omp-session-sync-overlap-");
		const { registry, sync } = await makeIdleHarness();
		registry.create({ name: "o", cwd: dir, project: "o", status: "ready" });
		let inFlight = 0;
		let maxInFlight = 0;
		const calls: string[] = [];
		const exec: GitRunner = async (args) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			calls.push(args[0] ?? "");
			await sleep(40);
			inFlight -= 1;
			return args[0] === "status" ? okStatus : noDiff;
		};
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		sync.syncNow();
		sync.syncNow();
		await waitFor(() => (calls.length >= 2 ? true : null), 5000, "two passes");
		await sleep(100);
		expect(maxInFlight).toBe(1);
		expect(calls).toHaveLength(2);
	});

	test("asleep rows are probed at most once per 60s; live rows on every pass", async () => {
		const asleepDir = tempDir("omp-session-sync-asleep-");
		const liveDir = tempDir("omp-session-sync-live-");
		const { registry, sync } = await makeIdleHarness();
		registry.create({ name: "a", cwd: asleepDir, project: "a", status: "asleep" });
		registry.create({ name: "l", cwd: liveDir, project: "l", status: "ready" });
		const { exec, calls } = fakeGitPhases([[okStatus, noDiff]]);
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		await waitFor(() => (calls.length === 2 ? true : null), 5000, "first pass");

		sync.syncNow();
		await waitFor(() => (calls.length >= 3 ? true : null), 5000, "second pass");
		await sleep(100);
		expect(calls.filter((c) => c.cwd === asleepDir)).toHaveLength(1);
		expect(calls.filter((c) => c.cwd === liveDir)).toHaveLength(2);
	});
});

describe("git-state probe: failure isolation, clone checkout, bounded concurrency", () => {
	const okStatus: GitResult = { exitCode: 0, stderr: "", stdout: "## main\n" };
	const titleLine = (title: string): string => {
		const json = JSON.stringify({ type: "title", title });
		if (json.length > 256) throw new Error("test title too long for the slot");
		return json.padEnd(256, " ") + "\n";
	};

	test("the title probe still runs when the git probe fails", async () => {
		const { registry, sync } = await makeIdleHarness();
		const dir = tempDir("omp-session-sup-title-nongit-");
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(
			sessionFile,
			titleLine("Survives git failure") +
				JSON.stringify({ type: "session", id: "s1", cwd: dir }) +
				"\n",
		);
		const row = registry.create({
			name: "t",
			cwd: dir,
			project: "t",
			status: "ready",
			lastSessionFile: sessionFile,
		});
		const failing: GitRunner = async () => ({ exitCode: 128, stderr: "not a repo", stdout: "" });
		sync.startGitStatePolling({ exec: failing, intervalMs: 60_000 });
		await waitFor(
			() => (registry.get(row.daemonId)?.sessionTitle === "Survives git failure" ? true : null),
			5000,
			"title filled despite git failure",
		);
	});

	test("a clone row probes its checkout (the repo), not the volume root", async () => {
		const volume = tempDir("omp-session-sup-clone-volume-");
		const checkout = join(volume, ".checkout");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		const { registry, sync } = await makeIdleHarness();
		const row = registry.create({
			name: "c",
			cwd: volume,
			project: "c",
			status: "ready",
			workspace: { kind: "clone", projectId: "p1", desiredState: "running" },
		});
		const calls: GitCall[] = [];
		const exec: GitRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return okStatus;
		};
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		await waitFor(
			() => (registry.get(row.daemonId)?.branch === "main" ? true : null),
			5000,
			"clone branch",
		);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.cwd === checkout)).toBe(true);
	});

	test("a clone whose checkout has no .git yet spawns no git probe", async () => {
		const volume = tempDir("omp-session-sup-clone-empty-");
		const { registry, sync } = await makeIdleHarness();
		const row = registry.create({
			name: "e",
			cwd: volume,
			project: "e",
			status: "ready",
			workspace: { kind: "clone", projectId: "p1", desiredState: "running" },
		});
		const calls: GitCall[] = [];
		const exec: GitRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return okStatus;
		};
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		await sleep(200);
		expect(calls).toHaveLength(0);
		expect(registry.get(row.daemonId)?.branch).toBeUndefined();
	});

	test("a sync pass probes rows concurrently, bounded at 4 in flight", async () => {
		const { registry, sync } = await makeIdleHarness();
		for (let i = 0; i < 6; i++) {
			const dir = tempDir(`omp-session-sup-conc-${i}-`);
			registry.create({ name: `c${i}`, cwd: dir, project: `c${i}`, status: "ready" });
		}
		let inFlight = 0;
		let maxInFlight = 0;
		const exec: GitRunner = async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await sleep(40);
			inFlight -= 1;
			return okStatus;
		};
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		await waitFor(
			() => (registry.list().every((e) => e.branch === "main") ? true : null),
			5000,
			"all rows probed",
		);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	test("a spawn-time probe and a sync pass of the same row share one run", async () => {
		const dir = tempDir("omp-session-sup-singleflight-");
		const { registry, sync } = await makeIdleHarness();
		const row = registry.create({ name: "s", cwd: dir, project: "s", status: "ready" });
		const inFlightByCwd = new Map<string, number>();
		let maxSameRow = 0;
		const exec: GitRunner = async (_args, cwd) => {
			const n = (inFlightByCwd.get(cwd) ?? 0) + 1;
			inFlightByCwd.set(cwd, n);
			maxSameRow = Math.max(maxSameRow, n);
			await sleep(40);
			inFlightByCwd.set(cwd, (inFlightByCwd.get(cwd) ?? 1) - 1);
			return okStatus;
		};
		sync.startGitStatePolling({ exec, intervalMs: 60_000 });
		sync.probeGitState(row.daemonId);
		sync.syncNow();
		await waitFor(
			() => (registry.get(row.daemonId)?.branch === "main" ? true : null),
			5000,
			"row probed",
		);
		await sleep(100);
		expect(maxSameRow).toBe(1);
	});
});
