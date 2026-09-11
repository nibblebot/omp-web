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
 *  4. kubernetes restart rediscovery: a restart reattaches the SAME Pod/PVC
 *     identity recorded by the provider (inspect-only, never a second
 *     ensure), and an attempted-but-failed launch is retried at its
 *     recorded lastAttemptedGeneration with its ORIGINAL credential.
 *
 *  5. retention: an initialized checkout keeps later commits, tracked
 *     modifications, and untracked files across stop, wake, and a fleet
 *     restart — nothing re-prepares the volume.
 *
 *  6. identity reconciliation: a legacy record with no persisted provider
 *     kind is inferred bwrap from its verified local preparation marker; a
 *     kubernetes record with no persisted binding is marked unavailable and
 *     KEEPS its provider-recorded resources for manual recovery.
 *
 * Fixtures: a real local git repo for the clone source, scripted fake
 * provider executables speaking OMP_PROVIDER_PROTO = 2 (stdin request /
 * stdout response, recording every request's op + generation + proto +
 * credential + binding), a fake kubectl for fleet-side namespace-uid
 * resolution, and real fleet boots via startTestFleet (restart = close +
 * rebind the same statePath). Git identity uses the repo's local config,
 * never global overrides.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetServer } from "./server";
import type { FleetPaths } from "./server.testkit";
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
afterEach(restoreEnv);

await pinSettingsInMemory();

/** Namespace uid the fake kubectl reports; bound into every kubernetes record. */
const KUBE_NAMESPACE_UID = "ns-uid-0001";
/** Fleet callback origin a kubernetes profile accepts (https, non-loopback). */
const KUBE_CALLBACK_URL = "https://fleet.example.invalid";

const envRestore: Array<() => void> = [];

/** Set one env var for the current test, restoring it afterwards. */
function setEnv(key: string, value: string): void {
	const previous = process.env[key];
	process.env[key] = value;
	envRestore.push(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
}

function restoreEnv(): void {
	for (const restore of envRestore.splice(0)) restore();
}

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

/**
 * Real git repo with one commit. Identity is repo-local (the operator's
 * global config is never relied on or mutated).
 */
async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/**
 * A scripted fake provider executable. Every request it receives is appended
 * as JSON to `<stateDir>/ops.jsonl` (op, generation, request providerProto,
 * the credential the handoff file carries, the kubernetes binding). A request
 * that is not OMP_PROVIDER_PROTO = 2 aborts the fake: the v2 wire is the
 * fake's hard precondition, not an assumption. `scenario` picks the op
 * responses:
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
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
if (req.providerProto !== 2) {
  console.error("provider request proto " + JSON.stringify(req.providerProto));
  process.exit(3);
}
mkdirSync(req.stateDir, { recursive: true });
let token = null;
const envFile = join(req.stateDir, "callback-env.json");
if (existsSync(envFile)) {
  try { token = JSON.parse(readFileSync(envFile, "utf8")).env.OMP_SESSION_CALLBACK_TOKEN; } catch {}
}
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation, providerProto: req.providerProto, token, kubernetes: req.kubernetes ?? null }) + "\\n");
const scenario = ${JSON.stringify(scenario)};
const ok = (observed) => JSON.stringify({ ok: true, providerProto: 2, handle: req.handle ?? "h", observed, pid: 4242 });
const fail = (code, message) => JSON.stringify({ ok: false, providerProto: 2, error: { code, message, retryable: true } });
if (op === "ensure-running") {
  console.log(ok("running"));
} else if (op === "inspect") {
  if (scenario === "uncertain") console.log(fail("conflict", "predecessor termination uncertain"));
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

/**
 * A scripted fake kubernetes provider. It owns durable "resources" in
 * `<stateDir>/kube.json`: `ensure-running` creates the Pod/PVC exactly once
 * (only when no Pod uid is recorded) and every successful response echoes the
 * SAME uids, so a restart that re-ensures instead of reattaching is visible
 * in `ensures`/`ops.jsonl`. `fail-first-ensure` refuses the first ensure with
 * a retryable `unavailable`, then succeeds — the failed-launch fixture.
 */
function writeKubeProvider(dir: string, scenario: "adopt" | "fail-first-ensure"): string {
	const executable = join(dir, "fake-kube-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
if (req.providerProto !== 2) {
  console.error("provider request proto " + JSON.stringify(req.providerProto));
  process.exit(3);
}
if (req.kubernetes === undefined) {
  console.error("kubernetes request is missing the resource binding");
  process.exit(3);
}
mkdirSync(req.stateDir, { recursive: true });
const resourcesFile = join(req.stateDir, "kube.json");
let state = null;
try { state = JSON.parse(readFileSync(resourcesFile, "utf8")); } catch {}
if (state === null) state = { creates: 0, ensures: 0, podUid: null, pvcUid: null };
let token = null;
const envFile = join(req.stateDir, "callback-env.json");
if (existsSync(envFile)) {
  try { token = JSON.parse(readFileSync(envFile, "utf8")).env.OMP_SESSION_CALLBACK_TOKEN; } catch {}
}
const record = (fields) => appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify(Object.assign({ op, generation: req.generation, providerProto: req.providerProto, token, kubernetes: req.kubernetes }, fields)) + "\\n");
const ok = (observed) => JSON.stringify({
  ok: true,
  providerProto: 2,
  handle: "pod:" + state.podUid,
  observed,
  kubernetes: { namespaceUid: req.kubernetes.namespaceUid, podUid: state.podUid, pvcUid: state.pvcUid },
});
const scenario = ${JSON.stringify(scenario)};
if (op === "ensure-running") {
  state.ensures += 1;
  if (scenario === "fail-first-ensure" && state.ensures === 1) {
    writeFileSync(resourcesFile, JSON.stringify(state));
    record({ ok: false });
    console.log(JSON.stringify({ ok: false, providerProto: 2, error: { code: "unavailable", message: "cluster API is not reachable", retryable: true } }));
  } else {
    if (state.podUid === null) {
      state.creates += 1;
      state.podUid = randomUUID();
      state.pvcUid = randomUUID();
    }
    writeFileSync(resourcesFile, JSON.stringify(state));
    record({ ok: true });
    console.log(ok("running"));
  }
} else if (op === "inspect") {
  writeFileSync(resourcesFile, JSON.stringify(state));
  record({ ok: true });
  console.log(ok(state.podUid === null ? "missing" : "running"));
} else if (op === "stop") {
  writeFileSync(resourcesFile, JSON.stringify(state));
  record({ ok: true });
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: "pod:" + state.podUid, observed: "stopped", kubernetes: { namespaceUid: req.kubernetes.namespaceUid, podUid: null, pvcUid: state.pvcUid } }));
} else {
  writeFileSync(resourcesFile, JSON.stringify(state));
  record({ ok: true });
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: "pod:" + state.podUid, observed: "missing", kubernetes: { namespaceUid: req.kubernetes.namespaceUid, podUid: state.podUid, pvcUid: state.pvcUid } }));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/** Fake fleet-side kubectl: reports one namespace API uid for the binding. */
function writeFakeKubectl(dir: string): string {
	const executable = join(dir, "kubectl");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
console.log(${JSON.stringify(KUBE_NAMESPACE_UID)});
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

interface RecordedOp {
	op: string;
	generation: number;
	providerProto: number;
	token: string | null;
	kubernetes: unknown;
}

/** Recorded provider ops from one provider state dir. */
function readOps(stateDir: string): RecordedOp[] {
	try {
		const raw = readFileSync(join(stateDir, "ops.jsonl"), "utf8");
		return raw
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as RecordedOp);
	} catch {
		return [];
	}
}

/** Recorded provider ops from a bwrap workspace's state dir. */
function providerOps(workspaceDir: string, daemonId: string): RecordedOp[] {
	return readOps(join(workspaceDir, ".provider-state", daemonId));
}

/** The provider state dir a kubernetes workspace's resource identity owns. */
function kubeStateDir(workspaceDir: string, resourceIdentity: string): string {
	return join(workspaceDir, ".kubernetes", resourceIdentity);
}

interface KubeResources {
	creates: number;
	ensures: number;
	podUid: string | null;
	pvcUid: string | null;
}

/** The fake kubernetes provider's durable "Pod/PVC" record. */
function kubeResources(stateDir: string): KubeResources {
	return JSON.parse(readFileSync(join(stateDir, "kube.json"), "utf8")) as KubeResources;
}

/**
 * Drop one fleet-private workspace field from the persisted state file,
 * simulating a record written by an older fleet process (no provider kind,
 * or a kubernetes record whose binding was never persisted).
 */
function stripWorkspaceField(
	statePath: string,
	daemonId: string,
	field: "providerKind" | "kubernetes",
): void {
	const file = JSON.parse(readFileSync(statePath, "utf8")) as {
		entries: Array<{ daemonId: string; workspace?: Record<string, unknown> }>;
	};
	const entry = file.entries.find((candidate) => candidate.daemonId === daemonId);
	if (entry?.workspace === undefined) throw new Error(`no persisted workspace for ${daemonId}`);
	delete entry.workspace[field];
	writeFileSync(statePath, JSON.stringify(file));
}

interface TestFleet {
	server: FleetServer;
	paths: FleetPaths;
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

/** Boot a fresh bwrap fleet on the SAME paths (a fleet restart). */
function rebootBwrapFleet(
	fleet: TestFleet,
	scenario: "reattach-running" | "dead-after-ensure" | "uncertain" | "stopped",
): Promise<FleetServer> {
	return startTestFleet(
		{ statePath: fleet.paths.statePath, configPath: fleet.paths.configPath },
		{
			workspaceDir: fleet.workspaceDir,
			providerProfiles: {
				local: {
					id: "local",
					provider: "bwrap",
					executable: writeFakeProvider(join(fleet.paths.tmp, "provider-next"), scenario),
					tools: [],
				},
			},
		},
		{ workspaceDir: fleet.workspaceDir },
	);
}

interface KubeFleet {
	server: FleetServer;
	paths: FleetPaths;
	workspaceDir: string;
	repoDir: string;
	/** Remote source the fleet can pin: rewritten to the local repo by git. */
	remote: string;
	/** Start a fresh fleet process on the same paths (a restart). */
	boot(): Promise<void>;
	close(): Promise<void>;
}

const KUBE_REMOTE = "https://example.invalid/omp/repo.git";

/**
 * Boot a fleet whose "local" profile is a kubernetes provider: a fake kubectl
 * answers the fleet-side namespace-uid resolution, the callback URL is a
 * kubernetes-acceptable https origin, and git rewrites the remote source to a
 * real local repo so pin resolution stays offline.
 */
async function bootKubernetesFleet(
	scenario: "adopt" | "fail-first-ensure" = "adopt",
): Promise<KubeFleet> {
	const paths = fleetPaths("omp-clone-kube-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const providerExecutable = writeKubeProvider(join(paths.tmp, "provider"), scenario);
	setEnv("OMP_KUBE_BIN", writeFakeKubectl(join(paths.tmp, "bin")));
	setEnv("OMP_FLEET_CALLBACK_URL", KUBE_CALLBACK_URL);
	setEnv("GIT_CONFIG_COUNT", "1");
	setEnv("GIT_CONFIG_KEY_0", `url.file://${repoDir}.insteadOf`);
	setEnv("GIT_CONFIG_VALUE_0", KUBE_REMOTE);
	const launch = (): Promise<FleetServer> =>
		startTestFleet(
			{ statePath: paths.statePath, configPath: paths.configPath },
			{
				workspaceDir,
				providerProfiles: {
					local: {
						id: "local",
						provider: "kubernetes",
						executable: providerExecutable,
						tools: [],
						image: "example.invalid/runtime:latest",
						namespace: "test-ns",
						context: "test-ctx",
					},
				},
			},
			{ workspaceDir },
		);
	const fleet: KubeFleet = {
		server: await launch(),
		paths,
		workspaceDir,
		repoDir,
		remote: KUBE_REMOTE,
		async boot() {
			fleet.server = await launch();
		},
		async close() {
			await fleet.server.close().catch(() => {
				// Already closed for a restart.
			});
		},
	};
	return fleet;
}

/** Create a clone (no start), returning its daemonId. */
async function createClone(
	server: FleetServer,
	repoDir: string,
	name: string,
	source?: { remote: string },
): Promise<string> {
	const project = await server.registry.addProject(repoDir);
	const res = await postJson(server.port, "/ctl/clones", {
		projectId: project.projectId,
		name,
		profileId: "local",
		start: false,
		...(source !== undefined ? { source } : {}),
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { entry: { daemonId: string } };
	return body.entry.daemonId;
}

describe("clone recovery: restart durable boundaries + races", () => {
	test(
		"restart reattaches a live desired-running sandbox at the SAME generation — never a second writer",
		async () => {
			const fleet = await bootFleet("reattach-running");
			const { server, workspaceDir, repoDir } = fleet;
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
				const inspectsBefore = providerOps(workspaceDir, daemonId).filter(
					(o) => o.op === "inspect",
				).length;
				await server.close();
				const server2 = await rebootBwrapFleet(fleet, "reattach-running");
				try {
					// Boot reconcile is fire-and-forget: wait for its reattach
					// side-effect (a provider inspect). Readiness belongs to the
					// readiness owner, so the reattachment no longer writes
					// lifecycleStage "ready" itself.
					await waitFor(
						() =>
							providerOps(workspaceDir, daemonId).filter((o) => o.op === "inspect").length >
							inspectsBefore,
						5_000,
						"reconcile reattach after restart",
					);
					entry = server2.registry.get(daemonId)!;
					// Reattach publishes the transitional session rung + the
					// callback stage: readiness belongs to the readiness owner,
					// so no lifecycle path writes either ready field.
					expect(entry.status).toBe("session");
					expect(entry.lifecycleStage).toBe("callback");
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
					expect(ensures[0]!.providerProto).toBe(2); // v2 wire
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
			const fleet = await bootFleet("stopped");
			const { server, workspaceDir, repoDir } = fleet;
			try {
				const daemonId = await createClone(server, repoDir, "dead-restart");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				expect(server.registry.get(daemonId)!.workspace?.authorizedGeneration).toBe(1);

				// Simulate the sandbox dying between the stop and the restart:
				// the provider's inspect reports stopped/missing from boot.
				await server.close();
				const server2 = await rebootBwrapFleet(fleet, "stopped");
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
					// The recreated sandbox is running but unvalidated: the
					// transitional session rung, never readiness.
					expect(entry.status).toBe("session");
					expect(entry.lifecycleStage).toBe("callback");
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
				// would have, mid-launch): the provider now answers inspect
				// with conflict. The lifecycle's own provider-running rung is
				// the transitional session + callback stage — readiness is
				// never a lifecycle write.
				server.registry.updateWorkspace(daemonId, {
					desiredState: "running",
					authorizedGeneration: 1,
					providerHandle: "h-1",
				});
				server.registry.setStatus(daemonId, "session");
				server.registry.update(daemonId, { lifecycleStage: "callback" });
				// Start/wake must refuse: the inspect conflict means the
				// predecessor's termination is uncertain — no new writer may be
				// admitted (P6.2).
				const wake = await postJson(server.port, "/ctl/start", { daemonId });
				expect(wake.status).toBe(409);
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
				// Provider-running is never readiness: the clone sits on the
				// transitional session rung + callback stage until a validated
				// hello_ok/ready promotes it (and this fake never dials).
				expect(entry.status).toBe("session");
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

describe("kubernetes restart rediscovery", () => {
	test(
		"a restart reattaches the SAME Pod/PVC identity without a duplicate create",
		async () => {
			const fleet = await bootKubernetesFleet();
			try {
				const daemonId = await createClone(fleet.server, fleet.repoDir, "kube-reattach", {
					remote: fleet.remote,
				});
				const start = await postJson(fleet.server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const entry = fleet.server.registry.get(daemonId)!;
				const binding = entry.workspace?.kubernetes;
				expect(entry.workspace?.providerKind).toBe("kubernetes");
				expect(binding?.resourceIdentity).toMatch(/^[0-9a-f]{32}$/);
				expect(binding?.namespaceUid).toBe(KUBE_NAMESPACE_UID);
				expect(entry.workspace?.authorizedGeneration).toBe(1);
				const stateDir = kubeStateDir(fleet.workspaceDir, binding!.resourceIdentity);
				const resourcesBefore = kubeResources(stateDir);
				expect(resourcesBefore.creates).toBe(1);
				expect(resourcesBefore.ensures).toBe(1);
				expect(resourcesBefore.podUid).not.toBeNull();
				expect(entry.workspace?.providerHandle).toBe(`pod:${resourcesBefore.podUid}`);

				// The request carried the v2 wire and the persisted binding.
				const opsBefore = readOps(stateDir);
				expect(opsBefore[0]!.providerProto).toBe(2);
				expect(opsBefore[0]!.kubernetes).toEqual({
					resourceIdentity: binding!.resourceIdentity,
					context: "test-ctx",
					namespace: "test-ns",
					namespaceUid: KUBE_NAMESPACE_UID,
				});
				expect(opsBefore.filter((op) => op.op === "ensure-running")).toHaveLength(1);

				// FLEET RESTART on the same statePath + provider state dir.
				await fleet.close();
				await fleet.boot();
				// Wait for the reattach side-effect (a fresh provider inspect).
				// Readiness belongs to the readiness owner, so a reattachment no
				// longer writes lifecycleStage "ready" itself.
				await waitFor(
					() =>
						readOps(stateDir)
							.slice(opsBefore.length)
							.some((op) => op.op === "inspect"),
					5_000,
					"kubernetes reattach after restart",
				);

				const tail = readOps(stateDir).slice(opsBefore.length);
				expect(tail.some((op) => op.op === "inspect")).toBe(true);
				expect(tail.filter((op) => op.op === "ensure-running")).toHaveLength(0);
				const resourcesAfter = kubeResources(stateDir);
				expect(resourcesAfter.creates).toBe(1);
				expect(resourcesAfter.ensures).toBe(1);
				expect(resourcesAfter.podUid).toBe(resourcesBefore.podUid);
				expect(resourcesAfter.pvcUid).toBe(resourcesBefore.pvcUid);
				const entryAfter = fleet.server.registry.get(daemonId)!;
				// The reattach published the transitional session rung + the
				// callback stage — readiness is the readiness owner's.
				expect(entryAfter.status).toBe("session");
				expect(entryAfter.lifecycleStage).toBe("callback");
				expect(entryAfter.workspace?.authorizedGeneration).toBe(1); // NO bump
				expect(entryAfter.workspace?.kubernetes).toEqual(binding);
				expect(entryAfter.workspace?.providerHandle).toBe(`pod:${resourcesBefore.podUid}`);
			} finally {
				await fleet.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a failed launch is retried at its recorded generation with the original credential",
		async () => {
			const fleet = await bootKubernetesFleet("fail-first-ensure");
			try {
				const daemonId = await createClone(fleet.server, fleet.repoDir, "kube-retry", {
					remote: fleet.remote,
				});
				const binding = fleet.server.registry.get(daemonId)!.workspace!.kubernetes!;
				const stateDir = kubeStateDir(fleet.workspaceDir, binding.resourceIdentity);

				// First launch: the provider refuses. The attempt generation and
				// the handoff credential stay durable.
				const failed = await postJson(fleet.server.port, "/ctl/start", { daemonId });
				expect(failed.status).toBe(503);
				const attempted = fleet.server.registry.get(daemonId)!;
				expect(attempted.workspace?.lastAttemptedGeneration).toBe(1);
				expect(attempted.workspace?.authorizedGeneration).toBeUndefined();

				// Retry: the SAME generation, reusing the attempt's credential.
				const retry = await postJson(fleet.server.port, "/ctl/start", { daemonId });
				expect(retry.status).toBe(200);
				const recovered = fleet.server.registry.get(daemonId)!;
				expect(recovered.workspace?.lastAttemptedGeneration).toBe(1);
				expect(recovered.workspace?.authorizedGeneration).toBe(1);

				const ensures = readOps(stateDir).filter((op) => op.op === "ensure-running");
				expect(ensures).toHaveLength(2);
				expect(ensures.map((op) => op.generation)).toEqual([1, 1]);
				// The credential the provider observed across both attempts is
				// byte-identical: a regenerated credential would differ here.
				expect(ensures[0]!.token).not.toBeNull();
				expect(ensures[1]!.token).toBe(ensures[0]!.token);
				// ...and the persisted enrollment digest never moved either.
				expect(recovered.workspace?.enrollment?.credentialHash).toBe(
					attempted.workspace?.enrollment?.credentialHash,
				);
				expect(kubeResources(stateDir).creates).toBe(1);
			} finally {
				await fleet.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a kubernetes record without a persisted binding is marked unavailable and keeps its resources",
		async () => {
			const fleet = await bootKubernetesFleet();
			try {
				const daemonId = await createClone(fleet.server, fleet.repoDir, "kube-orphan", {
					remote: fleet.remote,
				});
				const start = await postJson(fleet.server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const binding = fleet.server.registry.get(daemonId)!.workspace!.kubernetes!;
				const stateDir = kubeStateDir(fleet.workspaceDir, binding.resourceIdentity);
				const resourcesBefore = kubeResources(stateDir);
				const opsBefore = readOps(stateDir).length;

				// A record persisted by a fleet that never captured the binding:
				// the provider kind is known, the resource identity is not.
				await fleet.close();
				stripWorkspaceField(fleet.paths.statePath, daemonId, "kubernetes");
				await fleet.boot();

				const entry = fleet.server.registry.get(daemonId)!;
				expect(entry.status).toBe("error");
				expect(entry.lifecycleStage).toBe("failed");
				expect(entry.workspace?.kubernetes).toBeUndefined();
				// Resources are RETAINED (manual recovery): the provider's
				// durable Pod/PVC record is untouched and nothing destructive
				// ran during boot.
				const resourcesAfter = kubeResources(stateDir);
				expect(resourcesAfter.podUid).toBe(resourcesBefore.podUid);
				expect(resourcesAfter.pvcUid).toBe(resourcesBefore.pvcUid);
				expect(resourcesAfter.creates).toBe(1);
				expect(readOps(stateDir)).toHaveLength(opsBefore);
			} finally {
				await fleet.close();
			}
		},
		{ timeout: 20_000 },
	);
});

describe("clone volume retention", () => {
	test(
		"an initialized checkout keeps later commits and dirty files across stop/wake and a fleet restart",
		async () => {
			const fleet = await bootFleet("stopped");
			const { server, workspaceDir, repoDir } = fleet;
			try {
				const daemonId = await createClone(server, repoDir, "retention");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const checkout = join(workspaceDir, daemonId, ".checkout");
				// A later commit plus a tracked modification and an untracked
				// file: the checkout is live user work the lifecycle must never
				// re-prepare out from under a stop, a wake, or a restart.
				await git(checkout, ["config", "user.email", "test@example.com"]);
				await git(checkout, ["config", "user.name", "Test"]);
				writeFileSync(join(checkout, "later.txt"), "later\n");
				await git(checkout, ["add", "later.txt"]);
				await git(checkout, ["commit", "-q", "-m", "later"]);
				const laterCommit = await git(checkout, ["rev-parse", "HEAD"]);
				writeFileSync(join(checkout, "readme.md"), "dirty work\n");
				writeFileSync(join(checkout, "untracked.txt"), "scratch\n");

				const assertPreserved = async (): Promise<void> => {
					expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(laterCommit);
					expect(readFileSync(join(checkout, "readme.md"), "utf8")).toBe("dirty work\n");
					expect(existsSync(join(checkout, "untracked.txt"))).toBe(true);
					const porcelain = await git(checkout, ["status", "--porcelain"]);
					expect(porcelain).toContain("readme.md");
					expect(porcelain).toContain("untracked.txt");
				};
				await assertPreserved();

				const stop = await postJson(server.port, "/ctl/stop", { selector: daemonId });
				expect(stop.status).toBe(200);
				await assertPreserved();

				const wake = await postJson(server.port, "/ctl/start", { daemonId });
				expect(wake.status).toBe(200);
				await assertPreserved();

				await server.close();
				const server2 = await rebootBwrapFleet(fleet, "stopped");
				try {
					// Wait for the post-restart reconcile to re-ensure (gen 3),
					// then prove it did so without touching the checkout.
					await waitFor(
						() => server2.registry.get(daemonId)?.workspace?.authorizedGeneration === 3,
						5_000,
						"post-restart re-ensure",
					);
					await assertPreserved();
				} finally {
					await server2.close();
				}
			} finally {
				await server.close().catch(() => {
					// Already closed for the restart above.
				});
			}
		},
		{ timeout: 25_000 },
	);

	test(
		"a legacy record with no persisted provider kind is inferred bwrap from its verified marker",
		async () => {
			const fleet = await bootFleet("stopped");
			const { server, workspaceDir, repoDir } = fleet;
			try {
				const daemonId = await createClone(server, repoDir, "legacy-kind");
				const volumeRoot = join(workspaceDir, daemonId);
				expect(existsSync(join(volumeRoot, ".omp-workspace-init.json"))).toBe(true);
				expect(server.registry.get(daemonId)!.workspace?.providerKind).toBe("bwrap");

				// A record persisted before the provider kind was captured.
				await server.close();
				stripWorkspaceField(fleet.paths.statePath, daemonId, "providerKind");
				const server2 = await rebootBwrapFleet(fleet, "stopped");
				try {
					await waitFor(
						() => server2.registry.get(daemonId)?.workspace?.providerKind === "bwrap",
						5_000,
						"provider kind inference from the preparation marker",
					);
					expect(server2.registry.get(daemonId)!.workspace?.providerKind).toBe("bwrap");
					// Inference never touched the prepared volume.
					expect(existsSync(join(volumeRoot, ".checkout", ".git"))).toBe(true);
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
		"a legacy record whose verified marker is absent is retained unavailable and never probed",
		async () => {
			const fleet = await bootFleet("reattach-running");
			const { server, workspaceDir, repoDir } = fleet;
			try {
				const daemonId = await createClone(server, repoDir, "legacy-no-marker");
				// Started, so the record carries compute history: without the
				// marker check, boot reconcile would fall through and invoke
				// the provider against an unverified volume.
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const volumeRoot = join(workspaceDir, daemonId);
				const markerPath = join(volumeRoot, ".omp-workspace-init.json");
				expect(existsSync(markerPath)).toBe(true);
				const inspectsBefore = providerOps(workspaceDir, daemonId).filter(
					(o) => o.op === "inspect",
				).length;

				await server.close();
				rmSync(markerPath);
				stripWorkspaceField(fleet.paths.statePath, daemonId, "providerKind");
				const server2 = await rebootBwrapFleet(fleet, "reattach-running");
				try {
					await waitFor(
						() => server2.registry.get(daemonId)?.status === "error",
						5_000,
						"legacy unavailable marking",
					);
					const entry = server2.registry.get(daemonId)!;
					expect(entry.workspace?.providerKind).toBeUndefined();
					expect(entry.lifecycleStage).toBe("failed");
					// Compute and storage retained for manual recovery, and the
					// provider was never invoked for this record.
					expect(existsSync(volumeRoot)).toBe(true);
					expect(providerOps(workspaceDir, daemonId).filter((o) => o.op === "inspect").length).toBe(
						inspectsBefore,
					);
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
		"a legacy record whose marker names another workspace is retained unavailable and never probed",
		async () => {
			const fleet = await bootFleet("reattach-running");
			const { server, workspaceDir, repoDir } = fleet;
			try {
				const daemonId = await createClone(server, repoDir, "legacy-foreign-marker");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const volumeRoot = join(workspaceDir, daemonId);
				const markerPath = join(volumeRoot, ".omp-workspace-init.json");
				const inspectsBefore = providerOps(workspaceDir, daemonId).filter(
					(o) => o.op === "inspect",
				).length;

				// A structurally valid marker copied from ANOTHER workspace: it
				// must never be accepted as this record's identity proof.
				await server.close();
				const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { workspaceId: string };
				marker.workspaceId = "d999-foreign";
				writeFileSync(markerPath, JSON.stringify(marker));
				stripWorkspaceField(fleet.paths.statePath, daemonId, "providerKind");
				const server2 = await rebootBwrapFleet(fleet, "reattach-running");
				try {
					await waitFor(
						() => server2.registry.get(daemonId)?.status === "error",
						5_000,
						"foreign marker unavailable marking",
					);
					const entry = server2.registry.get(daemonId)!;
					expect(entry.workspace?.providerKind).toBeUndefined();
					expect(entry.lifecycleStage).toBe("failed");
					expect(existsSync(volumeRoot)).toBe(true);
					expect(providerOps(workspaceDir, daemonId).filter((o) => o.op === "inspect").length).toBe(
						inspectsBefore,
					);
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
});
