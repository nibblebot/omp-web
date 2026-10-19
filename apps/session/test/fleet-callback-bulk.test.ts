/**
 * Regression for the bulk channel (SXP-10): a materialize or bulk upload POST
 * had no deadline and was not aborted by stop(), so a fleet that accepted the
 * request and never answered pinned the caller indefinitely. The fake fleet
 * below does exactly that on /callback/bulk/. Also covers drain() (SXP-09): a
 * shutdown drain must confirm queued envelopes reached the fleet on the wire.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MATERIALIZE_REQUEST_TYPE } from "#lib/session-files/wake-materialize";
import {
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_DOWN_PATH,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	CallbackError,
	type CallbackEnvelope,
	decodeEnvelope,
	encodeSseEnvelope,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../fleet-callback";

const WORKSPACE = "ws-bulk";
const GENERATION = 1;
const TOKEN = "b".repeat(64);
const STREAM = "test/bulk";
const BULK_TIMEOUT_MS = 200;

interface FakeFleet {
	url: string;
	/** Count of bulk POSTs received on /callback/bulk/ (accepted, never answered). */
	bulkRequests: number;
	/** Resolves when the first bulk POST reaches the fleet. */
	whenBulkRequested: Promise<void>;
	/** STREAM envelopes received on /callback/up, in arrival order. */
	received: CallbackEnvelope[];
	stop(): void;
}

function startFakeFleet(): FakeFleet {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const downLegs = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
	let notifyBulk: () => void = () => {};
	const whenBulkRequested = new Promise<void>((resolve) => {
		notifyBulk = resolve;
	});
	const fleet: FakeFleet = {
		url: "",
		bulkRequests: 0,
		whenBulkRequested,
		received: [],
		stop: () => {},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const connectionId = req.headers.get("x-omp-connection-id") ?? "";
			if (path === CALLBACK_DOWN_PATH) {
				const ready = encodeSseEnvelope({
					version: 1,
					workspaceId: WORKSPACE,
					generation: GENERATION,
					connectionId,
					streamId: CALLBACK_TRANSPORT_STREAM_ID,
					seq: 1,
					kind: "control",
					payload: { type: CALLBACK_PAIR_READY_TYPE, connectionId, generation: GENERATION },
					at: Date.now(),
				});
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							downLegs.set(connectionId, controller);
							controller.enqueue(encoder.encode(ready));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (path === CALLBACK_UP_PATH) {
				const reader = req.body!.getReader();
				let pending = "";
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						pending += decoder.decode(value, { stream: true });
						let nl = pending.indexOf("\n");
						while (nl !== -1) {
							const line = pending.slice(0, nl);
							pending = pending.slice(nl + 1);
							if (line.trim() !== "") fleet.received.push(decodeEnvelope(line));
							nl = pending.indexOf("\n");
						}
					}
				} catch {
					// The daemon aborted the up leg (teardown).
					return new Response("up leg ended", { status: 499 });
				}
				downLegs.get(connectionId)?.close();
				downLegs.delete(connectionId);
				return new Response("ok");
			}
			if (path.startsWith(CALLBACK_BULK_PATH_PREFIX)) {
				fleet.bulkRequests++;
				notifyBulk();
				return new Promise<Response>(() => {});
			}
			return new Response("not found", { status: 404 });
		},
	});
	fleet.url = `http://127.0.0.1:${server.port}`;
	fleet.stop = () => {
		server.stop(true);
	};
	return fleet;
}

const fleets: FakeFleet[] = [];
const callbacks: FleetCallback[] = [];
afterAll(() => {
	for (const callback of callbacks) callback.stop();
	for (const fleet of fleets) fleet.stop();
});

function makeCallback(fleet: FakeFleet, extra: { bulkTimeoutMs?: number } = {}): FleetCallback {
	const callback = new FleetCallback({
		url: fleet.url,
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		allowHttp: true,
		...extra,
	});
	callbacks.push(callback);
	return callback;
}

/** Resolves with the rejection reason; fails the test if the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("expected the request to reject");
}

const MATERIALIZE = { type: MATERIALIZE_REQUEST_TYPE, sessionId: "session-bulk" } as const;

describe("FleetCallback bulk channel deadlines", () => {
	test("a materialize the fleet never answers fails retryable at the bulk deadline", async () => {
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = makeCallback(fleet, { bulkTimeoutMs: BULK_TIMEOUT_MS });
		await callback.start();

		const started = Date.now();
		const err = await rejectionOf(callback.requestBulkMaterialize(MATERIALIZE));
		expect(err).toBeInstanceOf(CallbackError);
		expect((err as CallbackError).code).toBe("retryable");
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(fleet.bulkRequests).toBe(1);
	}, 15_000);

	test("a bulk upload part the fleet never answers fails retryable at the bulk deadline", async () => {
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = makeCallback(fleet, { bulkTimeoutMs: BULK_TIMEOUT_MS });
		await callback.start();

		const started = Date.now();
		const err = await rejectionOf(
			callback.requestBulkUploadParts({
				correlationId: "corr-upload",
				totalBytes: 4,
				readPart: async () => new Uint8Array(4),
			}),
		);
		expect(err).toBeInstanceOf(CallbackError);
		expect((err as CallbackError).code).toBe("retryable");
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(fleet.bulkRequests).toBe(1);
	}, 15_000);

	test("stop() ends an in-flight materialize without waiting for the bulk deadline", async () => {
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = makeCallback(fleet);
		await callback.start();

		const pending = rejectionOf(callback.requestBulkMaterialize(MATERIALIZE));
		await fleet.whenBulkRequested;
		const stopped = Date.now();
		callback.stop();
		const err = await pending;
		expect(err).toBeInstanceOf(CallbackError);
		expect((err as CallbackError).code).toBe("retryable");
		expect(Date.now() - stopped).toBeLessThan(5_000);
	}, 15_000);
});

describe("FleetCallback drain (shutdown)", () => {
	test("drain() returns once queued envelopes have reached the fleet on the wire", async () => {
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = makeCallback(fleet);
		await callback.start();

		const COUNT = 20;
		for (let i = 0; i < COUNT; i++) {
			expect(callback.send({ streamId: STREAM, kind: "frame", payload: { i } })).toBe("sent");
		}
		await callback.drain(5_000);
		expect(fleet.received.filter((env) => env.streamId === STREAM).length).toBe(COUNT);
	}, 15_000);
});
