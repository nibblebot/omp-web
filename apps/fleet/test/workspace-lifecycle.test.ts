/**
 * Clone-workspace deletion lifecycle tests (clone-plan P7.3/P7.5,
 * DeletionSafetyTests). Deterministic failure-transition regressions over
 * the real fleet control plane (loopback HTTP) with a real git clone source
 * and a scripted fixture provider executable that keeps DURABLE operation
 * records (`<stateDir>/ops.jsonl`, appended on every provider request). No
 * test depends on error wording or source text; every assertion is an
 * observable retention / refusal / retry / no-double-writer contract:
 *
 *  1. live-writer refusal + no bypass: deleting a desired-running clone is
 *     refused and a second delete attempt through the same gate is refused
 *     again: the roster entry, the volume, and the enrollment survive and
 *     the provider never sees a delete;
 *  2. serialized concurrent deletes: parallel deletes of a stopped,
 *     verified workspace complete exactly one destroy (one entry removal,
 *     one provider delete); the loser is refused, never a double delete;
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
 *     refused with a 400 and creates no workspace.
 *
 * Fixtures reuse fleet/server.testkit's fleetPaths/startTestFleet (real
 * startFleet on ephemeral ports, state under a tracked temp dir). Git
 * identity comes only from the operator's gitconfig, never overridden.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FleetServer } from "../server";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	pinSettingsInMemory,
	postJson,
	startTestFleet,
} from "./server.testkit";

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
	generation: number;
	handle: string | null;
}

/** Durable provider-op records from a workspace's provider state dir. */
function providerOps(workspaceDir: string, daemonId: string): OpsRecord[] {
	try {
		const raw = readFileSync(join(workspaceDir, ".provider-state", daemonId, "ops.jsonl"), "utf8");
		return raw
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as OpsRecord);
	} catch {
		return [];
	}
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
}

/**
 * Scripted fixture provider executable speaking OMP_PROVIDER_PROTO
 * (`<executable> <op>`, one JSON request on stdin, one JSON response on
 * stdout). Every request is durably appended to `<stateDir>/ops.jsonl` (the
 * provider state dir lives under the fleet workspaceDir, so the record
 * survives fleet restarts). `deleteFailures` control how many initial
 * `delete` requests fail (`unavailable`); `stopObserved` can refuse to
 * prove termination.
 */
function writeFakeProvider(dir: string, scenario: ProviderScenario): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
const opsFile = join(req.stateDir, "ops.jsonl");
appendFileSync(opsFile, JSON.stringify({ op, generation: req.generation, handle: req.handle ?? null }) + "\\n");
const countFile = join(req.stateDir, "delete-count.json");
const deletesSeen = (existsSync(countFile) ? Number.parseInt(readFileSync(countFile, "utf8"), 10) : 0) || 0;
const scenario = ${JSON.stringify(scenario)};
const ok = (observed) => JSON.stringify({ ok: true, handle: req.handle ?? "h", observed, pid: 4242 });
const err = (code, message) => JSON.stringify({ ok: false, error: { code, message, retryable: false } });
if (op === "ensure-running") {
  console.log(ok("running"));
} else if (op === "inspect") {
  console.log(ok(scenario.runningWhileLive ? "running" : "stopped"));
} else if (op === "stop") {
  console.log(ok(scenario.stopObserved));
} else if (op === "delete") {
  const attempt = deletesSeen + 1;
  writeFileSync(countFile, String(attempt));
  if (attempt <= scenario.deleteFailures) console.log(err("unavailable", "provider storage busy; delete failed"));
  else console.log(ok("missing"));
} else {
  console.log(ok("missing"));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/**
 * JSONL session transcript: a title slot, a session header, then one
 * assistant message line, all newline-terminated. Matches the daemon's
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
		"deleting a live desired-running clone is refused with everything retained, and a second attempt cannot bypass the refusal",
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
				// again; no state change, no bypass, no accidental delete.
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
				expect(providerOps(workspaceDir, daemonId).some((o) => o.op === "delete")).toBe(false);
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
				// in flight, or 400 once the winner removed the entry),
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
				// check fails, the exact interrupted-stream condition.
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
				// read-only marker, verification never passed).
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
					// the successful retry, exactly two attempts total across
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
