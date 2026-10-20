/**
 * Clone-workspace deletion lifecycle tests (DeletionSafetyTests). Deterministic failure-transition regressions over
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
 *     refused with a 400 and creates no workspace;
 *  6. the clone-path Git guard, one case per condition: a dirty
 *     tracked file, an untracked file, a stash, commits not preserved on
 *     origin, and an unusable git state each refuse deletion with the
 *     checkout, volume, and transcript store retained and no provider
 *     delete;
 *  7. the volume/store completeness cross-check, one case per mismatch
 *     class: a volume session file missing from the store, a size
 *     (truncation) disagreement, a same-size content rewrite (sha256), a
 *     session tree beyond the shared file bound, and a not-fleet-readable
 *     volume on an ever-started workspace (root or session tree) — each
 *     refuses with the store still writable and nothing deleted, while a
 *     genuinely empty, never-created, or genuinely removed (ENOENT) volume
 *     still deletes;
 *  8. the guards' pass-through: a stopped clone with a clean checkout and a
 *     fully stored session deletes exactly once, so the refusals above are
 *     never vacuous.
 *
 * Fixtures reuse fleet/server.testkit's fleetPaths/startTestFleet (real
 * startFleet on ephemeral ports, state under a tracked temp dir). Git
 * identity comes only from the operator's gitconfig, never overridden.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
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
	/**
	 * list-sessions answer for a volume the fleet cannot read (an entry with
	 * no `sha256` models a provider that cannot hash). Absent = the
	 * provider does not know the op (a typed invalid_request, as a real
	 * provider without it answers).
	 */
	listSessions?: {
		files: { path: string; size: number; sha256?: string }[];
		complete?: boolean;
	};
}

/**
 * Scripted fixture provider executable speaking OMP_PROVIDER_PROTO
 * (`<executable> <op>`, one JSON request on stdin, one JSON response on
 * stdout). Every request is durably appended to `<stateDir>/ops.jsonl` (the
 * provider state dir lives beside the persisted clone volume, so the record
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
} else if (op === "list-sessions") {
  const listed = scenario.listSessions;
  if (listed === undefined) console.log(err("invalid_request", "unknown op list-sessions"));
  else console.log(JSON.stringify({ ok: true, handle: req.handle ?? "h", observed: "stopped", sessions: listed.files, complete: listed.complete ?? true }));
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

/** Lowercase hex sha256 of a string's UTF-8 bytes (what a provider inventory reports). */
function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
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
	cloneRoot: string;
	logsDir: string;
	repoDir: string;
}

/**
 * Boot a fleet with a fake provider profile over a tracked temp dir: real
 * workspaceDir + state under tmp (fleet logs live at <tmp>/logs). Registers
 * a local git repo as the clone project.
 */
async function bootFleet(
	scenario: ProviderScenario,
	sharedWorkspaceDir?: string,
): Promise<FleetFixture> {
	const paths = fleetPaths("omp-workspace-lifecycle-");
	const workspaceDir = sharedWorkspaceDir ?? join(paths.tmp, "workspaces");
	const cloneRoot = join(dirname(paths.statePath), "clones");
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
	return { server, paths, workspaceDir, cloneRoot, logsDir, repoDir };
}

/** Create a clone of the registered repo, returning its daemonId. */
async function createClone(server: FleetServer, repoDir: string, name: string): Promise<string> {
	const { project } = server.registry.addProject(repoDir);
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

test(
	"fleets sharing a worktree destination allocate independent private clone volumes and provider state",
	async () => {
		const scenario = {
			runningWhileLive: false,
			stopObserved: "stopped" as const,
			deleteFailures: 0,
		};
		const first = await bootFleet(scenario);
		let second: FleetFixture | undefined;
		try {
			second = await bootFleet(scenario, first.workspaceDir);
			const firstId = await createClone(first.server, first.repoDir, "first");
			const secondId = await createClone(second.server, second.repoDir, "second");
			expect(firstId).toBe(secondId);
			const firstVolume = first.server.registry.get(firstId)!.cwd!;
			const secondVolume = second.server.registry.get(secondId)!.cwd!;
			expect(firstVolume).toBe(join(first.cloneRoot, firstId));
			expect(secondVolume).toBe(join(second.cloneRoot, secondId));
			expect(firstVolume).not.toBe(secondVolume);
			expect((await postJson(first.server.port, "/ctl/start", { daemonId: firstId })).status).toBe(
				200,
			);
			expect(providerOps(first.cloneRoot, firstId)).toHaveLength(1);
			expect(providerOps(second.cloneRoot, secondId)).toHaveLength(0);
			expect(
				(await postJson(second.server.port, "/ctl/start", { daemonId: secondId })).status,
			).toBe(200);
			expect(providerOps(second.cloneRoot, secondId)).toHaveLength(1);
			expect(existsSync(join(first.workspaceDir, firstId))).toBe(false);
		} finally {
			await second?.server.close();
			await first.server.close();
		}
	},
	{ timeout: 30_000 },
);

test(
	"a clone without its persisted location fails instead of using an allocation destination",
	async () => {
		const { server, cloneRoot, repoDir } = await bootFleet({
			runningWhileLive: false,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		try {
			const daemonId = await createClone(server, repoDir, "missing-location");
			server.registry.update(daemonId, { cwd: "" });
			const start = await postJson(server.port, "/ctl/start", { daemonId });
			expect(start.status).toBe(503);
			expect(providerOps(cloneRoot, daemonId)).toHaveLength(0);
			expect(server.registry.get(daemonId)!.cwd).toBe("");
		} finally {
			await server.close();
		}
	},
	{ timeout: 20_000 },
);

describe("clone workspace deletion lifecycle", () => {
	test(
		"deleting a live desired-running clone is refused with everything retained, and a second attempt cannot bypass the refusal",
		async () => {
			const { server, cloneRoot, repoDir } = await bootFleet({
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
				expect(providerOps(cloneRoot, daemonId).some((o) => o.op === "delete")).toBe(false);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"concurrent starts on one stopped clone serialize: one generation, both succeed",
		async () => {
			const { server, repoDir } = await bootFleet({
				runningWhileLive: true,
				stopObserved: "stopped",
				deleteFailures: 0,
			});
			try {
				const daemonId = await createClone(server, repoDir, "concurrent-start");
				const [a, b] = await Promise.all([
					postJson(server.port, "/ctl/start", { daemonId }),
					postJson(server.port, "/ctl/start", { daemonId }),
				]);
				expect(a.status).toBe(200);
				expect(b.status).toBe(200);
				// Unserialized, both starts computed generation 1 and both
				// enrolled; the loser's enrollment was then revoked. Serialized,
				// the second start reattaches to the first generation.
				const entry = server.registry.get(daemonId)!;
				expect(entry.workspace?.authorizedGeneration).toBe(1);
				expect(entry.workspace?.enrollment?.generation).toBe(1);
				expect(entry.workspace?.desiredState).toBe("running");
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"parallel deletes serialize: exactly one destroy, the loser refused",
		async () => {
			const { server, cloneRoot, repoDir } = await bootFleet({
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
				expect(existsSync(join(cloneRoot, daemonId))).toBe(false);
				expect(providerOps(cloneRoot, daemonId).filter((o) => o.op === "delete")).toHaveLength(1);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an incomplete store blocks deletion with the registry entry, volume, and store retained and a durable retry state",
		async () => {
			const { server, cloneRoot, logsDir, repoDir } = await bootFleet({
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
				seedSession(logsDir, cloneRoot, daemonId, {
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
				expect(existsSync(join(cloneRoot, daemonId))).toBe(true);
				expect(existsSync(readOnlyMarker(logsDir, daemonId))).toBe(false);
				// The provider never saw a delete (the gate stopped at the
				// verification step).
				expect(providerOps(cloneRoot, daemonId).filter((o) => o.op === "delete")).toHaveLength(0);
				// A refusal that ran nothing destructive does not strand the
				// row: Start abandons the pending delete.
				const wake = await postJson(server.port, "/ctl/start", { daemonId });
				expect(wake.status).toBe(200);
				expect(server.registry.get(daemonId)?.workspace?.deletion).toBeUndefined();
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
			// Preserve an old shared-root volume through the changed-destination restart.
			const cloneRoot = workspaceDir;
			const config = {
				workspaceDir: join(paths.tmp, "changed-worktrees"),
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
					workspaceDir: config.workspaceDir,
				});
			let daemonId: string;
			{
				const id = await createClone(server, repoDir, "verified-retry");
				daemonId = id;
				mkdirSync(workspaceDir, { recursive: true });
				renameSync(server.registry.get(id)!.cwd!, join(cloneRoot, id));
				server.registry.update(id, { cwd: join(cloneRoot, id) });
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
				seedSession(logsDir, cloneRoot, daemonId, {});

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
				expect(existsSync(join(cloneRoot, daemonId))).toBe(true);
				expect(deleteCount(cloneRoot, daemonId)).toBe(1); // exactly ONE failed attempt
				// Past the read-only flip the row stays quarantined: Start is refused.
				const blockedStart = await postJson(server.port, "/ctl/start", { daemonId });
				expect(blockedStart.status).toBe(409);

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
					expect(existsSync(join(cloneRoot, daemonId))).toBe(false);
					expect(existsSync(readOnlyMarker(logsDir, daemonId))).toBe(true);
					// The durable provider record shows the failed delete AND
					// the successful retry, exactly two attempts total across
					// both fleet lifetimes, no double destroy after success.
					expect(deleteCount(cloneRoot, daemonId)).toBe(2);
					const deletes = providerOps(cloneRoot, daemonId).filter((o) => o.op === "delete");
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

test(
	"clone create, start, and wake HTTP responses keep provider and enrollment state private",
	async () => {
		const { server, repoDir } = await bootFleet({
			runningWhileLive: true,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		try {
			const { project } = server.registry.addProject(repoDir);
			const response = await postJson(server.port, "/ctl/clones", {
				projectId: project.projectId,
				name: "private-clone",
				profileId: "local",
				source: { local: repoDir },
				start: true,
			});
			expect(response.status).toBe(201);
			const body = (await response.json()) as { entry: { daemonId: string } };
			const daemonId = body.entry.daemonId;
			const entry = server.registry.get(daemonId)!;
			// Prove the omitted facts actually exist; lifecycle assertions must
			// read private state in-process, not depend on a private HTTP shape.
			expect(entry.workspace?.source).toEqual({ local: repoDir });
			expect(entry.workspace?.providerHandle).toBe("h");
			expect(entry.workspace?.enrollment?.credentialHash).toBeDefined();
			expect(body.entry).toMatchObject({
				daemonId,
				name: "private-clone",
				workspaceKind: "clone",
				desiredState: "running",
				providerProfileId: "local",
			});
			for (const key of [
				"workspace",
				"source",
				"providerHandle",
				"enrollment",
				"credentialHash",
				"template",
				"registeredAt",
			]) {
				expect(body.entry).not.toHaveProperty(key);
			}
			expect(JSON.stringify(body)).not.toContain(repoDir);
			expect(JSON.stringify(body)).not.toContain(entry.workspace!.enrollment!.credentialHash);
			for (const route of ["/ctl/start", "/ctl/wake"]) {
				const started = await postJson(server.port, route, { daemonId });
				expect(started.status).toBe(200);
				expect(await started.json()).toEqual({ daemonId, observed: "running" });
				expect(server.registry.get(daemonId)!.workspace?.providerHandle).toBe("h");
			}
		} finally {
			await server.close();
		}
	},
	{ timeout: 20_000 },
);

describe("clone source validation over /ctl/clones", () => {
	const validSources = [
		{ label: "relative-local", kind: "local" as const },
		{ label: "remote-only", kind: "remote" as const },
	];

	for (const { label, kind } of validSources) {
		test(
			`a ${label} source clones successfully and materializes a real volume`,
			async () => {
				const { server, paths, workspaceDir, cloneRoot, repoDir } = await bootFleet({
					runningWhileLive: false,
					stopObserved: "stopped",
					deleteFailures: 0,
				});
				try {
					const { project } = server.registry.addProject(repoDir);
					const source =
						kind === "local"
							? { local: relative(process.cwd(), repoDir) }
							: { remote: `file://${repoDir}` };
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
					// Independent checkout is private to the selected fleet state,
					// never allocated in the configured worktree destination.
					expect(entry.cwd).toBe(join(dirname(paths.statePath), "clones", daemonId));
					expect(existsSync(join(workspaceDir, daemonId))).toBe(false);
					const checkout = join(cloneRoot, daemonId, ".checkout");
					expect(existsSync(join(checkout, ".git"))).toBe(true);
					expect(existsSync(join(checkout, "readme.md"))).toBe(true);
					if (kind === "local") {
						expect(entry.workspace?.source).toEqual({ local: repoDir });
						const marker = JSON.parse(
							readFileSync(join(entry.cwd!, ".omp-workspace-init.json"), "utf8"),
						) as { source: { local: string } };
						expect(marker.source.local).toBe(repoDir);
						const deletion = await deleteWorkspace(server.port, daemonId);
						expect(deletion.status).toBe(200);
						expect(server.registry.get(daemonId)).toBeUndefined();
						expect(existsSync(entry.cwd!)).toBe(false);
					}
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
				const { server, cloneRoot, repoDir } = await bootFleet({
					runningWhileLive: false,
					stopObserved: "stopped",
					deleteFailures: 0,
				});
				try {
					const { project } = server.registry.addProject(repoDir);
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
					// added and no private clone volume was created.
					expect(server.registry.list()).toHaveLength(before);
					let volumeEntries: string[];
					try {
						volumeEntries = readdirSync(cloneRoot);
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

describe("clone source remoteName over /ctl/clones", () => {
	test("a configured remote name resolves fleet-side and clones successfully", async () => {
		const { server, cloneRoot, repoDir } = await bootFleet({
			runningWhileLive: false,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		try {
			const { project } = server.registry.addProject(repoDir);
			await git(repoDir, ["remote", "add", "upstream", `file://${repoDir}`]);
			const res = await postJson(server.port, "/ctl/clones", {
				projectId: project.projectId,
				name: "clone-remote-name",
				profileId: "local",
				source: { remoteName: "upstream" },
				start: false,
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as { entry: { daemonId: string } };
			const checkout = join(cloneRoot, body.entry.daemonId, ".checkout");
			expect(existsSync(join(checkout, "readme.md"))).toBe(true);
		} finally {
			await server.close();
		}
	}, 20_000);

	test("an unconfigured remote name is refused with 503 and creates no workspace", async () => {
		const { server, repoDir } = await bootFleet({
			runningWhileLive: false,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		try {
			const { project } = server.registry.addProject(repoDir);
			const before = server.registry.list().length;
			const res = await postJson(server.port, "/ctl/clones", {
				projectId: project.projectId,
				name: "clone-missing-remote",
				profileId: "local",
				source: { remoteName: "nowhere" },
				start: false,
			});
			expect(res.status).toBe(503);
			expect(server.registry.list()).toHaveLength(before);
		} finally {
			await server.close();
		}
	}, 20_000);

	test("a kubernetes profile with no source refuses when the project has no origin remote", async () => {
		const paths = fleetPaths("omp-workspace-lifecycle-kube-");
		const workspaceDir = join(paths.tmp, "workspaces");
		const repoDir = join(paths.tmp, "repo");
		await makeRepo(repoDir);
		const fakeProvider = writeFakeProvider(join(paths.tmp, "provider"), {
			runningWhileLive: false,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		const server = await startTestFleet(
			{ statePath: paths.statePath, configPath: paths.configPath },
			{
				workspaceDir,
				providerProfiles: {
					kube: {
						id: "kube",
						provider: "kubernetes",
						executable: fakeProvider,
						image: "img",
						namespace: "ns",
						context: "ctx",
					},
				},
			},
			{ workspaceDir },
		);
		try {
			const { project } = server.registry.addProject(repoDir);
			const before = server.registry.list().length;
			const res = await postJson(server.port, "/ctl/clones", {
				projectId: project.projectId,
				name: "clone-kube-no-origin",
				profileId: "kube",
				start: false,
			});
			expect(res.status).toBe(503);
			expect(await res.text()).toContain("has no origin remote");
			expect(server.registry.list()).toHaveLength(before);
		} finally {
			await server.close();
		}
	}, 20_000);

	test("a provider-prepared profile with no source defaults to origin at the main checkout HEAD", async () => {
		const paths = fleetPaths("omp-workspace-lifecycle-kube-origin-");
		const workspaceDir = join(paths.tmp, "workspaces");
		const repoDir = join(paths.tmp, "repo");
		await makeRepo(repoDir);
		// A local path is a valid git remote URL and keeps pin verification hermetic.
		const originUrl = repoDir;
		await git(repoDir, ["remote", "add", "origin", originUrl]);
		const head = await git(repoDir, ["rev-parse", "HEAD"]);
		const fakeProvider = writeFakeProvider(join(paths.tmp, "provider"), {
			runningWhileLive: false,
			stopObserved: "stopped",
			deleteFailures: 0,
		});
		const server = await startTestFleet(
			{ statePath: paths.statePath, configPath: paths.configPath },
			{
				workspaceDir,
				providerProfiles: {
					kube: {
						id: "kube",
						provider: "kubernetes",
						executable: fakeProvider,
						image: "img",
						namespace: "ns",
						context: "ctx",
					},
				},
			},
			{ workspaceDir },
		);
		try {
			const { project } = server.registry.addProject(repoDir);
			const res = await postJson(server.port, "/ctl/clones", {
				projectId: project.projectId,
				name: "clone-kube-origin",
				profileId: "kube",
				start: false,
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as { entry: { daemonId: string } };
			const record = server.registry.get(body.entry.daemonId)?.workspace;
			expect(record?.source).toEqual({ remote: originUrl });
			expect(record?.pinnedRevision).toBe(head);
		} finally {
			await server.close();
		}
	}, 20_000);
});

// ---------------------------------------------------------------------------
// Clone-deletion guard coverage (Git guard; volume/store cross-check).
// The worktree suites exercise the worktree path only, so every refusal
// class below is pinned on a stopped, EVER-STARTED clone (a real provider
// history, so "no provider delete" is an observable claim and the gate's
// quiesce path actually runs). Each case is a single injected defect
// against an otherwise deletion-ready workspace, and the retention contract
// is shared: roster entry + delete-pending-retry, checkout, volume, and
// transcript store all retained, store never flipped read-only, provider
// never sees a delete.
// ---------------------------------------------------------------------------

interface GuardFixture extends FleetFixture {
	daemonId: string;
	checkoutDir: string;
	volume: { root: string; sessions: string };
}

/**
 * Boot a fleet and create a clone that has STARTED once and is now stopped:
 * everStarted (authorized generation + provider handle) with a proven stop,
 * so admission and quiesce pass and only the guards under test can refuse.
 */
async function bootStoppedClone(
	name: string,
	listSessions?: ProviderScenario["listSessions"],
): Promise<GuardFixture> {
	const fixture = await bootFleet({
		runningWhileLive: false,
		stopObserved: "stopped",
		deleteFailures: 0,
		...(listSessions !== undefined ? { listSessions } : {}),
	});
	const daemonId = await createClone(fixture.server, fixture.repoDir, name);
	const start = await postJson(fixture.server.port, "/ctl/start", { daemonId });
	expect(start.status).toBe(200);
	const stop = await postJson(fixture.server.port, "/ctl/stop", { selector: daemonId });
	expect(stop.status).toBe(200);
	const volume = volumePaths(fixture.cloneRoot, daemonId);
	return { ...fixture, daemonId, checkoutDir: join(volume.root, ".checkout"), volume };
}

/** Stored main transcript of the seeded session: `logs/<id>/<session>/<session>.jsonl`. */
function storedSessionPath(logsDir: string, daemonId: string): string {
	return join(logsDir, daemonId, SESSION_ID, `${SESSION_ID}.jsonl`);
}

/** Raw `git -C <cwd> <args>` exit code (never throws). */
async function gitExit(cwd: string, args: string[]): Promise<number> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	return await proc.exited;
}

/**
 * One refused deletion plus the full retention contract: 409, the
 * caller-visible error is exactly the gate's persisted typed failure (no
 * generic 500 envelope), the roster entry stays in delete-pending-retry,
 * the checkout, volume, and transcript store are retained, the store was
 * never flipped read-only, and the provider never saw a delete.
 *
 * `retainedVolumeRoot` defaults to the persisted volume location; the
 * unreadable/relocated classes pass the location the volume still occupies
 * (the refusal must retain the bytes where they are). The provider state dir
 * follows the volume's parent (`join(dirname(volumeRoot), ".provider-state")`,
 * per the lifecycle's own path rule), so the delete-op assertion stays
 * meaningful for a relocated volume too.
 */
async function expectRefusedWithRetention(
	fixture: GuardFixture,
	response: Response,
	code: "conflict" | "archive_conflict",
	opts: { retainedVolumeRoot?: string; storedSession?: boolean } = {},
): Promise<void> {
	const retainedVolumeRoot = opts.retainedVolumeRoot ?? fixture.volume.root;
	expect(response.status).toBe(409);
	const entry = fixture.server.registry.get(fixture.daemonId)!;
	expect(entry.workspace?.deletion?.state).toBe("delete-pending-retry");
	expect(entry.workspace?.deletion?.error?.code).toBe(code);
	const body = (await response.json()) as { error?: string };
	expect(body.error).toBe(entry.workspace?.deletion?.error?.message);
	expect(existsSync(join(retainedVolumeRoot, ".checkout"))).toBe(true);
	expect(existsSync(retainedVolumeRoot)).toBe(true);
	if (opts.storedSession !== false) {
		expect(existsSync(storedSessionPath(fixture.logsDir, fixture.daemonId))).toBe(true);
	}
	expect(existsSync(readOnlyMarker(fixture.logsDir, fixture.daemonId))).toBe(false);
	expect(
		providerOps(dirname(retainedVolumeRoot), fixture.daemonId).filter((op) => op.op === "delete"),
	).toHaveLength(0);
	// Still listed: a refusal is retry-able, never a silent roster eviction.
	expect(fixture.server.registry.list().some((e) => e.daemonId === fixture.daemonId)).toBe(true);
}

/** Errno thrown for a path, or undefined when it stats cleanly (never suppresses). */
function pathErrorCode(path: string): string | undefined {
	try {
		statSync(path);
		return undefined;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error) {
			const code = error.code; // unknown: validated below.
			if (typeof code === "string") return code;
		}
		return "unknown";
	}
}

describe("clone deletion git guard", () => {
	test(
		"a dirty tracked file refuses deletion with the checkout, volume, and store retained",
		async () => {
			const fixture = await bootStoppedClone("git-dirty");
			try {
				// The store/volume are deletion-ready: only the checkout blocks.
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const readme = join(fixture.checkoutDir, "readme.md");
				writeFileSync(readme, "tampered\n");
				expect(await git(fixture.checkoutDir, ["status", "--porcelain=v1"])).not.toBe("");

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"conflict",
				);
				// Retained as-is: the uncommitted edit was not reset or stashed.
				expect(readFileSync(readme, "utf8")).toBe("tampered\n");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an untracked file refuses deletion with the checkout, volume, and store retained",
		async () => {
			const fixture = await bootStoppedClone("git-untracked");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const stray = join(fixture.checkoutDir, "scratch.md");
				writeFileSync(stray, "notes\n");
				expect(await git(fixture.checkoutDir, ["status", "--porcelain=v1"])).toContain(
					"scratch.md",
				);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"conflict",
				);
				expect(existsSync(stray)).toBe(true); // never deleted with the volume
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a stash refuses deletion with the checkout, volume, and store retained",
		async () => {
			const fixture = await bootStoppedClone("git-stash");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				writeFileSync(join(fixture.checkoutDir, "readme.md"), "stashed work\n");
				await git(fixture.checkoutDir, ["stash", "push", "-m", "unpreserved"]);
				// A clean tree with one stash: the stash alone blocks.
				expect(await git(fixture.checkoutDir, ["status", "--porcelain=v1"])).toBe("");
				expect(await git(fixture.checkoutDir, ["stash", "list"])).not.toBe("");

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"conflict",
				);
				// The refusal never drops the stash.
				expect(await git(fixture.checkoutDir, ["stash", "list"])).not.toBe("");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a commit not preserved on origin refuses deletion with the checkout, volume, and store retained",
		async () => {
			const fixture = await bootStoppedClone("git-local-commit");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				writeFileSync(join(fixture.checkoutDir, "local.md"), "local work\n");
				await git(fixture.checkoutDir, ["add", "local.md"]);
				await git(fixture.checkoutDir, ["commit", "-q", "-m", "unpreserved local work"]);
				expect(await git(fixture.checkoutDir, ["status", "--porcelain=v1"])).toBe("");
				const unpreserved = async (): Promise<number> =>
					Number(
						await git(fixture.checkoutDir, [
							"rev-list",
							"--count",
							"HEAD",
							"--not",
							"--remotes=origin",
						]),
					);
				expect(await unpreserved()).toBeGreaterThan(0);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"conflict",
				);
				// The unpreserved commit survives the refusal (nothing pushed
				// or reset on the caller's behalf).
				expect(await unpreserved()).toBeGreaterThan(0);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an unusable git state refuses deletion with the checkout, volume, and store retained",
		async () => {
			const fixture = await bootStoppedClone("git-unusable");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// `.git` still EXISTS (so the guard cannot skip a never-prepared
				// clone) but is not a repository: every git read fails, so the
				// checkout's safety is unknowable and deletion must block.
				const dotGit = join(fixture.checkoutDir, ".git");
				rmSync(dotGit, { recursive: true, force: true });
				writeFileSync(dotGit, "not a git dir\n");
				expect(existsSync(dotGit)).toBe(true);
				expect(await gitExit(fixture.checkoutDir, ["status", "--porcelain=v1"])).not.toBe(0);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"conflict",
				);
				// Nothing was repaired or removed: the unusable state is intact.
				expect(readFileSync(dotGit, "utf8")).toBe("not a git dir\n");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);
});

describe("clone deletion volume/store cross-check", () => {
	/** The volume's main transcript of the seeded session. */
	function volumeMain(fixture: GuardFixture): string {
		return join(fixture.volume.sessions, SESSION_ID, `${SESSION_ID}.jsonl`);
	}

	test(
		"a volume session file missing from the store refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-missing-file");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// The store verifies by itself; the volume carries a lineage file
				// the store never received (logs were not fully streamed).
				const unstreamed = join(fixture.volume.sessions, SESSION_ID, "extra.jsonl");
				writeFileSync(unstreamed, '{"type":"message"}\n');

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
				// The unstreamed bytes are retained, not deleted with the volume.
				expect(readFileSync(unstreamed, "utf8")).toBe('{"type":"message"}\n');
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a volume file shorter than its stored bytes refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-truncated");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const storedBytes = readFileSync(storedSessionPath(fixture.logsDir, fixture.daemonId));
				const truncated = storedBytes.subarray(0, storedBytes.length - 8);
				writeFileSync(volumeMain(fixture), truncated);
				expect(readFileSync(volumeMain(fixture)).length).toBeLessThan(storedBytes.length);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
				// Both sides retained byte-for-byte: nothing rewritten or healed.
				expect(readFileSync(volumeMain(fixture)).length).toBe(truncated.length);
				expect(readFileSync(storedSessionPath(fixture.logsDir, fixture.daemonId))).toEqual(
					storedBytes,
				);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a same-size content rewrite on the volume refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-rewritten");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const original = readFileSync(volumeMain(fixture), "utf8");
				const rewritten = original.replace('"text":"hi"', '"text":"yo"');
				// Same length: only the sha256 comparison can catch this rewrite.
				expect(Buffer.byteLength(rewritten, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
				expect(rewritten).not.toBe(original);
				writeFileSync(volumeMain(fixture), rewritten);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
				expect(readFileSync(volumeMain(fixture), "utf8")).toBe(rewritten);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a volume session tree beyond the verification bounds refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-bounds");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// 10k files is the shared export/verify ceiling; the bound check
				// runs BEFORE any per-file comparison, so this refusal is the
				// bound (the store itself verifies: one contiguous session).
				const sessionDir = join(fixture.volume.sessions, SESSION_ID);
				for (let i = 0; i < 10_000; i++) {
					writeFileSync(join(sessionDir, `f${String(i).padStart(5, "0")}.jsonl`), "");
				}
				expect(readdirSync(sessionDir).length).toBeGreaterThan(10_000);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
				// The oversized tree is retained (never partially reaped).
				expect(readdirSync(sessionDir).length).toBeGreaterThan(10_000);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"an ever-started clone whose volume is not fleet-readable refuses deletion with the volume and store retained",
		async () => {
			const fixture = await bootStoppedClone("volume-not-readable");
			try {
				// A session only the VOLUME holds: nothing was ever streamed, so
				// the store has no subtree at all (no sessions to compare).
				mkdirSync(join(fixture.volume.sessions, SESSION_ID), { recursive: true });
				writeFileSync(
					join(fixture.volume.sessions, SESSION_ID, `${SESSION_ID}.jsonl`),
					transcriptJsonl(),
				);
				// The volume is not readable at its persisted location (an
				// unmounted/substituted volume root, exactly what a k8s PVC is
				// fleet-side): existsSync(volumeRoot) is the fleet-side
				// readability test, and with no stored sessions to compare, the
				// workspace's completeness is unprovable — an ever-started
				// workspace is refused rather than inferred complete.
				const detached = join(fixture.cloneRoot, `${fixture.daemonId}.detached`);
				renameSync(fixture.volume.root, detached);
				expect(existsSync(fixture.volume.root)).toBe(false);
				// Genuinely removed (ENOENT), NOT unreadable: this must stay on
				// the absent-volume path, not the strict-probe refusal.
				expect(pathErrorCode(fixture.volume.root)).toBe("ENOENT");
				const volumeMainFile = join(
					detached,
					".home",
					"agent",
					"sessions",
					SESSION_ID,
					`${SESSION_ID}.jsonl`,
				);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
					{ retainedVolumeRoot: detached, storedSession: false },
				);
				// The unstreamed local session survives the refusal.
				expect(readFileSync(volumeMainFile, "utf8")).toBe(transcriptJsonl());
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an ever-started clone whose volume root cannot be stat'd refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-root-unverifiable");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// The recorded root is replaced by a symlink that resolves
				// through a regular file: statSync(volumeRoot) fails with
				// ENOTDIR (deterministic, no permissions involved), while the
				// volume's PARENT stays a usable directory so the provider
				// state dir the gate's quiesce writes to still works.
				const relocated = join(fixture.cloneRoot, `${fixture.daemonId}.relocated`);
				renameSync(fixture.volume.root, relocated);
				const regularFile = join(fixture.cloneRoot, "not-a-directory");
				writeFileSync(regularFile, "regular file\n");
				symlinkSync(join(regularFile, "sub"), fixture.volume.root);
				// The store verified WITH a session, so before the strict probe
				// this state took the absent-volume path: existsSync cannot see
				// the ENOTDIR and reported the root as absent.
				expect(pathErrorCode(fixture.volume.root)).toBe("ENOTDIR");
				expect(existsSync(fixture.volume.root)).toBe(false);
				expect(existsSync(storedSessionPath(fixture.logsDir, fixture.daemonId))).toBe(true);

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
					{ retainedVolumeRoot: relocated },
				);
				// The relocated volume (checkout + session tree) is untouched;
				// the provider state dir stayed beside it (the helper's
				// delete-op check reads it via dirname(retainedVolumeRoot)).
				expect(providerOps(fixture.cloneRoot, fixture.daemonId).length).toBeGreaterThan(0);
				expect(existsSync(join(relocated, ".checkout", ".git"))).toBe(true);
				expect(existsSync(join(relocated, ".home", "agent", "sessions", SESSION_ID))).toBe(true);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an ever-started clone whose session tree cannot be enumerated refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-tree-not-enumerable");
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// Replacing the session root with a regular file is the
				// permission-independent way to make it unenumerable: the path
				// exists, `readdirSync` fails (ENOTDIR), and the fleet must not
				// read that as "no volume sessions to compare".
				rmSync(fixture.volume.sessions, { recursive: true, force: true });
				writeFileSync(fixture.volume.sessions, "not a directory\n");
				expect(() => readdirSync(fixture.volume.sessions)).toThrow();

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
				// The substituted path is retained: nothing repaired or deleted.
				expect(readFileSync(fixture.volume.sessions, "utf8")).toBe("not a directory\n");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an ever-started clone whose session subtree cannot be enumerated refuses deletion with everything retained",
		async () => {
			const fixture = await bootStoppedClone("volume-subtree-not-enumerable");
			const sessionDir = join(fixture.volume.sessions, SESSION_ID);
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				// A session dir the fleet cannot read (EACCES for this suite's
				// non-root user; the ENOTDIR case above is the
				// permission-independent mechanism). The tree still holds the
				// session bytes, which is exactly why the walk must refuse
				// instead of reporting zero files.
				chmodSync(sessionDir, 0o000);
				expect(() => readdirSync(sessionDir)).toThrow();

				await expectRefusedWithRetention(
					fixture,
					await deleteWorkspace(fixture.server.port, fixture.daemonId),
					"archive_conflict",
				);
			} finally {
				chmodSync(sessionDir, 0o755); // Restore so the retained bytes are assertable (and cleanable).
				await fixture.server.close();
			}
			// Retained: only unreadable to the fleet, never reaped.
			expect(readFileSync(join(sessionDir, `${SESSION_ID}.jsonl`), "utf8")).toBe(transcriptJsonl());
		},
		{ timeout: 20_000 },
	);

	test(
		"a never-started clone with an unenumerable session tree still deletes (the refusal is gated on everStarted)",
		async () => {
			const fixture = await bootFleet({
				runningWhileLive: false,
				stopObserved: "stopped",
				deleteFailures: 0,
			});
			try {
				const daemonId = await createClone(fixture.server, fixture.repoDir, "never-started");
				// Same unenumerable tree as the refusal case, but this clone
				// never ran compute: there is no retained provider history, and
				// a never-started clone has no volume sessions to lose, so the
				// deletion proceeds (the strict rule is gated on everStarted).
				expect(
					fixture.server.registry.get(daemonId)!.workspace?.authorizedGeneration,
				).toBeUndefined();
				expect(fixture.server.registry.get(daemonId)!.workspace?.providerHandle).toBeUndefined();
				seedSession(fixture.logsDir, fixture.cloneRoot, daemonId, {});
				const volume = volumePaths(fixture.cloneRoot, daemonId);
				rmSync(volume.sessions, { recursive: true, force: true });
				writeFileSync(volume.sessions, "not a directory\n");
				expect(() => readdirSync(volume.sessions)).toThrow();

				const response = await deleteWorkspace(fixture.server.port, daemonId);
				expect(response.status).toBe(200);
				const body = (await response.json()) as { removed?: string; verified?: string[] };
				expect(body.removed).toBe(daemonId);
				expect(body.verified).toEqual([SESSION_ID]);
				expect(fixture.server.registry.get(daemonId)).toBeUndefined();
				expect(existsSync(volume.root)).toBe(false);
				// Never started: the provider saw no stop and no delete.
				expect(providerOps(fixture.cloneRoot, daemonId)).toHaveLength(0);
				expect(existsSync(storedSessionPath(fixture.logsDir, daemonId))).toBe(true);
				expect(existsSync(readOnlyMarker(fixture.logsDir, daemonId))).toBe(true);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	// The refusal above must not be vacuous: the two legitimate "nothing on the
	// volume to compare" states keep deleting (only ENOENT proves absence).
	const emptyOrAbsentTree = [
		{
			label: "session tree that does not exist (ENOENT)",
			prepare: (fixture: GuardFixture): void => {
				rmSync(fixture.volume.sessions, { recursive: true, force: true });
			},
		},
		{
			label: "session tree that is present but empty",
			prepare: (fixture: GuardFixture): void => {
				rmSync(join(fixture.volume.sessions, SESSION_ID, `${SESSION_ID}.jsonl`), { force: true });
			},
		},
		{
			label: "volume root that does not exist at all",
			prepare: (fixture: GuardFixture): void => {
				rmSync(fixture.volume.root, { recursive: true, force: true });
				// Genuinely absent (ENOENT): the success path is preserved.
				expect(pathErrorCode(fixture.volume.root)).toBe("ENOENT");
				expect(existsSync(fixture.volume.root)).toBe(false);
			},
		},
	];

	for (const { label, prepare } of emptyOrAbsentTree) {
		test(
			`an ever-started clone with a ${label} still deletes and retains its verified store`,
			async () => {
				const fixture = await bootStoppedClone("volume-empty-or-absent", { files: [] });
				try {
					seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
					prepare(fixture);

					const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
					expect(response.status).toBe(200);
					const body = (await response.json()) as { removed?: string; verified?: string[] };
					expect(body.removed).toBe(fixture.daemonId);
					expect(body.verified).toEqual([SESSION_ID]);
					expect(fixture.server.registry.get(fixture.daemonId)).toBeUndefined();
					expect(existsSync(fixture.volume.root)).toBe(false);
					// The store is the retained artifact and flipped read-only.
					expect(existsSync(storedSessionPath(fixture.logsDir, fixture.daemonId))).toBe(true);
					expect(existsSync(readOnlyMarker(fixture.logsDir, fixture.daemonId))).toBe(true);
					expect(
						providerOps(fixture.cloneRoot, fixture.daemonId).filter((op) => op.op === "delete"),
					).toHaveLength(1);
				} finally {
					await fixture.server.close();
				}
			},
			{ timeout: 20_000 },
		);
	}
});

describe("clone deletion of a volume the fleet cannot read (provider session inventory)", () => {
	/** Make the volume invisible fleet-side, as a kubernetes claim always is. */
	function detachVolume(fixture: GuardFixture): string {
		const detached = join(fixture.cloneRoot, `${fixture.daemonId}.detached`);
		renameSync(fixture.volume.root, detached);
		return detached;
	}

	const mainPath = `${SESSION_ID}/${SESSION_ID}.jsonl`;

	test(
		"a clone whose provider proves an empty volume deletes with an empty store (never wrote a transcript)",
		async () => {
			const fixture = await bootStoppedClone("k8s-no-transcript", { files: [] });
			try {
				detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				expect(response.status).toBe(200);
				const body = (await response.json()) as { removed?: string; verified?: string[] };
				expect(body.removed).toBe(fixture.daemonId);
				expect(body.verified).toEqual([]);
				expect(fixture.server.registry.get(fixture.daemonId)).toBeUndefined();
				const ops = providerOps(fixture.cloneRoot, fixture.daemonId).map((o) => o.op);
				expect(ops).toContain("list-sessions");
				expect(ops.filter((op) => op === "delete")).toHaveLength(1);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an inventory whose files the verified store holds deletes and retains the store",
		async () => {
			const size = Buffer.byteLength(transcriptJsonl(), "utf8");
			const fixture = await bootStoppedClone("k8s-matched", {
				files: [{ path: mainPath, size, sha256: sha256Hex(transcriptJsonl()) }],
			});
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				expect(response.status).toBe(200);
				const body = (await response.json()) as { removed?: string; verified?: string[] };
				expect(body.verified).toEqual([SESSION_ID]);
				expect(existsSync(readOnlyMarker(fixture.logsDir, fixture.daemonId))).toBe(true);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a volume session the store never received refuses deletion, retains everything, and leaves the row startable",
		async () => {
			const fixture = await bootStoppedClone("k8s-unmatched", {
				files: [{ path: mainPath, size: 64, sha256: "0".repeat(64) }],
			});
			try {
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
					storedSession: false,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain(`session ${SESSION_ID} file ${SESSION_ID}.jsonl (64 bytes)`);
				expect(body.error).toContain("missing from the fleet store");

				// Retry delete is still available (and still refused for the same reason).
				const retry = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				expect(retry.status).toBe(409);

				// Nothing destructive ran, so Start abandons the pending delete.
				const start = await postJson(fixture.server.port, "/ctl/start", {
					daemonId: fixture.daemonId,
				});
				expect(start.status).toBe(200);
				expect(fixture.server.registry.get(fixture.daemonId)?.workspace?.deletion).toBeUndefined();
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"a store file shorter than the volume's file refuses deletion",
		async () => {
			const size = Buffer.byteLength(transcriptJsonl(), "utf8");
			const fixture = await bootStoppedClone("k8s-short-store", {
				files: [{ path: mainPath, size: size + 10, sha256: "0".repeat(64) }],
			});
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain(`truncated in the fleet store (${size}/${size + 10} bytes)`);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a store file longer than the volume's file refuses deletion (exact match, not append-only growth)",
		async () => {
			const size = Buffer.byteLength(transcriptJsonl(), "utf8");
			const fixture = await bootStoppedClone("k8s-long-store", {
				files: [{ path: mainPath, size: size - 1, sha256: "0".repeat(64) }],
			});
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain(`longer in the fleet store (${size}/${size - 1} bytes)`);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a same-size rewrite of a volume file refuses deletion (sha256 differs from the store)",
		async () => {
			const original = transcriptJsonl();
			const size = Buffer.byteLength(original, "utf8");
			// Same length, different bytes: only the digest can tell.
			const rewritten = `${original.slice(0, -2)}X\n`;
			expect(Buffer.byteLength(rewritten, "utf8")).toBe(size);
			const fixture = await bootStoppedClone("k8s-rewritten", {
				files: [{ path: mainPath, size, sha256: sha256Hex(rewritten) }],
			});
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain(`file ${SESSION_ID}.jsonl differs from its stored bytes`);
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an inventory entry without a sha256 refuses deletion (fail safe)",
		async () => {
			const size = Buffer.byteLength(transcriptJsonl(), "utf8");
			const fixture = await bootStoppedClone("k8s-no-hash", {
				files: [{ path: mainPath, size }],
			});
			try {
				seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain("without a sha256");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a truncated inventory refuses deletion",
		async () => {
			const fixture = await bootStoppedClone("k8s-truncated-inventory", {
				files: [],
				complete: false,
			});
			try {
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
					storedSession: false,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain("exceeds verification bounds");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a provider that does not know list-sessions fails safe: deletion is refused",
		async () => {
			const fixture = await bootStoppedClone("k8s-unsupported-op");
			try {
				const detached = detachVolume(fixture);
				const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
				const refusal = response.clone();
				await expectRefusedWithRetention(fixture, response, "archive_conflict", {
					retainedVolumeRoot: detached,
					storedSession: false,
				});
				const body = (await refusal.json()) as { error?: string };
				expect(body.error).toContain("could not list its sessions");
				expect(body.error).toContain("invalid_request");
			} finally {
				await fixture.server.close();
			}
		},
		{ timeout: 20_000 },
	);
});

test(
	"with every guard satisfied a stopped clone deletes exactly once (the refusals above are not vacuous)",
	async () => {
		const fixture = await bootStoppedClone("guards-satisfied");
		try {
			seedSession(fixture.logsDir, fixture.cloneRoot, fixture.daemonId, {});
			expect(await git(fixture.checkoutDir, ["status", "--porcelain=v1"])).toBe("");

			const response = await deleteWorkspace(fixture.server.port, fixture.daemonId);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { removed?: string; verified?: string[] };
			expect(body.removed).toBe(fixture.daemonId);
			expect(body.verified).toEqual([SESSION_ID]);
			// Identity + volume destroyed exactly once; the verified store is
			// retained read-only for Retention.
			expect(fixture.server.registry.get(fixture.daemonId)).toBeUndefined();
			expect(existsSync(fixture.volume.root)).toBe(false);
			expect(existsSync(storedSessionPath(fixture.logsDir, fixture.daemonId))).toBe(true);
			expect(existsSync(readOnlyMarker(fixture.logsDir, fixture.daemonId))).toBe(true);
			expect(deleteCount(fixture.cloneRoot, fixture.daemonId)).toBe(1);
			expect(
				providerOps(fixture.cloneRoot, fixture.daemonId).filter((op) => op.op === "delete"),
			).toHaveLength(1);
		} finally {
			await fixture.server.close();
		}
	},
	{ timeout: 20_000 },
);
