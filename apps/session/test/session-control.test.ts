/**
 * Session control broker replay regression: per-browser virtual
 * stream_open ring-hit replay vs ring-miss re-prime. The observed defect:
 * openStream's ring-miss guard was logically unreachable (`live > 0 &&
 * replay.length === 0 && newest > lastSeq` cannot fire; the newest live
 * entry itself satisfies `seq > lastSeq`, so ringAfter never returns empty
 * while a newer entry exists). Consequences:
 *
 *   - A reconnect floor at or below the EVICTED ring head silently
 *     partial-replayed the retained tail; entries between the floor and
 *     the head were lost with no stream_resync (never a partial replay
 *     violated).
 *   - A caught-up ring hit (existing stream, floor >= newest) fell through
 *     to a re-prime where the client already had
 *     everything ("ring hit replays; only a miss re-primes").
 *
 * Fix: track the ring eviction frontier (`evictedSeq`, the highest wire seq
 * dropped from the head). A floor BELOW the frontier is a MISS →
 * stream_resync + ring clear + full re-prime (never a partial tail). A
 * floor at or above the frontier replays retained entries newer than it
 * (HIT). A caught-up HIT replays nothing and does NOT re-prime. Only a
 * brand-new stream primes fresh. A stream_open without lastSeq (the fleet's
 * re-open on a new pair, which has no replay floor) clears the ring, resyncs
 * the browser, and re-primes it fresh. A stream the fleet does not re-open on
 * a new pair is an orphan and is dropped.
 *
 * Pure unit: createSessionControl with a stub deps whose send() assigns
 * synthetic wire seqs (like the real transport) and records every emit.
 */
import { describe, expect, test, vi } from "bun:test";
import {
	createSessionControl,
	type SessionControl,
	type SessionControlDeps,
} from "../session-control";
import {
	PreEncodedPayload,
	type CallbackEnvelope,
	type CallbackKind,
} from "#lib/wire/callback-protocol";

const STREAM = "browser/test-conn";

interface Sent {
	streamId: string;
	kind: CallbackKind;
	payload: unknown;
	seq: number | null; // null when the transport reported no seq (non-ringed)
}

/** Narrow a sent payload to an object with a string `type` (control/frame
 * vocabulary; the only shape session-control emits). */
function typeOf(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	if (!("type" in payload)) return undefined;
	return typeof payload.type === "string" ? payload.type : undefined;
}

/** Stub deps: send() returns "sent", assigns a fresh wire seq per ringed
 * browser-stream frame (invoking onEmittedSeq like the real transport), and
 * records every send. Each prime records one entry in `primes`; its snapshot
 * is `snapshot()` (no frames by default). */
function makeHarness(
	snapshot: () => Record<string, unknown>[] = () => [],
	pairLive: () => boolean = () => true,
	onBrowserStreamsChange: (count: number) => void = () => {},
	bufferedBytes: () => { stream: number; connection: number } = () => ({
		stream: 0,
		connection: 0,
	}),
	recordSent = true,
	streamConfirmMs?: number,
	onDrain: (listener: () => void) => () => void = () => () => {},
): {
	control: SessionControl;
	sent: Sent[];
	primes: string[];
	/** Resolves once `count` envelopes have been sent in total. */
	sentCount: (count: number) => Promise<void>;
} {
	const sent: Sent[] = [];
	const primes: string[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	let wireSeq = 1024;
	const send: SessionControlDeps["send"] = (streamId, kind, payload, onEmittedSeq): string => {
		let seq: number | null = null;
		if (onEmittedSeq !== undefined && streamId.startsWith("browser/") && kind === "frame") {
			seq = ++wireSeq;
			onEmittedSeq(seq);
		}
		if (recordSent) {
			// The broker hands the transport the payload pre-serialized; record what the wire carries.
			const wire = payload instanceof PreEncodedPayload ? JSON.parse(payload.json) : payload;
			sent.push({ streamId, kind, payload: wire, seq });
		}
		for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve();
		return "sent";
	};
	const sentCount = (count: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (sent.length >= count) resolve();
		else waiters.push({ count, resolve });
		return promise;
	};
	const deps: SessionControlDeps = {
		handleCommand: async () => undefined,
		preparePriming: async () => {
			primes.push("prime");
			return snapshot;
		},
		bufferedBytes,
		onDrain,
		send,
		pairLive,
		onShutdown: () => {},
		onBrowserStreamsChange,
		streamConfirmMs,
	};
	const control = createSessionControl(deps);
	return { control, sent, primes, sentCount };
}

/** Open the stream (stream_open control) with an optional lastSeq. */
function openStream(control: SessionControl, lastSeq?: number): void {
	control.handleEnvelope({
		version: 2,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: STREAM,
		seq: 0,
		kind: "control",
		payload: {
			type: "stream_open",
			...(lastSeq !== undefined ? { lastSeq } : {}),
		},
		at: Date.now(),
	} satisfies CallbackEnvelope);
}

/** The fleet's stream_ack: every frame up to wire seq `seq` has drained. */
function ackStream(control: SessionControl, seq: number): void {
	control.handleEnvelope({
		version: 2,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: STREAM,
		seq: 0,
		kind: "control",
		payload: { type: "stream_ack", seq },
		at: Date.now(),
	} satisfies CallbackEnvelope);
}

/** Ringed-delta frame on a browser stream via mirror (state is ringed). */
function emitState(control: SessionControl): void {
	control.mirror({ type: "state", state: { streaming: true } });
}

/** Non-ringed frame on a browser stream via publish (priming burst). */
function emitPrimeFrame(control: SessionControl): void {
	control.publish(STREAM, { type: "history", messages: [] });
}

const ringedSeqs = (sent: Sent[], streamId = STREAM): number[] =>
	sent.filter((s) => s.streamId === streamId && s.seq !== null).map((s) => s.seq as number);

const resyncSent = (sent: Sent[], from: number): boolean =>
	sent
		.slice(from)
		.some(
			(s) =>
				s.streamId === STREAM &&
				s.kind === "control" &&
				typeof s.payload === "object" &&
				s.payload !== null &&
				"type" in s.payload &&
				s.payload.type === "stream_resync",
		);

describe("session-control stream_open replay", () => {
	test("a fresh stream primes; subsequent ringed deltas ring with wire seqs", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // brand-new: prime
		expect(primes).toHaveLength(1);
		emitState(control);
		emitState(control);
		const ringed = ringedSeqs(sent);
		expect(ringed.length).toBe(2);
		expect(ringed[1]!).toBeGreaterThan(ringed[0]!);
		// Non-ringed frames consume no ring entry (seq stays null).
		const before = sent.length;
		emitPrimeFrame(control);
		expect(sent.length).toBe(before + 1);
		expect(sent[sent.length - 1]!.seq).toBeNull();
		control.stop();
	});

	test("ring HIT: a reconnect floor inside the ring replays newer deltas and does NOT re-prime", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1 call)
		emitState(control); // wire 1025
		emitState(control); // wire 1026
		const beforeReopen = sent.length;
		// Reconnect with the floor at the FIRST delta: the second must replay.
		openStream(control, 1025);
		expect(primes.length).toBe(1); // NO new prime (ring hit)
		const replayed = sent.slice(beforeReopen);
		expect(replayed.length).toBe(1); // the replayed delta
		const replayFrames = replayed.filter((s) => s.kind === "frame");
		expect(replayFrames.length).toBe(1);
		expect(replayFrames[0]!.payload).toEqual({ type: "state", state: { streaming: true } });
		control.stop();
	});

	test("caught-up ring HIT: a floor at the newest replays nothing and does NOT re-prime", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1 call)
		emitState(control); // wire 1025
		const sentBeforeReopen = sent.length;
		// Reconnect fully caught up (floor == the only delta's seq).
		openStream(control, 1025);
		expect(primes.length).toBe(1); // no re-prime (pre-fix this re-primed)
		// Nothing was added: no replayed delta, no prime.
		const added = sent.slice(sentBeforeReopen);
		expect(added.length).toBe(0);
		expect(added.filter((s) => s.kind === "frame")).toHaveLength(0);
		control.stop();
	});

	test("ring MISS: a floor below the eviction frontier resyncs and full re-primes (never a partial tail)", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1)
		// Evict from the head via the byte budget: a state delta whose
		// serialized payload exceeds 4 MiB is one oversized entry; a second
		// pushes the first out (the eviction loop never drops the newest).
		const big = { type: "state", state: { blob: "x".repeat(3 * 1024 * 1024) } };
		control.publish(STREAM, big); // wire 1025, ~3 MiB
		control.publish(STREAM, big); // wire 1026: pushes 1025 out (frontier=1025)
		expect(control.status().streams[0]!.ringEntries).toBe(1); // head evicted
		// Reconnect with a floor BELOW the evicted entry (1024 < frontier
		// 1025): the client still needs the evicted delta, a MISS.
		const before = primes.length;
		openStream(control, 1024);
		expect(primes.length).toBe(before + 1); // full re-prime
		const resyncIdx = sent.findIndex(
			(s) => s.kind === "control" && typeOf(s.payload) === "stream_resync",
		);
		expect(resyncIdx).toBeGreaterThanOrEqual(0);
		// The re-prime is the recovery: no ringed-delta tail replay rides
		// after the resync (a partial tail would be a silent gap).
		const afterMiss = sent.slice(resyncIdx + 1);
		expect(afterMiss.filter((s) => s.kind === "frame" && s.seq !== null)).toHaveLength(0);
		control.stop();
	});

	test("ring HIT after partial eviction: a floor ABOVE the frontier replays the retained tail", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1)
		const big = { type: "state", state: { blob: "x".repeat(3 * 1024 * 1024) } };
		control.publish(STREAM, big); // wire 1025
		control.publish(STREAM, big); // wire 1026: evicts 1025 (frontier=1025)
		control.publish(STREAM, { type: "event", event: { type: "notice" } }); // wire 1027
		const before = primes.length;
		const sentBeforeReopen = sent.length;
		openStream(control, 1026); // floor above the frontier: HIT, replay 1027
		expect(primes.length).toBe(before); // no re-prime
		const added = sent.slice(sentBeforeReopen);
		// Exactly the replayed event frame, no prime.
		expect(added.filter((s) => s.kind === "frame")).toHaveLength(1);
		expect(typeOf(added.find((s) => s.kind === "frame")!.payload)).toBe("event");
		control.stop();
	});

	test("stream_close drops the stream; a later open is fresh and primes", () => {
		const { control, primes } = makeHarness();
		openStream(control); // prime (1)
		control.handleEnvelope({
			version: 2,
			workspaceId: "w1",
			generation: 1,
			connectionId: "conn",
			streamId: STREAM,
			seq: 0,
			kind: "control",
			payload: { type: "stream_close" },
			at: Date.now(),
		} satisfies CallbackEnvelope);
		expect(control.status().streams).toHaveLength(0);
		openStream(control); // fresh again
		expect(primes.length).toBe(2);
		control.stop();
	});

	test("a stream_open without lastSeq on an existing stream resyncs and re-primes (pair replacement)", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1)
		emitState(control); // wire 1025, ringed
		emitState(control); // wire 1026, ringed
		expect(primes.length).toBe(1);
		// Pair replacement: the edge re-sends stream_open with no lastSeq (the
		// new pair has no replay floor for this stream). The dead pair's ring
		// must be cleared, the browser resynced, and the stream re-primed
		// fresh, never replayed into the new pair.
		const sentBefore = sent.length;
		openStream(control);
		expect(primes.length).toBe(2);
		expect(resyncSent(sent, sentBefore)).toBe(true);
		const st = control.status().streams[0]!;
		expect(st.ringEntries).toBe(0);
		expect(st.ringBytes).toBe(0);
		// New-pair live deltas ring afresh.
		const sentBeforeDelta = sent.length;
		emitState(control); // wire 1027 on the new pair
		const newRinged = sent
			.slice(sentBeforeDelta)
			.filter((s) => s.kind === "frame" && s.seq !== null);
		expect(newRinged.length).toBe(1);
		// A reconnect floor at the newest seq is a caught-up HIT (no re-prime).
		const sentBeforeReopen = sent.length;
		openStream(control, 1027);
		expect(primes.length).toBe(2);
		expect(sent.slice(sentBeforeReopen).filter((s) => s.kind === "frame")).toHaveLength(0);
		control.stop();
	});

	test("frames lost while the pair was down are recovered by the re-open that follows", () => {
		let live = true;
		const { control, sent, primes } = makeHarness(undefined, () => live);
		openStream(control); // prime (1)
		live = false;
		emitState(control); // dropped: the pair is down
		live = true;
		const sentBefore = sent.length;
		openStream(control); // fleet re-opens on the new pair, no lastSeq
		expect(primes.length).toBe(2);
		expect(resyncSent(sent, sentBefore)).toBe(true);
		control.stop();
	});
});

describe("session-control browser-stream orphan GC (SXP-03)", () => {
	const open = (control: SessionControl, streamId: string, connectionId: string): void => {
		control.handleEnvelope({
			version: 2,
			workspaceId: "w1",
			generation: 1,
			connectionId,
			streamId,
			seq: 0,
			kind: "control",
			payload: { type: "stream_open" },
			at: Date.now(),
		} satisfies CallbackEnvelope);
	};

	test("a browser stream the fleet does not re-open on a new pair is dropped", () => {
		vi.useFakeTimers();
		try {
			const counts: number[] = [];
			const { control } = makeHarness(
				undefined,
				() => true,
				(n) => counts.push(n),
				undefined,
				true,
				20,
			);
			open(control, "browser/gone", "pairA");
			open(control, "browser/live", "pairA");
			expect(control.browserStreamCount()).toBe(2);
			open(control, "browser/live", "pairB"); // new pair: only the live browser re-opens
			vi.advanceTimersByTime(20);
			expect(control.status().streams.map((s) => s.streamId)).toEqual(["browser/live"]);
			expect(counts.at(-1)).toBe(1);
			control.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test("an orphan the fleet re-opens later is re-created and primed fresh", () => {
		vi.useFakeTimers();
		try {
			const { control, primes } = makeHarness(
				undefined,
				() => true,
				() => {},
				undefined,
				true,
				20,
			);
			open(control, "browser/gone", "pairA");
			open(control, "browser/live", "pairB");
			vi.advanceTimersByTime(20); // browser/gone dropped
			expect(control.status().streams.map((s) => s.streamId)).toEqual(["browser/live"]);
			const primedBefore = primes.length;
			open(control, "browser/gone", "pairB"); // the browser is still alive
			expect(primes.length).toBe(primedBefore + 1);
			expect(control.browserStreamCount()).toBe(2);
			control.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("session-control browser-stream priming", () => {
	test("frames mirrored after the priming snapshot arrive after the prime, in order", async () => {
		let control!: SessionControl;
		const harness = makeHarness(() => {
			// A live frame published the instant the snapshot is taken: its
			// effect is not in the snapshot, so it must follow the history.
			control.mirror({ type: "event", event: { type: "turn_start" } });
			return [
				{ type: "hello_ok" },
				{ type: "attached", scope: "d1" },
				{ type: "history", messages: [] },
				{ type: "state", state: {} },
			];
		});
		control = harness.control;
		openStream(control);
		// the event's control-stream mirror + 4 priming frames + the held event.
		await harness.sentCount(6);
		const browserFrames = harness.sent
			.filter((s) => s.streamId === STREAM && s.kind === "frame")
			.map((s) => typeOf(s.payload));
		expect(browserFrames).toEqual(["hello_ok", "attached", "history", "state", "event"]);
		control.stop();
	});

	test("a history resync reaches every browser stream but not the control stream", async () => {
		const { control, sent } = makeHarness();
		openStream(control);
		const before = sent.length;
		await control.publishHistory([
			{ type: "history", messages: [], final: false },
			{ type: "history", messages: [], final: true },
		]);
		const added = sent.slice(before);
		expect(added.map((s) => [s.streamId, typeOf(s.payload)])).toEqual([
			[STREAM, "history"],
			[STREAM, "history"],
		]);
		control.stop();
	});

	test("browser presence requires a live pair: a dropped pair reports none", () => {
		let live = true;
		const { control } = makeHarness(undefined, () => live);
		openStream(control);
		expect(control.browserStreamCount()).toBe(1);
		// A pair drop keeps the stream in the map (it re-primes on the new
		// pair), but the mirror drops every frame meanwhile: a dialog opened
		// in that window would never reach a browser, so presence must report
		// none and let the caller fail fast.
		live = false;
		expect(control.browserStreamCount()).toBe(0);
		live = true;
		expect(control.browserStreamCount()).toBe(1);
		control.stop();
	});
});

describe("session-control browser-stream count (FLEET-05)", () => {
	test("onBrowserStreamsChange reports each browser stream open/close and 0 on stop", () => {
		const counts: number[] = [];
		const { control } = makeHarness(undefined, undefined, (count) => counts.push(count));
		const envelope = (streamId: string, type: "stream_open" | "stream_close"): void =>
			control.handleEnvelope({
				version: 2,
				workspaceId: "w1",
				generation: 1,
				connectionId: "conn",
				streamId,
				seq: 0,
				kind: "control",
				payload: { type },
				at: Date.now(),
			} satisfies CallbackEnvelope);
		envelope("browser/x", "stream_open");
		expect(counts).toEqual([1]);
		envelope("browser/y", "stream_open");
		expect(counts).toEqual([1, 2]);
		envelope("browser/x", "stream_close");
		expect(counts).toEqual([1, 2, 1]);
		envelope("browser/y", "stream_close");
		expect(counts).toEqual([1, 2, 1, 0]);
		control.stop();
		expect(counts).toEqual([1, 2, 1, 0, 0]);
	});
});

test("a live backlog past the ring budget mid-prime re-primes in place with no stream_resync", async () => {
	// Held-overflow trigger: a prime still waiting for outbound room holds live
	// frames; past RING_MAX_BYTES the prime restarts in place. The restart's
	// snapshot covers the superseded deltas, so the client is never reset and no
	// held frame is replayed.
	let jammed = true;
	let builds = 0;
	const built = Promise.withResolvers<void>();
	const { control, sent, primes, sentCount } = makeHarness(
		() => {
			builds++;
			built.resolve();
			return [{ type: "state", state: {} }];
		},
		() => true,
		() => {},
		() =>
			jammed ? { stream: Number.MAX_SAFE_INTEGER, connection: 0 } : { stream: 0, connection: 0 },
	);
	openStream(control);
	await built.promise;
	const blob = "x".repeat(1024 * 1024);
	for (let i = 0; i < 5; i++) control.mirror({ type: "event", event: { i, blob } });
	// The restart is a second prime on the same stream; nothing is reset.
	expect(primes).toHaveLength(2);
	expect(
		sent.some(
			(s) => s.streamId === STREAM && s.kind === "control" && typeOf(s.payload) === "stream_resync",
		),
	).toBe(false);
	// The superseded prime never wrote its snapshot.
	expect(sent.some((s) => s.streamId === STREAM && typeOf(s.payload) === "state")).toBe(false);
	// Release the jam: the restarted prime writes its single snapshot frame.
	const sentBefore = sent.length;
	jammed = false;
	await sentCount(sentBefore + 1);
	expect(builds).toBe(2);
	expect(sent.filter((s) => s.streamId === STREAM && typeOf(s.payload) === "state")).toHaveLength(
		1,
	);
	// Superseded held deltas are never replayed after the restarted snapshot.
	const snapshotAt = sent.findIndex((s) => s.streamId === STREAM && typeOf(s.payload) === "state");
	expect(
		sent.slice(snapshotAt + 1).some((s) => s.streamId === STREAM && typeOf(s.payload) === "event"),
	).toBe(false);
	control.stop();
});

test("sustained output with a full-speed client primes without a reset loop", async () => {
	// Live output keeps arriving while the prime drains. A full-speed client
	// acknowledges each frame as it drains, so the prime completes once and every
	// live delta lands in order, with no stream_resync.
	const { control, sent, primes, sentCount } = makeHarness(() => [{ type: "state", state: {} }]);
	const acknowledgeDrained = (): void => {
		const seq = sent.reduce((max, s) => (s.seq === null ? max : Math.max(max, s.seq)), 0);
		if (seq > 0) ackStream(control, seq);
	};
	openStream(control);
	const blob = "x".repeat(1024 * 1024);
	for (let i = 0; i < 40; i++) {
		const before = sent.length;
		control.mirror({ type: "event", event: { i, blob } });
		await sentCount(before + 1);
		acknowledgeDrained();
	}
	// state + 40 live deltas.
	await sentCount(41);
	acknowledgeDrained();
	expect(primes).toHaveLength(1);
	expect(
		sent.some(
			(s) => s.streamId === STREAM && s.kind === "control" && typeOf(s.payload) === "stream_resync",
		),
	).toBe(false);
	expect(sent.filter((s) => s.streamId === STREAM && typeOf(s.payload) === "state")).toHaveLength(
		1,
	);
	const eventIndex = (payload: unknown): number => {
		if (typeof payload !== "object" || payload === null || !("event" in payload)) return -1;
		const { event } = payload;
		if (typeof event !== "object" || event === null || !("i" in event)) return -1;
		return typeof event.i === "number" ? event.i : -1;
	};
	const indices = sent
		.filter((s) => s.streamId === STREAM && typeOf(s.payload) === "event")
		.map((s) => eventIndex(s.payload));
	expect(indices).toEqual(Array.from({ length: 40 }, (_, i) => i));
	control.stop();
});

describe("session-control replay ring releases evicted frames (WIRE-18)", () => {
	test("frames evicted from the replay ring become unreachable", async () => {
		const { control } = makeHarness(undefined, undefined, undefined, undefined, false);
		openStream(control);
		const refs: WeakRef<object>[] = [];
		// Frames are built in a helper so the test body holds no direct reference to them.
		const mirrorBlob = (): void => {
			const frame = { type: "state", state: { blob: "x".repeat(1024 * 1024) } };
			refs.push(new WeakRef(frame));
			control.mirror(frame);
		};
		for (let i = 0; i < 40; i++) mirrorBlob();
		const { ringEntries } = control.status().streams[0]!;
		// 4 MiB budget over ~1 MiB frames: only the newest few stay ringed.
		expect(ringEntries).toBeLessThan(5);
		// WeakRef targets created in this job only become collectable after it ends.
		for (let i = 0; i < 3; i++) {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			Bun.gc(true);
		}
		// The collector scans the stack conservatively, so the single most recently
		// evicted frame may still be pinned by a stale slot. Every older evicted frame
		// must be gone; an entries array that kept them would hold all of them alive.
		const evicted = refs.slice(0, refs.length - ringEntries - 1);
		expect(evicted.length).toBeGreaterThan(30);
		expect(evicted.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
		control.stop();
	});

	test("the ring compacts past its cap and a floor at the frontier replays exactly the retained tail", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control);
		for (let i = 0; i < 22_000; i++) control.mirror({ type: "state", state: { i } });
		const seqs = ringedSeqs(sent);
		expect(seqs).toHaveLength(22_000);
		expect(control.status().streams[0]!.ringEntries).toBe(10_000);
		const stateIndex = (payload: unknown): number => {
			if (typeof payload !== "object" || payload === null || !("state" in payload)) return -1;
			const { state } = payload;
			if (typeof state !== "object" || state === null || !("i" in state)) return -1;
			return typeof state.i === "number" ? state.i : -1;
		};
		// The 12,000 oldest deltas were evicted; the frontier is the newest of them.
		const before = sent.length;
		openStream(control, seqs[11_999]!);
		expect(primes).toHaveLength(1); // ring HIT: no re-prime
		const replayed = sent
			.slice(before)
			.filter((s) => s.kind === "frame" && typeOf(s.payload) === "state")
			.map((s) => stateIndex(s.payload));
		expect(replayed).toEqual(Array.from({ length: 10_000 }, (_, k) => k + 12_000));
		control.stop();
	});
});

describe("session-control paced priming waits on drain (SXP-16)", () => {
	test("a paced prime parks on the pair's drain and resumes when it fires", async () => {
		let queued = Number.MAX_SAFE_INTEGER; // no room: every priming frame waits
		const subscribed = Promise.withResolvers<void>();
		let wake = (): void => {};
		const harness = makeHarness(
			() => [{ type: "hello_ok" }, { type: "attached", scope: "d1" }],
			() => true,
			undefined,
			() => ({ stream: queued, connection: queued }),
			true,
			undefined,
			(listener) => {
				wake = listener;
				subscribed.resolve();
				return () => {};
			},
		);
		openStream(harness.control);
		await subscribed.promise;
		expect(harness.sent.filter((s) => s.kind === "frame")).toHaveLength(0);
		// The buffer empties and the pair signals the drain: the prime emits every frame.
		queued = 0;
		wake();
		await harness.sentCount(2); // hello_ok + attached
		expect(harness.sent.filter((s) => s.kind === "frame").map((s) => typeOf(s.payload))).toEqual([
			"hello_ok",
			"attached",
		]);
		harness.control.stop();
	});
});

describe("session-control ack-paced priming (fleet drain credit)", () => {
	const PAD = 700 * 1024;
	const FRAMES = 6;
	const snapshot = (): Record<string, unknown>[] =>
		Array.from({ length: FRAMES }, (_, i) => ({ type: "history", chunk: i, pad: "x".repeat(PAD) }));
	/** Let every promise continuation the priming loop has queued run (it awaits only microtasks until it parks). */
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	};
	const historySeqs = (sent: Sent[]): number[] =>
		sent.filter((s) => s.kind === "frame" && typeOf(s.payload) === "history").map((s) => s.seq!);

	test("a stream holds the burst to the credit window and releases it per stream_ack", async () => {
		const { control, sent } = makeHarness(snapshot);
		openStream(control);
		await settle();
		// A frame goes out only while unacknowledged bytes plus one maximal envelope
		// (1 MiB) fit the 3 MiB window: three 700 KiB frames leave 2100 KiB in flight.
		expect(historySeqs(sent)).toHaveLength(3);
		await settle();
		expect(historySeqs(sent)).toHaveLength(3);
		// Acking the first frees exactly enough for the next one.
		ackStream(control, historySeqs(sent)[0]!);
		await settle();
		expect(historySeqs(sent)).toHaveLength(4);
		// A cumulative ack past everything sent lets the rest through.
		ackStream(control, historySeqs(sent).at(-1)!);
		await settle();
		expect(historySeqs(sent)).toHaveLength(FRAMES);
		control.stop();
	});

	test("a stale ack releases nothing; a stream_close wakes the parked sender", async () => {
		const drains = new Set<() => void>();
		const { control, sent } = makeHarness(
			snapshot,
			() => true,
			undefined,
			undefined,
			true,
			undefined,
			(listener) => {
				drains.add(listener);
				return () => drains.delete(listener);
			},
		);
		openStream(control);
		await settle();
		expect(historySeqs(sent)).toHaveLength(3);
		ackStream(control, 1); // below every sent seq
		await settle();
		expect(historySeqs(sent)).toHaveLength(3);
		expect(drains.size).toBe(1); // the sender is parked on drain
		control.handleEnvelope({
			version: 2,
			workspaceId: "w1",
			generation: 1,
			connectionId: "conn",
			streamId: STREAM,
			seq: 0,
			kind: "control",
			payload: { type: "stream_close" },
			at: Date.now(),
		} satisfies CallbackEnvelope);
		await settle();
		expect(drains.size).toBe(0); // closing the stream woke it and it gave up
		expect(historySeqs(sent)).toHaveLength(3);
		control.stop();
	});
});

describe("session-control control mirror carries only what the fleet reads", () => {
	const messageUpdate = (text: string) => ({
		type: "event",
		event: {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		},
	});
	/** `type`, or `event:<event.type>` for an event frame. */
	const label = (payload: unknown): string => {
		if (typeof payload === "object" && payload !== null && "event" in payload) {
			const event = payload.event;
			if (typeof event === "object" && event !== null && "type" in event) {
				return `event:${String(event.type)}`;
			}
		}
		return typeOf(payload) ?? "";
	};
	const fromTypes = (sent: Sent[], streamId: string): string[] =>
		sent.filter((s) => s.streamId === streamId && s.kind === "frame").map((s) => label(s.payload));

	test("streaming deltas skip the control stream; every other frame still mirrors", () => {
		const { control, sent } = makeHarness();
		control.mirror({ type: "state", state: { isStreaming: true } });
		control.mirror(messageUpdate("a"));
		control.mirror({ type: "event", event: { type: "tool_execution_update", toolCallId: "t1" } });
		control.mirror({ type: "bash_chunk", id: 1, text: "out" });
		control.mirror({ type: "python_chunk", id: 2, text: "out" });
		control.mirror({
			type: "event",
			event: { type: "message_end", message: { role: "assistant" } },
		});
		control.mirror({ type: "event", event: { type: "agent_end" } });
		control.mirror({ type: "call_result", id: "c1", ok: true });
		control.mirror({ type: "ui_request", id: "d1" });
		expect(fromTypes(sent, "control")).toEqual([
			"state",
			"event:message_end",
			"event:agent_end",
			"call_result",
			"ui_request",
		]);
		control.stop();
	});

	test("browser streams still get the deltas, ringed with wire seqs, and replay them", () => {
		const { control, sent } = makeHarness();
		openStream(control);
		control.mirror({ type: "state", state: { isStreaming: true } }); // wire 1025
		control.mirror(messageUpdate("a")); // wire 1026
		control.mirror(messageUpdate("b")); // wire 1027
		control.mirror({ type: "bash_chunk", id: 1, text: "out" }); // wire 1028
		expect(fromTypes(sent, STREAM)).toEqual([
			"state",
			"event:message_update",
			"event:message_update",
			"bash_chunk",
		]);
		expect(ringedSeqs(sent)).toEqual([1025, 1026, 1027, 1028]);
		expect(fromTypes(sent, "control")).toEqual(["state"]);

		// A reconnect with the floor at the first delta replays the three dropped-from-control
		// frames from the ring, unchanged, under fresh seqs.
		const before = sent.length;
		openStream(control, 1025);
		const replayed = sent.slice(before).filter((s) => s.kind === "frame");
		expect(replayed.map((s) => s.payload)).toEqual([
			messageUpdate("a"),
			messageUpdate("b"),
			{ type: "bash_chunk", id: 1, text: "out" },
		]);
		expect(control.status().streams[0]!.ringEntries).toBe(4);
		control.stop();
	});
});

describe("session-control stream_pause / stream_resume (a parked browser stream)", () => {
	const control$ = (control: SessionControl, type: "stream_pause" | "stream_resume"): void =>
		control.handleEnvelope({
			version: 2,
			workspaceId: "w1",
			generation: 1,
			connectionId: "conn",
			streamId: STREAM,
			seq: 0,
			kind: "control",
			payload: { type },
			at: Date.now(),
		} satisfies CallbackEnvelope);
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	const framesTo = (sent: Sent[], from: number) =>
		sent.slice(from).filter((s) => s.streamId === STREAM && s.kind === "frame");

	test("a paused stream sends nothing; the resume sends the held deltas in order without a re-prime", async () => {
		const { control, sent, primes } = makeHarness();
		openStream(control);
		await settle();
		control$(control, "stream_pause");
		const before = sent.length;
		for (let i = 0; i < 3; i++) control.mirror({ type: "state", state: { n: i } });
		expect(framesTo(sent, before)).toHaveLength(0);
		control$(control, "stream_resume");
		const resumed = framesTo(sent, before);
		expect(resumed.map((s) => (s.payload as { state: { n: number } }).state.n)).toEqual([0, 1, 2]);
		expect(primes).toHaveLength(1);
		// Live again: a later delta goes out at once.
		control.mirror({ type: "state", state: { n: 3 } });
		expect(framesTo(sent, before)).toHaveLength(4);
		control.stop();
	});

	test("a history resync while paused makes the resume re-prime the stream", async () => {
		const { control, sent, primes } = makeHarness();
		openStream(control);
		await settle();
		control$(control, "stream_pause");
		const before = sent.length;
		control.mirror({ type: "history", messages: [] });
		control.mirror({ type: "state", state: { n: 1 } });
		control$(control, "stream_resume");
		expect(resyncSent(sent, before)).toBe(true);
		expect(primes).toHaveLength(2);
		control.stop();
	});

	test("a hold past the ring budget gives up: the resume re-primes instead of replaying a partial tail", async () => {
		const { control, sent, primes } = makeHarness();
		openStream(control);
		await settle();
		control$(control, "stream_pause");
		const before = sent.length;
		const big = { type: "state", state: { blob: "x".repeat(3 * 1024 * 1024) } };
		control.mirror(big);
		control.mirror(big);
		control$(control, "stream_resume");
		expect(resyncSent(sent, before)).toBe(true);
		expect(primes).toHaveLength(2);
		control.stop();
	});

	test("a resume without a pause changes nothing", async () => {
		const { control, sent, primes } = makeHarness();
		openStream(control);
		await settle();
		const before = sent.length;
		control$(control, "stream_resume");
		expect(sent.length).toBe(before);
		expect(primes).toHaveLength(1);
		control.stop();
	});
});
