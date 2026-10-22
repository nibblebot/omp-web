/**
 * Shared harness for the split fleet edge suites (edge-wire, edge-pipe,
 * edge-worktrees): a browser socket (`/ws`) client, ring replay collection, wire
 * fixtures, and polling helpers. The controlled daemon lives in
 * callback-daemon.testkit.ts (a session-side callback pair dialed out to the
 * fleet; the fleet never dials a session). Named *.testkit.ts so bun test
 * discovery never picks it up as a suite.
 */
import { join } from "node:path";
import { DELTA_SEQ_START, OMP_PROTO } from "#lib/wire/protocol";
import type { DaemonEntry, DaemonInfo, ServerFrame } from "#lib/wire/protocol";
import {
	BROWSER_SOCKET_PATH,
	browserSocketUrl,
	parseServerMessage,
} from "#lib/wire/browser-socket";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { EdgeEvictionHooks, FleetEdge } from "../edge";
import type { DaemonTransportRegistry } from "../daemon-transport";
import { fleetWebSocket, type FleetSocketData } from "../fleet-websocket";
import type { Registry } from "../registry";
import type { LifecycleApi } from "../workspace-lifecycle";
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

/**
 * End every host child a suite spawned. Fleet `close()` never kills sessions (they
 * outlive the control plane), so a suite whose template idles forever must stop its
 * spawned rows itself or each run leaks one process per spawn. Stopping an asleep
 * row is a no-op; every row is attempted before a failure is thrown.
 */
export async function stopSpawnedRows(server: {
	registry: Pick<Registry, "list">;
	lifecycle: Pick<LifecycleApi, "stop">;
}): Promise<void> {
	const rows = server.registry.list().filter((entry) => entry.template !== undefined);
	const results = await Promise.allSettled(
		rows.map((entry) => server.lifecycle.stop(entry.daemonId)),
	);
	const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, "stopSpawnedRows: a stop failed");
}

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

/** A command the edge nacked (the HTTP status the old POST /command would have answered). */
export class CommandNack extends Error {
	constructor(
		readonly id: string,
		readonly status: number,
		message: string,
	) {
		super(`command ${id} nacked ${status}: ${message}`);
	}
}

/** How a browser socket closed (RFC 6455 code + reason). */
export interface SocketClose {
	code: number;
	reason: string;
}

/** Bun's WebSocket client with its upgrade-header options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => WebSocket;

/**
 * A browser edge client: one `/ws` socket bound with `client=<id>` (per-browser
 * command routing), `proto` and, after a reconnect, `after` (the highest seq
 * received). Commands ride in band; `send` resolves on the ack and rejects with
 * CommandNack on a nack.
 */
export class BrowserSocket {
	readonly frames: ServerFrame[] = [];
	readonly events: Array<{ id: number; frame: ServerFrame }> = [];
	/** Every message received, in order (raw JSON text), for wire-shape assertions. */
	readonly messages: string[] = [];
	/** The same text joined by newlines. */
	rawText = "";
	readonly pings: number[] = [];
	readonly acks: string[] = [];
	readonly nacks: Array<{ id: string; status: number; error: string }> = [];
	/** Set once the socket closed. */
	closeInfo: SocketClose | null = null;
	readonly clientId: string;
	readonly port: number;
	/** Overrides for dial-time tests: a different `proto`, none at all, no client id, extra headers. */
	readonly dial: {
		proto?: number | null;
		headers?: Record<string, string>;
		after?: number | null;
		/** Dial without a `client` query (a socket no command can address). */
		anonymous?: boolean;
	};
	#ws: WebSocket | null = null;
	#after: number | null = null;
	#closed: Promise<SocketClose> | null = null;
	readonly #pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

	constructor(
		port: number,
		clientId: string = crypto.randomUUID(),
		dial: BrowserSocket["dial"] = {},
	) {
		this.port = port;
		this.clientId = clientId;
		this.dial = dial;
	}

	/** Dial and resolve once the socket is open (a refused dial opens, then closes typed). */
	async open(): Promise<void> {
		const proto = this.dial.proto === undefined ? OMP_PROTO : this.dial.proto;
		const url = browserSocketUrl(`http://127.0.0.1:${this.port}`, {
			clientId: this.dial.anonymous === true ? null : this.clientId,
			after: this.dial.after === undefined ? this.#after : this.dial.after,
			proto,
			token: null,
		});
		const ws = new BunWebSocket(url, { headers: this.dial.headers });
		this.#ws = ws;
		this.closeInfo = null;
		const closed = Promise.withResolvers<SocketClose>();
		this.#closed = closed.promise;
		ws.addEventListener("close", (event) => {
			const info = { code: event.code, reason: event.reason };
			this.closeInfo = info;
			for (const waiter of this.#pending.values()) {
				waiter.reject(new Error(`socket closed ${info.code} before the command settled`));
			}
			this.#pending.clear();
			closed.resolve(info);
		});
		ws.addEventListener("message", (event) => this.#onMessage(event.data));
		const opened = Promise.withResolvers<void>();
		ws.addEventListener("open", () => opened.resolve(), { once: true });
		ws.addEventListener("error", () => opened.reject(new Error("browser /ws dial failed")), {
			once: true,
		});
		await opened.promise;
	}

	#onMessage(data: unknown): void {
		const text = typeof data === "string" ? data : String(data);
		this.messages.push(text);
		this.rawText += `${text}\n`;
		const message = parseServerMessage(text);
		if (message === null) throw new Error(`unparseable server message: ${text.slice(0, 200)}`);
		switch (message.kind) {
			case "frame": {
				const id = message.seq ?? -1;
				if (message.seq !== null && (this.#after === null || message.seq > this.#after)) {
					this.#after = message.seq;
				}
				this.frames.push(message.frame);
				this.events.push({ id, frame: message.frame });
				return;
			}
			case "ping":
				this.pings.push(message.at);
				return;
			case "ack": {
				this.acks.push(message.id);
				const waiter = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				waiter?.resolve();
				return;
			}
			case "nack": {
				this.nacks.push({ id: message.id, status: message.status, error: message.error });
				const waiter = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				waiter?.reject(new CommandNack(message.id, message.status, message.error));
				return;
			}
		}
	}

	/** Highest seq received so far (the `after` the next dial carries). */
	get lastSeq(): number | null {
		return this.#after;
	}

	/** Send one command (an id is minted when the test gives none); resolves on the ack, rejects on a nack. */
	send(cmd: Record<string, unknown>): Promise<void> {
		const id = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : crypto.randomUUID();
		return this.sendRaw(JSON.stringify({ cmd: { ...cmd, id } }), id);
	}

	/** Send raw text as one message; when `id` is given, resolve on its ack and reject on its nack. */
	sendRaw(text: string | Uint8Array<ArrayBuffer>, id?: string): Promise<void> {
		const ws = this.#ws;
		if (ws === null || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("browser socket is not open"));
		}
		if (id === undefined) {
			ws.send(text);
			return Promise.resolve();
		}
		const settled = Promise.withResolvers<void>();
		this.#pending.set(id, { resolve: settled.resolve, reject: settled.reject });
		ws.send(text);
		return settled.promise;
	}

	/** Resolves with the close code when the socket closes (dropped, refused, closed), or rejects on timeout. */
	async end(timeoutMs = 5000): Promise<SocketClose> {
		if (!this.#closed) throw new Error("browser not open");
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new Error("browser socket did not close")),
			timeoutMs,
		);
		try {
			return await Promise.race([this.#closed, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Close the socket, like a browser tab closing. */
	close(): void {
		this.#ws?.close(1000, "test done");
	}

	/** Reconnect after a drop: the highest received seq rides the new dial as `after`. */
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
 * Mount a standalone edge on an ephemeral loopback port for direct tests
 * (no browser auth: every `/ws` dial is admitted). Pass the transport the
 * edge was built with to also serve /callback/* so a callback-daemon.testkit
 * daemon can dial the pair.
 */
export function serveEdge(
	edge: FleetEdge,
	transport?: DaemonTransportRegistry,
): { port: number; stop(): void } {
	const server = Bun.serve<FleetSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req, srv) => {
			if (new URL(req.url).pathname === BROWSER_SOCKET_PATH) {
				return edge.acceptBrowserSocket(req, srv, { refusal: null, session: null });
			}
			const handled = (await transport?.handleFetch(req, srv)) ?? null;
			if (handled !== null) return handled;
			return (await edge.handleFetch(req)) ?? new Response("not found", { status: 404 });
		},
		websocket: fleetWebSocket(transport, edge),
	});
	return { port: server.port!, stop: () => server.stop(true) };
}

/**
 * Dial /ws for a clientId with a delta-era `after` and collect the RING
 * REPLAY (delta-era frames only) until `want` matches or `timeoutMs`
 * elapses. The probe binds the client (a rebind closes any previous socket),
 * so it must be the LAST use of that clientId in a test. A non-matching
 * `want` falls through to the timeout and returns what was collected;
 * assertions judge the frames.
 */
export async function collectReplay(
	port: number,
	clientId: string,
	after: number,
	want: (f: ServerFrame) => boolean,
	timeoutMs = 3000,
): Promise<Array<{ id: number; frame: ServerFrame }>> {
	const probe = new BrowserSocket(port, clientId, { after });
	await probe.open();
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			if (probe.events.some((ev) => ev.id >= DELTA_SEQ_START && want(ev.frame))) break;
			await sleep(10);
		}
	} finally {
		probe.close();
	}
	return probe.events.filter((ev) => ev.id >= DELTA_SEQ_START);
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
export function testEviction(
	registry: Registry,
	lifecycle: Pick<LifecycleApi, "delete">,
): EdgeEvictionHooks {
	return {
		async evictRow(daemonId, removal) {
			await lifecycle.delete(daemonId);
			const result = await removal();
			registry.remove(daemonId);
			return result;
		},
		async evictProject(projectId) {
			for (const entry of registry.list()) {
				if (entry.projectId === projectId && entry.status !== "asleep") {
					await lifecycle.delete(entry.daemonId);
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
	lifecycle: Pick<LifecycleApi, "start">,
	transport: DaemonTransportRegistry | undefined,
): SessionWaker {
	return new SessionWaker({ registry, lifecycle, transport });
}
