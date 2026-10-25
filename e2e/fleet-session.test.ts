/**
 * Cross-app E2E: real fleet + real omp-session processes over the dial-out model.
 *
 * Boots a real fleet (startFleet from apps/fleet/server) on a loopback port
 * with tmp state + config, and spawns real omp-session processes through the
 * configured spawn templates (bun apps/session/index.ts). Every session dials
 * OUT to the fleet's callback pair (one WebSocket, /callback/ws); the fleet
 * never dials a session. The host runtime enrolls each launch (workspaceId ===
 * workspaceId, generation bumps per launch, credential on the --fleet-stdin payload,
 * digest persisted in entry.workspace.enrollment),
 * runs the child detached, and appends its output to
 * <state dir>/session-logs/<workspaceId>.log.
 *
 * Scenarios (serial, one shared fleet; scenario 4 closes and re-opens it):
 *  1. spawn three sessions; all reach ready once their pair forms; prompt each.
 *  2. SIGKILL one child: the host runtime relaunches it under a NEW enrollment
 *     generation; the old generation's credential is revoked (a redial with it
 *     is refused with 401/409).
 *  3. idle auto-exit → asleep (enrollment released); a prompt wakes it: the
 *     fanout respawns it under a new enrollment generation.
 *  4. closing the fleet does NOT kill sessions: the session keeps running; a new
 *     fleet on the same state/config/port re-enrolls the persisted digest at
 *     boot, the SAME process re-pairs and the entry returns to ready with no
 *     respawn, and a prompt still reaches it.
 *  5. POST /ctl/stop on that session makes the process exit and the entry asleep.
 *  6. a prompt on that stopped session wakes it: the respawn carries --resume <lastSessionFile>.
 *  7. a host-kind clone of a git repo (real omp-session, no sandbox): create through
 *     the control API, start, pair up to ready, stop, delete.
 *
 * Model determinism: every session runs with a fresh, empty PI_CODING_AGENT_DIR
 * and PI_AUTH_NO_BORROW=1, so no model is selectable and no live model or API
 * is ever touched. A prompt is accepted by the session, its turn can never
 * complete, and the fanout settles it on the /ctl/prompt waitMs timeout with
 * ok:false. The assertions cover the /ctl/prompt → fan-out → session dispatch
 * and the timeout correlation, not a model answer. Exactly seven prompts are
 * issued across the suite (d1, d2, d3, the external session, the woken idle
 * session, the re-adopted survivor, the survivor woken after its stop), and
 * the final assertion checks that count.
 *
 * Sessions are detached and outlive the fleet by design, so process hygiene is
 * explicit: every observed pid is tracked, and afterAll closes the fleet and
 * then SIGKILLs every session process whose command line names this suite's
 * tmp root, so nothing is left behind even when a test fails midway.
 *
 * The shortidle template pins the test-only OMP_SESSION_TEST_IDLE_CHECK_MS knob
 * (500ms idle-check tick; default 15s) so the idle lifecycle runs in seconds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import type { RosterEntry } from "#lib/wire/protocol";
import { startCallbackSession } from "../apps/fleet/test/callback-session.testkit";
import type { RegistryEntry } from "../apps/fleet/registry";
import { type FleetServer, startFleet } from "../apps/fleet/server";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { hermeticStatsConfig } from "./helpers.testkit";

afterAll(cleanupTempDirs);

const PROMPT_TEXT = "Reply with exactly: PONG";
const SESSION_ENTRY = "apps/session/index.ts";

// Provider API keys exported in the SHELL (a dev machine has e.g. KIMI_API_KEY)
// would give spawned sessions a live model and break the no-model determinism
// below. The scrub rides the spawn command line (`env -u KEY …`), and the
// externally launched session's env is filtered by the same key list.
const PROVIDER_ENV_KEYS = Object.keys(process.env).filter(
	(k) => k.endsWith("_API_KEY") || k.endsWith("_AUTH_TOKEN"),
);
const PROVIDER_ENV_SCRUB_STR = PROVIDER_ENV_KEYS.map((k) => `-u ${k}`).join(" ");
const PROVIDER_ENV_SCRUB = PROVIDER_ENV_SCRUB_STR === "" ? "" : `env ${PROVIDER_ENV_SCRUB_STR} `;

/**
 * Built in beforeAll because the paths derive from the suite tmp dir. {name}
 * and {resume} expand per session in the fleet templates. {fleet} expands
 * to --fleet-stdin: the host runtime writes the callback pair and listener token to
 * the child's stdin. Each template tees that payload to handoff-{name}.json (0600,
 * suite tmp dir) so the suite can read the enrolled credential without it ever
 * entering the session's environment or argv.
 */
let LOCAL_TEMPLATE = "";
let SHORTIDLE_TEMPLATE = "";

interface PromptResultWire {
	workspaceId: string;
	ok: boolean;
	text?: string;
	error?: string;
}

interface StopResponse {
	stopped: string[];
}

interface StateFile {
	entries: RegistryEntry[];
}

/** A live process whose command line names apps/session/index.ts and this suite's root. */
interface SessionProc {
	pid: number;
	args: string[];
}

/**
 * Real wall-clock waiting for OS processes. The sessions under test are separate
 * processes on the platform clock (idle timers, host restart backoff, the
 * redial after a fleet restart), so fake timers cannot drive them; waits poll
 * the observable status until it changes instead of guessing a duration.
 */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitUntil(
	cond: () => boolean | Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return;
		await sleep(60);
	}
	throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`);
}

/** Every process whose argv names the session entry point and `root`. */
function sessionProcs(root: string): SessionProc[] {
	const out: SessionProc[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let raw: string;
		try {
			raw = readFileSync(`/proc/${name}/cmdline`, "utf8");
		} catch {
			continue; // exited between readdir and read
		}
		const args = raw.split("\0");
		if (!args.includes(SESSION_ENTRY) || !raw.includes(root)) continue;
		out.push({ pid: Number(name), args });
	}
	return out;
}

/** True while `pid` is a live, non-zombie process. */
function isRunning(pid: number): boolean {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return false;
	}
	// The state field follows the parenthesised comm, which may itself contain ')'.
	const close = stat.lastIndexOf(")");
	return stat.slice(close + 2, close + 3) !== "Z";
}

function argAfter(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

describe("e2e: real fleet + real omp-session processes", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let projDirs: string[];
	let server!: FleetServer;
	/** Saved OMP_FLEET_* env, restored in afterAll (see the beforeAll scrub). */
	const savedFleetEnv: Record<string, string | undefined> = {};
	let d1!: RosterEntry;
	let d2!: RosterEntry;
	let d3!: RosterEntry;
	let d4!: RosterEntry;
	let survivor!: RosterEntry;
	/** Every session pid observed (spawn responses, /proc sweeps). */
	const trackedPids = new Set<number>();
	/** Prompts issued through the control plane (all settle ok:false, no live model). */
	let promptCount = 0;

	const base = (): string => `http://127.0.0.1:${server.port}`;

	function postJson(path: string, body: unknown): Promise<Response> {
		return fetch(`${base()}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function getEntry(id: string): Promise<RosterEntry | undefined> {
		const res = await fetch(`${base()}/ctl/sessions`);
		if (res.status !== 200) throw new Error(`GET /ctl/sessions → ${res.status}`);
		const entries = (await res.json()) as RosterEntry[];
		return entries.find((entry) => entry.workspaceId === id);
	}

	/** Privileged assertions read private workspace state from disk, never from HTTP. */
	function getPersistedEntry(id: string): RegistryEntry {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as StateFile;
		const entry = state.entries.find((entry) => entry.workspaceId === id);
		if (!entry) throw new Error(`session ${id} is absent from durable fleet state`);
		return entry;
	}

	/** The single live session process launched with `--name <name>` (the bun session, not the sh wrapper). */
	function sessionProc(name: string): SessionProc {
		const matches = sessionProcs(tmp).filter((p) => argAfter(p.args, "--name") === name);
		if (matches.length !== 1) {
			throw new Error(
				`expected exactly one live session process named ${name}, found ${matches.length}`,
			);
		}
		trackedPids.add(matches[0].pid);
		return matches[0];
	}

	/**
	 * Poll GET /ctl/sessions until `predicate` holds. An error status throws at
	 * once with the session's log tail; a timeout throws with the last status.
	 */
	async function waitForEntry(
		id: string,
		predicate: (entry: RosterEntry) => boolean,
		timeoutMs: number,
		what: string,
	): Promise<RosterEntry> {
		const deadline = Date.now() + timeoutMs;
		let last: RosterEntry | undefined;
		while (Date.now() < deadline) {
			last = await getEntry(id);
			if (last) {
				if (predicate(last)) return last;
				if (last.status === "error") {
					const tail = server.lifecycle.sessionLogTail(id);
					throw new Error(
						`session ${id} entered error: ${last.error ?? "unknown"}${tail ? `\nlog tail: ${tail.slice(-500)}` : ""}`,
					);
				}
			}
			await sleep(60);
		}
		const tail = server.lifecycle.sessionLogTail(id);
		throw new Error(
			`timed out waiting for ${id} to ${what} (${timeoutMs}ms); last status: ${last?.status ?? "absent"}${tail ? `\nlog tail: ${tail.slice(-500)}` : ""}`,
		);
	}

	/** One prompt through POST /ctl/prompt; every prompt settles ok:false (no model). */
	async function ctlPrompt(selector: string): Promise<PromptResultWire> {
		promptCount++;
		const res = await postJson("/ctl/prompt", { selector, text: PROMPT_TEXT, waitMs: 5_000 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as PromptResultWire[];
		expect(body).toHaveLength(1);
		return body[0];
	}

	beforeAll(async () => {
		if (!existsSync(join(process.cwd(), SESSION_ENTRY))) {
			throw new Error(
				"integration tests must run from the repo root: bun scripts/test.ts e2e/fleet-session.test.ts",
			);
		}
		tmp = tempDir("omp-web-integration-");
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		// Hermetic per-session agent dir ({name} expands per session): no auth and
		// no model cache, so no model is selectable and every prompt times out.
		const hermeticEnv = `${PROVIDER_ENV_SCRUB}PI_CODING_AGENT_DIR=${join(tmp, "agent-{name}")} PI_AUTH_NO_BORROW=1`;
		LOCAL_TEMPLATE = `umask 077; tee ${join(tmp, "handoff-{name}.json")} | ${hermeticEnv} bun ${SESSION_ENTRY} --cwd {cwd} --port 0 {fleet} --name {name} {resume}`;
		// Short-idle variant pins the test-only idle-check knob (500ms tick) so the
		// idle lifecycle runs in seconds.
		SHORTIDLE_TEMPLATE = `umask 077; tee ${join(tmp, "handoff-{name}.json")} | OMP_SESSION_TEST_IDLE_CHECK_MS=500 ${hermeticEnv} bun ${SESSION_ENTRY} --cwd {cwd} --port 0 {fleet} --name {name} --idle-timeout 2s {resume}`;
		const projectsRoot = join(tmp, "projects");
		projDirs = [
			join(projectsRoot, "proj-a"),
			join(projectsRoot, "proj-b"),
			join(projectsRoot, "proj-c"),
		];
		for (const dir of projDirs) mkdirSync(dir, { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				templates: {
					local: { command: LOCAL_TEMPLATE },
					shortidle: { command: SHORTIDLE_TEMPLATE },
				},
				defaultTemplate: "local",
				// The in-process host kind: clones run the real omp-session on this host, unsandboxed.
				providerProfiles: { host: { provider: "host" } },
			}),
		);
		// Hermetic against the dev-runner override: OMP_FLEET_* env replaces config
		// templates outright (config.ts), so a shell that ran `bun run dev` would
		// spawn sessions with the real agent dir and a live model. Cleared for the
		// suite's lifetime; restored in afterAll.
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("OMP_FLEET_")) {
				savedFleetEnv[key] = process.env[key];
				delete process.env[key];
			}
		}
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			statsConfig: hermeticStatsConfig(statePath),
		});
	});

	afterAll(async () => {
		for (const [key, value] of Object.entries(savedFleetEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// Close the fleet FIRST so no host restart races the kills below.
		// close() deliberately leaves sessions running, so they are reaped here.
		if (server !== undefined) await server.close();
		if (tmp === undefined) return;
		// Tracked pids plus a /proc sweep for any session naming this suite's tmp
		// root. A tracked pid is killed only while its command line still names
		// tmp, so a recycled pid is never hit.
		const doomed = new Set<number>(sessionProcs(tmp).map((p) => p.pid));
		for (const pid of trackedPids) {
			try {
				if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(tmp)) doomed.add(pid);
			} catch {
				// already gone
			}
		}
		for (const pid of doomed) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone
			}
		}
		await waitUntil(
			() => sessionProcs(tmp).every((p) => !isRunning(p.pid)),
			10_000,
			"sessions to exit",
		);
	});

	test("boots the control plane against a fresh tmp state", async () => {
		const res = await fetch(`${base()}/ctl/sessions`);
		expect(res.status).toBe(200);
		expect((await res.json()) as unknown[]).toEqual([]);
	});

	test("spawns three real sessions; all reach ready once their callback pair forms", async () => {
		const [r1, r2, r3] = await Promise.all([
			postJson("/ctl/spawn", { cwd: projDirs[0], name: "d-one" }),
			postJson("/ctl/spawn", { cwd: projDirs[1], name: "d-two" }),
			postJson("/ctl/spawn", { cwd: projDirs[2], name: "d-three" }),
		]);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(200);
		d1 = (await r1.json()) as RosterEntry;
		d2 = (await r2.json()) as RosterEntry;
		d3 = (await r3.json()) as RosterEntry;
		for (const entry of [d1, d2, d3]) {
			if (entry.pid !== undefined) trackedPids.add(entry.pid);
		}
		const [a, b, c] = await Promise.all([
			waitForEntry(d1.workspaceId, (e) => e.status === "ready", 60_000, "become ready"),
			waitForEntry(d2.workspaceId, (e) => e.status === "ready", 60_000, "become ready"),
			waitForEntry(d3.workspaceId, (e) => e.status === "ready", 60_000, "become ready"),
		]);
		// The host runtime enrolled each launch: workspaceId === the session id, first generation.
		for (const entry of [a, b, c]) {
			expect(entry.status).toBe("ready");
			const enrollment = getPersistedEntry(entry.workspaceId).workspace?.enrollment;
			expect(enrollment?.generation).toBe(1);
			expect(enrollment?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
		}
		// Each session records its session file once its pair forms.
		const withFiles = await Promise.all(
			[a, b, c].map((entry) =>
				waitForEntry(
					entry.workspaceId,
					(e) => e.status === "ready" && e.lastSessionFile !== undefined,
					30_000,
					"record its session file",
				),
			),
		);
		for (const entry of withFiles) expect(entry.lastSessionFile).toBeTruthy();
		// Each session is a detached process with its output under session-logs/.
		for (const [entry, name] of [
			[a, "d-one"],
			[b, "d-two"],
			[c, "d-three"],
		] as const) {
			sessionProc(name);
			expect(existsSync(join(tmp, "session-logs", `${entry.workspaceId}.log`))).toBe(true);
		}
	}, 90_000);

	test("prompts fan out to all three sessions; each settles ok:false (no selectable model)", async () => {
		const results: PromptResultWire[] = [];
		for (const entry of [d1, d2, d3]) results.push(await ctlPrompt(entry.workspaceId));
		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(result.error).toBeTruthy();
		}
	}, 90_000);

	test("SIGKILL one child: the host runtime relaunches it under a new generation; the old credential is refused", async () => {
		const before = (await getEntry(d2.workspaceId))!;
		const enrollmentBefore = getPersistedEntry(d2.workspaceId).workspace!.enrollment!;
		const oldProc = sessionProc("d-two");
		// The credential the old child dialed with, from the tee'd --fleet-stdin payload
		// (0600, suite tmp dir). The session's environment and argv must not carry it.
		const handoffFile = join(tmp, "handoff-d-two.json");
		expect(statSync(handoffFile).mode & 0o777).toBe(0o600);
		const handoff = JSON.parse(readFileSync(handoffFile, "utf8")) as {
			callback: { token: string };
		};
		const oldToken = handoff.callback.token;
		expect(oldToken).toMatch(/^[0-9a-f]{64}$/);
		const oldEnviron = readFileSync(`/proc/${oldProc.pid}/environ`, "utf8").split("\0");
		expect(
			oldEnviron.some(
				(e) => e.startsWith("OMP_SESSION_CALLBACK_") || e.startsWith("OMP_SESSION_TOKEN="),
			),
		).toBe(false);
		expect(readFileSync(`/proc/${oldProc.pid}/cmdline`, "utf8")).not.toContain(oldToken);
		process.kill(oldProc.pid, "SIGKILL");
		// The relaunch enrolls a new generation and returns to ready once its pair forms.
		await waitUntil(
			() =>
				(getPersistedEntry(d2.workspaceId).workspace?.enrollment?.generation ?? 0) >
				enrollmentBefore.generation,
			90_000,
			"persist a new enrollment generation",
		);
		const after = await waitForEntry(
			d2.workspaceId,
			(e) => e.status === "ready",
			90_000,
			"recover to ready under a new generation",
		);
		const enrollmentAfter = getPersistedEntry(d2.workspaceId).workspace!.enrollment!;
		expect(enrollmentAfter.generation).toBeGreaterThan(enrollmentBefore.generation);
		expect(enrollmentAfter.credentialHash).not.toBe(enrollmentBefore.credentialHash);
		// The new enrollment is persisted to state.json.
		expect(getPersistedEntry(d2.workspaceId).workspace?.enrollment).toEqual(enrollmentAfter);
		// The relaunched child is a new process.
		const relaunched = sessionProc("d-two");
		expect(relaunched.pid).not.toBe(oldProc.pid);
		// The relaunch resumes the durable session the old child was on.
		expect(before.lastSessionFile).toBeTruthy();
		expect(argAfter(relaunched.args, "--resume")).toBe(before.lastSessionFile);
		expect(after.lastSessionFile).toBe(before.lastSessionFile);
		// The old generation's credential is revoked: a redial with it is refused.
		const stale = startCallbackSession({
			url: base(),
			workspaceId: d2.workspaceId,
			generation: enrollmentBefore.generation,
			token: oldToken!,
		});
		try {
			await waitUntil(
				() => stale.rejection() !== null,
				10_000,
				"the stale credential to be refused",
			);
			const rejected = stale.rejection()!;
			expect([401, 409]).toContain(rejected.status);
			expect(stale.connected()).toBe(false);
		} finally {
			await stale.stop();
		}
	}, 120_000);

	test("short-idle session: idle exit → asleep (enrollment released)", async () => {
		const res = await postJson("/ctl/spawn", {
			cwd: projDirs[2],
			name: "d-four",
			template: "shortidle",
		});
		expect(res.status).toBe(200);
		d4 = (await res.json()) as RosterEntry;
		await waitForEntry(d4.workspaceId, (e) => e.status === "ready", 60_000, "become ready");
		const proc = sessionProc("d-four");
		// Idle exit runs when no browser stream and no in-flight bash/python is
		// active; the callback pair does not count. A clean exit is dormant: the
		// host runtime releases the credential and marks the entry asleep.
		const asleep = await waitForEntry(
			d4.workspaceId,
			(e) => e.status === "asleep",
			30_000,
			"go asleep after idle exit",
		);
		await waitUntil(() => !isRunning(proc.pid), 10_000, "the idle session process to exit");
		expect(asleep.cwd).toBe(projDirs[2]);
		expect(getPersistedEntry(d4.workspaceId).workspace?.enrollment).toBeUndefined();
	}, 90_000);

	test("asleep session wakes on a prompt: the fanout respawns it under a new generation", async () => {
		const before = (await getEntry(d4.workspaceId))!;
		const generationBefore = getPersistedEntry(d4.workspaceId).workspace?.authorizedGeneration ?? 0;
		// The prompt is the wake trigger: the fanout respawns the asleep spawned
		// session and waits for ready before sending the turn.
		const promise = ctlPrompt(d4.workspaceId);
		// Short-idle may exit the woken session again before the turn settles, so
		// capture its process while it is alive, from the moment the wake starts.
		let woken: SessionProc | undefined;
		await waitUntil(
			() => {
				woken = sessionProcs(tmp).find((p) => argAfter(p.args, "--name") === "d-four");
				return woken !== undefined;
			},
			30_000,
			"the woken d-four process",
		);
		trackedPids.add(woken!.pid);
		expect(before.lastSessionFile).toBeTruthy();
		expect(argAfter(woken!.args, "--resume")).toBe(before.lastSessionFile);
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		// The wake enrolled a new generation (monotonic across the idle exit).
		expect(getPersistedEntry(d4.workspaceId).workspace?.authorizedGeneration ?? 0).toBeGreaterThan(
			generationBefore,
		);
	}, 120_000);

	test("closing the fleet leaves the session running; a new fleet re-adopts the same process without a respawn", async () => {
		const res = await postJson("/ctl/spawn", { cwd: projDirs[0], name: "d-survivor" });
		expect(res.status).toBe(200);
		survivor = (await res.json()) as RosterEntry;
		await waitForEntry(survivor.workspaceId, (e) => e.status === "ready", 60_000, "become ready");
		const enrollmentBefore = getPersistedEntry(survivor.workspaceId).workspace!.enrollment!;
		const withFile = await waitForEntry(
			survivor.workspaceId,
			(e) => e.status === "ready" && e.lastSessionFile !== undefined,
			30_000,
			"record its session file",
		);
		const sessionFileBefore = withFile.lastSessionFile;
		expect(sessionFileBefore).toBeTruthy();
		const proc = sessionProc("d-survivor");
		const port = server.port;

		// close() no longer kills sessions: the session keeps running and redials.
		await server.close();
		expect(isRunning(proc.pid)).toBe(true);

		// A new fleet on the same state/config/port re-enrolls the persisted digest at
		// boot, so the session's original credential is accepted again.
		server = await startFleet({
			port,
			statePath,
			configPath,
			statsConfig: hermeticStatsConfig(statePath),
		});
		expect(server.port).toBe(port);
		const rejoined = await waitForEntry(
			survivor.workspaceId,
			(e) => e.status === "ready",
			60_000,
			"re-pair after the fleet restart",
		);
		// The SAME process re-paired: no respawn, no new generation.
		expect(isRunning(proc.pid)).toBe(true);
		expect(sessionProc("d-survivor").pid).toBe(proc.pid);
		expect(getPersistedEntry(survivor.workspaceId).workspace?.enrollment).toEqual(enrollmentBefore);
		expect(rejoined.lastSessionFile).toBe(sessionFileBefore);

		// It still takes a prompt through the new fleet's control plane.
		const result = await ctlPrompt(survivor.workspaceId);
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(sessionProc("d-survivor").pid).toBe(proc.pid);
		// Accounting: five prompts across the suite, all settled ok:false.
		expect(promptCount).toBe(5);
	}, 150_000);

	test("POST /ctl/stop makes the session exit and the entry asleep", async () => {
		const proc = sessionProc("d-survivor");
		const res = await postJson("/ctl/stop", { selector: survivor.workspaceId });
		expect(res.status).toBe(200);
		const stopBody = (await res.json()) as StopResponse;
		expect(stopBody.stopped).toEqual([survivor.workspaceId]);
		await waitUntil(() => !isRunning(proc.pid), 30_000, "the stopped session process to exit");
		const entry = (await getEntry(survivor.workspaceId))!;
		expect(entry.status).toBe("asleep");
		expect(getPersistedEntry(survivor.workspaceId).workspace?.enrollment).toBeUndefined();
		expect(sessionProcs(tmp).some((p) => argAfter(p.args, "--name") === "d-survivor")).toBe(false);
	}, 60_000);

	test("a prompt wakes the stopped session: the fanout respawns it with --resume its lastSessionFile", async () => {
		const stopped = (await getEntry(survivor.workspaceId))!;
		expect(stopped.status).toBe("asleep");
		const resumeFile = stopped.lastSessionFile;
		expect(resumeFile).toBeTruthy();
		const promise = ctlPrompt(survivor.workspaceId);
		let woken: SessionProc | undefined;
		await waitUntil(
			() => {
				woken = sessionProcs(tmp).find((p) => argAfter(p.args, "--name") === "d-survivor");
				return woken !== undefined;
			},
			30_000,
			"the woken d-survivor process",
		);
		trackedPids.add(woken!.pid);
		expect(argAfter(woken!.args, "--resume")).toBe(resumeFile);
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		// Accounting: this is the sixth prompt across the suite.
		expect(promptCount).toBe(6);
	}, 120_000);

	test("a host clone of a git repo runs the real omp-session: create, start, ready, stop, delete", async () => {
		const source = join(tmp, "host-clone-source");
		mkdirSync(source, { recursive: true });
		const git = (...args: string[]): void => {
			const proc = Bun.spawnSync(["git", "-C", source, ...args], { stderr: "pipe" });
			if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
		};
		git("init", "-q", "-b", "main");
		writeFileSync(join(source, "readme.md"), "hello\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");

		const registered = await postJson("/ctl/projects", { path: source });
		expect(registered.status).toBe(201);
		const { project } = (await registered.json()) as { project: { projectId: string } };
		const created = await postJson("/ctl/clones", {
			projectId: project.projectId,
			name: "host-clone",
			profileId: "host",
			start: true,
		});
		expect(created.status).toBe(201);
		const { entry } = (await created.json()) as { entry: RosterEntry };
		const persisted = getPersistedEntry(entry.workspaceId);
		const volume = persisted.cwd!;
		const checkout = join(volume, ".checkout");
		expect(existsSync(join(checkout, ".git"))).toBe(true);
		const stateDir = join(dirname(volume), ".provider-state", entry.workspaceId);
		const recorded = (): number =>
			(JSON.parse(readFileSync(join(stateDir, "provider.pid.json"), "utf8")) as { pid: number })
				.pid;
		try {
			// The real session dials out over the callback pair and the roster settles ready.
			await waitForEntry(
				entry.workspaceId,
				(e) => e.status === "ready" && e.lifecycleStage === "ready",
				60_000,
				"become ready",
			);
			const pid = recorded();
			trackedPids.add(pid);
			expect(isRunning(pid)).toBe(true);
			// The session runs in the clone's checkout with its home inside the volume.
			expect(readFileSync(`/proc/${pid}/cmdline`, "utf8")).toContain("--fleet-stdin");
			const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			expect(environ).toContain(`HOME=${join(volume, ".home")}`);
			expect(environ.some((line) => line.startsWith("OMP_SESSION_CALLBACK_"))).toBe(false);

			const stopped = await postJson("/ctl/stop", { selector: entry.workspaceId });
			expect(stopped.status).toBe(200);
			await waitUntil(() => !isRunning(pid), 30_000, "the host clone process to exit");
			expect(existsSync(checkout)).toBe(true);

			const removed = await fetch(`${base()}/ctl/worktrees/${entry.workspaceId}`, {
				method: "DELETE",
			});
			expect(removed.status).toBe(200);
			expect(existsSync(volume)).toBe(false);
			expect(await getEntry(entry.workspaceId)).toBeUndefined();
		} finally {
			// A failure midway must not leave the unsandboxed session behind.
			await postJson("/ctl/stop", { selector: entry.workspaceId }).catch(() => undefined);
		}
	}, 150_000);
});
