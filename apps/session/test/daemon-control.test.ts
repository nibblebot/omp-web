/**
 * Daemon control broker replay regression (P3.10): per-browser virtual
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
 *     to `deps.primeStream(...)`; a re-prime where the client already had
 *     everything (P3.10: "ring hit replays; only a miss re-primes").
 *
 * Fix: track the ring eviction frontier (`evictedSeq`, the highest wire seq
 * dropped from the head). A floor BELOW the frontier is a MISS →
 * stream_resync + ring clear + full re-prime (never a partial tail). A
 * floor at or above the frontier replays retained entries newer than it
 * (HIT). A caught-up HIT replays nothing and does NOT re-prime. Only a
 * brand-new stream primes fresh. A pair replacement clears every stream's
 * ring (per-connection seq spaces restart) and re-primes it fresh.
 *
 * Pure unit: createDaemonControl with a stub deps whose send() assigns
 * synthetic wire seqs (like the real transport) and records every emit.
 */
import { describe, expect, test } from "bun:test";
import { createDaemonControl, type DaemonControl, type DaemonControlDeps } from "../daemon-control";
import type { CallbackEnvelope, CallbackKind } from "../../../lib/wire/callback-protocol";

const STREAM = "browser/test-conn";

interface Sent {
	streamId: string;
	kind: CallbackKind;
	payload: unknown;
	seq: number | null; // null when the transport reported no seq (non-ringed)
}

/** Narrow a sent payload to an object with a string `type` (control/frame
 * vocabulary; the only shape daemon-control emits). */
function typeOf(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	if (!("type" in payload)) return undefined;
	return typeof payload.type === "string" ? payload.type : undefined;
}

/** Stub deps: send() returns "sent", assigns a fresh wire seq per ringed
 * browser-stream frame (invoking onEmittedSeq like the real transport), and
 * records every send. primeStream records its calls. */
function makeHarness(): { control: DaemonControl; sent: Sent[]; primes: string[] } {
	const sent: Sent[] = [];
	const primes: string[] = [];
	let wireSeq = 1024;
	const send: DaemonControlDeps["send"] = (streamId, kind, payload, onEmittedSeq): string => {
		let seq: number | null = null;
		if (onEmittedSeq !== undefined && streamId.startsWith("browser/") && kind === "frame") {
			seq = ++wireSeq;
			onEmittedSeq(seq);
		}
		sent.push({ streamId, kind, payload, seq });
		return "sent";
	};
	const deps: DaemonControlDeps = {
		getEntry: () => undefined,
		handleCommand: async () => undefined,
		flushWriters: async () => ({
			ok: true,
			descendants: [],
			advisors: "inactive",
		}),
		finalizeTailer: async () => ({}),
		waitForAckedBoundary: async () => {},
		verifyLineage: async () => ({
			manifestFiles: [],
			provenance: { workspaceId: "w1", workspaceName: "w", resolvedCommit: "", generatedAt: 0 },
		}),
		collectGitEvidence: async () => ({ ok: true }),
		primeStream: (streamId) => {
			primes.push(streamId);
		},
		send,
		pairLive: () => true,
		mainSessionFile: null,
	};
	const control = createDaemonControl(deps);
	return { control, sent, primes };
}

/** Open the stream (stream_open control) with an optional lastSeq. */
function openStream(control: DaemonControl, lastSeq?: number): void {
	control.handleEnvelope({
		version: 1,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: STREAM,
		seq: 0,
		kind: "control",
		payload: { type: "stream_open", ...(lastSeq !== undefined ? { lastSeq } : {}) },
		at: Date.now(),
	} satisfies CallbackEnvelope);
}

/** Ringed-delta frame on a browser stream via mirror (state is ringed). */
function emitState(control: DaemonControl): void {
	control.mirror({ type: "state", state: { streaming: true } });
}

/** Non-ringed frame on a browser stream via publish (priming burst). */
function emitPrimeFrame(control: DaemonControl): void {
	control.publish(STREAM, { type: "history", messages: [] });
}

const ringedSeqs = (sent: Sent[], streamId = STREAM): number[] =>
	sent.filter((s) => s.streamId === streamId && s.seq !== null).map((s) => s.seq as number);

describe("daemon-control stream_open replay (P3.10)", () => {
	test("a fresh stream primes; subsequent ringed deltas ring with wire seqs", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // brand-new: prime
		expect(primes).toEqual([STREAM]);
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
		expect(replayed.length).toBe(2); // stream_open ack + replayed delta
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
		// Only the stream_open ack was added, no replayed delta, no prime.
		const added = sent.slice(sentBeforeReopen);
		expect(added.length).toBe(1); // the ack
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
		// Exactly the replayed event frame + the stream_open ack, no prime.
		expect(added.filter((s) => s.kind === "frame")).toHaveLength(1);
		expect(typeOf(added.find((s) => s.kind === "frame")!.payload)).toBe("event");
		control.stop();
	});

	test("stream_close drops the stream; a later open is fresh and primes", () => {
		const { control, primes } = makeHarness();
		openStream(control); // prime (1)
		control.handleEnvelope({
			version: 1,
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

	test("pair replacement clears the ring and re-primes every stream fresh", () => {
		const { control, sent, primes } = makeHarness();
		openStream(control); // prime (1)
		emitState(control); // wire 1025, ringed
		emitState(control); // wire 1026, ringed
		expect(primes.length).toBe(1);
		// Pair replacement: the per-connection seq space restarts, so the old
		// ring (seqs 1025/1026 of the dead pair) must be cleared and the
		// stream re-primed, never replayed into the new seq space.
		control.onPairChange();
		expect(primes.length).toBe(2); // re-primed
		const st = control.status().streams[0]!;
		expect(st.ringEntries).toBe(0); // ring cleared
		expect(st.lastSeq).toBe(0); // seq floor reset
		expect(st.ringBytes).toBe(0);
		// New-pair live deltas ring afresh from the reset state.
		const sentBefore = sent.length;
		emitState(control); // wire 1027 on the new pair
		const newRinged = sent.slice(sentBefore).filter((s) => s.kind === "frame" && s.seq !== null);
		expect(newRinged.length).toBe(1);
		// A reconnect floor at the reset seq is a caught-up HIT (no replay of
		// dead-pair entries, no re-prime).
		const sentBeforeReopen = sent.length;
		openStream(control, 1027);
		expect(primes.length).toBe(2); // no new prime
		expect(sent.slice(sentBeforeReopen).filter((s) => s.kind === "frame")).toHaveLength(0);
		control.stop();
	});
});
