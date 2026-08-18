/**
 * SpawnSupervisor tests. A FAKE child script (sh) stands in for omp-session: it
 * appends its argv (which carries the template-filled token / labels /
 * resume args) to a file, optionally prints the OMP_SESSION| listening line for a
 * fake daemon the connector dials, and optionally fails. Covers spawn →
 * endpoint resolution → connect, respawn with --resume + fresh token,
 * restart-on-failure with fresh token per attempt, stop (kill + asleep),
 * restart cancellation, and the stderr ring.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Server } from "bun";
import { OMP_PROTO, SSE_EVENT_NAME } from "../shared/protocol";
import { encodeSseEvent } from "../shared/sse";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import type { GitResult, GitRunner } from "./discovery";
import { Registry, type RegistryEntry } from "./registry";
import { SpawnSupervisor } from "./supervisor";

const tmpDirs: string[] = [];

function tmpPath(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

// Every fixture a test creates is tracked here so teardown runs even when a
// test fails mid-body (body-end `await connector.close(); fake.stop();`
// would otherwise leak spawned children, sockets, and servers into the rest
// of the suite). afterEach closes whatever the body left open; each close is
// idempotent, so fixtures the body already closed are no-ops. Order matters:
// supervisors first (kill children, drop sockets), then connectors (abort
// remaining streams), then the fake daemon servers.
const liveSupervisors: SpawnSupervisor[] = [];
const liveConnectors: DaemonConnector[] = [];
const liveFakes: FakeServer[] = [];

afterEach(async () => {
	for (const supervisor of liveSupervisors.splice(0)) await supervisor.close();
	for (const connector of liveConnectors.splice(0)) await connector.close();
	for (const fake of liveFakes.splice(0)) fake.stop();
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

interface FakeServer {
	server: Server<undefined>;
	port: number;
	openCount: number;
	headers: Array<Record<string, string>>;
	/** Client aborts observed server-side (client disconnect). */
	serverCloses: number;
	stop(): void;
}

/** Fake omp-session daemon: primes hello_ok (hello.cwd) → state → ready on every dial. */
function startFake(
	hello: { cwd: string; sessionFile: string },
	opts?: { closeAfterMs?: number },
): FakeServer {
	const encoder = new TextEncoder();
	const fake: FakeServer = {
		server: null as unknown as Server<undefined>,
		port: 0,
		openCount: 0,
		headers: [],
		serverCloses: 0,
		stop() {
			this.server.stop(true);
		},
	};
	fake.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					await req.json().catch(() => null);
					return Response.json({ commandId: "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			fake.openCount++;
			fake.headers.push(Object.fromEntries(req.headers.entries()));
			let closeRecorded = false;
			const recordClose = (): void => {
				if (closeRecorded) return;
				closeRecorded = true;
				fake.serverCloses++;
			};
			const write = (
				controller: ReadableStreamDefaultController<Uint8Array>,
				frame: unknown,
				seq: number,
			): void => {
				controller.enqueue(encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, seq)));
			};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					req.signal.addEventListener("abort", recordClose);
					write(
						controller,
						{
							type: "hello_ok",
							proto: OMP_PROTO,
							name: "fake",
							cwd: hello.cwd,
							pid: 4242,
							version: "test",
							sessionFile: hello.sessionFile,
						},
						1,
					);
					write(
						controller,
						{
							type: "state",
							sessionId: "s1",
							state: { sessionId: "s1", sessionFile: hello.sessionFile, isStreaming: false },
						},
						2,
					);
					write(controller, { type: "ready", readyAt: Date.now() }, 3);
					// Simulate a daemon going dormant shortly after priming: the
					// connector sees a clean EOF → "asleep", so a later relaunch
					// dials fresh and produces a NEW ready transition.
					if (opts?.closeAfterMs !== undefined) {
						const closeTimer = setTimeout(() => {
							try {
								controller.close();
							} catch {
								// The stream was already closed/aborted (client drop).
							}
						}, opts.closeAfterMs);
						req.signal.addEventListener("abort", () => clearTimeout(closeTimer));
					}
				},
				cancel() {
					recordClose();
				},
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	fake.port = fake.server.port ?? 0;
	liveFakes.push(fake);
	return fake;
}

async function loadedRegistry(): Promise<Registry> {
	const registry = new Registry(join(tmpPath("omp-session-sup-state-"), "state.json"));
	await registry.load();
	return registry;
}

/**
 * Write a fake child script. It appends "$@" (the template-filled token /
 * labels / resume args) to argsFile, optionally records its pid, prints
 * stderr lines, then either exits 1 (fail) or prints the OMP_SESSION| listening
 * line for `port` and idles.
 */
function writeChildScript(
	dir: string,
	port: number,
	argsFile: string,
	opts: { fail?: boolean; pidFile?: string; stderrLines?: string[] } = {},
): string {
	const script = join(dir, "child.sh");
	const lines = ["#!/bin/sh", 'trap "exit 0" TERM INT', `echo "$@" >> ${argsFile}`];
	if (opts.pidFile) lines.push(`echo $$ > ${opts.pidFile}`);
	for (const line of opts.stderrLines ?? []) lines.push(`echo ${JSON.stringify(line)} >&2`);
	if (opts.fail) {
		lines.push("exit 1");
	} else {
		lines.push(
			`printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${port},"url":"ws://127.0.0.1:${port}"}'`,
		);
		// Idle loop. The tick must stay short: dash defers an untrapped SIGTERM
		// until the running `sleep` returns, so the supervisor's stop()/close()
		// teardown (SIGTERM, 5s grace) costs one tick per child — sleep 1 makes
		// every spawn test pay ~1s at close. 0.05 keeps the child alive while
		// making teardown ~instant.
		lines.push("while :; do sleep 0.05; done");
	}
	writeFileSync(script, lines.join("\n") + "\n");
	return script;
}

/** Spawn template that fills {token} {labels} {resume} as argv for the fake child. */
function makeConfig(script: string): FleetConfig {
	return {
		templates: { test: { command: `sh ${script} {token} {labels} {resume}` } },
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
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
			test: { command: `sh ${scriptDefault} {token} {labels} {resume}` },
			other: { command: `sh ${scriptOverride} {token} {labels} {resume}` },
		},
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
		...(projectTemplates !== undefined ? { projectTemplates } : {}),
	};
}

function makeConnector(registry: Registry): DaemonConnector {
	const connector = new DaemonConnector(registry, undefined, {
		backoffMinMs: 10,
		backoffMaxMs: 50,
	});
	liveConnectors.push(connector);
	return connector;
}

/** Supervisor with afterEach-tracked teardown (its children are real processes). */
function makeSupervisor(
	registry: Registry,
	connector: DaemonConnector,
	config: FleetConfig,
	opts?: ConstructorParameters<typeof SpawnSupervisor>[3],
): SpawnSupervisor {
	const supervisor = new SpawnSupervisor(registry, connector, config, opts);
	liveSupervisors.push(supervisor);
	return supervisor;
}

/** Recorded git invocation for the fake exec. */
interface GitCall {
	args: string[];
	cwd: string;
}

/**
 * Fake git answering each POLL PASS from `phases`: one pass is a full
 * probeGitState — a status run then a numstat run — so each element is the
 * pair [statusResult, numstatResult] and the LAST pass repeats. Records
 * every call so tests can pin the exact git args and cwds.
 */
function fakeGitPhases(phases: [GitResult, GitResult][]): { exec: GitRunner; calls: GitCall[] } {
	const calls: GitCall[] = [];
	const exec: GitRunner = async (args, cwd) => {
		const pass = phases[Math.min(Math.floor(calls.length / 2), phases.length - 1)];
		calls.push({ args, cwd });
		return args[0] === "status" ? pass[0] : pass[1];
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
		const projectDir = tmpPath("omp-session-sup-wt-");
		const { main, wt } = makeWorktreeRepo(projectDir);
		const fake = startFake({ cwd: wt, sessionFile: "/srv/proj/sess.jsonl" });
		const script = writeChildScript(projectDir, fake.port, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 0,
		});

		const wtEntry = await supervisor.spawn({ cwd: wt });
		expect(wtEntry.worktreeOf).toBe("main-repo");
		const mainEntry = await supervisor.spawn({ cwd: main });
		expect(mainEntry.worktreeOf).toBeUndefined();
	});

	test("backfillWorktrees tags untagged local entries; remote entries are never probed", async () => {
		const projectDir = tmpPath("omp-session-sup-backfill-");
		const { main, wt } = makeWorktreeRepo(projectDir);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const spawned = registry.create({
			name: "wt",
			cwd: wt,
			project: basename(wt),
			labels: [],
			mode: "spawned",
			template: "test",
		});
		// A remote entry pointing at a local worktree path must stay untagged:
		// its cwd lives on another host.
		const remote = registry.create({
			name: "r",
			cwd: wt,
			project: "r",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
		});
		const mainEntry = registry.create({
			name: "m",
			cwd: main,
			project: "main-repo",
			labels: [],
			mode: "spawned",
			template: "test",
		});

		await supervisor.backfillWorktrees();
		expect(registry.get(spawned.daemonId)!.worktreeOf).toBe("main-repo");
		expect(registry.get(remote.daemonId)!.worktreeOf).toBeUndefined();
		expect(registry.get(mainEntry.daemonId)!.worktreeOf).toBeUndefined();
	});

	test("spawn runs the child, resolves the endpoint, and connects to ready", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, {
			pidFile: join(projectDir, "pid.txt"),
		});
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir, labels: ["env=prod"] });
		expect(entry.mode).toBe("spawned");
		expect(entry.project).toBe(basename(projectDir));
		expect(entry.status).toBe("spawning");
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const updated = registry.get(entry.daemonId)!;
		expect(updated.endpoint).toBe(`ws://127.0.0.1:${fake.port}`);
		expect(updated.lastSessionFile).toBe("/srv/proj/sess.jsonl");
		expect(updated.pid).toBeTypeOf("number");
		expect(updated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(fake.headers[0]?.["authorization"]).toBe(`Bearer ${updated.token}`);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		const line1 = readFileSync(argsFile, "utf8").split("\n")[0];
		expect(line1).toContain(updated.token!);
		expect(line1).toContain("--label env=prod");
	});

	test("snapshot exposes pid, restarts, and endpoint for a live spawned child", async () => {
		const projectDir = tmpPath("omp-session-sup-snap-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const script = writeChildScript(projectDir, fake.port, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const snap = supervisor.snapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(0);
		expect(typeof snap?.pid).toBe("number");
		expect(snap?.endpoint).toBe(`ws://127.0.0.1:${fake.port}`);
	});

	test("snapshot reports restart-budget use and no live pid after the budget is exhausted", async () => {
		const projectDir = tmpPath("omp-session-sup-snapfail-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"), { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 1,
			backoffMinMs: 20,
			backoffMaxMs: 40,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
			10_000,
			"error status",
		);
		const snap = supervisor.snapshot()[entry.daemonId];
		expect(snap).toBeDefined();
		expect(snap?.restarts).toBe(1); // one restart consumed before the cap hit
		expect(snap?.pid).toBeUndefined(); // no live child
		expect(snap?.endpoint).toBeUndefined(); // never resolved
	});

	test("onEvent reports spawn, endpoint resolution, exit/restart, and budget exhaustion", async () => {
		const projectDir = tmpPath("omp-session-sup-events-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"), { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const events: Array<{ level: string; message: string; daemonId?: string }> = [];
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 1,
			backoffMinMs: 20,
			backoffMaxMs: 40,
			onEvent: (level, message, daemonId) => events.push({ level, message, daemonId }),
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
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
		const projectDir = tmpPath("omp-session-sup-events2-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const script = writeChildScript(projectDir, fake.port, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const events: Array<{ level: string; message: string; daemonId?: string }> = [];
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
			onEvent: (level, message, daemonId) => events.push({ level, message, daemonId }),
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		// lastSessionFile was adopted from hello_ok, so the respawn resumes.
		const firstToken = registry.get(entry.daemonId)!.token;
		await supervisor.respawn(registry.get(entry.daemonId)!);
		await waitFor(
			() => {
				const updated = registry.get(entry.daemonId);
				return updated?.status === "ready" && updated.token !== firstToken ? "ready" : null;
			},
			5000,
			"ready after respawn",
		);
		await supervisor.prune(entry.daemonId);
		// Give the killed child's exit handler a beat to land.
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
			events.some((event) => event.daemonId === entry.daemonId && event.message === "stop"),
		).toBe(true);
		expect(
			events.some((event) => event.daemonId === entry.daemonId && event.message === "prune"),
		).toBe(true);
	});

	test("respawn uses --resume lastSessionFile and a fresh token; reconnects to ready", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const firstToken = registry.get(entry.daemonId)!.token;

		await supervisor.respawn(registry.get(entry.daemonId)!);
		// Wait for the NEW child to dial and reach ready — the registry token
		// changes at launch time while the old "ready" status is still stale.
		await waitFor(
			() => {
				const current = registry.get(entry.daemonId)!;
				return fake.openCount >= 2 && current.status === "ready" && current.token !== firstToken
					? "ready"
					: null;
			},
			8000,
			"respawned ready",
		);
		const updated = registry.get(entry.daemonId)!;
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(firstToken!); // first spawn: no resume, bare token
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl"); // R3 resume rule
		expect(lines[1]).toContain(updated.token!);
		expect(updated.token!).not.toBe(firstToken!);
		expect(fake.openCount).toBeGreaterThanOrEqual(2);
	});

	test("spawn shell-quotes label/name values — a $(touch) payload stays inert", async () => {
		const projectDir = tmpPath("omp-session-sup-quote-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const pwn = join(projectDir, "pwned");
		const entry = await supervisor.spawn({
			cwd: projectDir,
			labels: [`k=$(touch ${pwn})`, "q='quoted'", "sp ace"],
		});
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const line = readFileSync(argsFile, "utf8").split("\n")[0];
		// The payloads arrived as literal argv text (sh stripped the outer
		// quoting); none of the metacharacters was executed.
		expect(line).toContain(`--label k=$(touch ${pwn})`);
		expect(line).toContain(`--label q='quoted'`);
		expect(line).toContain("--label sp ace");
		expect(existsSync(pwn)).toBe(false);
	});

	test("quoted cwd/name/labels with metacharacters round-trip as single argv entries", async () => {
		const projectDir = tmpPath("omp-session-sup-roundtrip-");
		// A REAL directory whose name contains spaces, quotes, $(), backticks,
		// and a newline — the exact hostile value class the quoting must tame.
		const weirdCwd = join(projectDir, "dir 'quoted' $(x) `y`\nnewline");
		mkdirSync(weirdCwd, { recursive: true });
		const fake = startFake({ cwd: weirdCwd, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				`printf '%s\\0' "$@" > '${argsFile}'`,
				`printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const config: FleetConfig = {
			templates: {
				test: {
					command: `sh ${script} --cwd {cwd} --token {token} --name {name} {labels} {resume}`,
				},
			},
			defaultTemplate: "test",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, config, { restartMax: 2 });

		const trickyName = "na'me $(nope) `nope` with spaces\nand a newline";
		const pwn = join(projectDir, "pwned");
		const entry = await supervisor.spawn({
			cwd: weirdCwd,
			name: trickyName,
			labels: [`k=$(touch ${pwn})`],
		});
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);

		// NUL-delimited "$@" dump (printf '%s\0' "$@"): each hostile value
		// survived shell parsing as a single literal argument — even the
		// embedded newline stays inside one argv entry.
		const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
		expect(args[0]).toBe("--cwd");
		expect(args[1]).toBe(weirdCwd);
		expect(args[2]).toBe("--token");
		expect(args[3]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(args[4]).toBe("--name");
		expect(args[5]).toBe(trickyName);
		expect(args[6]).toBe("--label");
		expect(args[7]).toBe(`k=$(touch ${pwn})`);
		expect(existsSync(pwn)).toBe(false);
	});

	test("concurrent respawn() calls launch exactly one child — no orphan", async () => {
		const projectDir = tmpPath("omp-session-sup-conc-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
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
				`printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);

		// Two overlapping respawns (no await between the calls): both must
		// coalesce onto ONE launch — exactly one replacement child, and the
		// original is terminated rather than orphaned.
		await Promise.all([
			supervisor.respawn(registry.get(entry.daemonId)!),
			supervisor.respawn(registry.get(entry.daemonId)!),
		]);
		await waitFor(
			() => {
				const current = registry.get(entry.daemonId)!;
				return fake.openCount >= 2 && current.status === "ready" ? "ready" : null;
			},
			8000,
			"respawned ready",
		);

		// One launch per spawn/respawn, never a double-launch: the initial
		// child wrote line/pid 1, the respawned child line/pid 2.
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl");
		const pids = readFileSync(pidsFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => Number.parseInt(l, 10));
		expect(pids).toHaveLength(2);

		// stop() kills the tracked (only) child; the pre-respawn child was
		// terminated by the respawn — no orphan survives.
		await supervisor.stop(entry.daemonId);
		for (const pid of pids) {
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
			expect(alive).toBe(false);
		}
	});

	test("restart-on-failure: bounded restarts with a fresh token per attempt, then error", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		// restartMax 1: initial child + exactly one restart, then error.
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 1,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
			10_000,
			"error status",
		);
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("exited");
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain(updated.token!); // the final attempt's token is registered
		expect(lines[0]).not.toBe(lines[1]); // fresh token across attempts
	});

	test("#22 rapid crashes without ever reaching ready exhaust the budget and error (window, not lifetime)", async () => {
		const projectDir = tmpPath("omp-session-sup-budgetfail-");
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, 1, argsFile, { fail: true });
		const registry = await loadedRegistry();
		// The connector's onStatus is wired to the supervisor exactly as
		// server.ts wires it; a crash loop never reaches ready, so no reset.
		let supervisor: SpawnSupervisor;
		const connector = new DaemonConnector(
			registry,
			{ onStatus: (entry) => supervisor.onConnectorStatus(entry) },
			{ backoffMinMs: 10, backoffMaxMs: 50 },
		);
		supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 5,
			backoffMinMs: 20,
			backoffMaxMs: 50,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
			10_000,
			"error status",
		);
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("exited");
		// Initial launch + 5 restarts; the 6th exit exceeds the consecutive cap.
		expect(readFileSync(argsFile, "utf8").trim().split("\n")).toHaveLength(6);
	}, 20_000);

	test("#22 crash → ready → crash → ready never errors: the budget resets on the connector ready transition", async () => {
		const projectDir = tmpPath("omp-session-sup-budget-");
		// The fake closes each /events stream shortly after priming (dormant),
		// so every relaunch dials fresh and produces a NEW ready transition —
		// exactly what a real daemon process (which dies with the child) does.
		const fake = startFake(
			{ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" },
			{ closeAfterMs: 200 },
		);
		const argsFile = join(projectDir, "args.txt");
		const counterFile = join(projectDir, "counter.txt");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				`n=$(cat '${counterFile}' 2>/dev/null || echo 0)`,
				"n=$((n + 1))",
				`echo "$n" > '${counterFile}'`,
				`echo "$@" >> '${argsFile}'`,
				// Odd launches crash before printing anything; even launches
				// resolve an endpoint (reaching ready), then crash after a beat.
				"if [ $((n % 2)) -eq 1 ]; then exit 1; fi",
				`printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}'`,
				"sleep 0.6",
				"exit 1",
			].join("\n") + "\n",
		);
		const registry = await loadedRegistry();
		let supervisor: SpawnSupervisor;
		const connector = new DaemonConnector(
			registry,
			{ onStatus: (entry) => supervisor.onConnectorStatus(entry) },
			{ backoffMinMs: 10, backoffMaxMs: 50 },
		);
		supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 5,
			backoffMinMs: 20,
			backoffMaxMs: 50,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		// Six launches: three crash-only + three that reach ready. With the
		// old LIFETIME budget this would hit the 5-restart cap; the ready
		// transitions reset it, so the daemon keeps restarting instead of
		// erroring.
		await waitFor(
			() => {
				try {
					return readFileSync(argsFile, "utf8").trim().split("\n").length >= 6
						? "six-launches"
						: null;
				} catch {
					return null; // the child may not have written the file yet
				}
			},
			15_000,
			"six child launches",
		);
		const current = registry.get(entry.daemonId)!;
		expect(current.status).not.toBe("error");
		expect(current.error).toBeUndefined();
	}, 20_000);

	test("#23 a malformed template-host endpoint fails loudly with the bad value and kills the child (no wedge)", async () => {
		const projectDir = tmpPath("omp-session-sup-badhost-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const pidFile = join(projectDir, "pid.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { pidFile });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		// A template host that can never form a valid ws:// URL: the resolved
		// endpoint is rejected BEFORE the connector dials (the old behavior
		// threw inside new URL() and wedged the stdout pump).
		const config: FleetConfig = {
			templates: { test: { command: `sh ${script} {token} {labels} {resume}`, host: "bad host" } },
			defaultTemplate: "test",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = makeSupervisor(registry, connector, config, { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		const updated = await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
			5000,
			"error status",
		);
		expect(updated.error).toContain("invalid endpoint from child");
		expect(updated.error).toContain("bad host");
		// The child is dead — not left running behind a wedged pump — and the
		// connector never touched it.
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		await waitFor(
			() => {
				try {
					process.kill(pid, 0);
					return null;
				} catch {
					return "dead";
				}
			},
			2000,
			"child death",
		);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		expect(registry.get(entry.daemonId)!.status).toBe("error");
	});

	test("#23 a malformed endpoint line is dropped as noise; the valid listening line still resolves (no wedged pump)", async () => {
		const projectDir = tmpPath("omp-session-sup-garbage-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				// The malformed wrapper endpoint line must not throw inside the
				// supervisor's read loop: it is dropped at parse time and the
				// following valid listening line resolves normally.
				`printf 'OMP_SESSION|%s\\n' '{"event":"endpoint","url":"garbage"}'`,
				`printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const updated = registry.get(entry.daemonId)!;
		expect(updated.endpoint).toBe(`ws://127.0.0.1:${fake.port}`);
		expect(updated.status).toBe("ready");
	});

	test("#23 a child that prints only malformed contract lines errors at the endpoint deadline and is killed", async () => {
		const projectDir = tmpPath("omp-session-sup-onlygarbage-");
		const argsFile = join(projectDir, "args.txt");
		const pidFile = join(projectDir, "pid.txt");
		const script = join(projectDir, "child.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'trap "exit 0" TERM INT',
				`echo $$ > '${pidFile}'`,
				`echo "$@" >> '${argsFile}'`,
				`printf 'OMP_SESSION|%s\\n' '{"event":"endpoint","url":"garbage"}'`,
				"while :; do sleep 0.05; done",
			].join("\n") + "\n",
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
			endpointTimeoutMs: 1000,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		const updated = await waitFor(
			() =>
				registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null,
			5000,
			"error status",
		);
		expect(updated.error).toContain("endpoint timeout");
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		await waitFor(
			() => {
				try {
					process.kill(pid, 0);
					return null;
				} catch {
					return "dead";
				}
			},
			2000,
			"child death",
		);
		expect(connector.isConnected(entry.daemonId)).toBe(false);
	});

	test("stop kills the child, drops the socket, and sets status asleep", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const pidFile = join(projectDir, "pid.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { pidFile });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(pid).toBeGreaterThan(0);

		await supervisor.stop(entry.daemonId);
		expect(registry.get(entry.daemonId)?.status).toBe("asleep");
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		await waitFor(() => (fake.serverCloses >= 1 ? "closed" : null), 2000, "server-observed close");
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	test("stop cancels a scheduled restart", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 5,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		// The first child exits ~instantly and schedules a restart at ≥500ms;
		// stop() within that window must cancel it.
		await waitFor(
			() => {
				try {
					return readFileSync(argsFile, "utf8").trim().split("\n").length >= 1 ? "spawned" : null;
				} catch {
					return null; // the child may not have written the file yet
				}
			},
			2000,
			"first child",
		);
		await supervisor.stop(entry.daemonId);
		expect(registry.get(entry.daemonId)?.status).toBe("asleep");
		await sleep(2200); // the 1s-min backoff would have fired by now if not cancelled
		expect(readFileSync(argsFile, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("stderrTail returns the ring buffer; the ring truncates to stderrRingBytes", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, {
			stderrLines: ["boom-one", "boom-two"],
		});
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		const tail = supervisor.stderrTail(entry.daemonId);
		expect(tail).toContain("boom-one");
		expect(tail).toContain("boom-two");

		await supervisor.stop(entry.daemonId);

		// A small ring keeps only the tail.
		const supervisor2 = makeSupervisor(registry, connector, makeConfig(script), {
			stderrRingBytes: 8,
		});
		const entry2 = await supervisor2.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry2.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready 2",
		);
		const smallTail = supervisor2.stderrTail(entry2.daemonId);
		expect(smallTail.length).toBeLessThanOrEqual(8);
		expect(smallTail.endsWith("two\n")).toBe(true);
	});

	test("#24 prune() drops the per-daemon child state after stop (stderr ring, restart budget)", async () => {
		const projectDir = tmpPath("omp-session-sup-prune-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, {
			stderrLines: ["prune-boom"],
		});
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script));
		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		// The stderr ring is populated while the child lives.
		expect(supervisor.stderrTail(entry.daemonId)).toContain("prune-boom");
		// prune() = stop + drop the ChildState: the ring (up to 64KB per
		// daemon) and restart budget must not outlive the removed daemon.
		await supervisor.prune(entry.daemonId);
		expect(registry.get(entry.daemonId)?.status).toBe("asleep");
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		expect(supervisor.stderrTail(entry.daemonId)).toBe("");
		// The child stays dead — no restart fires from the pruned state.
		await sleep(100);
		expect(supervisor.stderrTail(entry.daemonId)).toBe("");
	});

	test("unknown template rejects and creates nothing", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {});
		const before = registry.list().length;
		await expect(supervisor.spawn({ cwd: projectDir, template: "nope" })).rejects.toThrow(
			/unknown spawn template/,
		);
		expect(registry.list()).toHaveLength(before);
	});

	test("projectTemplates: basename(cwd) picks the template when init.template is absent", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		// Separate dirs: writeChildScript uses a fixed `child.sh` name per dir.
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(
			join(projectDir, "tpl-override"),
			fake.port,
			argsOverride,
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(
			registry,
			connector,
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		expect(registry.get(entry.daemonId)?.template).toBe("other");
		expect(readFileSync(argsOverride, "utf8").split("\n")[0]).toContain(
			registry.get(entry.daemonId)!.token!,
		);
		// The default-template child must never have launched.
		expect(existsSync(argsDefault)).toBe(false);
	});

	test("init.template wins over projectTemplates", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(
			join(projectDir, "tpl-override"),
			fake.port,
			argsOverride,
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(
			registry,
			connector,
			makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir, template: "test" });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(readFileSync(argsDefault, "utf8").split("\n")[0]).toContain(
			registry.get(entry.daemonId)!.token!,
		);
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("defaultTemplate applies when the project has no override", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(
			join(projectDir, "tpl-override"),
			fake.port,
			argsOverride,
		);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		// The override key deliberately does not match this project's basename.
		const supervisor = makeSupervisor(
			registry,
			connector,
			makeTierConfig(scriptDefault, scriptOverride, { "some-other-project": "other" }),
			{ restartMax: 2 },
		);

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(
			() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"ready",
		);
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(readFileSync(argsDefault, "utf8").split("\n")[0]).toContain(
			registry.get(entry.daemonId)!.token!,
		);
		expect(existsSync(argsOverride)).toBe(false);
	});

	test("unknown projectTemplates value rejects and creates nothing", async () => {
		const projectDir = tmpPath("omp-session-sup-proj-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(
			registry,
			connector,
			makeTierConfig(script, script, { [basename(projectDir)]: "nope" }),
			{ restartMax: 2 },
		);
		const before = registry.list().length;
		await expect(supervisor.spawn({ cwd: projectDir })).rejects.toThrow(
			/unknown spawn template: nope/,
		);
		expect(registry.list()).toHaveLength(before);
	});
});

describe("git-state polling", () => {
	/** Supervisor with a config whose child would fail: polling tests never spawn. */
	async function pollSupervisor(opts?: ConstructorParameters<typeof SpawnSupervisor>[3]): Promise<{
		registry: Registry;
		connector: DaemonConnector;
		supervisor: SpawnSupervisor;
	}> {
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
			...(opts ?? {}),
		});
		return { registry, connector, supervisor };
	}

	test("probes local entries only on change; remote and empty-cwd entries are never probed", async () => {
		const { registry, connector, supervisor } = await pollSupervisor();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
			mode: "spawned",
			template: "test",
		});
		// Same cwd as the local entry: if the poll ever probed the remote
		// entry the fake exec would see its cwd too.
		registry.create({
			name: "r",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
		});
		registry.create({
			name: "e",
			cwd: "",
			project: "",
			labels: [],
			mode: "attached",
			endpoint: "ws://127.0.0.1:2",
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
		// Remote + empty-cwd entries are never probed with local git.
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
		expect(registry.get("d3")?.git).toBeUndefined();
	});

	test("a changed state updates the registry and persists to disk", async () => {
		const statePath = join(tmpPath("omp-session-sup-gitstate-"), "state.json");
		const registry = new Registry(statePath);
		await registry.load();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig("/nonexistent-child.sh"), {
			restartMax: 0,
		});
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
			mode: "spawned",
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

	test("a probe failure clears previously-set fields, once", async () => {
		const { registry, connector, supervisor } = await pollSupervisor();
		const local = registry.create({
			name: "l",
			cwd: "/srv/repos/acme",
			project: "acme",
			labels: [],
			mode: "spawned",
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
		const projectDir = tmpPath("omp-session-sup-gitone-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const script = writeChildScript(projectDir, fake.port, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = makeSupervisor(registry, connector, makeConfig(script), {
			restartMax: 2,
		});

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
		const ghost = join(tmpPath("omp-session-sup-vanished-"), "gone-worktree");
		const fired: RegistryEntry[] = [];
		const { registry, supervisor } = await pollSupervisor({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		// A TAGGED worktree entry (the detection gate: worktreeOf set) whose
		// cwd does NOT exist on disk — e.g. `git worktree remove` run outside
		// the fleet. Branch/git preset so the test can pin that the hook path
		// returns WITHOUT the stale-field clearing.
		const entry = registry.create({
			name: "wt",
			cwd: ghost,
			project: "acme",
			labels: [],
			mode: "spawned",
			template: "test",
			worktreeOf: "acme",
			branch: "main",
		});
		// Every probe fails (the dir is gone) — the injected exec never
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
			mode: "spawned",
		});
		// Detection only: the supervisor itself never removes the entry, and
		// the hook path returned BEFORE the branch/git clearing.
		expect(registry.get(entry.daemonId)).toBeDefined();
		expect(registry.get(entry.daemonId)?.branch).toBe("main");
		// Simulate the server's eviction (prune/drop + registry.remove): with
		// the entry gone, later poll ticks must NOT re-fire — the hook is at
		// most meaningful once per entry. The polls keep ticking (250ms) but
		// the roster no longer contains the entry, so nothing is probed.
		registry.remove(entry.daemonId);
		await sleep(400); // well past the next interval tick
		expect(fired).toHaveLength(1);
	});

	test("a probe failure with the cwd still present keeps the clear path and never fires onWorktreeRemoved", async () => {
		// A REAL directory on disk (tmpPath creates it); the fake exec fails,
		// but existsSync sees the dir present — transient git failure, no
		// eviction: branch/git are cleared exactly as before.
		const cwd = tmpPath("omp-session-sup-present-");
		const fired: RegistryEntry[] = [];
		const { registry, supervisor } = await pollSupervisor({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		const entry = registry.create({
			name: "wt",
			cwd,
			project: "acme",
			labels: [],
			mode: "spawned",
			template: "test",
			worktreeOf: "acme",
		});
		let onChange = 0;
		registry.onChange = () => {
			onChange++;
		};
		// First pass: dirty state. Then the repo is unreadable (nonzero
		// exit) — dir still on disk, so this is the classic clear path.
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
		const ghost = join(tmpPath("omp-session-sup-untagged-"), "gone");
		const fired: RegistryEntry[] = [];
		const { registry, supervisor } = await pollSupervisor({
			onWorktreeRemoved: (entry) => fired.push(entry),
		});
		// No worktreeOf: a main checkout or untagged spawn. Such entries are
		// NEVER auto-evicted — only tagged linked worktrees qualify.
		registry.create({
			name: "main",
			cwd: ghost,
			project: "acme",
			labels: [],
			mode: "spawned",
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
