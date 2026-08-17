/**
 * Shared fakes and harness for the split fleet edge suites (edge-wire,
 * edge-pipe, edge-worktrees): a fake omp-session / pipe daemon serving the
 * OMP_PROTO 2 wire contract, a browser SSE edge client, ring replay
 * collection, and polling helpers. Named *.testkit.ts so bun test discovery
 * never picks it up as a suite.
 */
import { join } from "node:path";
import { OMP_PROTO, SSE_DELTA_SEQ_START, SSE_EVENT_NAME } from "../shared/protocol";
import type { DaemonEntry, DaemonInfo, ServerFrame } from "../shared/protocol";
import { encodeSseEvent, parseSseUnits, SSE_PING_BLOCK } from "../shared/sse";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import type { FleetEdge } from "./edge";

export { cleanupTempDirs };

/** Fake omp-session cwd — under a testkit temp dir so the afterAll reaps it. */
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
		outputBytes: 0,
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
export interface FakeStreamSeen {
	authHeader: string | null;
	closed: boolean;
}

export interface FakeSession {
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
export function startFakeSession(opts: { cwd?: string } = {}): FakeSession {
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
						const answer = encodeSseEvent(
							SSE_EVENT_NAME,
							{ type: "call_result", id: cmd.id, ok: true, data: { echoed: frame } },
							nextSeq++,
						);
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
		write(
			encodeSseEvent(
				SSE_EVENT_NAME,
				{
					type: "hello_ok",
					proto: OMP_PROTO,
					name: "fake",
					cwd,
					pid: 4242,
					version: "0.0.0-test",
					sessionFile,
				},
				seq++,
			),
		);
		// Phase 6 wire format: omp-session keeps the required "s1" on `attached` but
		// no longer stamps session-scoped frames — the edge adds the daemonId.
		write(encodeSseEvent(SSE_EVENT_NAME, { type: "attached", sessionId: "s1" }, seq++));
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
			const frame = encodeSseEvent(
				SSE_EVENT_NAME,
				{ type: "daemons", daemons: entries },
				nextSeq++,
			);
			for (const write of live) write(frame);
		},
		close: () => {
			server.stop(true);
		},
	};
}

export interface PipeFake {
	url: string;
	port: number;
	/** Last-Event-ID seen on each /events open, in open order (null when absent). */
	lastEventIds(): Array<string | null>;
	/** Stop the heartbeat keepalives: the pipe then goes silent (the edge trips its deadline). */
	pause(): void;
	/** Drop ONE live stream non-cleanly (index 0 = the connector's control stream, 1 = the pipe). */
	killStream(index: number): void;
	/** Drop every live stream non-cleanly (a daemon-side kill). */
	kill(): void;
	/** Broadcast a delta to live streams AND ring it for Last-Event-ID replay. */
	emitDelta(frame: ServerFrame): void;
	close(): void;
}

/**
 * Fake daemon for the pipe tests: primes every /events stream (the
 * connector's control stream and the edge's pipe), answers prompt calls
 * with call_result on all open streams, emits keepalive ping events every
 * heartbeatMs while not paused, and — like the real omp-session — keeps a
 * delta ring so a stream opened with Last-Event-ID ≥ SSE_DELTA_SEQ_START
 * replays the deltas it missed after the full priming.
 */
export function startPipeFake(opts: { heartbeatMs?: number } = {}): PipeFake {
	const heartbeatMs = opts.heartbeatMs ?? 30;
	let paused = false;
	const encoder = new TextEncoder();
	const live: Array<(block: string) => void> = [];
	const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
	const seen: Array<string | null> = [];
	const ring: Array<{ seq: number; block: string }> = [];
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
						const seq = nextSeq++;
						const block = encodeSseEvent(
							SSE_EVENT_NAME,
							{ type: "call_result", id: cmd.id, ok: true, data: { echoed: frame } },
							seq,
						);
						ring.push({ seq, block });
						for (const write of live) write(block);
					}
					return Response.json({ commandId: cmd.id ?? "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			const lastEventId = req.headers.get("last-event-id");
			seen.push(lastEventId);
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const write = (block: string): void => {
				try {
					controller!.enqueue(encoder.encode(block));
				} catch {
					// Stream already errored/closed (kill); the consumer saw the end.
				}
			};
			live.push(write);
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					controller = ctrl;
					controllers.push(ctrl);
					// Full priming on EVERY open (the real daemon re-primes even
					// for a delta resume), then ring replay for delta-era ids.
					let seq = 1;
					write(
						encodeSseEvent(
							SSE_EVENT_NAME,
							{
								type: "hello_ok",
								proto: OMP_PROTO,
								name: "pipe-fake",
								cwd: FAKE_CWD,
								pid: 4243,
								version: "0.0.0-test",
							},
							seq++,
						),
					);
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "attached", sessionId: "s1" }, seq++));
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "history", messages: [] }, seq++));
					write(
						encodeSseEvent(
							SSE_EVENT_NAME,
							{ type: "state", state: { ...FAKE_STATE, sessionFile: FAKE_SESSION_FILE } },
							seq++,
						),
					);
					write(
						encodeSseEvent(SSE_EVENT_NAME, { type: "available_commands", commands: [] }, seq++),
					);
					write(encodeSseEvent(SSE_EVENT_NAME, { type: "ready", readyAt: Date.now() }, seq++));
					const last = lastEventId === null ? NaN : Number(lastEventId);
					if (Number.isFinite(last) && last >= SSE_DELTA_SEQ_START) {
						for (const entry of ring) {
							if (entry.seq > last) write(entry.block);
						}
					}
				},
				cancel() {
					const index = live.indexOf(write);
					if (index !== -1) {
						live.splice(index, 1);
						controllers.splice(index, 1);
					}
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
		lastEventIds: () => [...seen],
		pause: () => {
			paused = true;
		},
		killStream: (index: number) => {
			const ctrl = controllers[index];
			// A clean close is still a non-intentional drop to the edge (the
			// consume loop's EOF path redials); close avoids Bun reporting an
			// unhandled stream error the way controller.error() does.
			if (ctrl) ctrl.close();
		},
		kill: () => {
			for (const ctrl of [...controllers]) ctrl.close();
		},
		emitDelta: (frame: ServerFrame) => {
			const seq = nextSeq++;
			const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
			ring.push({ seq, block });
			for (const write of live) write(block);
		},
		close: () => {
			clearInterval(heartbeat);
			server.stop(true);
		},
	};
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

/** Mount a standalone edge on an ephemeral loopback port for direct tests. */
export function serveEdge(edge: FleetEdge): { port: number; stop(): void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) =>
			(await edge.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	return { port: server.port!, stop: () => server.stop(true) };
}

/**
 * Open /events for a clientId with a delta-era Last-Event-ID and collect the
 * RING REPLAY (delta-era frames only) until `want` matches or `timeoutMs`
 * elapses. The probe binds the client (a rebind closes any previous stream),
 * so it must be the LAST use of that clientId in a test. A non-matching
 * `want` falls through to the timeout abort and returns what was collected —
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
