/**
 * Regression for the bulk channel (SXP-10): a materialize or bulk upload POST
 * had no deadline and was not aborted by stop(), so a fleet that accepted the
 * request and never answered pinned the caller indefinitely. The fake fleet
 * below does exactly that on /callback/bulk/. Bulk requests stay plain HTTP
 * beside the pair socket and name the live pair's connectionId. Also covers
 * drain() (SXP-09): a shutdown drain must confirm queued envelopes reached the
 * fleet on the wire and close the socket normally.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MATERIALIZE_REQUEST_TYPE } from "#lib/session-files/wake-materialize";
import { CallbackError } from "#lib/wire/callback-protocol";
import { FleetCallback } from "../fleet-callback";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.testkit";

const WORKSPACE = "ws-bulk";
const GENERATION = 1;
const TOKEN = "b".repeat(64);
const STREAM = "test/bulk";
const BULK_TIMEOUT_MS = 200;

interface BulkFleet {
	fleet: FakeFleet;
	/** Bulk POSTs received (accepted, never answered), with the headers each carried. */
	bulkHeaders: Headers[];
	/** Resolves when the first bulk POST reaches the fleet. */
	whenBulkRequested: Promise<void>;
}

function startBulkFleet(): BulkFleet {
	let notifyBulk: () => void = () => {};
	const whenBulkRequested = new Promise<void>((resolve) => {
		notifyBulk = resolve;
	});
	const bulkHeaders: Headers[] = [];
	const fleet = startFakeFleet({
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		bulk: (req) => {
			bulkHeaders.push(req.headers);
			notifyBulk();
			return new Promise<Response>(() => {});
		},
	});
	return { fleet, bulkHeaders, whenBulkRequested };
}

const fleets: FakeFleet[] = [];
const callbacks: FleetCallback[] = [];
afterAll(() => {
	for (const callback of callbacks) callback.stop();
	for (const fleet of fleets) fleet.stop();
});

function makeCallback(fleet: FakeFleet, extra: { bulkTimeoutMs?: number } = {}): FleetCallback {
	fleets.push(fleet);
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
		const { fleet, bulkHeaders } = startBulkFleet();
		const callback = makeCallback(fleet, { bulkTimeoutMs: BULK_TIMEOUT_MS });
		await callback.start();

		const started = Date.now();
		const err = await rejectionOf(callback.requestBulkMaterialize(MATERIALIZE));
		expect(err).toBeInstanceOf(CallbackError);
		expect((err as CallbackError).code).toBe("retryable");
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(bulkHeaders.length).toBe(1);
	}, 15_000);

	test("a bulk request names the live socket pair and carries the credential in headers", async () => {
		const { fleet, bulkHeaders } = startBulkFleet();
		const callback = makeCallback(fleet, { bulkTimeoutMs: BULK_TIMEOUT_MS });
		await callback.start();

		await rejectionOf(callback.requestBulkMaterialize(MATERIALIZE));
		const headers = bulkHeaders[0]!;
		expect(headers.get("x-omp-connection-id")).toBe(fleet.connectionId()!);
		expect(headers.get("x-omp-connection-id")).toBe(callback.status().connectionId!);
		expect(headers.get("x-omp-workspace-id")).toBe(WORKSPACE);
		expect(headers.get("x-omp-generation")).toBe(String(GENERATION));
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
	}, 15_000);

	test("a bulk upload part the fleet never answers fails retryable at the bulk deadline", async () => {
		const { fleet, bulkHeaders } = startBulkFleet();
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
		expect(bulkHeaders.length).toBe(1);
	}, 15_000);

	test("stop() ends an in-flight materialize without waiting for the bulk deadline", async () => {
		const { fleet, whenBulkRequested } = startBulkFleet();
		const callback = makeCallback(fleet);
		await callback.start();

		const pending = rejectionOf(callback.requestBulkMaterialize(MATERIALIZE));
		await whenBulkRequested;
		const stopped = Date.now();
		callback.stop();
		const err = await pending;
		expect(err).toBeInstanceOf(CallbackError);
		expect((err as CallbackError).code).toBe("retryable");
		expect(Date.now() - stopped).toBeLessThan(5_000);
	}, 15_000);
});

describe("FleetCallback drain (shutdown)", () => {
	test("drain() returns once queued envelopes have reached the fleet on the wire, then closes the socket normally", async () => {
		const { fleet } = startBulkFleet();
		const callback = makeCallback(fleet);
		await callback.start();

		const COUNT = 20;
		for (let i = 0; i < COUNT; i++) {
			expect(callback.send({ streamId: STREAM, kind: "frame", payload: { i } })).toBe("sent");
		}
		await callback.drain(5_000);
		// Bun's client reports the close as soon as it is initiated, not when the peer
		// has read: the fleet side is awaited for the data and the close frame behind it.
		expect(callback.status().pendingEnvelopes).toBe(0);
		await fleet.whenClosed(1);
		expect(fleet.received.filter((env) => env.streamId === STREAM).length).toBe(COUNT);
		expect(fleet.closes.map((close) => close.code)).toEqual([1000]);
		// A drained pair is not a failure and dials no replacement.
		expect(callback.status().reconnects).toBe(0);
		expect(fleet.upgrades.length).toBe(1);
	}, 15_000);
});
