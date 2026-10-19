/**
 * Regression (WIRE-01): a command whose serialized envelope exceeds one SSE
 * record (1 MiB) used to fail validation on the session's down leg and tear
 * the pair down, so every oversize command reconnected under a new
 * connectionId. Commands now travel as ordered chunks to a session that
 * advertises reassembly (CALLBACK_CHUNKS_HEADER). A session without it gets a
 * typed payload_too_large for that call only, and a malformed down record is
 * skipped without costing the pair.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
	CALLBACK_DOWN_PATH,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	CallbackError,
	type CallbackEnvelope,
	encodeSseEnvelope,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../../session/fleet-callback";
import { DaemonTransportRegistry } from "../daemon-transport";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";

const MIB = 1024 * 1024;
const WORKSPACE = "ws-oversize";
const GENERATION = 1;
const cleanups: Array<() => unknown> = [];

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rig {
	registry: DaemonTransportRegistry;
	url: string;
	cred: string;
}

function startRig(opts: { onDroppedRecord?: (message: string) => void } = {}): Rig {
	const registry = new DaemonTransportRegistry(opts);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req) =>
			(await registry.handleFetch(req)) ?? new Response("not found", { status: 404 }),
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
	test("commands over one SSE record reach a chunk-capable session on the same pair", async () => {
		const rig = startRig();
		const session = startSession(rig);
		await session.callback.start();
		const connectionId = session.callback.status().connectionId;

		for (const [id, bytes] of [
			["big-1", 1_300_000],
			["big-4", 4 * MIB],
		] as const) {
			await rig.registry.sendToDaemon(WORKSPACE, bigCommand(id, bytes));
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

		const error = await rig.registry.sendToDaemon(WORKSPACE, bigCommand("over", 33 * MIB)).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error instanceof CallbackError ? error.code : error).toBe("payload_too_large");

		await rig.registry.sendToDaemon(WORKSPACE, bigCommand("small", 1024));
		await session.arrived("browser/small");

		expect(session.callback.status().connectionId).toBe(connectionId);
		expect(session.callback.status().reconnects).toBe(0);
	});

	test("a session without chunk reassembly gets payload_too_large for an oversize command; the pair stays up", async () => {
		const rig = startRig();
		// The callback-daemon fake dials without CALLBACK_CHUNKS_HEADER: an old session.
		const daemon: CallbackDaemon = startCallbackDaemon({
			url: rig.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: rig.cred,
		});
		cleanups.push(() => daemon.stop());
		await daemon.waitConnected();

		const error = await rig.registry.sendToDaemon(WORKSPACE, bigCommand("over", 1_300_000)).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error instanceof CallbackError ? error.code : error).toBe("payload_too_large");

		expect(daemon.connected()).toBe(true);
		expect(daemon.dials()).toBe(1);
	});

	test("a malformed down record is reported and skipped; the pair stays up", async () => {
		const encoder = new TextEncoder();
		let serverConnectionId = "";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === CALLBACK_UP_PATH) {
					// Drain the up leg until the session closes it.
					const reader = req.body?.getReader();
					while (reader && !(await reader.read()).done) {
						// discard session traffic
					}
					return new Response("ok");
				}
				if (path === CALLBACK_DOWN_PATH) {
					const connectionId = req.headers.get("x-omp-connection-id") ?? "";
					serverConnectionId = connectionId;
					const frame = (
						seq: number,
						kind: CallbackEnvelope["kind"],
						streamId: string,
						payload: unknown,
					) =>
						encodeSseEnvelope({
							version: 1,
							workspaceId: WORKSPACE,
							generation: GENERATION,
							connectionId,
							streamId,
							seq,
							kind,
							payload,
							at: Date.now(),
						});
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									encoder.encode(
										frame(1, "control", CALLBACK_TRANSPORT_STREAM_ID, {
											type: CALLBACK_PAIR_READY_TYPE,
											connectionId,
											generation: GENERATION,
										}),
									),
								);
								controller.enqueue(encoder.encode("data: {not json\n\n"));
								controller.enqueue(
									encoder.encode(
										frame(2, "command", "browser/after-bad", { type: "ping", id: "after-bad" }),
									),
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		cleanups.push(() => server.stop(true));

		const session = startSession({ url: `http://127.0.0.1:${server.port}`, cred: "a".repeat(64) });
		await session.callback.start();
		await session.arrived("browser/after-bad");

		expect(session.errors.length).toBeGreaterThan(0);
		expect(session.callback.status().connectionId).toBe(serverConnectionId);
		expect(session.callback.status().reconnects).toBe(0);
		expect(session.callback.status().state).toBe("ready");
	});
});

describe("up-leg records drop without tearing down the pair", () => {
	const UP_CONNECTION = "conn-up-drop";
	const enc = new TextEncoder();

	const envelopeLine = (seq: number, workspaceId = WORKSPACE): string =>
		`${JSON.stringify({
			version: 1,
			workspaceId,
			generation: GENERATION,
			connectionId: UP_CONNECTION,
			streamId: "browser/up-ok",
			seq,
			kind: "frame",
			payload: { type: "ping" },
			at: Date.now(),
		})}\n`;

	/** Raw up POST through the registry; identity rides headers as on the wire. */
	async function postUp(rig: Rig, body: BodyInit): Promise<Response> {
		const res = await rig.registry.handleFetch(
			new Request(`${rig.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: {
					"x-omp-workspace-id": WORKSPACE,
					"x-omp-generation": String(GENERATION),
					"x-omp-connection-id": UP_CONNECTION,
					authorization: `Bearer ${rig.cred}`,
				},
				body,
			}),
		);
		if (!res) throw new Error("up route not handled");
		return res;
	}

	test("malformed and schema-invalid records are dropped and logged", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedRecord: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onDaemonEnvelope(WORKSPACE, (env) => seen.push(env));

		const res = await postUp(rig, `{not json\n{"version":1}\n${envelopeLine(1)}`);

		expect(res.status).toBe(200);
		expect(dropped).toHaveLength(2);
		expect(dropped[0]).toContain("not valid JSON");
		expect(dropped[1]).toContain("invalid callback envelope");
		expect(seen.map((env) => env.seq)).toEqual([1]);
	});

	test("an over-cap record is dropped while streaming; the next record is delivered", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedRecord: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onDaemonEnvelope(WORKSPACE, (env) => seen.push(env));

		// 17 x 64 KiB without a newline crosses the 1 MiB record cap mid-stream.
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < 17; i++) chunks.push(enc.encode("x".repeat(64 * 1024)));
		chunks.push(enc.encode("\n"), enc.encode(envelopeLine(1)));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const res = await postUp(rig, body);

		expect(res.status).toBe(200);
		expect(dropped).toHaveLength(1);
		expect(dropped[0]).toContain("over the");
		expect(seen.map((env) => env.seq)).toEqual([1]);
	});

	test("a record with invalid UTF-8 is dropped; the next record is delivered", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedRecord: (m) => dropped.push(m) });
		const seen: CallbackEnvelope[] = [];
		rig.registry.onDaemonEnvelope(WORKSPACE, (env) => seen.push(env));

		const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a]);
		const res = await postUp(rig, new Blob([bad, enc.encode(envelopeLine(1))]));

		expect(res.status).toBe(200);
		expect(dropped).toHaveLength(1);
		expect(dropped[0]).toContain("not valid UTF-8");
		expect(seen.map((env) => env.seq)).toEqual([1]);
	});

	test("an identity mismatch still ends the upload", async () => {
		const dropped: string[] = [];
		const rig = startRig({ onDroppedRecord: (m) => dropped.push(m) });

		const res = await postUp(rig, envelopeLine(1, "ws-other"));

		expect(res.status).not.toBe(200);
		expect(dropped).toHaveLength(0);
	});
});
