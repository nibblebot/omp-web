/**
 * Host clone workspaces (ys07): a clone whose session runs directly on the
 * fleet host through the in-process `host` provider kind, with no sandbox.
 *
 * Real fleet control plane (loopback HTTP), real git repos, and the real
 * provider ops of apps/fleet/host-clone-provider.ts launching a real detached
 * child. The child is a scripted stand-in for omp-session (selected through
 * OMP_RUNTIME_ENTRY, the same override operators use) that records the argv,
 * working directory and environment it was launched with, and writes a
 * transcript into the agent dir it was given. The real omp-session over a
 * real fleet is covered by e2e/fleet-session.test.ts.
 *
 * Covered: create + start from a local source and from a remote source,
 * the launch layout (cwd = checkout, HOME and agent dir inside the volume,
 * callback pair on stdin only, secretRefs resolved from the fleet env, no
 * ambient leakage), transcripts under the volume, stop with proof, wake
 * resume, the verified delete gate, and fetch-into-project.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderErrorResponse, ProviderOkResponse } from "#lib/runtime/provider-protocol";
import { hostCloneRuntimeProvider } from "../host-clone-provider";
import { SESSION_LOG_MAX_BYTES } from "../session-log";
import type { ExecutableRequest } from "../runtime-provider";
import type { FleetServer } from "../server";
import { startCallbackDaemon, type CallbackDaemon } from "./callback-daemon.testkit";
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

const SESSION_ID = "s1";
const MODEL_KEY_VAR = "OMP_HOST_CLONE_TEST_MODEL_KEY";
const LEAK_VAR = "OMP_HOST_CLONE_TEST_FLEET_ONLY";

/** The scripted stand-in for omp-session: records its launch, writes one transcript, idles until stopped. */
const FAKE_RUNTIME = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const stdin = process.argv.includes("--fleet-stdin") ? await Bun.stdin.text() : "";
appendFileSync(
	join(home, "boots.jsonl"),
	JSON.stringify({
		pid: process.pid,
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		stdin,
		env: {
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			OMP_WORKSPACE_DIR: process.env.OMP_WORKSPACE_DIR,
			OMP_PROVIDER_PROTO: process.env.OMP_PROVIDER_PROTO,
			OMP_SESSION_RESUME: process.env.OMP_SESSION_RESUME,
			MODEL_KEY: process.env.MODEL_KEY,
			LEAK: process.env.${LEAK_VAR},
			CALLBACK_TOKEN: process.env.OMP_SESSION_CALLBACK_TOKEN,
		},
	}) + "\\n",
);
const sessionDir = join(agentDir, "sessions", "${SESSION_ID}");
mkdirSync(sessionDir, { recursive: true });
const transcript = join(sessionDir, "${SESSION_ID}.jsonl");
if (!existsSync(transcript)) writeFileSync(transcript, ${JSON.stringify(transcriptJsonl())});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

/** Same structure a real session streams: a title slot, a session header, one message. */
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

const previousEnv: Record<string, string | undefined> = {};
let runtimeEntry = "";

beforeAll(() => {
	const dir = fleetPaths("omp-host-clone-runtime-").tmp;
	runtimeEntry = join(dir, "fake-runtime.js");
	writeFileSync(runtimeEntry, FAKE_RUNTIME);
	chmodSync(runtimeEntry, 0o755);
	for (const [key, value] of Object.entries({
		OMP_RUNTIME_ENTRY: runtimeEntry,
		[MODEL_KEY_VAR]: "model-key-value",
		[LEAK_VAR]: "fleet-only-value",
	})) {
		previousEnv[key] = process.env[key];
		process.env[key] = value;
	}
});

afterAll(() => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

interface Boot {
	pid: number;
	argv: string[];
	cwd: string;
	stdin: string;
	env: Record<string, string | undefined>;
}

interface Fixture {
	server: FleetServer;
	tmp: string;
	repoDir: string;
	projectId: string;
	daemons: CallbackDaemon[];
}

async function bootFleet(): Promise<Fixture> {
	const paths = fleetPaths("omp-host-clone-");
	const repoDir = await makeRepo(join(paths.tmp, "repo"));
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			providerProfiles: {
				host: { id: "host", provider: "host", secretRefs: { MODEL_KEY: `env:${MODEL_KEY_VAR}` } },
			},
		},
		{ workspaceDir: join(paths.tmp, "workspaces") },
	);
	const { project } = server.registry.addProject(repoDir);
	return { server, tmp: paths.tmp, repoDir, projectId: project.projectId, daemons: [] };
}

async function teardown(fx: Fixture): Promise<void> {
	for (const daemon of fx.daemons) await daemon.stop().catch(() => undefined);
	for (const entry of fx.server.registry.list()) {
		if (entry.workspace?.kind !== "clone") continue;
		await fetch(`http://127.0.0.1:${fx.server.port}/ctl/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ selector: entry.daemonId }),
		}).catch(() => undefined);
	}
	await fx.server.close();
}

interface Clone {
	daemonId: string;
	volume: string;
	checkout: string;
	home: string;
	sessions: string;
	stateDir: string;
}

function cloneOf(fx: Fixture, daemonId: string): Clone {
	const volume = fx.server.registry.get(daemonId)!.cwd!;
	return {
		daemonId,
		volume,
		checkout: join(volume, ".checkout"),
		home: join(volume, ".home"),
		sessions: join(volume, ".home", "agent", "sessions"),
		stateDir: join(dirname(volume), ".provider-state", daemonId),
	};
}

async function createClone(
	fx: Fixture,
	name: string,
	opts: { source?: { local?: string; remote?: string }; start?: boolean } = {},
): Promise<Clone> {
	const res = await postJson(fx.server.port, "/ctl/clones", {
		projectId: fx.projectId,
		name,
		profileId: "host",
		...(opts.source !== undefined ? { source: opts.source } : {}),
		start: opts.start ?? false,
	});
	expect(res.status).toBe(201);
	const { entry } = (await res.json()) as { entry: { daemonId: string } };
	return cloneOf(fx, entry.daemonId);
}

const start = (fx: Fixture, clone: Clone): Promise<Response> =>
	postJson(fx.server.port, "/ctl/start", { daemonId: clone.daemonId });
const stop = (fx: Fixture, clone: Clone): Promise<Response> =>
	postJson(fx.server.port, "/ctl/stop", { selector: clone.daemonId });
const remove = (fx: Fixture, clone: Clone): Promise<Response> =>
	fetch(`http://127.0.0.1:${fx.server.port}/ctl/worktrees/${clone.daemonId}`, { method: "DELETE" });

function boots(clone: Clone): Boot[] {
	try {
		return readFileSync(join(clone.home, "boots.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Boot);
	} catch {
		return [];
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The pid the provider recorded for the clone's runtime. */
function recordedPid(clone: Clone): number {
	const record = JSON.parse(readFileSync(join(clone.stateDir, "provider.pid.json"), "utf8")) as {
		pid: number;
	};
	return record.pid;
}

/** Dial a callback daemon with the credential of the clone's CURRENT handoff. */
async function pairUp(fx: Fixture, clone: Clone): Promise<CallbackDaemon> {
	const handoff = JSON.parse(readFileSync(join(clone.stateDir, "callback-env.json"), "utf8")) as {
		generation: number;
		env: Record<string, string>;
	};
	const daemon = startCallbackDaemon({
		url: handoff.env.OMP_SESSION_CALLBACK_URL!,
		workspaceId: clone.daemonId,
		generation: handoff.generation,
		token: handoff.env.OMP_SESSION_CALLBACK_TOKEN!,
	});
	fx.daemons.push(daemon);
	await daemon.waitConnected(5_000);
	return daemon;
}

/** Mirror the volume's transcripts into the fleet log store, as the session's log mirror does. */
function storeVolumeTranscripts(fx: Fixture, clone: Clone): void {
	for (const sessionId of readdirSync(clone.sessions)) {
		const bytes = readFileSync(join(clone.sessions, sessionId, `${sessionId}.jsonl`), "utf8");
		const storeDir = join(fx.tmp, "logs", clone.daemonId, sessionId);
		mkdirSync(storeDir, { recursive: true });
		writeFileSync(join(storeDir, `${sessionId}.jsonl`), bytes);
		writeFileSync(
			join(storeDir, "index.json"),
			JSON.stringify({
				version: 1,
				workspaceId: clone.daemonId,
				sessionId,
				streams: {
					[`${sessionId}.jsonl`]: {
						generation: 1,
						ackedOffset: Buffer.byteLength(bytes, "utf8"),
						eof: true,
					},
				},
			}),
		);
	}
}

const stageOf = (fx: Fixture, clone: Clone) =>
	fx.server.registry.get(clone.daemonId)?.lifecycleStage;

describe("host clone workspace", () => {
	test("local source: create, start, launch layout, transcripts, stop, wake resume, verified delete", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "local-host");
			// Fleet-side preparation: the volume is a real checkout on the workspace branch.
			expect(existsSync(join(clone.checkout, ".git"))).toBe(true);
			expect(await git(clone.checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
				fx.server.registry.get(clone.daemonId)!.workspace!.branch!,
			);
			expect(fx.server.registry.get(clone.daemonId)!.workspace!.source).toEqual({
				local: fx.repoDir,
			});

			expect((await start(fx, clone)).status).toBe(200);
			await waitFor(() => boots(clone).length === 1, 10_000, "the runtime to boot");
			const [first] = boots(clone);
			expect(first!.cwd).toBe(clone.checkout);
			// The env and home layout bwrap gives: the volume's home, agent dir under it.
			expect(first!.env).toMatchObject({
				HOME: clone.home,
				PI_CODING_AGENT_DIR: join(clone.home, "agent"),
				OMP_WORKSPACE_DIR: clone.checkout,
				OMP_PROVIDER_PROTO: "1",
				// secretRefs resolved from the fleet's own environment.
				MODEL_KEY: "model-key-value",
			});
			// Nothing else from the fleet's environment leaks, and the callback pair is on stdin only.
			expect(first!.env.LEAK).toBeUndefined();
			expect(first!.env.CALLBACK_TOKEN).toBeUndefined();
			expect(first!.argv).toContain("--fleet-stdin");
			expect(first!.argv.some((arg) => arg.startsWith("--omp-workspace-token="))).toBe(true);
			expect(JSON.parse(first!.stdin)).toBeObject();
			// A first start boots fresh.
			expect(first!.env.OMP_SESSION_RESUME).toBeUndefined();

			// Transcripts land under the volume's .home/agent/sessions.
			const transcript = join(clone.sessions, SESSION_ID, `${SESSION_ID}.jsonl`);
			await waitFor(() => existsSync(transcript), 5_000, "the transcript");
			expect(existsSync(join(clone.volume, ".home", "agent"))).toBe(true);

			// The pair comes up: the roster reaches ready.
			await pairUp(fx, clone);
			await waitFor(() => stageOf(fx, clone) === "ready", 5_000, "ready");
			const pid = recordedPid(clone);
			expect(pid).toBe(first!.pid);
			expect(alive(pid)).toBe(true);

			// A live clone is never deletable.
			expect((await remove(fx, clone)).status).not.toBe(200);
			expect(existsSync(clone.volume)).toBe(true);

			// Stop proves the process gone and keeps the checkout, logs and transcripts.
			expect((await stop(fx, clone)).status).toBe(200);
			await waitFor(() => !alive(pid), 5_000, "the runtime to exit");
			expect(existsSync(clone.checkout)).toBe(true);
			expect(existsSync(transcript)).toBe(true);
			expect(fx.server.registry.get(clone.daemonId)!.workspace!.desiredState).toBe("stopped");

			// Wake resumes the transcript the previous run left on the volume.
			expect((await start(fx, clone)).status).toBe(200);
			await waitFor(() => boots(clone).length === 2, 10_000, "the second boot");
			expect(boots(clone)[1]!.env.OMP_SESSION_RESUME).toBe(transcript);
			expect(boots(clone)[1]!.pid).not.toBe(pid);
			expect(fx.server.registry.get(clone.daemonId)!.workspace!.authorizedGeneration).toBe(2);
			expect((await stop(fx, clone)).status).toBe(200);
			await waitFor(() => !alive(boots(clone)[1]!.pid), 5_000, "the second run to exit");

			// The delete gate refuses a volume transcript the fleet store lacks, then
			// verifies byte-for-byte once the store holds it, and removes everything.
			const refused = await remove(fx, clone);
			expect(refused.status).not.toBe(200);
			expect(existsSync(clone.volume)).toBe(true);
			storeVolumeTranscripts(fx, clone);
			const deleted = await remove(fx, clone);
			expect(deleted.status).toBe(200);
			expect(await deleted.json()).toMatchObject({
				removed: clone.daemonId,
				verified: [SESSION_ID],
			});
			expect(existsSync(clone.volume)).toBe(false);
			expect(existsSync(clone.stateDir)).toBe(false);
			expect(fx.server.registry.get(clone.daemonId)).toBeUndefined();
		} finally {
			await teardown(fx);
		}
	}, 60_000);

	test("remote source: create+start clones the URL and runs the same layout", async () => {
		const fx = await bootFleet();
		try {
			const remote = `file://${fx.repoDir}`;
			const clone = await createClone(fx, "remote-host", { source: { remote }, start: true });
			expect(fx.server.registry.get(clone.daemonId)!.workspace!.source).toEqual({ remote });
			expect(readFileSync(join(clone.checkout, "readme.md"), "utf8")).toBe("hello\n");
			await waitFor(() => boots(clone).length === 1, 10_000, "the runtime to boot");
			expect(boots(clone)[0]!.cwd).toBe(clone.checkout);
			expect(boots(clone)[0]!.env.HOME).toBe(clone.home);
			await pairUp(fx, clone);
			await waitFor(() => stageOf(fx, clone) === "ready", 5_000, "ready");

			const pid = recordedPid(clone);
			expect((await stop(fx, clone)).status).toBe(200);
			await waitFor(() => !alive(pid), 5_000, "the runtime to exit");
			storeVolumeTranscripts(fx, clone);
			const deleted = await remove(fx, clone);
			expect(deleted.status).toBe(200);
			expect(existsSync(clone.volume)).toBe(false);
		} finally {
			await teardown(fx);
		}
	}, 60_000);

	test("fetch-into-project brings the host clone's branch back to the project", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "fetch-host");
			const branch = fx.server.registry.get(clone.daemonId)!.workspace!.branch!;
			writeFileSync(join(clone.checkout, "a.txt"), "a\n");
			await git(clone.checkout, ["add", "a.txt"]);
			await git(clone.checkout, ["commit", "-q", "-m", "add a"]);
			const work = await git(clone.checkout, ["rev-parse", "HEAD"]);

			const res = await postJson(
				fx.server.port,
				`/ctl/clones/${clone.daemonId}/fetch-into-project`,
				{},
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ outcome: "created", commit: work, branch });
			expect(await git(fx.repoDir, ["rev-parse", `refs/heads/${branch}`])).toBe(work);
		} finally {
			await teardown(fx);
		}
	}, 30_000);
});

describe("host clone provider ops", () => {
	function requestFor(
		stateRoot: string,
		op: ExecutableRequest["op"],
		overrides: Partial<ExecutableRequest> = {},
	): ExecutableRequest {
		return {
			op,
			workspaceId: "w1",
			generation: 1,
			workspaceDir: join(stateRoot, "volume", ".checkout"),
			homeDir: join(stateRoot, "volume", ".home"),
			stateDir: join(stateRoot, "state"),
			profile: { id: "host", provider: "host" },
			...overrides,
		} as ExecutableRequest;
	}

	function scratch(): string {
		const root = fleetPaths("omp-host-clone-ops-").tmp;
		mkdirSync(join(root, "volume", ".checkout"), { recursive: true });
		return root;
	}

	const run = (request: ExecutableRequest) => hostCloneRuntimeProvider.run(request);
	/** Poll the provider's own observation until it leaves `running` (the runtime is a separate process). */
	async function observedAfterExit(root: string): Promise<string> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const { observed } = okOf(await run(requestFor(root, "inspect")));
			if (observed !== "running" || Date.now() >= deadline) return observed;
			await Bun.sleep(50);
		}
	}
	const okOf = (response: ProviderOkResponse | ProviderErrorResponse): ProviderOkResponse => {
		if (!response.ok)
			throw new Error(`expected ok, got ${response.error.code}: ${response.error.message}`);
		return response;
	};

	test("ensure-running is idempotent per generation, refuses another while live, and stop proves termination", async () => {
		const root = scratch();
		const started = okOf(await run(requestFor(root, "ensure-running")));
		expect(started.observed).toBe("running");
		expect(started.pid).toBeGreaterThan(0);
		try {
			const again = okOf(await run(requestFor(root, "ensure-running")));
			expect(again).toMatchObject({ handle: started.handle, pid: started.pid });
			const conflict = await run(requestFor(root, "ensure-running", { generation: 2 }));
			expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
			expect(okOf(await run(requestFor(root, "inspect"))).observed).toBe("running");
		} finally {
			const stopped = okOf(await run(requestFor(root, "stop")));
			expect(stopped.observed).toBe("stopped");
		}
		await waitFor(() => !alive(started.pid!), 5_000, "the stopped runtime to be reaped");
		expect(okOf(await run(requestFor(root, "inspect"))).observed).toBe("stopped");
		// A stopped runtime restarts under the next generation.
		const next = okOf(await run(requestFor(root, "ensure-running", { generation: 2 })));
		expect(next.pid).not.toBe(started.pid);
		expect(okOf(await run(requestFor(root, "delete"))).observed).toBe("missing");
		await waitFor(() => !alive(next.pid!), 5_000, "the deleted runtime to be reaped");
		expect(existsSync(join(root, "state"))).toBe(false);
		// Delete of what is already gone, and inspect of what never ran, are idempotent.
		expect(okOf(await run(requestFor(root, "delete"))).observed).toBe("missing");
		expect(okOf(await run(requestFor(root, "inspect"))).observed).toBe("missing");
	}, 30_000);

	test("a runtime that exits after launch inspects as stopped, never running", async () => {
		const root = scratch();
		const exits = join(root, "exits.js");
		// Lives long enough to be launched, then exits on its own.
		writeFileSync(
			exits,
			'console.error("runtime says goodbye"); setTimeout(() => process.exit(3), 800);\n',
		);
		const previous = process.env.OMP_RUNTIME_ENTRY;
		process.env.OMP_RUNTIME_ENTRY = exits;
		try {
			okOf(await run(requestFor(root, "ensure-running")));
			expect(await observedAfterExit(root)).toBe("stopped");
			// The runtime's own output reaches the clone's daemon log through the relay.
			const log = join(root, "state", "daemon.log");
			await waitFor(
				() => existsSync(log) && readFileSync(log, "utf8").includes("runtime says goodbye"),
				10_000,
				"the runtime's output in daemon.log",
			);
		} finally {
			process.env.OMP_RUNTIME_ENTRY = previous;
		}
	}, 30_000);

	test("a runtime that dies during launch fails the start with its own output", async () => {
		const root = scratch();
		const dies = join(root, "dies.js");
		writeFileSync(dies, 'console.error("boom from the runtime"); process.exit(3);\n');
		const previous = process.env.OMP_RUNTIME_ENTRY;
		process.env.OMP_RUNTIME_ENTRY = dies;
		try {
			const response = await run(requestFor(root, "ensure-running"));
			expect(response).toMatchObject({
				ok: false,
				error: { code: "unavailable", retryable: true },
			});
			if (!response.ok) expect(response.error.message).toContain("boom from the runtime");
			expect(existsSync(join(root, "state", "provider.pid.json"))).toBe(false);
		} finally {
			process.env.OMP_RUNTIME_ENTRY = previous;
		}
	}, 30_000);

	test("daemon.log stays under the cap for the whole run, rotating to daemon.log.1", async () => {
		const root = scratch();
		const loud = join(root, "loud.js");
		// Writes ~3.5 MiB across stdout and stderr in 64 KiB lines, then idles until stopped.
		writeFileSync(
			loud,
			`const line = "x".repeat(65535) + "\\n";
for (let i = 0; i < 56; i++) (i % 2 === 0 ? process.stdout : process.stderr).write(line);
process.stdout.write("LAST-LINE\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
		);
		const previous = process.env.OMP_RUNTIME_ENTRY;
		process.env.OMP_RUNTIME_ENTRY = loud;
		const log = join(root, "state", "daemon.log");
		const size = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
		try {
			okOf(await run(requestFor(root, "ensure-running")));
			await waitFor(
				() => existsSync(log) && readFileSync(log, "utf8").includes("LAST-LINE"),
				15_000,
				"the runtime's last line in daemon.log",
			);
			// The runtime is still running, yet the live file is bounded and the older output rotated.
			expect(okOf(await run(requestFor(root, "inspect"))).observed).toBe("running");
			expect(size(log)).toBeLessThanOrEqual(SESSION_LOG_MAX_BYTES);
			expect(size(`${log}.1`)).toBeGreaterThan(0);
			expect(size(`${log}.1`)).toBeLessThanOrEqual(SESSION_LOG_MAX_BYTES);
			// Both generations together hold less than the runtime wrote (it wrote ~3.5 MiB).
			expect(size(log) + size(`${log}.1`)).toBeLessThanOrEqual(2 * SESSION_LOG_MAX_BYTES);
		} finally {
			process.env.OMP_RUNTIME_ENTRY = previous;
			await run(requestFor(root, "stop"));
		}
		// Stopping proves the runtime gone and lets the relay drain and exit.
		expect(okOf(await run(requestFor(root, "inspect"))).observed).toBe("stopped");
		expect(size(log)).toBeLessThanOrEqual(SESSION_LOG_MAX_BYTES);
	}, 60_000);

	test("a launch that cannot spawn fails typed and records nothing", async () => {
		const root = scratch();
		const previous = process.env.OMP_RUNTIME_BIN;
		process.env.OMP_RUNTIME_BIN = join(root, "no-such-runtime-binary");
		try {
			expect(await run(requestFor(root, "ensure-running"))).toMatchObject({
				ok: false,
				error: { code: "unavailable", retryable: true },
			});
			expect(existsSync(join(root, "state", "provider.pid.json"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.OMP_RUNTIME_BIN;
			else process.env.OMP_RUNTIME_BIN = previous;
		}
	});

	test("refuses a profile of another kind, an unresolvable secret, a missing checkout, and list-sessions", async () => {
		const root = scratch();
		expect(
			await run(
				requestFor(root, "inspect", {
					profile: { id: "b", provider: "bwrap", executable: "/p", tools: [] },
				}),
			),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(
			await run(
				requestFor(root, "ensure-running", {
					profile: {
						id: "host",
						provider: "host",
						secretRefs: { K: "env:OMP_HOST_CLONE_TEST_UNSET" },
					},
				}),
			),
		).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(
			await run(
				requestFor(root, "ensure-running", {
					profile: { id: "host", provider: "host", secretRefs: { K: "vault:path" } },
				}),
			),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(
			await run(requestFor(root, "ensure-running", { workspaceDir: join(root, "absent") })),
		).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await run(requestFor(root, "list-sessions"))).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		// Nothing was launched by any refusal.
		expect(existsSync(join(root, "state", "provider.pid.json"))).toBe(false);
	});
});
