/**
 * Wake-from-store / resume recovery regressions (clone-plan P8.4/P8.9/P8.10;
 * docs/clone-contracts.md "Wake"). Deliberately narrow deterministic tests
 * over the uncertain boundaries this lane introduced — NOT a lifecycle
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
 *     profile) — checked via the callback-env handoff the fake provider
 *     records; a never-started clone wake writes NO resume env.
 *  5. REQUIRED resume (kubernetes): the PVC is not fleet-readable, so the
 *     fleet hands the IN-POD main file plus OMP_SESSION_RESUME_REQUIRED=1 —
 *     either the in-pod path a previous daemon lifetime recorded, or the
 *     store's validated main relpath mapped under the in-pod sessions root.
 *     An assets-only history (no main anywhere) is typed `unavailable`
 *     BEFORE any provider operation runs, never a silent fresh boot — and
 *     so is an explicit target that exists nowhere on a bwrap volume.
 *  6. resume-onto-fresh-clone route keeps 404 (no provenance) / 409 (live
 *     workspace or no transcripts) / 503 (no provider hook, P5) after the
 *     shared-helper refactor.
 *  7. Stored-main availability (P5 wake review): a warm volume with no store
 *     lineage succeeds with zero writes; a fill that ends without a real
 *     main is typed `unavailable` even when assets were written; a newer
 *     assets-only/empty-main lineage never outranks an older resumable one
 *     (using the accurate file mtime); history with no usable main is typed
 *     `unavailable` instead of a silent fresh boot, while genuine absence
 *     still returns undefined. FleetLogStore.onStoredChange notifies after
 *     durable ingest/purge only.
 *
 * Provider fakes speak OMP_PROVIDER_PROTO = 2: they abort unless the request
 * carries `providerProto` (and, for kubernetes, the resource binding), and
 * every response carries `providerProto` + `handle` + `observed`.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
import { CloneLifecycleError } from "./workspace-lifecycle";
import {
	WakeMaterializeError,
	materializeMissingSessionFiles,
	pickNewestSessionId,
	resolveMainSessionFile,
} from "./wake-materialize";

afterAll(cleanupTempDirs);
afterEach(restoreEnv);

await pinSettingsInMemory();

const WS = "d1";
const SESSION = "20260906T1200_sess1";
const MAIN_RELPATH = `${SESSION}.jsonl`;
/** In-pod sessions root a kubernetes resume hint must name (Runtime contract). */
const KUBE_SESSIONS_ROOT = "/workspace/.home/agent/sessions";
/** Fleet callback origin a kubernetes profile accepts (https, non-loopback). */
const KUBE_CALLBACK_URL = "https://fleet.example.invalid";
/** Remote source the fleet pins; git rewrites it to the local fixture repo. */
const KUBE_REMOTE = "https://example.invalid/omp/repo.git";

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
// Stored-main availability: warm-without-lineage, unusable-history refusal,
// and newest-usable selection (P5 wake review).
// ---------------------------------------------------------------------------

describe("fleet/wake-materialize stored-main availability", () => {
	test("warm volume with NO store lineage succeeds with zero writes", () => {
		const paths = fleetPaths("omp-wake-warm-nolineage-");
		const store = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		const volume = join(paths.tmp, "volume", ".home", "agent", "sessions");
		mkdirSync(volume, { recursive: true });
		const body = sessionBody(SESSION);
		writeFileSync(join(volume, MAIN_RELPATH), body);

		const out = materializeMissingSessionFiles({
			store,
			workspaceId: WS,
			sessionId: SESSION,
			sessionsDir: volume,
		});
		// No restoration needed and nothing to restore from: success, no writes.
		expect(out).toEqual({ written: 0, bytes: 0, mainPresent: true });
		expect(readFileSync(join(volume, MAIN_RELPATH), "utf8")).toBe(body);
	});

	test("cold completion with no real main throws unavailable even if assets wrote", () => {
		const paths = fleetPaths("omp-wake-phantom-main-");
		// A lineage that CLAIMS a stored non-empty main but cannot produce its
		// bytes (the store/read disagreement the post-fill check defends).
		const phantom = {
			storedLineage: (_w: string, _s: string) => ({
				sessionId: SESSION,
				files: [
					{ relpath: MAIN_RELPATH, status: "stored" as const, bytes: 10 },
					{ relpath: "artifact.log", status: "stored" as const, bytes: 6 },
				],
				mainRelpath: MAIN_RELPATH,
			}),
			readStored: (_w: string, _s: string, rel: string) =>
				rel === MAIN_RELPATH ? null : Buffer.from("asset\n", "utf8"),
		};
		const volume = join(paths.tmp, "volume", "sessions");
		mkdirSync(volume, { recursive: true });

		let code: string | undefined;
		try {
			materializeMissingSessionFiles({
				store: phantom,
				workspaceId: WS,
				sessionId: SESSION,
				sessionsDir: volume,
			});
		} catch (err) {
			code = err instanceof WakeMaterializeError ? err.code : undefined;
		}
		expect(code).toBe("unavailable");
		// The asset WAS written before the refusal; no main landed, so the
		// caller never sees a false resumable success.
		expect(existsSync(join(volume, "artifact.log"))).toBe(true);
		expect(resolveMainSessionFile(volume, SESSION)).toBeNull();
	});

	test("empty indexed main plus a stored asset is refused (assets cannot fake a main)", () => {
		const paths = fleetPaths("omp-wake-empty-main-");
		const store = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		ingestAcked(store, WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, "", true));
		ingestAcked(store, WS, SESSION, "artifact.log", chunkAt(0, 1, "asset\n", true));
		const volume = join(paths.tmp, "volume", "sessions");
		mkdirSync(volume, { recursive: true });

		let code: string | undefined;
		try {
			materializeMissingSessionFiles({
				store,
				workspaceId: WS,
				sessionId: SESSION,
				sessionsDir: volume,
			});
		} catch (err) {
			code = err instanceof WakeMaterializeError ? err.code : undefined;
		}
		expect(code).toBe("unavailable");
		expect(resolveMainSessionFile(volume, SESSION)).toBeNull();
	});

	test("newer unusable stored lineage never outranks older resumable history", () => {
		const paths = fleetPaths("omp-wake-newest-usable-");
		const rootDir = join(paths.tmp, "logs");
		const store = new FleetLogStore({ rootDir });
		const OLD = "20260901T0000_old";
		const NEW_ASSETS = "20260902T0000_assets";
		const NEW_EMPTY = "20260903T0000_empty";
		ingestAcked(store, WS, OLD, `${OLD}.jsonl`, chunkAt(0, 1, sessionBody(OLD), true));
		// Newer lineage with an asset but no main file at all.
		ingestAcked(store, WS, NEW_ASSETS, "artifact.log", chunkAt(0, 1, "asset\n", true));
		// Newest lineage whose indexed main is empty (not resumable).
		ingestAcked(store, WS, NEW_EMPTY, `${NEW_EMPTY}.jsonl`, chunkAt(0, 1, "", true));

		const older = new Date(Date.now() - 60_000);
		const newer = new Date(Date.now() + 60_000);
		utimesSync(join(rootDir, WS, OLD, `${OLD}.jsonl`), older, older);
		utimesSync(join(rootDir, WS, NEW_ASSETS, "artifact.log"), newer, newer);
		utimesSync(join(rootDir, WS, NEW_EMPTY, `${NEW_EMPTY}.jsonl`), newer, newer);

		// Store-only selection uses the accurate latest FILE mtime, not the
		// directory mtime (which the later ingests would have made newest).
		const lineage = store.storedLineage(WS, OLD);
		expect(lineage).not.toBeNull();
		expect(Math.abs((lineage?.mtimeMs ?? 0) - older.getTime())).toBeLessThan(5);

		const volume = join(paths.tmp, "volume", "sessions");
		mkdirSync(volume, { recursive: true });
		expect(pickNewestSessionId({ sessionsDir: volume, store, workspaceId: WS })).toBe(OLD);

		// A warm volume main stays a candidate even when the store history is
		// entirely unusable.
		const VOL = "20260904T0000_volume";
		const volumeMain = join(volume, `${VOL}.jsonl`);
		writeFileSync(volumeMain, sessionBody(VOL));
		expect(pickNewestSessionId({ sessionsDir: volume, store, workspaceId: WS })).toBe(VOL);
	});

	test("history with no usable main throws unavailable; genuine absence stays fresh", () => {
		const paths = fleetPaths("omp-wake-unusable-history-");
		const store = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		ingestAcked(store, WS, SESSION, "artifact.log", chunkAt(0, 1, "asset\n", true));
		const volume = join(paths.tmp, "volume", "sessions");
		mkdirSync(volume, { recursive: true });

		let code: string | undefined;
		try {
			pickNewestSessionId({ sessionsDir: volume, store, workspaceId: WS });
		} catch (err) {
			code = err instanceof WakeMaterializeError ? err.code : undefined;
		}
		expect(code).toBe("unavailable");

		// No history anywhere: a never-started clone boots fresh (undefined).
		const empty = new FleetLogStore({ rootDir: join(paths.tmp, "logs-empty") });
		expect(
			pickNewestSessionId({ sessionsDir: volume, store: empty, workspaceId: WS }),
		).toBeUndefined();
		expect(pickNewestSessionId({ sessionsDir: volume })).toBeUndefined();
	});
});

describe("FleetLogStore.onStoredChange", () => {
	test("notifies after durable ingest/purge, isolates listener errors, unsubscribes", () => {
		const paths = fleetPaths("omp-wake-stored-change-");
		const store = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		const seen: string[] = [];
		const off = store.onStoredChange((ws) => {
			seen.push(ws);
			throw new Error("listener must not break the store");
		});

		const body = sessionBody(SESSION);
		ingestAcked(store, WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, body, true));
		expect(seen).toEqual([WS]);

		// A no-op resend changes no stored bytes: no notification.
		expect(store.ingest(WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, body, true)).status).toBe(
			"duplicate",
		);
		expect(seen).toEqual([WS]);

		expect(store.purgeSession(WS, SESSION)).toBe(true);
		expect(seen).toEqual([WS, WS]);
		expect(store.purgeSession(WS, SESSION)).toBe(false); // Nothing removed.
		expect(seen).toEqual([WS, WS]);

		off();
		ingestAcked(store, WS, SESSION, MAIN_RELPATH, chunkAt(0, 1, body, true));
		expect(seen).toEqual([WS, WS]);
	});
});

// ---------------------------------------------------------------------------
// 4-6: lifecycle wake resume + resume-clone route (fleet boot, fake provider)
// ---------------------------------------------------------------------------

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
 * Fake bwrap provider that always reports running; records each request's
 * op/generation/providerProto into `<stateDir>/ops.jsonl` and aborts unless
 * the request carries OMP_PROVIDER_PROTO = 2. ensure-running also mirrors
 * the callback-env.json it would consume into `<stateDir>/env-seen.json` so
 * tests can assert the resume handoff.
 */
function writeFakeProvider(dir: string): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
if (req.providerProto !== 2) {
  console.error("provider request proto " + JSON.stringify(req.providerProto));
  process.exit(3);
}
mkdirSync(req.stateDir, { recursive: true });
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation, providerProto: req.providerProto, kubernetes: req.kubernetes ?? null }) + "\\n");
if (op === "ensure-running") {
  try {
    const envFile = join(req.stateDir, "callback-env.json");
    if (existsSync(envFile)) writeFileSync(join(req.stateDir, "env-seen.json"), readFileSync(envFile, "utf8"));
  } catch {}
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: "h", observed: "running", pid: 4242 }));
} else if (op === "inspect") {
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: req.handle ?? "h", observed: "running", pid: 4242 }));
} else if (op === "stop") {
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: req.handle ?? "h", observed: "stopped" }));
} else {
  console.log(JSON.stringify({ ok: true, providerProto: 2, handle: req.handle ?? "h", observed: "missing" }));
}
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/**
 * Fake kubernetes provider: same recording contract as the bwrap fake plus
 * the required resource binding, and every successful response echoes the
 * binding's namespace uid alongside the observed Pod/PVC uids.
 */
function writeKubeProvider(dir: string): string {
	const executable = join(dir, "fake-kube-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation, providerProto: req.providerProto, kubernetes: req.kubernetes }) + "\\n");
const ok = (observed) => JSON.stringify({
  ok: true,
  providerProto: 2,
  handle: "pod:" + req.workspaceId,
  observed,
  kubernetes: { namespaceUid: req.kubernetes.namespaceUid, podUid: "pod-uid-1", pvcUid: "pvc-uid-1" },
});
if (op === "ensure-running") {
  try {
    const envFile = join(req.stateDir, "callback-env.json");
    if (existsSync(envFile)) writeFileSync(join(req.stateDir, "env-seen.json"), readFileSync(envFile, "utf8"));
  } catch {}
  console.log(ok("running"));
} else if (op === "inspect") {
  console.log(ok("running"));
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

/** Fake fleet-side kubectl: reports one namespace API uid for the binding. */
function writeFakeKubectl(dir: string): string {
	const executable = join(dir, "kubectl");
	mkdirSync(dir, { recursive: true });
	writeFileSync(executable, '#!/usr/bin/env bun\nconsole.log("ns-uid-0001");\n');
	chmodSync(executable, 0o755);
	return executable;
}

interface RecordedOp {
	op: string;
	generation: number;
	providerProto: number;
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

function envSeen(stateDir: string): { env?: Record<string, string> } | null {
	try {
		return JSON.parse(readFileSync(join(stateDir, "env-seen.json"), "utf8")) as {
			env?: Record<string, string>;
		};
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

async function bootFleet(): Promise<Booted> {
	const paths = fleetPaths("omp-recovery-wake-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	const provider = writeFakeProvider(join(paths.tmp, "provider"));
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			workspaceDir,
			providerProfiles: {
				local: { id: "local", provider: "bwrap", executable: provider, tools: [] },
			},
		},
		{ workspaceDir },
	);
	return { server, paths, workspaceDir, repoDir };
}

/**
 * Boot a fleet whose "local" profile is a kubernetes provider: a fake kubectl
 * answers the fleet-side namespace-uid resolution, the callback URL is a
 * kubernetes-acceptable https origin, and git rewrites the remote source to a
 * real local repo so pin resolution stays offline.
 */
async function bootKubernetesFleet(): Promise<Booted> {
	const paths = fleetPaths("omp-recovery-wake-kube-");
	const workspaceDir = join(paths.tmp, "workspaces");
	const repoDir = join(paths.tmp, "repo");
	await makeRepo(repoDir);
	setEnv("OMP_KUBE_BIN", writeFakeKubectl(join(paths.tmp, "bin")));
	setEnv("OMP_FLEET_CALLBACK_URL", KUBE_CALLBACK_URL);
	setEnv("GIT_CONFIG_COUNT", "1");
	setEnv("GIT_CONFIG_KEY_0", `url.file://${repoDir}.insteadOf`);
	setEnv("GIT_CONFIG_VALUE_0", KUBE_REMOTE);
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			workspaceDir,
			providerProfiles: {
				local: {
					id: "local",
					provider: "kubernetes",
					executable: writeKubeProvider(join(paths.tmp, "provider")),
					tools: [],
					image: "example.invalid/runtime:latest",
					namespace: "test-ns",
					context: "test-ctx",
				},
			},
		},
		{ workspaceDir },
	);
	return { server, paths, workspaceDir, repoDir };
}

/** The provider state dir a kubernetes workspace's resource identity owns. */
function kubeStateDir(workspaceDir: string, server: FleetServer, daemonId: string): string {
	const binding = server.registry.get(daemonId)?.workspace?.kubernetes;
	if (binding === undefined) throw new Error(`${daemonId} has no persisted kubernetes binding`);
	return join(workspaceDir, ".kubernetes", binding.resourceIdentity);
}

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

				// Explicit wake with the store-validated session id — the
				// same call the edge's spawn_resume makes after membership
				// validation. The /ctl/start route intentionally takes only
				// daemonId (implicit wake); the explicit id rides the
				// lifecycle call the edge owns.
				await server.lifecycle.ensureCloneRunning(daemonId, { resumeSessionId: SESSION });

				// Volume got the materialized main file.
				const volumeMain = join(workspaceDir, daemonId, ".home", "agent", "sessions", MAIN_RELPATH);
				expect(existsSync(volumeMain)).toBe(true);
				expect(readFileSync(volumeMain, "utf8")).toBe(sessionBody(SESSION));
				// The provider observed OMP_SESSION_RESUME in the handoff.
				const seen = envSeen(join(workspaceDir, ".provider-state", daemonId));
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
				const seen = envSeen(join(workspaceDir, ".provider-state", daemonId));
				expect(seen?.env?.OMP_SESSION_RESUME).toBeUndefined();
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);
});

describe("required resume (kubernetes wake resume)", () => {
	test(
		"a recorded in-pod transcript resolves and is handed to the daemon as required",
		async () => {
			const { server, workspaceDir, repoDir } = await bootKubernetesFleet();
			try {
				const daemonId = await createClone(server, repoDir, "kube-recorded", {
					remote: KUBE_REMOTE,
				});
				// A previous daemon lifetime reported its in-pod main file.
				const inPodMain = `${KUBE_SESSIONS_ROOT}/${MAIN_RELPATH}`;
				server.registry.update(daemonId, { lastSessionFile: inPodMain });

				await server.lifecycle.ensureCloneRunning(daemonId, { resumeSessionId: SESSION });

				const seen = envSeen(kubeStateDir(workspaceDir, server, daemonId));
				expect(seen?.env?.OMP_SESSION_RESUME).toBe(inPodMain);
				expect(seen?.env?.OMP_SESSION_RESUME_REQUIRED).toBe("1");
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a store-only main resolves to the in-pod restore target for the daemon",
		async () => {
			const { server, paths, workspaceDir, repoDir } = await bootKubernetesFleet();
			try {
				const daemonId = await createClone(server, repoDir, "kube-store", {
					remote: KUBE_REMOTE,
				});
				const store = new FleetLogStore({ rootDir: join(paths.statePath, "..", "logs") });
				ingestAcked(
					store,
					daemonId,
					SESSION,
					MAIN_RELPATH,
					chunkAt(0, 1, sessionBody(SESSION), true),
				);

				await server.lifecycle.ensureCloneRunning(daemonId);

				const seen = envSeen(kubeStateDir(workspaceDir, server, daemonId));
				// The PVC is not fleet-readable: the fleet names the IN-POD
				// main file (never a fleet-host path) and marks the resume
				// required so the daemon restores it over the callback pair.
				expect(seen?.env?.OMP_SESSION_RESUME).toBe(`${KUBE_SESSIONS_ROOT}/${MAIN_RELPATH}`);
				expect(seen?.env?.OMP_SESSION_RESUME_REQUIRED).toBe("1");
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an assets-only history is typed unavailable before any compute starts",
		async () => {
			const { server, paths, workspaceDir, repoDir } = await bootKubernetesFleet();
			try {
				const daemonId = await createClone(server, repoDir, "kube-assets", {
					remote: KUBE_REMOTE,
				});
				// Store holds a session tree with an artifact but NO main
				// transcript: not resumable, and the fleet must say so BEFORE
				// any provider operation runs.
				const storeRoot = join(paths.statePath, "..", "logs");
				mkdirSync(join(storeRoot, daemonId, SESSION), { recursive: true });
				writeFileSync(join(storeRoot, daemonId, SESSION, "artifact.log"), "asset\n");
				const stateDir = kubeStateDir(workspaceDir, server, daemonId);

				let code: string | undefined;
				try {
					await server.lifecycle.ensureCloneRunning(daemonId, { resumeSessionId: SESSION });
				} catch (err) {
					code = err instanceof CloneLifecycleError ? err.code : undefined;
				}
				expect(code).toBe("unavailable");
				// No provider op ran and no generation was authorized: the
				// failure predates compute.
				expect(readOps(stateDir)).toHaveLength(0);
				expect(server.registry.get(daemonId)!.workspace?.authorizedGeneration).toBeUndefined();
			} finally {
				await server.close();
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"an explicit target that exists nowhere fails typed instead of booting fresh",
		async () => {
			const { server, workspaceDir, repoDir } = await bootFleet();
			try {
				const daemonId = await createClone(server, repoDir, "no-target");
				const stateDir = join(workspaceDir, ".provider-state", daemonId);

				let code: string | undefined;
				try {
					await server.lifecycle.ensureCloneRunning(daemonId, { resumeSessionId: SESSION });
				} catch (err) {
					code = err instanceof CloneLifecycleError ? err.code : undefined;
				}
				expect(code).toBe("unavailable");
				// No fresh boot was fabricated: no compute started and the
				// workspace is still the parked clone it was.
				expect(readOps(stateDir)).toHaveLength(0);
				const entry = server.registry.get(daemonId)!;
				expect(entry.workspace?.authorizedGeneration).toBeUndefined();
				expect(entry.workspace?.desiredState).toBe("stopped");
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
			// (P5) — never a fake spawn.
			expect(res.status).toBe(503);
		} finally {
			await server.close();
		}
	});
});
