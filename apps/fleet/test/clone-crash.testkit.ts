/**
 * Fixtures for clone runtimes that die after their callback pair came up: a
 * real git repo, a scripted fake provider whose liveness is a marker file in
 * its state dir, a real fleet boot with shrunken watch timings, and a real
 * callback session dialing the fleet with the credential from the provider's
 * callback-env handoff.
 *
 * Fake provider: inspect reports `stopped` while `<stateDir>/dead` exists, else
 * `running`; a dead inspect also carries the exit code/detail recorded in
 * `<stateDir>/exit.json` (what a real provider reports from the terminated
 * container). ensure-running clears `dead` (a fresh runtime) unless
 * `<stateDir>/die-on-ensure` exists, in which case the new runtime is dead on
 * arrival. Every request is appended to `<stateDir>/ops.jsonl`.
 */

import { expect } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneRuntimePolicy } from "../workspace-lifecycle";
import type { FleetServer } from "../server";
import { type CallbackSession, startCallbackSession } from "./callback-session.testkit";
import { fleetPaths, gitInit, postJson, startTestFleet, waitFor } from "./server.testkit";

/** Fast watch timings; the budget and backoff are overridden per test. */
export const FAST_CLONE_RUNTIME: Partial<CloneRuntimePolicy> = {
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
const ok = (observed, extra) => JSON.stringify({ ok: true, handle: req.handle ?? "h", observed, pid: 4242, ...extra });
if (op === "ensure-running") {
  if (existsSync(join(req.stateDir, "die-on-ensure"))) writeFileSync(dead, "1");
  else rmSync(dead, { force: true });
  console.log(ok("running"));
} else if (op === "inspect") {
  if (!existsSync(dead)) console.log(ok("running"));
  else {
    const exitFile = join(req.stateDir, "exit.json");
    console.log(ok("stopped", existsSync(exitFile) ? JSON.parse(readFileSync(exitFile, "utf8")) : {}));
  }
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

/** What the provider reports for a runtime that ended (the protocol's `exitCode` / `detail`). */
export interface RuntimeExit {
	exitCode?: number;
	detail?: string;
}

export interface CloneCrashFixture {
	server: FleetServer;
	workspaceId: string;
	stateDir: string;
	sessions: CallbackSession[];
	/** Dial a callback session with the credential of the CURRENT handoff. */
	pairUp(): Promise<CallbackSession>;
	/** The runtime dies: the marker flips inspect to stopped (reporting `exit`) and the pair, if any, drops. */
	kill(session: CallbackSession | undefined, exit?: RuntimeExit): Promise<void>;
	ops(): Array<{ op: string; generation: number }>;
	ensureGenerations(): number[];
	/** The generation and callback token of the current handoff (the file the provider reads). */
	currentHandoff(): { generation: number; token: string };
}

export async function bootCloneCrashFixture(
	runtime: Partial<CloneRuntimePolicy>,
): Promise<CloneCrashFixture> {
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
		{ workspaceDir, cloneRuntime: { ...FAST_CLONE_RUNTIME, ...runtime } },
	);
	const { project } = server.registry.addProject(repoDir);
	const created = await postJson(server.port, "/ctl/clones", {
		projectId: project.projectId,
		name: "crash",
		profileId: "local",
		start: false,
	});
	expect(created.status).toBe(201);
	const workspaceId = ((await created.json()) as { entry: { workspaceId: string } }).entry
		.workspaceId;
	const started = await postJson(server.port, "/ctl/start", { workspaceId });
	expect(started.status).toBe(200);
	const stateDir = join(
		dirname(server.registry.get(workspaceId)!.cwd!),
		".provider-state",
		workspaceId,
	);
	const sessions: CallbackSession[] = [];
	const handoff = (): { generation: number; env: Record<string, string> } =>
		JSON.parse(readFileSync(join(stateDir, "callback-env.json"), "utf8")) as {
			generation: number;
			env: Record<string, string>;
		};
	const ops = (): Array<{ op: string; generation: number }> =>
		readFileSync(join(stateDir, "ops.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { op: string; generation: number });
	return {
		server,
		workspaceId,
		stateDir,
		sessions,
		async pairUp() {
			const current = handoff();
			const session = startCallbackSession({
				url: current.env.OMP_SESSION_CALLBACK_URL!,
				workspaceId,
				generation: current.generation,
				token: current.env.OMP_SESSION_CALLBACK_TOKEN!,
			});
			sessions.push(session);
			await session.waitConnected(5_000);
			return session;
		},
		async kill(session, exit) {
			if (exit !== undefined) writeFileSync(join(stateDir, "exit.json"), JSON.stringify(exit));
			writeFileSync(join(stateDir, "dead"), "1");
			await session?.stop();
		},
		ops,
		ensureGenerations: () =>
			ops()
				.filter((o) => o.op === "ensure-running")
				.map((o) => o.generation),
		currentHandoff: () => {
			const current = handoff();
			return { generation: current.generation, token: current.env.OMP_SESSION_CALLBACK_TOKEN! };
		},
	};
}

export async function teardownCloneCrashFixture(fx: CloneCrashFixture): Promise<void> {
	for (const session of fx.sessions) await session.stop().catch(() => undefined);
	await fx.server.close();
}

/** waitFor that reports the clone's roster state on timeout (the failing-before evidence). */
export async function waitForCloneRoster(
	fx: CloneCrashFixture,
	predicate: () => boolean,
	timeoutMs: number,
	what: string,
): Promise<void> {
	try {
		await waitFor(predicate, timeoutMs, what);
	} catch (err) {
		const entry = fx.server.registry.get(fx.workspaceId);
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
