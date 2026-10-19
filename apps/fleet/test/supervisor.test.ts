/**
 * SpawnSupervisor tests. A FAKE child script (sh) stands in for omp-session:
 * it appends its argv (the template-filled --fleet-stdin / labels / resume
 * args) to a file and captures the fleet stdin payload (the callback pair)
 * to another, optionally logs to stderr, then exits or idles. A real
 * DaemonTransportRegistry served over loopback HTTP receives the dial; tests
 * that need a live pair start the callback-daemon testkit with the pair the
 * child was launched with. Covers spawn (generation, stdin payload, no secret
 * on the entry or in argv/env), pair timeout,
 * respawn (generation bump, --resume), stop (ShutdownControl, revoke,
 * asleep), close (children and enrollments survive), exit policy (77, 78, 0,
 * bounded restarts, pair resets the budget), stderrTail, and git-state polling.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Server } from "bun";
import { CALLBACK_TRANSPORT_STREAM_ID } from "#lib/wire/callback-protocol";
import {
	OMP_SESSION_EXIT_RESUME_FAILED,
	OMP_SESSION_EXIT_SESSION_LOCKED,
} from "#lib/wire/protocol";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import type { GitResult, GitRunner } from "../discovery";
import { Registry, type RegistryEntry } from "../registry";
import { SpawnSupervisor, type SupervisorDeps } from "../supervisor";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";

afterAll(cleanupTempDirs);

// Every fixture a test creates registers its teardown here so it runs even
// when a test fails mid-body (the children are real processes). Cleanups run
// in reverse creation order: daemons first, then the supervisor's children,
// the transport, and the HTTP server.
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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Non-empty lines of a file the fake child writes; [] while it does not exist yet. */
function readLines(file: string): string[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "");
}

/** Resolves with the file's lines once at least `count` launches have appended to it. */
function waitForLaunches(file: string, count: number): Promise<string[]> {
	return waitFor(
		() => {
			const lines = readLines(file);
			return lines.length >= count ? lines : null;
		},
		5000,
		`${count} launch(es) in ${basename(file)}`,
	);
}

/** The child's pid (`$$` of the script), once written. */
function waitForPid(file: string): Promise<number> {
	return waitFor(
		() => {
			const pid = Number.parseInt(readLines(file)[0] ?? "", 10);
			return Number.isInteger(pid) && pid > 0 ? pid : null;
		},
		5000,
		"child pid",
	);
}

/** The stdin payload the supervisor hands a `--fleet-stdin` child; one JSON object per launch. */
interface FleetPayload {
	v: number;
	callback: {
		url: string;
		workspace: string;
		generation: number;
		token: string;
		allowHttp?: true;
		proxy?: string;
	};
	token?: string;
}

/** The callback pair of the launch at `generation`, once its stdin payload is captured. */
function waitForPayload(file: string, generation: number): Promise<FleetPayload["callback"]> {
	return waitFor(
		() => {
			if (!existsSync(file)) return null;
			// Complete lines only: the child's `echo` terminates each payload.
			const payloads = readFileSync(file, "utf8").split("\n").slice(0, -1);
			const pair = payloads
				.map((line) => JSON.parse(line) as FleetPayload)
				.find((p) => p.callback.generation === generation);
			return pair?.callback ?? null;
		},
		5000,
		`launch payload at generation ${generation}`,
	);
}

interface ChildScriptOpts {
	envFile?: string;
	pidFile?: string;
	/** Captures the stdin payload, one JSON line per launch. */
	payloadFile?: string;
	stderrLines?: string[];
	/** Exit immediately with this code instead of idling. */
	exitCode?: number;
	/** The idle loop exits (once, removing the flag) when this file appears. */
	crashFlag?: string;
	/** The exit code the idle loop uses when crashFlag fires (default 1). */
	crashExitCode?: number;
}

/**
 * Write a fake child script. It captures its stdin (the fleet payload) to
 * payloadFile first, appends "$@" (the template-filled --fleet-stdin /
 * labels / resume args) to argsFile, optionally dumps its OMP_SESSION_*
 * environment, records its pid, prints stderr lines, then either exits with
 * `exitCode` or idles.
 */
function writeChildScript(dir: string, argsFile: string, opts: ChildScriptOpts = {}): string {
	const script = join(dir, "child.sh");
	const lines = ["#!/bin/sh", 'trap "exit 0" TERM INT'];
	// cat ends at the supervisor's stdin EOF; the echo terminates the JSON line.
	if (opts.payloadFile) lines.push(`{ cat; echo; } >> '${opts.payloadFile}'`);
	lines.push(`echo "$@" >> '${argsFile}'`);
	if (opts.envFile) {
		lines.push(
			`env | grep '^OMP_SESSION_' | sort > '${opts.envFile}.tmp' && mv '${opts.envFile}.tmp' '${opts.envFile}'`,
		);
	}
	if (opts.pidFile) lines.push(`echo $$ > '${opts.pidFile}'`);
	for (const line of opts.stderrLines ?? []) lines.push(`echo ${JSON.stringify(line)} >&2`);
	if (opts.exitCode !== undefined) {
		lines.push(`exit ${opts.exitCode}`);
	} else {
		// Idle loop. The tick must stay short: dash defers an untrapped SIGTERM
		// until the running `sleep` returns, so every teardown costs one tick
		// per child; 0.05 keeps the child alive while making teardown ~instant.
		const crash = opts.crashFlag
			? `if [ -e '${opts.crashFlag}' ]; then rm -f '${opts.crashFlag}'; exit ${opts.crashExitCode ?? 1}; fi; `
			: "";
		lines.push(`while :; do ${crash}sleep 0.05; done`);
	}
	writeFileSync(script, lines.join("\n") + "\n");
	return script;
}

/** Spawn template that fills {fleet} {labels} {resume} as argv for the fake child. */
function makeConfig(script: string): FleetConfig {
	return {
		templates: { test: { command: `sh ${script} {fleet} {labels} {resume}` } },
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
		bind: "127.0.0.1",
	};
}

/** Two-template config for resolution-order tests: default "test", override "other". */
function makeTierConfig(
	scriptDefault: string,
	scriptOverride: string,
	projectTemplates?: Record<string, string>,
): FleetConfig {
	return {
		templates: {
			test: { command: `sh ${scriptDefault} {fleet} {labels} {resume}` },
			other: { command: `sh ${scriptOverride} {fleet} {labels} {resume}` },
		},
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
		bind: "127.0.0.1",
		...(projectTemplates !== undefined ? { projectTemplates } : {}),
	};
}

interface Harness {
	registry: Registry;
	transport: DaemonTransportRegistry;
	supervisor: SpawnSupervisor;
	statePath: string;
	/** The base URL the callback daemon testkit dials (no /callback suffix). */
	base: string;
	/** The callback URL the child receives in its stdin payload. */
	callbackUrl: string;
}

/**
 * A supervisor over a real registry and a real DaemonTransportRegistry served
 * on an ephemeral loopback port. Teardown stops every entry (killing its
 * child, which close() deliberately leaves running), then closes the
 * supervisor, the transport, and the server.
 */
async function makeHarness(
	config: FleetConfig,
	opts?: ConstructorParameters<typeof SpawnSupervisor>[3],
	deps?: Pick<SupervisorDeps, "pairTimeoutMs" | "onEnrolled">,
): Promise<Harness> {
	const statePath = join(tempDir("omp-session-sup-state-"), "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new DaemonTransportRegistry();
	const server: Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req) =>
			(await transport.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	const base = `http://127.0.0.1:${server.port}`;
	const callbackUrl = `${base}/callback`;
	const supervisor = new SpawnSupervisor(
		registry,
		config,
		{ transport, statePath, callbackUrl: () => callbackUrl, ...deps },
		opts,
	);
	cleanups.push(async () => {
		for (const entry of registry.list()) await supervisor.stop(entry.daemonId);
		supervisor.close();
		transport.close();
		await server.stop(true);
	});
	return { registry, transport, supervisor, statePath, base, callbackUrl };
}

interface Fixture extends Harness {
	dir: string;
	argsFile: string;
	envFile: string;
	pidFile: string;
	payloadFile: string;
}

/** A harness whose template runs the standard fake child (writeChildScript) in a fresh dir. */
async function makeFixture(
	prefix: string,
	child: ChildScriptOpts = {},
	supOpts?: ConstructorParameters<typeof SpawnSupervisor>[3],
	deps?: Pick<SupervisorDeps, "pairTimeoutMs" | "onEnrolled">,
): Promise<Fixture> {
	const dir = tempDir(prefix);
	const argsFile = join(dir, "args.txt");
	const envFile = join(dir, "env.txt");
	const pidFile = join(dir, "pid.txt");
	const payloadFile = join(dir, "payload.txt");
	const script = writeChildScript(dir, argsFile, { envFile, pidFile, payloadFile, ...child });
	const harness = await makeHarness(makeConfig(script), supOpts, deps);
	return { ...harness, dir, argsFile, envFile, pidFile, payloadFile };
}

/** Start the daemon half of the pair with the callback pair the child received on stdin; waits for the pair. */
async function pairDaemon(
	harness: Harness,
	pair: FleetPayload["callback"],
): Promise<CallbackDaemon> {
	const daemon = startCallbackDaemon({
		url: harness.base,
		workspaceId: pair.workspace,
		generation: pair.generation,
		token: pair.token,
	});
	cleanups.push(() => daemon.stop());
	await daemon.waitConnected(5000);
	return daemon;
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

describe("SpawnSupervisor", () => {
	test("spawn tags worktreeOf for a worktree cwd; a main checkout stays untagged", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sup-wt-"));
		const fx = await makeFixture("omp-session-sup-wt-child-", {}, { restartMax: 0 });

		const wtEntry = await fx.supervisor.spawn({ cwd: wt });
		expect(wtEntry.worktreeOf).toBe("main-repo");
		const mainEntry = await fx.supervisor.spawn({ cwd: main });
		expect(mainEntry.worktreeOf).toBeUndefined();
	});

	test("backfillWorktrees tags untagged local entries and leaves the main checkout untagged", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sup-backfill-"));
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const spawned = registry.create({
			name: "wt",
			cwd: wt,
			project: basename(wt),
			labels: [],
			template: "test",
		});
		const mainEntry = registry.create({
			name: "m",
			cwd: main,
			project: "main-repo",
			labels: [],
			template: "test",
		});

		await supervisor.backfillWorktrees();
		expect(registry.get(spawned.daemonId)!.worktreeOf).toBe("main-repo");
		expect(registry.get(mainEntry.daemonId)!.worktreeOf).toBeUndefined();
	});

	test("spawn enrolls generation 1 and launches the child with a stdin payload; the entry holds no secret", async () => {
		const enrolled: string[] = [];
		const fx = await makeFixture(
			"omp-session-sup-env-",
			{},
			{ restartMax: 2 },
			{ onEnrolled: (daemonId) => enrolled.push(daemonId) },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir, labels: ["env=prod"] });
		expect(entry.project).toBe(basename(fx.dir));
		const pair = await waitForPayload(fx.payloadFile, 1);
		expect(pair.url).toBe(fx.callbackUrl);
		expect(pair.workspace).toBe(entry.daemonId);
		expect(pair.generation).toBe(1);
		expect(pair.token).toMatch(/^[0-9a-f]{64}$/);
		expect(pair.allowHttp).toBe(true); // loopback http callback
		// The pair travels only on stdin: the env dump has the non-secret knob and no callback/token vars.
		const envDump = await waitFor(
			() => (existsSync(fx.envFile) ? readFileSync(fx.envFile, "utf8") : null),
			5000,
			"env dump",
		);
		expect(envDump).toContain("OMP_SESSION_LOG_MIRROR=0");
		expect(envDump).not.toMatch(/OMP_SESSION_CALLBACK_/);
		expect(envDump).not.toMatch(/OMP_SESSION_TOKEN=/);
		expect(enrolled).toEqual([entry.daemonId]);

		const current = fx.registry.get(entry.daemonId)!;
		expect(current.status).toBe("connecting");
		expect(current.pid).toBeTypeOf("number");
		// The registry keeps only the credential's digest, never the credential.
		expect(current).not.toHaveProperty("token");
		expect(JSON.stringify(current)).not.toContain(pair.token);
		expect(current.workspace?.enrollment?.generation).toBe(1);
		expect(current.workspace?.enrollment?.credentialHash).not.toBe(pair.token);
		expect(current.workspace?.authorizedGeneration).toBe(1);
		expect(fx.transport.pairStatus(entry.daemonId)).toMatchObject({
			enrolled: true,
			authorizedGeneration: 1,
			paired: false,
		});
		const [line] = await waitForLaunches(fx.argsFile, 1);
		expect(line).toContain("--label env=prod");
		expect(line).toContain("--fleet-stdin");
		expect(line).not.toContain(pair.token); // the credential never reaches argv
	});

	test("a daemon dialing with the child's credential pairs with the transport", async () => {
		const fx = await makeFixture("omp-session-sup-pair-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const daemon = await pairDaemon(fx, pair);

		expect(daemon.connected()).toBe(true);
		expect(fx.transport.pairStatus(entry.daemonId)).toMatchObject({
			enrolled: true,
			authorizedGeneration: 1,
			paired: true,
		});
		expect(fx.supervisor.snapshot()[entry.daemonId]?.restarts).toBe(0);
	});

	test("no pair within pairTimeoutMs errors the entry, revokes the credential, and kills the child", async () => {
		const fx = await makeFixture(
			"omp-session-sup-timeout-",
			{},
			{ restartMax: 2 },
			{ pairTimeoutMs: 200 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pid = await waitForPid(fx.pidFile);
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			5000,
			"pair-timeout error",
		);
		expect(failed.error).toContain("no callback pair");
		await waitFor(() => (isAlive(pid) ? null : true), 5000, "child killed");
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
		// The timeout owns the aftermath: the killed child is not restarted.
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
	});

	test("snapshot exposes pid and restarts for a live spawned child", async () => {
		const fx = await makeFixture("omp-session-sup-snap-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForPayload(fx.payloadFile, 1);
		const snap = fx.supervisor.snapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(0);
		expect(typeof snap?.pid).toBe("number");
	});

	test("snapshot reports restart-budget use and no live pid after the budget is exhausted", async () => {
		const fx = await makeFixture(
			"omp-session-sup-snapfail-",
			{ exitCode: 1 },
			{ restartMax: 1, backoffMinMs: 20, backoffMaxMs: 40 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitFor(
			() => (fx.registry.get(entry.daemonId)?.status === "error" ? "error" : null),
			10_000,
			"error status",
		);
		const snap = fx.supervisor.snapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(1); // one restart consumed before the cap hit
		expect(snap?.pid).toBeUndefined(); // no live child
	});

	test("onEvent reports spawn, exit/restart, and budget exhaustion", async () => {
		const events: Array<{ level: string; message: string; daemonId?: string }> = [];
		const fx = await makeFixture(
			"omp-session-sup-events-",
			{ exitCode: 1 },
			{
				restartMax: 1,
				backoffMinMs: 20,
				backoffMaxMs: 40,
				onEvent: (level, message, daemonId) => events.push({ level, message, daemonId }),
			},
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitFor(
			() => (fx.registry.get(entry.daemonId)?.status === "error" ? "error" : null),
			10_000,
			"error status",
		);
		expect(
			events.some(
				(event) => event.daemonId === entry.daemonId && event.message.startsWith("spawn template="),
			),
		).toBe(true);
		expect(
			events.some(
				(event) => event.daemonId === entry.daemonId && event.message.startsWith("exit code=1"),
			),
		).toBe(true);
		expect(
			events.some((event) => event.level === "warn" && event.message.includes("restart 1/1")),
		).toBe(true);
		expect(
			events.some(
				(event) => event.level === "error" && event.message.includes("restart budget exhausted"),
			),
		).toBe(true);
	});

	test("onEvent reports respawn, replaced-exit, stop, and prune", async () => {
		const events: Array<{ level: string; message: string; daemonId?: string }> = [];
		const fx = await makeFixture(
			"omp-session-sup-events2-",
			{},
			{
				restartMax: 2,
				onEvent: (level, message, daemonId) => events.push({ level, message, daemonId }),
			},
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForPayload(fx.payloadFile, 1);
		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!);
		await waitForPayload(fx.payloadFile, 2);
		await fx.supervisor.prune(entry.daemonId);
		await waitFor(
			() =>
				events.some(
					(event) => event.message.startsWith("exit code=") && event.message.includes("(replaced)"),
				)
					? "replaced-exit"
					: null,
			3000,
			"replaced exit event",
		);
		expect(
			events.some(
				(event) => event.daemonId === entry.daemonId && event.message.startsWith("respawn"),
			),
		).toBe(true);
		expect(
			events.some(
				(event) => event.daemonId === entry.daemonId && event.message.startsWith("stop ("),
			),
		).toBe(true);
		expect(
			events.some((event) => event.daemonId === entry.daemonId && event.message === "prune"),
		).toBe(true);
	});

	test("respawn bumps the generation to 2 with a fresh credential and the daemon pairs at it", async () => {
		const fx = await makeFixture("omp-session-sup-regen-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pair1 = await waitForPayload(fx.payloadFile, 1);
		const first = await pairDaemon(fx, pair1);

		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!);
		const pair2 = await waitForPayload(fx.payloadFile, 2);
		expect(pair2.workspace).toBe(entry.daemonId);
		expect(pair2.token).toMatch(/^[0-9a-f]{64}$/);
		expect(pair2.token).not.toBe(pair1.token);
		// Enrolling generation 2 revoked generation 1: the old pair is refused on redial.
		await waitFor(() => first.rejection(), 5000, "generation 1 rejection");
		expect(first.connected()).toBe(false);

		await pairDaemon(fx, pair2);
		expect(fx.transport.pairStatus(entry.daemonId)).toMatchObject({
			enrolled: true,
			authorizedGeneration: 2,
			paired: true,
		});
		const current = fx.registry.get(entry.daemonId)!;
		expect(current.workspace?.enrollment?.generation).toBe(2);
		expect(current.workspace?.authorizedGeneration).toBe(2);
	});

	test("respawn uses --resume lastSessionFile and a fresh token", async () => {
		const fx = await makeFixture("omp-session-sup-resume-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!);
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("--fleet-stdin"); // first spawn: no resume, bare fleet flag
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl"); // R3 resume rule
		expect(lines[1]?.split(" ")[0]).toBe("--fleet-stdin");
		const pair1 = await waitForPayload(fx.payloadFile, 1);
		const pair2 = await waitForPayload(fx.payloadFile, 2);
		expect(pair2.token).toMatch(/^[0-9a-f]{64}$/);
		expect(pair2.token).not.toBe(pair1.token);
	});

	test("respawn with an explicit resumeFile resumes THAT file, not lastSessionFile", async () => {
		const fx = await makeFixture("omp-session-sup-resumefile-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		// Dropdown-picked session: the SUPERVISOR takes the file verbatim (the
		// edge validates membership); this test proves the argv actually carries
		// the chosen path rather than the entry's lastSessionFile.
		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!, {
			resumeFile: "/chosen/other-session.jsonl",
		});
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("--resume /chosen/other-session.jsonl");
		expect(lines[1]).not.toContain("/srv/proj/sess.jsonl");
		expect(lines[1]).not.toContain("--resume-unwritten");
	});

	test("respawn of a lastSessionFile the fleet never saw persisted resumes leniently (--resume-unwritten)", async () => {
		const fx = await makeFixture("omp-session-sup-unknown-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!);
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl --resume-unwritten");
	});

	test("respawn of a lastSessionFile the daemon reported persisted resumes strictly (plain --resume)", async () => {
		const fx = await makeFixture("omp-session-sup-persisted-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, {
			lastSessionFile: "/srv/proj/sess.jsonl",
			lastSessionPersisted: true,
		});

		await fx.supervisor.respawn(fx.registry.get(entry.daemonId)!);
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl");
		expect(lines[1]).not.toContain("--resume-unwritten");
	});

	test("respawn of a template-less asleep entry falls back to spawn's resolution and heals the entry", async () => {
		// Regression: entries registered asleep without a template (the auto
		// default workspace, unstarted worktrees, or pre-fix state files) must
		// be wakeable, since respawn used to key off entry.template only and throw
		// "unknown spawn template: undefined", wedging the row asleep.
		const fx = await makeFixture("omp-session-sup-notpl-", {}, { restartMax: 2 });

		const entry = fx.registry.create({
			name: "placeholder",
			cwd: fx.dir,
			project: "placeholder",
			labels: [],
			status: "asleep",
		});
		expect(entry.template).toBeUndefined();

		await fx.supervisor.respawn(entry);
		const lines = await waitForLaunches(fx.argsFile, 1);
		expect(fx.registry.get(entry.daemonId)?.template).toBe("test"); // healed with the resolved name
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("--fleet-stdin"); // no lastSessionFile → fresh start, no --resume
		expect(lines[0]).not.toContain("--resume");
		const pair = await waitForPayload(fx.payloadFile, 1);
		expect(pair.workspace).toBe(entry.daemonId);
	});

	test("spawn with reuse wakes the checkout's existing row; a plain spawn adds a session", async () => {
		// Regression: the sync registers every checkout as an asleep row, and the
		// fleet's create-and-start path used to add a second row for it.
		const fx = await makeFixture("omp-session-sup-reuse-", {}, { restartMax: 2 });
		const asleep = fx.registry.create({
			name: "checkout",
			cwd: fx.dir,
			project: "checkout",
			labels: [],
			status: "asleep",
		});

		const reused = await fx.supervisor.spawn({ cwd: fx.dir, reuse: true });
		expect(reused.daemonId).toBe(asleep.daemonId);
		expect(fx.registry.list()).toHaveLength(1);
		await waitForLaunches(fx.argsFile, 1); // the asleep row was woken

		// Several sessions per folder stay a deliberate CLI capability.
		const extra = await fx.supervisor.spawn({ cwd: fx.dir });
		expect(extra.daemonId).not.toBe(asleep.daemonId);
		expect(fx.registry.list()).toHaveLength(2);
	});

	test("respawn of an adopted row whose session still holds its lock refuses to launch a second child", async () => {
		// An adopted row has no child handle: the held lock stands in for a live
		// session this supervisor did not launch.
		const lastSessionFile = join(tempDir("omp-session-sup-adopt-"), "session.jsonl");
		writeFileSync(
			`${lastSessionFile}.lock`,
			`${JSON.stringify({ pid: process.pid, name: "adopted-holder", startedAt: 0 })}\n`,
		);
		const fx = await makeFixture("omp-session-sup-adopt-", {}, { restartMax: 2 });
		const adopted = fx.registry.create({
			name: "adopted",
			cwd: fx.dir,
			project: "adopted",
			labels: [],
			status: "reconnecting",
			lastSessionFile,
		});

		await expect(fx.supervisor.respawn(adopted)).rejects.toThrow("still holds its lock");
		expect(existsSync(fx.argsFile)).toBe(false);
	}, 20_000);

	test("spawn shell-quotes label/name values, a $(touch) payload stays inert", async () => {
		const fx = await makeFixture("omp-session-sup-quote-", {}, { restartMax: 2 });

		const pwn = join(fx.dir, "pwned");
		await fx.supervisor.spawn({
			cwd: fx.dir,
			labels: [`k=$(touch ${pwn})`, "q='quoted'", "sp ace"],
		});
		const [line] = await waitForLaunches(fx.argsFile, 1);
		// The payloads arrived as literal argv text (sh stripped the outer
		// quoting); none of the metacharacters was executed.
		expect(line).toContain(`--label k=$(touch ${pwn})`);
		expect(line).toContain(`--label q='quoted'`);
		expect(line).toContain("--label sp ace");
		expect(existsSync(pwn)).toBe(false);
	});

	test("quoted cwd/name/labels with metacharacters round-trip as single argv entries", async () => {
		const projectDir = tempDir("omp-session-sup-roundtrip-");
		// A REAL directory whose name contains spaces, quotes, $(), backticks,
		// and a newline, the exact hostile value class the quoting must tame.
		const weirdCwd = join(projectDir, "dir 'quoted' $(x) `y`\nnewline");
		mkdirSync(weirdCwd, { recursive: true });
		const argsFile = join(projectDir, "args.txt");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				`printf '%s\\0' "$@" > '${argsFile}.tmp' && mv '${argsFile}.tmp' '${argsFile}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const config: FleetConfig = {
			templates: {
				test: {
					command: `sh ${script} --cwd {cwd} {fleet} --name {name} {labels} {resume}`,
				},
			},
			defaultTemplate: "test",
			workspaceDir: "/tmp/fleet-test-ws",
			bind: "127.0.0.1",
		};
		const { supervisor } = await makeHarness(config, { restartMax: 2 });

		const trickyName = "na'me $(nope) `nope` with spaces\nand a newline";
		const pwn = join(projectDir, "pwned");
		await supervisor.spawn({
			cwd: weirdCwd,
			name: trickyName,
			labels: [`k=$(touch ${pwn})`],
		});
		await waitFor(() => (existsSync(argsFile) ? "written" : null), 5000, "args file");

		// NUL-delimited "$@" dump (printf '%s\0' "$@"): each hostile value
		// survived shell parsing as a single literal argument; even the
		// embedded newline stays inside one argv entry.
		const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
		expect(args[0]).toBe("--cwd");
		expect(args[1]).toBe(weirdCwd);
		expect(args[2]).toBe("--fleet-stdin");
		expect(args[3]).toBe("--name");
		expect(args[4]).toBe(trickyName);
		expect(args[5]).toBe("--label");
		expect(args[6]).toBe(`k=$(touch ${pwn})`);
		expect(existsSync(pwn)).toBe(false);
	});

	test("concurrent respawn() calls launch exactly one child, no orphan", async () => {
		const projectDir = tempDir("omp-session-sup-conc-");
		const argsFile = join(projectDir, "args.txt");
		const pidsFile = join(projectDir, "pids.txt");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				`echo $$ >> '${pidsFile}'`,
				`echo "$@" >> '${argsFile}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const { registry, supervisor } = await makeHarness(makeConfig(script), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitForLaunches(argsFile, 1);
		registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		// Two overlapping respawns (no await between the calls): both must
		// coalesce onto ONE launch. Exactly one replacement child is launched,
		// and the original is terminated rather than orphaned.
		await Promise.all([
			supervisor.respawn(registry.get(entry.daemonId)!),
			supervisor.respawn(registry.get(entry.daemonId)!),
		]);
		await waitForLaunches(argsFile, 2);
		await sleep(150); // a double-launch would have landed by now

		// One launch per spawn/respawn, never a double-launch: the initial
		// child wrote line/pid 1, the respawned child line/pid 2.
		const lines = readLines(argsFile);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl");
		const pids = readLines(pidsFile).map((l) => Number.parseInt(l, 10));
		expect(pids).toHaveLength(2);

		// stop() kills the tracked (only) child; the pre-respawn child was
		// terminated by the respawn, so no orphan survives.
		await supervisor.stop(entry.daemonId);
		for (const pid of pids) expect(isAlive(pid)).toBe(false);
	});

	test("restart-on-failure: bounded restarts, a fresh generation and credential per attempt, then error", async () => {
		// restartMax 1: initial child + exactly one restart, then error.
		const fx = await makeFixture("omp-session-sup-restart-", { exitCode: 1 }, { restartMax: 1 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status",
		);
		expect(failed.error).toContain("exited");
		const payloads = readLines(fx.payloadFile).map((line) => JSON.parse(line) as FleetPayload);
		expect(payloads).toHaveLength(2);
		expect(payloads.map((p) => p.callback.generation)).toEqual([1, 2]);
		expect(payloads[0]?.callback.token).not.toBe(payloads[1]?.callback.token); // fresh credential across attempts
		expect(readLines(fx.argsFile)).toHaveLength(2);
		// The exhausted entry holds no live credential; the generation stays monotonic.
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
		expect(failed.workspace?.authorizedGeneration).toBe(2);
	});

	test("rapid crashes that never pair exhaust the budget and error (window, not lifetime)", async () => {
		const fx = await makeFixture(
			"omp-session-sup-budgetfail-",
			{ exitCode: 1 },
			{ restartMax: 5, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status",
		);
		expect(failed.error).toContain("exited");
		// Initial launch + 5 restarts; the 6th exit exceeds the consecutive cap.
		expect(readLines(fx.argsFile)).toHaveLength(6);
	}, 20_000);

	test("a pair that holds the stable window refills the restart budget", async () => {
		const crashFlag = join(tempDir("omp-session-sup-flag-"), "crash.flag");
		const fx = await makeFixture(
			"omp-session-sup-budget-",
			{ crashFlag },
			{ restartMax: 1, backoffMinMs: 20, backoffMaxMs: 50, stablePairMs: 200 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pair1 = await waitForPayload(fx.payloadFile, 1);
		await pairDaemon(fx, pair1);

		// The paired child crashes once; its restart is generation 2 and pairs.
		writeFileSync(crashFlag, "");
		const pair2 = await waitForPayload(fx.payloadFile, 2);
		await pairDaemon(fx, pair2);
		await waitFor(
			() => (fx.supervisor.snapshot()[entry.daemonId]?.restarts === 0 ? "reset" : null),
			5000,
			"stable pair refilled the restart budget",
		);
		expect(fx.registry.get(entry.daemonId)?.status).not.toBe("error");
	}, 20_000);

	test("a pair-then-crash loop exhausts the restart budget and errors", async () => {
		const crashFlag = join(tempDir("omp-session-sup-flag-"), "crash.flag");
		// The default stable window (60s) never elapses here, so each pair leaves its restart spent.
		const fx = await makeFixture(
			"omp-session-sup-loop-",
			{ crashFlag },
			{ restartMax: 2, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		for (const generation of [1, 2, 3]) {
			const pair = await waitForPayload(fx.payloadFile, generation);
			await pairDaemon(fx, pair);
			// The paired child crashes on its next tick.
			writeFileSync(crashFlag, "");
		}
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status",
		);
		expect(failed.error).toContain("exited");
		// Initial launch + 2 restarts; the 3rd crash exhausts the budget.
		expect(readLines(fx.argsFile)).toHaveLength(3);
	}, 20_000);

	test("a restart whose log cannot open fails the entry instead of throwing from the timer", async () => {
		const crashFlag = join(tempDir("omp-session-sup-logrestart-"), "crash.flag");
		const fx = await makeFixture(
			"omp-session-sup-logrestart-",
			{ crashFlag },
			{ restartMax: 3, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await pairDaemon(fx, await waitForPayload(fx.payloadFile, 1));
		// Replace the entry's log file with a directory: the restart cannot open it.
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		rmSync(logPath);
		mkdirSync(logPath);
		writeFileSync(crashFlag, "");

		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status after a failed restart",
		);
		expect(failed.error).toContain("restart failed");
		expect(failed.error).toContain("EISDIR");
	}, 20_000);

	test("an exit whose handling throws fails the entry instead of stalling it", async () => {
		const crashFlag = join(tempDir("omp-session-sup-logexit-"), "crash.flag");
		const fx = await makeFixture(
			"omp-session-sup-logexit-",
			{ crashFlag, crashExitCode: OMP_SESSION_EXIT_SESSION_LOCKED },
			{ restartMax: 3, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await pairDaemon(fx, await waitForPayload(fx.payloadFile, 1));
		// The exit reason reads the log tail, which now throws (EISDIR).
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		rmSync(logPath);
		mkdirSync(logPath);
		writeFileSync(crashFlag, "");

		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status after a throwing exit",
		);
		expect(failed.error).toContain("exit handling failed");
		expect(failed.error).toContain("EISDIR");
	}, 20_000);

	test("exit 77 (session locked) never restarts: the entry sleeps carrying the child's last log line", async () => {
		const reason =
			"session file /srv/proj/sess.jsonl is locked by another omp-session (pid 4242); it is already open elsewhere (another omp-web or dev fleet), close it there and retry";
		const events: Array<{ level: string; message: string }> = [];
		const fx = await makeFixture(
			"omp-session-sup-locked-",
			{
				stderrLines: ["booting", `omp-session: ${reason}`],
				exitCode: OMP_SESSION_EXIT_SESSION_LOCKED,
			},
			{
				restartMax: 5,
				backoffMinMs: 20,
				backoffMaxMs: 50,
				onEvent: (level, message) => events.push({ level, message }),
			},
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const asleep = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "asleep" ? current : null;
			},
			10_000,
			"asleep status",
		);
		expect(asleep.error).toBe(reason);
		expect(events.some((e) => e.level === "error" && e.message === reason)).toBe(true);
		// A restart would have been scheduled (and announced) synchronously in
		// the exit handler, before the status flipped.
		expect(events.some((e) => /restart \d+\//.test(e.message))).toBe(false);
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
	}, 20_000);

	test("exit 78 (resume failed) never restarts: the entry sleeps carrying the child's last log line", async () => {
		const reason =
			"--resume /srv/proj/s.jsonl: session switch returned false; refusing to start fresh";
		const events: Array<{ level: string; message: string }> = [];
		const fx = await makeFixture(
			"omp-session-sup-resume-failed-",
			{
				stderrLines: ["booting", `omp-session: ${reason}`],
				exitCode: OMP_SESSION_EXIT_RESUME_FAILED,
			},
			{
				restartMax: 5,
				backoffMinMs: 20,
				backoffMaxMs: 50,
				onEvent: (level, message) => events.push({ level, message }),
			},
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const asleep = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "asleep" ? current : null;
			},
			10_000,
			"asleep status",
		);
		expect(asleep.error).toBe(reason);
		expect(events.some((e) => e.level === "error" && e.message === reason)).toBe(true);
		expect(events.some((e) => /restart \d+\//.test(e.message))).toBe(false);
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
	}, 20_000);

	test("a clean exit 0 puts the entry asleep without a restart", async () => {
		const fx = await makeFixture(
			"omp-session-sup-clean-",
			{ exitCode: 0 },
			{ restartMax: 5, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitFor(
			() => (fx.registry.get(entry.daemonId)?.status === "asleep" ? "asleep" : null),
			10_000,
			"asleep status",
		);
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
	});

	test("stop on a paired child sends ShutdownControl, revokes the credential, kills the child, and sets asleep", async () => {
		const fx = await makeFixture("omp-session-sup-stop-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const pid = await waitForPid(fx.pidFile);
		const daemon = await pairDaemon(fx, pair);

		await fx.supervisor.stop(entry.daemonId);

		const shutdown = await waitFor(
			() =>
				daemon
					.received()
					.find((e) => e.streamId === CALLBACK_TRANSPORT_STREAM_ID && e.kind === "control") ?? null,
			3000,
			"ShutdownControl",
		);
		expect(shutdown.payload).toEqual({ type: "shutdown", reason: "stop" });
		const stopped = fx.registry.get(entry.daemonId)!;
		expect(stopped.status).toBe("asleep");
		expect(stopped.workspace?.enrollment).toBeUndefined();
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
		expect(isAlive(pid)).toBe(false);
	});

	test("stop cancels a scheduled restart", async () => {
		const fx = await makeFixture(
			"omp-session-sup-stoprestart-",
			{ exitCode: 1 },
			{ restartMax: 5 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		// The first child exits ~instantly and schedules a restart at >=500ms;
		// stop() within that window must cancel it.
		await waitForLaunches(fx.argsFile, 1);
		await fx.supervisor.stop(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)?.status).toBe("asleep");
		await sleep(2200); // the 1s-min backoff would have fired by now if not cancelled
		expect(readLines(fx.argsFile)).toHaveLength(1);
	});

	test("close leaves the child running and its enrollment in place", async () => {
		const fx = await makeFixture("omp-session-sup-close-", {}, { restartMax: 2 });

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const pid = await waitForPid(fx.pidFile);
		const daemon = await pairDaemon(fx, pair);

		fx.supervisor.close();
		await sleep(150);

		// Sessions outlive the control plane: the child and its pair survive
		// (the harness teardown kills the child).
		expect(isAlive(pid)).toBe(true);
		expect(daemon.connected()).toBe(true);
		expect(fx.transport.pairStatus(entry.daemonId)).toMatchObject({
			enrolled: true,
			authorizedGeneration: 1,
			paired: true,
		});
		expect(fx.registry.get(entry.daemonId)?.workspace?.enrollment?.generation).toBe(1);
	});

	test("stderrTail returns the tail of the session log file, bounded to 64 KiB", async () => {
		const projectDir = tempDir("omp-session-sup-stderr-");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				'echo "head-line"',
				"head -c 70000 /dev/zero | tr '\\0' 'a'",
				"echo",
				'echo "tail-marker" >&2',
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const { supervisor } = await makeHarness(makeConfig(script), { restartMax: 2 });
		expect(supervisor.stderrTail("d-never-spawned")).toBe("");

		const entry = await supervisor.spawn({ cwd: projectDir });
		const tail = await waitFor(
			() => {
				const text = supervisor.stderrTail(entry.daemonId);
				return text.includes("tail-marker") ? text : null;
			},
			5000,
			"log tail",
		);
		expect(tail.length).toBeLessThanOrEqual(64 * 1024);
		expect(tail).not.toContain("head-line"); // fell outside the 64 KiB tail
		expect(tail.endsWith("tail-marker\n")).toBe(true);
	});

	test("prune drops the per-daemon child state and deletes its session log", async () => {
		const fx = await makeFixture(
			"omp-session-sup-prune-",
			{ stderrLines: ["prune-boom"] },
			{ restartMax: 2 },
		);

		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitFor(
			() => (fx.supervisor.stderrTail(entry.daemonId).includes("prune-boom") ? "logged" : null),
			5000,
			"child log",
		);
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		writeFileSync(`${logPath}.1`, "rotated\n");
		expect(fx.supervisor.snapshot()[entry.daemonId]).toBeDefined();

		await fx.supervisor.prune(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)?.status).toBe("asleep");
		expect(fx.supervisor.snapshot()[entry.daemonId]).toBeUndefined();
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
		// Prune deletes the session log and its rotated generation.
		expect(fx.supervisor.stderrTail(entry.daemonId)).toBe("");
		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(`${logPath}.1`)).toBe(false);
		// The child stays dead; no restart fires from the pruned state.
		await sleep(100);
		expect(readLines(fx.argsFile)).toHaveLength(1);
	});

	test("respawn rotates an over-cap session log to <daemonId>.log.1", async () => {
		const fx = await makeFixture(
			"omp-session-sup-rotate-",
			{ stderrLines: ["rotate-boom"] },
			{ restartMax: 2 },
		);
		const entry = await fx.supervisor.spawn({ cwd: fx.dir });
		await waitFor(
			() => (fx.supervisor.stderrTail(entry.daemonId).includes("rotate-boom") ? "logged" : null),
			5000,
			"child log",
		);
		await fx.supervisor.stop(entry.daemonId);
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		const oversized = "x".repeat(1024 * 1024 + 1);
		writeFileSync(logPath, oversized);
		await fx.supervisor.respawn(fx.registry.get(entry.daemonId) ?? entry);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe(oversized);
		const relaunched = await waitFor(
			() => (fx.supervisor.stderrTail(entry.daemonId).includes("rotate-boom") ? "relogged" : null),
			5000,
			"relaunch log",
		);
		expect(relaunched).toBe("relogged");
		await fx.supervisor.stop(entry.daemonId);
	});

	test("unknown template rejects and creates nothing", async () => {
		const fx = await makeFixture("omp-session-sup-unknown-", {}, {});
		const before = fx.registry.list().length;
		await expect(fx.supervisor.spawn({ cwd: fx.dir, template: "nope" })).rejects.toThrow(
			/unknown spawn template/,
		);
		expect(fx.registry.list()).toHaveLength(before);
	});

	/** Two scripts in separate dirs (writeChildScript uses a fixed `child.sh` name per dir). */
	function tierScripts(projectDir: string): {
		argsDefault: string;
		argsOverride: string;
		scriptDefault: string;
		scriptOverride: string;
	} {
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		return {
			argsDefault,
			argsOverride,
			scriptDefault: writeChildScript(join(projectDir, "tpl-default"), argsDefault),
			scriptOverride: writeChildScript(join(projectDir, "tpl-override"), argsOverride),
		};
	}

	test("projectTemplates: basename(cwd) picks the template when init.template is absent", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		const { registry, supervisor } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir });
		const [line] = await waitForLaunches(argsOverride, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("other");
		expect(line).toBe("--fleet-stdin");
		// The default-template child must never have launched.
		expect(existsSync(argsDefault)).toBe(false);
	});

	test("init.template wins over projectTemplates", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		const { registry, supervisor } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir, template: "test" });
		await waitForLaunches(argsDefault, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("defaultTemplate applies when the project has no override", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		// The override key deliberately does not match this project's basename.
		const { registry, supervisor } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { "some-other-project": "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitForLaunches(argsDefault, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("unknown projectTemplates value rejects and creates nothing", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const script = writeChildScript(projectDir, join(projectDir, "args.txt"));
		const { registry, supervisor } = await makeHarness(
			makeTierConfig(script, script, { [basename(projectDir)]: "nope" }),
			{ restartMax: 2 },
		);
		const before = registry.list().length;
		await expect(supervisor.spawn({ cwd: projectDir })).rejects.toThrow(
			/unknown spawn template: nope/,
		);
		expect(registry.list()).toHaveLength(before);
	});

	test("resolveTemplateName: explicit → projectTemplates[basename(cwd)] → defaultTemplate; unknown names reject", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const script = writeChildScript(projectDir, join(projectDir, "args.txt")); // path only; no child runs
		const { supervisor } = await makeHarness(
			makeTierConfig(script, script, { [basename(projectDir)]: "other" }),
			{ restartMax: 0 },
		);
		// projectTemplates[basename(cwd)] wins over the default.
		expect(supervisor.resolveTemplateName(projectDir)).toBe("other");
		// Explicit wins over everything.
		expect(supervisor.resolveTemplateName(projectDir, "test")).toBe("test");
		// A cwd without an override falls back to defaultTemplate.
		expect(supervisor.resolveTemplateName("/somewhere/else")).toBe("test");
		// An unknown explicit name rejects.
		expect(() => supervisor.resolveTemplateName(projectDir, "nope")).toThrow(
			"unknown spawn template: nope",
		);
		// An unknown name resolved via the default tier rejects too.
		const missingDefault: FleetConfig = {
			templates: { test: { command: "sh /nonexistent " } },
			defaultTemplate: "missing",
			workspaceDir: "/tmp/fleet-test-ws",
			bind: "127.0.0.1",
		};
		const { supervisor: supervisor2 } = await makeHarness(missingDefault, { restartMax: 0 });
		expect(() => supervisor2.resolveTemplateName("/x")).toThrow("unknown spawn template: missing");
	});

	test("respawn of a template-less asleep entry resolves projectTemplates/defaultTemplate (asleep default workspaces are wakeable)", async () => {
		const projectDir = tempDir("omp-session-sup-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		// The project has a per-repo override; a template-less entry must
		// resolve it exactly like spawn() would.
		const { registry, supervisor } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);
		// An asleep default-workspace row persisted WITHOUT a template (a
		// state file written before entries stored the resolved name).
		const asleep = registry.create({
			name: basename(projectDir),
			cwd: projectDir,
			project: basename(projectDir),
			labels: [],
			status: "asleep",
		});
		expect(asleep.template).toBeUndefined();

		await supervisor.respawn(asleep);
		// The OVERRIDE template's child ran, never the default's; the
		// fallback resolved projectTemplates.
		expect(await waitForLaunches(argsOverride, 1)).toHaveLength(1);
		expect(existsSync(argsDefault)).toBe(false);
		// The resolved name was healed onto the entry for later respawns.
		expect(registry.get(asleep.daemonId)?.template).toBe("other");
	});
});

describe("git-state polling", () => {
	/** Supervisor with a config whose child would fail: polling tests never spawn. */
	function pollSupervisor(
		opts?: ConstructorParameters<typeof SpawnSupervisor>[3],
	): Promise<Harness> {
		return makeHarness(makeConfig("/nonexistent-child.sh"), { restartMax: 0, ...(opts ?? {}) });
	}

	test("probes local entries only on change; empty-cwd entries are never probed", async () => {
		const { registry, supervisor } = await pollSupervisor();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
			template: "test",
		});
		registry.create({
			name: "e",
			cwd: "",
			project: "",
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 25 });

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
		const { registry, supervisor, statePath } = await makeHarness(
			makeConfig("/nonexistent-child.sh"),
			{ restartMax: 0 },
		);
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 25 });

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
		const { registry, supervisor, statePath } = await makeHarness(
			makeConfig("/nonexistent-child.sh"),
			{ restartMax: 0 },
		);
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
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 25 });

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
		const { registry, supervisor, statePath } = await makeHarness(
			makeConfig("/nonexistent-child.sh"),
			{ restartMax: 0 },
		);
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
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 25 });

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
		const { registry, supervisor } = await pollSupervisor();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 250 });

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

	test("spawn() runs a one-off probe before the next poll tick", async () => {
		const fx = await makeFixture("omp-session-sup-gitone-", {}, { restartMax: 2 });
		const { registry, supervisor } = fx;
		const projectDir = fx.dir;

		const stdout = ["## main", "?? new.txt", ""].join("\n");
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 0, stderr: "", stdout },
				{ exitCode: 0, stderr: "", stdout: "7\t4\tnew.txt\n" },
			],
		]);
		// A long interval: the immediate start tick runs before the entry
		// exists, so only the spawn() one-off can probe in this window.
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		const entry = await supervisor.spawn({ cwd: projectDir });
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
		const { registry, supervisor } = await pollSupervisor({
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
			labels: [],
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
		supervisor.startGitStatePolling({ exec, intervalMs: 250 });

		await waitFor(() => (fired.length > 0 ? "fired" : null), 5000, "worktree-removed hook");
		expect(fired[0]).toMatchObject({
			daemonId: entry.daemonId,
			name: "wt",
			cwd: ghost,
			worktreeOf: "acme",
		});
		// Detection only: the supervisor itself never removes the entry, and
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
		const { registry, supervisor } = await pollSupervisor({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		const entry = registry.create({
			name: "wt",
			cwd,
			project: "acme",
			labels: [],
			template: "test",
			worktreeOf: "acme",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};
		// First pass: dirty state. Then the repo is unreadable (nonzero
		// exit), but the dir is still on disk, so this is the classic clear path.
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
		supervisor.startGitStatePolling({ exec, intervalMs: 250 });

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
		const { registry, supervisor } = await pollSupervisor({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		// No worktreeOf: a main checkout or untagged spawn. Such entries are
		// NEVER auto-evicted; only tagged linked worktrees qualify.
		registry.create({
			name: "main",
			cwd: ghost,
			project: "acme",
			labels: [],
			template: "test",
		});
		const { exec, calls } = fakeGitPhases([
			[
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
				{ exitCode: 128, stderr: "fatal: not a git repository", stdout: "" },
			],
		]);
		supervisor.startGitStatePolling({ exec, intervalMs: 25 });

		const startedAt = calls.length;
		await waitFor(() => (calls.length >= startedAt + 2 ? "ticks" : null), 5000, "poll ticks");
		expect(fired).toHaveLength(0);
		expect(registry.list().length).toBe(1); // still registered
	});
});

describe("project sync", () => {
	/** Supervisor whose child would fail: sync tests never spawn. */
	function syncHarness(): Promise<Harness> {
		return makeHarness(makeConfig("/nonexistent-child.sh"), { restartMax: 0 });
	}
	const okStatus: GitResult = { exitCode: 0, stderr: "", stdout: "## main\n" };
	const noDiff: GitResult = { exitCode: 0, stderr: "", stdout: "" };

	test("a pass registers the main checkout and each linked worktree", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-register-"));
		const { registry, supervisor } = await syncHarness();
		const { project } = registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });

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
	});

	test("prunable linked worktrees are skipped", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("omp-session-sync-prunable-"));
		rmSync(wt, { recursive: true, force: true });
		const { registry, supervisor } = await syncHarness();
		registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });

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
		const { registry, supervisor } = await syncHarness();
		registry.addProject(main);
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });

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
		const { registry, supervisor } = await syncHarness();
		registry.addProject(main);
		rmSync(main, { recursive: true, force: true });
		const { exec } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });

		await waitFor(
			() => (registry.projects()[0]?.missing === true ? true : null),
			5000,
			"missing flag",
		);
		expect(registry.projects()).toHaveLength(1);
	});

	test("syncNow coalesces requests that arrive during a pass into one follow-up pass", async () => {
		const dir = tempDir("omp-session-sync-coalesce-");
		const { registry, supervisor } = await syncHarness();
		registry.create({ name: "r", cwd: dir, project: "r", labels: [], status: "ready" });
		const { exec, calls } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		supervisor.syncNow();
		supervisor.syncNow();

		// One probe is one git call (clean status: no numstat): the first pass
		// plus exactly one follow-up.
		await waitFor(() => (calls.length >= 2 ? true : null), 5000, "two passes");
		await sleep(100);
		expect(calls).toHaveLength(2);
	});

	test("passes never overlap: git calls from one pass finish before the next pass starts", async () => {
		const dir = tempDir("omp-session-sync-overlap-");
		const { registry, supervisor } = await syncHarness();
		registry.create({ name: "o", cwd: dir, project: "o", labels: [], status: "ready" });
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
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		supervisor.syncNow();
		supervisor.syncNow();
		await waitFor(() => (calls.length >= 2 ? true : null), 5000, "two passes");
		await sleep(100);
		expect(maxInFlight).toBe(1);
		expect(calls).toHaveLength(2);
	});

	test("asleep rows are probed at most once per 60s; live rows on every pass", async () => {
		const asleepDir = tempDir("omp-session-sync-asleep-");
		const liveDir = tempDir("omp-session-sync-live-");
		const { registry, supervisor } = await syncHarness();
		registry.create({ name: "a", cwd: asleepDir, project: "a", labels: [], status: "asleep" });
		registry.create({ name: "l", cwd: liveDir, project: "l", labels: [], status: "ready" });
		const { exec, calls } = fakeGitPhases([[okStatus, noDiff]]);
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		await waitFor(() => (calls.length === 2 ? true : null), 5000, "first pass");

		supervisor.syncNow();
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
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
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
			labels: [],
			status: "ready",
			lastSessionFile: sessionFile,
		});
		const failing: GitRunner = async () => ({ exitCode: 128, stderr: "not a repo", stdout: "" });
		supervisor.startGitStatePolling({ exec: failing, intervalMs: 60_000 });
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
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const row = registry.create({
			name: "c",
			cwd: volume,
			project: "c",
			labels: [],
			status: "ready",
			workspace: { kind: "clone", projectId: "p1", desiredState: "running" },
		});
		const calls: GitCall[] = [];
		const exec: GitRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return okStatus;
		};
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
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
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const row = registry.create({
			name: "e",
			cwd: volume,
			project: "e",
			labels: [],
			status: "ready",
			workspace: { kind: "clone", projectId: "p1", desiredState: "running" },
		});
		const calls: GitCall[] = [];
		const exec: GitRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return okStatus;
		};
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		await sleep(200);
		expect(calls).toHaveLength(0);
		expect(registry.get(row.daemonId)?.branch).toBeUndefined();
	});

	test("a sync pass probes rows concurrently, bounded at 4 in flight", async () => {
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		for (let i = 0; i < 6; i++) {
			const dir = tempDir(`omp-session-sup-conc-${i}-`);
			registry.create({ name: `c${i}`, cwd: dir, project: `c${i}`, labels: [], status: "ready" });
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
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
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
		const { registry, supervisor } = await makeHarness(makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const row = registry.create({ name: "s", cwd: dir, project: "s", labels: [], status: "ready" });
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
		supervisor.startGitStatePolling({ exec, intervalMs: 60_000 });
		supervisor.probeGitState(row.daemonId);
		supervisor.syncNow();
		await waitFor(
			() => (registry.get(row.daemonId)?.branch === "main" ? true : null),
			5000,
			"row probed",
		);
		await sleep(100);
		expect(maxSameRow).toBe(1);
	});
});
