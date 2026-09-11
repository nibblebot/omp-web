/**
 * Clone-workspace deletion lifecycle tests (clone-plan P7.3/P7.5 —
 * DeletionSafetyTests). Deterministic failure-transition regressions over
 * the real fleet control plane (loopback HTTP) with a real git clone source
 * and a scripted fixture provider executable that keeps DURABLE operation
 * records (`<stateDir>/ops.jsonl`, appended on every provider request). No
 * test depends on error wording or source text — every assertion is an
 * observable retention / refusal / retry / no-double-writer contract:
 *
 *  1. live-writer refusal + no bypass: deleting a desired-running clone is
 *     refused and a second delete attempt through the same gate is refused
 *     again — the roster entry, the volume, and the enrollment survive and
 *     the provider never sees a delete;
 *  2. serialized concurrent deletes: parallel deletes of a stopped,
 *     verified workspace complete exactly one destroy (one entry removal,
 *     one provider delete) — the loser is refused, never a double delete;
 *  3. incomplete store retains registry/volume: an interrupted (never
 *     fully acked) workspace's delete is blocked with everything retained
 *     and a durable delete-pending-retry state;
 *  4. verified store, provider-delete failure → accurate retry state, then
 *     a successful retry: after the read-only flip a failing provider
 *     delete leaves delete-pending-retry + remainingResources and keeps the
 *     entry + volume + verified store; a retry (even after a fleet restart
 *     on the same state) completes exactly one destroy;
 *  5. clone-source validation (replaces the old wording-pinning validator
 *     test): a valid local-only source and a valid remote-only (file://)
 *     source both clone successfully and materialize a real volume, while
 *     an invalid source (both members set, or a wrongly typed member) is
 *     refused with a 400 and creates no workspace;
 *  6. kubernetes admission: a local source, an invalid remote (file:, no
 *     repository path, scp syntax), and a missing/invalid branch are all
 *     refused invalid_request before any provider call;
 *  7. kubernetes binding stability: a changed persisted binding (a mutated
 *     namespace uid, or a provider observing a different namespace uid) is
 *     refused conflict with the record and desired state untouched;
 *  8. provider error mapping: a timeout becomes retryable and an internal
 *     failure provider_failed on the lifecycle error;
 *  9. per-workspace serialization: two concurrent lifecycle operations
 *     reach the provider in call order through its durable request log;
 * 10. attempted-generation reuse: a failed launch keeps its attempt and
 *     handoff so the retry reuses that generation and credential, while a
 *     replacement after a proven stop uses a larger generation;
 * 11. kubernetes delete gate: final evidence is collected BEFORE the
 *     provider stop, the pending receipt's request id is the one handed to
 *     the collector, and an invalid receipt blocks with the workspace,
 *     volume, and store all retained;
 * 12. failed ahead attempt: evidence is collected while the attempt's
 *     callback pair is still enrolled, then the provider is fenced at the
 *     ATTEMPTED generation for both the stop and the delete; a rejected
 *     attempt replays its persisted request id;
 * 13. provider invocation budget: an operation held past runProviderOp's
 *     30 s default still completes (the fleet applies the computed waits);
 * 14. boot reconciliation of attempted generations: an attempted-only
 *     record is inspected and fenced rather than skipped, and an ahead
 *     attempt is never reattached at the stale authorized generation (it is
 *     fenced when desired stopped and retried when desired running);
 * 15. post-verification recovery: a provider-delete failure resumes at
 *     cleanup without re-running the pre-stop handshake and refuses
 *     clear-deletion, while a pre-verification rejection stays clearable;
 * 16. deletion edge cases: an empty but VERIFIED receipt authorizes a
 *     kubernetes clone with no fleet-readable volume, an interrupted
 *     deletion keeps its replay id + remaining resources across boot, and a
 *     live workspace errored by the readiness probe is still refused;
 * 17. stop-time evidence: an explicit stop persists the validated receipt
 *     for its generation (durably), a delete whose Pod is gone adopts it
 *     instead of failing closed, a receipt bound to an older generation is
 *     never reused, a stop whose collection failed still stops and reports
 *     THAT failure at delete, and a workspace with no evidence at all still
 *     fails closed.
 *
 * Fixtures reuse fleet/server.testkit's fleetPaths/startTestFleet (real
 * startFleet on ephemeral ports, state under a tracked temp dir). The
 * kubernetes cases in the second half drive WorkspaceLifecycle directly so
 * the delete gate's evidence collector can be injected. Git identity comes
 * only from the operator's gitconfig — never overridden.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CALLBACK_ENV_FILE } from "../runtime/callback-env";
import { PROVIDER_OP_TIMEOUT_MS_DEFAULT } from "../runtime/provider-exec";
import {
	computeSourcePinDigest,
	OMP_PROVIDER_PROTO,
	type KubernetesBinding,
} from "../shared/provider-protocol";
import {
	CloneQuiesceError,
	type CloneQuiesceReceipt,
	type CloneQuiesceRequest,
} from "./clone-quiesce";
import { DaemonTransportRegistry, type PairStatus } from "./daemon-transport";
import { FleetEventLog } from "./events";
import { FleetLogStore } from "./log-store";
import type { ProviderProfile } from "./provider-profile";
import type { RegistryEntry, WorkspaceDeletion } from "./registry";
import { Registry } from "./registry";
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
import { CloneLifecycleError, WorkspaceLifecycle } from "./workspace-lifecycle";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
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

/** Real local git repo with one commit on `main` (operator identity only). */
async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

interface OpsRecord {
	op: string;
	generation: number | null;
	handle: string | null;
	/** `providerProto` the fleet sent on the request (v2 contract). */
	providerProto: number | null;
	/** The request's kubernetes binding, or null for a bwrap request. */
	kubernetes: KubernetesBinding | null;
	profileProvider: "bwrap" | "kubernetes" | null;
	profileContext: string | null;
	profileNamespace: string | null;
	startedAt: number;
	endedAt: number;
	ok: boolean;
	code: string | null;
}

/** Parse one provider-op JSONL log (missing/unreadable → []). */
function readOps(opsPath: string): OpsRecord[] {
	try {
		const raw = readFileSync(opsPath, "utf8");
		return raw
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as OpsRecord);
	} catch {
		return [];
	}
}

/** Durable provider-op records from a bwrap workspace's provider state dir. */
function providerOps(workspaceDir: string, daemonId: string): OpsRecord[] {
	return readOps(join(workspaceDir, ".provider-state", daemonId, "ops.jsonl"));
}

/** Persisted provider delete attempts (survives fleet restarts). */
function deleteCount(workspaceDir: string, daemonId: string): number {
	try {
		return (
			Number.parseInt(
				readFileSync(join(workspaceDir, ".provider-state", daemonId, "delete-count.json"), "utf8"),
				10,
			) || 0
		);
	} catch {
		return 0;
	}
}

interface ProviderScenario {
	/** ensure-running / inspect response while desired-running (admission live). */
	runningWhileLive: boolean;
	/** stop response observed (quiesce proof). */
	stopObserved: "stopped" | "running";
	/** delete failures: consecutive "delete" requests to fail before succeeding. */
	deleteFailures: number;
	/** Kubernetes namespace uid the provider reports (the namespace's truth). */
	namespaceUid?: string;
	/** Kubernetes Pod uid observed (null = no Pod). */
	podUid?: string | null;
	/** Kubernetes PVC uid observed (null = no claim). */
	pvcUid?: string | null;
	/** Per-op observed override, taking precedence over the fields above. */
	observed?: Partial<Record<"ensure-running" | "inspect" | "stop" | "delete", string>>;
	/** Inject one typed provider error for one op. */
	error?: { op: "ensure-running" | "inspect" | "stop" | "delete"; code: string };
	/**
	 * Hold one op's response for `ms` before answering. Used to prove the
	 * fleet's invocation budget covers a wait longer than runProviderOp's
	 * 30 s default.
	 */
	delayOp?: { op: "ensure-running" | "inspect" | "stop" | "delete"; ms: number };
}

/**
 * Scripted fixture provider executable speaking OMP_PROVIDER_PROTO = 2 as a
 * kubernetes/bwrap profile's executable (argv is the executable plus one op;
 * one JSON request on stdin, one JSON envelope on stdout). The scenario is
 * read from scenario.json beside the executable on EVERY invocation
 * (setScenario mutates it mid-test), so one fake can fail once and succeed on
 * a retry. Every request is durably appended to ops.jsonl under the request's
 * stateDir (the provider state dir lives under the fleet workspaceDir, so the
 * record survives fleet restarts): op, generation, handle, providerProto, the
 * request's kubernetes binding, the profile's context/namespace, and the
 * invocation's [startedAt, endedAt] interval. That log is what the
 * request-ordering assertions read.
 *
 * A kubernetes request gets the v2 kubernetes observation back (the scenario's
 * namespace/Pod/PVC uids). Like the real provider, a profile whose
 * context/namespace disagrees with the request's persisted binding is refused
 * conflict, never a silent re-anchor. deleteFailures controls how many initial
 * delete requests fail (unavailable); stopObserved can refuse to prove
 * termination.
 */
function writeFakeProvider(dir: string, scenario: Partial<ProviderScenario>): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
	const scenarioPath = join(dir, "scenario.json");
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const scenarioPath = ${JSON.stringify(scenarioPath)};
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
const startedAt = Date.now();

// A held response proves the fleet invoked this executable with a budget that
// covers the hold. This is a deliberate real-clock delay (the fleet's
// runProviderOp kill timer lives in the parent process and cannot be faked
// here): it is the only way to observe that the fleet applied the computed
// provider-op timeout instead of the 30 s default.
if (scenario.delayOp !== undefined && scenario.delayOp.op === op) {
  const hold = Promise.withResolvers();
  setTimeout(hold.resolve, scenario.delayOp.ms);
  await hold.promise;
}

const isKube = req.profile !== undefined && req.profile.provider === "kubernetes";
const kube = isKube
  ? {
      namespaceUid: scenario.namespaceUid || "ns-uid-1",
      podUid: scenario.podUid === undefined ? "pod-uid-1" : scenario.podUid,
      pvcUid: scenario.pvcUid === undefined ? "pvc-uid-1" : scenario.pvcUid,
    }
  : undefined;

let observed = "missing";
if (scenario.observed !== undefined && scenario.observed[op] !== undefined) observed = scenario.observed[op];
else if (op === "ensure-running") observed = "running";
else if (op === "inspect") observed = scenario.runningWhileLive ? "running" : "stopped";
else if (op === "stop") observed = scenario.stopObserved || "stopped";

let fault = null;
if (req.kubernetes !== undefined && req.profile !== undefined) {
  if (req.profile.context !== undefined && req.profile.context !== req.kubernetes.context) {
    fault = ["conflict", "profile context disagrees with the persisted binding"];
  } else if (req.profile.namespace !== undefined && req.profile.namespace !== req.kubernetes.namespace) {
    fault = ["conflict", "profile namespace disagrees with the persisted binding"];
  }
}
if (fault === null && scenario.error !== undefined && scenario.error.op === op) {
  fault = [scenario.error.code, "scripted provider failure"];
}

const countFile = join(req.stateDir, "delete-count.json");
let deleteAttempt = null;
if (op === "delete") {
  deleteAttempt = (existsSync(countFile) ? Number.parseInt(readFileSync(countFile, "utf8"), 10) : 0) || 0;
  deleteAttempt += 1;
  writeFileSync(countFile, String(deleteAttempt));
  if (fault === null && deleteAttempt <= (scenario.deleteFailures || 0)) {
    fault = ["unavailable", "provider storage busy; delete failed"];
  }
}

const envelope = fault !== null
  ? { ok: false, providerProto: ${OMP_PROVIDER_PROTO}, error: { code: fault[0], message: fault[1], retryable: fault[0] === "unavailable" || fault[0] === "timeout" } }
  : { ok: true, providerProto: ${OMP_PROVIDER_PROTO}, handle: req.handle || "h", observed: observed, pid: 4242, kubernetes: kube };

appendFileSync(
  join(req.stateDir, "ops.jsonl"),
  JSON.stringify({
    op: op,
    generation: req.generation,
    handle: req.handle === undefined ? null : req.handle,
    providerProto: req.providerProto,
    profileProvider: req.profile ? req.profile.provider : null,
    profileContext: req.profile ? req.profile.context : null,
    profileNamespace: req.profile ? req.profile.namespace : null,
    kubernetes: req.kubernetes === undefined ? null : req.kubernetes,
    startedAt: startedAt,
    endedAt: Date.now(),
    deleteAttempt: deleteAttempt,
    ok: envelope.ok,
    code: envelope.ok ? null : envelope.error.code,
  }) + String.fromCharCode(10),
);
console.log(JSON.stringify(envelope));
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/** Rewrite the fake provider's live scenario (merged into the current one). */
function setScenario(dir: string, patch: Partial<ProviderScenario>): void {
	const scenarioPath = join(dir, "scenario.json");
	const current = JSON.parse(readFileSync(scenarioPath, "utf8")) as Partial<ProviderScenario>;
	writeFileSync(scenarioPath, JSON.stringify({ ...current, ...patch }));
}

/**
 * JSONL session transcript: a title slot, a session header, then one
 * assistant message line — all newline-terminated. Matches the daemon's
 * streamed lineage layout (`<sessionDir>/<sessionId>.jsonl`).
 */
const SESSION_ID = "s1";

/** Modern SDK layout: title slot line, session header line, one entry. */
function transcriptJsonl(): string {
	const title = { type: "title", v: 1, title: "t", updatedAt: "2026-01-01T00:00:00.000Z", pad: "" };
	const header = { type: "session", id: "uuid-minted", sessionId: SESSION_ID, ts: 1 };
	const entry = {
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		ts: 2,
	};
	return `${JSON.stringify(title)}\n${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
}

/** Store-side `readonly.json` marker for a verified workspace. */
function readOnlyMarker(logsDir: string, daemonId: string): string {
	return join(logsDir, daemonId, "readonly.json");
}

/** Volumes: the workspace volume root and its session tree root. */
function volumePaths(workspaceDir: string, daemonId: string): { root: string; sessions: string } {
	const root = join(workspaceDir, daemonId);
	return { root, sessions: join(root, ".home", "agent", "sessions") };
}

/**
 * Seed a structurally valid, offset-contiguous session in BOTH the fleet
 * log store (logs/<workspaceId>/<sessionId>) and the workspace volume
 * (`.home/agent/sessions/<sessionId>`), with the index's ackedOffset
 * optionally short of the stored bytes.
 */
function seedSession(
	logsDir: string,
	workspaceDir: string,
	daemonId: string,
	opts: { ackedOffset?: number },
): void {
	const bytes = transcriptJsonl();
	const storeDir = join(logsDir, daemonId, SESSION_ID);
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(join(storeDir, `${SESSION_ID}.jsonl`), bytes);
	writeFileSync(
		join(storeDir, "index.json"),
		JSON.stringify({
			version: 1,
			workspaceId: daemonId,
			sessionId: SESSION_ID,
			streams: {
				[`${SESSION_ID}.jsonl`]: {
					generation: 1,
					ackedOffset: opts.ackedOffset ?? Buffer.byteLength(bytes, "utf8"),
					eof: true,
				},
			},
		}),
	);
	const volumeDir = join(volumePaths(workspaceDir, daemonId).sessions, SESSION_ID);
	mkdirSync(volumeDir, { recursive: true });
	writeFileSync(join(volumeDir, `${SESSION_ID}.jsonl`), bytes);
}

interface FleetFixture {
	server: FleetServer;
	paths: { tmp: string; statePath: string; configPath: string };
	workspaceDir: string;
	logsDir: string;
	repoDir: string;
}

/**
 * Boot a fleet with a fake provider profile over a tracked temp dir: real
 * workspaceDir + state under tmp (fleet logs live at <tmp>/logs). Registers
 * a local git repo as the clone project.
 */
async function bootFleet(scenario: ProviderScenario): Promise<FleetFixture> {
	const paths = fleetPaths("omp-workspace-lifecycle-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const logsDir = join(paths.tmp, "logs");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const fakeProvider = writeFakeProvider(join(paths.tmp, "provider"), scenario);
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
	return { server, paths, workspaceDir, logsDir, repoDir };
}

/** Create a clone of the registered repo, returning its daemonId. */
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

/** DELETE /ctl/worktrees/:id on the given fleet. */
function deleteWorkspace(port: number, daemonId: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/ctl/worktrees/${daemonId}`, { method: "DELETE" });
}

describe("clone workspace deletion lifecycle (P7.3/P7.5)", () => {
	test(
		"deleting a live desired-running clone is refused with everything retained — and a second attempt cannot bypass the refusal",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet({
				runningWhileLive: true,
				stopObserved: "stopped",
				deleteFailures: 0,
			});
			try {
				const daemonId = await createClone(server, repoDir, "live");
				// Start: desired running, gen 1, enrollment persisted.
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const running = server.registry.get(daemonId)!;
				expect(running.status).toBe("ready");
				expect(running.workspace?.desiredState).toBe("running");
				expect(running.workspace?.enrollment?.generation).toBe(1);

				// The provider reports a live sandbox → the admission gate
				// refuses (activity is not observable fleet-side for clones).
				const del1 = await deleteWorkspace(server.port, daemonId);
				expect(del1.status).toBe(409); // writer_active maps to 409
				// A second delete (through the SAME verified gate) is refused
				// again — no state change, no bypass, no accidental delete.
				const del2 = await deleteWorkspace(server.port, daemonId);
				expect(del2.status).toBe(409);

				// Everything retained: roster entry present, volume present,
				// no provider delete op, still enrolled at gen 1.
				const after = server.registry.get(daemonId)!;
				expect(after.status).toBe("ready");
				expect(after.workspace?.desiredState).toBe("running");
				expect(after.workspace?.enrollment?.generation).toBe(1);
				expect(after.workspace?.deletion).toBeUndefined();
				expect(existsSync(join(after.cwd ?? "", ".checkout", ".git"))).toBe(true);
				const ops = providerOps(workspaceDir, daemonId);
				expect(ops.some((o) => o.op === "delete")).toBe(false);
				// The v2 wire contract: every dispatched request carried the
				// pinned protocol version, and a bwrap request never carried
				// the kubernetes binding.
				expect(ops.length).toBeGreaterThan(0);
				for (const record of ops) {
					expect(record.providerProto).toBe(OMP_PROVIDER_PROTO);
					expect(record.kubernetes).toBeNull();
				}
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"parallel deletes serialize: exactly one destroy, the loser refused",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet({
				runningWhileLive: false,
				stopObserved: "stopped",
				deleteFailures: 0,
			});
			try {
				const daemonId = await createClone(server, repoDir, "serial");
				// Start (gen 1, live compute) then stop: the workspace has
				// provider history, so a delete runs the provider delete op.
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const stop = await postJson(server.port, "/ctl/stop", { selector: daemonId });
				expect(stop.status).toBe(200);
				expect(server.registry.get(daemonId)!.workspace?.desiredState).toBe("stopped");
				// Both deletes fire before either resolves; the #deleting gate
				// serializes them (the winner's whole gate runs, the loser is
				// refused with a typed conflict).
				const [a, b] = await Promise.all([
					deleteWorkspace(server.port, daemonId),
					deleteWorkspace(server.port, daemonId),
				]);
				// Exactly one destroy completed; the loser is refused with a
				// typed client error (409 conflict while the winner's gate is
				// in flight, or 400 once the winner removed the entry) —
				// never a 500 double-delete.
				const statuses = [a.status, b.status];
				expect(statuses.filter((s) => s === 200)).toHaveLength(1);
				for (const s of statuses) expect(s).toBeLessThan(500);
				// The loser's refusal is observable client-side: 4xx, and the
				// body is an error envelope.
				const loser = statuses[0] === 200 ? b : a;
				expect(loser.status).toBeGreaterThanOrEqual(400);
				// The roster is gone, the volume is gone, and the provider saw
				// exactly ONE delete op.
				expect(server.registry.get(daemonId)).toBeUndefined();
				expect(existsSync(join(workspaceDir, daemonId))).toBe(false);
				expect(providerOps(workspaceDir, daemonId).filter((o) => o.op === "delete")).toHaveLength(
					1,
				);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an incomplete store blocks deletion with the registry entry, volume, and store retained and a durable retry state",
		async () => {
			const { server, workspaceDir, logsDir, repoDir } = await bootFleet({
				runningWhileLive: false,
				stopObserved: "stopped",
				deleteFailures: 0,
			});
			try {
				const daemonId = await createClone(server, repoDir, "incomplete");
				// Seed the fleet log store with an INCOMPLETE session: the
				// streamed file's final byte was never acked (index ackedOffset
				// is one short of the durable length). The volume carries the
				// same session tree, so only the store's offset-contiguity
				// check fails — the exact interrupted-stream condition.
				seedSession(logsDir, workspaceDir, daemonId, {
					ackedOffset: Buffer.byteLength(transcriptJsonl(), "utf8") - 1,
				});

				const del = await deleteWorkspace(server.port, daemonId);
				expect(del.status).toBe(409); // archive_conflict maps to 409
				const entry = server.registry.get(daemonId)!;
				expect(entry).toBeDefined(); // roster entry retained
				// The gate persisted the typed failure: deletion is pending
				// retry, not silently cleared.
				expect(entry.workspace?.deletion?.state).toBe("delete-pending-retry");
				expect(entry.workspace?.deletion?.error?.code).toBe("conflict");
				// Volume retained; store retained and still writable (no
				// read-only marker — verification never passed).
				expect(existsSync(join(workspaceDir, daemonId))).toBe(true);
				expect(existsSync(readOnlyMarker(logsDir, daemonId))).toBe(false);
				// The provider never saw a delete (the gate stopped at the
				// verification step).
				expect(providerOps(workspaceDir, daemonId).filter((o) => o.op === "delete")).toHaveLength(
					0,
				);
				// A start remains blocked too: the workspace is quarantined by
				// the pending-retry state until a delete retry succeeds.
				const wake = await postJson(server.port, "/ctl/start", { daemonId });
				expect(wake.status).toBe(409); // archive_pending maps to 409
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a post-verification provider-delete failure persists an accurate retry state, and a retry (even after a fleet restart) completes exactly one destroy",
		async () => {
			const { server, paths, workspaceDir, logsDir, repoDir } = await bootFleet({
				runningWhileLive: false,
				stopObserved: "stopped",
				deleteFailures: 1, // the FIRST provider delete fails
			});
			const config = {
				workspaceDir,
				providerProfiles: {
					local: {
						id: "local",
						provider: "bwrap",
						// Reuse the SAME provider executable path (its durable
						// delete-count file carries the failure across restarts).
						executable: join(paths.tmp, "provider", "fake-provider.js"),
						tools: [],
					},
				},
			};
			const boot = async (): Promise<FleetServer> =>
				await startTestFleet({ statePath: paths.statePath, configPath: paths.configPath }, config, {
					workspaceDir,
				});
			let daemonId: string;
			{
				const id = await createClone(server, repoDir, "verified-retry");
				daemonId = id;
			}
			try {
				// Start (gen 1, desired running) then explicitly stop: the
				// workspace has provider compute history, so the delete gate's
				// quiesce (provider stop) and post-verification provider
				// delete paths actually run.
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				expect(server.registry.get(daemonId)!.workspace?.authorizedGeneration).toBe(1);
				const stop = await postJson(server.port, "/ctl/stop", { selector: daemonId });
				expect(stop.status).toBe(200);
				expect(server.registry.get(daemonId)!.workspace?.desiredState).toBe("stopped");

				// Verified, stopped clone with a real stored session (valid
				// JSONL, offset-contiguous index) mirrored on the volume.
				seedSession(logsDir, workspaceDir, daemonId, {});

				// First delete: verification passes, the store flips read-only,
				// then the provider delete FAILS → delete-pending-retry with
				// remainingResources (a retryable partial failure), and the
				// entry + volume + verified store are all retained.
				const del1 = await deleteWorkspace(server.port, daemonId);
				expect(del1.status).toBe(500); // provider_failed maps to 500
				const entry = server.registry.get(daemonId)!;
				expect(entry).toBeDefined(); // never dropped early
				expect(entry.workspace?.deletion?.state).toBe("delete-pending-retry");
				expect(entry.workspace?.deletion?.error?.code).toBe("provider_failed");
				expect(entry.workspace?.deletion?.remainingResources?.length).toBeGreaterThan(0);
				// Verified: the store flipped read-only and stays; the volume
				// is retained until the retry destroys it.
				expect(existsSync(readOnlyMarker(logsDir, daemonId))).toBe(true);
				expect(existsSync(join(workspaceDir, daemonId))).toBe(true);
				expect(deleteCount(workspaceDir, daemonId)).toBe(1); // exactly ONE failed attempt

				// FLEET RESTART on the same state, then the RETRY: the retry
				// must complete the interrupted destroy exactly once.
				await server.close();
				const server2 = await boot();
				try {
					const del2 = await deleteWorkspace(server2.port, daemonId);
					expect(del2.status).toBe(200);
					const body = (await del2.json()) as { removed?: string; verified?: string[] };
					expect(body.removed).toBe(daemonId);
					expect(body.verified).toEqual([SESSION_ID]);
					// The registry identity is gone, the volume is gone, the
					// verified store (read-only) is retained for Retention.
					expect(server2.registry.get(daemonId)).toBeUndefined();
					expect(existsSync(join(workspaceDir, daemonId))).toBe(false);
					expect(existsSync(readOnlyMarker(logsDir, daemonId))).toBe(true);
					// The durable provider record shows the failed delete AND
					// the successful retry — exactly two attempts total across
					// both fleet lifetimes, no double destroy after success.
					expect(deleteCount(workspaceDir, daemonId)).toBe(2);
					const deletes = providerOps(workspaceDir, daemonId).filter((o) => o.op === "delete");
					expect(deletes).toHaveLength(2);
					expect(deletes[0]!.handle).toBeDefined();
					expect(deletes[1]!.handle).toBe(deletes[0]!.handle);
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
});

describe("clone source validation over /ctl/clones (P1.3)", () => {
	const validSources = [
		{ label: "local-only", kind: "local" as const },
		{ label: "remote-only", kind: "remote" as const },
	];

	for (const { label, kind } of validSources) {
		test(
			`a ${label} source clones successfully and materializes a real volume`,
			async () => {
				const { server, workspaceDir, repoDir } = await bootFleet({
					runningWhileLive: false,
					stopObserved: "stopped",
					deleteFailures: 0,
				});
				try {
					const project = await server.registry.addProject(repoDir);
					const source = kind === "local" ? { local: repoDir } : { remote: `file://${repoDir}` };
					const res = await postJson(server.port, "/ctl/clones", {
						projectId: project.projectId,
						name: `clone-${label}`,
						profileId: "local",
						source,
						start: false,
					});
					expect(res.status).toBe(201);
					const body = (await res.json()) as { entry: { daemonId: string } };
					const daemonId = body.entry.daemonId;
					const entry = server.registry.get(daemonId)!;
					expect(entry.workspace?.kind).toBe("clone");
					// The workspace volume was really prepared from the source:
					// an independent checkout under workspaceDir/<dN>/.checkout
					// holding the source's file.
					const checkout = join(workspaceDir, daemonId, ".checkout");
					expect(existsSync(join(checkout, ".git"))).toBe(true);
					expect(existsSync(join(checkout, "readme.md"))).toBe(true);
				} finally {
					await server.close();
				}
			},
			{ timeout: 20_000 },
		);
	}

	const invalidSources = [
		{ label: "both-members", source: { local: "/tmp/a", remote: "file:///tmp/a" } },
		{ label: "wrongly-typed-member", source: { remote: 42 } },
	];

	for (const { label, source } of invalidSources) {
		test(
			`an invalid source (${label}) is refused with 400 and creates no workspace`,
			async () => {
				const { server, workspaceDir, repoDir } = await bootFleet({
					runningWhileLive: false,
					stopObserved: "stopped",
					deleteFailures: 0,
				});
				try {
					const project = await server.registry.addProject(repoDir);
					const before = server.registry.list().length;
					const res = await postJson(server.port, "/ctl/clones", {
						projectId: project.projectId,
						name: `clone-invalid-${label}`,
						profileId: "local",
						source,
						start: false,
					});
					expect(res.status).toBe(400); // invalid_request maps to 400
					// Refused before any durable work: no roster entry was
					// added and no workspaceDir/<dN> volume was created.
					expect(server.registry.list()).toHaveLength(before);
					let volumeEntries: string[];
					try {
						volumeEntries = readdirSync(workspaceDir);
					} catch {
						volumeEntries = [];
					}
					expect(volumeEntries).toHaveLength(0);
				} finally {
					await server.close();
				}
			},
			{ timeout: 20_000 },
		);
	}
});

// ---------------------------------------------------------------------------
// Kubernetes profile lifecycle contracts (P5.3/P5.5; plan stages 1/2/3)
//
// These drive WorkspaceLifecycle DIRECTLY (never startFleet) over the real
// registry, transport, and log store: the delete gate's `collectCloneEvidence`
// is injected by the server, so only direct construction lets a test control
// it. The provider is the same scripted v2 fixture used above, pointed at by a
// kubernetes profile; every assertion reads the fake's durable request log or
// the registry record, never fleet internals.
// ---------------------------------------------------------------------------

const KUBE_IDENTITY = "0123456789abcdef0123456789abcdef";
const KUBE_REMOTE = "ssh://git@example.test/org/repo.git";
const KUBE_BRANCH = "main";
const KUBE_REVISION = "a".repeat(40);
const KUBE_STATE_REL = join(".kubernetes", KUBE_IDENTITY);
const KUBE_BINDING: KubernetesBinding = {
	resourceIdentity: KUBE_IDENTITY,
	context: "ctx-1",
	namespace: "ns-1",
	namespaceUid: "ns-uid-1",
};

/**
 * Test seam over the real transport: direct-lifecycle tests have no callback
 * socket, so the pair observation the watcher reads is the only thing faked.
 * Enrollment/revocation/teardown and every other transport behavior stay the
 * real registry's (setPaired only forces the `paired` bit of pairStatus).
 */
class PairControllableTransport extends DaemonTransportRegistry {
	#paired = false;

	setPaired(paired: boolean): void {
		this.#paired = paired;
	}

	override pairStatus(workspaceId: string): PairStatus {
		return { ...super.pairStatus(workspaceId), paired: this.#paired };
	}
}

interface KubeFixture {
	lifecycle: WorkspaceLifecycle;
	registry: Registry;
	transport: PairControllableTransport;
	config: { workspaceDir: string; providerProfiles: Record<string, ProviderProfile> };
	workspaceDir: string;
	logsDir: string;
	providerDir: string;
	/** Persisted registry state path (for reload assertions). */
	statePath: string;
	projectId: string;
	/** Every collectCloneEvidence request the delete gate issued, in order. */
	collected: CloneQuiesceRequest[];
	/** Workspace ids the post-verification volume deleter was invoked for. */
	deletions: string[];
}

/**
 * Boot a WorkspaceLifecycle over a tracked temp dir with a kubernetes profile
 * pointed at the scripted fake provider and a local git repo registered as the
 * project. `collect` replaces the default evidence collector (which records
 * the request and then blocks the deletion with a typed failure).
 */
async function bootKubernetes(
	opts: {
		scenario?: Partial<ProviderScenario>;
		collect?: (request: CloneQuiesceRequest) => Promise<CloneQuiesceReceipt>;
		/** Consecutive volume/provider-state cleanup failures before success. */
		resourceFailures?: number;
	} = {},
): Promise<KubeFixture> {
	const paths = fleetPaths("omp-kube-lifecycle-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const logsDir = join(paths.tmp, "logs");
	const providerDir = join(paths.tmp, "provider");
	const executable = writeFakeProvider(providerDir, opts.scenario ?? {});
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const registry = new Registry(paths.statePath);
	await registry.load();
	const project = await registry.addProject(repoDir);
	const collected: CloneQuiesceRequest[] = [];
	const deletions: string[] = [];
	const transport = new PairControllableTransport();
	const providerProfiles: Record<string, ProviderProfile> = {
		kube: {
			id: "kube",
			provider: "kubernetes",
			executable,
			tools: [],
			context: KUBE_BINDING.context,
			namespace: KUBE_BINDING.namespace,
			image: "example.test/omp-web:test",
		},
	};
	const lifecycle = new WorkspaceLifecycle({
		registry,
		config: { workspaceDir, providerProfiles },
		transport,
		logStore: FleetLogStore.load(logsDir),
		resourceDeleter: {
			deleteWorkspaceResources: async (workspaceId) => {
				deletions.push(workspaceId);
				if (deletions.length <= (opts.resourceFailures ?? 0)) {
					throw new Error("provider state cleanup failed");
				}
			},
		},
		eventLog: new FleetEventLog(),
		attachLogTap: () => {},
		callbackUrl: () => "https://fleet.example.test",
		collectCloneEvidence: async (request) => {
			collected.push(request);
			if (opts.collect !== undefined) return await opts.collect(request);
			throw new CloneQuiesceError("unavailable", "no scripted evidence collector", "validation");
		},
	});
	return {
		lifecycle,
		registry,
		transport,
		config: { workspaceDir, providerProfiles },
		workspaceDir,
		logsDir,
		providerDir,
		statePath: paths.statePath,
		projectId: project.projectId,
		collected,
		deletions,
	};
}

/** Persist a stopped kubernetes clone in the exact shape createClone writes. */
function seedKubernetesClone(fx: KubeFixture): RegistryEntry {
	const created = fx.registry.create({
		name: "kube-clone",
		cwd: "",
		project: "repo",
		projectId: fx.projectId,
		labels: [],
		managed: true,
		mode: "spawned",
		status: "asleep",
		workspace: {
			kind: "clone",
			projectId: fx.projectId,
			source: { remote: KUBE_REMOTE },
			branch: KUBE_BRANCH,
			profileId: "kube",
			providerKind: "kubernetes",
			desiredState: "stopped",
			pinnedRevision: KUBE_REVISION,
			kubernetes: { ...KUBE_BINDING },
			sourcePinDigest: computeSourcePinDigest(KUBE_REMOTE, KUBE_REVISION, KUBE_BRANCH),
		},
	});
	const volumeRoot = join(fx.workspaceDir, created.daemonId);
	mkdirSync(volumeRoot, { recursive: true });
	return fx.registry.update(created.daemonId, { cwd: volumeRoot });
}

/**
 * Minimal quiesce receipt the delete gate accepts. The gate reads only the
 * validated `git` verdict, the resource binding it is compared against
 * (generation/claim/namespace), and the receipt's presence (the HEAVY evidence
 * document is the real validator's business, exercised by
 * fleet/clone-quiesce.test.ts), so this fixture stubs the parts the gate never
 * inspects. The request id echoes the caller's persisted one.
 */
function gateReceipt(request: CloneQuiesceRequest): CloneQuiesceReceipt {
	const requestId = request.requestId ?? "rq-fixture";
	const correlationId = "corr-fixture";
	const receipt = {
		requestId,
		correlationId,
		workspaceId: request.workspaceId,
		generation: request.generation,
		podUid: request.podUid,
		pvcUid: request.pvcUid,
		namespaceUid: request.namespaceUid,
		git: { status: "clean" as const },
	} as unknown as CloneQuiesceReceipt["receipt"];
	return {
		requestId,
		correlationId,
		evidence: {} as CloneQuiesceReceipt["evidence"],
		receipt,
	};
}

/** Await a lifecycle operation expected to fail and return its typed error. */
async function lifecycleError(promise: Promise<unknown>): Promise<CloneLifecycleError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof CloneLifecycleError) return err;
		throw err;
	}
	throw new Error("expected the lifecycle operation to fail");
}

describe("kubernetes clone admission (P5.3)", () => {
	test("a local source is refused invalid_request before any provider call", async () => {
		const fx = await bootKubernetes();
		const err = await lifecycleError(
			fx.lifecycle.createClone({
				projectId: fx.projectId,
				name: "local-source",
				profileId: "kube",
				source: { local: join(fx.workspaceDir, "host-only") },
			}),
		);
		expect(err.code).toBe("invalid_request");
		// Refused before any durable work: no resource binding was resolved
		// and no roster entry exists.
		expect(existsSync(join(fx.workspaceDir, ".kubernetes"))).toBe(false);
		expect(fx.registry.list()).toHaveLength(0);
	});

	test("an invalid remote is refused invalid_request before any provider call", async () => {
		const fx = await bootKubernetes();
		const invalidRemotes = [
			"file:///srv/repo",
			"https://example.test",
			"git@example.test:org/repo.git",
		];
		for (const remote of invalidRemotes) {
			const err = await lifecycleError(
				fx.lifecycle.createClone({
					projectId: fx.projectId,
					name: "remote-check",
					profileId: "kube",
					source: { remote },
				}),
			);
			expect(err.code).toBe("invalid_request");
		}
		expect(existsSync(join(fx.workspaceDir, ".kubernetes"))).toBe(false);
		expect(fx.registry.list()).toHaveLength(0);
	});

	test("a missing or invalid branch is refused invalid_request before any provider call", async () => {
		const fx = await bootKubernetes();
		for (const branch of ["", "foo//bar", "foo.lock"]) {
			const err = await lifecycleError(
				fx.lifecycle.createClone({
					projectId: fx.projectId,
					name: "branch-check",
					profileId: "kube",
					source: { remote: KUBE_REMOTE },
					branch,
				}),
			);
			expect(err.code).toBe("invalid_request");
		}
		expect(existsSync(join(fx.workspaceDir, ".kubernetes"))).toBe(false);
		expect(fx.registry.list()).toHaveLength(0);
	});
});

describe("kubernetes binding stability (P5.3)", () => {
	test("a changed persisted namespace uid is refused conflict and never re-anchored", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)!.workspace?.authorizedGeneration).toBe(1);

		fx.registry.updateWorkspace(entry.daemonId, {
			kubernetes: { ...KUBE_BINDING, namespaceUid: "ns-uid-2" },
		});
		const err = await lifecycleError(fx.lifecycle.stopClone(entry.daemonId));
		expect(err.code).toBe("conflict");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.desiredState).toBe("running");
		expect(after.workspace?.authorizedGeneration).toBe(1);
		// The fleet never writes the observed uid back over the record.
		expect(after.workspace?.kubernetes?.namespaceUid).toBe("ns-uid-2");
		// The request carried the mutated binding; the provider answered with
		// the namespace's own uid, which is exactly the disagreement refused.
		const ops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl"));
		expect(ops.at(-1)?.kubernetes?.namespaceUid).toBe("ns-uid-2");
	});

	test("a provider response whose namespace uid drifted is refused conflict", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		setScenario(fx.providerDir, { namespaceUid: "ns-uid-replaced" });
		const err = await lifecycleError(fx.lifecycle.stopClone(entry.daemonId));
		expect(err.code).toBe("conflict");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.desiredState).toBe("running");
		expect(after.workspace?.kubernetes?.namespaceUid).toBe(KUBE_BINDING.namespaceUid);
	});

	test("a profile context that drifted from the persisted binding is refused conflict", async () => {
		// The binding's context/namespace stability is enforced by the
		// provider (it treats request.kubernetes as authoritative and refuses a
		// disagreeing profile), so the fixture mirrors that contract; the
		// observable asserted here is the fleet surfacing conflict without
		// mutating the record or the desired state.
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		fx.config.providerProfiles.kube.context = "ctx-2";
		const err = await lifecycleError(fx.lifecycle.stopClone(entry.daemonId));
		expect(err.code).toBe("conflict");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.desiredState).toBe("running");
		expect(after.workspace?.kubernetes?.context).toBe(KUBE_BINDING.context);
		// The fleet forwarded the persisted binding unchanged while the
		// profile drifted.
		const ops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl"));
		expect(ops.at(-1)?.kubernetes?.context).toBe(KUBE_BINDING.context);
		expect(ops.at(-1)?.profileContext).toBe("ctx-2");
	});
});

describe("kubernetes provider error mapping (P5.4)", () => {
	const mappings = [
		{ code: "timeout", expected: "retryable" },
		{ code: "internal", expected: "provider_failed" },
	] as const;

	for (const { code, expected } of mappings) {
		test(`a provider ${code} failure maps to the ${expected} lifecycle code`, async () => {
			const fx = await bootKubernetes({
				scenario: { error: { op: "ensure-running", code } },
			});
			const entry = seedKubernetesClone(fx);
			const err = await lifecycleError(fx.lifecycle.ensureCloneRunning(entry.daemonId));
			expect(err.code).toBe(expected);
			// A failed ensure never persists an authorized generation.
			expect(fx.registry.get(entry.daemonId)!.workspace?.authorizedGeneration).toBeUndefined();
		});
	}
});

describe("per-workspace provider serialization (P5.3)", () => {
	test("concurrent start and stop for one workspace reach the provider in order", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		const [start, stop] = await Promise.allSettled([
			fx.lifecycle.ensureCloneRunning(entry.daemonId),
			fx.lifecycle.stopClone(entry.daemonId),
		]);
		expect(start.status).toBe("fulfilled");
		expect(stop.status).toBe("fulfilled");

		const ops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl"));
		// Both operations ran, in call order. Without the per-workspace queue
		// the stop would read the record before the start persisted its
		// generation (leaving it with no provider call at all) or would
		// collide with the provider's cross-process lock; either way the log
		// would not carry both ops in this order. The stop's own evidence
		// collection inspects the live Pod before it stops it (the fixture's
		// default collector refuses, which never fails the stop).
		expect(ops.map((record) => record.op)).toEqual(["ensure-running", "inspect", "stop"]);
		for (let i = 1; i < ops.length; i++) {
			expect(ops[i]!.startedAt).toBeGreaterThanOrEqual(ops[i - 1]!.endedAt);
		}
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.desiredState).toBe("stopped");
		expect(after.workspace?.authorizedGeneration).toBe(1);
	});
});

describe("kubernetes attempted generation and credential reuse (stage 2)", () => {
	test("a failed launch keeps its attempted generation and handoff; the retry reuses them", async () => {
		const fx = await bootKubernetes({
			scenario: { error: { op: "ensure-running", code: "internal" } },
		});
		const entry = seedKubernetesClone(fx);
		const stateDir = join(fx.workspaceDir, KUBE_STATE_REL);

		const first = await lifecycleError(fx.lifecycle.ensureCloneRunning(entry.daemonId));
		expect(first.code).toBe("provider_failed");
		let current = fx.registry.get(entry.daemonId)!;
		expect(current.workspace?.lastAttemptedGeneration).toBe(1);
		expect(current.workspace?.authorizedGeneration).toBeUndefined();
		expect(current.workspace?.enrollment?.generation).toBe(1);
		const credentialHash = current.workspace!.enrollment!.credentialHash;
		const handoff = JSON.parse(readFileSync(join(stateDir, CALLBACK_ENV_FILE), "utf8")) as {
			generation: number;
			env: Record<string, string>;
		};
		expect(handoff.generation).toBe(1);

		// The retry: the attempt is inspected at its own generation and its
		// credential is recovered rather than re-issued.
		setScenario(fx.providerDir, { error: undefined });
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		current = fx.registry.get(entry.daemonId)!;
		expect(current.workspace?.authorizedGeneration).toBe(1);
		expect(current.workspace?.lastAttemptedGeneration).toBe(1);
		// A fresh credential at the same non-revoked generation would have
		// been a transport conflict; the digest proving reuse is observable.
		expect(current.workspace?.enrollment?.credentialHash).toBe(credentialHash);
		const handoffAfter = JSON.parse(readFileSync(join(stateDir, CALLBACK_ENV_FILE), "utf8")) as {
			generation: number;
			env: Record<string, string>;
		};
		expect(handoffAfter.generation).toBe(1);
		expect(handoffAfter.env.OMP_SESSION_CALLBACK_TOKEN).toBe(
			handoff.env.OMP_SESSION_CALLBACK_TOKEN,
		);
		const ops = readOps(join(stateDir, "ops.jsonl"));
		expect(ops.map((record) => record.op)).toEqual(["ensure-running", "inspect", "ensure-running"]);
		expect(ops[2]!.generation).toBe(1);
	});

	test("a replacement after a proven stop uses a larger generation", async () => {
		const fx = await bootKubernetes({ scenario: { runningWhileLive: true } });
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)!.workspace?.authorizedGeneration).toBe(1);

		// A lost callback binding: the credential the live resource holds is
		// no longer recoverable, so the predecessor must be proven gone
		// before a replacement is admitted.
		fx.registry.clearWorkspaceEnrollment(entry.daemonId, 1);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		const ops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl"));
		expect(ops.map((record) => record.op)).toEqual([
			"ensure-running",
			"inspect",
			"stop",
			"ensure-running",
		]);
		expect(ops[3]!.generation).toBe(2);
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.authorizedGeneration).toBe(2);
		expect(after.workspace?.lastAttemptedGeneration).toBe(2);
	});
});

describe("kubernetes delete-gate final evidence (stage 3)", () => {
	test("evidence is collected before the provider stop, and an invalid receipt blocks with everything retained", async () => {
		const pendingAtCollect: Array<WorkspaceDeletion | undefined> = [];
		let fx!: KubeFixture;
		fx = await bootKubernetes({
			collect: async (request) => {
				const deletion = fx.registry.get(request.workspaceId)?.workspace?.deletion;
				// The stop collects its own receipt first (its attempt is not
				// durable yet); this case is the DELETE gate's handshake,
				// which must run while the attempt is already persisted.
				if (deletion === undefined) return gateReceipt(request);
				pendingAtCollect.push(deletion);
				throw new CloneQuiesceError(
					"conflict",
					"the uploaded evidence is incomplete: no writer boundary",
					"validation",
				);
			},
		});
		const entry = seedKubernetesClone(fx);
		const volumeRoot = join(fx.workspaceDir, entry.daemonId);
		writeFileSync(join(volumeRoot, "keep.txt"), "keep\n");
		mkdirSync(join(fx.logsDir, entry.daemonId), { recursive: true });
		writeFileSync(join(fx.logsDir, entry.daemonId, "keep.txt"), "keep\n");

		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);
		const opsPath = join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl");
		const stopsBefore = readOps(opsPath).filter((record) => record.op === "stop").length;

		const err = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(err.code).toBe("conflict");

		// The gate persisted the typed, invalid receipt and retained the
		// roster entry, the volume, and the (still writable) store.
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(after.workspace?.deletion?.error?.code).toBe("conflict");
		expect(after.workspace?.deletion?.receipt?.state).toBe("invalid");
		expect(existsSync(volumeRoot)).toBe(true);
		expect(existsSync(join(volumeRoot, "keep.txt"))).toBe(true);
		expect(existsSync(join(fx.logsDir, entry.daemonId, "keep.txt"))).toBe(true);
		expect(existsSync(join(fx.logsDir, entry.daemonId, "readonly.json"))).toBe(false);
		expect(fx.deletions).toEqual([]);

		// Evidence precedes the gate's stop: after the explicit stop, the
		// provider log gained the evidence inspect and NO second stop; a
		// stop-first gate would have added one.
		const ops = readOps(opsPath);
		expect(ops.filter((record) => record.op === "stop")).toHaveLength(stopsBefore);
		const lastStop = ops.map((record) => record.op).lastIndexOf("stop");
		expect(ops.slice(lastStop + 1).map((record) => record.op)).toEqual(["inspect"]);

		// The request was bound to the observed resources and the pending
		// receipt was already durable when the collector ran.
		expect(pendingAtCollect).toHaveLength(1);
		expect(pendingAtCollect[0]?.state).toBe("deleting");
		expect(pendingAtCollect[0]?.receipt?.state).toBe("pending");
		expect(pendingAtCollect[0]?.receipt?.generation).toBe(1);
		expect(pendingAtCollect[0]?.receipt?.podUid).toBe("pod-uid-1");
		expect(pendingAtCollect[0]?.receipt?.pvcUid).toBe("pvc-uid-1");
		// The first request was the stop's own collection (which succeeded
		// here); the last is the gate's.
		expect(fx.collected).toHaveLength(2);
		const gateRequest = fx.collected.at(-1);
		expect(gateRequest?.workspaceId).toBe(entry.daemonId);
		expect(gateRequest?.generation).toBe(1);
		expect(gateRequest?.namespaceUid).toBe(KUBE_BINDING.namespaceUid);
		expect(gateRequest?.binding?.resourceIdentity).toBe(KUBE_IDENTITY);
		expect(gateRequest?.sourceRemote).toBe(KUBE_REMOTE);
		expect(gateRequest?.pinnedRevision).toBe(KUBE_REVISION);
		expect(gateRequest?.branch).toBe(KUBE_BRANCH);
		// The collector is asked about the SAME request id the pending
		// receipt persisted: the daemon caches its outcome under that id, so
		// a crash after the ack can replay it on a retry.
		expect(gateRequest?.requestId).toBeDefined();
		expect(gateRequest?.requestId).toBe(pendingAtCollect[0]?.receipt?.requestId);
	});
});

/**
 * Drive a kubernetes clone to the failed-ahead-attempt state: generation 1 is
 * authorized and then stopped, and generation 2 is attempted but the launch
 * fails after the provider may already have created (and booted) its Pod.
 * `authorizedGeneration` stays 1, `lastAttemptedGeneration` becomes 2, and the
 * attempt's enrollment + handoff persist exactly as #ensure wrote them.
 */
async function seedFailedAheadAttempt(fx: KubeFixture): Promise<RegistryEntry> {
	const entry = seedKubernetesClone(fx);
	await fx.lifecycle.ensureCloneRunning(entry.daemonId);
	await fx.lifecycle.stopClone(entry.daemonId);
	setScenario(fx.providerDir, { error: { op: "ensure-running", code: "internal" } });
	const failed = await lifecycleError(fx.lifecycle.ensureCloneRunning(entry.daemonId));
	expect(failed.code).toBe("provider_failed");
	setScenario(fx.providerDir, { error: undefined });
	const current = fx.registry.get(entry.daemonId)!;
	expect(current.workspace?.authorizedGeneration).toBe(1);
	expect(current.workspace?.lastAttemptedGeneration).toBe(2);
	expect(current.workspace?.enrollment?.generation).toBe(2);
	return current;
}

describe("kubernetes failed-ahead-attempt deletion (stage 2/3)", () => {
	test("evidence is collected while the attempt's pair is still enrolled, then fenced and deleted at its own generation", async () => {
		const enrollmentAtCollect: Array<number | undefined> = [];
		const enrolledAtCollect: boolean[] = [];
		let fx!: KubeFixture;
		fx = await bootKubernetes({
			collect: async (request) => {
				// The seeding stop collects its own receipt (generation 1);
				// this case is about the DELETE gate's handshake, which runs
				// while the ATTEMPT's pair is still enrolled.
				if (fx.registry.get(request.workspaceId)?.workspace?.deletion?.state !== "deleting") {
					return gateReceipt(request);
				}
				enrollmentAtCollect.push(
					fx.registry.get(request.workspaceId)?.workspace?.enrollment?.generation,
				);
				enrolledAtCollect.push(fx.transport.pairStatus(request.workspaceId).enrolled);
				return gateReceipt(request);
			},
		});
		const entry = await seedFailedAheadAttempt(fx);
		const opsPath = join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl");

		await fx.lifecycle.deleteClone(entry.daemonId);

		// The quiesce handshake ran BEFORE the enrollment was revoked: a
		// revoke-first gate leaves a live Pod with no daemon to ask, which is
		// exactly the receipt its deletion requires.
		expect(enrollmentAtCollect).toEqual([2]);
		expect(enrolledAtCollect).toEqual([true]);

		// The gate fenced the ATTEMPTED generation for its stop and for the
		// provider delete: a generated-1 fence would leave the generation-2
		// Pod untouched (the provider refuses a foreign generation).
		const ops = readOps(opsPath);
		expect(ops.filter((record) => record.op === "inspect").at(-1)?.generation).toBe(2);
		expect(ops.filter((record) => record.op === "stop").at(-1)?.generation).toBe(2);
		expect(ops.filter((record) => record.op === "delete").at(-1)?.generation).toBe(2);
		expect(fx.deletions).toEqual([entry.daemonId]);
		expect(fx.registry.get(entry.daemonId)).toBeUndefined();
	});

	test("a rejected attempt replays the same persisted request id on the retry", async () => {
		const seen: Array<string | undefined> = [];
		let fx!: KubeFixture;
		fx = await bootKubernetes({
			collect: async (request) => {
				// Only the DELETE gate's attempts are counted: the seeding
				// stop's own collection has its own (persisted) request id.
				if (fx.registry.get(request.workspaceId)?.workspace?.deletion?.state !== "deleting") {
					return gateReceipt(request);
				}
				seen.push(request.requestId);
				if (seen.length === 1) {
					throw new CloneQuiesceError("unavailable", "daemon busy", "request");
				}
				return gateReceipt(request);
			},
		});
		const entry = await seedFailedAheadAttempt(fx);

		const first = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(first.code).toBe("unavailable");
		const persisted = fx.registry.get(entry.daemonId)!.workspace?.deletion?.receipt?.requestId;
		expect(persisted).toBeDefined();
		expect(seen).toEqual([persisted]);

		// The retry asks the daemon about the SAME id: the daemon caches its
		// quiesce outcome under that id, so a fresh id would name no outcome.
		await fx.lifecycle.deleteClone(entry.daemonId);
		expect(seen).toEqual([persisted, persisted]);
		expect(fx.registry.get(entry.daemonId)).toBeUndefined();
	});
});

describe("kubernetes provider invocation budget (P5.4)", () => {
	test(
		"an operation held past runProviderOp's 30 s default still completes",
		async () => {
			// The provider's own stop budget is stop wait + headroom; only a real
			// hold longer than the default proves the fleet applied the computed
			// invocation timeout (a fake clock cannot reach the parent's kill
			// timer).
			const holdMs = PROVIDER_OP_TIMEOUT_MS_DEFAULT + 1_000;
			const fx = await bootKubernetes({ scenario: { delayOp: { op: "stop", ms: holdMs } } });
			const entry = seedKubernetesClone(fx);
			await fx.lifecycle.ensureCloneRunning(entry.daemonId);
			await fx.lifecycle.stopClone(entry.daemonId);

			// The durable record exists only because the provider was allowed to
			// answer: a 30 s invocation killed it before it could write one out.
			// The recorded interval outlives the default by construction.
			const stops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl")).filter(
				(record) => record.op === "stop",
			);
			expect(stops).toHaveLength(1);
			expect(stops[0]!.endedAt - stops[0]!.startedAt).toBeGreaterThan(
				PROVIDER_OP_TIMEOUT_MS_DEFAULT,
			);
			expect(fx.registry.get(entry.daemonId)!.workspace?.desiredState).toBe("stopped");
		},
		{ timeout: 60_000 },
	);
});

describe("kubernetes boot reconciliation of attempted generations (stage 2)", () => {
	test("an attempted-only generation is inspected and fenced, never skipped as never-started", async () => {
		const fx = await bootKubernetes({
			scenario: { error: { op: "ensure-running", code: "internal" } },
		});
		const entry = seedKubernetesClone(fx);
		const failed = await lifecycleError(fx.lifecycle.ensureCloneRunning(entry.daemonId));
		expect(failed.code).toBe("provider_failed");
		const attempted = fx.registry.get(entry.daemonId)!;
		expect(attempted.workspace?.authorizedGeneration).toBeUndefined();
		expect(attempted.workspace?.providerHandle).toBeUndefined();
		expect(attempted.workspace?.lastAttemptedGeneration).toBe(1);

		const opsPath = join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl");
		expect(readOps(opsPath).filter((record) => record.op === "inspect")).toHaveLength(0);

		// The attempt's Pod survived the failed launch: boot must inspect it
		// at its own generation and fence it (desired stopped), never treat
		// the record as having nothing to reconcile.
		setScenario(fx.providerDir, { error: undefined, runningWhileLive: true });
		await fx.lifecycle.reconcile();

		const ops = readOps(opsPath);
		const inspects = ops.filter((record) => record.op === "inspect");
		expect(inspects).toHaveLength(1);
		expect(inspects[0]!.generation).toBe(1);
		expect(ops.filter((record) => record.op === "stop").at(-1)?.generation).toBe(1);
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.status).toBe("asleep");
		expect(after.workspace?.desiredState).toBe("stopped");
		expect(after.workspace?.authorizedGeneration).toBeUndefined();
		expect(after.workspace?.enrollment).toBeUndefined();
	});

	test("an ahead attempt is fenced, never reattached at the stale authorized generation", async () => {
		const fx = await bootKubernetes();
		const entry = await seedFailedAheadAttempt(fx);

		// The generation-2 Pod survived the failed launch.
		setScenario(fx.providerDir, { runningWhileLive: true });
		await fx.lifecycle.reconcile();

		const after = fx.registry.get(entry.daemonId)!;
		// A same-generation reattach would surface the workspace "ready"
		// while the record still authorized generation 1: the persisted
		// authorization and the live resource would disagree forever.
		expect(after.status).toBe("asleep");
		expect(after.workspace?.authorizedGeneration).toBe(1);
		expect(after.workspace?.lastAttemptedGeneration).toBe(2);
		expect(after.workspace?.enrollment).toBeUndefined();
		const ops = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl"));
		expect(ops.filter((record) => record.op === "inspect").at(-1)?.generation).toBe(2);
		expect(ops.filter((record) => record.op === "stop").at(-1)?.generation).toBe(2);
	});

	test("an ahead attempt is retried through ensure-running when the workspace should run", async () => {
		const fx = await bootKubernetes();
		const entry = await seedFailedAheadAttempt(fx);
		// The wake was requested: the workspace should be running.
		fx.registry.updateWorkspace(entry.daemonId, { desiredState: "running" });

		setScenario(fx.providerDir, { runningWhileLive: true });
		await fx.lifecycle.reconcile();

		// The retry authorized the attempt's own generation and reused its
		// credential; the record is consistent again.
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.authorizedGeneration).toBe(2);
		expect(after.workspace?.lastAttemptedGeneration).toBe(2);
		expect(after.workspace?.desiredState).toBe("running");
		expect(after.status).toBe("ready");
	});
});

describe("kubernetes post-verification deletion recovery (stage 3)", () => {
	test("a provider-delete failure resumes at cleanup and refuses clear-deletion", async () => {
		const fx = await bootKubernetes({
			scenario: { deleteFailures: 1 },
			resourceFailures: 1,
			collect: async (request) => gateReceipt(request),
		});
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);
		// A stored session makes verification flip the store read-only.
		seedSession(fx.logsDir, fx.workspaceDir, entry.daemonId, {});

		const first = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(first.code).toBe("provider_failed");
		const blocked = fx.registry.get(entry.daemonId)!;
		expect(blocked.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(blocked.workspace?.deletion?.remainingResources?.length).toBeGreaterThan(0);
		expect(blocked.workspace?.deletion?.receipt?.state).toBe("verified");
		expect(existsSync(readOnlyMarker(fx.logsDir, entry.daemonId))).toBe(true);
		// The stop's own collection + the gate's first handshake.
		expect(fx.collected).toHaveLength(2);
		expect(fx.deletions).toEqual([]);

		// Post-verification cleanup failures stay quarantined: waking the
		// clone would stream new frames into a store that rejects them.
		expect(() => fx.lifecycle.clearRejectedDeletion(entry.daemonId)).toThrow(CloneLifecycleError);
		expect(fx.registry.get(entry.daemonId)!.workspace?.deletion?.state).toBe(
			"delete-pending-retry",
		);

		// The retry resumes at provider deletion: the pre-stop handshake (and
		// the daemon round trip it needs) is NOT re-run, and neither is the
		// store verification that already flipped it read-only.
		const handshakes = fx.collected.length;
		const second = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(second.code).toBe("provider_failed");
		expect(fx.collected).toHaveLength(handshakes);
		const cleanup = fx.registry.get(entry.daemonId)!;
		expect(cleanup.workspace?.deletion?.remainingResources).toEqual([entry.cwd]);
		expect(cleanup.workspace?.deletion?.receipt?.state).toBe("verified");

		// The next retry resumes at the same cleanup stage and finishes.
		setScenario(fx.providerDir, { deleteFailures: 0 });
		await fx.lifecycle.deleteClone(entry.daemonId);
		expect(fx.collected).toHaveLength(handshakes);
		expect(fx.deletions).toEqual([entry.daemonId, entry.daemonId]);
		expect(fx.registry.get(entry.daemonId)).toBeUndefined();
	});

	test("a pre-verification rejection is still clearable for wake", async () => {
		const fx = await bootKubernetes({
			collect: async () => {
				throw new CloneQuiesceError("unavailable", "daemon unreachable", "request");
			},
		});
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);

		const rejected = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(rejected.code).toBe("unavailable");
		const blocked = fx.registry.get(entry.daemonId)!;
		expect(blocked.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(blocked.workspace?.deletion?.remainingResources).toBeUndefined();
		expect(existsSync(readOnlyMarker(fx.logsDir, entry.daemonId))).toBe(false);

		expect(fx.lifecycle.clearRejectedDeletion(entry.daemonId)).toBe(true);
		expect(fx.registry.get(entry.daemonId)!.workspace?.deletion).toBeUndefined();
	});

	test("an empty but verified receipt authorizes deleting a clone with no fleet-readable volume", async () => {
		const fx = await bootKubernetes({ collect: async (request) => gateReceipt(request) });
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);
		// A kubernetes volume is its PVC, not a fleet directory: this clone
		// started but never produced a session, so the volume tree is absent
		// and there is nothing on the store side to compare either. The
		// provider stop deleted the Pod, so the delete adopts the receipt the
		// stop collected instead of handshaking with a daemon that is gone.
		rmSync(join(fx.workspaceDir, entry.daemonId), { recursive: true, force: true });
		setScenario(fx.providerDir, { podUid: null });

		await fx.lifecycle.deleteClone(entry.daemonId);

		expect(fx.collected).toHaveLength(1);
		expect(fx.deletions).toEqual([entry.daemonId]);
		expect(fx.registry.get(entry.daemonId)).toBeUndefined();
	});
});

describe("kubernetes deletion recovery and admission (stage 3)", () => {
	test("boot reconciliation of an interrupted deletion preserves the replay id and remaining resources", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		fx.registry.setWorkspaceDeletion(entry.daemonId, {
			state: "deleting",
			requestedAt: 1_700_000_000_000,
			receipt: {
				requestId: "rq-interrupted",
				generation: 1,
				podUid: "pod-uid-1",
				pvcUid: "pvc-uid-1",
				state: "pending",
			},
			remainingResources: ["provider:handle-1"],
		});

		await fx.lifecycle.reconcile();

		// The interrupted attempt stays retryable WITH its durable progress:
		// the pending request id names the daemon's cached outcome and the
		// remaining resources name the cleanup stage to resume at.
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(after.workspace?.deletion?.error?.code).toBe("retryable");
		expect(after.workspace?.deletion?.receipt?.requestId).toBe("rq-interrupted");
		expect(after.workspace?.deletion?.receipt?.state).toBe("pending");
		expect(after.workspace?.deletion?.remainingResources).toEqual(["provider:handle-1"]);
	});

	test("a live workspace whose readiness probe errored it is refused deletion", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		const running = fx.registry.get(entry.daemonId)!;
		expect(running.workspace?.desiredState).toBe("running");
		expect(running.workspace?.enrollment?.generation).toBe(1);

		// The readiness probe marks a cwd/resume mismatch as error WITHOUT
		// stopping the provider: the clone is still live.
		fx.registry.setStatus(entry.daemonId, "error", "session resume mismatch");

		const err = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(err.code).toBe("writer_active");

		// Nothing was torn down: still enrolled, no provider stop/delete, no
		// deletion state.
		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.desiredState).toBe("running");
		expect(after.workspace?.enrollment?.generation).toBe(1);
		expect(after.workspace?.deletion).toBeUndefined();
		expect(fx.collected).toEqual([]);
		const deletes = readOps(join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl")).filter(
			(record) => record.op === "delete",
		);
		expect(deletes).toHaveLength(0);
	});
});

describe("kubernetes stop-time evidence (stage 3)", () => {
	test("a wake hands the in-pod main transcript of the stored session and requires its restore", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);

		// The kubernetes volume is not fleet-readable, so a wake of a stopped
		// clone must hand the IN-POD main-file path of the store's session and
		// require the daemon to restore/materialize it over the pair.
		const sessionId = "s-wake-restore";
		mkdirSync(join(fx.logsDir, entry.daemonId, sessionId), { recursive: true });
		writeFileSync(join(fx.logsDir, entry.daemonId, sessionId, `${sessionId}.jsonl`), "{}\n");

		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		const handoff = JSON.parse(
			readFileSync(join(fx.workspaceDir, KUBE_STATE_REL, CALLBACK_ENV_FILE), "utf8"),
		) as { generation: number; env: Record<string, string> };
		expect(handoff.generation).toBe(2);
		expect(handoff.env.OMP_SESSION_RESUME).toBe(
			`/workspace/.home/agent/sessions/${sessionId}.jsonl`,
		);
		expect(handoff.env.OMP_SESSION_RESUME_REQUIRED).toBe("1");
	});

	test("an explicit stop persists the validated receipt for this generation", async () => {
		const fx = await bootKubernetes({ collect: async (request) => gateReceipt(request) });
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		await fx.lifecycle.stopClone(entry.daemonId);

		// The stop handed the collector the observed resources and the
		// persisted binding/source tuple, and persisted the validated receipt
		// bound to this generation.
		expect(fx.collected).toHaveLength(1);
		expect(fx.collected[0]?.workspaceId).toBe(entry.daemonId);
		expect(fx.collected[0]?.generation).toBe(1);
		expect(fx.collected[0]?.podUid).toBe("pod-uid-1");
		expect(fx.collected[0]?.pvcUid).toBe("pvc-uid-1");
		expect(fx.collected[0]?.namespaceUid).toBe(KUBE_BINDING.namespaceUid);
		expect(fx.collected[0]?.binding?.resourceIdentity).toBe(KUBE_IDENTITY);
		expect(fx.collected[0]?.sourceRemote).toBe(KUBE_REMOTE);
		expect(fx.collected[0]?.pinnedRevision).toBe(KUBE_REVISION);
		expect(fx.collected[0]?.branch).toBe(KUBE_BRANCH);

		const evidence = fx.registry.get(entry.daemonId)!.workspace?.lastEvidence;
		expect(evidence?.state).toBe("verified");
		expect(evidence?.generation).toBe(1);
		expect(evidence?.podUid).toBe("pod-uid-1");
		expect(evidence?.pvcUid).toBe("pvc-uid-1");
		expect(evidence?.validated).toBeDefined();
		// The collector was asked about the id the receipt carries: a retry
		// replays the daemon's cached outcome under the same id.
		expect(evidence?.requestId).toBe(fx.collected[0]?.requestId);

		// The receipt is durable: the delete may run in a later fleet process,
		// after the Pod (and its daemon) are long gone.
		const reloaded = new Registry(fx.statePath);
		await reloaded.load();
		expect(reloaded.get(entry.daemonId)?.workspace?.lastEvidence?.state).toBe("verified");
		expect(reloaded.get(entry.daemonId)?.workspace?.lastEvidence?.validated).toBeDefined();
	});

	test("a delete whose Pod is gone reuses the stop's receipt and succeeds", async () => {
		const fx = await bootKubernetes({ collect: async (request) => gateReceipt(request) });
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);
		// The provider stop deleted the Pod: a stopped workspace observes none,
		// so no daemon is left to quiesce.
		setScenario(fx.providerDir, { podUid: null });

		await fx.lifecycle.deleteClone(entry.daemonId);

		// The gate adopted the stop's receipt: no second handshake, and the
		// workspace plus its provider resources are gone.
		expect(fx.collected).toHaveLength(1);
		expect(fx.deletions).toEqual([entry.daemonId]);
		expect(fx.registry.get(entry.daemonId)).toBeUndefined();
	});

	test("a receipt bound to an older generation never authorizes the delete", async () => {
		const fx = await bootKubernetes({ collect: async (request) => gateReceipt(request) });
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);
		await fx.lifecycle.stopClone(entry.daemonId);
		expect(fx.registry.get(entry.daemonId)!.workspace?.lastEvidence?.generation).toBe(1);

		// A wake authorizes the NEXT generation; the receipt above was
		// collected for generation 1's Pod/claim, so it must never authorize
		// deleting generation 2's resources.
		fx.registry.updateWorkspace(entry.daemonId, {
			authorizedGeneration: 2,
			lastAttemptedGeneration: 2,
		});
		setScenario(fx.providerDir, { podUid: null });

		const err = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(err.code).toBe("unavailable");
		expect(err.message).toContain("no verified evidence receipt was carried");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(existsSync(join(fx.workspaceDir, entry.daemonId))).toBe(true);
		expect(fx.collected).toHaveLength(1);
		expect(fx.deletions).toEqual([]);
	});

	test("a stop whose evidence collection fails still stops and reports that failure at delete", async () => {
		const fx = await bootKubernetes({
			collect: async () => {
				throw new CloneQuiesceError("unavailable", "daemon unreachable", "request");
			},
		});
		const entry = seedKubernetesClone(fx);
		await fx.lifecycle.ensureCloneRunning(entry.daemonId);

		// Stop is the operator's escape hatch: a failed handshake must not
		// fail it.
		await fx.lifecycle.stopClone(entry.daemonId);
		const stopped = fx.registry.get(entry.daemonId)!;
		expect(stopped.workspace?.desiredState).toBe("stopped");
		expect(stopped.status).toBe("asleep");
		expect(stopped.workspace?.enrollment).toBeUndefined();
		expect(stopped.workspace?.lastEvidence?.state).toBe("invalid");
		expect(stopped.workspace?.lastEvidence?.error?.code).toBe("unavailable");
		expect(stopped.workspace?.lastEvidence?.error?.message).toContain("daemon unreachable");

		// The delete reports the RECORDED verification failure — never a bare
		// "no receipt", which would misdescribe why the workspace cannot be
		// removed.
		setScenario(fx.providerDir, { podUid: null });
		const err = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(err.code).toBe("unavailable");
		expect(err.message).toContain("stop-time evidence collection failed");
		expect(err.message).toContain("daemon unreachable");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(after.workspace?.deletion?.receipt?.state).toBe("invalid");
		expect(existsSync(join(fx.workspaceDir, entry.daemonId))).toBe(true);
		expect(fx.deletions).toEqual([]);
	});

	test("a stopped workspace with no evidence at all still fails closed", async () => {
		const fx = await bootKubernetes();
		const entry = seedKubernetesClone(fx);
		// A launched workspace recorded before stop-time collection existed:
		// it was stopped without ever persisting evidence.
		fx.registry.updateWorkspace(entry.daemonId, {
			authorizedGeneration: 1,
			desiredState: "stopped",
		});
		setScenario(fx.providerDir, { podUid: null });

		const err = await lifecycleError(fx.lifecycle.deleteClone(entry.daemonId));
		expect(err.code).toBe("unavailable");
		expect(err.message).toContain("its Pod is gone and no verified evidence receipt was carried");

		const after = fx.registry.get(entry.daemonId)!;
		expect(after.workspace?.deletion?.state).toBe("delete-pending-retry");
		expect(existsSync(join(fx.workspaceDir, entry.daemonId))).toBe(true);
		expect(existsSync(readOnlyMarker(fx.logsDir, entry.daemonId))).toBe(false);
		expect(fx.collected).toEqual([]);
		expect(fx.deletions).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// S1 post-ready pair liveness
//
// A clone whose pair was observed live and then lost must stop presenting as
// live. The watcher is driven through the PairControllableTransport seam (a
// real registry with only its `paired` bit forced) and the scripted provider;
// assertions read the registry entry the roster projects, never private state.
// ---------------------------------------------------------------------------

describe("clone pair liveness after ready (S1)", () => {
	test(
		"a pair that was ready and is then lost errors the clone when the sandbox is gone, and stops probing",
		async () => {
			const fx = await bootKubernetes({ scenario: { runningWhileLive: true } });
			try {
				const entry = seedKubernetesClone(fx);
				const daemonId = entry.daemonId;
				await fx.lifecycle.ensureCloneRunning(daemonId);
				expect(fx.registry.get(daemonId)!.lifecycleStage).toBe("callback");

				// The daemon's pair dials: the watcher flips the stage ready.
				fx.transport.setPaired(true);
				await waitFor(
					() => fx.registry.get(daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair ready transition",
				);

				// The worker is gone (sandbox missing) and the pair is lost.
				setScenario(fx.providerDir, { runningWhileLive: false });
				fx.transport.setPaired(false);
				await waitFor(
					() => fx.registry.get(daemonId)?.status === "error",
					15_000,
					"post-ready demotion to error",
				);

				const after = fx.registry.get(daemonId)!;
				expect(after.lifecycleStage).toBe("failed");
				expect(after.lifecycleError).toContain("after the callback pair established");
				// A lost pair with desired-running is a crash, never a stop.
				expect(after.workspace?.desiredState).toBe("running");

				// The watcher stopped: no further provider invocations.
				// Real wall clock is unavoidable here: the watcher's post-ready
				// cadence is a real setTimeout and each probe spawns the provider
				// subprocess, so fake timers cannot drive the observation.
				const opsPath = join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl");
				const inspects = readOps(opsPath).filter((record) => record.op === "inspect").length;
				await Bun.sleep(6_000); // one full post-ready interval
				expect(readOps(opsPath).filter((record) => record.op === "inspect")).toHaveLength(inspects);
				expect(fx.registry.get(daemonId)!.status).toBe("error");
			} finally {
				fx.lifecycle.close();
			}
		},
		{ timeout: 45_000 },
	);

	test(
		"a deliberate stop stops the watcher immediately and is never relabeled a crash",
		async () => {
			const fx = await bootKubernetes({ scenario: { runningWhileLive: true } });
			try {
				const entry = seedKubernetesClone(fx);
				const daemonId = entry.daemonId;
				await fx.lifecycle.ensureCloneRunning(daemonId);
				fx.transport.setPaired(true);
				await waitFor(
					() => fx.registry.get(daemonId)?.lifecycleStage === "ready",
					5_000,
					"pair ready transition",
				);

				await fx.lifecycle.stopClone(daemonId);
				const stopped = fx.registry.get(daemonId)!;
				expect(stopped.workspace?.desiredState).toBe("stopped");
				expect(stopped.status).toBe("asleep");
				expect(stopped.lifecycleStage).toBeUndefined();

				// Even after the post-ready window elapses with the pair lost
				// and the provider reporting the sandbox gone, the stopped
				// entry is untouched and no probe fires. (Real wall clock: the
				// disarm removed a real setTimeout; a fake clock cannot prove a
				// removed subprocess-spawning timer stayed silent.)
				const opsPath = join(fx.workspaceDir, KUBE_STATE_REL, "ops.jsonl");
				setScenario(fx.providerDir, { runningWhileLive: false });
				fx.transport.setPaired(false);
				const inspects = readOps(opsPath).filter((record) => record.op === "inspect").length;
				await Bun.sleep(6_000); // one full post-ready interval
				const after = fx.registry.get(daemonId)!;
				expect(after.status).toBe("asleep");
				expect(after.workspace?.desiredState).toBe("stopped");
				expect(after.lifecycleError).toBeUndefined();
				expect(readOps(opsPath).filter((record) => record.op === "inspect")).toHaveLength(inspects);
			} finally {
				fx.lifecycle.close();
			}
		},
		{ timeout: 45_000 },
	);
});
