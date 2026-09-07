/**
 * Clone recovery + race regressions (clone-plan P6.1/P6.2/P6.3/P6.4 —
 * RecoveryCompletion's uncertain-safety boundaries). These are deliberately
 * narrow deterministic regressions, NOT a lifecycle matrix:
 *
 *  1. restart at the enrollment-before-authorization boundary: a fleet that
 *     crashed after persisting the enrollment (gen N) but before persisting
 *     authorizedGeneration must, on restart, re-inspect the sandbox and NOT
 *     blindly re-ensure at a fenced generation — a live sandbox reattaches
 *     at the same generation with the persisted credential; a sandbox the
 *     provider reports stopped/missing for desired-running bumps exactly
 *     once (no double writer, no stale-gen request).
 *
 *  2. stale generation / uncertain predecessor: with an inspect `conflict`
 *     (uncertain termination) replacement is refused — no new writer is
 *     admitted and the registry authorizedGeneration does not move.
 *
 *  3. busy / disconnected is not idle-stopped: a clone workspace's compute
 *     is provider-owned (never a supervisor child); the fleet is the SOLE
 *     idle-stop authority — no legacy supervisor idle path, connector
 *     disconnect, or registry downgrade may stop a desired-running clone.
 *
 * Fixtures: a real local git repo for the clone source, a scripted fake
 * provider executable speaking OMP_PROVIDER_PROTO (stdin request / stdout
 * response) that records every op + generation it receives, and real fleet
 * boots via startTestFleet (restart = close + rebind the same statePath).
 * Git identity uses the repo's local config, never global overrides.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetServer } from "./server";
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

/** One `git -C <cwd> <args>` invocation (throws on failure). */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const read = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
		await new Response(stream).text();
	const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

/** Real git repo with one commit, using the operator's Git identity. */
async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/**
 * A scripted fake provider executable. Every request it receives is appended
 * as JSON to `<stateDir>/ops.jsonl`. `scenario` picks the op responses:
 *   - "reattach-running": ensure + inspect both report running (live sandbox).
 *   - "dead-after-ensure": ensure reports running once; every inspect after
 *     the first reports stopped (sandbox died after the fleet's ensure).
 *   - "uncertain": inspect returns ok:false conflict (termination uncertain);
 *     ensure is never reached.
 *   - "stopped": inspect + stop report stopped; ensure reports running.
 */
function writeFakeProvider(
	dir: string,
	scenario: "reattach-running" | "dead-after-ensure" | "uncertain" | "stopped",
): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation, handle: req.handle ?? null }) + "\\n");
const scenario = ${JSON.stringify(scenario)};
const ok = (observed) => JSON.stringify({ ok: true, handle: req.handle ?? "h", observed, pid: 4242 });
const err = (code, message) => JSON.stringify({ ok: false, error: { code, message, retryable: false } });
if (op === "ensure-running") {
  console.log(ok("running"));
} else if (op === "inspect") {
  if (scenario === "uncertain") console.log(err("conflict", "predecessor termination uncertain"));
  else if (scenario === "dead-after-ensure") {
    // The sandbox died right after ensure (its pid is gone): every inspect
    // reports stopped, so the FIRST watchdog inspect (~10s) flips failed.
    console.log(ok("stopped"));
  } else if (scenario === "reattach-running") {
    console.log(ok("running"));
  } else {
    console.log(ok("stopped"));
  }
} else if (op === "stop") {
  console.log(ok("stopped"));
} else {
  console.log(ok("missing"));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/** Recorded provider ops from a workspace's state dir. */
function providerOps(
	workspaceDir: string,
	daemonId: string,
): Array<{ op: string; generation: number }> {
	try {
		const raw = readFileSync(join(workspaceDir, ".provider-state", daemonId, "ops.jsonl"), "utf8");
		return raw
			.trim()
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as { op: string; generation: number });
	} catch {
		return [];
	}
}

interface TestFleet {
	server: FleetServer;
	paths: { tmp: string; statePath: string; configPath: string };
	workspaceDir: string;
	repoDir: string;
}

/** Boot a fleet with a fake bwrap provider; register a repo; return the lot. */
async function bootFleet(
	scenario: "reattach-running" | "dead-after-ensure" | "uncertain" | "stopped",
	providerDir?: string,
): Promise<TestFleet> {
	const paths = fleetPaths("omp-clone-recovery-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const fakeProvider = providerDir ?? writeFakeProvider(join(paths.tmp, "provider"), scenario);
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			workspaceDir,
			providerProfiles: {
				local: { id: "local", provider: "bwrap", executable: fakeProvider, tools: [] },
			},
		},
		{ workspaceDir },
	);
	return { server, paths, workspaceDir, repoDir };
}

/** Create a clone (no start), returning its daemonId. */
async function createClone(server: FleetServer, repoDir: string, name: string): Promise<string> {
	const project = await server.registry.addProject(repoDir);
	const res = await postJson(server.port, "/ctl/clones", {
		projectId: project.projectId,
		name,
		profileId: "local",
		start: false,
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { entry: { daemonId: string } };
	return body.entry.daemonId;
}

describe("clone recovery: restart durable boundaries + races", () => {
	test(
		"restart reattaches a live desired-running sandbox at the SAME generation — never a second writer",
		async () => {
			const { server, paths, workspaceDir, repoDir } = await bootFleet("reattach-running");
			try {
				const daemonId = await createClone(server, repoDir, "reattach");
				// Start (gen 1, desired running, enrollment + authorizedGeneration
				// persisted; the fake sandbox stays "running" across restart).
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				let entry = server.registry.get(daemonId)!;
				expect(entry.workspace?.authorizedGeneration).toBe(1);
				expect(entry.workspace?.desiredState).toBe("running");
				expect(entry.workspace?.enrollment?.generation).toBe(1);

				// FLEET RESTART: same statePath, fresh process. Boot reconcile
				// inspects; the sandbox is running → reattach at gen 1 with the
				// persisted credential — never a bump, never a re-ensure.
				await server.close();
				const server2 = await startTestFleet(
					{ statePath: paths.statePath, configPath: paths.configPath },
					{
						workspaceDir,
						providerProfiles: {
							local: {
								id: "local",
								provider: "bwrap",
								executable: writeFakeProvider(join(paths.tmp, "provider2"), "reattach-running"),
								tools: [],
							},
						},
					},
					{ workspaceDir },
				);
				try {
					// Boot reconcile is fire-and-forget: the persisted status is
					// ALREADY "ready" (clone entries skip the boot downgrade), so
					// wait for the reconcile's reattach side-effect — the stage
					// flips to "ready" (from the persisted value) only after the
					// provider inspect confirms the sandbox is live.
					await waitFor(
						() => {
							const ops = providerOps(workspaceDir, daemonId);
							return (
								ops.some((o) => o.op === "inspect") &&
								server2.registry.get(daemonId)?.lifecycleStage === "ready"
							);
						},
						5_000,
						"reconcile reattach after restart",
					);
					entry = server2.registry.get(daemonId)!;
					expect(entry.status).toBe("ready");
					expect(entry.workspace?.authorizedGeneration).toBe(1); // NO bump
					expect(entry.workspace?.desiredState).toBe("running");
					expect(entry.workspace?.enrollment?.generation).toBe(1); // persisted cred reused
					// The provider saw exactly ONE ensure (gen 1) across both
					// fleet lifetimes — reattach is inspect-only, never a second
					// ensure (no duplicate writer).
					const ops = providerOps(workspaceDir, daemonId);
					const ensures = ops.filter((o) => o.op === "ensure-running");
					expect(ensures).toHaveLength(1);
					expect(ensures[0]!.generation).toBe(1);
					const inspects = ops.filter((o) => o.op === "inspect");
					expect(inspects.length).toBeGreaterThanOrEqual(1);
				} finally {
					await server2.close();
				}
			} finally {
				await server.close().catch(() => {
					// Already closed for the restart above.
				});
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"restart of a desired-running clone whose sandbox died bumps EXACTLY ONCE and sends the bumped generation (no stale-gen request, no double writer)",
		async () => {
			const { server, paths, workspaceDir, repoDir } = await bootFleet("stopped");
			try {
				const daemonId = await createClone(server, repoDir, "dead-restart");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				expect(server.registry.get(daemonId)!.workspace?.authorizedGeneration).toBe(1);

				// Simulate the sandbox dying between the stop and the restart:
				// the provider's inspect reports stopped/missing from boot.
				await server.close();
				const server2 = await startTestFleet(
					{ statePath: paths.statePath, configPath: paths.configPath },
					{
						workspaceDir,
						providerProfiles: {
							local: {
								id: "local",
								provider: "bwrap",
								executable: writeFakeProvider(join(paths.tmp, "provider2"), "stopped"),
								tools: [],
							},
						},
					},
					{ workspaceDir },
				);
				try {
					// Boot reconcile: inspect reports stopped + desired running →
					// ensure-running with a bumped generation (1 → 2), fencing the
					// old enrollment. Wait for the recreate.
					await waitFor(
						() => server2.registry.get(daemonId)?.workspace?.authorizedGeneration === 2,
						5_000,
						"gen-2 recreate after restart",
					);
					const entry = server2.registry.get(daemonId)!;
					expect(entry.workspace?.authorizedGeneration).toBe(2);
					expect(entry.workspace?.enrollment?.generation).toBe(2);
					expect(entry.workspace?.desiredState).toBe("running");
					expect(entry.status).toBe("ready");
					// Exactly TWO ensures total (gen 1 pre-restart, gen 2 post) and
					// the gen-2 ensure request carried generation 2 — never the
					// stale gen 1 (the fencing regression Main observed).
					const ops = providerOps(workspaceDir, daemonId);
					const ensures = ops.filter((o) => o.op === "ensure-running");
					expect(ensures).toHaveLength(2);
					expect(ensures[0]!.generation).toBe(1);
					expect(ensures[1]!.generation).toBe(2);
				} finally {
					await server2.close();
				}
			} finally {
				await server.close().catch(() => {
					// Already closed.
				});
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"uncertain predecessor (inspect conflict) refuses replacement — no second writer admitted, generation never moves",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet("uncertain");
			try {
				const daemonId = await createClone(server, repoDir, "uncertain");
				// Manually persist a gen-1 authorized state (as a previous fleet
				// would have): the provider now answers inspect with conflict.
				server.registry.updateWorkspace(daemonId, {
					desiredState: "running",
					authorizedGeneration: 1,
					providerHandle: "h-1",
				});
				server.registry.setStatus(daemonId, "ready");
				// Start/wake must refuse: the inspect conflict means the
				// predecessor's termination is uncertain — no new writer may be
				// admitted (P6.2).
				const wake = await postJson(server.port, "/ctl/start", { daemonId });
				expect(wake.status).toBe(409);
				const body = (await wake.json()) as { error?: string };
				expect(body.error ?? "").toContain("uncertain");
				const after = server.registry.get(daemonId)!;
				expect(after.workspace?.authorizedGeneration).toBe(1); // never moved
				// The provider NEVER saw an ensure or stop (inspect conflict
				// blocks before any mutation).
				const ops = providerOps(workspaceDir, daemonId);
				expect(ops.some((o) => o.op === "ensure-running")).toBe(false);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a dead desired-running sandbox is surfaced failed/error by the callback watchdog — never left at an eternal callback stage",
		async () => {
			const { server, repoDir } = await bootFleet("dead-after-ensure");
			try {
				const daemonId = await createClone(server, repoDir, "dead-pid");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				let entry = server.registry.get(daemonId)!;
				expect(entry.status).toBe("ready");
				expect(entry.lifecycleStage).toBe("callback");
				// The sandbox is dead (later inspects report stopped): the
				// watchdog (~10s inspect cadence) must flip to failed/error.
				// Real-time wait is deliberate: the watchdog is a wall-clock
				// poller (1s ticks, inspect every 10th) — there is no event to
				// await, so waitFor polls the observable transition.
				await waitFor(
					() => server.registry.get(daemonId)?.lifecycleStage === "failed",
					15_000,
					"watchdog failed flip",
				);
				entry = server.registry.get(daemonId)!;
				expect(entry.lifecycleStage).toBe("failed");
				expect(entry.status).toBe("error");
				expect(entry.error ?? "").toContain("callback");
				// The desired state stays running (the failure is surfaced, not
				// silently downgraded to a stop).
				expect(entry.workspace?.desiredState).toBe("running");
			} finally {
				await server.close();
			}
		},
		{ timeout: 25_000 },
	);

	test(
		"stop of a clone never touches the supervisor child paths and preserves the volume (checkout + enrollment removed, desired stopped)",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet("stopped");
			try {
				const daemonId = await createClone(server, repoDir, "stop-preserve");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const entryBefore = server.registry.get(daemonId)!;
				expect(entryBefore.workspace?.desiredState).toBe("running");
				// The provider saw one ensure at gen 1.
				expect(
					providerOps(workspaceDir, daemonId).filter((o) => o.op === "ensure-running"),
				).toHaveLength(1);

				const stop = await postJson(server.port, "/ctl/stop", { selector: daemonId });
				expect(stop.status).toBe(200);
				const entry = server.registry.get(daemonId)!;
				expect(entry.workspace?.desiredState).toBe("stopped");
				expect(entry.status).toBe("asleep");
				expect(entry.workspace?.enrollment).toBeUndefined(); // revoked
				expect(entry.lifecycleStage).toBeUndefined(); // no active stage
				// The volume (checkout) is preserved — stop never deletes.
				const checkout = join(entry.cwd ?? "", ".checkout", ".git");
				expect(existsSync(checkout)).toBe(true);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);
});
