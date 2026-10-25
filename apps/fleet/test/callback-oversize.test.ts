/**
 * Regression (WIRE-01): a command whose serialized envelope exceeds one pair
 * message (1 MiB) used to fail validation on the session's down leg and tear
 * the pair down, so every oversize command reconnected under a new
 * connectionId. Commands now always travel as ordered chunks (every proto-2
 * session reassembles them), and a malformed message in either direction is
 * dropped and counted without costing the pair.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_WS_PATH,
	CallbackError,
	type CallbackEnvelope,
	ENVELOPE_MAX_BYTES,
	OMP_CALLBACK_PROTO,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../../session/fleet-callback";
import { SessionTransportRegistry, type CallbackSocketData } from "../session-transport";
import { waitFor } from "./edge.testkit";

/** Bun's WebSocket client with its upgrade-header options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => Bun.WebSocket;

const MIB = 1024 * 1024;
const WORKSPACE = "ws-oversize";
const GENERATION = 1;
const cleanups: Array<() => unknown> = [];

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rig {
	registry: SessionTransportRegistry;
	url: string;
	cred: string;
}

function startRig(opts: { onDroppedMessage?: (message: string) => void } = {}): Rig {
	const registry = new SessionTransportRegistry(opts);
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
	const cred = randomBytes(32).toString("hex");
	registry.enrollWorkspace(WORKSPACE, GENERATION, cred);
	cleanups.push(() => {
		registry.close();
		server.stop(true);
	});
	return { registry, url: `http://127.0.0.1:${server.port}`, cred };
}

interface Session {
	callback: FleetCallback;
	errors: unknown[];
	/** Resolves with the delivered envelope on `streamId`, once it has arrived. */
	arrived(streamId: string): Promise<CallbackEnvelope>;
	/** Every delivered down envelope, in order. */
	envelopes(): CallbackEnvelope[];
}

/** A real session-side FleetCallback dialing `target`, with deliveries recorded. */
function startSession(target: Pick<Rig, "url" | "cred">): Session {
	const envelopes: CallbackEnvelope[] = [];
	const errors: unknown[] = [];
	const waiting: Array<{ streamId: string; resolve: (envelope: CallbackEnvelope) => void }> = [];
	const callback = new FleetCallback(
		{
			url: target.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: target.cred,
			allowHttp: true,
			backoffMinMs: 25,
			backoffMaxMs: 100,
		},
		{
			onEnvelope: (envelope) => {
				envelopes.push(envelope);
				for (const waiter of waiting) {
					if (waiter.streamId === envelope.streamId) waiter.resolve(envelope);
				}
			},
			onError: (error) => errors.push(error),
		},
	);
	cleanups.push(() => callback.stop());
	return {
		callback,
		errors,
		envelopes: () => envelopes,
		arrived(streamId) {
			const found = envelopes.find((envelope) => envelope.streamId === streamId);
			if (found) return Promise.resolve(found);
			const { promise, resolve } = Promise.withResolvers<CallbackEnvelope>();
			waiting.push({ streamId, resolve });
			return promise;
		},
	};
}

/** A command draft whose serialized size is about `bytes`, addressed to one browser stream. */
function bigCommand(id: string, bytes: number) {
	return {
		streamId: `browser/${id}`,
		kind: "command" as const,
		payload: { type: "call", id, blob: "A".repeat(bytes) },
	};
}

/** The `blob` string of a delivered test command; throws on any other shape. */
function blobOf(envelope: CallbackEnvelope): string {
	const payload = envelope.payload;
	if (
		payload &&
		typeof payload === "object" &&
		"blob" in payload &&
		typeof payload.blob === "string"
	) {
		return payload.blob;
	}
	throw new Error(`envelope on ${envelope.streamId} carries no blob`);
}

describe("oversize commands on the callback pair", () => {
	test("commands over one pair message reach the session on the same pair", async () => {
		const rig = startRig();
		const session = startSession(rig);
		await session.callback.start();
		const connectionId = session.callback.status().connectionId;

		for (const [id, bytes] of [
			["big-1", 1_300_000],
			["big-4", 4 * MIB],
		] as const) {
			await rig.registry.sendToSession(WORKSPACE, bigCommand(id, bytes));
			const delivered = await session.arrived(`browser/${id}`);
			expect(blobOf(delivered).length).toBe(bytes);
		}

		expect(session.callback.status().connectionId).toBe(connectionId);
		expect(session.callback.status().reconnects).toBe(0);
		expect(session.errors).toEqual([]);
	});

	test("a command over the 32 MiB cap fails only that call; the pair stays up", async () => {
		const rig = startRig();
		const session = startSession(rig);
		await session.callback.start();
		const connectionId = session.callback.status().connectionId;

		const error = await rig.registry.sendToSession(WORKSPACE, bigCommand("over", 33 * MIB)).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error instanceof CallbackError ? error.code : error).toBe("payload_too_large");

		await rig.registry.sendToSession(WORKSPACE, bigCommand("small", 1024));
		await session.arrived("browser/small");

		expect(session.callback.status().connectionId).toBe(connectionId);
		expect(session.callback.status().reconnects).toBe(0);
	});

	test("an oversize frame (not a command) is refused payload_too_large; the pair stays up", async () => {
		const rig = startRig();
		const session = startSession(rig);
		await session.callback.start();
		const connectionId = session.callback.status().connectionId;

		const error = await rig.registry
			.sendToSession(WORKSPACE, {
				streamId: "browser/frame",
				kind: "frame",
				payload: { blob: "F".repeat(ENVELOPE_MAX_BYTES + 1024) },
			})
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error instanceof CallbackError ? error.code : error).toBe("payload_too_large");
		expect(session.callback.status().connectionId).toBe(connectionId);
		expect(session.callback.status().reconnects).toBe(0);
	});

	test("a malformed down message is reported and skipped; the pair stays up", async () => {
		let serverConnectionId = "";
		const frame = (
			connectionId: string,
			seq: number,
			kind: CallbackEnvelope["kind"],
			streamId: string,
			payload: unknown,
		): string =>
			JSON.stringify({
				version: OMP_CALLBACK_PROTO,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				connectionId,
				streamId,
				seq,
				kind,
				payload,
				at: Date.now(),
			});
		// A scripted fleet half: upgrades the pair, then sends pair_ready, one bad
		// message and a valid command, in that order.
		const server = Bun.serve<{ connectionId: string }>({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch(req, srv) {
				const connectionId = req.headers.get("x-omp-connection-id") ?? "";
				if (
					new URL(req.url).pathname === CALLBACK_WS_PATH &&
					srv.upgrade(req, { data: { connectionId } })
				) {
					return;
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open(ws) {
					const { connectionId } = ws.data;
					serverConnectionId = connectionId;
					ws.send(
						frame(connectionId, 1, "control", CALLBACK_TRANSPORT_STREAM_ID, {
							type: CALLBACK_PAIR_READY_TYPE,
							connectionId,
							generation: GENERATION,
						}),
					);
					ws.send("{not json");
					ws.send(
						frame(connectionId, 2, "command", "browser/after-bad", {
							type: "ping",
							id: "after-bad",
						}),
					);
				},
				message() {},
			},
		});
		cleanups.push(() => server.stop(true));

		const session = startSession({ url: `http://127.0.0.1:${server.port}`, cred: "a".repeat(64) });
		await session.callback.start();
		await session.arrived("browser/after-bad");

		expect(session.errors.length).toBeGreaterThan(0);
		expect(session.callback.status().connectionId).toBe(serverConnectionId);
		expect(session.callback.status().badMessages).toBe(1);
		expect(session.callback.status().reconnects).toBe(0);
		expect(session.callback.status().state).toBe("ready");
	});
});

describe("session messages drop without tearing down the pair", () => {
	/** A raw session socket dialed at the rig, open and past pair_ready. */
	async function dialRaw(rig: Rig): Promise<{ socket: Bun.WebSocket; connectionId: string }> {
		const connectionId = randomUUID();
		const socket = new BunWebSocket(`${rig.url.replace(/^http/, "ws")}${CALLBACK_WS_PATH}`, {
			headers: {
				"x-omp-workspace-id": WORKSPACE,
				"x-omp-generation": String(GENERATION),
				"x-omp-connection-id": connectionId,
				authorization: `Bearer ${rig.cred}`,
				[CALLBACK_PROTO_HEADER]: String(OMP_CALLBACK_PROTO),
			},
		});
		const ready = Promise.withResolvers<void>();
		socket.onmessage = () => ready.resolve();
		socket.onerror = () => ready.reject(new Error("pair dial failed"));
		cleanups.push(() => socket.close());
		await ready.promise;
		return { socket, connectionId };
	}

	const envelopeText = (
		connectionId: string,
		seq: number,
		over: Partial<CallbackEnvelope> = {},
	): string =>
		JSON.stringify({
			version: OMP_CALLBACK_PROTO,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			connectionId,
			streamId: "browser/up-ok",
			seq,
			kind: "frame",
			payload: { type: "ping" },
			at: Date.now(),
			...over,
		});

	test("malformed and schema-invalid messages are dropped and logged", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedMessage: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onSessionEnvelope(WORKSPACE, (env) => seen.push(env));
		const { socket, connectionId } = await dialRaw(rig);

		socket.send("{not json");
		socket.send('{"version":2}');
		socket.send(envelopeText(connectionId, 1));
		await waitFor(() => (seen.length === 1 ? true : null), 3000, "valid message delivered");

		expect(dropped).toHaveLength(2);
		expect(dropped[0]).toContain("not valid JSON");
		expect(dropped[1]).toContain("invalid callback envelope");
		expect(seen.map((env) => env.seq)).toEqual([1]);
		expect(rig.registry.pairStatus(WORKSPACE).paired).toBe(true);
	});

	test("an envelope over the 1 MiB cap is dropped; the next message is delivered", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedMessage: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onSessionEnvelope(WORKSPACE, (env) => seen.push(env));
		const { socket, connectionId } = await dialRaw(rig);

		// Above the envelope cap, below the socket's 2 MiB message cap.
		socket.send(
			envelopeText(connectionId, 1, { payload: { blob: "x".repeat(ENVELOPE_MAX_BYTES + 4096) } }),
		);
		socket.send(envelopeText(connectionId, 2));
		await waitFor(() => (seen.length === 1 ? true : null), 3000, "next message delivered");

		expect(dropped).toHaveLength(1);
		expect(dropped[0]).toContain("over the");
		expect(seen.map((env) => env.seq)).toEqual([2]);
		expect(rig.registry.pairStatus(WORKSPACE).paired).toBe(true);
	});

	test("a binary message is dropped; the next message is delivered", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedMessage: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onSessionEnvelope(WORKSPACE, (env) => seen.push(env));
		const { socket, connectionId } = await dialRaw(rig);

		socket.send(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
		socket.send(envelopeText(connectionId, 1));
		await waitFor(() => (seen.length === 1 ? true : null), 3000, "next message delivered");

		expect(dropped).toHaveLength(1);
		expect(dropped[0]).toContain("binary message");
		expect(seen.map((env) => env.seq)).toEqual([1]);
	});

	test("an identity mismatch still ends the pair", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedMessage: (m) => dropped.push(m) });
		const { socket, connectionId } = await dialRaw(rig);

		const closed = Promise.withResolvers<number>();
		socket.onclose = (event) => closed.resolve(event.code);
		socket.send(envelopeText(connectionId, 1, { workspaceId: "ws-other" }));

		expect(await closed.promise).toBe(4403);
		expect(dropped).toHaveLength(0);
		expect(rig.registry.pairStatus(WORKSPACE).paired).toBe(false);
	});
});
