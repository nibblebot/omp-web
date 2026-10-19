/**
 * Shared harness for the split fleet edge suites (edge-wire, edge-pipe,
 * edge-worktrees): a browser SSE edge client, ring replay collection, wire
 * fixtures, and polling helpers. The controlled daemon lives in
 * callback-daemon.testkit.ts (a session-side callback pair dialed out to the
 * fleet; the fleet never dials a session). Named *.testkit.ts so bun test
 * discovery never picks it up as a suite.
 */
import { join } from "node:path";
import { SSE_DELTA_SEQ_START, SSE_EVENT_NAME } from "#lib/wire/protocol";
import type { DaemonEntry, DaemonInfo, ServerFrame } from "#lib/wire/protocol";
import { parseSseUnits } from "#lib/wire/sse";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { EdgeEvictionHooks, FleetEdge } from "../edge";
import type { DaemonTransportRegistry } from "../daemon-transport";
import type { Registry } from "../registry";
import type { SpawnSupervisor } from "../supervisor";
import { SessionWaker } from "../session-waker";

export { cleanupTempDirs };

/** Fake omp-session cwd, under a testkit temp dir so the afterAll reaps it. */
export const FAKE_CWD = join(tempDir("omp-web-edge-fake-cwd-"), "fake-proj");
export const FAKE_SESSION_FILE = join(FAKE_CWD, ".omp", "session.json");
export const FAKE_TOKEN = "sekret";
/** A wire-safe DaemonInfo (hub launch / broker roster entry) for fake emissions. */
export function daemonInfo(
	name: string,
	projectDir: string,
	overrides: Partial<DaemonInfo> = {},
): DaemonInfo {
	return {
		name,
		id: `${projectDir}/${name}`,
		projectDir,
		state: "running",
		createdAt: 1,
		startedAt: 1,
		restartCount: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

export const FAKE_STATE = {
	model: undefined,
	modelRoles: undefined,
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	sessionFile: FAKE_SESSION_FILE,
	sessionId: "s1",
	readyAt: Date.now(),
	sessionName: undefined,
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
	contextUsage: undefined,
	goalModeState: undefined,
	planModeEnabled: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
};

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll until `probe` returns non-null or the timeout elapses. */
export async function waitFor<T>(
	probe: () => T | null,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** Poll `events` until an event satisfies `pred` (latest-wins collections). */
export async function waitForEvent(
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
export class BrowserSocket {
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
		const res = await fetch(`http://127.0.0.1:${this.port}/events?client=${this.clientId}`, {
			headers,
			signal: abort.signal,
		});
		if (!res.ok || !res.body) throw new Error(`browser /events → HTTP ${res.status}`);
		this.#readerDone = (async () => {
			try {
				for await (const unit of parseSseUnits(res.body!)) {
					if (unit.kind !== "event" || unit.event !== SSE_EVENT_NAME || unit.id === undefined)
						continue;
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
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("browser stream did not end")), timeoutMs),
			),
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

	waitForFrame(
		pred: (f: ServerFrame) => boolean,
		what = "frame",
		timeoutMs = 5000,
	): Promise<ServerFrame> {
		return waitForEvent(this.events, (ev) => pred(ev.frame), what, timeoutMs).then(
			(ev) => ev.frame,
		);
	}

	waitForEvent(
		pred: (ev: { id: number; frame: ServerFrame }) => boolean,
		what = "event",
		timeoutMs = 5000,
	): Promise<{ id: number; frame: ServerFrame }> {
		return waitForEvent(this.events, pred, what, timeoutMs);
	}
}

export const allBrowsers: BrowserSocket[] = [];

export async function openBrowser(port: number): Promise<BrowserSocket> {
	const browser = new BrowserSocket(port);
	allBrowsers.push(browser);
	await browser.open();
	return browser;
}

/**
 * Mount a standalone edge on an ephemeral loopback port for direct tests.
 * Pass the transport the edge was built with to also serve /callback/* so a
 * callback-daemon.testkit daemon can dial the pair.
 */
export function serveEdge(
	edge: FleetEdge,
	transport?: DaemonTransportRegistry,
): { port: number; stop(): void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) =>
			(await transport?.handleFetch(req)) ??
			(await edge.handleFetch(req)) ??
			new Response("not found", { status: 404 }),
	});
	return { port: server.port!, stop: () => server.stop(true) };
}

/**
 * Open /events for a clientId with a delta-era Last-Event-ID and collect the
 * RING REPLAY (delta-era frames only) until `want` matches or `timeoutMs`
 * elapses. The probe binds the client (a rebind closes any previous stream),
 * so it must be the LAST use of that clientId in a test. A non-matching
 * `want` falls through to the timeout abort and returns what was collected;
 * assertions judge the frames.
 */
export async function collectReplay(
	port: number,
	clientId: string,
	lastEventId: number,
	want: (f: ServerFrame) => boolean,
	timeoutMs = 3000,
): Promise<Array<{ id: number; frame: ServerFrame }>> {
	const abort = new AbortController();
	const res = await fetch(`http://127.0.0.1:${port}/events?client=${clientId}`, {
		headers: { "Last-Event-ID": String(lastEventId) },
		signal: abort.signal,
	});
	if (!res.ok || !res.body) throw new Error(`replay probe /events → HTTP ${res.status}`);
	const frames: Array<{ id: number; frame: ServerFrame }> = [];
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		for await (const unit of parseSseUnits(res.body!)) {
			if (unit.kind !== "event" || unit.event !== SSE_EVENT_NAME || unit.id === undefined) continue;
			const frame = JSON.parse(unit.data) as ServerFrame;
			if (Number(unit.id) >= SSE_DELTA_SEQ_START) {
				frames.push({ id: Number(unit.id), frame });
				if (want(frame)) break;
			}
		}
	} catch {
		// Aborted (timeout or teardown): the collected frames are the result.
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
	return frames;
}

/** Narrow a replay entry to an event frame (type guard preserving narrowing). */
export function isEventEntry(entry: {
	id: number;
	frame: ServerFrame;
}): entry is { id: number; frame: ServerFrame & { type: "event" } } {
	return entry.frame.type === "event";
}

/** The `message` field of an event frame's event (undefined when absent). */
export function eventMessage(frame: ServerFrame & { type: "event" }): string | undefined {
	return (frame.event as { message?: string }).message;
}

export function asRoster(frame: ServerFrame): { type: "roster"; daemons: DaemonEntry[] } {
	if (frame.type !== "roster") throw new Error("expected roster frame");
	return frame;
}

/**
 * Eviction hooks for edge tests: the server's #evictRow/#evictProject minus
 * its pair/log-tap/orphan bookkeeping (covered by the server suites). Prune
 * first, run the removal, then drop the row, as the server does.
 */
export function testEviction(registry: Registry, supervisor: SpawnSupervisor): EdgeEvictionHooks {
	return {
		async evictRow(daemonId, removal) {
			await supervisor.prune(daemonId);
			const result = await removal();
			registry.remove(daemonId);
			return result;
		},
		async evictProject(projectId) {
			for (const entry of registry.list()) {
				if (entry.projectId === projectId && entry.status !== "asleep") {
					await supervisor.prune(entry.daemonId);
				}
			}
			registry.removeProject(projectId);
		},
	};
}

/**
 * Session waker for edge tests: the server's wiring without a clone lifecycle
 * (edge rigs drive non-clone rows through the real callback transport).
 */
export function testWaker(
	registry: Registry,
	supervisor: SpawnSupervisor,
	transport: DaemonTransportRegistry | undefined,
): SessionWaker {
	return new SessionWaker({ registry, supervisor, transport });
}
