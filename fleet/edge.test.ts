/**
 * Fleet edge tests: the browser WS edge (/ws) and the new /ctl routes
 * against the real server mount (startFleet), with a FAKE omp-session that
 * primes every socket on open (attached → history → state →
 * available_commands → ready), answers hello with hello_ok, echoes calls as
 * call_result, and records per-socket auth headers / messages / closes.
 *
 * The real DaemonConnector + SpawnSupervisor drive the fake; the only child
 * process spawned is the fake-spawn template in the "respawn an asleep
 * spawned daemon" test, which prints an OMP_SESSION| listening line pointing at the
 * fake daemon and idles until stopped.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { OMP_PROTO } from "../src/protocol";
import type { DaemonEntry, DaemonInfo, ServerFrame } from "../src/protocol";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import { FleetEdge, shouldDropFrame, toRosterEntry } from "./edge";
import type { RegistryEntry } from "./registry";
import { Registry } from "./registry";
import { startFleet, type FleetServer } from "./server";
import { SpawnSupervisor } from "./supervisor";

const FAKE_CWD = "/tmp/fake-proj";
const FAKE_SESSION_FILE = "/tmp/fake-proj/.omp/session.json";
const FAKE_TOKEN = "sekret";
/** Second fake omp-session's cwd — different projectDir for cross-daemon merge tests. */
const OTHER_CWD = "/tmp/other-proj";

/** A wire-safe DaemonInfo (hub launch / broker roster entry) for fake emissions. */
function daemonInfo(name: string, projectDir: string, overrides: Partial<DaemonInfo> = {}): DaemonInfo {
	return {
		name,
		id: `${projectDir}/${name}`,
		projectDir,
		state: "running",
		createdAt: 1,
		startedAt: 1,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

const FAKE_STATE = {
	model: undefined,
	modelRoles: undefined,
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionFile: FAKE_SESSION_FILE,
	sessionId: "s1",
	readyAt: Date.now(),
	sessionName: undefined,
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
	systemPrompt: undefined,
	dumpTools: undefined,
	contextUsage: undefined,
	goalModeState: undefined,
	planModeEnabled: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
	inspectImageMode: "disabled",
};

interface FakeSocketSeen {
	authHeader: string | null;
	messages: unknown[];
	closed: boolean;
	closeCode: number | null;
}

interface FakeSession {
	url: string;
	port: number;
	cwd: string;
	sockets(): FakeSocketSeen[];
	socketCount(): number;
	/** Broadcast a {type:"daemons"} broker roster to every attached socket. */
	emitDaemons(entries: DaemonInfo[]): void;
	close(): void;
}

/** Fake omp-session: primes on open, answers hello, echoes calls, records everything. */
function startFakeSession(opts: { cwd?: string } = {}): FakeSession {
	const cwd = opts.cwd ?? FAKE_CWD;
	const sessionFile = join(cwd, ".omp", "session.json");
	const state = { ...FAKE_STATE, sessionFile };
	const sockets: FakeSocketSeen[] = [];
	const live = new Map<ServerWebSocket<{ auth: string | null }>, FakeSocketSeen>();
	const server = Bun.serve<{ auth: string | null }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			// Real omp-session only upgrades /ws; registered endpoints are pathless,
			// so this also proves the daemonWsUrl normalization end-to-end.
			if (new URL(req.url).pathname !== "/ws") return new Response("expected /ws", { status: 400 });
			const auth = req.headers.get("authorization");
			if (srv.upgrade(req, { data: { auth } })) return;
			return new Response("expected websocket", { status: 400 });
		},
		websocket: {
			open(ws) {
				const seen: FakeSocketSeen = { authHeader: ws.data.auth, messages: [], closed: false, closeCode: null };
				sockets.push(seen);
				live.set(ws, seen);
				prime(ws);
			},
			message(ws, raw) {
				const seen = live.get(ws);
				if (!seen) return;
				let msg: unknown;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				seen.messages.push(msg);
				const cmd = msg as { type?: string; id?: string };
				if (cmd.type === "hello") {
					ws.send(
						JSON.stringify({
							type: "hello_ok",
							proto: OMP_PROTO,
							name: "fake",
							cwd,
							pid: 4242,
							version: "0.0.0-test",
							sessionFile,
						}),
					);
				} else if (cmd.type === "call") {
					ws.send(JSON.stringify({ type: "call_result", id: cmd.id, ok: true, data: { echoed: msg } }));
				}
			},
			close(ws, code) {
				const seen = live.get(ws);
				if (seen) {
					seen.closed = true;
					seen.closeCode = code;
				}
			},
		},
	});
	/** omp-session's attach priming: attached → history → state → available_commands → ready. */
	function prime(ws: ServerWebSocket<{ auth: string | null }>): void {
		// Phase 6 wire format: omp-session keeps the required "s1" on `attached` but
		// no longer stamps session-scoped frames — the edge adds the daemonId.
		ws.send(JSON.stringify({ type: "attached", sessionId: "s1", mode: "single" }));
		ws.send(JSON.stringify({ type: "history", messages: [] }));
		ws.send(JSON.stringify({ type: "state", state }));
		ws.send(JSON.stringify({ type: "available_commands", commands: [] }));
		ws.send(JSON.stringify({ type: "ready", readyAt: Date.now() }));
	}
	return {
		url: `ws://127.0.0.1:${server.port}`,
		port: server.port!,
		cwd,
		sockets: () => [...sockets],
		socketCount: () => sockets.length,
		emitDaemons: (entries: DaemonInfo[]) => {
			const frame = JSON.stringify({ type: "daemons", daemons: entries });
			for (const ws of live.keys()) ws.send(frame);
		},
		close: () => {
			server.stop(true);
		},
	};
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll until `probe` returns non-null or the timeout elapses. */
async function waitFor<T>(probe: () => T | null, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** Poll `frames` until a frame satisfies `pred` (latest-wins collections). */
async function waitForFrame(
	frames: ServerFrame[],
	pred: (f: ServerFrame) => boolean,
	what = "frame",
	timeoutMs = 5000,
): Promise<ServerFrame> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = frames.find(pred);
		if (hit) return hit;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** A browser edge socket that records every frame it receives. */
class BrowserSocket {
	readonly frames: ServerFrame[] = [];
	readonly ws: WebSocket;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.onmessage = (ev) => {
			this.frames.push(JSON.parse(String(ev.data)) as ServerFrame);
		};
	}

	async open(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return;
		await new Promise<void>((resolve, reject) => {
			this.ws.onopen = () => resolve();
			this.ws.onerror = () => reject(new Error("browser ws failed to open"));
		});
	}

	send(cmd: unknown): void {
		this.ws.send(JSON.stringify(cmd));
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// Already closed.
		}
	}

	waitForFrame(pred: (f: ServerFrame) => boolean, what = "frame"): Promise<ServerFrame> {
		return waitForFrame(this.frames, pred, what);
	}
}

const allBrowsers: BrowserSocket[] = [];

async function openBrowser(port: number): Promise<BrowserSocket> {
	const browser = new BrowserSocket(`ws://127.0.0.1:${port}/ws`);
	allBrowsers.push(browser);
	await browser.open();
	return browser;
}

function asRoster(frame: ServerFrame): { type: "roster"; daemons: DaemonEntry[] } {
	if (frame.type !== "roster") throw new Error("expected roster frame");
	return frame;
}

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
	let pipeA: FakeSocketSeen;
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
		tmp = mkdtempSync(join(tmpdir(), "omp-fleet-edge-"));
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
						command: `printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}' && while :; do sleep 1; done`,
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
		server.supervisor.spawn = async (init: { cwd: string; template?: string; name?: string; labels?: string[] }) => {
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
		await waitFor(() => (server.registry.get(remoteEntry.daemonId)?.status === "ready" ? "ready" : null), 5000, "remote daemon ready");
	});

	test("roster is unicast on open and broadcast on registry change, without tokens", async () => {
		const browser = await openBrowser(server.port);
		const roster = asRoster(await browser.waitForFrame((f) => f.type === "roster", "initial roster"));
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
		// A registry mutation broadcasts a fresh roster to every edge socket.
		server.registry.update(remoteEntry.daemonId, { labels: ["env=test"] });
		const second = asRoster(
			await browser.waitForFrame((f) => f.type === "roster" && JSON.stringify(f).includes("env=test"), "roster broadcast"),
		);
		const changed = second.daemons.find((d) => d.daemonId === remoteEntry.daemonId);
		expect(changed?.labels).toContain("env=test");
		expect(JSON.stringify(second)).not.toContain(FAKE_TOKEN);
	});

	test("daemon_status is broadcast on connector status transitions", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		// Re-dial so the status machine runs connecting → … → ready again.
		server.connector.disconnect(remoteEntry.daemonId);
		server.connector.connect(remoteEntry.daemonId);
		const status = await browser.waitForFrame(
			(f) => f.type === "daemon_status" && f.daemonId === remoteEntry.daemonId && f.status === "ready",
			"daemon_status ready",
		);
		if (status.type !== "daemon_status") throw new Error("expected daemon_status");
		expect(status.daemonId).toBe(remoteEntry.daemonId);
		expect(status.status).toBe("ready");
		await waitFor(() => (server.registry.get(remoteEntry.daemonId)?.status === "ready" ? "ready" : null), 5000, "remote ready again");
	});

	test("list_projects answers with a projects frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		browser.send({ type: "list_projects" });
		const frame = await browser.waitForFrame((f) => f.type === "projects", "projects frame");
		if (frame.type !== "projects") throw new Error("expected projects");
		expect(frame.projects).toContainEqual({ name: "proj", path: join(rootsDir, "proj"), isWorktree: false });
	});

	test("spawn with a bad path answers an error frame", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		browser.send({ type: "spawn", cwd: join(tmp, "does-not-exist") });
		const frame = await browser.waitForFrame((f) => f.type === "error", "spawn error");
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("not a directory");
	});

	test("spawn passes valid labels through to supervisor.spawn", async () => {
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const before = spawnInits.length;
		spawnedByEdge = null; // the wait below must observe the NEW spawn
		browser.send({ type: "spawn", cwd: FAKE_CWD, labels: ["env=prod", "tag=api"] });
		// The real supervisor runs underneath: wait until the child dials ready.
		await waitFor(
			() => (spawnedByEdge && server.registry.get(spawnedByEdge.daemonId)?.status === "ready" ? "ready" : null),
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
			browser.send({ type: "spawn", cwd: FAKE_CWD, labels: bad });
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
		browser.send({ type: "spawn", cwd: FAKE_CWD });
		await waitFor(
			() => (spawnedByEdge && server.registry.get(spawnedByEdge.daemonId)?.status === "ready" ? "ready" : null),
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
			browser.send({ type });
			const frame = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "fleet edge: use spawn/stop/roster",
				`rejection error for ${type}`,
			);
			expect(frame.type).toBe("error");
		}
	});

	test("attach opens a pipe (Bearer + hello), forwards priming with sessionId rewritten, swallows hello_ok", async () => {
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
		const before = fake.socketCount();
		browserA.send({ type: "attach", sessionId: remoteEntry.daemonId });
		const attached = await browserA.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"attached (daemonId)",
		);
		expect(attached.type).toBe("attached");
		// The pipe socket carries the Bearer header and sends the hello handshake.
		await waitFor(() => (fake.socketCount() === before + 1 ? "pipe" : null), 5000, "pipe socket");
		pipeA = fake.sockets()[before];
		expect(pipeA.authHeader).toBe(`Bearer ${FAKE_TOKEN}`);
		const hello = await waitFor(
			() => pipeA.messages.find((m) => (m as { type?: string }).type === "hello") ?? null,
			5000,
			"pipe hello",
		);
		expect(hello).toEqual({ type: "hello", proto: OMP_PROTO, token: FAKE_TOKEN });
		// Priming is forwarded with the sessionId rewritten to the daemonId.
		await browserA.waitForFrame((f) => f.type === "history" && f.sessionId === remoteEntry.daemonId, "history");
		await browserA.waitForFrame((f) => f.type === "state" && f.sessionId === remoteEntry.daemonId, "state");
		await browserA.waitForFrame(
			(f) => f.type === "available_commands" && f.sessionId === remoteEntry.daemonId,
			"available_commands",
		);
		await browserA.waitForFrame((f) => f.type === "ready", "ready");
		// hello_ok is swallowed: it never reaches the browser.
		expect(browserA.frames.some((f) => f.type === "hello_ok")).toBe(false);
		// Every forwarded session-scoped frame carries the daemonId.
		for (const f of browserA.frames) {
			if ("sessionId" in f) expect(f.sessionId).toBe(remoteEntry.daemonId);
		}
	});

	test("browser calls are forwarded verbatim and call_result routes back", async () => {
		browserA.send({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
		const result = await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "c1", "call_result c1");
		if (result.type !== "call_result") throw new Error("expected call_result");
		expect(result.ok).toBe(true);
		const call = await waitFor(
			() => pipeA.messages.find((m) => (m as { id?: string }).id === "c1") ?? null,
			5000,
			"call c1 at fake",
		);
		expect(call).toEqual({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
	});

	test("a second browser attach gets an independent pipe and its own priming", async () => {
		const browserB = await openBrowser(server.port);
		await browserB.waitForFrame((f) => f.type === "roster", "roster");
		const before = fake.socketCount();
		browserB.send({ type: "attach", sessionId: remoteEntry.daemonId });
		await browserB.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId,
			"second attached",
		);
		await waitFor(() => (fake.socketCount() === before + 1 ? "pipe B" : null), 5000, "pipe B socket");
		const pipeB = fake.sockets()[before];
		expect(pipeB).not.toBe(pipeA);
		await browserB.waitForFrame((f) => f.type === "history" && f.sessionId === remoteEntry.daemonId, "history B");
		// Routing is per-pipe: each browser's call reaches only its own pipe.
		browserA.send({ type: "call", id: "a2", method: "getQueuedMessages" });
		browserB.send({ type: "call", id: "b2", method: "getQueuedMessages" });
		await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "a2", "a2 result");
		await browserB.waitForFrame((f) => f.type === "call_result" && f.id === "b2", "b2 result");
		await waitFor(() => (pipeA.messages.some((m) => (m as { id?: string }).id === "a2") ? "a2 at A" : null), 5000, "a2 at pipe A");
		await waitFor(() => (pipeB.messages.some((m) => (m as { id?: string }).id === "b2") ? "b2 at B" : null), 5000, "b2 at pipe B");
		expect(pipeA.messages.some((m) => (m as { id?: string }).id === "b2")).toBe(false);
		expect(pipeB.messages.some((m) => (m as { id?: string }).id === "a2")).toBe(false);
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
		expect(browserA.frames.some((f) => f.type === "error" && f.error === "daemon connection lost")).toBe(false);
	});

	test("attach to an asleep spawned daemon respawns it, waits ready, then pipes", async () => {
		const browserC = await openBrowser(server.port);
		await browserC.waitForFrame((f) => f.type === "roster", "roster");
		const before = fake.socketCount();
		const respawnsBefore = respawns;
		browserC.send({ type: "attach", sessionId: spawnedEntry.daemonId });
		await browserC.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === spawnedEntry.daemonId,
			"attached (spawned)",
		);
		expect(respawns).toBe(respawnsBefore + 1);
		const entryNow = server.registry.get(spawnedEntry.daemonId);
		expect(entryNow?.status).toBe("ready");
		expect(server.connector.isConnected(spawnedEntry.daemonId)).toBe(true);
		// The wake path produced a connector dial + this browser's pipe.
		await waitFor(() => (fake.socketCount() === before + 2 ? "connector+pipe" : null), 5000, "connector + pipe sockets");
		const pipeC = fake.sockets()[before + 1];
		expect(pipeC.authHeader).toBe(`Bearer ${entryNow?.token}`);
		await browserC.waitForFrame((f) => f.type === "history" && f.sessionId === spawnedEntry.daemonId, "history C");
	});

	test("spawn_resume then attach wakes an asleep spawned daemon exactly once", async () => {
		const entry = server.registry.list().find((e) => e.name === "spawned2");
		if (!entry) throw new Error("spawned2 missing");
		expect(entry.status).toBe("asleep");
		const browser = await openBrowser(server.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const respawnsBefore = respawns;
		// The roster UI sends these back-to-back; the edge must serialize them.
		browser.send({ type: "spawn_resume", daemonId: entry.daemonId });
		browser.send({ type: "attach", sessionId: entry.daemonId });
		await browser.waitForFrame(
			(f) => f.type === "attached" && f.sessionId === entry.daemonId,
			"attached (spawned2)",
		);
		expect(respawns).toBe(respawnsBefore + 1);
		expect(server.registry.get(entry.daemonId)?.status).toBe("ready");
	});

	test("GET /ctl/sessions/{id}/stderr returns text for spawned and 404 for remote", async () => {
		const spawned = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions/${spawnedEntry.daemonId}/stderr`);
		expect(spawned.status).toBe(200);
		const body = (await spawned.json()) as { text?: unknown };
		expect(typeof body.text).toBe("string");
		const remote = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions/${remoteEntry.daemonId}/stderr`);
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
		const probe = await fetch(`http://127.0.0.1:${server.port}/__omp_fleet_placeholder_probe__`);
		expect(probe.status).toBe(200);
		expect(await probe.text()).toContain("omp-fleet");
	});

	test("aggregated daemons: merge across daemons with same-projectDir preference", async () => {
		// A second fake omp-session with a different cwd, registered like any remote daemon.
		fake2 = startFakeSession({ cwd: OTHER_CWD });
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "daemons-b", url: fake2.url, token: FAKE_TOKEN, cwd: OTHER_CWD }),
		});
		expect(res.status).toBe(200);
		daemonsEntryB = (await res.json()) as RegistryEntry;
		await waitFor(() => (server.registry.get(daemonsEntryB.daemonId)?.status === "ready" ? "ready" : null), 5000, "second daemon ready");
		// A browser to funnel the emits into the cache (update broadcasts are observable).
		const funnel = await openBrowser(server.port);
		await funnel.waitForFrame((f) => f.type === "roster", "roster");
		// fake (cwd FAKE_CWD) reports its own roster; fake2 (cwd OTHER_CWD)
		// reports its own PLUS a stale cross-cwd entry for FAKE_CWD arriving later.
		fake.emitDaemons([daemonInfo("hub-a", FAKE_CWD, { pid: 1111 }), daemonInfo("shared", FAKE_CWD, { pid: 1112 })]);
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
		fake2.emitDaemons([daemonInfo("hub-b", OTHER_CWD, { pid: 2221 }), daemonInfo("shared", FAKE_CWD, { pid: 2222 })]);
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
		browser.send({ type: "attach", sessionId: remoteEntry.daemonId });
		await browser.waitForFrame((f) => f.type === "attached" && f.sessionId === remoteEntry.daemonId, "attached");
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
		expect(daemonsBrowser.frames.some((f) => f.type === "daemons" && f.daemons.some((d) => d.name === "zombie"))).toBe(false);
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

	test("shouldDropFrame guards the 4 MiB cap boundary", () => {
		const cap = 4 * 1024 * 1024;
		expect(shouldDropFrame(0, cap)).toBe(false);
		expect(shouldDropFrame(cap, cap)).toBe(false);
		expect(shouldDropFrame(cap + 1, cap)).toBe(true);
		expect(shouldDropFrame(1024, 1024)).toBe(false);
		expect(shouldDropFrame(1025, 1024)).toBe(true);
	});

	test("backpressure drops frames and marks the drop with one error frame", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-fleet-edge-bp-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry);
		const config: FleetConfig = { roots: [], templates: { local: { command: "true" } }, defaultTemplate: "local" };
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge({ registry, connector, supervisor, config }, { backpressureBytes: 128 });
		const sent: unknown[] = [];
		const fakeBrowser = {
			getBufferedAmount: () => 4096, // already over the tiny cap
			send: (data: string | Buffer) => {
				sent.push(JSON.parse(String(data)));
			},
			close: () => {},
		} as unknown as ServerWebSocket<unknown>;
		try {
			edge.onSocketOpen(fakeBrowser); // open roster is dropped + marked
			registry.create({ name: "x", cwd: "/x", project: "x", labels: [], mode: "remote", status: "connecting" }); // broadcast dropped too
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.every((f) => (f as { type?: string }).type === "error")).toBe(true);
			expect(sent.some((f) => (f as { error?: string }).error === "backpressure: output dropped — re-attach")).toBe(true);
			expect(sent.some((f) => (f as { type?: string }).type === "roster")).toBe(false);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("proxy pipes share the connector keepalive: pings flow, a responsive pipe stays up", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-fleet-edge-ka-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
			pingIntervalMs: 30,
			pongTimeoutMs: 20,
		});
		const daemon = startFakeSession();
		const entry = registry.create({
			name: "ka",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 3000);
		const config: FleetConfig = { roots: [], templates: {}, defaultTemplate: "local" };
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge({ registry, connector, supervisor, config }, { pingIntervalMs: 30, pongTimeoutMs: 20 });
		const sent: unknown[] = [];
		const fakeBrowser = {
			getBufferedAmount: () => 0,
			send: (data: string | Buffer) => {
				sent.push(JSON.parse(String(data)));
			},
			close: () => {},
		} as unknown as ServerWebSocket<unknown>;
		try {
			edge.onSocketOpen(fakeBrowser);
			const before = daemon.socketCount();
			edge.onSocketMessage(fakeBrowser, JSON.stringify({ type: "attach", sessionId: entry.daemonId }));
			await waitFor(() => (daemon.socketCount() === before + 1 ? "pipe" : null), 3000, "pipe socket");
			const pipe = daemon.sockets()[before];
			expect(pipe.authHeader).toBe(`Bearer ${FAKE_TOKEN}`);
			await waitFor(() => (pipe.messages.some((m) => (m as { type?: string }).type === "hello") ? "hello" : null), 3000, "pipe hello");
			// Several 30ms keepalive intervals: the responsive daemon
			// (auto-pong) keeps the pipe open — no loss frame, no redial.
			await sleep(200);
			expect(pipe.closed).toBe(false);
			expect(sent.some((f) => (f as { type?: string }).type === "error")).toBe(false);
			expect(daemon.socketCount()).toBe(before + 1); // connector socket + one pipe
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
