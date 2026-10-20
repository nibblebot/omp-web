/**
 * Clone runtime that dies AFTER its callback pair came up (kata zn0e).
 *
 * The lifecycle owner's runtime watch must restart a desired-running clone
 * whose provider-proven runtime is gone: revoke the predecessor's credential,
 * prove the predecessor gone via provider inspect, then ensure-running at
 * generation + 1 with a fresh credential, on the shared restart policy
 * (restart-policy.ts: jittered backoff, budget refilled by a stable pair).
 *
 * Fixtures: a real git repo, a scripted fake provider whose liveness is a
 * marker file in its state dir (`dead` = inspect reports stopped;
 * `die-on-ensure` = every ensure-running leaves the new runtime dead), real
 * fleet boots with shrunken watch timings, and a real callback daemon dialing
 * the fleet with the credential from the provider's callback-env handoff.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneRuntimePolicy } from "../workspace-lifecycle";
import type { FleetServer } from "../server";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	pinSettingsInMemory,
	postJson,
	startTestFleet,
	waitFor,
} from "./server.testkit";

afterAll(cleanupTempDirs);

await pinSettingsInMemory();

/** Fast watch timings; the budget and backoff are overridden per test. */
const FAST: Partial<CloneRuntimePolicy> = {
	pairLossGraceMs: 150,
	tickMs: 30,
	inspectEveryMs: 60,
	backoffMinMs: 20,
	backoffMaxMs: 40,
	restartMax: 3,
};

async function git(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
}

async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/**
 * Fake provider: inspect reports `stopped` while `<stateDir>/dead` exists,
 * else `running`. ensure-running clears `dead` (a fresh runtime) unless
 * `<stateDir>/die-on-ensure` exists, in which case the new runtime is dead on
 * arrival. Every request is appended to `<stateDir>/ops.jsonl`.
 */
function writeFakeProvider(dir: string): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation }) + "\\n");
const dead = join(req.stateDir, "dead");
const ok = (observed) => JSON.stringify({ ok: true, handle: req.handle ?? "h", observed, pid: 4242 });
if (op === "ensure-running") {
  if (existsSync(join(req.stateDir, "die-on-ensure"))) writeFileSync(dead, "1");
  else rmSync(dead, { force: true });
  console.log(ok("running"));
} else if (op === "inspect") {
  console.log(ok(existsSync(dead) ? "stopped" : "running"));
} else if (op === "stop") {
  writeFileSync(dead, "1");
  console.log(ok("stopped"));
} else {
  console.log(ok("missing"));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

interface Fixture {
	server: FleetServer;
	daemonId: string;
	stateDir: string;
	daemons: CallbackDaemon[];
	/** Dial a callback daemon with the credential of the CURRENT handoff. */
	pairUp(): Promise<CallbackDaemon>;
	/** The runtime dies: the marker flips inspect to stopped and the pair drops. */
	kill(daemon: CallbackDaemon): Promise<void>;
	ops(): Array<{ op: string; generation: number }>;
	ensureGenerations(): number[];
}

async function boot(runtime: Partial<CloneRuntimePolicy>): Promise<Fixture> {
	const paths = fleetPaths("omp-clone-crash-");
	const repoDir = await makeRepo(join(paths.tmp, "repo"));
	const workspaceDir = join(paths.tmp, "workspaces");
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			workspaceDir,
			providerProfiles: {
				local: {
					id: "local",
					provider: "bwrap",
					executable: writeFakeProvider(join(paths.tmp, "provider")),
					tools: [],
				},
			},
		},
		{ workspaceDir, cloneRuntime: { ...FAST, ...runtime } },
	);
	const { project } = server.registry.addProject(repoDir);
	const created = await postJson(server.port, "/ctl/clones", {
		projectId: project.projectId,
		name: "crash",
		profileId: "local",
		start: false,
	});
	expect(created.status).toBe(201);
	const daemonId = ((await created.json()) as { entry: { daemonId: string } }).entry.daemonId;
	const started = await postJson(server.port, "/ctl/start", { daemonId });
	expect(started.status).toBe(200);
	const stateDir = join(dirname(server.registry.get(daemonId)!.cwd!), ".provider-state", daemonId);
	const daemons: CallbackDaemon[] = [];
	const ops = (): Array<{ op: string; generation: number }> =>
		readFileSync(join(stateDir, "ops.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { op: string; generation: number });
	return {
		server,
		daemonId,
		stateDir,
		daemons,
		async pairUp() {
			const handoff = JSON.parse(readFileSync(join(stateDir, "callback-env.json"), "utf8")) as {
				generation: number;
				env: Record<string, string>;
			};
			const daemon = startCallbackDaemon({
				url: handoff.env.OMP_SESSION_CALLBACK_URL!,
				workspaceId: daemonId,
				generation: handoff.generation,
				token: handoff.env.OMP_SESSION_CALLBACK_TOKEN!,
			});
			daemons.push(daemon);
			await daemon.waitConnected(5_000);
			return daemon;
		},
		async kill(daemon) {
			writeFileSync(join(stateDir, "dead"), "1");
			await daemon.stop();
		},
		ops,
		ensureGenerations: () =>
			ops()
				.filter((o) => o.op === "ensure-running")
				.map((o) => o.generation),
	};
}

async function teardown(fx: Fixture): Promise<void> {
	for (const daemon of fx.daemons) await daemon.stop().catch(() => undefined);
	await fx.server.close();
}

/** waitFor that reports the clone's roster state on timeout (the failing-before evidence). */
async function waitForRoster(
	fx: Fixture,
	predicate: () => boolean,
	timeoutMs: number,
	what: string,
): Promise<void> {
	try {
		await waitFor(predicate, timeoutMs, what);
	} catch (err) {
		const entry = fx.server.registry.get(fx.daemonId);
		const state = {
			status: entry?.status,
			stage: entry?.lifecycleStage,
			error: entry?.error,
			desiredState: entry?.workspace?.desiredState,
			generation: entry?.workspace?.authorizedGeneration,
			ensureGenerations: fx.ensureGenerations(),
		};
		throw new Error(`${(err as Error).message}; clone state ${JSON.stringify(state)}`);
	}
}

describe("clone runtime that dies after pair-up", () => {
	test(
		"runtime killed after pair-up returns to running with generation+1",
		async () => {
			const fx = await boot({});
			try {
				const first = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				const gen1 = JSON.parse(readFileSync(join(fx.stateDir, "callback-env.json"), "utf8")) as {
					env: Record<string, string>;
				};

				await fx.kill(first);

				await waitForRoster(
					fx,
					() => {
						const entry = fx.server.registry.get(fx.daemonId);
						return entry?.workspace?.authorizedGeneration === 2 && entry.status === "ready";
					},
					8_000,
					"restart at generation 2",
				);
				const entry = fx.server.registry.get(fx.daemonId)!;
				expect(entry.workspace?.desiredState).toBe("running");
				expect(entry.workspace?.enrollment?.generation).toBe(2);
				expect(fx.ensureGenerations()).toEqual([1, 2]);
				// Predecessor proven gone BEFORE the replacement ensure.
				const ops = fx.ops().map((o) => o.op);
				expect(ops.lastIndexOf("inspect")).toBeLessThan(ops.lastIndexOf("ensure-running"));
				// Fresh credential per generation.
				const gen2 = JSON.parse(readFileSync(join(fx.stateDir, "callback-env.json"), "utf8")) as {
					generation: number;
					env: Record<string, string>;
				};
				expect(gen2.generation).toBe(2);
				expect(gen2.env.OMP_SESSION_CALLBACK_TOKEN).not.toBe(gen1.env.OMP_SESSION_CALLBACK_TOKEN);
				// The restarted runtime pairs with the new credential and the roster settles ready.
				await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
					5_000,
					"gen-2 pair-up ready",
				);
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a pair that drops while the runtime is alive never restarts",
		async () => {
			const fx = await boot({});
			try {
				const daemon = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				await daemon.stop(); // Pair gone, runtime (marker) alive.
				// Several pair-loss graces and inspect cadences pass.
				await Bun.sleep(1_000);
				expect(fx.ensureGenerations()).toEqual([1]);
				expect(fx.ops().some((o) => o.op === "stop")).toBe(false);
				const entry = fx.server.registry.get(fx.daemonId)!;
				expect(entry.workspace?.authorizedGeneration).toBe(1);
				expect(entry.status).toBe("ready");
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a restart loop reaches failed with the reason once the budget is spent",
		async () => {
			const fx = await boot({ restartMax: 2 });
			try {
				const first = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				// Every replacement runtime is dead on arrival.
				writeFileSync(join(fx.stateDir, "die-on-ensure"), "1");
				await fx.kill(first);

				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "failed",
					8_000,
					"failed after the restart budget",
				);
				const entry = fx.server.registry.get(fx.daemonId)!;
				expect(entry.status).toBe("error");
				expect(entry.error ?? "").toContain("restart budget exhausted");
				expect(entry.error ?? "").toContain("2 restarts allowed");
				expect(entry.lifecycleError ?? "").toContain("runtime");
				// The failure is surfaced, not silently downgraded to a stop.
				expect(entry.workspace?.desiredState).toBe("running");
				// restartMax = 2: the original start plus exactly two restarts.
				expect(fx.ensureGenerations()).toEqual([1, 2, 3]);
				await Bun.sleep(300);
				expect(fx.ensureGenerations()).toEqual([1, 2, 3]);
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a pair that holds refills the budget, so restarts bound crash loops and not lifetime restarts",
		async () => {
			const fx = await boot({ restartMax: 1, stablePairMs: 100 });
			try {
				const first = await fx.pairUp();
				await fx.kill(first);
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.workspace?.authorizedGeneration === 2,
					8_000,
					"first restart",
				);
				const second = await fx.pairUp();
				// The pair holds past stablePairMs: the one allowed restart is forgiven.
				await Bun.sleep(400);
				await fx.kill(second);
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.workspace?.authorizedGeneration === 3,
					8_000,
					"second restart after a stable pair",
				);
				expect(fx.server.registry.get(fx.daemonId)!.lifecycleStage).not.toBe("failed");
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"explicit stop never restarts, even while a restart is backing off",
		async () => {
			const fx = await boot({ backoffMinMs: 600, backoffMaxMs: 600 });
			try {
				const daemon = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				await fx.kill(daemon);
				// The runtime death is observed and a restart is queued behind its backoff.
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.daemonId)?.status === "reconnecting",
					5_000,
					"restart backing off",
				);
				const stop = await postJson(fx.server.port, "/ctl/stop", { selector: fx.daemonId });
				expect(stop.status).toBe(200);
				// Well past the backoff window.
				await Bun.sleep(1_200);
				expect(fx.ensureGenerations()).toEqual([1]);
				const entry = fx.server.registry.get(fx.daemonId)!;
				expect(entry.workspace?.desiredState).toBe("stopped");
				expect(entry.status).toBe("asleep");
				rmSync(join(fx.stateDir, "dead"), { force: true });
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);
});
