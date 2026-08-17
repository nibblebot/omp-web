/**
 * Fleet edge wire-contract tests: the browser SSE edge (/events + /command)
 * and the /ctl routes against the real server mount (startFleet), with a
 * FAKE omp-session that serves the OMP_PROTO 2 wire contract. The
 * order-dependent shared fixtures (browserA/pipeA, release/retain/respawn
 * counters, spawn capture, the second daemon for aggregated-daemons) stay
 * together here; the standalone pipe/replay tests live in edge-pipe.test.ts
 * and the worktree commands in edge-worktrees.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_PROTO } from "../shared/protocol";
import { shouldDropFrame, toRosterEntry } from "./edge";
import type { RegistryEntry } from "./registry";
import { Registry } from "./registry";
import { startFleet, type FleetServer } from "./server";
import {
	FAKE_CWD,
	FAKE_TOKEN,
	allBrowsers,
	asRoster,
	BrowserSocket,
	daemonInfo,
	openBrowser,
	sleep,
	startFakeSession,
	waitFor,
	type FakeSession,
	type FakeStreamSeen,
	cleanupTempDirs,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

/** Second fake omp-session's cwd — different projectDir for cross-daemon merge tests. */
const OTHER_CWD = "/tmp/other-proj";

describe("fleet edge", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let rootsDir: string;
	let server: FleetServer;
	let fake: FakeSession;
	let remoteEntry: RegistryEntry;
	let spawnedEntry: RegistryEntry;
	let browserA: BrowserSocket;
	let pipeA: FakeStreamSeen;
	let releases = 0;
	let retains = 0;
	let respawns = 0;
	/** supervisor.spawn invocations captured by the wrapper (labels passthrough tests). */
	let spawnInits: Array<{ cwd: string; template?: string; labels?: string[] }> = [];
	/** The entry the wrapper's last spawn returned (its cwd must match the fake's hello cwd). */
	let spawnedByEdge: RegistryEntry | null = null;
	// Aggregated daemons panel tests (second fake + its registered entry).
	let fake2: FakeSession;
	let daemonsEntryB: RegistryEntry;
	let daemonsBrowser: BrowserSocket;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		rootsDir = join(tmp, "roots");
		mkdirSync(rootsDir, { recursive: true });
		// A fake repo (git is not needed: an unreadable .git degrades to a
		// plain entry, which is exactly what list_projects must return).
		mkdirSync(join(rootsDir, "proj", ".git"), { recursive: true });
		// The spawn fixture: the fake omp-session's hello_ok.cwd is FAKE_CWD, and
		// the connector rejects a cwd mismatch — so edge spawns must use it.
		mkdirSync(FAKE_CWD, { recursive: true });
		fake = startFakeSession();
		writeFileSync(
			configPath,
			JSON.stringify({
				roots: [rootsDir],
				templates: {
					local: {
						command: `printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}' && while :; do sleep 0.05; done`,
					},
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
		server = await startFleet({ port: 0, statePath, configPath });
		// Count supervisor.respawn calls across the wake tests (real impl runs underneath).
		const origRespawn = server.supervisor.respawn.bind(server.supervisor);
		server.supervisor.respawn = async (entry: RegistryEntry) => {
			respawns++;
			await origRespawn(entry);
		};
		// Capture supervisor.spawn inits for the labels-passthrough tests.
		const origSpawn = server.supervisor.spawn.bind(server.supervisor);
		server.supervisor.spawn = async (init: {
			cwd: string;
			template?: string;
			name?: string;
			labels?: string[];
		}) => {
			spawnInits.push({ cwd: init.cwd, template: init.template, labels: init.labels });
			spawnedByEdge = await origSpawn(init);
			return spawnedByEdge;
		};
	});

	afterAll(async () => {
		for (const browser of allBrowsers) browser.close();
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
		if (fake2 !== undefined) fake2.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("GET /ctl/templates returns the config template names", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/templates`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown;
		expect(body).toEqual(["local"]);
	});

	test("GET /ctl/sessions/{id}/stderr 404s for unknown daemons", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions/d999/stderr`);
		expect(res.status).toBe(404);
	});

	test("POST /ctl/add registers a remote daemon and the connector reaches ready", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "added", url: fake.url, token: FAKE_TOKEN }),
		});
		expect(res.status).toBe(200);
		remoteEntry = (await res.json()) as RegistryEntry;
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
			expect(typeof d.uptime).toBe("number");
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

	test("daemon_status is broadcast on connector status transitions", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// Re-dial so the status machine runs connecting → … → ready again.
		server.connector.disconnect(remoteEntry.daemonId);
		server.connector.connect(remoteEntry.daemonId);
		const status = await browser.waitForFrame(
			(f) =>
				f.type === "daemon_status" && f.daemonId === remoteEntry.daemonId && f.status === "ready",
			"daemon_status ready",
		);
		if (status.type !== "daemon_status") throw new Error("expected daemon_status");
		expect(status.daemonId).toBe(remoteEntry.daemonId);
		expect(status.status).toBe("ready");
		await waitFor(
			() => (server.registry.get(remoteEntry.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"remote ready again",
		);
	});

	test("POST /command with an unknown client id is a 400", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/command`, {
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
		expect(frame.projects).toContainEqual({
			name: "proj",
			path: join(rootsDir, "proj"),
			isWorktree: false,
		});
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
		// The real supervisor runs underneath: wait until the child dials ready.
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
		// Phase 6: the mux-era commands and detach were removed from the
		// protocol. A stale client sending them — or any other non-allowlisted
		// type — must get the edge rejection instead of a daemon forward.
		// The removed type names are assembled so the identifiers never
		// appear in this file.
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

	test("attach opens a daemon /events pipe (Bearer), forwards priming with sessionId rewritten, forwards the gated hello_ok", async () => {
		const origRelease = server.connector.release.bind(server.connector);
		const origRetain = server.connector.retain.bind(server.connector);
		server.connector.release = (daemonId: string) => {
			releases++;
			origRelease(daemonId);
		};
		server.connector.retain = (daemonId: string) => {
			retains++;
			origRetain(daemonId);
		};
		browserA = await openBrowser(server.port);
		await browserA.waitForFrame((f) => f.type === "roster", "roster");
		const before = fake.streamCount();
		await browserA.send({ type: "attach", sessionId: remoteEntry.daemonId });
		const attached = await browserA.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"attached (daemonId)",
		);
		expect(attached.type).toBe("attached");
		// The pipe is a dedicated daemon /events stream carrying the Bearer
		// header — daemon auth is HTTP-level now, no hello on the wire.
		await waitFor(() => (fake.streamCount() === before + 1 ? "pipe" : null), 5000, "pipe stream");
		pipeA = fake.streams()[before];
		expect(pipeA.authHeader).toBe(`Bearer ${FAKE_TOKEN}`);
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
		// Finding #61: the proto-gated hello_ok is FORWARDED (not swallowed)
		// so the browser's own proto check runs in roster mode too.
		const hello = await browserA.waitForFrame(
			(f) => f.type === "hello_ok",
			"hello_ok (proto-gated)",
		);
		expect((hello as { proto?: unknown }).proto).toBe(OMP_PROTO);
		// Every forwarded session-scoped frame carries the daemonId.
		for (const f of browserA.frames) {
			if ("sessionId" in f) expect(f.sessionId).toBe(remoteEntry.daemonId);
		}
	});

	test("browser calls are forwarded verbatim and call_result routes back", async () => {
		await browserA.send({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
		const result = await browserA.waitForFrame(
			(f) => f.type === "call_result" && f.id === "c1",
			"call_result c1",
		);
		if (result.type !== "call_result") throw new Error("expected call_result");
		expect(result.ok).toBe(true);
		// The command reached the daemon's POST /command (with no hello before it).
		await waitFor(
			() => fake.received.find((m) => (m as { id?: string }).id === "c1") ?? null,
			5000,
			"call c1 at fake",
		);
		expect(fake.received.find((m) => (m as { id?: string }).id === "c1")).toEqual({
			type: "call",
			id: "c1",
			method: "prompt",
			args: ["hello"],
		});
	});

	test("a second browser attach gets an independent pipe and its own priming", async () => {
		const browserB = await openBrowser(server.port);
		await browserB.waitForFrame((f) => f.type === "roster", "roster");
		const before = fake.streamCount();
		await browserB.send({ type: "attach", sessionId: remoteEntry.daemonId });
		await browserB.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"second attached",
		);
		await waitFor(
			() => (fake.streamCount() === before + 1 ? "pipe B" : null),
			5000,
			"pipe B stream",
		);
		const pipeB = fake.streams()[before];
		expect(pipeB).not.toBe(pipeA);
		await browserB.waitForFrame(
			(f) => f.type === "history" && f.sessionId === remoteEntry.daemonId,
			"history B",
		);
		// Routing is per-browser: each browser's command reaches the daemon and
		// answers on its own stream (the daemon broadcasts; pendings dedup by id).
		await browserA.send({ type: "call", id: "a2", method: "getQueuedMessages" });
		await browserB.send({ type: "call", id: "b2", method: "getQueuedMessages" });
		await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "a2", "a2 result");
		await browserB.waitForFrame((f) => f.type === "call_result" && f.id === "b2", "b2 result");
		await waitFor(
			() => (fake.received.some((m) => (m as { id?: string }).id === "a2") ? "a2 at daemon" : null),
			5000,
			"a2 at daemon",
		);
		await waitFor(
			() => (fake.received.some((m) => (m as { id?: string }).id === "b2") ? "b2 at daemon" : null),
			5000,
			"b2 at daemon",
		);
	});

	test("browser close closes the pipe and releases the connector retain", async () => {
		// Phase 6: the detach command is gone; browser close is the teardown
		// path (the edge closes the pipe + releases the retain itself).
		browserA.close();
		await waitFor(() => (pipeA.closed ? "closed" : null), 5000, "fake observes pipe close");
		await waitFor(() => (releases >= 1 ? "released" : null), 5000, "release call");
		expect(releases).toBe(1);
		expect(retains).toBe(2); // pipe A + pipe B
		// The idle-drop timer (60s) has not fired: the connector socket is alive.
		expect(server.connector.isConnected(remoteEntry.daemonId)).toBe(true);
		expect(
			browserA.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
		).toBe(false);
	});

	test("an unattached call fails fast with an id-keyed call_result, not a bare error frame (finding #59)", async () => {
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

	test("clientId rebind closes the previous live stream and broadcasts ring exactly once (finding #25)", async () => {
		const sharedId = crypto.randomUUID();
		const oldBrowser = new BrowserSocket(server.port, sharedId);
		allBrowsers.push(oldBrowser);
		await oldBrowser.open();
		await oldBrowser.waitForFrame((f) => f.type === "roster", "roster");
		const beforePipe = fake.streamCount();
		await oldBrowser.send({ type: "attach", sessionId: remoteEntry.daemonId });
		await oldBrowser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"attached (rebind old)",
		);
		await waitFor(
			() => (fake.streamCount() === beforePipe + 1 ? "pipe" : null),
			5000,
			"rebind pipe stream",
		);
		const oldPipe = fake.streams()[beforePipe];

		// Rebind: a SECOND /events open with the SAME clientId while the old
		// stream is still live (the old EventSource's cancel has not fired).
		const newBrowser = new BrowserSocket(server.port, sharedId);
		allBrowsers.push(newBrowser);
		await newBrowser.open();
		await newBrowser.waitForFrame((f) => f.type === "roster", "roster");

		// The old stream is torn down: its body ends and its pipe closes.
		await oldBrowser.end(5000);
		await waitFor(() => (oldPipe.closed ? "closed" : null), 5000, "old pipe closed after rebind");

		// A broadcast after the rebind reaches the new stream EXACTLY once
		// (pre-fix both streams sat in #browsers for one client → two ring
		// entries + a double delivery on the rebound stream). The roster
		// broadcast via registry.update is single-source (emitDaemons would be
		// ingested once per still-live pipe from earlier tests).
		const oldFramesAtEnd = oldBrowser.frames.length;
		const seenBefore = newBrowser.frames.length;
		server.registry.update(remoteEntry.daemonId, {});
		await waitFor(
			() => {
				const hit = newBrowser.frames.slice(seenBefore).find((f) => f.type === "roster");
				return hit ?? null;
			},
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

	test("attach to an asleep spawned daemon respawns it, waits ready, then pipes", async () => {
		const browserC = await openBrowser(server.port);
		await browserC.waitForFrame((f) => f.type === "roster", "roster");
		const before = fake.streamCount();
		const respawnsBefore = respawns;
		await browserC.send({ type: "attach", sessionId: spawnedEntry.daemonId });
		await browserC.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === spawnedEntry.daemonId,
			"attached (spawned)",
		);
		expect(respawns).toBe(respawnsBefore + 1);
		const entryNow = server.registry.get(spawnedEntry.daemonId);
		expect(entryNow?.status).toBe("ready");
		expect(server.connector.isConnected(spawnedEntry.daemonId)).toBe(true);
		// The wake path produced a connector dial + this browser's pipe.
		await waitFor(
			() => (fake.streamCount() === before + 2 ? "connector+pipe" : null),
			5000,
			"connector + pipe streams",
		);
		const pipeC = fake.streams()[before + 1];
		expect(pipeC.authHeader).toBe(`Bearer ${entryNow?.token}`);
		await browserC.waitForFrame(
			(f) => f.type === "history" && f.sessionId === spawnedEntry.daemonId,
			"history C",
		);
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
		await browser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === entry.daemonId,
			"attached (spawned2)",
		);
		expect(respawns).toBe(respawnsBefore + 1);
		expect(server.registry.get(entry.daemonId)?.status).toBe("ready");
	});

	test("GET /ctl/sessions/{id}/stderr returns text for spawned and 404 for remote", async () => {
		const spawned = await fetch(
			`http://127.0.0.1:${server.port}/ctl/sessions/${spawnedEntry.daemonId}/stderr`,
		);
		expect(spawned.status).toBe(200);
		const body = (await spawned.json()) as { text?: unknown };
		expect(typeof body.text).toBe("string");
		const remote = await fetch(
			`http://127.0.0.1:${server.port}/ctl/sessions/${remoteEntry.daemonId}/stderr`,
		);
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
		const root = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type") ?? "").toContain("text/html");
		const probe = await fetch(`http://127.0.0.1:${server.port}/__omp_web_placeholder_probe__`);
		expect(probe.status).toBe(200);
		expect(await probe.text()).toContain("omp-web");
	});

	test("aggregated daemons: merge across daemons with same-projectDir preference", async () => {
		// A second fake omp-session with a different cwd, registered like any remote daemon.
		fake2 = startFakeSession({ cwd: OTHER_CWD });
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "daemons-b",
				url: fake2.url,
				token: FAKE_TOKEN,
				cwd: OTHER_CWD,
			}),
		});
		expect(res.status).toBe(200);
		daemonsEntryB = (await res.json()) as RegistryEntry;
		await waitFor(
			() => (server.registry.get(daemonsEntryB.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"second daemon ready",
		);
		// A browser to funnel the emits into the cache (update broadcasts are observable).
		const funnel = await openBrowser(server.port);
		await funnel.waitForFrame((f) => f.type === "roster", "roster");
		// fake (cwd FAKE_CWD) reports its own roster; fake2 (cwd OTHER_CWD)
		// reports its own PLUS a stale cross-cwd entry for FAKE_CWD arriving later.
		fake.emitDaemons([
			daemonInfo("hub-a", FAKE_CWD, { pid: 1111 }),
			daemonInfo("shared", FAKE_CWD, { pid: 1112 }),
		]);
		fake2.emitDaemons([
			daemonInfo("hub-b", OTHER_CWD, { pid: 2221 }),
			daemonInfo("shared", FAKE_CWD, { pid: 2222 }),
			daemonInfo("only-b", OTHER_CWD, { pid: 2223 }),
		]);
		const frame = await funnel.waitForFrame(
			(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "only-b"),
			"merged daemons frame",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const byName = new Map(frame.daemons.map((d) => [d.name, d]));
		expect(byName.get("hub-a")?.pid).toBe(1111);
		expect(byName.get("hub-b")?.pid).toBe(2221);
		expect(byName.get("only-b")?.pid).toBe(2223);
		// Same-projectDir preference: fake (cwd === projectDir) wins the
		// shared key over fake2's later arrival.
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
		// fake2's next frame drops "only-b"; the merged frame must lose it
		// while keeping fake2's remaining entry and fake1's roster.
		fake2.emitDaemons([
			daemonInfo("hub-b", OTHER_CWD, { pid: 2221 }),
			daemonInfo("shared", FAKE_CWD, { pid: 2222 }),
		]);
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
		await browser.send({ type: "attach", sessionId: remoteEntry.daemonId });
		await browser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"attached",
		);
		// The daemon refreshes its broker roster with a new entry; the pipe
		// receives it too, but the browser must only see the merged broadcast.
		fake.emitDaemons([
			daemonInfo("hub-a", FAKE_CWD, { pid: 1111 }),
			daemonInfo("shared", FAKE_CWD, { pid: 1112 }),
			daemonInfo("hub-c", FAKE_CWD, { pid: 1113 }),
		]);
		const frame = await browser.waitForFrame(
			(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "hub-c"),
			"merged frame with hub-c",
		);
		if (frame.type !== "daemons") throw new Error("expected daemons");
		const names = new Set(frame.daemons.map((d) => d.name));
		expect(names.has("hub-c")).toBe(true);
		expect(names.has("hub-b")).toBe(true);
		// No raw per-daemon frame leaked: every daemons frame this browser saw
		// carries fake2's entry (a forwarded fake1-only frame would not).
		for (const f of browser.frames) {
			if (f.type !== "daemons") continue;
			expect(f.daemons.some((d) => d.name === "hub-b")).toBe(true);
		}
	});

	test("aggregated daemons: registry removal evicts the cache", async () => {
		expect(server.registry.remove(daemonsEntryB.daemonId)).toBe(true);
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
		// The removed daemon's tap is gone: a late frame no longer updates the cache.
		fake2.emitDaemons([daemonInfo("zombie", OTHER_CWD, { pid: 9999 })]);
		await sleep(50);
		expect(
			daemonsBrowser.frames.some(
				(f) => f.type === "daemons" && f.daemons.some((d) => d.name === "zombie"),
			),
		).toBe(false);
	});

	test("remove evicts a remote daemon and broadcasts a roster without it", async () => {
		// A fresh entry so the shared remoteEntry fixture stays intact for earlier tests.
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "removable", url: fake.url, token: FAKE_TOKEN }),
		});
		expect(res.status).toBe(200);
		const added = (await res.json()) as RegistryEntry;
		await waitFor(
			() => (server.registry.get(added.daemonId)?.status === "ready" ? "ready" : null),
			5000,
			"removable daemon ready",
		);
		const browser = await openBrowser(server.port);
		await browser.waitForFrame(
			(f) => f.type === "roster" && f.daemons.some((d) => d.daemonId === added.daemonId),
			"roster with removable",
		);
		await browser.send({ type: "remove", daemonId: added.daemonId });
		const roster = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && !f.daemons.some((d) => d.daemonId === added.daemonId),
				"roster without removable",
			),
		);
		expect(roster.daemons.some((d) => d.daemonId === added.daemonId)).toBe(false);
		expect(server.registry.get(added.daemonId)).toBeUndefined();
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

	test("browser allowlist accepts add_project and remove_project (their own validation errors, not the allowlist rejection)", async () => {
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
		// Cleanup: drop the daemon (child runs under the config's template,
		// whose hello cwd FAKE_CWD mismatches this repo — status error is fine).
		await server.supervisor.prune(tagged.entry.daemonId);
		server.registry.remove(tagged.entry.daemonId);
		server.registry.removeProject(tagged.project.projectId);
	});

	test("remove_project refuses while daemons reference the project and removes once free", async () => {
		const repoDir = join(tmp, "edge-rm-project-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const project = await server.registry.addProject(repoDir);
		const ref = server.registry.create({
			name: "ref",
			cwd: realpathSync(repoDir),
			project: project.name,
			labels: [],
			mode: "spawned",
			template: "local",
			status: "asleep",
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
			endpoint: "ws://127.0.0.1:9",
			token: "sekret",
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
		// Never-ready entries fall back to registeredAt.
		const neverReady = toRosterEntry({ ...entry, readyAt: undefined, status: "asleep" });
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

	test("toRosterEntry sets managed only for cwds realpath-under the workspaceDir", () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-managed-"));
		const ws = join(tmp, "workspaces");
		const inside = join(ws, "repo", "feature");
		mkdirSync(inside, { recursive: true });
		const outside = join(tmp, "outside");
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
		rmSync(tmp, { recursive: true, force: true });
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
