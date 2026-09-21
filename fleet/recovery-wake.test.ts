/**
 * Wake-from-store / resume recovery regressions (clone-plan P8.4/P8.9/P8.10;
 * docs/clone-contracts.md "Wake"). Deliberately narrow deterministic tests
 * over the uncertain boundaries this lane introduced; NOT a lifecycle
 * matrix (DeletionSafetyTests owns fleet/workspace-lifecycle.test.ts for the
 * destroy path; Lifecycle owns fleet/clone-recovery.test.ts for restart
 * races). No file/helper collision with either.
 *
 * Covered boundaries:
 *  1. materializeMissingSessionFiles fills ONLY cold/missing files and never
 *     clobbers a newer volume byte (the store can lag an unacked tail).
 *  2. Hostile stored relpaths (traversal, absolute, `.` segments) abort
 *     typed `invalid_request` and never escape the sessions dir.
 *  3. resolveMainSessionFile finds depth-1 and depth-2 mains; pickNewest
 *     union (volume ∪ store) returns the newest mtime.
 *  4. An explicit resumeSessionId wake materializes the stored transcript
 *     into the volume and hands the daemon OMP_SESSION_RESUME (bwrap
 *     profile), checked via the callback-env handoff the fake provider
 *     records; a never-started clone wake writes NO resume env.
 *  5. A k8s-shaped profile wake writes NO resume env (pod paths differ).
 *  6. resume-onto-fresh-clone route keeps 404 (no provenance) / 409 (live
 *     workspace or no transcripts) / 503 (no provider hook, P5) after the
 *     shared-helper refactor.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
} from "./server.testkit";
import { FleetLogStore, type LogChunk } from "./log-store";
import {
	WakeMaterializeError,
	materializeMissingSessionFiles,
	pickNewestSessionId,
	resolveMainSessionFile,
} from "./wake-materialize";

afterAll(cleanupTempDirs);

await pinSettingsInMemory();

const WS = "d1";
const SESSION = "20260906T1200_sess1";
const MAIN_RELPATH = `${SESSION}.jsonl`;

function chunkAt(offset: number, generation: number, content: string, eof = false): LogChunk {
	const bytes = Buffer.from(content, "utf8");
	return { offset, generation, data: bytes.toString("base64"), eof };
}

function ingestAcked(
	store: FleetLogStore,
	workspace: string,
	session: string,
	relpath: string,
	chunk: LogChunk,
): number {
	const result = store.ingest(workspace, session, relpath, chunk);
	if (result.status !== "acked") throw new Error(`ingest not acked: ${result.status}`);
	return result.offset;
}

/** A minimal structurally-plausible main JSONL body (title + header + msg). */
function sessionBody(id: string): string {
	const title = JSON.stringify({
		type: "title",
		title: "Wake me",
		updatedAt: "2026-09-06T12:00:00.000Z",
		pad: "",
	});
	const header = JSON.stringify({ type: "session", id, cwd: "/srv/proj" });
	const msg = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } });
	return `${title}\n${header}\n${msg}\n`;
}

/** Seed a store with one main session (and an advisor artifact). */
function seedStore(rootDir: string, extra = ""): FleetLogStore {
	const store = new FleetLogStore({ rootDir });
	const body = sessionBody(SESSION) + extra;
	const o1 = ingestAcked(store, WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, body, true));
	expect(o1).toBe(body.length);
	return store;
}

// ---------------------------------------------------------------------------
// 1-3: wake-materialize helper semantics (pure, no fleet boot)
// ---------------------------------------------------------------------------

describe("fleet/wake-materialize", () => {
	test("fill-missing-only: writes cold files, NEVER clobbers newer volume bytes", () => {
		const rootDir = join(fleetPaths("omp-wake-fill-").tmp, "logs");
		const store = seedStore(rootDir);
		const volume = join(rootDir, "..", "volume", ".home", "agent", "sessions");
		mkdirSync(volume, { recursive: true });
		// The volume has a NEWER main (longer, unacked tail): must survive.
		const newer =
			sessionBody(SESSION) +
			'{"type":"message","message":{"role":"user","content":"newer tail"}}\n';
		writeFileSync(join(volume, MAIN_RELPATH), newer);

		const out = materializeMissingSessionFiles({
			store,
			workspaceId: WS,
			sessionId: SESSION,
			sessionsDir: volume,
		});
		expect(out.mainPresent).toBe(true);
		// Main was warm → NOT overwritten; nothing written for it.
		expect(readFileSync(join(volume, MAIN_RELPATH), "utf8")).toBe(newer);
		expect(out.written).toBe(0);
	});

	test("cold volume: fills the stored main from the store", () => {
		const paths = fleetPaths("omp-wake-cold-");
		const store = seedStore(join(paths.tmp, "logs"));
		const volume = join(paths.tmp, "volume", ".home", "agent", "sessions");
		mkdirSync(volume, { recursive: true });

		const out = materializeMissingSessionFiles({
			store,
			workspaceId: WS,
			sessionId: SESSION,
			sessionsDir: volume,
		});
		expect(out.written).toBe(1);
		expect(out.mainPresent).toBe(true);
		expect(readFileSync(join(volume, MAIN_RELPATH), "utf8")).toBe(sessionBody(SESSION));
	});

	test("hostile stored relpath aborts typed invalid_request", () => {
		const paths = fleetPaths("omp-wake-hostile-");
		const rootDir = join(paths.tmp, "logs");
		const store = new FleetLogStore({ rootDir });
		ingestAcked(store, WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, sessionBody(SESSION), true));
		// Plant a traversal-shaped file in the store tree directly.
		const escapeRel = "../../escape.jsonl";
		// FleetLogStore rejects traversal at ingest; simulate by a store whose
		// storedLineage returns a hostile relpath via a structural stub.
		const hostile = {
			storedLineage: (w: string, s: string) =>
				w === WS && s === SESSION
					? {
							sessionId: SESSION,
							files: [
								{ relpath: MAIN_RELPATH, status: "stored" as const },
								{ relpath: escapeRel, status: "stored" as const },
							],
							mainRelpath: MAIN_RELPATH,
						}
					: null,
			readStored: (w: string, s: string, rel: string) =>
				Buffer.from(rel === MAIN_RELPATH ? sessionBody(SESSION) : "pwn", "utf8"),
		};
		const volume = join(paths.tmp, "volume", "sessions");
		mkdirSync(volume, { recursive: true });
		expect(() =>
			materializeMissingSessionFiles({
				store: hostile,
				workspaceId: WS,
				sessionId: SESSION,
				sessionsDir: volume,
			}),
		).toThrow(WakeMaterializeError);
		try {
			materializeMissingSessionFiles({
				store: hostile,
				workspaceId: WS,
				sessionId: SESSION,
				sessionsDir: volume,
			});
		} catch (err) {
			expect(err).toBeInstanceOf(WakeMaterializeError);
			expect((err as WakeMaterializeError).code).toBe("invalid_request");
		}
		// The escape file never landed.
		expect(existsSync(join(volume, "..", "escape.jsonl"))).toBe(false);
	});

	test("unknown session → typed unavailable", () => {
		const paths = fleetPaths("omp-wake-missing-");
		const store = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		const volume = join(paths.tmp, "sessions");
		mkdirSync(volume, { recursive: true });
		try {
			materializeMissingSessionFiles({
				store,
				workspaceId: WS,
				sessionId: "nope",
				sessionsDir: volume,
			});
			throw new Error("expected WakeMaterializeError");
		} catch (err) {
			expect(err).toBeInstanceOf(WakeMaterializeError);
			expect((err as WakeMaterializeError).code).toBe("unavailable");
		}
	});

	test("resolveMainSessionFile finds depth-1 and depth-2 mains; pickNewest union", () => {
		const paths = fleetPaths("omp-wake-pick-");
		const sessions = join(paths.tmp, "sessions");
		mkdirSync(join(sessions, "proj"), { recursive: true });
		writeFileSync(join(sessions, `${SESSION}.jsonl`), sessionBody(SESSION));
		expect(resolveMainSessionFile(sessions, SESSION)).toBe(join(sessions, `${SESSION}.jsonl`));
		expect(resolveMainSessionFile(sessions, "absent")).toBeNull();
		// Depth 2 (project dir).
		const s2 = `${SESSION}_proj`;
		writeFileSync(join(sessions, "proj", `${s2}.jsonl`), sessionBody(s2));
		expect(resolveMainSessionFile(sessions, s2)).toBe(join(sessions, "proj", `${s2}.jsonl`));

		// Newest by mtime: bump s2 later.
		const older = new Date(Date.now() - 60_000);
		writeFileSync(join(sessions, "proj", `${s2}.jsonl`), sessionBody(s2));
		utimesSync(join(sessions, `${SESSION}.jsonl`), older, older);
		utimesSync(join(sessions, "proj", `${s2}.jsonl`), new Date(), new Date());
		const pick = pickNewestSessionId({ sessionsDir: sessions });
		expect(pick).toBe(s2);
	});
});

// ---------------------------------------------------------------------------
// 4-6: lifecycle wake resume + resume-clone route (fleet boot, fake provider)
// ---------------------------------------------------------------------------

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
 * Fake provider that always reports running; records each request's
 * workspaceDir/generation into `<stateDir>/ops.jsonl`. ensure-running also
 * mirrors the callback-env.json it would consume into
 * `<stateDir>/env-seen.json` so tests can assert the resume handoff.
 */
function writeFakeProvider(dir: string): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation, handle: req.handle ?? null }) + "\\n");
if (op === "ensure-running") {
  try {
    const envFile = join(req.stateDir, "callback-env.json");
    if (existsSync(envFile)) writeFileSync(join(req.stateDir, "env-seen.json"), readFileSync(envFile, "utf8"));
  } catch {}
  console.log(JSON.stringify({ ok: true, handle: "h", observed: "running", pid: 4242 }));
} else if (op === "inspect") {
  console.log(JSON.stringify({ ok: true, handle: req.handle ?? "h", observed: "running", pid: 4242 }));
} else if (op === "stop") {
  console.log(JSON.stringify({ ok: true, handle: req.handle ?? "h", observed: "stopped" }));
} else {
  console.log(JSON.stringify({ ok: true, handle: req.handle ?? "h", observed: "missing" }));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

function envSeen(workspaceDir: string, daemonId: string): { env?: Record<string, string> } | null {
	try {
		return JSON.parse(
			readFileSync(join(workspaceDir, ".provider-state", daemonId, "env-seen.json"), "utf8"),
		) as { env?: Record<string, string> };
	} catch {
		return null;
	}
}

interface Booted {
	server: FleetServer;
	paths: FleetPaths;
	workspaceDir: string;
	repoDir: string;
}

async function bootFleet(profile: "bwrap" | "k8s" = "bwrap"): Promise<Booted> {
	const paths = fleetPaths("omp-recovery-wake-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const provider = writeFakeProvider(join(paths.tmp, "provider"));
	const providerProfiles =
		profile === "bwrap"
			? { local: { id: "local", provider: "bwrap", executable: provider, tools: [] } }
			: {
					local: {
						id: "local",
						provider: "kubernetes",
						executable: provider,
						tools: [],
						image: "example.invalid/runtime:latest",
						namespace: "test",
					},
				};
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{ workspaceDir, providerProfiles },
		{ workspaceDir },
	);
	return { server, paths, workspaceDir, repoDir };
}

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

describe("clone wake resume (P8.9)", () => {
	test(
		"explicit resumeSessionId wake materializes the stored transcript and writes OMP_SESSION_RESUME",
		async () => {
			const { server, paths, workspaceDir, repoDir } = await bootFleet();
			try {
				const daemonId = await createClone(server, repoDir, "wake-resume");
				// Populate the fleet store for this workspace as if a prior
				// lifetime streamed a session. The fleet store lives next to
				// the state file under dirname(statePath)/logs.
				const storeRoot = join(paths.statePath, "..", "logs");
				const store = new FleetLogStore({ rootDir: storeRoot });
				ingestAcked(
					store,
					daemonId,
					SESSION,
					MAIN_RELPATH,
					chunkAt(0, 1, sessionBody(SESSION), true),
				);

				// Explicit wake with the store-validated session id, the
				// same call the edge's spawn_resume makes after membership
				// validation. The /ctl/start route intentionally takes only
				// daemonId (implicit wake); the explicit id rides the
				// lifecycle call the edge owns.
				await (
					server as FleetServer & {
						lifecycle: {
							ensureCloneRunning(d: string, o?: { resumeSessionId?: string }): Promise<void>;
						};
					}
				).lifecycle.ensureCloneRunning(daemonId, { resumeSessionId: SESSION });

				// Volume got the materialized main file.
				const volumeMain = join(workspaceDir, daemonId, ".home", "agent", "sessions", MAIN_RELPATH);
				expect(existsSync(volumeMain)).toBe(true);
				expect(readFileSync(volumeMain, "utf8")).toBe(sessionBody(SESSION));
				// The provider observed OMP_SESSION_RESUME in the handoff.
				const seen = envSeen(workspaceDir, daemonId);
				expect(seen).not.toBeNull();
				expect(seen?.env?.OMP_SESSION_RESUME).toBe(volumeMain);
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"never-started clone wake writes NO resume env (fresh boot)",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet();
			try {
				const daemonId = await createClone(server, repoDir, "fresh");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const seen = envSeen(workspaceDir, daemonId);
				expect(seen?.env?.OMP_SESSION_RESUME).toBeUndefined();
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"k8s-shaped profile wake writes NO resume env",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet("k8s");
			try {
				const daemonId = await createClone(server, repoDir, "k8s-wake");
				const start = await postJson(server.port, "/ctl/start", { daemonId });
				expect(start.status).toBe(200);
				const seen = envSeen(workspaceDir, daemonId);
				expect(seen?.env?.OMP_SESSION_RESUME).toBeUndefined();
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);
});

describe("resume-onto-fresh-clone route (P8.10)", () => {
	test("live workspace → 409 (applies only to deleted workspaces)", async () => {
		const { server, repoDir } = await bootFleet();
		try {
			const daemonId = await createClone(server, repoDir, "live-rc");
			const res = await postJson(server.port, `/ctl/workspaces/${daemonId}/resume-clone`, {
				sessionId: SESSION,
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { error?: string };
			expect(body.error ?? "").toContain("still registered");
		} finally {
			await server.close();
		}
	});

	test("deleted workspace with no provenance → 404", async () => {
		const { server, repoDir } = await bootFleet();
		try {
			const daemonId = await createClone(server, repoDir, "gone-rc");
			// Evict without a store subtree and without an orphan marker:
			// no provenance → the route cannot resume.
			server.registry.remove(daemonId);
			const res = await postJson(server.port, `/ctl/workspaces/${daemonId}/resume-clone`, {
				sessionId: SESSION,
			});
			expect(res.status).toBe(404);
		} finally {
			await server.close();
		}
	});

	test("deleted workspace with provenance but no provider hook → 503 typed (P5 gate)", async () => {
		const { server, repoDir } = await bootFleet();
		try {
			const daemonId = await createClone(server, repoDir, "orphan-rc");
			// Seed the store subtree for this workspace, then mark the orphan
			// WITH provenance (the registry captures source + pinnedRevision
			// from the still-present record at mark time) and evict.
			const storeRoot = join(server.fleetFacts.statePath, "..", "logs");
			const store = new FleetLogStore({ rootDir: storeRoot });
			ingestAcked(
				store,
				daemonId,
				SESSION,
				MAIN_RELPATH,
				chunkAt(0, 1, sessionBody(SESSION), true),
			);
			server.registry.markStoreOrphan(daemonId, "test orphan");
			server.registry.remove(daemonId);

			const res = await postJson(server.port, `/ctl/workspaces/${daemonId}/resume-clone`, {
				sessionId: SESSION,
			});
			// With no cloneResumeSpawner wired the route fails typed 503
			// (P5), never a fake spawn.
			expect(res.status).toBe(503);
			const body = (await res.json()) as { error?: string };
			expect(body.error ?? "").toContain("no clone provider is configured");
		} finally {
			await server.close();
		}
	});
});
