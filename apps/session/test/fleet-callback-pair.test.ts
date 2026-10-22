/**
 * The session's callback pair (OMP_CALLBACK_PROTO 2): one WebSocket dialed to
 * GET /callback/ws, against the fake fleet in fake-fleet.testkit.ts. Covers the
 * dial headers, pair_ready gating and its timeout, the refusal policy (terminal
 * versus retryable closes), redial backoff, inbound handling (bad messages,
 * chunked commands) and outbound flow control under a full socket buffer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	CALLBACK_CONTROL_STREAM_ID,
	CALLBACK_ERROR_CODES,
	CALLBACK_TRANSPORT_STREAM_ID,
	CallbackError,
	OMP_CALLBACK_PROTO,
	PAIR_CREDIT_WINDOW_BYTES,
	planOversizeSplit,
	type CallbackEnvelope,
	type CallbackErrorCode,
} from "#lib/wire/callback-protocol";
import {
	FleetCallback,
	type FleetCallbackEvents,
	type FleetCallbackOptions,
} from "../fleet-callback";
import { startFakeFleet, type FakeFleet, type FakeFleetOptions } from "./fake-fleet.testkit";
import { startStalledFleet, type StalledFleet } from "./stalled-fleet.testkit";

const WORKSPACE = "ws-pair";
const GENERATION = 3;
const TOKEN = "c".repeat(64);
const STREAM = "browser/pair";

const fleets: FakeFleet[] = [];
const stalledFleets: StalledFleet[] = [];
const callbacks: FleetCallback[] = [];
afterAll(() => {
	for (const callback of callbacks) callback.stop();
	for (const fleet of fleets) fleet.stop();
	for (const fleet of stalledFleets) fleet.stop();
});

function makeFleet(extra: Partial<FakeFleetOptions> = {}): FakeFleet {
	const fleet = startFakeFleet({
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		...extra,
	});
	fleets.push(fleet);
	return fleet;
}

/** Listeners fired on every event a FleetCallback emits, by instance (see `until`). */
const changeListeners = new WeakMap<FleetCallback, Set<() => void>>();

function makeCallback(
	fleet: Pick<FakeFleet, "url">,
	options: Partial<FleetCallbackOptions> = {},
	events: FleetCallbackEvents = {},
): FleetCallback {
	const listeners = new Set<() => void>();
	const changed = (): void => {
		for (const listener of listeners) listener();
	};
	const callback = new FleetCallback(
		{
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			...options,
		},
		{
			onStatus: (status) => {
				events.onStatus?.(status);
				changed();
			},
			onError: (error, context) => {
				events.onError?.(error, context);
				changed();
			},
			onEnvelope: (envelope) => {
				events.onEnvelope?.(envelope);
				changed();
			},
			onControl: (envelope) => {
				events.onControl?.(envelope);
				changed();
			},
			onRejected: (error) => {
				events.onRejected?.(error);
				changed();
			},
		},
	);
	changeListeners.set(callback, listeners);
	callbacks.push(callback);
	return callback;
}

/** Resolves once `ready` holds, re-checked on every event the callback emits (status, error, envelope, refusal). */
function until(callback: FleetCallback, ready: () => boolean): Promise<void> {
	const listeners = changeListeners.get(callback)!;
	return new Promise<void>((resolve) => {
		const check = (): void => {
			if (!ready()) return;
			listeners.delete(check);
			resolve();
		};
		listeners.add(check);
		check();
	});
}

function indexOf(envelope: CallbackEnvelope): number {
	const payload = envelope.payload;
	return typeof payload === "object" && payload !== null && "i" in payload ? Number(payload.i) : -1;
}

describe("FleetCallback dial", () => {
	test("dials GET /callback/ws with identity, credential and protocol in headers only", async () => {
		const fleet = makeFleet();
		const callback = makeCallback(fleet);
		await callback.start();

		const upgrade = fleet.upgrades[0]!;
		const url = new URL(upgrade.url);
		expect(url.pathname).toBe("/callback/ws");
		expect(url.search).toBe("");
		expect(upgrade.url).not.toContain(TOKEN);
		expect(upgrade.headers.get("x-omp-workspace-id")).toBe(WORKSPACE);
		expect(upgrade.headers.get("x-omp-generation")).toBe(String(GENERATION));
		expect(upgrade.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(upgrade.headers.get("x-omp-callback-proto")).toBe(String(OMP_CALLBACK_PROTO));
		expect(upgrade.headers.get("x-omp-connection-id")).toBe(callback.status().connectionId!);
		expect(upgrade.headers.get("sec-websocket-extensions")).toBeNull();
		expect(callback.status().state).toBe("ready");
	});

	test("every redial mints a fresh connectionId and a failure-driven pair replacement", async () => {
		const fleet = makeFleet();
		const callback = makeCallback(fleet, { backoffMinMs: 10, backoffMaxMs: 10 });
		await callback.start();
		const first = callback.status().connectionId!;

		fleet.close(1001, "going away");
		await until(callback, () => callback.status().readyCount === 2);
		const second = callback.status().connectionId!;

		expect(second).not.toBe(first);
		expect(fleet.upgrades.map((u) => u.headers.get("x-omp-connection-id"))).toEqual([
			first,
			second,
		]);
		expect(callback.status().reconnects).toBe(1);
		// An ordinary close is no refusal: the instance keeps redialing.
		expect(callback.status().state).toBe("ready");
	});
});

describe("FleetCallback pair_ready", () => {
	test("holds the backlog until pair_ready, then sends it once, in order", async () => {
		const fleet = makeFleet({ holdReady: true });
		const callback = makeCallback(fleet);
		const started = callback.start();
		await fleet.whenUpgrades(1);

		const COUNT = 20;
		for (let i = 0; i < COUNT; i++) {
			expect(callback.send({ streamId: STREAM, kind: "frame", payload: { i } })).toBe("sent");
		}
		// No event marks "the session wrote nothing", so a bounded real-time wait is the only
		// way to observe it on a real socket; the assertion holds at any point for a correct
		// session and the grace only lets a regression surface.
		await Bun.sleep(100);
		expect(fleet.received).toEqual([]);
		expect(callback.status().state).toBe("connecting");

		fleet.releaseReady();
		await started;
		await fleet.whenReceived(COUNT);
		expect(fleet.received.map(indexOf)).toEqual(Array.from({ length: COUNT }, (_, i) => i));
		expect(callback.status().reconnects).toBe(0);
	});

	test("a command written right behind pair_ready reaches a session that already reads as ready", async () => {
		// Regression: readiness used to wait for the supervisor's promise continuations, so a
		// command sharing pair_ready's socket read was delivered while the pair still read as
		// "connecting" and its answers were dropped (pairLive false).
		const fleet = makeFleet({
			afterReady: [{ streamId: STREAM, kind: "command", payload: { id: "first" } }],
		});
		const states: string[] = [];
		const callback = makeCallback(
			fleet,
			{},
			{ onEnvelope: () => states.push(callback.status().state) },
		);
		await callback.start();
		await until(callback, () => states.length === 1);
		expect(states).toEqual(["ready"]);
		expect(callback.status().connectionId).not.toBeNull();
	});

	test("a pair_ready that never arrives times out retryable and redials; start() stays pending", async () => {
		const fleet = makeFleet({ holdReady: true });
		const errors: CallbackError[] = [];
		const callback = makeCallback(
			fleet,
			{ readyTimeoutMs: 100, backoffMinMs: 10, backoffMaxMs: 10 },
			{ onError: (error) => errors.push(error) },
		);
		let started = false;
		const startResult = callback.start().then(
			() => {
				started = true;
			},
			(cause: unknown) => cause,
		);
		await fleet.whenUpgrades(2);

		expect(started).toBe(false);
		expect(callback.status().readyCount).toBe(0);
		expect(
			errors.some((e) => e.code === "retryable" && e.message === "callback pair not ready"),
		).toBe(true);
		callback.stop();
		expect(await startResult).toBeInstanceOf(Error);
	});
});

describe("FleetCallback refusal policy", () => {
	const TERMINAL: CallbackErrorCode[] = [
		"unauthorized",
		"invalid_identity",
		"generation_obsolete",
		"proto_unsupported",
	];
	const RETRYABLE = CALLBACK_ERROR_CODES.filter((code) => !TERMINAL.includes(code));

	for (const code of TERMINAL) {
		test(`a ${code} refusal close stops the client for good`, async () => {
			const fleet = makeFleet({ refuse: { code, message: `fleet says ${code}` } });
			const rejections: CallbackError[] = [];
			const callback = makeCallback(
				fleet,
				{ backoffMinMs: 10, backoffMaxMs: 10 },
				{ onRejected: (error) => rejections.push(error) },
			);
			const startError = await callback.start().then(
				() => null,
				(cause: unknown) => cause,
			);

			expect(startError).toBeInstanceOf(Error);
			expect(rejections.map((e) => e.code)).toEqual([code]);
			expect(rejections[0]!.message).toContain(`fleet says ${code}`);
			expect(callback.status().state).toBe("stopped");
			// The backoff is 10 ms: a redial would show within this bounded grace.
			// Real-time bounded negative check: a redial (10 ms backoff) would show within this grace.
			await Bun.sleep(150);
			expect(fleet.upgrades.length).toBe(1);
		});
	}

	for (const code of RETRYABLE) {
		test(`a ${code} refusal close redials with backoff and never stops the client`, async () => {
			const fleet = makeFleet({ refuse: { code } });
			const rejections: CallbackError[] = [];
			const callback = makeCallback(
				fleet,
				{ backoffMinMs: 10, backoffMaxMs: 10 },
				{ onRejected: (error) => rejections.push(error) },
			);
			void callback.start().catch(() => {});
			await fleet.whenUpgrades(3);

			expect(rejections).toEqual([]);
			expect(callback.status().state).not.toBe("stopped");
			expect(callback.status().lastError?.code).toBe(code);
			callback.stop();
		});
	}

	test("a credential the fleet rejects on the upgrade is a terminal unauthorized close", async () => {
		const fleet = makeFleet();
		const rejections: CallbackError[] = [];
		const callback = makeCallback(
			fleet,
			{ token: "d".repeat(64) },
			{ onRejected: (error) => rejections.push(error) },
		);
		await callback.start().catch(() => {});
		expect(rejections.map((e) => e.code)).toEqual(["unauthorized"]);
	});

	test("a refusal on an established pair is just as terminal", async () => {
		const fleet = makeFleet();
		const rejections: CallbackError[] = [];
		const callback = makeCallback(
			fleet,
			{ backoffMinMs: 10, backoffMaxMs: 10 },
			{ onRejected: (error) => rejections.push(error) },
		);
		await callback.start();
		fleet.close(4409, "generation_obsolete: superseded");
		await until(callback, () => rejections.length === 1);
		expect(rejections[0]!.code).toBe("generation_obsolete");
		expect(callback.status().state).toBe("stopped");
	});
});

describe("FleetCallback liveness", () => {
	test("a pair that dies before a heartbeat interval keeps growing the redial backoff", async () => {
		// Regression: the attempt counter reset at every ready, so a fleet that accepts
		// a pair and ends it redialed at ~1 Hz. The fake fleet sends pair_ready and then
		// nothing; silenceMs ends each pair long before heartbeatMs, so the third
		// redial must back off from attempt 2 (>= 2 s), not attempt 0 (<= 1.5 s).
		const fleet = makeFleet();
		const callback = makeCallback(fleet, {
			heartbeatMs: 60_000,
			silenceMs: 150,
			backoffMinMs: 1_000,
			backoffMaxMs: 30_000,
		});
		await callback.start();
		await until(callback, () => callback.status().reconnects >= 3);

		const status = callback.status();
		expect(status.reconnectAt).not.toBeNull();
		expect(status.reconnectAt! - Date.now()).toBeGreaterThan(1_500);
		expect(status.lastError?.message).toBe("callback socket silent");
	}, 20_000);

	test("fleet heartbeats keep the pair past the silence deadline; the daemon mirrors its own while idle", async () => {
		const fleet = makeFleet({ heartbeatMs: 40 });
		const callback = makeCallback(fleet, { heartbeatMs: 40, silenceMs: 200 });
		await callback.start();
		// Bounded hold: three silence windows with heartbeats flowing both ways.
		// Real-time hold by design: the silence deadline is measured on the platform clock.
		await Bun.sleep(600);

		expect(callback.status().reconnects).toBe(0);
		expect(callback.status().readyCount).toBe(1);
		const heartbeats = fleet.raw
			.map((text) => JSON.parse(text) as CallbackEnvelope)
			.filter((e) => e.kind === "heartbeat");
		expect(heartbeats.length).toBeGreaterThan(3);
		for (const heartbeat of heartbeats) expect(heartbeat.streamId).toBe(CALLBACK_CONTROL_STREAM_ID);
		// A heartbeat is liveness only: it never counts as user traffic on either side.
		expect(fleet.received).toEqual([]);
		expect(callback.status().received).toBe(0);
	});
});

describe("FleetCallback inbound", () => {
	test("routes frames, commands and controls; heartbeats and pair_ready are transport only", async () => {
		const fleet = makeFleet({ heartbeatMs: 20 });
		const envelopes: CallbackEnvelope[] = [];
		const controls: CallbackEnvelope[] = [];
		const callback = makeCallback(
			fleet,
			{},
			{ onEnvelope: (e) => envelopes.push(e), onControl: (e) => controls.push(e) },
		);
		await callback.start();
		fleet.send(STREAM, "command", { id: "c1" });
		fleet.send(STREAM, "control", { type: "stream_open" });
		fleet.send(CALLBACK_TRANSPORT_STREAM_ID, "frame", { n: 1 });
		await until(callback, () => callback.status().received === 3);

		expect(envelopes.map((e) => [e.kind, e.streamId])).toEqual([
			["command", STREAM],
			["frame", CALLBACK_TRANSPORT_STREAM_ID],
		]);
		expect(controls.map((e) => e.payload)).toEqual([{ type: "stream_open" }]);
		expect(callback.status().readyCount).toBe(1);
	});

	test("a binary or invalid message is dropped, counted and reported; the pair survives and keeps routing", async () => {
		const fleet = makeFleet();
		const errors: CallbackError[] = [];
		const envelopes: CallbackEnvelope[] = [];
		const callback = makeCallback(
			fleet,
			{},
			{ onError: (error) => errors.push(error), onEnvelope: (e) => envelopes.push(e) },
		);
		await callback.start();
		const connectionId = fleet.connectionId()!;

		fleet.sendRaw("not json");
		fleet.sendRaw(new Uint8Array([1, 2, 3]));
		fleet.sendRaw(JSON.stringify({ version: 1, kind: "frame" }));
		fleet.sendRaw(
			JSON.stringify({
				version: OMP_CALLBACK_PROTO,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				connectionId,
				streamId: STREAM,
				seq: 99,
				kind: "bogus",
				payload: {},
				at: Date.now(),
			}),
		);
		fleet.send(STREAM, "command", { id: "after" });
		await until(callback, () => envelopes.length === 1);

		expect(callback.status().badMessages).toBe(4);
		expect(errors.length).toBe(4);
		for (const error of errors) expect(error.code).toBe("invalid_request");
		expect(callback.status().reconnects).toBe(0);
		expect(callback.status().state).toBe("ready");
	});

	test("an envelope carrying another pair's connectionId replaces the pair", async () => {
		const fleet = makeFleet();
		const callback = makeCallback(fleet, { backoffMinMs: 10, backoffMaxMs: 10 });
		await callback.start();
		fleet.sendRaw(
			JSON.stringify({
				version: OMP_CALLBACK_PROTO,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				connectionId: "11111111-1111-4111-8111-111111111111",
				streamId: STREAM,
				seq: 5,
				kind: "frame",
				payload: {},
				at: Date.now(),
			}),
		);
		await until(callback, () => callback.status().readyCount === 2);
		expect(callback.status().reconnects).toBe(1);
	});

	test("a chunked command is reassembled and delivered as one command", async () => {
		const fleet = makeFleet();
		const envelopes: CallbackEnvelope[] = [];
		const callback = makeCallback(fleet, {}, { onEnvelope: (e) => envelopes.push(e) });
		await callback.start();

		const payload = { id: "big", type: "prompt", text: "é".repeat(700 * 1024) };
		const split = planOversizeSplit({
			version: OMP_CALLBACK_PROTO,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			connectionId: fleet.connectionId()!,
			streamId: STREAM,
			seq: 2,
			kind: "command",
			payload,
			at: Date.now(),
		});
		expect(split.total).toBeGreaterThan(1);
		for (const chunk of split.envelopes) fleet.sendRaw(JSON.stringify(chunk));
		await until(callback, () => envelopes.length === 1);

		expect(envelopes[0]!.kind).toBe("command");
		expect(envelopes[0]!.streamId).toBe(STREAM);
		expect(envelopes[0]!.payload).toEqual(payload);
		expect(callback.status().badMessages).toBe(0);
	});
});

describe("FleetCallback outbound flow control", () => {
	test("a socket buffer above high water loses and reorders nothing: the backlog waits in the bounded queue", async () => {
		const fleet = makeFleet();
		const callback = makeCallback(fleet, {
			connectionBufferBytes: 16 * 1024 * 1024,
			streamBufferBytes: 16 * 1024 * 1024,
		});
		await callback.start();

		const COUNT = 8;
		const PAD = "x".repeat(900 * 1024);
		for (let i = 0; i < COUNT; i++) {
			expect(callback.send({ streamId: STREAM, kind: "frame", payload: { i, pad: PAD } })).toBe(
				"sent",
			);
		}
		// The client socket reports a buffered amount above the 1 MiB high-water mark
		// within this same tick, so the pump handed it only what fit and held the rest.
		const held = callback.status();
		expect(held.pendingEnvelopes).toBeGreaterThan(0);
		expect(held.sent + held.pendingEnvelopes).toBe(COUNT);

		await fleet.whenReceived(COUNT);
		expect(fleet.received.map(indexOf)).toEqual(Array.from({ length: COUNT }, (_, i) => i));
		const seqs = fleet.received.map((e) => e.seq);
		expect(seqs).toEqual(Array.from({ length: COUNT }, (_, i) => seqs[0]! + i));
		expect(new Set(fleet.received.map((e) => e.connectionId)).size).toBe(1);
		const status = callback.status();
		expect(status.pendingEnvelopes).toBe(0);
		expect(status.pendingBytes).toBe(0);
		expect(status.drops).toBe(0);
		expect(status.reconnects).toBe(0);
	});

	test("the bounded queue still drops loudly when the backlog fills it", async () => {
		const fleet = makeFleet({ holdReady: true });
		const errors: CallbackError[] = [];
		const callback = makeCallback(
			fleet,
			{ streamBufferBytes: 64 * 1024 },
			{ onError: (error) => errors.push(error) },
		);
		void callback.start().catch(() => {});
		await fleet.whenUpgrades(1);

		const PAD = "x".repeat(20 * 1024);
		const results = [0, 1, 2, 3, 4].map((i) =>
			callback.send({ streamId: STREAM, kind: "frame", payload: { i, pad: PAD } }),
		);
		expect(results).toEqual(["sent", "sent", "sent", "dropped", "dropped"]);
		expect(callback.status().drops).toBe(2);
		expect(errors.map((e) => e.message)).toEqual([
			"callback send dropped: outbound buffer full",
			"callback send dropped: outbound buffer full",
		]);
		callback.stop();
	});

	test("a peer that stops reading is replaced after the silence window, the unsent backlog kept for the next pair", async () => {
		// The peer keeps heartbeating, so only the outbound stall rule can end this pair:
		// the kernel buffers fill, the socket buffer stays above high water, and no envelope
		// leaves the session queue for a full silence window.
		const stalled = await startStalledFleet({
			workspaceId: WORKSPACE,
			generation: GENERATION,
			heartbeatMs: 20,
		});
		stalledFleets.push(stalled);
		const callback = makeCallback(stalled, {
			heartbeatMs: 60_000,
			silenceMs: 300,
			backoffMinMs: 10,
			backoffMaxMs: 10,
			connectionBufferBytes: 512 * 1024 * 1024,
			streamBufferBytes: 512 * 1024 * 1024,
		});
		await callback.start();

		const PAD = "x".repeat(900 * 1024);
		for (let i = 0; i < 50; i++) {
			expect(callback.send({ streamId: STREAM, kind: "frame", payload: { i, pad: PAD } })).toBe(
				"sent",
			);
		}
		await until(callback, () => callback.status().reconnects >= 1);

		const status = callback.status();
		expect(status.lastError?.message).toBe("callback send stalled");
		expect(status.lastError?.code).toBe("retryable");
		// Nothing that never reached the socket was discarded: it replays on the fresh pair.
		expect(status.pendingEnvelopes).toBeGreaterThan(0);
		expect(status.drops).toBe(0);
		await until(callback, () => stalled.upgrades >= 2);
		callback.stop();
	});
});

describe("FleetCallback pair credit", () => {
	const FRAME_PAD = "x".repeat(900 * 1024);
	/** Wire bytes of one frame: the pad plus a few hundred bytes of envelope framing. */
	const FRAME_BYTES = FRAME_PAD.length + 400;

	function sendFrames(callback: FleetCallback, count: number): void {
		for (let i = 0; i < count; i++) {
			expect(
				callback.send({ streamId: STREAM, kind: "frame", payload: { i, pad: FRAME_PAD } }),
			).toBe("sent");
		}
	}

	test("stops at the window while no credit arrives and resumes, in order, as grants do", async () => {
		const fleet = makeFleet({ withholdCredit: true });
		const controls: CallbackEnvelope[] = [];
		const callback = makeCallback(
			fleet,
			{ connectionBufferBytes: 64 * 1024 * 1024, streamBufferBytes: 64 * 1024 * 1024 },
			{ onControl: (envelope) => controls.push(envelope) },
		);
		await callback.start();
		const COUNT = 24;
		sendFrames(callback, COUNT);

		let granted = 0;
		for (let round = 0; round < 2; round++) {
			// The session sends until one more frame would not fit the window beyond the last grant;
			// it must wait there (the outstanding invariant below covers anything it sent past that).
			await fleet.whenConsumed(granted + PAIR_CREDIT_WINDOW_BYTES - FRAME_BYTES + 1);
			granted = fleet.consumedBytes();
			fleet.grant();
			// A stale grant (below what is already granted) changes nothing.
			fleet.grant(granted - 1000);
		}
		await fleet.whenReceived(COUNT);
		expect(granted).toBeGreaterThan(PAIR_CREDIT_WINDOW_BYTES);
		// Never more than the window beyond the credit the fleet had granted when each message arrived, and the window was filled.
		expect(fleet.maxOutstandingBytes()).toBeLessThanOrEqual(PAIR_CREDIT_WINDOW_BYTES);
		expect(fleet.maxOutstandingBytes()).toBeGreaterThan(PAIR_CREDIT_WINDOW_BYTES - FRAME_BYTES);
		expect(fleet.received.map(indexOf)).toEqual(Array.from({ length: COUNT }, (_, i) => i));
		expect(callback.status()).toMatchObject({ drops: 0, reconnects: 0, pendingEnvelopes: 0 });
		// Grants are transport control: never surfaced to the session's own handlers.
		expect(controls).toEqual([]);
	}, 30_000);

	test("a fresh pair starts a fresh window: the backlog replays from zero credit", async () => {
		const fleet = makeFleet({ withholdCredit: true });
		const callback = makeCallback(fleet, {
			backoffMinMs: 10,
			backoffMaxMs: 10,
			connectionBufferBytes: 64 * 1024 * 1024,
			streamBufferBytes: 64 * 1024 * 1024,
		});
		await callback.start();
		const COUNT = 24;
		sendFrames(callback, COUNT);
		await fleet.whenConsumed(PAIR_CREDIT_WINDOW_BYTES - FRAME_BYTES + 1);
		const firstPair = fleet.received.length;
		fleet.close(1011, "test");
		await fleet.whenClosed(1);
		// The second pair fills its own window again with no credit: twice the window left the session in total.
		await fleet.whenConsumed(PAIR_CREDIT_WINDOW_BYTES - FRAME_BYTES + 1);
		expect(fleet.maxOutstandingBytes()).toBeLessThanOrEqual(PAIR_CREDIT_WINDOW_BYTES);
		expect(fleet.consumedBytes()).toBeLessThanOrEqual(PAIR_CREDIT_WINDOW_BYTES);
		expect(fleet.received.length).toBeGreaterThan(firstPair);
		expect(fleet.received.map(indexOf)).toEqual(
			Array.from({ length: fleet.received.length }, (_, i) => i),
		);
		expect(callback.status().drops).toBe(0);
	}, 30_000);
});
