/**
 * Host runtime tests: the lifecycle's host section (WorkspaceLifecycle over
 * the in-process HostRuntimeProvider) driving main-checkout and worktree
 * sessions. A FAKE child script (sh) stands in for omp-session: it appends
 * its argv (the template-filled --fleet-stdin / labels / resume args) to a
 * file and captures the fleet stdin payload (the callback pair) to another,
 * optionally logs to stderr, then exits or idles. A real
 * DaemonTransportRegistry served over loopback HTTP receives the dial; tests
 * that need a live pair start the callback-daemon testkit with the pair the
 * child was launched with. Covers spawn (generation, stdin payload, no secret
 * on the entry or in argv/env), pair timeout, respawn (generation bump,
 * --resume), stop (ShutdownControl, revoke, asleep), close (children and
 * enrollments survive), exit policy (77, 78, 0, bounded restarts, pair
 * resets the budget, a lifecycle `runtime` override applies), the session log
 * tail, delete, template resolution, and boot reconciliation of rows a
 * previous fleet process left running. Git-state polling and project sync
 * live in project-sync.test.ts; the provider's own mechanics in
 * host-provider.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Server } from "bun";
import { CALLBACK_TRANSPORT_STREAM_ID } from "#lib/wire/callback-protocol";
import {
	OMP_SESSION_EXIT_RESUME_FAILED,
	OMP_SESSION_EXIT_SESSION_LOCKED,
} from "#lib/wire/protocol";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry, type FleetSocketData } from "../daemon-transport";
import type { FleetEventLog } from "../events";
import { Registry, type RegistryEntry } from "../registry";
import type { WorkspaceLifecycle, CloneRuntimePolicy } from "../workspace-lifecycle";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";

afterAll(cleanupTempDirs);

// Every fixture a test creates registers its teardown here so it runs even
// when a test fails mid-body (the children are real processes). Cleanups run
// in reverse creation order: daemons first, then the lifecycle's children,
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

/** The stdin payload the lifecycle hands a `--fleet-stdin` child; one JSON object per launch. */
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
	// cat ends at the lifecycle's stdin EOF; the echo terminates the JSON line.
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
	lifecycle: WorkspaceLifecycle;
	eventLog: FleetEventLog;
	statePath: string;
	/** The base URL the callback daemon testkit dials (no /callback suffix). */
	base: string;
	/** The callback URL the child receives in its stdin payload. */
	callbackUrl: string;
}

interface HarnessDeps {
	pairTimeoutMs?: number;
	onEnrolled?: (daemonId: string) => void;
}

/**
 * A host lifecycle over a real registry and a real DaemonTransportRegistry
 * served on an ephemeral loopback port. Teardown stops every entry (killing
 * its child, which close() deliberately leaves running), then closes the
 * lifecycle, the transport, and the server.
 */
async function makeHarness(
	config: FleetConfig,
	runtime?: Partial<CloneRuntimePolicy>,
	deps?: HarnessDeps,
): Promise<Harness> {
	const statePath = join(tempDir("host-lifecycle-state-"), "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new DaemonTransportRegistry();
	const server: Server<FleetSocketData> = Bun.serve<FleetSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req, srv) => {
			const handled = await transport.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
		websocket: transport.websocket,
	});
	const base = `http://127.0.0.1:${server.port}`;
	const callbackUrl = `${base}/callback`;
	const { lifecycle, eventLog } = makeHostLifecycle({
		registry,
		config,
		transport,
		statePath,
		callbackUrl: () => callbackUrl,
		...(runtime !== undefined ? { runtime } : {}),
		...deps,
	});
	cleanups.push(async () => {
		for (const entry of registry.list()) {
			// A clone's runtime goes through the clone lifecycle, never the host verbs.
			if (entry.workspace?.kind !== "clone") await lifecycle.stop(entry.daemonId);
		}
		lifecycle.close();
		transport.close();
		await server.stop(true);
	});
	return { registry, transport, lifecycle, eventLog, statePath, base, callbackUrl };
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
	runtime?: Partial<CloneRuntimePolicy>,
	deps?: HarnessDeps,
): Promise<Fixture> {
	const dir = tempDir(prefix);
	const argsFile = join(dir, "args.txt");
	const envFile = join(dir, "env.txt");
	const pidFile = join(dir, "pid.txt");
	const payloadFile = join(dir, "payload.txt");
	const script = writeChildScript(dir, argsFile, { envFile, pidFile, payloadFile, ...child });
	const harness = await makeHarness(makeConfig(script), runtime, deps);
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

describe("host runtime", () => {
	test("spawn tags worktreeOf for a worktree cwd; a main checkout stays untagged", async () => {
		const { main, wt } = makeWorktreeRepo(tempDir("host-lifecycle-wt-"));
		const fx = await makeFixture("host-lifecycle-wt-child-", {}, { restartMax: 0 });

		const wtEntry = await fx.lifecycle.spawnHost({ cwd: wt });
		expect(wtEntry.worktreeOf).toBe("main-repo");
		const mainEntry = await fx.lifecycle.spawnHost({ cwd: main });
		expect(mainEntry.worktreeOf).toBeUndefined();
	});

	test("spawn enrolls generation 1 and launches the child with a stdin payload; the entry holds no secret", async () => {
		const enrolled: string[] = [];
		const fx = await makeFixture(
			"host-lifecycle-env-",
			{},
			{ restartMax: 2 },
			{ onEnrolled: (daemonId) => enrolled.push(daemonId) },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir, labels: ["env=prod"] });
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
		const fx = await makeFixture("host-lifecycle-pair-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const daemon = await pairDaemon(fx, pair);

		expect(daemon.connected()).toBe(true);
		expect(fx.transport.pairStatus(entry.daemonId)).toMatchObject({
			enrolled: true,
			authorizedGeneration: 1,
			paired: true,
		});
		expect(fx.lifecycle.hostSnapshot()[entry.daemonId]?.restarts).toBe(0);
	});

	test("no pair within pairTimeoutMs errors the entry, revokes the credential, and kills the child", async () => {
		const fx = await makeFixture(
			"host-lifecycle-timeout-",
			{},
			{ restartMax: 2 },
			{ pairTimeoutMs: 200 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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

	test("hostSnapshot exposes pid and restarts for a live spawned child", async () => {
		const fx = await makeFixture("host-lifecycle-snap-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForPayload(fx.payloadFile, 1);
		const snap = fx.lifecycle.hostSnapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(0);
		expect(typeof snap?.pid).toBe("number");
	});

	test("hostSnapshot reports restart-budget use and no live pid after the budget is exhausted", async () => {
		const fx = await makeFixture(
			"host-lifecycle-snapfail-",
			{ exitCode: 1 },
			{ restartMax: 1, backoffMinMs: 20, backoffMaxMs: 40 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitFor(
			() => (fx.registry.get(entry.daemonId)?.status === "error" ? "error" : null),
			10_000,
			"error status",
		);
		const snap = fx.lifecycle.hostSnapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(1); // one restart consumed before the cap hit
		expect(snap?.pid).toBeUndefined(); // no live child
	});

	test("host events reach the event log: spawn, exit/restart, and budget exhaustion", async () => {
		const fx = await makeFixture(
			"host-lifecycle-events-",
			{ exitCode: 1 },
			{ restartMax: 1, backoffMinMs: 20, backoffMaxMs: 40 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitFor(
			() => (fx.registry.get(entry.daemonId)?.status === "error" ? "error" : null),
			10_000,
			"error status",
		);
		expect(
			fx.eventLog
				.list()
				.some(
					(event) =>
						event.daemonId === entry.daemonId && event.message.startsWith("spawn template="),
				),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some(
					(event) => event.daemonId === entry.daemonId && event.message.includes("exit code=1"),
				),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some((event) => event.level === "warn" && event.message.includes("restart 1/1")),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some(
					(event) => event.level === "error" && event.message.includes("restart budget exhausted"),
				),
		).toBe(true);
	});

	test("host events reach the event log: respawn, replaced-exit, stop, and delete", async () => {
		const fx = await makeFixture("host-lifecycle-events2-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForPayload(fx.payloadFile, 1);
		await fx.lifecycle.start(entry.daemonId);
		await waitForPayload(fx.payloadFile, 2);
		await fx.lifecycle.delete(entry.daemonId);
		await waitFor(
			() =>
				fx.eventLog
					.list()
					.some(
						(event) =>
							event.message.startsWith("exit code=") && event.message.includes("(replaced)"),
					)
					? "replaced-exit"
					: null,
			3000,
			"replaced exit event",
		);
		expect(
			fx.eventLog
				.list()
				.some((event) => event.daemonId === entry.daemonId && event.message.startsWith("respawn")),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some((event) => event.daemonId === entry.daemonId && event.message.startsWith("stop (")),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some((event) => event.daemonId === entry.daemonId && event.message === "delete"),
		).toBe(true);
	});

	test("respawn bumps the generation to 2 with a fresh credential and the daemon pairs at it", async () => {
		const fx = await makeFixture("host-lifecycle-regen-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair1 = await waitForPayload(fx.payloadFile, 1);
		const first = await pairDaemon(fx, pair1);

		await fx.lifecycle.start(entry.daemonId);
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
		const fx = await makeFixture("host-lifecycle-resume-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		await fx.lifecycle.start(entry.daemonId);
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
		const fx = await makeFixture("host-lifecycle-resumefile-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		// Dropdown-picked session: the lifecycle takes the file verbatim (the
		// edge validates membership); this test proves the argv actually carries
		// the chosen path rather than the entry's lastSessionFile.
		await fx.lifecycle.start(entry.daemonId, {
			resume: "/chosen/other-session.jsonl",
		});
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("--resume /chosen/other-session.jsonl");
		expect(lines[1]).not.toContain("/srv/proj/sess.jsonl");
		expect(lines[1]).not.toContain("--resume-unwritten");
	});

	test("respawn of a lastSessionFile the fleet never saw persisted resumes leniently (--resume-unwritten)", async () => {
		const fx = await makeFixture("host-lifecycle-unknown-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		await fx.lifecycle.start(entry.daemonId);
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl --resume-unwritten");
	});

	test("respawn of a lastSessionFile the daemon reported persisted resumes strictly (plain --resume)", async () => {
		const fx = await makeFixture("host-lifecycle-persisted-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitForLaunches(fx.argsFile, 1);
		fx.registry.update(entry.daemonId, {
			lastSessionFile: "/srv/proj/sess.jsonl",
			lastSessionPersisted: true,
		});

		await fx.lifecycle.start(entry.daemonId);
		const lines = await waitForLaunches(fx.argsFile, 2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl");
		expect(lines[1]).not.toContain("--resume-unwritten");
	});

	test("respawn of a template-less asleep entry falls back to spawn's resolution and heals the entry", async () => {
		// Regression: entries registered asleep without a template (the auto
		// default workspace, unstarted worktrees, or pre-fix state files) must
		// be wakeable, since respawn used to key off entry.template only and throw
		// "unknown spawn template: undefined", wedging the row asleep.
		const fx = await makeFixture("host-lifecycle-notpl-", {}, { restartMax: 2 });

		const entry = fx.registry.create({
			name: "placeholder",
			cwd: fx.dir,
			project: "placeholder",
			labels: [],
			status: "asleep",
		});
		expect(entry.template).toBeUndefined();

		await fx.lifecycle.start(entry.daemonId);
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
		const fx = await makeFixture("host-lifecycle-reuse-", {}, { restartMax: 2 });
		const asleep = fx.registry.create({
			name: "checkout",
			cwd: fx.dir,
			project: "checkout",
			labels: [],
			status: "asleep",
		});

		const reused = await fx.lifecycle.spawnHost({ cwd: fx.dir, reuse: true });
		expect(reused.daemonId).toBe(asleep.daemonId);
		expect(fx.registry.list()).toHaveLength(1);
		await waitForLaunches(fx.argsFile, 1); // the asleep row was woken

		// Several sessions per folder stay a deliberate CLI capability.
		const extra = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		expect(extra.daemonId).not.toBe(asleep.daemonId);
		expect(fx.registry.list()).toHaveLength(2);
	});

	test("respawn of an adopted row whose session still holds its lock refuses to launch a second child", async () => {
		// An adopted row has no child handle: the held lock stands in for a live
		// session this lifecycle did not launch.
		const lastSessionFile = join(tempDir("host-lifecycle-adopt-"), "session.jsonl");
		writeFileSync(
			`${lastSessionFile}.lock`,
			`${JSON.stringify({ pid: process.pid, name: "adopted-holder", startedAt: 0 })}\n`,
		);
		const fx = await makeFixture("host-lifecycle-adopt-", {}, { restartMax: 2 });
		const adopted = fx.registry.create({
			name: "adopted",
			cwd: fx.dir,
			project: "adopted",
			labels: [],
			status: "reconnecting",
			lastSessionFile,
		});

		await expect(fx.lifecycle.start(adopted.daemonId)).rejects.toThrow("still holds its lock");
		expect(existsSync(fx.argsFile)).toBe(false);
	}, 20_000);

	test("spawn shell-quotes label/name values, a $(touch) payload stays inert", async () => {
		const fx = await makeFixture("host-lifecycle-quote-", {}, { restartMax: 2 });

		const pwn = join(fx.dir, "pwned");
		await fx.lifecycle.spawnHost({
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
		const projectDir = tempDir("host-lifecycle-roundtrip-");
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
		const { lifecycle } = await makeHarness(config, { restartMax: 2 });

		const trickyName = "na'me $(nope) `nope` with spaces\nand a newline";
		const pwn = join(projectDir, "pwned");
		await lifecycle.spawnHost({
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
		const projectDir = tempDir("host-lifecycle-conc-");
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
		const { registry, lifecycle } = await makeHarness(makeConfig(script), { restartMax: 2 });

		const entry = await lifecycle.spawnHost({ cwd: projectDir });
		await waitForLaunches(argsFile, 1);
		registry.update(entry.daemonId, { lastSessionFile: "/srv/proj/sess.jsonl" });

		// Two overlapping respawns (no await between the calls): both must
		// coalesce onto ONE launch. Exactly one replacement child is launched,
		// and the original is terminated rather than orphaned.
		await Promise.all([lifecycle.start(entry.daemonId), lifecycle.start(entry.daemonId)]);
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
		await lifecycle.stop(entry.daemonId);
		for (const pid of pids) expect(isAlive(pid)).toBe(false);
	});

	test("restart-on-failure: bounded restarts, a fresh generation and credential per attempt, then error", async () => {
		// restartMax 1: initial child + exactly one restart, then error.
		const fx = await makeFixture("host-lifecycle-restart-", { exitCode: 1 }, { restartMax: 1 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
			"host-lifecycle-budgetfail-",
			{ exitCode: 1 },
			{ restartMax: 5, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
		const crashFlag = join(tempDir("host-lifecycle-flag-"), "crash.flag");
		const fx = await makeFixture(
			"host-lifecycle-budget-",
			{ crashFlag },
			{ restartMax: 1, backoffMinMs: 20, backoffMaxMs: 50, stablePairMs: 200 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair1 = await waitForPayload(fx.payloadFile, 1);
		await pairDaemon(fx, pair1);

		// The paired child crashes once; its restart is generation 2 and pairs.
		writeFileSync(crashFlag, "");
		const pair2 = await waitForPayload(fx.payloadFile, 2);
		await pairDaemon(fx, pair2);
		await waitFor(
			() => (fx.lifecycle.hostSnapshot()[entry.daemonId]?.restarts === 0 ? "reset" : null),
			5000,
			"stable pair refilled the restart budget",
		);
		expect(fx.registry.get(entry.daemonId)?.status).not.toBe("error");
	}, 20_000);

	test("a pair-then-crash loop exhausts the restart budget and errors", async () => {
		const crashFlag = join(tempDir("host-lifecycle-flag-"), "crash.flag");
		// The default stable window (60s) never elapses here, so each pair leaves its restart spent.
		const fx = await makeFixture(
			"host-lifecycle-loop-",
			{ crashFlag },
			{ restartMax: 2, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
		const crashFlag = join(tempDir("host-lifecycle-logrestart-"), "crash.flag");
		const fx = await makeFixture(
			"host-lifecycle-logrestart-",
			{ crashFlag },
			{ restartMax: 3, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
		expect(failed.error).toContain("spawn failed");
		expect(failed.error).toContain("EISDIR");
	}, 20_000);

	test("an exit whose handling throws fails the entry instead of stalling it", async () => {
		const crashFlag = join(tempDir("host-lifecycle-logexit-"), "crash.flag");
		const fx = await makeFixture(
			"host-lifecycle-logexit-",
			{ crashFlag, crashExitCode: OMP_SESSION_EXIT_SESSION_LOCKED },
			{ restartMax: 3, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
		const fx = await makeFixture(
			"host-lifecycle-locked-",
			{
				stderrLines: ["booting", `omp-session: ${reason}`],
				exitCode: OMP_SESSION_EXIT_SESSION_LOCKED,
			},
			{
				restartMax: 5,
				backoffMinMs: 20,
				backoffMaxMs: 50,
			},
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const asleep = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "asleep" ? current : null;
			},
			10_000,
			"asleep status",
		);
		expect(asleep.error).toBe(reason);
		expect(fx.eventLog.list().some((e) => e.level === "error" && e.message === reason)).toBe(true);
		// A restart would have been scheduled (and announced) synchronously in
		// the exit handler, before the status flipped.
		expect(fx.eventLog.list().some((e) => /restart \d+\//.test(e.message))).toBe(false);
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
	}, 20_000);

	test("exit 78 (resume failed) never restarts: the entry sleeps carrying the child's last log line", async () => {
		const reason =
			"--resume /srv/proj/s.jsonl: session switch returned false; refusing to start fresh";
		const fx = await makeFixture(
			"host-lifecycle-resume-failed-",
			{
				stderrLines: ["booting", `omp-session: ${reason}`],
				exitCode: OMP_SESSION_EXIT_RESUME_FAILED,
			},
			{
				restartMax: 5,
				backoffMinMs: 20,
				backoffMaxMs: 50,
			},
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const asleep = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "asleep" ? current : null;
			},
			10_000,
			"asleep status",
		);
		expect(asleep.error).toBe(reason);
		expect(fx.eventLog.list().some((e) => e.level === "error" && e.message === reason)).toBe(true);
		expect(fx.eventLog.list().some((e) => /restart \d+\//.test(e.message))).toBe(false);
		await sleep(150);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
	}, 20_000);

	test("a clean exit 0 puts the entry asleep without a restart", async () => {
		const fx = await makeFixture(
			"host-lifecycle-clean-",
			{ exitCode: 0 },
			{ restartMax: 5, backoffMinMs: 20, backoffMaxMs: 50 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
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
		const fx = await makeFixture("host-lifecycle-stop-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const pid = await waitForPid(fx.pidFile);
		const daemon = await pairDaemon(fx, pair);

		await fx.lifecycle.stop(entry.daemonId);

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
		const fx = await makeFixture("host-lifecycle-stoprestart-", { exitCode: 1 }, { restartMax: 5 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		// The first child exits ~instantly and schedules a restart at >=500ms;
		// stop() within that window must cancel it.
		await waitForLaunches(fx.argsFile, 1);
		await fx.lifecycle.stop(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)?.status).toBe("asleep");
		await sleep(2200); // the 1s-min backoff would have fired by now if not cancelled
		expect(readLines(fx.argsFile)).toHaveLength(1);
	});

	test("a stop that fails still flips the row to asleep before the error surfaces (never left ready over a dead child)", async () => {
		const fx = await makeFixture("host-lifecycle-stopfail-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		await pairDaemon(fx, pair);
		fx.registry.setStatus(entry.daemonId, "ready");
		// The shutdown request reads the pair state first; making that throw fails the stop for real.
		const pairStatus = fx.transport.pairStatus.bind(fx.transport);
		fx.transport.pairStatus = () => {
			throw new Error("stop boom");
		};
		try {
			await expect(fx.lifecycle.stop(entry.daemonId)).rejects.toThrow("stop boom");
		} finally {
			fx.transport.pairStatus = pairStatus;
		}
		expect(fx.registry.get(entry.daemonId)?.status).toBe("asleep");
		// The failed stop left the child up; a later stop ends it.
		await fx.lifecycle.stop(entry.daemonId);
	});

	test("close leaves the child running and its enrollment in place", async () => {
		const fx = await makeFixture("host-lifecycle-close-", {}, { restartMax: 2 });

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const pair = await waitForPayload(fx.payloadFile, 1);
		const pid = await waitForPid(fx.pidFile);
		const daemon = await pairDaemon(fx, pair);

		fx.lifecycle.close();
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

	test("sessionLogTail returns the tail of the session log file, bounded to 64 KiB", async () => {
		const projectDir = tempDir("host-lifecycle-stderr-");
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
		const { lifecycle } = await makeHarness(makeConfig(script), { restartMax: 2 });
		expect(lifecycle.sessionLogTail("d-never-spawned")).toBe("");

		const entry = await lifecycle.spawnHost({ cwd: projectDir });
		const tail = await waitFor(
			() => {
				const text = lifecycle.sessionLogTail(entry.daemonId);
				return text.includes("tail-marker") ? text : null;
			},
			5000,
			"log tail",
		);
		expect(tail.length).toBeLessThanOrEqual(64 * 1024);
		expect(tail).not.toContain("head-line"); // fell outside the 64 KiB tail
		expect(tail.endsWith("tail-marker\n")).toBe(true);
	});

	test("delete drops the per-daemon runtime state and deletes its session log", async () => {
		const fx = await makeFixture(
			"host-lifecycle-delete-",
			{ stderrLines: ["delete-boom"] },
			{ restartMax: 2 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitFor(
			() => (fx.lifecycle.sessionLogTail(entry.daemonId).includes("delete-boom") ? "logged" : null),
			5000,
			"child log",
		);
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		writeFileSync(`${logPath}.1`, "rotated\n");
		expect(fx.lifecycle.hostSnapshot()[entry.daemonId]).toBeDefined();

		await fx.lifecycle.delete(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)?.status).toBe("asleep");
		expect(fx.lifecycle.hostSnapshot()[entry.daemonId]).toBeUndefined();
		expect(fx.transport.pairStatus(entry.daemonId).enrolled).toBe(false);
		// Delete removes the session log and its rotated generation.
		expect(fx.lifecycle.sessionLogTail(entry.daemonId)).toBe("");
		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(`${logPath}.1`)).toBe(false);
		// The child stays dead; no restart fires from the deleted state.
		await sleep(100);
		expect(readLines(fx.argsFile)).toHaveLength(1);
	});

	test("respawn rotates an over-cap session log to <daemonId>.log.1", async () => {
		const fx = await makeFixture(
			"host-lifecycle-rotate-",
			{ stderrLines: ["rotate-boom"] },
			{ restartMax: 2 },
		);
		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		await waitFor(
			() => (fx.lifecycle.sessionLogTail(entry.daemonId).includes("rotate-boom") ? "logged" : null),
			5000,
			"child log",
		);
		await fx.lifecycle.stop(entry.daemonId);
		const logPath = join(dirname(fx.statePath), "session-logs", `${entry.daemonId}.log`);
		const oversized = "x".repeat(1024 * 1024 + 1);
		writeFileSync(logPath, oversized);
		await fx.lifecycle.start(entry.daemonId);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe(oversized);
		const relaunched = await waitFor(
			() =>
				fx.lifecycle.sessionLogTail(entry.daemonId).includes("rotate-boom") ? "relogged" : null,
			5000,
			"relaunch log",
		);
		expect(relaunched).toBe("relogged");
		await fx.lifecycle.stop(entry.daemonId);
	});

	test("unknown template rejects and creates nothing", async () => {
		const fx = await makeFixture("host-lifecycle-unknown-", {}, {});
		const before = fx.registry.list().length;
		await expect(fx.lifecycle.spawnHost({ cwd: fx.dir, template: "nope" })).rejects.toThrow(
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
		const projectDir = tempDir("host-lifecycle-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		const { registry, lifecycle } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await lifecycle.spawnHost({ cwd: projectDir });
		const [line] = await waitForLaunches(argsOverride, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("other");
		expect(line).toBe("--fleet-stdin");
		// The default-template child must never have launched.
		expect(existsSync(argsDefault)).toBe(false);
	});

	test("init.template wins over projectTemplates", async () => {
		const projectDir = tempDir("host-lifecycle-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		const { registry, lifecycle } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await lifecycle.spawnHost({ cwd: projectDir, template: "test" });
		await waitForLaunches(argsDefault, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("defaultTemplate applies when the project has no override", async () => {
		const projectDir = tempDir("host-lifecycle-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		// The override key deliberately does not match this project's basename.
		const { registry, lifecycle } = await makeHarness(
			makeTierConfig(scriptDefault, scriptOverride, { "some-other-project": "other" }),
			{ restartMax: 2 },
		);

		const entry = await lifecycle.spawnHost({ cwd: projectDir });
		await waitForLaunches(argsDefault, 1);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("unknown projectTemplates value rejects and creates nothing", async () => {
		const projectDir = tempDir("host-lifecycle-proj-");
		const script = writeChildScript(projectDir, join(projectDir, "args.txt"));
		const { registry, lifecycle } = await makeHarness(
			makeTierConfig(script, script, { [basename(projectDir)]: "nope" }),
			{ restartMax: 2 },
		);
		const before = registry.list().length;
		await expect(lifecycle.spawnHost({ cwd: projectDir })).rejects.toThrow(
			/unknown spawn template: nope/,
		);
		expect(registry.list()).toHaveLength(before);
	});

	test("resolveTemplateName: explicit → projectTemplates[basename(cwd)] → defaultTemplate; unknown names reject", async () => {
		const projectDir = tempDir("host-lifecycle-proj-");
		const script = writeChildScript(projectDir, join(projectDir, "args.txt")); // path only; no child runs
		const { lifecycle } = await makeHarness(
			makeTierConfig(script, script, { [basename(projectDir)]: "other" }),
			{ restartMax: 0 },
		);
		// projectTemplates[basename(cwd)] wins over the default.
		expect(lifecycle.resolveTemplateName(projectDir)).toBe("other");
		// Explicit wins over everything.
		expect(lifecycle.resolveTemplateName(projectDir, "test")).toBe("test");
		// A cwd without an override falls back to defaultTemplate.
		expect(lifecycle.resolveTemplateName("/somewhere/else")).toBe("test");
		// An unknown explicit name rejects.
		expect(() => lifecycle.resolveTemplateName(projectDir, "nope")).toThrow(
			"unknown spawn template: nope",
		);
		// An unknown name resolved via the default tier rejects too.
		const missingDefault: FleetConfig = {
			templates: { test: { command: "sh /nonexistent " } },
			defaultTemplate: "missing",
			workspaceDir: "/tmp/fleet-test-ws",
			bind: "127.0.0.1",
		};
		const { lifecycle: lifecycle2 } = await makeHarness(missingDefault, { restartMax: 0 });
		expect(() => lifecycle2.resolveTemplateName("/x")).toThrow("unknown spawn template: missing");
	});

	test("respawn of a template-less asleep entry resolves projectTemplates/defaultTemplate (asleep default workspaces are wakeable)", async () => {
		const projectDir = tempDir("host-lifecycle-proj-");
		const { argsDefault, argsOverride, scriptDefault, scriptOverride } = tierScripts(projectDir);
		// The project has a per-repo override; a template-less entry must
		// resolve it exactly like spawn() would.
		const { registry, lifecycle } = await makeHarness(
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

		await lifecycle.start(asleep.daemonId);
		// The OVERRIDE template's child ran, never the default's; the
		// fallback resolved projectTemplates.
		expect(await waitForLaunches(argsOverride, 1)).toHaveLength(1);
		expect(existsSync(argsDefault)).toBe(false);
		// The resolved name was healed onto the entry for later respawns.
		expect(registry.get(asleep.daemonId)?.template).toBe("other");
	});
});

describe("host restart policy is the lifecycle's runtime policy", () => {
	test("a runtime restartMax of 0 errors the row on the first crash, with no restart", async () => {
		const fx = await makeFixture(
			"host-lifecycle-policy0-",
			{ exitCode: 1 },
			{ restartMax: 0, backoffMinMs: 20, backoffMaxMs: 40 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status",
		);
		expect(failed.error).toContain("child exited (exit code=1)");
		expect(failed.error).toContain("restart budget exhausted (0 restarts allowed");
		expect(failed.lifecycleStage).toBe("failed");
		expect(failed.lifecycleError).toBe(failed.error);
		expect(readLines(fx.argsFile)).toHaveLength(1);
		expect(
			fx.eventLog
				.list()
				.some((event) => event.level === "error" && event.message.includes("(0 restarts allowed")),
		).toBe(true);
	});

	test("a runtime restartMax of 2 and its backoff bound the restarts of a host crash loop", async () => {
		const fx = await makeFixture(
			"host-lifecycle-policy2-",
			{ exitCode: 1 },
			{ restartMax: 2, backoffMinMs: 20, backoffMaxMs: 40 },
		);

		const entry = await fx.lifecycle.spawnHost({ cwd: fx.dir });
		const failed = await waitFor(
			() => {
				const current = fx.registry.get(entry.daemonId);
				return current?.status === "error" ? current : null;
			},
			10_000,
			"error status",
		);
		expect(failed.error).toContain("restart budget exhausted (2 restarts allowed");
		expect(failed.lifecycleStage).toBe("failed");
		// Initial launch + the 2 restarts the override allows (the default would allow 5).
		expect(readLines(fx.argsFile)).toHaveLength(3);
		const restarts = fx.eventLog
			.list()
			.filter((event) => event.level === "warn" && /restart \d\/2 in \d+ms/.test(event.message));
		expect(restarts).toHaveLength(2);
		// The backoff override caps every delay (jittered up to 1.5x the 40ms ceiling).
		for (const event of restarts) {
			const delay = Number(/in (\d+)ms/.exec(event.message)?.[1]);
			expect(delay).toBeLessThanOrEqual(60);
		}
	}, 20_000);
});

describe("host boot reconciliation", () => {
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

	interface SeedRow {
		status: RegistryEntry["status"];
		/** Holds a persisted callback enrollment (digest only), as after a fleet restart. */
		enrolled: boolean;
		lastSessionFile?: string;
		pid?: number;
	}

	/** A host row as a previous fleet process left it: stale readyAt and pid facts included. */
	function seedHostRow(fx: Harness, name: string, row: SeedRow): RegistryEntry {
		const entry = fx.registry.create({
			name,
			cwd: tempDir("host-lifecycle-boot-cwd-"),
			project: "boot",
			labels: [],
			template: "test",
			status: row.status,
			readyAt: Date.now() - 60_000,
			...(row.lastSessionFile !== undefined ? { lastSessionFile: row.lastSessionFile } : {}),
			...(row.pid !== undefined ? { pid: row.pid } : {}),
		});
		if (row.enrolled) {
			fx.registry.setWorkspaceEnrollment(entry.daemonId, {
				credentialHash: "a".repeat(64),
				generation: 1,
			});
		}
		return fx.registry.get(entry.daemonId)!;
	}

	function sessionFileWithLock(holderPid: number | null): string {
		const file = join(tempDir("host-lifecycle-boot-"), "session.jsonl");
		if (holderPid !== null) {
			writeFileSync(
				`${file}.lock`,
				`${JSON.stringify({ pid: holderPid, name: "boot-holder", startedAt: 0 })}\n`,
			);
		}
		return file;
	}

	function bootHarness(): Promise<Harness> {
		return makeHarness(makeConfig("/nonexistent-child.sh"), { restartMax: 0 });
	}

	test("an enrolled ready/connecting row whose lock is free or stale, or whose recorded pid is dead, becomes asleep", async () => {
		const fx = await bootHarness();
		const stale = seedHostRow(fx, "stale-lock", {
			status: "ready",
			enrolled: true,
			lastSessionFile: sessionFileWithLock(deadPid),
			pid: process.pid,
		});
		const free = seedHostRow(fx, "free-lock", {
			status: "connecting",
			enrolled: true,
			lastSessionFile: sessionFileWithLock(null),
			pid: process.pid,
		});
		const deadRecorded = seedHostRow(fx, "dead-pid", {
			status: "ready",
			enrolled: true,
			pid: deadPid,
		});
		const spawning = seedHostRow(fx, "spawning", {
			status: "spawning",
			enrolled: true,
			lastSessionFile: sessionFileWithLock(deadPid),
		});

		expect(fx.lifecycle.reconcileHostBoot()).toEqual([]);

		for (const seeded of [stale, free, deadRecorded, spawning]) {
			const row = fx.registry.get(seeded.daemonId)!;
			expect(row.status).toBe("asleep");
			expect(row.readyAt).toBeUndefined();
			expect(row.pid).toBeUndefined();
		}
		expect(
			fx.eventLog
				.list()
				.some(
					(event) =>
						event.daemonId === stale.daemonId &&
						event.message === "boot reconcile: ready → asleep (local session dead)",
				),
		).toBe(true);
		// Reconciliation only reads liveness: no child was launched.
		expect(fx.lifecycle.hostSnapshot()).toEqual({});
	});

	test("an enrolled row with a held lock or unknown liveness stays reconnecting and is returned", async () => {
		const fx = await bootHarness();
		const held = seedHostRow(fx, "held-lock", {
			status: "ready",
			enrolled: true,
			lastSessionFile: sessionFileWithLock(process.pid),
			pid: deadPid, // a held lock outranks a dead recorded pid
		});
		const unknown = seedHostRow(fx, "unknown", {
			status: "connecting",
			enrolled: true,
			pid: process.pid, // a live recorded pid may be reused: no proof either way
		});
		const noEvidence = seedHostRow(fx, "no-evidence", { status: "ready", enrolled: true });
		const alreadyReconnecting = seedHostRow(fx, "reconnecting", {
			status: "reconnecting",
			enrolled: true,
			lastSessionFile: sessionFileWithLock(process.pid),
		});

		const reconnecting = fx.lifecycle.reconcileHostBoot();

		expect(reconnecting.sort()).toEqual(
			[held, unknown, noEvidence, alreadyReconnecting].map((row) => row.daemonId).sort(),
		);
		for (const seeded of [held, unknown, noEvidence, alreadyReconnecting]) {
			const row = fx.registry.get(seeded.daemonId)!;
			expect(row.status).toBe("reconnecting");
			expect(row.readyAt).toBeUndefined(); // stale facts cleared
			expect(row.pid).toBeUndefined();
			expect(row.workspace?.enrollment?.generation).toBe(1); // the enrollment is kept
		}
		expect(
			fx.eventLog
				.list()
				.some(
					(event) =>
						event.daemonId === held.daemonId &&
						event.message === "boot reconcile: ready → reconnecting (local session alive)",
				),
		).toBe(true);
		expect(
			fx.eventLog
				.list()
				.some(
					(event) =>
						event.daemonId === unknown.daemonId &&
						event.message === "boot reconcile: connecting → reconnecting (liveness unknown)",
				),
		).toBe(true);
	});

	test("an unenrolled row becomes asleep even when its session lock is held", async () => {
		const fx = await bootHarness();
		const heldUnenrolled = seedHostRow(fx, "unenrolled-held", {
			status: "ready",
			enrolled: false,
			lastSessionFile: sessionFileWithLock(process.pid),
			pid: process.pid,
		});
		const unenrolledConnecting = seedHostRow(fx, "unenrolled-connecting", {
			status: "connecting",
			enrolled: false,
		});

		expect(fx.lifecycle.reconcileHostBoot()).toEqual([]);

		for (const seeded of [heldUnenrolled, unenrolledConnecting]) {
			const row = fx.registry.get(seeded.daemonId)!;
			expect(row.status).toBe("asleep");
			expect(row.readyAt).toBeUndefined();
			expect(row.pid).toBeUndefined();
		}
		expect(
			fx.eventLog
				.list()
				.some(
					(event) =>
						event.daemonId === heldUnenrolled.daemonId &&
						event.message === "boot reconcile: ready → asleep (not enrolled)",
				),
		).toBe(true);
	});

	test("asleep and error rows and clone rows are left untouched", async () => {
		const fx = await bootHarness();
		const asleep = seedHostRow(fx, "asleep", { status: "asleep", enrolled: true });
		fx.registry.setStatus(asleep.daemonId, "asleep", "stopped by operator");
		const errored = seedHostRow(fx, "errored", { status: "error", enrolled: true });
		fx.registry.setStatus(errored.daemonId, "error", "daemon rejected the credential");
		fx.registry.update(errored.daemonId, { readyAt: 1234, pid: deadPid });
		const clone = fx.registry.create({
			name: "clone",
			cwd: tempDir("host-lifecycle-boot-clone-"),
			project: "boot",
			labels: [],
			status: "ready",
			readyAt: 5678,
			pid: deadPid,
			workspace: { kind: "clone", projectId: "p1", desiredState: "running" },
		});
		fx.registry.setWorkspaceEnrollment(clone.daemonId, {
			credentialHash: "b".repeat(64),
			generation: 1,
		});
		const before = fx.registry.list().map((row) => structuredClone(row));

		expect(fx.lifecycle.reconcileHostBoot()).toEqual([]);

		expect(fx.registry.list()).toEqual(before);
		expect(fx.registry.get(errored.daemonId)).toMatchObject({
			status: "error",
			error: "daemon rejected the credential",
			readyAt: 1234,
			pid: deadPid,
		});
		expect(fx.registry.get(clone.daemonId)).toMatchObject({ status: "ready", readyAt: 5678 });
		expect(
			fx.eventLog.list().filter((event) => event.message.startsWith("boot reconcile")),
		).toEqual([]);
	});
});
