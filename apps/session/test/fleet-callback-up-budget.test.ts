/**
 * Regression: the fleet's Bun.serve counts a streaming /callback/up request
 * body against maxRequestBodySize for the WHOLE life of the POST (default
 * 128 MiB). The up leg is one long-lived POST per pair, so without a renewal
 * before that budget the platform cuts the upload mid-stream and the pair is
 * replaced as a failure ("callback up body cancelled"). The fake fleet below
 * enforces the same lifetime cap, scaled down, and the daemon must renew the
 * pair voluntarily (UP_RENEWAL_BYTES) before it is reached.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	CALLBACK_DOWN_PATH,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	type CallbackEnvelope,
	decodeEnvelope,
	encodeSseEnvelope,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../fleet-callback";

/** Stand-in for Bun's per-request body cap, applied cumulatively to /callback/up. */
const CAP_BYTES = 256 * 1024;
/** Daemon renews the pair once the up leg has carried this many bytes. */
const RENEWAL_BYTES = 64 * 1024;
const WORKSPACE = "ws-up-budget";
const GENERATION = 1;
const TOKEN = "a".repeat(64);
const STREAM = "test/up-budget";
const ENVELOPES = 40;
const PAD_BYTES = 8 * 1024;

interface FakeFleet {
	url: string;
	upRequests: number;
	capHits: number;
	received: CallbackEnvelope[];
	/** Resolves once `count` envelopes on STREAM have been received. */
	whenReceived(count: number): Promise<void>;
	stop(): void;
	/** Withholds pair_ready on the next down leg until releaseReady(). */
	holdNextReady(): void;
	/** Releases the withheld pair_ready. */
	releaseReady(): void;
	/** connectionId of the down leg whose pair_ready is withheld, once dialed. */
	heldConnectionId: string | null;
	/** STREAM envelopes received on `connectionId`. */
	envelopesOn(connectionId: string): number;
	/** Resolves with the connectionId of the held down leg once it has dialed. */
	whenHeld(): Promise<string>;
}

function startFakeFleet(): FakeFleet {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const downLegs = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
	let holdNext = false;
	let releaseHeld: (() => void) | null = null;
	let onHeld: ((connectionId: string) => void) | null = null;
	const fleet: FakeFleet = {
		url: "",
		upRequests: 0,
		capHits: 0,
		received: [],
		heldConnectionId: null,
		whenHeld() {
			if (fleet.heldConnectionId !== null) return Promise.resolve(fleet.heldConnectionId);
			return new Promise<string>((resolve) => {
				onHeld = resolve;
			});
		},
		whenReceived(count) {
			if (fleet.received.filter((env) => env.streamId === STREAM).length >= count) {
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				waiters.push({ count, resolve });
			});
		},
		holdNextReady() {
			holdNext = true;
		},
		releaseReady() {
			const release = releaseHeld;
			releaseHeld = null;
			release?.();
		},
		envelopesOn(connectionId) {
			return fleet.received.filter(
				(env) => env.streamId === STREAM && env.connectionId === connectionId,
			).length;
		},
		stop: () => {},
	};
	const notify = () => {
		const delivered = fleet.received.filter((env) => env.streamId === STREAM).length;
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (delivered < waiters[i]!.count) continue;
			waiters[i]!.resolve();
			waiters.splice(i, 1);
		}
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
				const held = holdNext;
				holdNext = false;
				if (held) {
					fleet.heldConnectionId = connectionId;
					onHeld?.(connectionId);
				}
				// Closed once the up leg ends cleanly (renewal), as the real fleet does.
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							downLegs.set(connectionId, controller);
							if (held) releaseHeld = () => controller.enqueue(encoder.encode(ready));
							else controller.enqueue(encoder.encode(ready));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (path === CALLBACK_UP_PATH) {
				fleet.upRequests++;
				const reader = req.body!.getReader();
				let total = 0;
				let pending = "";
				const takeLines = (text: string) => {
					pending += text;
					let nl = pending.indexOf("\n");
					while (nl !== -1) {
						const line = pending.slice(0, nl);
						pending = pending.slice(nl + 1);
						if (line.trim() !== "") fleet.received.push(decodeEnvelope(line));
						nl = pending.indexOf("\n");
					}
					notify();
				};
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						total += value.byteLength;
						if (total > CAP_BYTES) {
							fleet.capHits++;
							await reader.cancel("request body exceeded cap");
							return new Response("request body exceeded cap", { status: 413 });
						}
						takeLines(decoder.decode(value, { stream: true }));
					}
					takeLines(decoder.decode());
				} catch {
					// The daemon aborted the up leg (renewal or teardown).
					return new Response("up leg ended", { status: 499 });
				}
				try {
					downLegs.get(connectionId)?.close();
				} catch {
					// The session already cancelled its down leg.
				}
				downLegs.delete(connectionId);
				return new Response("ok");
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

describe("FleetCallback up-leg lifetime budget", () => {
	test("renews the pair before the fleet's per-request body cap, losing nothing", async () => {
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = new FleetCallback({
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			upRenewalBytes: RENEWAL_BYTES,
		});
		callbacks.push(callback);

		await callback.start();
		// Each send waits for the fleet to read the previous envelope, so the
		// up leg is drained between sends and renewal happens at a drained moment.
		for (let i = 0; i < ENVELOPES; i++) {
			const result = callback.send({
				streamId: STREAM,
				kind: "frame",
				payload: { i, pad: "x".repeat(PAD_BYTES) },
			});
			expect(result).not.toBe("dropped");
			expect(result).not.toBe("rejected");
			await fleet.whenReceived(i + 1);
		}

		const indices = fleet.received
			.filter((env) => env.streamId === STREAM)
			.map((env) => {
				const payload = env.payload;
				return typeof payload === "object" && payload !== null && "i" in payload ? payload.i : -1;
			});
		expect(indices).toEqual(Array.from({ length: ENVELOPES }, (_, i) => i));

		const status = callback.status();
		expect(fleet.capHits).toBe(0);
		expect(fleet.upRequests).toBeGreaterThan(1);
		expect(status.renewals).toBeGreaterThanOrEqual(1);
		expect(status.reconnects).toBe(0);
		expect(status.drops).toBe(0);
	});

	test("renews through a sustained burst that never drains, in order, with no reconnect", async () => {
		// Regression: renewal used to wait for a drained moment (empty backlog,
		// desiredSize > 0). A settings-write burst keeps the backlog non-empty,
		// so the pair never renewed and the fleet cut the up body at its cap.
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = new FleetCallback({
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			upRenewalBytes: RENEWAL_BYTES,
		});
		callbacks.push(callback);

		await callback.start();
		const burst = 200;
		for (let i = 0; i < burst; i++) {
			const result = callback.send({
				streamId: STREAM,
				kind: "frame",
				payload: { i, pad: "x".repeat(PAD_BYTES) },
			});
			expect(result).toBe("sent");
		}
		await fleet.whenReceived(burst);

		const indices = fleet.received
			.filter((env) => env.streamId === STREAM)
			.map((env) => {
				const payload = env.payload;
				return typeof payload === "object" && payload !== null && "i" in payload ? payload.i : -1;
			});
		expect(indices).toEqual(Array.from({ length: burst }, (_, i) => i));

		const status = callback.status();
		expect(fleet.capHits).toBe(0);
		expect(fleet.upRequests).toBeGreaterThan(1);
		expect(status.renewals).toBeGreaterThanOrEqual(1);
		expect(status.reconnects).toBe(0);
		expect(status.drops).toBe(0);
	});

	test("writes nothing to a renewed pair before its pair_ready, losing nothing", async () => {
		// Regression: the pump wrote backlog into a renewed pair before the fleet
		// confirmed it. Crossing the renewal threshold on that unready pair tore it
		// down mid-establishment and dropped the envelopes already written to it,
		// which surfaced under CPU load as a missing envelope and a 15 s timeout.
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = new FleetCallback({
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			upRenewalBytes: RENEWAL_BYTES,
		});
		callbacks.push(callback);

		await callback.start();
		// The next down leg, the renewed pair, dials with its pair_ready withheld.
		fleet.holdNextReady();
		const burst = 200;
		for (let i = 0; i < burst; i++) {
			const result = callback.send({
				streamId: STREAM,
				kind: "frame",
				payload: { i, pad: "x".repeat(PAD_BYTES) },
			});
			expect(result).not.toBe("dropped");
			expect(result).not.toBe("rejected");
		}
		const heldConnectionId = await fleet.whenHeld();
		// No event marks "the session wrote nothing", so the grace period is a bounded
		// negative check: in-flight writes to the unready pair get time to arrive. The
		// assertion holds at any point for a correct session; the grace only lets a
		// regression surface.
		await Bun.sleep(100);
		expect(fleet.envelopesOn(heldConnectionId)).toBe(0);

		fleet.releaseReady();
		await fleet.whenReceived(burst);
		const indices = fleet.received
			.filter((env) => env.streamId === STREAM)
			.map((env) => {
				const payload = env.payload;
				return typeof payload === "object" && payload !== null && "i" in payload ? payload.i : -1;
			});
		expect(indices).toEqual(Array.from({ length: burst }, (_, i) => i));

		const status = callback.status();
		expect(fleet.capHits).toBe(0);
		expect(status.renewals).toBeGreaterThanOrEqual(1);
		expect(status.reconnects).toBe(0);
		expect(status.drops).toBe(0);
	});
});

describe("FleetCallback redial backoff", () => {
	test("a pair that dies before a heartbeat interval keeps growing the redial backoff", async () => {
		// Regression: the attempt counter reset at every ready, so a fleet that accepts
		// a pair and ends it redialed at ~1 Hz. The fake fleet sends pair_ready and then
		// nothing; silenceMs ends each pair long before heartbeatMs, so the third
		// redial must back off from attempt 2 (≥ 2 s), not attempt 0 (≤ 1.5 s).
		const fleet = startFakeFleet();
		fleets.push(fleet);
		const callback = new FleetCallback({
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			heartbeatMs: 60_000,
			silenceMs: 150,
			backoffMinMs: 1_000,
			backoffMaxMs: 30_000,
		});
		callbacks.push(callback);

		await callback.start();
		const deadline = Date.now() + 15_000;
		while (callback.status().reconnects < 3) {
			if (Date.now() > deadline) throw new Error("no third redial within 15 s");
			await Bun.sleep(10);
		}

		const status = callback.status();
		expect(status.reconnectAt).not.toBeNull();
		expect(status.reconnectAt! - Date.now()).toBeGreaterThan(1_500);
	}, 20_000);
});
