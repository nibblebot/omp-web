/**
 * Fleet edge wire-contract tests: the browser edge (/events + /command) and
 * the /ctl routes against the real server mount (startFleet). Every session
 * daemon is a fake that dials the callback pair (startCallbackDaemon); the
 * fleet never dials a session. Order-dependent shared fixtures (browserA,
 * respawn counter, spawn capture, the second daemon for aggregated-daemons)
 * stay together here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { OMP_PROTO } from "#lib/wire/protocol";
import { CALLBACK_CONTROL_STREAM_ID, type CallbackEnvelope } from "#lib/wire/callback-protocol";
import { shouldDropFrame, toRosterEntry } from "../edge";
import type { RegistryEntry } from "../registry";
import { Registry } from "../registry";
import { startFleet, type FleetServer } from "../server";
import { enrollSessionCredential } from "../supervisor";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	FAKE_CWD,
	FAKE_STATE,
	FAKE_TOKEN,
	allBrowsers,
	asRoster,
	BrowserSocket,
	cleanupTempDirs,
	daemonInfo,
	openBrowser,
	sleep,
	waitFor,
} from "./edge.testkit";
import { hermeticStatsConfig } from "./server.testkit";

afterAll(cleanupTempDirs);

/** Second daemon's cwd, a different projectDir for cross-daemon merge tests. */
const OTHER_CWD = "/tmp/other-proj";

interface EnrollBody {
	entry: { daemonId: string };
	enrollment: { workspaceId: string; generation: number; token: string };
}

function controlType(payload: unknown): string | undefined {
	return typeof payload === "object" &&
		payload !== null &&
		"type" in payload &&
		typeof payload.type === "string"
		? payload.type
		: undefined;
}

function hasId(payload: unknown, id: string): boolean {
	return typeof payload === "object" && payload !== null && "id" in payload && payload.id === id;
}

/** Control envelopes of one type the fleet sent down to a daemon. */
function controlsOf(daemon: CallbackDaemon, type: string): CallbackEnvelope[] {
	return daemon
		.received()
		.filter((env) => env.kind === "control" && controlType(env.payload) === type);
}

/** Commands a daemon received for one browser command id. */
function commandsWithId(daemon: CallbackDaemon, id: string): CallbackEnvelope[] {
	return daemon.received().filter((env) => env.kind === "command" && hasId(env.payload, id));
}

describe("fleet edge", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let browseDir: string;
	let server: FleetServer;
	let remoteEntry: RegistryEntry;
	let remoteDaemon: CallbackDaemon;
	let spawnedEntry: RegistryEntry;
	let browserA: BrowserSocket;
	let browserB: BrowserSocket;
	let streamA = "";
	let streamB = "";
	let respawns = 0;
	/** supervisor.spawn invocations captured by the wrapper (labels passthrough tests). */
	let spawnInits: Array<{ cwd: string; template?: string; labels?: string[] }> = [];
	/** The entry the wrapper's last spawn returned. */
	let spawnedByEdge: RegistryEntry | null = null;
	// Aggregated daemons panel tests (second daemon + its registered id).
	let daemonsBId = "";
	let daemonsBrowser: BrowserSocket;
	/** Every callback daemon this suite started, keyed by daemonId. */
	const daemonsById = new Map<string, CallbackDaemon>();

	const fleetUrl = () => `http://127.0.0.1:${server.port}`;

	/** Mint a daemon's pair credential through the enroll path and dial it. */
	async function connectDaemon(
		daemonId: string,
		generation: number,
		token: string,
	): Promise<CallbackDaemon> {
		daemonsById.get(daemonId)?.stop();
		const daemon = startCallbackDaemon({
			url: fleetUrl(),
			workspaceId: daemonId,
			generation,
			token,
		});
		daemonsById.set(daemonId, daemon);
		await daemon.waitConnected(10_000);
		return daemon;
	}

	/** Pair a supervisor-launched child: the test plays the child's callback dial. */
	async function pairSpawned(daemonId: string): Promise<void> {
		const { generation, credential } = enrollSessionCredential(
			server.transport,
			server.registry,
			daemonId,
		);
		await connectDaemon(daemonId, generation, credential);
	}

	function dropDaemon(daemonId: string): void {
		daemonsById.get(daemonId)?.stop();
		daemonsById.delete(daemonId);
	}

	async function enrollRemote(name: string, cwd = FAKE_CWD): Promise<EnrollBody> {
		const res = await fetch(`${fleetUrl()}/ctl/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, cwd }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as EnrollBody;
	}

	/** Wait for the fleet to open a new browser stream on this daemon. */
	async function awaitNewStream(daemon: CallbackDaemon, seen: number): Promise<string> {
		return waitFor(
			() => {
				const opens = controlsOf(daemon, "stream_open");
				return opens.length > seen ? opens[opens.length - 1].streamId : null;
			},
			5000,
			"stream_open on the callback pair",
		);
	}

	/** Prime a browser stream the way a session does after stream_open (hello_ok, attached, then priming). */
	function primeStream(daemon: CallbackDaemon, streamId: string): void {
		daemon.send(streamId, "frame", { type: "hello_ok", proto: OMP_PROTO });
		daemon.send(streamId, "frame", { type: "attached", sessionId: "s1" });
		daemon.send(streamId, "frame", { type: "history", entries: [] });
		daemon.send(streamId, "frame", { type: "state", state: FAKE_STATE });
		daemon.send(streamId, "frame", { type: "available_commands", commands: [] });
		daemon.send(streamId, "frame", { type: "ready" });
	}

	/** Attach a browser to a daemon, prime its pipe, and wait for the attached frame. Returns the stream id. */
	async function attachBrowser(
		browser: BrowserSocket,
		daemon: CallbackDaemon,
		daemonId: string,
	): Promise<string> {
		const seen = controlsOf(daemon, "stream_open").length;
		await browser.send({ type: "attach", sessionId: daemonId });
		const streamId = await awaitNewStream(daemon, seen);
		primeStream(daemon, streamId);
		await browser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === daemonId,
			`attached ${daemonId}`,
		);
		return streamId;
	}

	/** Attach through a respawn: wait for the pair the respawn creates, then prime its stream and wait for attached. */
	async function primeAttach(browser: BrowserSocket, daemonId: string): Promise<string> {
		const daemon = await waitFor(
			() => daemonsById.get(daemonId) ?? null,
			5000,
			`pair for ${daemonId}`,
		);
		const streamId = await awaitNewStream(daemon, 0);
		primeStream(daemon, streamId);
		await browser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === daemonId,
			`attached ${daemonId}`,
		);
		return streamId;
	}

	// Hermetic against the dev-runner override: loadConfig lets
	// OMP_FLEET_LOCAL_TEMPLATE replace the `local` template, and a shell that
	// ran `bun run dev` carries it. Deleted for the suite's lifetime.
	const savedLocalTemplate = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	delete process.env.OMP_FLEET_LOCAL_TEMPLATE;
	beforeAll(async () => {
		tmp = tempDir("omp-web-edge-");
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		// Browse fixture for GET /ctl/fs/browse: one plain child, one with a
		// .git entry, one dot-dir (skipped in listings).
		browseDir = join(tmp, "browse");
		mkdirSync(join(browseDir, "child"), { recursive: true });
		mkdirSync(join(browseDir, "repo", ".git"), { recursive: true });
		mkdirSync(join(browseDir, ".hidden"), { recursive: true });
		// Spawned entries run in FAKE_CWD, so it must exist.
		mkdirSync(FAKE_CWD, { recursive: true });
		// The local template is a sleep loop: spawned children never dial on
		// their own, the test pairs them through the callback pair.
		writeFileSync(
			configPath,
			JSON.stringify({
				templates: {
					local: { command: "while :; do sleep 0.05; done" },
				},
				defaultTemplate: "local",
			}),
		);
		// Seed a spawned-but-asleep entry so attach exercises the wake path.
		const registry = new Registry(statePath);
		await registry.load();
		spawnedEntry = registry.create({
			name: "spawned",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "local",
			status: "asleep",
		});
		// A second one for the spawn_resume + attach serialization test.
		registry.create({
			name: "spawned2",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "local",
			status: "asleep",
		});
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			statsConfig: hermeticStatsConfig(statePath),
		});
		// Count supervisor.respawn calls and pair the woken child, as its dial would.
		const origRespawn = server.supervisor.respawn.bind(server.supervisor);
		server.supervisor.respawn = async (entry: RegistryEntry, opts?: { resumeFile?: string }) => {
			respawns++;
			await origRespawn(entry, opts);
			await pairSpawned(entry.daemonId);
		};
		// Capture supervisor.spawn inits for the labels-passthrough tests, and
		// pair each spawned child as its dial would.
		const origSpawn = server.supervisor.spawn.bind(server.supervisor);
		server.supervisor.spawn = async (init: {
			cwd: string;
			template?: string;
			name?: string;
			labels?: string[];
		}) => {
			spawnInits.push({ cwd: init.cwd, template: init.template, labels: init.labels });
			spawnedByEdge = await origSpawn(init);
			await pairSpawned(spawnedByEdge.daemonId);
			return spawnedByEdge;
		};
	});

	afterAll(async () => {
		for (const browser of allBrowsers) browser.close();
		for (const daemon of daemonsById.values()) daemon.stop();
		if (server !== undefined) await server.close();
		if (savedLocalTemplate !== undefined) process.env.OMP_FLEET_LOCAL_TEMPLATE = savedLocalTemplate;
	});

	test("GET /ctl/templates returns the config template names", async () => {
		const res = await fetch(`${fleetUrl()}/ctl/templates`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown;
		expect(body).toEqual(["local"]);
	});

	test("GET /ctl/fs/browse lists subdirectories per the picker contract", async () => {
		const res = await fetch(`${fleetUrl()}/ctl/fs/browse?path=${encodeURIComponent(browseDir)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			path: string;
			parent: string | null;
			dirs: Array<{ name: string; path: string; hasGit: boolean }>;
			truncated: boolean;
		};
		expect(body.path).toBe(realpathSync(browseDir));
		expect(body.parent).toBe(realpathSync(tmp));
		expect(body.truncated).toBe(false);
		// Dot-dir skipped; name-sorted; .git dir flags hasGit.
		expect(body.dirs).toEqual([
			{ name: "child", path: join(realpathSync(browseDir), "child"), hasGit: false },
			{ name: "repo", path: join(realpathSync(browseDir), "repo"), hasGit: true },
		]);
	});

	test("GET /ctl/fs/browse 400s for a missing or non-directory path", async () => {
		const missing = await fetch(
			`${fleetUrl()}/ctl/fs/browse?path=${encodeURIComponent(join(tmp, "gone"))}`,
		);
		expect(missing.status).toBe(400);
		const missingBody = (await missing.json()) as { error?: string };
		expect(missingBody.error).toContain("no such directory");
		const file = await fetch(`${fleetUrl()}/ctl/fs/browse?path=${encodeURIComponent(configPath)}`);
		expect(file.status).toBe(400);
		const fileBody = (await file.json()) as { error?: string };
		expect(fileBody.error).toContain("not a directory");
	});

	test("GET /ctl/sessions/{id}/stderr 404s for unknown daemons", async () => {
		const res = await fetch(`${fleetUrl()}/ctl/sessions/d999/stderr`);
		expect(res.status).toBe(404);
	});

	test("POST /ctl/enroll registers a remote daemon whose callback pair reaches ready", async () => {
		const body = await enrollRemote("added");
		remoteEntry = server.registry.get(body.entry.daemonId)!;
		expect(remoteEntry.mode).toBe("remote");
		remoteDaemon = await connectDaemon(
			body.entry.daemonId,
			body.enrollment.generation,
			body.enrollment.token,
		);
		await waitFor(
			() => (server.registry.get(remoteEntry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"remote daemon ready",
		);
	});

	test("roster is unicast on open and broadcast on registry change, without tokens", async () => {
		const browser = await openBrowser(server.port);
		const roster = asRoster(
			await browser.waitForFrame((f) => f.type === "roster", "initial roster"),
		);
		const ids = roster.daemons.map((d) => d.daemonId);
		expect(ids).toContain(remoteEntry.daemonId);
		expect(ids).toContain(spawnedEntry.daemonId);
		expect(JSON.stringify(roster)).not.toContain(FAKE_TOKEN);
		for (const d of roster.daemons) {
			expect(d).not.toHaveProperty("token");
			expect(d).not.toHaveProperty("endpoint");
			expect(d).not.toHaveProperty("registeredAt");
			expect(d).not.toHaveProperty("template");
			// Alive daemons carry an uptime; asleep ones must not (no pid,
			// no uptime growing since a dead process's readyAt).
			if (d.status === "asleep") {
				expect(d.uptime).toBeUndefined();
				expect(d.pid).toBeUndefined();
				expect(d.readyAt).toBeUndefined();
			} else {
				expect(typeof d.uptime).toBe("number");
			}
		}
		// A registry mutation broadcasts a fresh roster to every edge stream.
		server.registry.update(remoteEntry.daemonId, { labels: ["env=test"] });
		const second = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && JSON.stringify(f).includes("env=test"),
				"roster broadcast",
			),
		);
		const changed = second.daemons.find((d) => d.daemonId === remoteEntry.daemonId);
		expect(changed?.labels).toContain("env=test");
		expect(JSON.stringify(second)).not.toContain(FAKE_TOKEN);
	});

	test("registered_projects primes on open and broadcasts on project registration, without tokens", async () => {
		const browser = await openBrowser(server.port);
		const priming = await browser.waitForFrame(
			(f) => f.type === "registered_projects",
			"registered_projects priming",
		);
		if (priming.type !== "registered_projects") throw new Error("expected registered_projects");
		expect(priming.projects).toEqual([]);
		// The frame carries the resolved fleet config path (the test fleet
		// boots with a real config file, so it is the path).
		expect(priming.configPath).toBe(configPath);

		// Register a real git repo: the open browser gets a live broadcast.
		const repoDir = join(tmp, "registered-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const project = await server.registry.addProject(repoDir);
		try {
			const frame = await browser.waitForFrame(
				(f) =>
					f.type === "registered_projects" &&
					f.projects.some((p) => p.projectId === project.projectId),
				"registered_projects broadcast",
			);
			if (frame.type !== "registered_projects") throw new Error("expected registered_projects");
			expect(frame.projects).toHaveLength(1);
			expect(frame.configPath).toBe(configPath);
			expect(frame.projects[0]).toMatchObject({
				projectId: project.projectId,
				path: project.path,
				name: "registered-repo",
			});
			expect(typeof frame.projects[0].addedAt).toBe("number");
			expect(JSON.stringify(frame)).not.toContain(FAKE_TOKEN);
		} finally {
			server.registry.removeProject(project.projectId);
		}
	});

	test("POST /command with an unknown client id is a 400", async () => {
		const res = await fetch(`${fleetUrl()}/command`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-client-id": "nobody" },
			body: JSON.stringify({ type: "list_projects" }),
		});
		expect(res.status).toBe(400);
	});

	test("list_projects answers with a projects frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "list_projects" });
		const frame = await browser.waitForFrame((f) => f.type === "projects", "projects frame");
		if (frame.type !== "projects") throw new Error("expected projects");
		// No root scanning and no registered projects here: the frame is an
		// empty list (registered projects surface via registered_projects).
		expect(frame.projects).toEqual([]);
	});

	test("list_daemon_sessions answers a per-daemon sessions frame (asleep daemon included)", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({
			type: "list_daemon_sessions",
			id: "ls1",
			daemonId: spawnedEntry.daemonId,
		});
		const frame = await browser.waitForFrame(
			(f) => f.type === "daemon_sessions",
			"daemon_sessions frame",
		);
		if (frame.type !== "daemon_sessions") throw new Error("expected daemon_sessions");
		// The asleep spawned entry answers from disk, so no live process is needed.
		expect(frame.daemonId).toBe(spawnedEntry.daemonId);
		expect(Array.isArray(frame.sessions)).toBe(true);
	});

	test("list_daemon_sessions rejects an unknown daemon", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "list_daemon_sessions", id: "ls2", daemonId: "d-ghost" });
		const frame = await browser.waitForFrame((f) => f.type === "error", "error frame");
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("unknown daemon");
	});

	test("spawn_resume with a session file outside the worktree is refused", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// A path that can never appear in the worktree's session listing.
		await browser.send({
			type: "spawn_resume",
			id: "sr1",
			daemonId: spawnedEntry.daemonId,
			sessionFile: "/etc/passwd",
		});
		const frame = await browser.waitForFrame((f) => f.type === "error", "error frame");
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("not in this worktree");
		// Refused: the daemon stays asleep.
		expect(server.registry.get(spawnedEntry.daemonId)?.status).toBe("asleep");
	});

	test("spawn with a bad path answers an error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "spawn", cwd: join(tmp, "does-not-exist") });
		const frame = await browser.waitForFrame((f) => f.type === "error", "spawn error");
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("not a directory");
	});

	test("spawn passes valid labels through to supervisor.spawn", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const before = spawnInits.length;
		spawnedByEdge = null; // the wait below must observe the NEW spawn
		await browser.send({ type: "spawn", cwd: FAKE_CWD, labels: ["env=prod", "tag=api"] });
		// The real supervisor runs underneath: wait until the child pairs ready.
		await waitFor(
			() =>
				spawnedByEdge && server.registry.get(spawnedByEdge.daemonId)?.status === "ready"
					? "ready"
					: null,
			4000,
			"labeled spawn ready",
		);
		expect(spawnInits.length).toBe(before + 1);
		const init = spawnInits[spawnInits.length - 1];
		expect(init.cwd).toBe(FAKE_CWD);
		expect(init.template).toBeUndefined();
		expect(init.labels).toEqual(["env=prod", "tag=api"]);
		// The labels landed on the registry entry (roster surfaces them).
		expect(server.registry.get(spawnedByEdge!.daemonId)?.labels).toEqual(["env=prod", "tag=api"]);
	});

	test("spawn rejects labels that are not k=v strings with an error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const before = spawnInits.length;
		for (const bad of [["nope"], "env=prod", ["env=prod", 42], [""], ["=x"]]) {
			await browser.send({ type: "spawn", cwd: FAKE_CWD, labels: bad });
			const frame = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "spawn: labels must be an array of k=v strings",
				`labels error for ${JSON.stringify(bad)}`,
			);
			expect(frame.type).toBe("error");
		}
		// None of the bad sends may have reached the supervisor.
		expect(spawnInits).toHaveLength(before);
	});

	test("spawn without labels still spawns (labels stays undefined)", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const before = spawnInits.length;
		spawnedByEdge = null; // the wait below must observe the NEW spawn
		await browser.send({ type: "spawn", cwd: FAKE_CWD });
		await waitFor(
			() =>
				spawnedByEdge && server.registry.get(spawnedByEdge.daemonId)?.status === "ready"
					? "ready"
					: null,
			4000,
			"unlabeled spawn ready",
		);
		expect(spawnInits.length).toBe(before + 1);
		const init = spawnInits[spawnInits.length - 1];
		expect(init.labels).toBeUndefined();
	});

	test("commands outside the browser allowlist are rejected with the edge error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// The mux-era commands and detach were removed from the protocol. A
		// stale client sending them, or any other non-allowlisted type, must
		// get the edge rejection instead of a daemon forward. The removed type
		// names are assembled so the identifiers never appear in this file.
		const removedMuxTypes = ["create_", "close_", "list_live_"].map((prefix) =>
			prefix === "list_live_" ? `${prefix}sessions` : `${prefix}session`,
		);
		for (const type of [...removedMuxTypes, "detach", "bogus_command"]) {
			await browser.send({ type });
			const frame = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "fleet edge: use spawn/stop/roster",
				`rejection error for ${type}`,
			);
			expect(frame.type).toBe("error");
		}
	});

	test("attach primes over the callback pair with sessionId rewritten, and forwards calls verbatim", async () => {
		browserA = await openBrowser(server.port);
		await browserA.waitForFrame((f) => f.type === "roster", "roster");
		streamA = await attachBrowser(browserA, remoteDaemon, remoteEntry.daemonId);
		// Priming is forwarded with the sessionId rewritten to the daemonId.
		await browserA.waitForFrame(
			(f) => f.type === "history" && f.sessionId === remoteEntry.daemonId,
			"history",
		);
		await browserA.waitForFrame(
			(f) => f.type === "state" && f.sessionId === remoteEntry.daemonId,
			"state",
		);
		await browserA.waitForFrame(
			(f) => f.type === "available_commands" && f.sessionId === remoteEntry.daemonId,
			"available_commands",
		);
		await browserA.waitForFrame((f) => f.type === "ready", "ready");
		// The proto-gated hello_ok is FORWARDED so the browser's own proto
		// check runs on the edge stream too.
		const hello = await browserA.waitForFrame((f) => f.type === "hello_ok", "hello_ok");
		expect((hello as { proto?: unknown }).proto).toBe(OMP_PROTO);
		// Every forwarded session-scoped frame carries the daemonId.
		for (const f of browserA.frames) {
			if ("sessionId" in f) expect(f.sessionId).toBe(remoteEntry.daemonId);
		}

		// The call reaches the daemon once, on this browser's stream, verbatim.
		await browserA.send({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
		await waitFor(
			() => (commandsWithId(remoteDaemon, "c1").length > 0 ? "c1" : null),
			5000,
			"call c1 at daemon",
		);
		const forwarded = commandsWithId(remoteDaemon, "c1");
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].streamId).toBe(streamA);
		expect(forwarded[0].payload).toEqual({
			type: "call",
			id: "c1",
			method: "prompt",
			args: ["hello"],
		});
		remoteDaemon.send(streamA, "frame", { type: "call_result", id: "c1", ok: true });
		const result = await browserA.waitForFrame(
			(f) => f.type === "call_result" && f.id === "c1",
			"call_result c1",
		);
		if (result.type !== "call_result") throw new Error("expected call_result");
		expect(result.ok).toBe(true);
		await sleep(200);
		expect(browserA.frames.filter((f) => f.type === "call_result" && f.id === "c1")).toHaveLength(
			1,
		);
	});

	test("a second browser gets an independent pipe, and answers reach only the browser that forwarded the command", async () => {
		browserB = await openBrowser(server.port);
		await browserB.waitForFrame((f) => f.type === "roster", "roster");
		streamB = await attachBrowser(browserB, remoteDaemon, remoteEntry.daemonId);
		expect(streamB).not.toBe(streamA);
		await browserB.waitForFrame(
			(f) => f.type === "history" && f.sessionId === remoteEntry.daemonId,
			"history B",
		);

		await browserA.send({ type: "call", id: "a2", method: "getQueuedMessages" });
		await browserB.send({ type: "call", id: "b2", method: "getQueuedMessages" });
		await waitFor(
			() =>
				commandsWithId(remoteDaemon, "a2").length > 0 &&
				commandsWithId(remoteDaemon, "b2").length > 0
					? "both"
					: null,
			5000,
			"a2 and b2 at daemon",
		);
		// The daemon broadcasts its answer to every stream it has open, the way
		// a real daemon does; the fleet must still deliver a2's answer only to A.
		const answerA2 = { type: "call_result", id: "a2", ok: true };
		remoteDaemon.send(streamA, "frame", answerA2);
		remoteDaemon.send(streamB, "frame", answerA2);
		remoteDaemon.send(streamB, "frame", { type: "call_result", id: "b2", ok: true });
		await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "a2", "a2 result");
		await browserB.waitForFrame((f) => f.type === "call_result" && f.id === "b2", "b2 result");
		await sleep(200);
		expect(browserA.frames.filter((f) => f.type === "call_result" && f.id === "a2")).toHaveLength(
			1,
		);
		expect(browserB.frames.some((f) => f.type === "call_result" && f.id === "a2")).toBe(false);
	});

	test("browser close closes its pipe and leaves the other browser's pipe working", async () => {
		// Browser close is the teardown path: the edge closes the pipe itself.
		browserA.close();
		await waitFor(
			() =>
				controlsOf(remoteDaemon, "stream_close").some((e) => e.streamId === streamA)
					? "closed"
					: null,
			5000,
			"stream_close for closed browser",
		);
		expect(
			browserA.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
		).toBe(false);
		// The other browser still forwards and receives over its own stream.
		await browserB.send({ type: "call", id: "b3", method: "getQueuedMessages" });
		await waitFor(
			() => (commandsWithId(remoteDaemon, "b3").length > 0 ? "b3" : null),
			5000,
			"b3 at daemon",
		);
		remoteDaemon.send(streamB, "frame", { type: "call_result", id: "b3", ok: true });
		await browserB.waitForFrame((f) => f.type === "call_result" && f.id === "b3", "b3 result");
		expect(controlsOf(remoteDaemon, "stream_close").some((e) => e.streamId === streamB)).toBe(
			false,
		);
	});

	test("an unattached call fails fast with an id-keyed call_result, not a bare error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// No attach: the daemon-less forward must answer the call BY ID so the
		// client's pending call() promise settles instead of hanging 30s.
		await browser.send({ type: "call", id: "c-unattached", method: "prompt", args: ["hi"] });
		const result = await browser.waitForFrame(
			(f) => f.type === "call_result" && f.id === "c-unattached",
			"call_result c-unattached",
		);
		if (result.type !== "call_result") throw new Error("expected call_result");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not attached");
		// No global error frame rides along for this call.
		expect(
			browser.frames.some((f) => f.type === "error" && String(f.error).includes("not attached")),
		).toBe(false);
	});

	test("clientId rebind closes the previous live stream and broadcasts the roster exactly once", async () => {
		const sharedId = crypto.randomUUID();
		const oldBrowser = new BrowserSocket(server.port, sharedId);
		allBrowsers.push(oldBrowser);
		await oldBrowser.open();
		await oldBrowser.waitForFrame((f) => f.type === "roster", "roster");
		const oldStream = await attachBrowser(oldBrowser, remoteDaemon, remoteEntry.daemonId);

		// Rebind: a SECOND /events open with the SAME clientId while the old
		// stream is still live.
		const newBrowser = new BrowserSocket(server.port, sharedId);
		allBrowsers.push(newBrowser);
		await newBrowser.open();
		await newBrowser.waitForFrame((f) => f.type === "roster", "roster");

		// The old stream is torn down: its body ends and its pipe closes.
		await oldBrowser.end(5000);
		await waitFor(
			() =>
				controlsOf(remoteDaemon, "stream_close").some((e) => e.streamId === oldStream)
					? "closed"
					: null,
			5000,
			"old pipe closed after rebind",
		);

		// A broadcast after the rebind reaches the new stream EXACTLY once.
		const oldFramesAtEnd = oldBrowser.frames.length;
		const seenBefore = newBrowser.frames.length;
		server.registry.update(remoteEntry.daemonId, {});
		await waitFor(
			() => newBrowser.frames.slice(seenBefore).find((f) => f.type === "roster") ?? null,
			5000,
			"roster broadcast after rebind",
		);
		await sleep(200);
		const dups = newBrowser.frames.slice(seenBefore).filter((f) => f.type === "roster");
		expect(dups).toHaveLength(1);
		// The old stream is dead: it received nothing after its teardown.
		expect(oldBrowser.frames.length).toBe(oldFramesAtEnd);
		oldBrowser.close();
		newBrowser.close();
	});

	test("attach to an asleep spawned daemon respawns it, waits for the pair, then pipes", async () => {
		const browserC = await openBrowser(server.port);
		await browserC.waitForFrame((f) => f.type === "roster", "roster");
		const respawnsBefore = respawns;
		const daemon = daemonsById.get(spawnedEntry.daemonId);
		// Nothing has paired this entry yet: the daemon is created by the respawn.
		expect(daemon).toBeUndefined();
		await browserC.send({ type: "attach", sessionId: spawnedEntry.daemonId });
		await primeAttach(browserC, spawnedEntry.daemonId);
		expect(respawns).toBe(respawnsBefore + 1);
		expect(server.registry.get(spawnedEntry.daemonId)?.status).toBe("ready");
		const paired = daemonsById.get(spawnedEntry.daemonId);
		if (!paired) throw new Error("spawned daemon did not pair");
		await awaitNewStream(paired, 0);
		await browserC.waitForFrame(
			(f) => f.type === "history" && f.sessionId === spawnedEntry.daemonId,
			"history C",
		);
		browserC.close();
	});

	test("spawn_resume then attach wakes an asleep spawned daemon exactly once", async () => {
		const entry = server.registry.list().find((e) => e.name === "spawned2");
		if (!entry) throw new Error("spawned2 missing");
		expect(entry.status).toBe("asleep");
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const respawnsBefore = respawns;
		// The roster UI sends these back-to-back; the edge must serialize them.
		await browser.send({ type: "spawn_resume", daemonId: entry.daemonId });
		await browser.send({ type: "attach", sessionId: entry.daemonId });
		await primeAttach(browser, entry.daemonId);
		expect(respawns).toBe(respawnsBefore + 1);
		expect(server.registry.get(entry.daemonId)?.status).toBe("ready");
	});

	test("spawn_resume with a picked session then attach resumes the PICKED session once", async () => {
		// The roster UI fires spawn_resume {sessionFile} and attach back-to-back.
		// spawn_resume validates the pick against the worktree listing (async disk
		// read) before waking; an attach that wakes first would respawn on
		// lastSessionFile and silently drop the pick.
		const agentDir = tempDir("omp-web-edge-agentdir-");
		const savedEnv = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			OMP_PROFILE: process.env.OMP_PROFILE,
			PI_PROFILE: process.env.PI_PROFILE,
		};
		// listDaemonSessions resolves the agent dir from the SDK's process-level
		// state (the edge has no per-call seam), so point it at the temp dir for
		// this test only and restore it exactly afterwards.
		setAgentDir(agentDir);
		const origRespawn = server.supervisor.respawn;
		const resumeFiles: Array<string | undefined> = [];
		server.supervisor.respawn = async (e: RegistryEntry, opts?: { resumeFile?: string }) => {
			resumeFiles.push(opts?.resumeFile);
			await origRespawn.call(server.supervisor, e, opts);
		};
		try {
			const sessionDir = SessionManager.getDefaultSessionDir(
				FAKE_CWD,
				agentDir,
				new FileSessionStorage(),
			);
			const picked = join(sessionDir, "picked.jsonl");
			writeFileSync(
				picked,
				`${JSON.stringify({ type: "session", id: "picked", cwd: FAKE_CWD })}\n`,
			);
			const entry = server.registry.create({
				name: "spawned-picked",
				cwd: FAKE_CWD,
				project: "fake-proj",
				labels: [],
				mode: "spawned",
				template: "local",
				status: "asleep",
				lastSessionFile: join(sessionDir, "last.jsonl"),
			});
			const browser = await openBrowser(server.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "spawn_resume", daemonId: entry.daemonId, sessionFile: picked });
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await primeAttach(browser, entry.daemonId);
			// Exactly one respawn, and on the PICKED file rather than lastSessionFile.
			expect(resumeFiles).toEqual([picked]);
			expect(server.registry.get(entry.daemonId)?.status).toBe("ready");
			dropDaemon(entry.daemonId);
		} finally {
			server.supervisor.respawn = origRespawn;
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
		}
	});

	test("GET /ctl/sessions/{id}/stderr returns text for spawned and 404 for remote", async () => {
		const spawned = await fetch(`${fleetUrl()}/ctl/sessions/${spawnedEntry.daemonId}/stderr`);
		expect(spawned.status).toBe(200);
		const body = (await spawned.json()) as { text?: unknown };
		expect(typeof body.text).toBe("string");
		const remote = await fetch(`${fleetUrl()}/ctl/sessions/${remoteEntry.daemonId}/stderr`);
		expect(remote.status).toBe(404);
	});

	test("tokens never appear in any roster frame", async () => {
		const rosters = allBrowsers.flatMap((b) => b.frames.filter((f) => f.type === "roster"));
		expect(rosters.length).toBeGreaterThan(0);
		for (const frame of rosters) {
			expect(JSON.stringify(frame)).not.toContain(FAKE_TOKEN);
			const { daemons } = asRoster(frame);
			for (const d of daemons) {
				expect(d).not.toHaveProperty("token");
				expect(d).not.toHaveProperty("endpoint");
			}
		}
	});

	test("static dist serving falls back to the placeholder page", async () => {
		const root = await fetch(`${fleetUrl()}/`);
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type") ?? "").toContain("text/html");
		const probe = await fetch(`${fleetUrl()}/__omp_web_placeholder_probe__`);
		expect(probe.status).toBe(200);
		expect(await probe.text()).toContain("omp-web");
	});

	test("GET /ctl/debug reports each session's callback pair state without tokens or endpoints", async () => {
		const pending = await enrollRemote("debug-unpaired");
		const res = await fetch(`${fleetUrl()}/ctl/debug`);
		expect(res.status).toBe(200);
		const text = await res.text();
		const body = JSON.parse(text) as {
			sessions: Array<{
				daemonId: string;
				pair?: { enrolled: boolean; paired: boolean; authorizedGeneration: number | null };
			}>;
		};
		const paired = body.sessions.find((s) => s.daemonId === remoteEntry.daemonId);
		expect(paired?.pair).toMatchObject({ enrolled: true, paired: true });
		expect(typeof paired?.pair?.authorizedGeneration).toBe("number");
		const unpaired = body.sessions.find((s) => s.daemonId === pending.entry.daemonId);
		expect(unpaired?.pair).toMatchObject({ enrolled: true, paired: false });
		expect(text).not.toContain(pending.enrollment.token);
		expect(text).not.toContain(FAKE_TOKEN);
		for (const session of body.sessions) {
			expect(session).not.toHaveProperty("token");
			expect(session).not.toHaveProperty("endpoint");
		}
	});

	test("aggregated daemons: merge across daemons with same-projectDir preference", async () => {
		// A second daemon with a different cwd, enrolled and paired like any remote daemon.
		const body = await enrollRemote("daemons-b", OTHER_CWD);
		daemonsBId = body.entry.daemonId;
		const daemonB = await connectDaemon(
			daemonsBId,
			body.enrollment.generation,
			body.enrollment.token,
		);
		await waitFor(
			() => (server.registry.get(daemonsBId)?.status === "ready" ? "ready" : null),
			5000,
			"second daemon ready",
		);
		// A browser to observe the merged broadcasts.
		const funnel = await openBrowser(server.port);
		await funnel.waitForFrame((f) => f.type === "roster", "roster");
		// The first daemon (cwd FAKE_CWD) reports its own roster; the second
		// (cwd OTHER_CWD) reports its own PLUS a cross-cwd entry for FAKE_CWD.
		remoteDaemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
			type: "daemons",
			daemons: [
				daemonInfo("hub-a", FAKE_CWD, { pid: 1111 }),
				daemonInfo("shared", FAKE_CWD, { pid: 1112 }),
			],
		});
		daemonB.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
			type: "daemons",
			daemons: [
				daemonInfo("hub-b", OTHER_CWD, { pid: 2221 }),
				daemonInfo("shared", FAKE_CWD, { pid: 2222 }),
				daemonInfo("only-b", OTHER_CWD, { pid: 2223 }),
			],
		});
		const frame = await funnel.waitForFrame(
			(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "only-b"),
			"merged daemons frame",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const byName = new Map(frame.daemons.map((d) => [d.name, d]));
		expect(byName.get("hub-a")?.pid).toBe(1111);
		expect(byName.get("hub-b")?.pid).toBe(2221);
		expect(byName.get("only-b")?.pid).toBe(2223);
		// Same-projectDir preference: the daemon whose cwd is the projectDir
		// wins the shared key over the later cross-cwd arrival.
		expect(byName.get("shared")?.pid).toBe(1112);
	});

	test("aggregated daemons: merged frame is broadcast on browser open", async () => {
		daemonsBrowser = await openBrowser(server.port);
		const frame = await daemonsBrowser.waitForFrame(
			(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "hub-b"),
			"merged daemons on open",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const names = new Set(frame.daemons.map((d) => d.name));
		expect(names).toEqual(new Set(["hub-a", "hub-b", "shared", "only-b"]));
	});

	test("aggregated daemons: full-replace per daemon drops disappeared entries", async () => {
		// The second daemon's next frame drops "only-b"; the merged frame must
		// lose it while keeping the second daemon's remaining entry and the first's roster.
		const daemonB = daemonsById.get(daemonsBId);
		if (!daemonB) throw new Error("second daemon missing");
		daemonB.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
			type: "daemons",
			daemons: [
				daemonInfo("hub-b", OTHER_CWD, { pid: 2221 }),
				daemonInfo("shared", FAKE_CWD, { pid: 2222 }),
			],
		});
		const frame = await daemonsBrowser.waitForFrame(
			(f) => f.type === "daemons" && !f.daemons.some((d) => d.name === "only-b"),
			"full-replace merged frame",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const names = new Set(frame.daemons.map((d) => d.name));
		expect(names.has("hub-b")).toBe(true);
		expect(names.has("shared")).toBe(true);
		expect(names.has("only-b")).toBe(false);
	});

	test("aggregated daemons: per-daemon frames are stripped from proxy pipes", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await attachBrowser(browser, remoteDaemon, remoteEntry.daemonId);
		// The first daemon refreshes its broker roster with a new entry; its pipe
		// carries it too, but the browser must only see the merged broadcast.
		remoteDaemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
			type: "daemons",
			daemons: [
				daemonInfo("hub-a", FAKE_CWD, { pid: 1111 }),
				daemonInfo("shared", FAKE_CWD, { pid: 1112 }),
				daemonInfo("hub-c", FAKE_CWD, { pid: 1113 }),
			],
		});
		const frame = await browser.waitForFrame(
			(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "hub-c"),
			"merged frame with hub-c",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const names = new Set(frame.daemons.map((d) => d.name));
		expect(names.has("hub-c")).toBe(true);
		expect(names.has("hub-b")).toBe(true);
		// No raw per-daemon frame leaked: every daemons frame this browser saw
		// carries the second daemon's entry (a forwarded first-daemon-only frame would not).
		for (const f of browser.frames) {
			if (f.type !== "daemons") continue;
			expect(f.daemons.some((d) => d.name === "hub-b")).toBe(true);
		}
		browser.close();
	});

	test("aggregated daemons: registry removal evicts the second daemon from the cache", async () => {
		expect(server.registry.remove(daemonsBId)).toBe(true);
		const frame = await daemonsBrowser.waitForFrame(
			(f) => f.type === "daemons" && !f.daemons.some((d) => d.name === "hub-b"),
			"evicted merged frame",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const names = new Set(frame.daemons.map((d) => d.name));
		expect(names.has("hub-a")).toBe(true);
		expect(names.has("hub-c")).toBe(true);
		expect(names.has("hub-b")).toBe(false);
		expect(names.has("only-b")).toBe(false);
		dropDaemon(daemonsBId);
	});

	test("remove evicts a remote daemon and broadcasts a roster without it", async () => {
		// A fresh entry so the shared remoteEntry fixture stays intact for earlier tests.
		const body = await enrollRemote("removable");
		const removableId = body.entry.daemonId;
		const browser = await openBrowser(server.port);
		await browser.waitForFrame(
			(f) => f.type === "roster" && f.daemons.some((d) => d.daemonId === removableId),
			"roster with removable",
		);
		await browser.send({ type: "remove", daemonId: removableId });
		const roster = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && !f.daemons.some((d) => d.daemonId === removableId),
				"roster without removable",
			),
		);
		expect(roster.daemons.some((d) => d.daemonId === removableId)).toBe(false);
		expect(server.registry.get(removableId)).toBeUndefined();
	});

	test("remove of an unknown daemon answers an error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "remove", daemonId: "d999" });
		const frame = await browser.waitForFrame(
			(f) =>
				f.type === "error" && typeof f.error === "string" && f.error.includes("unknown daemon"),
			"remove unknown error",
		);
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("unknown daemon");
	});

	test("stop of an attached spawned daemon closes its pipe, broadcasts asleep with no pid/uptime, and reports no connection loss", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		spawnedByEdge = null; // the wait below must observe the NEW spawn
		await browser.send({ type: "spawn", cwd: FAKE_CWD });
		const spawned = await waitFor(
			() => {
				const e = spawnedByEdge;
				return e && server.registry.get(e.daemonId)?.status === "ready" ? e : null;
			},
			4000,
			"stop-test spawn ready",
		);
		const id = spawned.daemonId;
		const daemon = daemonsById.get(id);
		if (!daemon) throw new Error("spawned daemon did not pair");
		const streamId = await attachBrowser(browser, daemon, id);

		await browser.send({ type: "stop", daemonId: id });
		const roster = asRoster(
			await browser.waitForFrame(
				(f) =>
					f.type === "roster" && f.daemons.some((d) => d.daemonId === id && d.status === "asleep"),
				"asleep roster",
			),
		);
		const entry = roster.daemons.find((d) => d.daemonId === id)!;
		expect(entry.status).toBe("asleep");
		expect(entry.pid).toBeUndefined();
		expect(entry.uptime).toBeUndefined();
		expect(entry.readyAt).toBeUndefined();
		// The registry truth matches the broadcast: no stale liveness facts.
		const reg = server.registry.get(id)!;
		expect(reg.status).toBe("asleep");
		expect(reg.pid).toBeUndefined();
		expect(reg.readyAt).toBeUndefined();
		// The browser's pipe is closed on the daemon at stop time, with no
		// phantom "daemon connection lost" on the browser.
		await waitFor(
			() =>
				controlsOf(daemon, "stream_close").some((e) => e.streamId === streamId) ? "closed" : null,
			5000,
			"stream_close on stop",
		);
		await sleep(100);
		expect(
			browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
		).toBe(false);
		dropDaemon(id);
		browser.close();
	});

	test("stop surfaces the error frame but still flips the entry to asleep when the terminate fails", async () => {
		const stopMe2 = server.registry.create({
			name: "stop-me-2",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "local",
			status: "ready",
			pid: 4321,
			readyAt: Date.now() - 30_000,
		});
		const origStop = server.supervisor.stop.bind(server.supervisor);
		server.supervisor.stop = async () => {
			throw new Error("stop boom");
		};
		try {
			const browser = await openBrowser(server.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "stop", daemonId: stopMe2.daemonId });
			const error = await browser.waitForFrame(
				(f) => f.type === "error" && String(f.error).includes("stop boom"),
				"stop error frame",
			);
			expect(error.type).toBe("error");
			// The entry must not stay "ready" forever: the status flip happens
			// even on terminate failure, and the broadcast carries no pid/uptime.
			const roster = asRoster(
				await browser.waitForFrame(
					(f) =>
						f.type === "roster" &&
						f.daemons.some((d) => d.daemonId === stopMe2.daemonId && d.status === "asleep"),
					"asleep roster after failed stop",
				),
			);
			const entry = roster.daemons.find((d) => d.daemonId === stopMe2.daemonId)!;
			expect(entry.status).toBe("asleep");
			expect(entry.pid).toBeUndefined();
			expect(entry.uptime).toBeUndefined();
			const reg = server.registry.get(stopMe2.daemonId)!;
			expect(reg.status).toBe("asleep");
			expect(reg.pid).toBeUndefined();
			expect(reg.readyAt).toBeUndefined();
			browser.close();
		} finally {
			server.supervisor.stop = origStop;
		}
	});

	test("attach to an unpaired remote answers the C10 error frame and never attaches", async () => {
		const body = await enrollRemote("unpaired-remote");
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "attach", sessionId: body.entry.daemonId });
		const err = await browser.waitForFrame(
			(f) =>
				f.type === "error" &&
				f.error ===
					"remote session unpaired-remote is not connected; start it on its host (see omp-web enroll)",
			"C10 unpaired remote error",
		);
		expect(err.type).toBe("error");
		expect(
			browser.frames.some((f) => f.type === "attached" && f.sessionId === body.entry.daemonId),
		).toBe(false);
		browser.close();
	});

	test("replaying a command across a generation change is refused, not re-run", async () => {
		const body = await enrollRemote("replay-remote");
		const replayId = body.entry.daemonId;
		const first = await connectDaemon(replayId, body.enrollment.generation, body.enrollment.token);
		await waitFor(
			() => (server.registry.get(replayId)?.status === "ready" ? "ready" : null),
			5000,
			"replay remote ready",
		);
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await attachBrowser(browser, first, replayId);
		// The daemon receives the call and never answers it.
		await browser.send({ type: "call", id: "replay-1", method: "prompt", args: ["once"] });
		await waitFor(
			() => (commandsWithId(first, "replay-1").length > 0 ? "sent" : null),
			5000,
			"replay-1 at first generation",
		);
		// The daemon restarts: a new generation is minted, the old pair is dropped.
		const next = enrollSessionCredential(server.transport, server.registry, replayId);
		const second = await connectDaemon(replayId, next.generation, next.credential);
		// The browser re-attaches on the new generation and replays the call.
		await attachBrowser(browser, second, replayId);
		await browser.send({ type: "call", id: "replay-1", method: "prompt", args: ["once"] });
		const refused = await browser.waitForFrame(
			(f) => f.type === "call_result" && f.id === "replay-1",
			"refused replay",
		);
		if (refused.type !== "call_result") throw new Error("expected call_result");
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/daemon restarted before this command was answered/);
		// The replay never reached the new generation, and the first saw it only once.
		expect(commandsWithId(second, "replay-1")).toHaveLength(0);
		expect(commandsWithId(first, "replay-1")).toHaveLength(1);
		browser.close();
	});

	test("allowlist accepts add_project and remove_project (their own validation errors, not the allowlist rejection)", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// Neither command may be rejected as an unknown browser command.
		await browser.send({ type: "add_project" });
		const addErr = await browser.waitForFrame(
			(f) => f.type === "error" && f.error === "add_project: missing path",
			"add_project missing path",
		);
		expect(addErr.type).toBe("error");
		await browser.send({ type: "remove_project" });
		const rmErr = await browser.waitForFrame(
			(f) => f.type === "error" && f.error === "remove_project: missing projectId",
			"remove_project missing projectId",
		);
		expect(rmErr.type).toBe("error");
		expect(
			browser.frames.filter(
				(f) => f.type === "error" && f.error === "fleet edge: use spawn/stop/roster",
			),
		).toHaveLength(0);
	});

	test("add_project registers a project (broadcast) and dedup answers an error frame naming the existing projectId", async () => {
		const repoDir = join(tmp, "edge-add-project-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "add_project", path: repoDir });
		const frame = await browser.waitForFrame(
			(f) =>
				f.type === "registered_projects" &&
				f.projects.some((p) => p.path === realpathSync(repoDir)),
			"registered_projects broadcast",
		);
		if (frame.type !== "registered_projects") throw new Error("expected registered_projects");
		const project = frame.projects.find((p) => p.path === realpathSync(repoDir))!;
		expect(project).toMatchObject({ path: realpathSync(repoDir), name: "edge-add-project-repo" });
		expect(project.projectId).toMatch(/^p\d+$/);
		// The default workspace is auto-registered: a roster broadcast shows the
		// asleep main-checkout entry, tagged with the project id and with NO
		// worktreeOf (main checkouts are the repo itself, never a managed worktree).
		const rosterFrame = await browser.waitForFrame(
			(f) =>
				f.type === "roster" &&
				f.daemons.some(
					(d) =>
						d.projectId === project.projectId &&
						d.cwd === realpathSync(repoDir) &&
						d.status === "asleep",
				),
			"roster broadcast with default workspace",
		);
		const main = asRoster(rosterFrame).daemons.find((d) => d.projectId === project.projectId);
		expect(main).toBeDefined();
		expect(main!.cwd).toBe(realpathSync(repoDir));
		expect(main!.mode).toBe("spawned");
		expect(main!.status).toBe("asleep");
		expect(main!.worktreeOf).toBeUndefined();
		expect(main!.lastSessionFile).toBeUndefined();
		// Dedup: registering the same realpath again answers an error frame
		// naming the existing projectId.
		await browser.send({ type: "add_project", path: repoDir });
		const dup = await browser.waitForFrame(
			(f) =>
				f.type === "error" && typeof f.error === "string" && f.error.includes(project.projectId),
			"add_project dedup error",
		);
		if (dup.type !== "error") throw new Error("expected error");
		expect(dup.error).toContain("already registered");
		expect(server.registry.projects().filter((p) => p.path === realpathSync(repoDir))).toHaveLength(
			1,
		);
		// The dedup answered an error and registered nothing: the roster
		// still holds exactly the first add_project's default workspace.
		expect(server.registry.list().filter((e) => e.cwd === realpathSync(repoDir))).toHaveLength(1);
		try {
			server.registry.removeProject(project.projectId);
		} catch {
			// Already clean.
		}
	});

	test("add_project with start:true spawns on the project path, passes template/labels, and tags the entry's projectId", async () => {
		const repoDir = join(tmp, "edge-add-project-spawn-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const before = spawnInits.length;
		spawnedByEdge = null; // the wait below must observe the NEW spawn
		await browser.send({
			type: "add_project",
			path: repoDir,
			start: true,
			template: "local",
			labels: ["env=prod"],
		});
		// The spawn + projectId tag land asynchronously after the broadcast.
		const tagged = await waitFor(
			() => {
				const project = server.registry.projects().find((p) => p.path === realpathSync(repoDir));
				const entry = spawnedByEdge ? server.registry.get(spawnedByEdge.daemonId) : undefined;
				return project && entry && entry.projectId === project.projectId
					? { project, entry }
					: null;
			},
			5000,
			"spawned entry tagged with projectId",
		);
		expect(spawnInits.length).toBe(before + 1);
		const init = spawnInits[spawnInits.length - 1];
		expect(init.cwd).toBe(realpathSync(repoDir));
		expect(init.template).toBe("local");
		expect(init.labels).toEqual(["env=prod"]);
		expect(tagged.entry.cwd).toBe(realpathSync(repoDir));
		expect(tagged.entry.mode).toBe("spawned");
		// Cleanup: drop the daemon and its entry.
		await server.supervisor.prune(tagged.entry.daemonId);
		dropDaemon(tagged.entry.daemonId);
		server.registry.remove(tagged.entry.daemonId);
		server.registry.removeProject(tagged.project.projectId);
		browser.close();
	});

	test("remove_project refuses while daemons reference the project and removes once free", async () => {
		const repoDir = join(tmp, "edge-rm-project-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const project = await server.registry.addProject(repoDir);
		// A real session file means this entry has transcripts, so
		// remove_project must block on it.
		const ref = server.registry.create({
			name: "ref",
			cwd: realpathSync(repoDir),
			project: project.name,
			labels: [],
			mode: "spawned",
			template: "local",
			status: "asleep",
			lastSessionFile: join(tmp, "rm-session.json"),
			projectId: project.projectId,
		});
		try {
			const browser = await openBrowser(server.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "remove_project", projectId: project.projectId });
			const err = await browser.waitForFrame(
				(f) => f.type === "error" && typeof f.error === "string" && f.error.includes(ref.daemonId),
				"remove_project blocker error",
			);
			if (err.type !== "error") throw new Error("expected error");
			expect(err.error).toContain("in use by daemons");
			expect(server.registry.projects().some((p) => p.projectId === project.projectId)).toBe(true);
			// Once the referencing daemon is gone, removal succeeds and the
			// registered_projects broadcast drops the project.
			server.registry.remove(ref.daemonId);
			await browser.send({ type: "remove_project", projectId: project.projectId });
			await browser.waitForFrame(
				(f) =>
					f.type === "registered_projects" &&
					!f.projects.some((p) => p.projectId === project.projectId),
				"registered_projects after remove",
			);
			expect(server.registry.projects().some((p) => p.projectId === project.projectId)).toBe(false);
			browser.close();
		} finally {
			server.registry.remove(ref.daemonId);
			try {
				server.registry.removeProject(project.projectId);
			} catch {
				// Already removed.
			}
		}
	});
});

describe("edge pure helpers", () => {
	test("toRosterEntry strips token/endpoint and computes uptime + pid", () => {
		const now = Date.now();
		const entry: RegistryEntry = {
			daemonId: "d1",
			name: "n",
			cwd: "/x",
			project: "x",
			labels: ["a=b"],
			mode: "spawned",
			status: "ready",
			template: "local",
			registeredAt: now - 200_000,
			pid: 1234,
			readyAt: now - 50_000,
		};
		const roster = toRosterEntry(entry);
		expect(roster.daemonId).toBe("d1");
		expect(roster.pid).toBe(1234);
		expect(roster.uptime).toBeGreaterThanOrEqual(49);
		expect(roster.uptime).toBeLessThanOrEqual(51);
		expect(roster).not.toHaveProperty("token");
		expect(roster).not.toHaveProperty("endpoint");
		expect(roster).not.toHaveProperty("registeredAt");
		expect(roster).not.toHaveProperty("template");
		// An asleep daemon has no live process: the roster must not carry a
		// pid or an uptime growing since registeredAt for a dead daemon.
		const asleep = toRosterEntry({ ...entry, readyAt: undefined, status: "asleep" });
		expect(asleep.uptime).toBeUndefined();
		expect(asleep.pid).toBeUndefined();
		expect(asleep.readyAt).toBeUndefined();
		// ... and the registry entry's stale liveness facts are skipped even
		// when still set (a pure-function guard alongside setStatus's clear).
		const asleepStale = toRosterEntry({ ...entry, status: "asleep" });
		expect(asleepStale.uptime).toBeUndefined();
		expect(asleepStale.pid).toBeUndefined();
		expect(asleepStale.readyAt).toBeUndefined();
		// Never-ready but alive entries still fall back to registeredAt.
		const neverReady = toRosterEntry({ ...entry, readyAt: undefined, status: "connecting" });
		expect(neverReady.uptime).toBeGreaterThanOrEqual(199);
		expect(neverReady.uptime).toBeLessThanOrEqual(201);
	});

	test("toRosterEntry serializes branch and git when present, omits when absent", () => {
		const entry: RegistryEntry = {
			daemonId: "d2",
			name: "n",
			cwd: "/srv/repos/acme-wt-feature",
			project: "acme",
			labels: [],
			mode: "spawned",
			status: "ready",
			branch: "feature/x",
			git: { added: 2, modified: 3, deleted: 1, untracked: 4 },
			registeredAt: Date.now(),
		};
		const roster = toRosterEntry(entry);
		expect(roster.branch).toBe("feature/x");
		expect(roster.git).toEqual({ added: 2, modified: 3, deleted: 1, untracked: 4 });
		// Old entries (pre-git-state) never carry the fields; a stale probe
		// that cleared them must serialize without them too.
		const bare = toRosterEntry({ ...entry, branch: undefined, git: undefined });
		expect(bare).not.toHaveProperty("branch");
		expect(bare).not.toHaveProperty("git");
	});

	test("toRosterEntry serializes sessionTitle when present, omits when absent", () => {
		const entry: RegistryEntry = {
			daemonId: "d4",
			name: "n",
			cwd: "/srv/repos/acme-wt-feature",
			project: "acme",
			labels: [],
			mode: "spawned",
			status: "ready",
			sessionTitle: "Fix the fleet sidebar",
			registeredAt: Date.now(),
		};
		expect(toRosterEntry(entry).sessionTitle).toBe("Fix the fleet sidebar");
		// A cleared title (probe found nothing) must serialize without the key.
		const cleared = toRosterEntry({ ...entry, sessionTitle: undefined });
		expect(cleared).not.toHaveProperty("sessionTitle");
	});

	test("toRosterEntry serializes sessionEmpty only when true", () => {
		const base: RegistryEntry = {
			daemonId: "d4b",
			name: "n",
			cwd: "/srv/repos/acme-wt-feature",
			project: "acme",
			labels: [],
			mode: "spawned",
			status: "ready",
			registeredAt: Date.now(),
		};
		const empty = toRosterEntry({ ...base, sessionEmpty: true });
		expect(empty.sessionEmpty).toBe(true);
		// Untitled+not-empty and absent both serialize without the key.
		expect(toRosterEntry({ ...base, sessionEmpty: false })).not.toHaveProperty("sessionEmpty");
		expect(toRosterEntry(base)).not.toHaveProperty("sessionEmpty");
	});

	test("toRosterEntry sets managed only for cwds realpath-under the workspaceDir", () => {
		const tmpRoot = tempDir("omp-web-edge-managed-");
		const ws = join(tmpRoot, "workspaces");
		const inside = join(ws, "repo", "feature");
		mkdirSync(inside, { recursive: true });
		const outside = join(tmpRoot, "outside");
		mkdirSync(outside, { recursive: true });
		const base: RegistryEntry = {
			daemonId: "d9",
			name: "n",
			cwd: "",
			project: "x",
			labels: [],
			mode: "spawned",
			status: "asleep",
			registeredAt: Date.now(),
		};
		expect(toRosterEntry({ ...base, cwd: inside }, ws).managed).toBe(true);
		// Outside the workspace root: absent (older-edge behavior), never false.
		expect(toRosterEntry({ ...base, cwd: outside }, ws)).not.toHaveProperty("managed");
		// A prefix-lookalike sibling (tmp/workspaces-other) is NOT under ws.
		expect(toRosterEntry({ ...base, cwd: `${ws}-other` }, ws)).not.toHaveProperty("managed");
		// No workspaceDir argument: absent, whatever the cwd.
		expect(toRosterEntry({ ...base, cwd: inside })).not.toHaveProperty("managed");
		// Empty cwd (remote-style entries) never carry it either.
		expect(toRosterEntry(base, ws)).not.toHaveProperty("managed");
	});

	test("shouldDropFrame guards the cap boundary", () => {
		const cap = 4 * 1024 * 1024;
		expect(shouldDropFrame(0, cap)).toBe(false);
		expect(shouldDropFrame(cap, cap)).toBe(false);
		expect(shouldDropFrame(cap + 1, cap)).toBe(true);
		expect(shouldDropFrame(1024, 1024)).toBe(false);
		expect(shouldDropFrame(1025, 1024)).toBe(true);
	});
});
