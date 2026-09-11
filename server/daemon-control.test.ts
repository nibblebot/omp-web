/**
 * Daemon control broker tests: stream_open ring-hit replay vs ring-miss
 * re-prime (P3.10); the Kubernetes quiesce_clone branch (P3.5: typed
 * admission, single evidence upload, requestId-cached replay, permanent
 * admission closure); and the clone-download lane (P3.4: the shared
 * /download realpath jail, bounded 4 MiB multi-part streaming, and the typed
 * ack + download_bulk_failed control on failure).
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDaemonControl,
	type DaemonControl,
	type DaemonControlDeps,
	type DaemonDownloadBulkDeps,
	type DaemonQuiesceCloneDeps,
} from "./daemon-control";
import { canonicalJailRoots } from "./download-jail";
import {
	parseQuiesceEvidence,
	type CallbackEnvelope,
	type CallbackKind,
	type CloneGitEvidence,
} from "../shared/callback-protocol";
import type { ReachableWriterFlushReport } from "./writer-flush";

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

/** One evidence upload recorded by the stub bulk channel. */
interface Upload {
	correlationId: string;
	document: string;
}

interface Harness {
	control: DaemonControl;
	sent: Sent[];
	primes: string[];
	uploads: Upload[];
}

/** Stub deps: send() returns "sent", assigns a fresh wire seq per ringed
 * browser-stream frame (invoking onEmittedSeq like the real transport), and
 * records every send. primeStream records its calls. `overrides` replaces
 * individual deps (e.g. the Kubernetes quiesce_clone support); `uploads` is
 * the shared array a clone harness records its bulk uploads into; `onSend`
 * observes every recorded emit (async lanes resolve their settled promises
 * from it, never from a wall-clock timer). */
function makeHarness(
	overrides: Partial<DaemonControlDeps> = {},
	uploads: Upload[] = [],
	onSend?: (streamId: string, kind: CallbackKind, payload: unknown) => void,
): Harness {
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
		onSend?.(streamId, kind, payload);
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
		...overrides,
	};
	const control = createDaemonControl(deps);
	return { control, sent, primes, uploads };
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
		// Only the stream_open ack was added — no replayed delta, no prime.
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
		// 1025): the client still needs the evicted delta — a MISS.
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
		// Exactly the replayed event frame + the stream_open ack — no prime.
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
		// stream re-primed — never replayed into the new seq space.
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

// ---------------------------------------------------------------------------
// Kubernetes quiesce_clone (P3.5): typed admission, single evidence upload,
// requestId-cached replay, and permanent admission closure.
// ---------------------------------------------------------------------------

const TRANSPORT = "transport";
const PINNED = "a".repeat(40);

const CLEAN_GIT: CloneGitEvidence = {
	status: "clean",
	head: PINNED,
	branch: "acceptance",
	dirty: { added: 0, modified: 0, deleted: 0, untracked: 0 },
	stashes: 0,
	remote: { name: "origin", url: "https://git.example.com/repo.git" },
	refs: [{ name: "refs/heads/acceptance", tip: PINNED, preserved: true }],
};

/** A well-formed quiesce_clone payload; overrides model each invalid field. */
function cloneRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "quiesce_clone",
		requestId: "req-1",
		correlationId: "corr-1",
		sourceRemote: "https://git.example.com/repo.git",
		pinnedRevision: PINNED,
		branch: "acceptance",
		...overrides,
	};
}

function cloneEnvelope(
	overrides: Partial<CallbackEnvelope> = {},
	payload: Record<string, unknown> = cloneRequest(),
): CallbackEnvelope {
	return {
		version: 1,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: TRANSPORT,
		seq: 0,
		kind: "control",
		payload,
		at: Date.now(),
		...overrides,
	};
}

/** A command envelope on the reserved control stream (handleCommand path). */
function commandEnvelope(payload: Record<string, unknown>): CallbackEnvelope {
	return {
		version: 1,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: "control",
		seq: 0,
		kind: "command",
		payload,
		at: Date.now(),
	};
}

interface CloneHarness extends Harness {
	/** One entry per reachable-writer flush attempt (must stay empty when admission fails). */
	flushCalls: number[];
	/** One entry per session-cascade disposal (a replay must never re-dispose). */
	disposeCalls: number[];
}

interface CloneHarnessOptions {
	identity?: { workspaceId: string; generation: number; connectionId: string | null };
	collectGitEvidence?: DaemonControlDeps["collectGitEvidence"];
	uploadError?: string;
	/** Fail only the FIRST bulk upload with this message, so a replay succeeds. */
	failFirstUpload?: string;
	/** Command dispatch spy: proves a closed admission never reaches the handler. */
	handleCommand?: DaemonControlDeps["handleCommand"];
}

/** A harness wired for Kubernetes quiesce_clone with a healthy stub cluster. */
function makeCloneHarness(options: CloneHarnessOptions = {}): CloneHarness {
	const uploads: Upload[] = [];
	const flushCalls: number[] = [];
	const disposeCalls: number[] = [];
	const identity = options.identity ?? { workspaceId: "w1", generation: 1, connectionId: "conn" };
	let firstUploadFailed = false;
	const quiesceClone: DaemonQuiesceCloneDeps = {
		identity: () => identity,
		mainSessionRelpath: () => "main.jsonl",
		uploadEvidence: async (correlationId, document) => {
			if (options.uploadError !== undefined) throw new Error(options.uploadError);
			if (options.failFirstUpload !== undefined && !firstUploadFailed) {
				firstUploadFailed = true;
				throw new Error(options.failFirstUpload);
			}
			uploads.push({ correlationId, document });
		},
		flushReachableWriters: async () => {
			flushCalls.push(Date.now());
			return {
				ok: true,
				writers: [
					{ id: "s1", kind: "main", sessionFile: "/sessions/main.jsonl", state: "flushed" },
				],
				advisors: "inactive",
			} satisfies ReachableWriterFlushReport;
		},
	};
	const harness = makeHarness(
		{
			getEntry: () => ({
				disposeQuiesce: async () => {
					disposeCalls.push(Date.now());
				},
			}),
			verifyLineage: async () => ({
				manifestFiles: [],
				provenance: {
					workspaceId: "w1",
					workspaceName: "w",
					resolvedCommit: PINNED,
					generatedAt: 0,
				},
			}),
			collectGitEvidence:
				options.collectGitEvidence ?? (async () => ({ ok: true, git: CLEAN_GIT })),
			handleCommand: options.handleCommand ?? (async () => undefined),
			quiesceClone,
		},
		uploads,
	);
	return { ...harness, flushCalls, disposeCalls };
}

/** Drain microtasks until `predicate` holds (async replay paths flip no status). */
async function settleUntil(predicate: () => boolean, failure: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(failure);
}

/** Drain microtasks until an admitted quiesce_clone records its outcome. */
async function settleClone(control: DaemonControl): Promise<void> {
	await settleUntil(
		() => control.status().lastQuiesceClone !== null,
		"quiesce_clone never settled",
	);
}

const cloneResults = (sent: Sent[]): Sent[] =>
	sent.filter((s) => s.kind === "control" && typeOf(s.payload) === "quiesce_clone_result");

const cloneAcks = (sent: Sent[]): Sent[] =>
	sent.filter((s) => s.kind === "ack" && typeOf(s.payload) === "quiesce_clone");

interface AckFields {
	/**
	 * True only when the payload explicitly declares ok:false. A receipt-only
	 * CommandAckPayload carries no `ok` at all, so a falsy check would mistake
	 * a receipt for a rejection.
	 */
	rejected: boolean;
	ok: boolean;
	code: string | undefined;
	message: string | undefined;
	/** The ClientCommand id carried by a receipt-only command_ack. */
	id: string | undefined;
}

/**
 * Narrow a control ack payload. Failures carry their reason ONLY in the
 * canonical nested ControlAckPayload.error; a top-level code/message is never
 * read, so a regression to the removed workaround fails these assertions.
 */
function ackFields(payload: unknown): AckFields {
	if (typeof payload !== "object" || payload === null) {
		return { rejected: false, ok: false, code: undefined, message: undefined, id: undefined };
	}
	const ok = "ok" in payload && payload.ok === true;
	const rejected = "ok" in payload && payload.ok === false;
	const id = "id" in payload && typeof payload.id === "string" ? payload.id : undefined;
	if ("error" in payload && typeof payload.error === "object" && payload.error !== null) {
		const error = payload.error;
		return {
			rejected,
			ok,
			id,
			code: "code" in error && typeof error.code === "string" ? error.code : undefined,
			message: "message" in error && typeof error.message === "string" ? error.message : undefined,
		};
	}
	return { rejected, ok, id, code: undefined, message: undefined };
}

interface ResultFields {
	requestId: string | undefined;
	correlationId: string | undefined;
	ok: boolean;
	code: string | undefined;
	message: string | undefined;
}

/** Narrow a quiesce_clone_result control payload. */
function resultFields(payload: unknown): ResultFields {
	const none: ResultFields = {
		requestId: undefined,
		correlationId: undefined,
		ok: false,
		code: undefined,
		message: undefined,
	};
	if (typeof payload !== "object" || payload === null) return none;
	const result: ResultFields = {
		requestId:
			"requestId" in payload && typeof payload.requestId === "string"
				? payload.requestId
				: undefined,
		correlationId:
			"correlationId" in payload && typeof payload.correlationId === "string"
				? payload.correlationId
				: undefined,
		ok: "ok" in payload && payload.ok === true,
		code: undefined,
		message: undefined,
	};
	if ("error" in payload && typeof payload.error === "object" && payload.error !== null) {
		const error = payload.error;
		result.code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		result.message =
			"message" in error && typeof error.message === "string" ? error.message : undefined;
	}
	return result;
}

describe("daemon-control quiesce_clone (P3.5)", () => {
	test("a successful request answers ok:true and uploads exactly one evidence document", async () => {
		const { control, sent, uploads } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);

		const acks = cloneAcks(sent);
		expect(acks).toHaveLength(1);
		expect(ackFields(acks[0]!.payload).ok).toBe(true);

		const results = cloneResults(sent);
		expect(results).toHaveLength(1);
		const result = resultFields(results[0]!.payload);
		expect(result.requestId).toBe("req-1");
		expect(result.correlationId).toBe("corr-1");
		expect(result.ok).toBe(true);

		expect(uploads).toHaveLength(1);
		expect(uploads[0]!.correlationId).toBe("corr-1");
		const evidence = parseQuiesceEvidence(uploads[0]!.document);
		expect(evidence.requestId).toBe("req-1");
		expect(evidence.mainSessionRelpath).toBe("main.jsonl");
		expect(evidence.writers.main).toBe("flushed");
		expect(evidence.git.status).toBe("clean");
		expect(evidence.provenance.resolvedCommit).toBe(PINNED);

		expect(control.status().admissionClosed).toBe(true);
		expect(control.status().lastQuiesceClone?.ok).toBe(true);
	});

	test("a duplicate requestId replays the cached outcome without a second upload", async () => {
		const { control, sent, uploads } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		expect(uploads).toHaveLength(1);

		const sentBefore = sent.length;
		control.handleEnvelope(cloneEnvelope());
		const added = sent.slice(sentBefore);
		expect(cloneAcks(added)).toHaveLength(1);
		expect(ackFields(cloneAcks(added)[0]!.payload).ok).toBe(true);
		expect(cloneResults(added)).toHaveLength(1);
		expect(resultFields(cloneResults(added)[0]!.payload).ok).toBe(true);
		// The receipt keeps the original capture correlation.
		expect(resultFields(cloneResults(added)[0]!.payload).correlationId).toBe("corr-1");
		// No re-collection: still exactly one evidence upload.
		expect(uploads).toHaveLength(1);
		expect(cloneResults(sent)).toHaveLength(2);
	});

	test("a duplicate with a fresh correlationId re-uploads the cached evidence under it", async () => {
		const { control, sent, uploads, flushCalls, disposeCalls } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		expect(uploads).toHaveLength(1);
		expect(flushCalls).toHaveLength(1);
		expect(disposeCalls).toHaveLength(1);

		// The fleet opens a fresh single-use capture correlation per delete
		// attempt and ignores a result whose correlationId differs.
		const sentBefore = sent.length;
		control.handleEnvelope(cloneEnvelope({}, cloneRequest({ correlationId: "corr-2" })));
		await settleUntil(() => cloneResults(sent).length === 2, "quiesce_clone replay never settled");
		const added = sent.slice(sentBefore);
		expect(cloneAcks(added)).toHaveLength(1);
		expect(ackFields(cloneAcks(added)[0]!.payload).ok).toBe(true);

		// The cached document is re-sent under the NEW correlation: exactly one
		// new upload, byte-identical, still bound to the request it was
		// collected for.
		expect(uploads).toHaveLength(2);
		expect(uploads[1]!.correlationId).toBe("corr-2");
		expect(uploads[1]!.document).toBe(uploads[0]!.document);
		expect(parseQuiesceEvidence(uploads[1]!.document).requestId).toBe("req-1");

		const replayed = resultFields(cloneResults(added)[0]!.payload);
		expect(replayed.requestId).toBe("req-1");
		expect(replayed.correlationId).toBe("corr-2");
		expect(replayed.ok).toBe(true);
		expect(cloneResults(sent)).toHaveLength(2);

		// Single collection per requestId: no second flush and no second dispose.
		expect(flushCalls).toHaveLength(1);
		expect(disposeCalls).toHaveLength(1);
	});

	test("a duplicate retries a timed-out evidence upload under its fresh correlation", async () => {
		const { control, sent, uploads, flushCalls, disposeCalls } = makeCloneHarness({
			failFirstUpload: "bulk channel timed out",
		});
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		const first = resultFields(cloneResults(sent)[0]!.payload);
		expect(first.ok).toBe(false);
		expect(first.code).toBe("unavailable");
		expect(first.message).toContain("bulk channel timed out");
		expect(uploads).toHaveLength(0);

		// The retry reuses the requestId (same generation + Pod uid) but opens a
		// new capture correlation: the cached document is the retry, not a
		// second collection.
		const sentBefore = sent.length;
		control.handleEnvelope(cloneEnvelope({}, cloneRequest({ correlationId: "corr-2" })));
		await settleUntil(() => cloneResults(sent).length === 2, "quiesce_clone replay never settled");
		const added = sent.slice(sentBefore);
		expect(uploads).toHaveLength(1);
		expect(uploads[0]!.correlationId).toBe("corr-2");
		const replayed = resultFields(cloneResults(added)[0]!.payload);
		expect(replayed.requestId).toBe("req-1");
		expect(replayed.correlationId).toBe("corr-2");
		expect(replayed.ok).toBe(true);
		expect(parseQuiesceEvidence(uploads[0]!.document).requestId).toBe("req-1");
		expect(flushCalls).toHaveLength(1);
		expect(disposeCalls).toHaveLength(1);
	});

	test("a workspace mismatch is rejected invalid_identity before any flush or upload", () => {
		const { control, sent, uploads, flushCalls } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope({ workspaceId: "other" }));
		const acks = cloneAcks(sent);
		expect(acks).toHaveLength(1);
		const ack = ackFields(acks[0]!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("invalid_identity");
		expect(uploads).toHaveLength(0);
		expect(flushCalls).toHaveLength(0);
		expect(control.status().admissionClosed).toBe(false);
	});

	test("a generation mismatch is rejected generation_obsolete before any flush or upload", () => {
		const { control, sent, uploads, flushCalls } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope({ generation: 9 }));
		const ack = ackFields(cloneAcks(sent)[0]!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("generation_obsolete");
		expect(uploads).toHaveLength(0);
		expect(flushCalls).toHaveLength(0);
	});

	test("a connection mismatch is rejected before any flush or upload", () => {
		const { control, sent, uploads, flushCalls } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope({ connectionId: "other" }));
		const ack = ackFields(cloneAcks(sent)[0]!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("invalid_request");
		expect(uploads).toHaveLength(0);
		expect(flushCalls).toHaveLength(0);
	});

	test("an unsupported control (no quiesceClone dep) gets the typed unsupported error", () => {
		const { control, sent, uploads } = makeHarness();
		control.handleEnvelope(cloneEnvelope());
		const acks = cloneAcks(sent);
		expect(acks).toHaveLength(1);
		const ack = ackFields(acks[0]!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("invalid_request");
		expect(uploads).toHaveLength(0);
		// The branch never ran: no result control was emitted.
		expect(cloneResults(sent)).toHaveLength(0);
	});

	test("a request on a non-transport stream is rejected without running the branch", () => {
		const { control, sent, uploads, flushCalls } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope({ streamId: "browser/x" }));
		const ack = ackFields(cloneAcks(sent)[0]!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("invalid_request");
		expect(uploads).toHaveLength(0);
		expect(flushCalls).toHaveLength(0);
	});

	test("a failed Git evidence probe answers ok:false with the typed conflict code", async () => {
		const { control, sent, uploads } = makeCloneHarness({
			collectGitEvidence: async () => ({
				ok: false,
				error: { code: "conflict", message: "working tree is dirty" },
			}),
		});
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		const result = resultFields(cloneResults(sent)[0]!.payload);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("conflict");
		expect(result.message).toContain("working tree is dirty");
		expect(uploads).toHaveLength(0);
		expect(control.status().lastQuiesceClone?.ok).toBe(false);
	});

	test("an evidence upload failure answers ok:false with the typed unavailable code", async () => {
		const { control, sent, uploads } = makeCloneHarness({ uploadError: "bulk channel closed" });
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		const result = resultFields(cloneResults(sent)[0]!.payload);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("unavailable");
		expect(result.message).toContain("bulk channel closed");
		expect(uploads).toHaveLength(0);
	});

	test("admission stays closed after the clone: a later quiesce_begin is conflict", async () => {
		const { control, sent } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		expect(control.status().admissionClosed).toBe(true);

		const before = sent.length;
		control.handleEnvelope({
			version: 1,
			workspaceId: "w1",
			generation: 1,
			connectionId: "conn",
			streamId: TRANSPORT,
			seq: 0,
			kind: "control",
			payload: { type: "quiesce_begin", requestId: "q-2" },
			at: Date.now(),
		} satisfies CallbackEnvelope);
		const beginAck = sent
			.slice(before)
			.find((s) => s.kind === "ack" && typeOf(s.payload) === "quiesce_begin");
		expect(beginAck).toBeDefined();
		const ack = ackFields(beginAck!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("conflict");
		expect(control.status().admissionClosed).toBe(true);
	});

	test("a successful clone leaves admission closed: a later command is rejected and never dispatched", async () => {
		const dispatched: unknown[] = [];
		const { control, sent } = makeCloneHarness({
			handleCommand: async (command) => {
				dispatched.push(command);
				return undefined;
			},
		});
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		expect(control.status().admissionClosed).toBe(true);
		expect(control.status().admissionBarrier).toBe(true);

		const before = sent.length;
		control.handleEnvelope(
			commandEnvelope({ type: "call", id: "cmd-1", method: "prompt", args: ["hello"] }),
		);
		const acks = sent.slice(before).filter((s) => s.kind === "ack");
		// Wire contract: the id-keyed receipt (no `ok`) precedes the explicit
		// typed rejection, and only the rejection declares ok:false.
		const fields = acks.map((s) => ackFields(s.payload));
		expect(fields).toHaveLength(2);
		expect(typeOf(acks[0]!.payload)).toBe("command_ack");
		expect(fields[0]!.id).toBe("cmd-1");
		expect(fields[0]!.rejected).toBe(false);
		const rejections = fields.filter((f) => f.rejected);
		expect(rejections).toHaveLength(1);
		expect(rejections[0]!.code).toBe("writer_active");
		// Disposal happened; the closed admission never reaches the dispatcher.
		expect(dispatched).toHaveLength(0);
	});

	test("a FAILED clone also keeps admission closed on later commands", async () => {
		const dispatched: unknown[] = [];
		const { control, sent } = makeCloneHarness({
			collectGitEvidence: async () => ({
				ok: false,
				error: { code: "conflict", message: "working tree is dirty" },
			}),
			handleCommand: async (command) => {
				dispatched.push(command);
				return undefined;
			},
		});
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);
		expect(control.status().lastQuiesceClone?.ok).toBe(false);
		expect(control.status().admissionClosed).toBe(true);
		expect(control.status().admissionBarrier).toBe(true);

		const before = sent.length;
		control.handleEnvelope(
			commandEnvelope({ type: "call", id: "cmd-2", method: "prompt", args: ["hello"] }),
		);
		const acks = sent.slice(before).filter((s) => s.kind === "ack");
		// Receipt first (id-keyed, no `ok`), then the ok:false writer_active
		// rejection: the same contract the successful-clone case asserts.
		const fields = acks.map((s) => ackFields(s.payload));
		expect(fields).toHaveLength(2);
		expect(fields[0]!.id).toBe("cmd-2");
		expect(fields[0]!.rejected).toBe(false);
		const rejections = fields.filter((f) => f.rejected);
		expect(rejections).toHaveLength(1);
		expect(rejections[0]!.code).toBe("writer_active");
		expect(dispatched).toHaveLength(0);
	});

	test("a cached replay keeps admission closed; a fresh requestId after closure is conflict", async () => {
		const { control, sent, uploads } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope());
		await settleClone(control);

		// Same requestId with a fresh capture correlation: replay, no re-collection.
		control.handleEnvelope(cloneEnvelope({}, cloneRequest({ correlationId: "corr-2" })));
		await settleUntil(() => cloneResults(sent).length === 2, "quiesce_clone replay never settled");
		expect(resultFields(cloneResults(sent)[1]!.payload).ok).toBe(true);
		expect(uploads).toHaveLength(2);
		expect(control.status().admissionBarrier).toBe(true);

		// A brand-new requestId is a new quiesce attempt: conflict, never a reopen.
		control.handleEnvelope(cloneEnvelope({}, cloneRequest({ requestId: "req-9" })));
		const ack = ackFields(cloneAcks(sent).at(-1)!.payload);
		expect(ack.ok).toBe(false);
		expect(ack.code).toBe("conflict");
		expect(control.status().admissionClosed).toBe(true);
	});

	test("a rejected clone ack carries its reason only in the nested error", () => {
		const { control, sent } = makeCloneHarness();
		control.handleEnvelope(cloneEnvelope({ workspaceId: "other" }));
		const payload = cloneAcks(sent)[0]!.payload as Record<string, unknown>;
		expect(Object.keys(payload).sort()).toEqual(["error", "ok", "requestId", "type"]);
		expect(payload).not.toHaveProperty("code");
		expect(payload).not.toHaveProperty("message");
	});

	test("invalid sourceRemote/pinnedRevision/branch are rejected before any flush or upload", () => {
		const cases = [
			cloneRequest({ sourceRemote: "file:///etc/passwd" }),
			cloneRequest({ sourceRemote: "https://git.example.com" }),
			cloneRequest({ pinnedRevision: "abc123" }),
			cloneRequest({ branch: "foo//bar" }),
			cloneRequest({ branch: "" }),
		];
		for (const payload of cases) {
			const { control, sent, uploads, flushCalls } = makeCloneHarness();
			control.handleEnvelope(cloneEnvelope({}, payload));
			const acks = cloneAcks(sent);
			expect(acks).toHaveLength(1);
			const ack = ackFields(acks[0]!.payload);
			expect(ack.ok).toBe(false);
			expect(ack.code).toBe("invalid_request");
			expect(uploads).toHaveLength(0);
			expect(flushCalls).toHaveLength(0);
			expect(control.status().admissionClosed).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// download_bulk (P3.4): the clone-download lane — the shared /download jail,
// bounded multi-part streaming under the fleet correlation, and typed
// failures that never carry file contents.
// ---------------------------------------------------------------------------

const DOWNLOAD_PART_BYTES = 4 * 1024 * 1024;

/** One part pulled through the stub bulk channel, in production order. */
interface PartRead {
	correlationId: string;
	part: number;
	bytes: Uint8Array;
}

interface DownloadHarness extends Harness {
	parts: PartRead[];
	/** Resolves once the stub bulk channel finished pulling its parts. */
	pulled: Promise<void>;
	/** Resolves when the lane emits its download_bulk_failed control. */
	failed: Promise<void>;
}

interface DownloadHarnessOptions {
	identity?: { workspaceId: string; generation: number; connectionId: string | null };
	/** Fail the bulk upload immediately with this message (mid-transfer lane). */
	uploadError?: string;
}

/** A jail root plus a sibling directory outside it, torn down by `cleanup`. */
interface DownloadFixture {
	root: string;
	outside: string;
	cleanup: () => Promise<void>;
}

async function tempDownloadFixture(): Promise<DownloadFixture> {
	const base = await mkdtemp(join(tmpdir(), "omp-download-"));
	const root = join(base, "jail");
	const outside = join(base, "outside");
	await mkdir(root);
	await mkdir(outside);
	return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** A harness wired for download_bulk: the REAL jail helpers resolve against
 * `root`, and the stub bulk channel records every part it pulls (mirroring
 * FleetCallback.requestBulkUploadParts' part loop). The lane does real fs
 * I/O, so its async phases are awaited through the promises the lane itself
 * drives — never a wall-clock wait. */
function makeDownloadHarness(root: string, options: DownloadHarnessOptions = {}): DownloadHarness {
	const parts: PartRead[] = [];
	const pulled = Promise.withResolvers<void>();
	const failed = Promise.withResolvers<void>();
	const identity = options.identity ?? {
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
	};
	const downloadBulk: DaemonDownloadBulkDeps = {
		identity: () => identity,
		jailRoots: () => canonicalJailRoots([root]),
		cwd: () => root,
		uploadParts: async ({ correlationId, totalBytes, partSize, readPart }) => {
			try {
				if (options.uploadError !== undefined) throw new Error(options.uploadError);
				const partCount = Math.max(1, Math.ceil(totalBytes / partSize));
				for (let part = 0; part < partCount; part++) {
					const size = Math.min(partSize, totalBytes - part * partSize);
					parts.push({ correlationId, part, bytes: await readPart(part, size) });
				}
			} finally {
				pulled.resolve();
			}
		},
	};
	const harness = makeHarness({ downloadBulk }, [], (_streamId, kind, payload) => {
		if (kind === "control" && typeOf(payload) === "download_bulk_failed") failed.resolve();
	});
	return { ...harness, parts, pulled: pulled.promise, failed: failed.promise };
}

/** A download_bulk envelope. fleet/edge.ts rides it as kind:"command" on the
 * reserved control stream; the acceptance harness as kind:"control" on a
 * browser virtual stream. */
function downloadEnvelope(
	path: string,
	overrides: Partial<CallbackEnvelope> = {},
	payload: Record<string, unknown> = {},
): CallbackEnvelope {
	return {
		version: 1,
		workspaceId: "w1",
		generation: 1,
		connectionId: "conn",
		streamId: "control",
		seq: 0,
		kind: "command",
		payload: { type: "download_bulk", correlationId: "corr-1", path, ...payload },
		at: Date.now(),
		...overrides,
	};
}

const downloadAcks = (sent: Sent[]): Sent[] =>
	sent.filter((s) => s.kind === "ack" && typeOf(s.payload) === "download_bulk");

const downloadFailures = (sent: Sent[]): Sent[] =>
	sent.filter((s) => s.kind === "control" && typeOf(s.payload) === "download_bulk_failed");

interface FailureFields {
	correlationId: string | undefined;
	code: string | undefined;
	message: string | undefined;
}

/** Narrow a download_bulk_failed control payload. */
function failureFields(payload: unknown): FailureFields {
	const failure: FailureFields = { correlationId: undefined, code: undefined, message: undefined };
	if (typeof payload !== "object" || payload === null) return failure;
	if ("correlationId" in payload && typeof payload.correlationId === "string") {
		failure.correlationId = payload.correlationId;
	}
	if ("error" in payload && typeof payload.error === "object" && payload.error !== null) {
		const error = payload.error;
		failure.code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		failure.message =
			"message" in error && typeof error.message === "string" ? error.message : undefined;
	}
	return failure;
}

/** Deterministic file bytes: a slice mix-up is visible on comparison. */
function testBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = i % 251;
	return bytes;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("daemon-control download_bulk (P3.4)", () => {
	test("a valid command streams the file's exact bytes in bounded ordered parts and acks", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const data = testBytes(5 * 1024 * 1024 + 137);
			const file = join(fixture.root, "transcript.jsonl");
			await writeFile(file, data);
			const { control, sent, parts, pulled } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(downloadEnvelope(file));
			await pulled;

			// Bounded reads: a 4 MiB first part (never the whole 5 MiB file) and
			// an exact non-aligned tail.
			expect(parts.map((p) => p.part)).toEqual([0, 1]);
			expect(parts.map((p) => p.bytes.byteLength)).toEqual([
				DOWNLOAD_PART_BYTES,
				1024 * 1024 + 137,
			]);
			expect(parts.every((p) => p.correlationId === "corr-1")).toBe(true);
			expect(sameBytes(parts[0]!.bytes, data.subarray(0, DOWNLOAD_PART_BYTES))).toBe(true);
			expect(sameBytes(parts[1]!.bytes, data.subarray(DOWNLOAD_PART_BYTES))).toBe(true);

			const acks = downloadAcks(sent);
			expect(acks).toHaveLength(1);
			expect(ackFields(acks[0]!.payload).ok).toBe(true);
			expect(downloadFailures(sent)).toHaveLength(0);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a control-kind command on a browser virtual stream (acceptance lane) streams too", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const data = testBytes(2048);
			const file = join(fixture.root, "notes.txt");
			await writeFile(file, data);
			const { control, sent, parts, pulled } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(
				downloadEnvelope(file, { streamId: "browser/acceptance", kind: "control" }),
			);
			await pulled;

			expect(sameBytes(parts[0]!.bytes, data)).toBe(true);
			const acks = downloadAcks(sent);
			expect(acks).toHaveLength(1);
			expect(acks[0]!.streamId).toBe("browser/acceptance");
			expect(ackFields(acks[0]!.payload).ok).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a path outside the jail fails typed, names the path, and transfers nothing", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const outsideFile = join(fixture.outside, "outside.txt");
			await writeFile(outsideFile, "secret-file-contents");
			const { control, sent, parts, failed } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(downloadEnvelope(outsideFile));
			await failed;

			const failures = downloadFailures(sent);
			expect(failures[0]!.streamId).toBe("control");
			const failure = failureFields(failures[0]!.payload);
			expect(failure.correlationId).toBe("corr-1");
			expect(failure.code).toBe("forbidden");
			expect(failure.message).toContain("outside.txt");
			// The reason names the path and never carries file contents.
			expect(failure.message).not.toContain("secret-file-contents");

			const ack = ackFields(downloadAcks(sent)[0]!.payload);
			expect(ack.ok).toBe(false);
			expect(ack.code).toBe("forbidden");
			expect(parts).toHaveLength(0);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a symlink inside the jail that escapes it is refused (canonical check)", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const outsideFile = join(fixture.outside, "outside.txt");
			await writeFile(outsideFile, "secret-file-contents");
			const link = join(fixture.root, "escape.link");
			await symlink(outsideFile, link);
			const { control, sent, parts, failed } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(downloadEnvelope(link));
			await failed;
			expect(failureFields(downloadFailures(sent)[0]!.payload).code).toBe("forbidden");
			expect(parts).toHaveLength(0);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a missing file fails typed and transfers nothing", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const missing = join(fixture.root, "nope.jsonl");
			const { control, sent, parts, failed } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(downloadEnvelope(missing));
			await failed;
			const failure = failureFields(downloadFailures(sent)[0]!.payload);
			expect(failure.code).toBe("invalid_request");
			expect(failure.message).toContain("nope.jsonl");
			expect(ackFields(downloadAcks(sent)[0]!.payload).ok).toBe(false);
			expect(parts).toHaveLength(0);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a file over the 64 MiB bulk cap is refused before any transfer", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const huge = join(fixture.root, "huge.bin");
			await writeFile(huge, new Uint8Array(0));
			await truncate(huge, 64 * 1024 * 1024 + 1);
			const { control, sent, parts, failed } = makeDownloadHarness(fixture.root);

			control.handleEnvelope(downloadEnvelope(huge));
			await failed;
			const failure = failureFields(downloadFailures(sent)[0]!.payload);
			expect(failure.code).toBe("invalid_request");
			expect(failure.message).toContain("bulk cap");
			expect(parts).toHaveLength(0);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a mismatched workspace/generation/connection is refused before any resolution", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const file = join(fixture.root, "transcript.jsonl");
			await writeFile(file, testBytes(64));
			const cases: Array<[Partial<CallbackEnvelope>, string]> = [
				[{ workspaceId: "other" }, "invalid_identity"],
				[{ generation: 9 }, "generation_obsolete"],
				[{ connectionId: "other" }, "invalid_request"],
			];
			for (const [overrides, code] of cases) {
				const { control, sent, parts } = makeDownloadHarness(fixture.root);
				control.handleEnvelope(downloadEnvelope(file, overrides));
				const acks = downloadAcks(sent);
				expect(acks).toHaveLength(1);
				const ack = ackFields(acks[0]!.payload);
				expect(ack.ok).toBe(false);
				expect(ack.code).toBe(code);
				expect(parts).toHaveLength(0);
				// A correlationId named by an unauthenticated envelope is not
				// ours to fail: it is refused, never failed.
				expect(downloadFailures(sent)).toHaveLength(0);
			}
		} finally {
			await fixture.cleanup();
		}
	});

	test("a daemon without the downloadBulk dep answers the typed unsupported error", () => {
		const { control, sent } = makeHarness();
		control.handleEnvelope(downloadEnvelope("/tmp/whatever.jsonl"));
		control.handleEnvelope(
			downloadEnvelope("/tmp/whatever.jsonl", {
				streamId: "browser/x",
				kind: "control",
			}),
		);
		const acks = downloadAcks(sent);
		expect(acks).toHaveLength(2);
		for (const ack of acks) {
			const fields = ackFields(ack.payload);
			expect(fields.ok).toBe(false);
			expect(fields.code).toBe("invalid_request");
			expect(fields.message).toContain("not supported");
		}
		expect(downloadFailures(sent)).toHaveLength(0);
	});

	test("a mid-transfer failure reports download_bulk_failed typed and names the path", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const file = join(fixture.root, "transcript.jsonl");
			await writeFile(file, testBytes(2048));
			const { control, sent, parts, failed } = makeDownloadHarness(fixture.root, {
				uploadError: "bulk channel closed",
			});

			control.handleEnvelope(downloadEnvelope(file));
			await failed;
			const failure = failureFields(downloadFailures(sent)[0]!.payload);
			expect(failure.code).toBe("unavailable");
			expect(failure.message).toContain("transcript.jsonl");
			expect(failure.message).toContain("bulk channel closed");
			expect(parts).toHaveLength(0);
			// The receipt was already accepted; the failure control is what
			// fails the correlation.
			expect(ackFields(downloadAcks(sent)[0]!.payload).ok).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});

	test("a rejected download ack is canonical: nested error only, correlation on the failure control", async () => {
		const fixture = await tempDownloadFixture();
		try {
			const missing = join(fixture.root, "nope.jsonl");
			const { control, sent, failed } = makeDownloadHarness(fixture.root);
			control.handleEnvelope(downloadEnvelope(missing));
			await failed;

			const payload = downloadAcks(sent)[0]!.payload as Record<string, unknown>;
			expect(Object.keys(payload).sort()).toEqual(["error", "ok", "type"]);
			expect(payload).not.toHaveProperty("code");
			expect(payload).not.toHaveProperty("message");
			// The failure control names the request's correlation (what the
			// fleet matches to fail the open capture) and never the file body.
			const failure = failureFields(downloadFailures(sent)[0]!.payload);
			expect(failure.correlationId).toBe("corr-1");
			expect(failure.code).toBe("invalid_request");
		} finally {
			await fixture.cleanup();
		}
	});
});
