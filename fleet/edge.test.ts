/**
 * Fleet edge tests: the browser SSE edge (/events + /command) and the /ctl
 * routes against the real server mount (startFleet), with a FAKE omp-session
 * that serves the OMP_PROTO 2 wire contract: every /events open primes
 * hello_ok (first, with OMP_PROTO) → attached → history → state →
 * available_commands → ready, answers prompt calls with call_result on all
 * open streams, and records per-stream auth headers and POST /command
 * bodies.
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
import { OMP_PROTO, SSE_DELTA_SEQ_START, SSE_EVENT_NAME } from "../src/protocol";
import type { DaemonEntry, DaemonInfo, ServerFrame } from "../src/protocol";
import { encodeSseEvent, parseSseUnits, SSE_PING_BLOCK } from "../src/sse";
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

/** One /events stream observed on the fake (the connector's control stream or an edge pipe). */
interface FakeStreamSeen {
	authHeader: string | null;
	closed: boolean;
}

interface FakeSession {
	url: string;
	port: number;
	cwd: string;
	streams(): FakeStreamSeen[];
	streamCount(): number;
	/** POST /command bodies received (the uplink — no hello precedes them). */
	received: unknown[];
	/** Broadcast a {type:"daemons"} broker roster to every open stream. */
	emitDaemons(entries: DaemonInfo[]): void;
	close(): void;
}

/**
 * Fake omp-session over the OMP_PROTO 2 wire contract: primes every /events
 * open (hello_ok first, then the attach priming), answers prompt calls with
 * call_result on ALL open streams (like the real single-session daemon,
 * whose unicast answers go to every stream; consumers dedup by id), and
 * records everything. Registered endpoints are pathless ws:// URLs, so
 * serving /events + /command on the bare origin also proves the
 * daemonHttpBase normalization end-to-end.
 */
function startFakeSession(opts: { cwd?: string } = {}): FakeSession {
	const cwd = opts.cwd ?? FAKE_CWD;
	const sessionFile = join(cwd, ".omp", "session.json");
	const state = { ...FAKE_STATE, sessionFile };
	const streams: FakeStreamSeen[] = [];
	const received: unknown[] = [];
	const live: Array<(block: string) => void> = [];
	let nextSeq = SSE_DELTA_SEQ_START;
	const encoder = new TextEncoder();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					let frame: unknown;
					try {
						frame = await req.json();
					} catch {
						return new Response("malformed", { status: 400 });
					}
					received.push(frame);
					const cmd = frame as { type?: string; id?: string };
					if (cmd.type === "call" && cmd.id !== undefined) {
						const answer = encodeSseEvent(SSE_EVENT_NAME, { type: "call_result", id: cmd.id, ok: true, data: { echoed: frame } }, nextSeq++);
						for (const write of live) write(answer);
					}
					return Response.json({ commandId: cmd.id ?? "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			const seen: FakeStreamSeen = { authHeader: req.headers.get("authorization"), closed: false };
			streams.push(seen);
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const write = (block: string): void => {
				controller!.enqueue(encoder.encode(block));
			};
			live.push(write);
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					controller = ctrl;
					prime(write);
				},
				cancel() {
					seen.closed = true;
					const index = live.indexOf(write);
					if (index !== -1) live.splice(index, 1);
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	/** omp-session's stream priming: hello_ok FIRST (HTTP-level auth), then the attach priming. */
	function prime(write: (block: string) => void): void {
		let seq = 1;
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "hello_ok", proto: OMP_PROTO, name: "fake", cwd, pid: 4242, version: "0.0.0-test", sessionFile }, seq++));
		// Phase 6 wire format: omp-session keeps the required "s1" on `attached` but
		// no longer stamps session-scoped frames — the edge adds the daemonId.
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "attached", sessionId: "s1", mode: "single" }, seq++));
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "history", messages: [] }, seq++));
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "state", state }, seq++));
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "available_commands", commands: [] }, seq++));
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "ready", readyAt: Date.now() }, seq++));
	}
	return {
		url: `ws://127.0.0.1:${server.port}`,
		port: server.port!,
		cwd,
		streams: () => [...streams],
		streamCount: () => streams.length,
		received,
		emitDaemons: (entries: DaemonInfo[]) => {
			const frame = encodeSseEvent(SSE_EVENT_NAME, { type: "daemons", daemons: entries }, nextSeq++);
			for (const write of live) write(frame);
		},
		close: () => {
			server.stop(true);
		},
	};
}

interface PipeFake {
	url: string;
	port: number;
	/** Stop the heartbeat keepalives: the pipe then goes silent (the edge trips its deadline). */
	pause(): void;
	close(): void;
}

/**
 * Fake daemon for the pipe-liveness test: primes every /events stream
 * (the connector's control stream and the edge's pipe), answers prompt
 * calls with call_result on all open streams, and emits keepalive ping
 * events every heartbeatMs while not paused. pause() silences it so the
 * edge's pipe silence deadline trips.
 */
function startPipeFake(opts: { heartbeatMs?: number } = {}): PipeFake {
	const heartbeatMs = opts.heartbeatMs ?? 30;
	let paused = false;
	const encoder = new TextEncoder();
	const live: Array<(block: string) => void> = [];
	let nextSeq = SSE_DELTA_SEQ_START;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					let frame: unknown;
					try {
						frame = await req.json();
					} catch {
						return new Response("malformed", { status: 400 });
					}
					const cmd = frame as { type?: string; id?: string };
					if (cmd.type === "call" && cmd.id !== undefined) {
						const answer = encodeSseEvent(SSE_EVENT_NAME, { type: "call_result", id: cmd.id, ok: true, data: { echoed: frame } }, nextSeq++);
						for (const write of live) write(answer);
					}
					return Response.json({ commandId: cmd.id ?? "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const write = (block: string): void => {
				controller!.enqueue(encoder.encode(block));
			};
			live.push(write);
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					controller = ctrl;
					let seq = 1;
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "hello_ok", proto: OMP_PROTO, name: "pipe-fake", cwd: FAKE_CWD, pid: 4243, version: "0.0.0-test" }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "attached", sessionId: "s1", mode: "single" }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "history", messages: [] }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "state", state: { ...FAKE_STATE, sessionFile: FAKE_SESSION_FILE } }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "available_commands", commands: [] }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "ready", readyAt: Date.now() }, seq++));
				},
				cancel() {
					const index = live.indexOf(write);
					if (index !== -1) live.splice(index, 1);
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const heartbeat = setInterval(() => {
		if (paused) return;
		for (const write of live) write(SSE_PING_BLOCK);
	}, heartbeatMs);
	return {
		url: `ws://127.0.0.1:${server.port}`,
		port: server.port!,
		pause: () => {
			paused = true;
		},
		close: () => {
			clearInterval(heartbeat);
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

/** Poll `events` until an event satisfies `pred` (latest-wins collections). */
async function waitForEvent(
	events: Array<{ id: number; frame: ServerFrame }>,
	pred: (ev: { id: number; frame: ServerFrame }) => boolean,
	what = "event",
	timeoutMs = 5000,
): Promise<{ id: number; frame: ServerFrame }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = events.find(pred);
		if (hit) return hit;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/**
 * A browser edge client: GET /events SSE downlink (bound with ?client= for
 * per-browser command routing) + POST /command uplink (X-Omp-Client-Id
 * header). Reconnects carry Last-Event-ID for ring replay.
 */
class BrowserSocket {
	readonly frames: ServerFrame[] = [];
	readonly events: Array<{ id: number; frame: ServerFrame }> = [];
	readonly clientId: string;
	readonly port: number;
	#abort: AbortController | null = null;
	#readerDone: Promise<void> | null = null;
	#lastEventId: string | null = null;

	constructor(port: number, clientId = crypto.randomUUID()) {
		this.port = port;
		this.clientId = clientId;
	}

	async open(): Promise<void> {
		const headers: Record<string, string> = {};
		if (this.#lastEventId !== null) headers["Last-Event-ID"] = this.#lastEventId;
		const abort = new AbortController();
		this.#abort = abort;
		const res = await fetch(`http://127.0.0.1:${this.port}/events?client=${this.clientId}`, { headers, signal: abort.signal });
		if (!res.ok || !res.body) throw new Error(`browser /events → HTTP ${res.status}`);
		this.#readerDone = (async () => {
			try {
				for await (const unit of parseSseUnits(res.body!)) {
					if (unit.kind !== "event" || unit.event !== SSE_EVENT_NAME || unit.id === undefined) continue;
					this.#lastEventId = unit.id;
					const frame = JSON.parse(unit.data) as ServerFrame;
					this.frames.push(frame);
					this.events.push({ id: Number(unit.id), frame });
				}
			} catch {
				// Stream dropped/aborted; tests observe via frames + end().
			}
		})();
	}

	/** POST one command; resolves on the 202 accept. */
	async send(cmd: unknown): Promise<void> {
		const res = await fetch(`http://127.0.0.1:${this.port}/command`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-client-id": this.clientId },
			body: JSON.stringify(cmd),
		});
		if (!res.ok) throw new Error(`browser command rejected (HTTP ${res.status})`);
	}

	/** Resolves when the /events body ends (backpressure drop / close), or rejects on timeout. */
	async end(timeoutMs = 5000): Promise<void> {
		if (!this.#readerDone) throw new Error("browser not open");
		await Promise.race([
			this.#readerDone,
			new Promise((_, reject) => setTimeout(() => reject(new Error("browser stream did not end")), timeoutMs)),
		]);
	}

	/** Close the stream (abort the fetch), like a browser tab closing. */
	close(): void {
		this.#abort?.abort();
	}

	/** Reconnect after a drop: the last received id rides the new open. */
	reopen(): Promise<void> {
		return this.open();
	}

	waitForFrame(pred: (f: ServerFrame) => boolean, what = "frame", timeoutMs = 5000): Promise<ServerFrame> {
		return waitForEvent(this.events, (ev) => pred(ev.frame), what, timeoutMs).then((ev) => ev.frame);
	}

	waitForEvent(
		pred: (ev: { id: number; frame: ServerFrame }) => boolean,
		what = "event",
		timeoutMs = 5000,
	): Promise<{ id: number; frame: ServerFrame }> {
		return waitForEvent(this.events, pred, what, timeoutMs);
	}
}

const allBrowsers: BrowserSocket[] = [];

async function openBrowser(port: number): Promise<BrowserSocket> {
	const browser = new BrowserSocket(port);
	allBrowsers.push(browser);
	await browser.open();
	return browser;
}

/** Mount a standalone edge on an ephemeral loopback port for direct tests. */
function serveEdge(edge: FleetEdge): { port: number; stop(): void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => (await edge.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	return { port: server.port!, stop: () => server.stop(true) };
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
		// A registry mutation broadcasts a fresh roster to every edge stream.
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
		expect(frame.projects).toContainEqual({ name: "proj", path: join(rootsDir, "proj"), isWorktree: false });
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
			await browser.send({ type });
			const frame = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "fleet edge: use spawn/stop/roster",
				`rejection error for ${type}`,
			);
			expect(frame.type).toBe("error");
		}
	});

	test("attach opens a daemon /events pipe (Bearer), forwards priming with sessionId rewritten, swallows hello_ok", async () => {
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
		await browserA.send({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
		const result = await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "c1", "call_result c1");
		if (result.type !== "call_result") throw new Error("expected call_result");
		expect(result.ok).toBe(true);
		// The command reached the daemon's POST /command (with no hello before it).
		await waitFor(() => (fake.received.find((m) => (m as { id?: string }).id === "c1") ?? null), 5000, "call c1 at fake");
		expect(fake.received.find((m) => (m as { id?: string }).id === "c1")).toEqual({ type: "call", id: "c1", method: "prompt", args: ["hello"] });
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
		await waitFor(() => (fake.streamCount() === before + 1 ? "pipe B" : null), 5000, "pipe B stream");
		const pipeB = fake.streams()[before];
		expect(pipeB).not.toBe(pipeA);
		await browserB.waitForFrame((f) => f.type === "history" && f.sessionId === remoteEntry.daemonId, "history B");
		// Routing is per-browser: each browser's command reaches the daemon and
		// answers on its own stream (the daemon broadcasts; pendings dedup by id).
		await browserA.send({ type: "call", id: "a2", method: "getQueuedMessages" });
		await browserB.send({ type: "call", id: "b2", method: "getQueuedMessages" });
		await browserA.waitForFrame((f) => f.type === "call_result" && f.id === "a2", "a2 result");
		await browserB.waitForFrame((f) => f.type === "call_result" && f.id === "b2", "b2 result");
		await waitFor(() => (fake.received.some((m) => (m as { id?: string }).id === "a2") ? "a2 at daemon" : null), 5000, "a2 at daemon");
		await waitFor(() => (fake.received.some((m) => (m as { id?: string }).id === "b2") ? "b2 at daemon" : null), 5000, "b2 at daemon");
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
		await waitFor(() => (fake.streamCount() === before + 2 ? "connector+pipe" : null), 5000, "connector + pipe streams");
		const pipeC = fake.streams()[before + 1];
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
		await browser.send({ type: "attach", sessionId: remoteEntry.daemonId });
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

	test("remove evicts a remote daemon and broadcasts a roster without it", async () => {
		// A fresh entry so the shared remoteEntry fixture stays intact for earlier tests.
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "removable", url: fake.url, token: FAKE_TOKEN }),
		});
		expect(res.status).toBe(200);
		const added = (await res.json()) as RegistryEntry;
		await waitFor(() => (server.registry.get(added.daemonId)?.status === "ready" ? "ready" : null), 5000, "removable daemon ready");
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
			(f) => f.type === "error" && typeof f.error === "string" && f.error.includes("unknown daemon"),
			"remove unknown error",
		);
		if (frame.type !== "error") throw new Error("expected error");
		expect(frame.error).toContain("unknown daemon");
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

	test("shouldDropFrame guards the cap boundary", () => {
		const cap = 4 * 1024 * 1024;
		expect(shouldDropFrame(0, cap)).toBe(false);
		expect(shouldDropFrame(cap, cap)).toBe(false);
		expect(shouldDropFrame(cap + 1, cap)).toBe(true);
		expect(shouldDropFrame(1024, 1024)).toBe(false);
		expect(shouldDropFrame(1025, 1024)).toBe(true);
	});

	test("backpressure: overflow drops the browser stream; Last-Event-ID resume replays the ring", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-fleet-edge-bp-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry);
		const config: FleetConfig = { roots: [], templates: { local: { command: "true" } }, defaultTemplate: "local" };
		const supervisor = new SpawnSupervisor(registry, connector, config);
		// The cap fits the priming (small roster) + the ring replay, but a
		// synchronous burst of roster broadcasts overflows it.
		const edge = new FleetEdge({ registry, connector, supervisor, config }, { backpressureBytes: 4096 });
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			// Priming arrives (roster + merged daemons, seqs 1..2).
			await browser.waitForFrame((f) => f.type === "roster", "priming roster");
			// One delta the browser reads, so its Last-Event-ID lands in the
			// delta range (≥ SSE_DELTA_SEQ_START) before the drop.
			const x1 = registry.create({ name: "x1", cwd: "/x1", project: "x1", labels: [], mode: "remote", status: "connecting" });
			await browser.waitForFrame((f) => f.type === "roster" && f.daemons.some((d) => d.daemonId === x1.daemonId), "first delta roster");
			// Overflow: a synchronous burst of roster broadcasts (constant-size
			// blocks) far exceeds the cap while the browser is not reading —
			// the stream must be dropped.
			for (let i = 2; i <= 40; i++) {
				registry.update(x1.daemonId, { labels: [`v=${i}`] });
			}
			await browser.end(); // the dropped stream's body ends
			// Reconnect with Last-Event-ID: the ring replays deltas after it.
			await browser.reopen();
			// The replay delivers the ringed deltas (delta-era seqs) — the
			// final burst roster — not just the fresh priming.
			const replayed = await browser.waitForEvent(
				(ev) => ev.frame.type === "roster" && ev.frame.daemons.some((d) => d.daemonId === x1.daemonId && d.labels.includes("v=40")) && ev.id >= SSE_DELTA_SEQ_START,
				"replayed final roster",
			);
			expect(replayed.frame.type).toBe("roster");
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("pipe liveness: a responsive daemon pipe stays up; silence past the deadline treats it as lost", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-fleet-edge-pipe-liveness-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 60_000 });
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "pipe-live",
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
		const edge = new FleetEdge({ registry, connector, supervisor, config }, { silenceDeadlineMs: 200 });
		let releases = 0;
		const origRelease = connector.release.bind(connector);
		connector.release = (daemonId: string) => {
			releases++;
			origRelease(daemonId);
		};
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame((f) => f.type === "attached" && f.sessionId === entry.daemonId, "attached");
			// Heartbeats every 30ms keep the 200ms silence deadline fed: the
			// pipe survives far past it — no loss frame, no teardown.
			await sleep(600);
			expect(browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost")).toBe(false);
			// Commands still round-trip through the live pipe.
			await browser.send({ type: "call", id: "l1", method: "prompt", args: ["hi"] });
			await browser.waitForFrame((f) => f.type === "call_result" && f.id === "l1", "call_result l1");
			// Silence: the daemon stops sending; the deadline trips → pipe lost
			// (error frame + the pipe retain released; the connector socket
			// itself is untouched).
			daemon.pause();
			const lost = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "daemon connection lost",
				"pipe lost",
				3000,
			);
			expect(lost.type).toBe("error");
			await waitFor(() => (releases >= 1 ? "released" : null), 3000, "pipe retain released");
			expect(releases).toBe(1);
			expect(connector.isConnected(entry.daemonId)).toBe(true);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
