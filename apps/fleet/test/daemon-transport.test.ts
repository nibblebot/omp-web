/**
 * Fleet-side callback transport controlled-peer regressions over the REAL
 * DaemonTransportRegistry: the WebSocket pair (OMP_CALLBACK_PROTO 2) with typed
 * refusals as close codes, pair_ready first, strictly monotonic seq per
 * direction, replacement by a newer socket, no duplicate acceptance, stale and
 * revoked generation rejection, bounded virtual-stream delivery (ordered per
 * stream, streams independent of each other),
 * send-side flow control that never drops silently, the silence sweep, and bulk
 * multi-part sequencing. Every scenario drives the actual registry over real
 * loopback HTTP/WebSocket with controlled daemon sockets, no mock transport,
 * no source assertions, except the two flow-control cases that must make Bun's
 * `send()` report a drop or a full buffer, which no real socket does on demand:
 * those drive the registry's own `websocket` handler with a scripted socket.
 * Each test owns its registry/server and cleans up in a finally.
 *
 * Harness notes:
 * - A refused dial is still upgraded and then closed with a typed code, so a
 *   refusal is observed as the client's close event (code 4000 + the ledger
 *   status, reason `<code>: <message>`), never as an HTTP status.
 * - Every socket mints a fresh connectionId and its own seq space; nothing is
 *   resumed or replayed on a new socket.
 *
 * Timers: these are integration tests over real network state; fake timers
 * cannot advance Bun's network stack, so the suite follows the repo's
 * poll-until-observable waitFor idiom and bounds every deadline. Deadline
 * sweeps (pair silence, bulk TTL) are driven through the registry's injectable
 * clock + sweep cadence (clockedRegistry), never by waiting out a real 30 s.
 */
import { describe, expect, test, vi } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
	BULK_FINAL_HEADER,
	BULK_PART_HEADER,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_PROTO_HEADER,
	CALLBACK_WS_PATH,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	CONNECTION_MAX_BYTES,
	decodeEnvelope,
	ENVELOPE_MAX_BYTES,
	encodeEnvelopeAround,
	HEARTBEAT_INTERVAL_MS,
	OMP_CALLBACK_PROTO,
	PAIR_CREDIT_STEP_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	SILENCE_DEADLINE_MS,
	type CallbackEnvelope,
	type PairCreditControl,
} from "#lib/wire/callback-protocol";
import { DaemonTransportRegistry, type CallbackSocketData } from "../daemon-transport";

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Bun's WebSocket client with its upgrade-header options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => Bun.WebSocket;

/**
 * Poll an observable wire/registry condition until it yields a value or the
 * deadline passes. Real network I/O has no event to await for most of these
 * transitions (the registry exposes no completion callback for delivery),
 * so polling a bounded deadline is the deterministic idiom (shared with the
 * edge/fanout suites).
 */
async function waitFor<T>(
	probe: () => T | undefined,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(20);
	}
}

interface Fixture {
	registry: DaemonTransportRegistry;
	url: string;
	stop(): void;
}

/** Mount one registry on an ephemeral loopback port, exactly as fleet/server.ts does. */
function serve(registry: DaemonTransportRegistry): Fixture {
	const server = Bun.serve<CallbackSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		websocket: registry.websocket,
		fetch: async (req, srv) => {
			const handled = await registry.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
	});
	return {
		registry,
		url: `http://127.0.0.1:${server.port}`,
		stop: () => {
			// Close the registry FIRST: it closes every live pair socket (each
			// client observes a clean close) before the server is torn down.
			registry.close();
			server.stop(true);
		},
	};
}

const wireHeaders = (
	ws: string,
	gen: number,
	connId: string,
	cred: string,
): Record<string, string> => ({
	"x-omp-workspace-id": ws,
	"x-omp-generation": String(gen),
	"x-omp-connection-id": connId,
	authorization: `Bearer ${cred}`,
});

/** Narrowed payload field read: envelope payloads are validated `unknown`. */
function payloadField(env: CallbackEnvelope, key: "id" | "type" | "i"): unknown {
	const p = env.payload;
	if (p === null || typeof p !== "object") return undefined;
	return key in p ? Object.entries(p).find(([name]) => name === key)?.[1] : undefined;
}

const pairReady = (env: CallbackEnvelope): boolean => payloadField(env, "type") === "pair_ready";
const commandId = (env: CallbackEnvelope): unknown => payloadField(env, "id");

interface CloseInfo {
	code: number;
	reason: string;
}

/** One controlled daemon pair socket: a WebSocket dialed at /callback/ws. */
interface PairClient {
	readonly connectionId: string;
	/** Envelopes observed on the live socket, in order. */
	seen(): CallbackEnvelope[];
	/** Push one daemon->fleet envelope; the registry stamps nothing (up seq is the daemon's). */
	push(streamId: string, kind: CallbackEnvelope["kind"], payload: unknown): CallbackEnvelope;
	/** Send one raw message as-is (text or binary). */
	sendRaw(data: string | Uint8Array): void;
	/** Stop reading from the socket: a daemon whose receive side cannot keep up. */
	pause(): void;
	resume(): void;
	/** Daemon-side close (a normal one). */
	close(): void;
	/** Resolves with the close the socket ended with; rejects on deadline. */
	closed(timeoutMs?: number): Promise<CloseInfo>;
}

interface DialOptions {
	connectionId?: string;
	/** Header overrides; null drops the header. */
	headers?: Record<string, string | null>;
}

function dial(
	fixture: Fixture,
	ws: string,
	gen: number,
	cred: string,
	opts: DialOptions = {},
): PairClient {
	const connectionId = opts.connectionId ?? randomUUID();
	const headers: Record<string, string> = {
		...wireHeaders(ws, gen, connectionId, cred),
		[CALLBACK_PROTO_HEADER]: String(OMP_CALLBACK_PROTO),
	};
	for (const [name, value] of Object.entries(opts.headers ?? {})) {
		if (value === null) delete headers[name];
		else headers[name] = value;
	}
	const socket = new BunWebSocket(`${fixture.url.replace(/^http/, "ws")}${CALLBACK_WS_PATH}`, {
		headers,
	});
	const observed: CallbackEnvelope[] = [];
	const closeSignal = Promise.withResolvers<CloseInfo>();
	// A rejected closed() waiter must never surface as an unhandled rejection.
	closeSignal.promise.catch(() => {});
	let upSeq = 0;
	socket.addEventListener("message", (event) => {
		const { data } = event as unknown as MessageEvent<string | ArrayBuffer>;
		if (typeof data === "string") observed.push(decodeEnvelope(data));
	});
	socket.onclose = (event) => closeSignal.resolve({ code: event.code, reason: event.reason });
	// A refused handshake fails with an error and no status; onclose still follows.
	socket.onerror = () => {};
	return {
		connectionId,
		seen: () => observed,
		push(streamId, kind, payload) {
			upSeq += 1;
			const envelope: CallbackEnvelope = {
				version: OMP_CALLBACK_PROTO,
				workspaceId: ws,
				generation: gen,
				connectionId,
				streamId,
				seq: upSeq,
				kind,
				payload,
				at: Date.now(),
			};
			socket.send(JSON.stringify(envelope));
			return envelope;
		},
		sendRaw: (data) => socket.send(data),
		pause: () => socket.pause(),
		resume: () => socket.resume(),
		close: () => socket.close(),
		closed: (timeoutMs = 3000) =>
			Promise.race([
				closeSignal.promise,
				sleep(timeoutMs).then(() => {
					throw new Error(`socket did not close (${timeoutMs}ms)`);
				}),
			]),
	};
}

/** Dial and wait for the fleet's pair_ready: the pair is live. */
async function dialReady(
	fixture: Fixture,
	ws: string,
	gen: number,
	cred: string,
	opts: DialOptions = {},
): Promise<PairClient> {
	const client = dial(fixture, ws, gen, cred, opts);
	await waitFor(() => client.seen().find(pairReady), 3000, "pair_ready");
	return client;
}

async function expectUnavailable(p: Promise<unknown>): Promise<void> {
	await expect(p).rejects.toMatchObject({ code: "unavailable" });
}

/** BULK_IDLE_MS is a module-private registry deadline; the swept bulk test advances past it. */
const SWEEP_TTL_MS = 10 * 60_000;

/** A registry with an injected clock and a fast sweep cadence: advancing
 * `clock` past a registry deadline and polling for the effect exercises the
 * sweep (pair silence, bulk expiry) with no wall-clock wait. The default
 * Date.now + 5 s cadence are what production runs. */
function clockedRegistry(): {
	registry: DaemonTransportRegistry;
	advance: (ms: number) => void;
} {
	let clock = Date.now();
	const registry = new DaemonTransportRegistry({
		now: () => clock,
		sweepIntervalMs: 25,
	});
	return {
		registry,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

/**
 * A scripted server socket handed straight to the registry's `websocket`
 * handler: the one way to make `send()` report a drop (0) or a full buffer on
 * demand, since a real loopback socket never does. The cast stands in for the
 * rest of Bun's ServerWebSocket surface, which the registry never touches.
 */
function scriptedSocket(
	data: CallbackSocketData,
	script: { send?: (text: string) => number; buffered?: () => number },
): { ws: ServerWebSocket<CallbackSocketData>; sent: string[]; closes: CloseInfo[] } {
	const sent: string[] = [];
	const closes: CloseInfo[] = [];
	const ws = {
		data,
		send(text: string): number {
			sent.push(text);
			return script.send?.(text) ?? text.length;
		},
		getBufferedAmount: () => script.buffered?.() ?? 0,
		close(code: number, reason: string): void {
			closes.push({ code, reason });
		},
	} as unknown as ServerWebSocket<CallbackSocketData>;
	return { ws, sent, closes };
}

describe("daemon transport pair: establishment and refusal", () => {
	test("pair_ready is the first message; down seq starts at 1 and stays strictly monotonic; a new socket restarts the space", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-ready";
		const gen = 1;
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			const client = await dialReady(fixture, ws, gen, cred);
			const ready = client.seen()[0]!;
			expect(pairReady(ready)).toBe(true);
			expect(ready).toMatchObject({
				version: 2,
				streamId: "transport",
				kind: "control",
				seq: 1,
				connectionId: client.connectionId,
				payload: { type: "pair_ready", connectionId: client.connectionId, generation: gen },
			});
			expect(fixture.registry.pairStatus(ws)).toMatchObject({
				paired: true,
				connectionId: client.connectionId,
			});

			const c1 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c1" },
			});
			const c2 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c2" },
			});
			expect([c1.seq, c2.seq]).toEqual([2, 3]);
			await waitFor(() => client.seen().find((e) => e.seq === c2.seq), 2000, "c2 delivery");
			expect(client.seen().map((e) => e.seq)).toEqual([1, 2, 3]);
			expect(client.seen().map(commandId)).toEqual([undefined, "c1", "c2"]);

			// A dropped socket is never resumed: the redial is a fresh connectionId
			// and a fresh seq space, and nothing is replayed.
			client.close();
			await client.closed();
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? undefined : true),
				2000,
				"paired:false after close",
			);
			const second = await dialReady(fixture, ws, gen, cred);
			expect(second.connectionId).not.toBe(client.connectionId);
			expect(second.seen()).toHaveLength(1);
			expect(second.seen()[0]!.seq).toBe(1);
			second.close();
			await second.closed();
		} finally {
			fixture.stop();
		}
	});

	test("every refusal arrives as a typed close code: 4401 wrong credential, 4409 superseded generation, 4410 wrong or missing protocol", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-refuse";
		const cred1 = randomBytes(32).toString("hex");
		const cred2 = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred1);
		fixture.registry.enrollWorkspace(ws, 2, cred2); // supersede without revoke
		try {
			// Verified but stale (gen 1 while gen 2 is authorized): the actionable 409.
			const stale = await dial(fixture, ws, 1, cred1).closed();
			expect(stale.code).toBe(4409);
			expect(stale.reason).toStartWith("generation_obsolete: ");

			// An unknown credential at the current generation: plain 401 (no
			// existence oracle), not a generation verdict.
			const wrongCred = await dial(fixture, ws, 2, randomBytes(32).toString("hex")).closed();
			expect(wrongCred.code).toBe(4401);
			expect(wrongCred.reason).toStartWith("unauthorized: ");
			// The gen-1 secret presented at gen 2 is just as unknown.
			expect((await dial(fixture, ws, 2, cred1).closed()).code).toBe(4401);
			// Malformed or missing credential, and missing identity headers, are 401 too.
			expect(
				(await dial(fixture, ws, 2, cred2, { headers: { authorization: null } }).closed()).code,
			).toBe(4401);
			const noConn = await dial(fixture, ws, 2, cred2, {
				headers: { "x-omp-connection-id": null },
			}).closed();
			expect(noConn.code).toBe(4401);
			expect(noConn.reason).toStartWith("invalid_identity: ");

			// A good credential without the proto header, or with another version.
			const noProto = await dial(fixture, ws, 2, cred2, {
				headers: { [CALLBACK_PROTO_HEADER]: null },
			}).closed();
			expect(noProto.code).toBe(4410);
			expect(noProto.reason).toStartWith("proto_unsupported: ");
			expect(
				(await dial(fixture, ws, 2, cred2, { headers: { [CALLBACK_PROTO_HEADER]: "1" } }).closed())
					.code,
			).toBe(4410);

			// A stale credential reads as obsolete before the protocol is looked at.
			expect(
				(await dial(fixture, ws, 1, cred1, { headers: { [CALLBACK_PROTO_HEADER]: null } }).closed())
					.code,
			).toBe(4409);

			// None of that registered a pair; the current generation still works.
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
			const ok = await dialReady(fixture, ws, 2, cred2);
			expect(fixture.registry.pairStatus(ws)).toMatchObject({ paired: true });
			ok.close();
			await ok.closed();
		} finally {
			fixture.stop();
		}
	});

	test("a connectionId already live for another workspace is refused 4401; a request that is no upgrade gets a typed 400; the wrong method 405", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace("ws-owner", 1, cred);
		fixture.registry.enrollWorkspace("ws-thief", 1, cred);
		try {
			const owner = await dialReady(fixture, "ws-owner", 1, cred);
			const stolen = await dial(fixture, "ws-thief", 1, cred, {
				connectionId: owner.connectionId,
			}).closed();
			expect(stolen.code).toBe(4401);
			expect(fixture.registry.pairStatus("ws-thief").paired).toBe(false);
			expect(fixture.registry.pairStatus("ws-owner").connectionId).toBe(owner.connectionId);

			const plain = await fetch(`${fixture.url}${CALLBACK_WS_PATH}`, {
				headers: wireHeaders("ws-owner", 1, randomUUID(), cred),
			});
			expect(plain.status).toBe(400);
			expect(await plain.json()).toMatchObject({ error: "invalid_request" });
			const post = await fetch(`${fixture.url}${CALLBACK_WS_PATH}`, { method: "POST" });
			expect(post.status).toBe(405);
			owner.close();
			await owner.closed();
		} finally {
			fixture.stop();
		}
	});

	test("revoking a generation closes its live pair; the revoked credential is then refused and a new generation pairs", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-revoke";
		const cred1 = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred1);
		try {
			const g1 = await dialReady(fixture, ws, 1, cred1);
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);

			fixture.registry.revokeEnrollment(ws, 1);
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
			expect((await g1.closed()).code).toBe(1000);
			await expectUnavailable(
				fixture.registry.sendToDaemon(ws, { streamId: "control", kind: "command", payload: {} }),
			);

			// The revoked credential is denied outright (the record is gone, so no
			// existence oracle), not as a generation verdict.
			expect((await dial(fixture, ws, 1, cred1).closed()).code).toBe(4401);

			// Renewal at generation 2: new pair, commands stamped gen 2.
			const cred2 = randomBytes(32).toString("hex");
			fixture.registry.enrollWorkspace(ws, 2, cred2);
			const g2 = await dialReady(fixture, ws, 2, cred2);
			const cmd = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "gen2" },
			});
			expect(cmd.generation).toBe(2);
			await waitFor(() => g2.seen().find((e) => e.seq === cmd.seq), 2000, "gen2 delivery");

			fixture.registry.revokeEnrollment(ws, 2);
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
			expect((await g2.closed()).code).toBe(1000);
		} finally {
			fixture.stop();
		}
	});
});

describe("daemon transport pair: replacement", () => {
	test("a newer socket of a workspace becomes its live pair; sends go to it; an older socket still open is the live pair again once it closes", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-replace";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const changes: Array<string | null> = [];
		fixture.registry.onPairChange(ws, (status) => changes.push(status.connectionId));
		try {
			const older = await dialReady(fixture, ws, 1, cred);
			const newer = await dialReady(fixture, ws, 1, cred);
			expect(fixture.registry.pairStatus(ws).connectionId).toBe(newer.connectionId);
			expect(changes).toEqual([older.connectionId, newer.connectionId]);

			const cmd = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "to-newer" },
			});
			await waitFor(() => newer.seen().find((e) => e.seq === cmd.seq), 2000, "newer delivery");
			expect(older.seen().some((e) => commandId(e) === "to-newer")).toBe(false);
			expect(cmd.connectionId).toBe(newer.connectionId);

			newer.close();
			await newer.closed();
			await waitFor(
				() =>
					fixture.registry.pairStatus(ws).connectionId === older.connectionId ? true : undefined,
				2000,
				"older socket live again",
			);
			older.close();
			await older.closed();
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? undefined : true),
				2000,
				"paired:false",
			);
			expect(changes.at(-1)).toBeNull();
		} finally {
			fixture.stop();
		}
	});

	test("with three open sockets the newest is live; closing a middle one keeps it, closing the newest falls back to the newest remaining, and with none open sends throw unavailable", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-replace-three";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const live = (): string | null => fixture.registry.pairStatus(ws).connectionId;
		const sendTo = async (id: string, client: PairClient): Promise<void> => {
			const cmd = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id },
			});
			expect(cmd.connectionId).toBe(client.connectionId);
			await waitFor(() => client.seen().find((e) => e.seq === cmd.seq), 2000, `delivery ${id}`);
		};
		try {
			const first = await dialReady(fixture, ws, 1, cred);
			const second = await dialReady(fixture, ws, 1, cred);
			const third = await dialReady(fixture, ws, 1, cred);
			expect(live()).toBe(third.connectionId);

			second.close();
			await second.closed();
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? true : undefined),
				2000,
				"paired",
			);
			expect(live()).toBe(third.connectionId);
			await sendTo("after-middle", third);

			third.close();
			await third.closed();
			await waitFor(() => (live() === first.connectionId ? true : undefined), 2000, "first live");
			await sendTo("after-newest", first);

			first.close();
			await first.closed();
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? undefined : true),
				2000,
				"down",
			);
			await expectUnavailable(
				fixture.registry.sendToDaemon(ws, { streamId: "control", kind: "command", payload: {} }),
			);
		} finally {
			fixture.stop();
		}
	});
});

describe("daemon transport pair: receive path", () => {
	test("daemon envelopes reach the tap and their sink in arrival order and are counted; a repeated seq closes the pair 4400", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-up-order";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const tapped: string[] = [];
		const sunk: string[] = [];
		fixture.registry.onDaemonEnvelope(ws, (e) => tapped.push(String(commandId(e))));
		fixture.registry.attachVirtualStream(ws, "control", {
			deliver: (e) => {
				sunk.push(String(commandId(e)));
			},
		});
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			for (let i = 0; i < 5; i++) client.push("control", "command", { type: "cmd", id: `c${i}` });
			client.push("control", "heartbeat", {});
			await waitFor(() => (sunk.length === 5 ? true : undefined), 2000, "five envelopes sunk");
			expect(sunk).toEqual(["c0", "c1", "c2", "c3", "c4"]);
			// Heartbeats are transport liveness only: counted, never tapped or sunk.
			expect(tapped).toEqual(sunk);
			await waitFor(
				() => (fixture.registry.pairStatus(ws).envelopesReceived === 6 ? true : undefined),
				2000,
				"six envelopes counted",
			);
			expect(fixture.registry.pairStatus(ws).upBytesIn).toBeGreaterThan(0);

			// Replaying the last envelope's seq is a protocol violation, not bad bytes.
			const replay: CallbackEnvelope = {
				version: 2,
				workspaceId: ws,
				generation: 1,
				connectionId: client.connectionId,
				streamId: "control",
				seq: 6,
				kind: "command",
				payload: { type: "cmd", id: "replayed" },
				at: Date.now(),
			};
			client.sendRaw(JSON.stringify(replay));
			const closed = await client.closed();
			expect(closed.code).toBe(4400);
			expect(closed.reason).toContain("not monotonic");
			expect(sunk).not.toContain("replayed");
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
		} finally {
			fixture.stop();
		}
	});

	test("an envelope naming another workspace, generation or connectionId closes the pair typed and is never delivered", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-identity";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const sunk: string[] = [];
		fixture.registry.attachVirtualStream(ws, "control", { deliver: (e) => void sunk.push(e.kind) });
		try {
			const base = (client: PairClient, over: Partial<CallbackEnvelope>): string =>
				JSON.stringify({
					version: 2,
					workspaceId: ws,
					generation: 1,
					connectionId: client.connectionId,
					streamId: "control",
					seq: 1,
					kind: "command",
					payload: { type: "cmd" },
					at: Date.now(),
					...over,
				});
			const foreign = await dialReady(fixture, ws, 1, cred);
			foreign.sendRaw(base(foreign, { workspaceId: "someone-else" }));
			expect((await foreign.closed()).code).toBe(4403);
			const wrongGen = await dialReady(fixture, ws, 1, cred);
			wrongGen.sendRaw(base(wrongGen, { generation: 9 }));
			expect((await wrongGen.closed()).code).toBe(4403);
			const wrongConn = await dialReady(fixture, ws, 1, cred);
			wrongConn.sendRaw(base(wrongConn, { connectionId: randomUUID() }));
			expect((await wrongConn.closed()).code).toBe(4400);
			expect(sunk).toEqual([]);
		} finally {
			fixture.stop();
		}
	});

	test("bad messages (not JSON, binary, over the envelope cap) are dropped, counted and logged; the pair stays live and ordered", async () => {
		const dropped: string[] = [];
		const fixture = serve(
			new DaemonTransportRegistry({ onDroppedMessage: (m) => dropped.push(m) }),
		);
		const ws = "ws-bad-messages";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const sunk: string[] = [];
		fixture.registry.attachVirtualStream(ws, "control", {
			deliver: (e) => {
				sunk.push(e.kind);
			},
		});
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			client.sendRaw("{ not json");
			client.sendRaw(new Uint8Array([1, 2, 3]));
			// Past the 1 MiB envelope cap but under the socket's message cap: the
			// envelope is dropped alone, the socket survives.
			client.push("control", "frame", { blob: "x".repeat(ENVELOPE_MAX_BYTES + 1024) });
			// The ordered stream carries on: this probe arrives after every bad message.
			client.push("control", "command", { type: "cmd", id: "probe" });
			await waitFor(() => (sunk.includes("command") ? true : undefined), 2000, "probe sunk");
			expect(sunk).toEqual(["command"]);
			expect(dropped).toHaveLength(3);
			expect(dropped.join("\n")).toContain("binary message");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const cmd = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "after-bad" },
			});
			await waitFor(
				() => client.seen().find((e) => e.seq === cmd.seq),
				2000,
				"command after drops",
			);
			client.close();
			await client.closed();
		} finally {
			fixture.stop();
		}
	});

	test("a long-lived pair keeps accepting envelopes past CONNECTION_MAX_BYTES of cumulative traffic", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-up-lifetime";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			const delivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(ws, "stream/settings", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					delivered.push(e);
				},
			});
			// Settings-model-sized answers (~200 KB each), consumed as they arrive:
			// the cap bounds buffered bytes, never the pair's lifetime total.
			const frames = Math.ceil((CONNECTION_MAX_BYTES * 1.5) / 200_000);
			for (let i = 0; i < frames; i++) {
				client.push("stream/settings", "frame", {
					type: "call_result",
					blob: "x".repeat(200_000),
					i,
				});
				if (i % 8 === 7)
					await waitFor(() => (delivered.length > i ? true : undefined), 4000, `frame ${i}`);
			}
			await waitFor(() => (delivered.length === frames ? true : undefined), 4000, "all frames");
			expect(delivered.map((e) => e.seq)).toEqual(Array.from({ length: frames }, (_, i) => i + 1));
			expect(fixture.registry.pairStatus(ws)).toMatchObject({
				paired: true,
				envelopesReceived: frames,
			});
			client.close();
			await client.closed();
		} finally {
			fixture.stop();
		}
	});

	test("a stream whose sink returns a slow promise delays only its own later envelopes, in arrival order; other streams and a sibling workspace are unaffected", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const wsSlow = "ws-slow-sink";
		const wsOther = "ws-other-sink";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(wsSlow, 1, cred);
		fixture.registry.enrollWorkspace(wsOther, 1, cred);
		const gate = Promise.withResolvers<void>();
		const order: string[] = [];
		try {
			const slow = await dialReady(fixture, wsSlow, 1, cred);
			fixture.registry.attachVirtualStream(wsSlow, "stream/slow", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					order.push(`slow:${String(commandId(e))}`);
					await gate.promise;
				},
			});
			fixture.registry.attachVirtualStream(wsSlow, "stream/fast", {
				deliver: (e) => {
					order.push(`fast:${String(commandId(e))}`);
				},
			});
			slow.push("stream/slow", "command", { id: "a" });
			slow.push("stream/fast", "command", { id: "b" });
			slow.push("stream/slow", "command", { id: "c" });
			slow.push("stream/fast", "command", { id: "d" });
			await waitFor(
				() => (order.length >= 3 ? true : undefined),
				2000,
				"the fast stream delivered past the parked slow stream",
			);
			// The slow stream's later envelope waits behind its own sink only.
			await sleep(150);
			expect(order).toEqual(["slow:a", "fast:b", "fast:d"]);
			expect(fixture.registry.pairStatus(wsSlow).envelopesReceived).toBe(4);

			// The sibling workspace has its own pair and sink.
			const other = await dialReady(fixture, wsOther, 1, cred);
			const otherDelivered: string[] = [];
			fixture.registry.attachVirtualStream(wsOther, "control", {
				deliver: (e) => {
					otherDelivered.push(String(commandId(e)));
				},
			});
			other.push("control", "command", { id: "other-1" });
			await waitFor(
				() => (otherDelivered.length === 1 ? true : undefined),
				2000,
				"sibling command while the slow sink is parked",
			);

			gate.resolve();
			await waitFor(() => (order.length === 4 ? true : undefined), 2000, "slow lane drained");
			expect(order).toEqual(["slow:a", "fast:b", "fast:d", "slow:c"]);
			slow.close();
			other.close();
			await Promise.all([slow.closed(), other.closed()]);
		} finally {
			gate.resolve();
			fixture.stop();
		}
	});

	test("a sink gets the payload's own JSON text for canonically framed envelopes, also from its lane queue; padded or re-keyed framing gets none", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-payload-json";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const gate = Promise.withResolvers<void>();
		const got: Array<{ id: unknown; payloadJson: string | undefined }> = [];
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			fixture.registry.attachVirtualStream(ws, "stream/lane", {
				async deliver(e: CallbackEnvelope, payloadJson?: string): Promise<void> {
					got.push({ id: commandId(e), payloadJson });
					await gate.promise;
				},
			});
			const text = '{"id":"b","note":"é日本 \\"q\\"","n":[1,2.5]}';
			client.push("stream/lane", "frame", { id: "a" });
			// Behind the parked sink: one canonical message carrying `text`...
			const second: CallbackEnvelope = {
				version: OMP_CALLBACK_PROTO,
				workspaceId: ws,
				generation: 1,
				connectionId: client.connectionId,
				streamId: "stream/lane",
				seq: 2,
				kind: "frame",
				payload: JSON.parse(text),
				at: Date.now(),
			};
			const { payload: secondPayload, ...secondHead } = second;
			client.sendRaw(encodeEnvelopeAround(secondHead, text));
			// ...one with a padded `at` member, and one pretty-printed.
			const padded = { ...second, seq: 3, payload: { id: "c" } };
			client.sendRaw(JSON.stringify(padded).replace(',"at":', ',"at" :'));
			client.sendRaw(JSON.stringify({ ...second, seq: 4, payload: { id: "d" } }, null, 1));
			await waitFor(
				() => (fixture.registry.pairStatus(ws).envelopesReceived === 4 ? true : undefined),
				2000,
				"four envelopes received",
			);
			gate.resolve();
			await waitFor(() => (got.length === 4 ? true : undefined), 2000, "lane drained");
			expect(secondPayload).toEqual(JSON.parse(text));
			expect(got).toEqual([
				{ id: "a", payloadJson: '{"id":"a"}' },
				{ id: "b", payloadJson: text },
				{ id: "c", payloadJson: undefined },
				{ id: "d", payloadJson: undefined },
			]);
			client.close();
			await client.closed();
		} finally {
			gate.resolve();
			fixture.stop();
		}
	});

	test("each stream is delivered in strict arrival order under interleaving, whether its sink is sync, async or mixed", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-stream-order";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const streams = ["stream/a", "stream/b", "stream/c"] as const;
		const perStream = 30;
		const delivered = new Map<string, number[]>(streams.map((s) => [s, []]));
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			for (const [index, streamId] of streams.entries()) {
				fixture.registry.attachVirtualStream(ws, streamId, {
					// a: async with a varying delay; b: sync; c: async on alternating envelopes.
					deliver: (e) => {
						const n = Number(commandId(e));
						const record = (): void => {
							delivered.get(streamId)!.push(n);
						};
						if (index === 1 || (index === 2 && n % 2 === 0)) {
							record();
							return;
						}
						return sleep(n % 4).then(record);
					},
				});
			}
			for (let n = 0; n < perStream; n++) {
				for (const streamId of streams) client.push(streamId, "command", { id: n });
			}
			await waitFor(
				() =>
					[...delivered.values()].every((list) => list.length === perStream) ? true : undefined,
				4000,
				"every stream delivered",
			);
			const expected = Array.from({ length: perStream }, (_, n) => n);
			for (const streamId of streams) expect(delivered.get(streamId)).toEqual(expected);
			client.close();
			await client.closed();
		} finally {
			fixture.stop();
		}
	});

	test("a stuck sink's backlog is bounded by the credit window: a daemon that sends past it is closed invalid_request (4400) instead of growing it", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-backlog";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const gate = Promise.withResolvers<void>();
		let delivered = 0;
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			fixture.registry.attachVirtualStream(ws, "stream/stuck", {
				async deliver(): Promise<void> {
					delivered += 1;
					await gate.promise;
				},
			});
			// 12 x ~900 KB with no regard for credit: the first is in the sink, the rest
			// park in its lane and hold their credit, so the window is passed.
			const blob = "z".repeat(900_000);
			for (let i = 0; i < 12; i++) client.push("stream/stuck", "frame", { blob, i });
			const closed = await client.closed(5000);
			expect(closed.code).toBe(4400);
			expect(closed.reason).toStartWith("invalid_request: ");
			expect(closed.reason).toContain("credit window");
			expect(delivered).toBe(1);
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
		} finally {
			gate.resolve();
			fixture.stop();
		}
	});

	test("the credit window is pair-wide: several stuck streams that are each under it together close the pair 4400", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-backlog-streams";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		const gate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			for (const streamId of ["stream/stuck-a", "stream/stuck-b"]) {
				fixture.registry.attachVirtualStream(ws, streamId, {
					async deliver(): Promise<void> {
						delivered.push(streamId);
						await gate.promise;
					},
				});
			}
			// Per stream: one in the sink and 5 x ~900 KB parked (~4.5 MB, under the
			// 8 MiB window); both streams together pass it.
			const blob = "z".repeat(900_000);
			for (let i = 0; i < 6; i++) {
				client.push("stream/stuck-a", "frame", { blob, i });
				client.push("stream/stuck-b", "frame", { blob, i });
			}
			const closed = await client.closed(5000);
			expect(closed.code).toBe(4400);
			expect(closed.reason).toStartWith("invalid_request: ");
			expect(delivered.toSorted()).toEqual(["stream/stuck-a", "stream/stuck-b"]);
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
		} finally {
			gate.resolve();
			fixture.stop();
		}
	});

	describe("upload credit", () => {
		const wireBytes = (envelope: CallbackEnvelope): number =>
			Buffer.byteLength(JSON.stringify(envelope), "utf8");

		/** The pair_credit grants a client has seen, in order. */
		const grantsSeen = (client: PairClient): number[] =>
			client
				.seen()
				.filter((e) => e.kind === "control" && payloadField(e, "type") === "pair_credit")
				.map((e) => (e.payload as PairCreditControl).consumed);

		test("grants the cumulative consumed bytes once per step, exactly in the UTF-8 length of what the daemon sent", async () => {
			const fixture = serve(new DaemonTransportRegistry());
			const ws = "ws-credit-grants";
			const cred = randomBytes(32).toString("hex");
			fixture.registry.enrollWorkspace(ws, 1, cred);
			try {
				const client = await dialReady(fixture, ws, 1, cred);
				// Multi-byte text: the unit is bytes, not UTF-16 length.
				const blob = "é€".repeat(60_000);
				const expected: number[] = [];
				let total = 0;
				let granted = 0;
				for (let i = 0; i < 12; i++) {
					total += wireBytes(client.push("stream/none", "frame", { blob, i }));
					if (total - granted >= PAIR_CREDIT_STEP_BYTES) {
						granted = total;
						expected.push(total);
					}
				}
				expect(expected.length).toBeGreaterThan(2);
				await waitFor(
					() => (grantsSeen(client).length >= expected.length ? true : undefined),
					3000,
					"every grant",
				);
				expect(grantsSeen(client)).toEqual(expected);
				const grant = client.seen().find((e) => payloadField(e, "type") === "pair_credit")!;
				expect(grant).toMatchObject({ streamId: "transport", kind: "control" });
				client.close();
				await client.closed();
			} finally {
				fixture.stop();
			}
		});

		test("a daemon that waits for credit sends several windows' worth on one pair and is never closed", async () => {
			const fixture = serve(new DaemonTransportRegistry());
			const ws = "ws-credit-obedient";
			const cred = randomBytes(32).toString("hex");
			fixture.registry.enrollWorkspace(ws, 1, cred);
			try {
				const client = await dialReady(fixture, ws, 1, cred);
				const blob = "z".repeat(300_000);
				let sent = 0;
				let maxOutstanding = 0;
				for (let i = 0; i < 80; i++) {
					// The next message must fit the window beyond the last grant seen.
					const size = wireBytes({
						version: OMP_CALLBACK_PROTO,
						workspaceId: ws,
						generation: 1,
						connectionId: client.connectionId,
						streamId: "stream/none",
						seq: i + 1,
						kind: "frame",
						payload: { blob, i },
						at: Date.now(),
					});
					await waitFor(
						() =>
							sent - (grantsSeen(client).at(-1) ?? 0) + size <= PAIR_CREDIT_WINDOW_BYTES
								? true
								: undefined,
						5000,
						`credit for message ${i}`,
					);
					sent += wireBytes(client.push("stream/none", "frame", { blob, i }));
					maxOutstanding = Math.max(maxOutstanding, sent - (grantsSeen(client).at(-1) ?? 0));
				}
				// 80 x 300 KB is about 3 windows, and every byte was consumed.
				expect(sent).toBeGreaterThan(2 * PAIR_CREDIT_WINDOW_BYTES);
				expect(maxOutstanding).toBeLessThanOrEqual(PAIR_CREDIT_WINDOW_BYTES);
				expect(fixture.registry.pairStatus(ws).paired).toBe(true);
				client.close();
				await client.closed();
			} finally {
				fixture.stop();
			}
		});

		test("credit comes only from the real consumer: a stuck sink holds its bytes, an obedient daemon stops at the window and resumes once the sink drains", async () => {
			const fixture = serve(new DaemonTransportRegistry());
			const ws = "ws-credit-stuck";
			const cred = randomBytes(32).toString("hex");
			fixture.registry.enrollWorkspace(ws, 1, cred);
			const gate = Promise.withResolvers<void>();
			let delivered = 0;
			try {
				const client = await dialReady(fixture, ws, 1, cred);
				fixture.registry.attachVirtualStream(ws, "stream/stuck", {
					async deliver(): Promise<void> {
						delivered += 1;
						await gate.promise;
					},
				});
				const blob = "z".repeat(900_000);
				let sent = 0;
				let i = 0;
				// Send while the window (beyond the last grant seen) has room for one more.
				const pushWhileRoom = (): void => {
					for (;;) {
						const granted = grantsSeen(client).at(-1) ?? 0;
						if (sent - granted + 900_300 > PAIR_CREDIT_WINDOW_BYTES) return;
						sent += wireBytes(client.push("stream/stuck", "frame", { blob, i: i++ }));
					}
				};
				pushWhileRoom();
				// Only the sink's first message was consumed: the credit stops short of the rest.
				await waitFor(() => (delivered === 1 ? true : undefined), 3000, "first delivery");
				expect(i).toBeGreaterThanOrEqual(8);
				expect(sent - (grantsSeen(client).at(-1) ?? 0)).toBeGreaterThan(
					PAIR_CREDIT_WINDOW_BYTES - 2 * 900_300,
				);
				pushWhileRoom();
				expect(fixture.registry.pairStatus(ws).paired).toBe(true);
				const before = grantsSeen(client).at(-1) ?? 0;
				// The sink recovers: the lane drains and the credit follows.
				gate.resolve();
				await waitFor(
					() => ((grantsSeen(client).at(-1) ?? 0) > before ? true : undefined),
					3000,
					"credit after the lane drained",
				);
				const granted = grantsSeen(client).at(-1) ?? 0;
				expect(granted).toBeGreaterThan(PAIR_CREDIT_WINDOW_BYTES - 2 * 900_300);
				expect(granted).toBeLessThanOrEqual(sent);
				expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			} finally {
				gate.resolve();
				fixture.stop();
			}
		});
	});

	test("a daemon download_bulk_failed control fails its own capture correlation at once; a foreign workspace's id is ignored", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk-failed";
		const wsOther = "ws-bulk-failed-other";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		fixture.registry.enrollWorkspace(wsOther, 1, cred);
		try {
			const mine = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const theirs = fixture.registry.createBulkCorrelation(wsOther, { capture: true });
			let theirsSettled = false;
			void theirs.done.then(() => {
				theirsSettled = true;
			});
			const client = await dialReady(fixture, ws, 1, cred);
			client.push("control", "control", {
				type: "download_bulk_failed",
				correlationId: theirs.correlationId,
				error: { code: "unavailable", message: "not yours" },
			});
			client.push("control", "control", {
				type: "download_bulk_failed",
				correlationId: mine.correlationId,
				error: { code: "unavailable", message: "file vanished mid-transfer" },
			});
			const result = await mine.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("file vanished mid-transfer");
			expect(result.chunks).toBeUndefined();
			// Envelopes dispatch in order, so the foreign report was handled before this one.
			expect(theirsSettled).toBe(false);
			theirs.cancel("test cleanup");
			expect((await theirs.done).error).toBe("test cleanup");
			client.close();
			await client.closed();
		} finally {
			fixture.stop();
		}
	});
});

describe("daemon transport pair: send flow control", () => {
	test("a paused reader still receives every envelope, in order, once it resumes: nothing is dropped", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-paused-reader";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			client.pause();
			// ~6 MiB of frames: more than the high-water mark, under the outbox cap.
			const blob = "p".repeat(400_000);
			const sent: CallbackEnvelope[] = [];
			for (let i = 0; i < 15; i++) {
				sent.push(
					await fixture.registry.sendToDaemon(ws, {
						streamId: "browser/x",
						kind: "frame",
						payload: { blob, i },
					}),
				);
			}
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			client.resume();
			await waitFor(
				() => (client.seen().length === 1 + sent.length ? true : undefined),
				8000,
				"every frame delivered after resume",
			);
			expect(client.seen().map((e) => e.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
			expect(
				client
					.seen()
					.slice(1)
					.map((e) => payloadField(e, "i")),
			).toEqual(sent.map((_, i) => i));
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			client.close();
			await client.closed();
		} finally {
			fixture.stop();
		}
	});

	test("a reader that never drains trips the bounded teardown: the pair closes and nothing further is accepted", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-down-bound";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			client.pause();
			// Flood 500 KB frames; the stalled reader lets the unsent bytes cross the
			// 8 MiB per-connection bound.
			const sentSeqs: number[] = [];
			const floodPayload = { type: "frame", blob: "y".repeat(500_000) };
			for (let i = 0; i < 200; i++) {
				try {
					const env = await fixture.registry.sendToDaemon(ws, {
						streamId: "browser/x",
						kind: "frame",
						payload: floodPayload,
					});
					sentSeqs.push(env.seq);
				} catch {
					break; // the registry refused further sends
				}
				if (!fixture.registry.pairStatus(ws).paired) break;
			}
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? undefined : true),
				6000,
				"bounded teardown",
			);
			expect(sentSeqs.length).toBeGreaterThan(0);
			await expectUnavailable(
				fixture.registry.sendToDaemon(ws, {
					streamId: "browser/x",
					kind: "frame",
					payload: floodPayload,
				}),
			);
			// A fresh socket starts its own seq space; nothing was replayed.
			const redial = await dialReady(fixture, ws, 1, cred);
			expect(redial.seen()).toHaveLength(1);
			expect(redial.seen()[0]!.seq).toBe(1);
			redial.close();
			await redial.closed();
		} finally {
			fixture.stop();
		}
	});

	test("nothing is handed to a socket above the high-water mark; envelopes wait in order and flush on drain", async () => {
		const registry = new DaemonTransportRegistry();
		const ws = "ws-high-water";
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, 1, cred);
		try {
			let buffered = 0;
			const connectionId = randomUUID();
			const socket = scriptedSocket(
				{ kind: "callback", refusal: null, workspaceId: ws, generation: 1, connectionId },
				{ buffered: () => buffered, send: () => -1 },
			);
			registry.websocket.open!(socket.ws);
			expect(socket.sent).toHaveLength(1); // pair_ready, the first message
			expect(JSON.parse(socket.sent[0]!)).toMatchObject({
				seq: 1,
				payload: { type: "pair_ready" },
			});

			buffered = CALLBACK_WS_SEND_HIGH_WATER_BYTES + 1;
			const c1 = await registry.sendToDaemon(ws, {
				streamId: "c",
				kind: "command",
				payload: { n: 1 },
			});
			const c2 = await registry.sendToDaemon(ws, {
				streamId: "c",
				kind: "command",
				payload: { n: 2 },
			});
			expect(socket.sent).toHaveLength(1);
			expect(registry.pairStatus(ws).paired).toBe(true);

			// At the mark the socket takes envelopes again; the buffer refilling
			// mid-flush stops the flush where it is.
			buffered = 0;
			registry.websocket.drain!(socket.ws);
			expect(socket.sent.map((text) => decodeEnvelope(text).seq)).toEqual([1, c1.seq, c2.seq]);
			expect(socket.closes).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test("the fleet heartbeats on the transport stream every HEARTBEAT_INTERVAL_MS, in the pair's seq space", () => {
		vi.useFakeTimers();
		const registry = new DaemonTransportRegistry();
		try {
			const ws = "ws-heartbeat";
			const connectionId = randomUUID();
			const socket = scriptedSocket(
				{ kind: "callback", refusal: null, workspaceId: ws, generation: 1, connectionId },
				{ send: () => -1 },
			);
			registry.websocket.open!(socket.ws);
			expect(socket.sent).toHaveLength(1); // pair_ready
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
			expect(socket.sent).toHaveLength(1);
			vi.advanceTimersByTime(1);
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
			const beats = socket.sent.slice(1).map((text) => decodeEnvelope(text));
			expect(beats.map((e) => [e.streamId, e.kind, e.seq])).toEqual([
				["transport", "heartbeat", 2],
				["transport", "heartbeat", 3],
			]);
			// A closed pair stops beating.
			registry.websocket.close!(socket.ws, 1000, "");
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
			expect(socket.sent).toHaveLength(3);
		} finally {
			registry.close();
			vi.useRealTimers();
		}
	});

	test("a send() that reports a drop (0) closes the pair retryable instead of losing the envelope silently", async () => {
		const registry = new DaemonTransportRegistry();
		const ws = "ws-send-dropped";
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, 1, cred);
		try {
			let drop = false;
			const connectionId = randomUUID();
			const socket = scriptedSocket(
				{ kind: "callback", refusal: null, workspaceId: ws, generation: 1, connectionId },
				{ send: () => (drop ? 0 : -1) },
			);
			registry.websocket.open!(socket.ws);
			expect(registry.pairStatus(ws).paired).toBe(true);
			drop = true;
			await registry.sendToDaemon(ws, { streamId: "c", kind: "command", payload: {} });
			expect(registry.pairStatus(ws).paired).toBe(false);
			expect(socket.closes).toHaveLength(1);
			expect(socket.closes[0]!.code).toBe(4503);
			expect(socket.closes[0]!.reason).toStartWith("retryable: ");
			await expectUnavailable(
				registry.sendToDaemon(ws, { streamId: "c", kind: "command", payload: {} }),
			);
		} finally {
			registry.close();
		}
	});
});

describe("daemon transport pair: liveness sweep", () => {
	test("a pair silent past SILENCE_DEADLINE_MS is closed 4503 and reports down; close() ends the rest with 1001", async () => {
		const { registry, advance } = clockedRegistry();
		const fixture = serve(registry);
		const ws = "ws-silence-deadline";
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, 1, cred);
		try {
			const client = await dialReady(fixture, ws, 1, cred);
			const paired = registry.pairStatus(ws);
			expect(paired).toMatchObject({
				paired: true,
				connectionId: client.connectionId,
				envelopesReceived: 0,
			});
			expect(paired.lastEnvelopeAt).not.toBeNull();
			expect(typeof paired.lastDownSendAt).toBe("number");

			// Any daemon message (here a heartbeat) restarts the silence clock.
			advance(SILENCE_DEADLINE_MS - 1_000);
			client.push("control", "heartbeat", {});
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 1 ? true : undefined),
				2000,
				"heartbeat counted",
			);
			advance(SILENCE_DEADLINE_MS - 1_000);
			await sleep(100); // several 25 ms sweeps
			expect(registry.pairStatus(ws).paired).toBe(true);

			// Quiet past the deadline: the sweep closes the socket and reports the
			// pair down. A dead daemon must not look paired (the roster would stay
			// "ready" and commands would be accepted into a zombie socket).
			advance(2_000);
			await waitFor(
				() => (registry.pairStatus(ws).paired ? undefined : true),
				2000,
				"paired:false after silence",
			);
			const killed = registry.pairStatus(ws);
			expect(killed.connectionId).toBeNull();
			expect(killed.lastEnvelopeAt).toBeNull();
			expect(killed.lastDownSendAt).toBeNull();
			expect(killed.envelopesReceived).toBe(0);
			const closed = await client.closed();
			expect(closed.code).toBe(4503);
			expect(closed.reason).toContain("silence deadline");
			// No live pair: sends fail `unavailable`, never queued offline.
			await expectUnavailable(
				registry.sendToDaemon(ws, { streamId: "control", kind: "command", payload: {} }),
			);

			// Fleet shutdown closes live pairs with 1001 (going away).
			const survivor = await dialReady(fixture, ws, 1, cred);
			registry.close();
			expect((await survivor.closed()).code).toBe(1001);
		} finally {
			fixture.stop();
		}
	});

	test("an open bulk correlation idle past BULK_IDLE_MS settles failed as expired, the retryable reason", async () => {
		const { registry, advance } = clockedRegistry();
		const ws = "ws-bulk-ttl";
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, 1, cred);
		try {
			// No upload ever starts: the sweep owns the open correlation's
			// deadline. `done` never rejects; the settle IS the observable.
			const expired = registry.createBulkCorrelation(ws, { capture: true });
			advance(SWEEP_TTL_MS + 1); // past BULK_IDLE_MS
			const result = await expired.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("bulk correlation expired");
			expect(result.bytes).toBe(0);
			expect(result.chunks).toBeUndefined();
		} finally {
			registry.close();
		}
	});
});

describe("daemon transport bulk", () => {
	test("bulk multi-part uploads concatenate exactly once; holes, out-of-order starts, and reuse fail the whole transfer without data", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk";
		const wsOther = "ws-bulk-other";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		fixture.registry.enrollWorkspace(wsOther, 1, cred);
		try {
			// The bulk request names the live pair's connectionId, as a session sends it.
			const pair = await dialReady(fixture, ws, 1, cred);
			const H = wireHeaders(ws, 1, pair.connectionId, cred);
			const bulkUrl = (corr: { correlationId: string }): string =>
				`${fixture.url}${CALLBACK_BULK_PATH_PREFIX}${corr.correlationId}`;
			const postPart = (
				url: string,
				headers: Record<string, string>,
				part?: number,
				final?: boolean,
				body = "",
			): Promise<Response> =>
				fetch(url, {
					method: "POST",
					headers: {
						...headers,
						...(part !== undefined ? { [BULK_PART_HEADER]: String(part) } : {}),
						...(final !== undefined ? { [BULK_FINAL_HEADER]: final ? "1" : "0" } : {}),
					},
					body,
				});

			// Happy sequential parts: part 0 (intermediate) then part 1 (final)
			// concatenate into exactly the original payload.
			const good = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const p0 = await postPart(bulkUrl(good), H, 0, false, "hello ");
			expect(p0.status).toBe(200);
			const p0Body: unknown = await p0.json();
			expect(p0Body).toMatchObject({ status: "part_received" });
			const p1 = await postPart(bulkUrl(good), H, 1, true, "world");
			expect(p1.status).toBe(200);
			const goodResult = await good.done;
			expect(goodResult.state).toBe("received");
			expect(goodResult.bytes).toBe(11);
			expect(Buffer.concat(goodResult.chunks ?? []).toString("utf8")).toBe("hello world");

			// The bulk request rode its own HTTP request: the pair never noticed.
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);

			// Reuse of a settled correlation is refused (single-use ids).
			const reuse = await postPart(bulkUrl(good), H, 2, true, "again");
			expect(reuse.status).toBe(409);

			// A hole in the sequence (0 then 2): the transfer fails as a
			// whole; correlation settles failed and serves no bytes.
			const hole = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const h0 = await postPart(bulkUrl(hole), H, 0, false, "aaa");
			expect(h0.status).toBe(200);
			const h2 = await postPart(bulkUrl(hole), H, 2, true, "ccc");
			expect(h2.status).toBe(409);
			const holeResult = await hole.done;
			expect(holeResult.state).toBe("failed");
			expect(holeResult.chunks).toBeUndefined();

			// An out-of-order FIRST part (1 on a fresh correlation) is
			// rejected the same way; no corrupt prefix is ever buffered.
			const ooo = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const o1 = await postPart(bulkUrl(ooo), H, 1, true, "zzz");
			expect(o1.status).toBe(409);
			const oooResult = await ooo.done;
			expect(oooResult.state).toBe("failed");
			expect(oooResult.chunks).toBeUndefined();

			// A part-less POST is the implicit single-shot transfer.
			const single = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const s0 = await postPart(bulkUrl(single), H, undefined, undefined, "single-shot");
			expect(s0.status).toBe(200);
			const singleResult = await single.done;
			expect(singleResult.state).toBe("received");
			expect(Buffer.concat(singleResult.chunks ?? []).toString("utf8")).toBe("single-shot");

			// Correlations are workspace-scoped: a foreign workspace's upload
			// is rejected (400 unknown correlation) and leaves the record
			// INTACT; the owner still completes it untouched.
			const foreign = fixture.registry.createBulkCorrelation(wsOther, { capture: true });
			const x = await postPart(bulkUrl(foreign), H, 0, true, "steal");
			expect(x.status).toBe(400);
			const xBody: unknown = await x.json();
			expect(xBody).toMatchObject({ error: "invalid_request" });
			// The owner's own upload still lands with exactly its bytes.
			const owner = await postPart(
				bulkUrl(foreign),
				wireHeaders(wsOther, 1, randomUUID(), cred),
				0,
				true,
				"legit",
			);
			expect(owner.status).toBe(200);
			const foreignResult = await foreign.done;
			expect(foreignResult.state).toBe("received");
			expect(foreignResult.bytes).toBe(5);
			expect(Buffer.concat(foreignResult.chunks ?? []).toString("utf8")).toBe("legit");
			pair.close();
			await pair.closed();
		} finally {
			fixture.stop();
		}
	});

	test("cancel settles a capture correlation failed with its reason; a late part is refused and a second cancel changes nothing", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk-cancel";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		try {
			const H = wireHeaders(ws, 1, randomUUID(), cred);
			const urlOf = (corr: { correlationId: string }): string =>
				`${fixture.url}${CALLBACK_BULK_PATH_PREFIX}${corr.correlationId}`;
			const corr = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const first = await fetch(urlOf(corr), {
				method: "POST",
				headers: { ...H, [BULK_PART_HEADER]: "0", [BULK_FINAL_HEADER]: "0" },
				body: "partial",
			});
			expect(first.status).toBe(200);
			corr.cancel("download request aborted");
			const result = await corr.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("download request aborted");
			expect(result.chunks).toBeUndefined();
			const late = await fetch(urlOf(corr), {
				method: "POST",
				headers: { ...H, [BULK_PART_HEADER]: "1", [BULK_FINAL_HEADER]: "1" },
				body: "late",
			});
			expect(late.status).toBe(409);
			corr.cancel("second cancel");
			expect((await corr.done).error).toBe("download request aborted");
		} finally {
			fixture.stop();
		}
	});

	test("capture downloads are capped at BULK_CAPTURE_MAX_OPEN open transfers; settling one frees its slot, and plain bulk is uncapped", async () => {
		const registry = new DaemonTransportRegistry();
		const ws = "ws-bulk-cap";
		try {
			const a = registry.createBulkCorrelation(ws, { capture: true });
			const b = registry.createBulkCorrelation(ws, { capture: true });
			expect(() => registry.createBulkCorrelation(ws, { capture: true })).toThrow(
				"too many concurrent downloads (limit 2)",
			);
			const plain = registry.createBulkCorrelation(ws);
			a.cancel("freed");
			expect((await a.done).state).toBe("failed");
			const c = registry.createBulkCorrelation(ws, { capture: true });
			b.cancel("cleanup");
			c.cancel("cleanup");
			plain.cancel("cleanup");
			await Promise.all([b.done, c.done, plain.done]);
		} finally {
			registry.close();
		}
	});
});
