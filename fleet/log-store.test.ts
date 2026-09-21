/**
 * FleetLogStore durable-behavior regressions (P3.6/P3.9 callback safety
 * surface): contiguous append and post-reconnect duplicate replay, gap
 * repair without byte loss, daemon-side rewrite forcing resync from zero,
 * reload after crash-partial record/index disagreement, read-only rejection,
 * and orphan retention/manual purge.
 *
 * Everything runs against the REAL FleetLogStore over real disk files in a
 * per-suite tempDir (shared/testkit tempDir/cleanupTempDirs, top-level
 * afterAll registered here): every "reload" is a fresh FleetLogStore.load()
 * over the same rootDir: never a mock fs and never a reused in-memory
 * instance. Assertions are observable contract only: durable bytes returned
 * by readStored/storedLineage, ack offsets on ingest results, repair kinds
 * and offsets on the load report, typed LogStoreError codes for refusals,
 * and retention/removal of files on disk. The store's internal framing,
 * message vocabulary, and private maps are never pinned.
 *
 * Fixture payloads are raw JSONL lines with byte-varying padding so that any
 * duplication, truncation, or offset splice would break the byte-equality
 * and offset-continuity invariants below.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	readdirSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FleetLogStore, LogStoreError, type LogChunk, type LogStoreErrorCode } from "./log-store";
import { cleanupTempDirs, tempDir } from "../shared/testkit";

afterAll(cleanupTempDirs);

const WORKSPACE = "ws-logdurable";
const SESSION = "sess-1";
/** Main transcript relpath: `<sessionId>.jsonl` at depth 1. */
const MAIN_RELPATH = "sess-1.jsonl";
/** Subagent transcript relpath nested under the main stem dir. */
const SUBAGENT_RELPATH = "sess-1/sub-1.jsonl";

/**
 * One JSONL record line with length varying by `n` (padding), always
 * newline-terminated so every record is a complete line.
 */
function recordLine(kind: string, n: number): string {
	const pad = "p".repeat((n % 6) * 5);
	return JSON.stringify({ type: "message", id: `${kind}-${n}`, seq: n, pad }) + "\n";
}

/** Chunk wrapping exact raw bytes at `offset` under `generation`. */
function chunkAt(offset: number, generation: number, content: string, eof = false): LogChunk {
	const bytes = Buffer.from(content, "utf8");
	return { offset, generation, data: bytes.toString("base64"), eof };
}

function expectBuffersEqual(actual: Buffer | null, expected: Buffer): void {
	expect(actual).not.toBeNull();
	if (actual === null) throw new Error("expected stored bytes");
	expect(actual.equals(expected)).toBe(true);
}

/** Absolute path of a stored stream file. */
function storedFile(rootDir: string, relpath: string): string {
	return join(rootDir, WORKSPACE, SESSION, relpath);
}

/** ingest() that asserts an ack and returns the durable offset. */
function ingestAcked(store: FleetLogStore, relpath: string, chunk: LogChunk): number {
	const result = store.ingest(WORKSPACE, SESSION, relpath, chunk);
	expect(result.status).toBe("acked");
	if (result.status !== "acked") throw new Error("unreachable");
	return result.offset;
}

/** Expect a typed store refusal and return its code. */
function expectLogStoreError(fn: () => unknown, code: LogStoreErrorCode): void {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LogStoreError);
	if (!(caught instanceof LogStoreError)) throw new Error("unreachable");
	expect(caught.code).toBe(code);
}

describe("FleetLogStore contiguous append and duplicate replay", () => {
	test("contiguous appends ack monotonic durable offsets; reload replays raw bytes exactly", () => {
		const rootDir = tempDir("omp-logstore-append-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const l3 = recordLine("main", 3);
		const expected = Buffer.from(l1 + l2 + l3, "utf8");

		// Fresh empty store; ack offsets must equal cumulative durable bytes.
		const store = new FleetLogStore({ rootDir });
		const o1 = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		expect(o1).toBe(l1.length);
		const o2 = ingestAcked(store, MAIN_RELPATH, chunkAt(o1, 1, l2));
		expect(o2).toBe(l1.length + l2.length);
		const o3 = ingestAcked(store, MAIN_RELPATH, chunkAt(o2, 1, l3));
		expect(o3).toBe(expected.length);

		// Mid-stream durability on the live instance.
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, MAIN_RELPATH), expected);

		// True reload: fresh process state rebuilt from index.json + files.
		const reloaded = FleetLogStore.load(rootDir);
		expect(reloaded.loadReport.repairs).toEqual([]);
		expect(reloaded.loadReport.sessions).toBe(1);
		expectBuffersEqual(reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH), expected);

		// A consumer resuming at the last acked offset continues contiguously.
		const l4 = recordLine("main", 4);
		const o4 = ingestAcked(reloaded, MAIN_RELPATH, chunkAt(o3, 1, l4));
		expect(o4).toBe(expected.length + l4.length);
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3 + l4, "utf8"),
		);
	});

	test("post-reconnect duplicate resends below the acked offset are dropped without touching durable bytes", () => {
		const rootDir = tempDir("omp-logstore-dup-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const store = new FleetLogStore({ rootDir });
		const o1 = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		const o2 = ingestAcked(store, MAIN_RELPATH, chunkAt(o1, 1, l2));
		expect(o2).toBe(l1.length + l2.length);

		// Full resend of an already-durable chunk (ack lost on the wire):
		// dropped as duplicate, bytes and ack state unchanged.
		const replay = store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, chunkAt(0, 1, l1));
		expect(replay).toEqual({ status: "duplicate" });
		expectBuffersEqual(
			store.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);

		// Reload: the duplicate left no trace, and the durable prefix is whole.
		const reloaded = FleetLogStore.load(rootDir);
		expect(reloaded.loadReport.repairs).toEqual([]);
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);

		// A resend that starts below the acked offset but extends past it (the
		// daemon's file is ahead of its last ack) appends ONLY the missing
		// suffix: the already-durable prefix must never be written twice.
		const l3 = recordLine("main", 3);
		const heal = store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, chunkAt(0, 1, l1 + l2 + l3));
		expect(heal).toEqual({ status: "acked", offset: l1.length + l2.length + l3.length });
		expectBuffersEqual(
			store.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3, "utf8"),
		);
		expectBuffersEqual(
			FleetLogStore.load(rootDir).readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3, "utf8"),
		);
	});
});

describe("FleetLogStore gap repair without byte loss", () => {
	test("out-of-order chunk yields a gap result with from/to; repair re-streams contiguously with no loss or duplication", () => {
		const rootDir = tempDir("omp-logstore-gap-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const l3 = recordLine("main", 3);
		const store = new FleetLogStore({ rootDir });
		const o1 = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		const o2 = ingestAcked(store, MAIN_RELPATH, chunkAt(o1, 1, l2));

		// A chunk whose offset leaps past the durable end must NOT be accepted
		// (no unsafe forward-fill): the wire maps this onto log_gap from/to.
		const outOfOrder = recordLine("main", 9);
		const skipped = store.ingest(
			WORKSPACE,
			SESSION,
			MAIN_RELPATH,
			chunkAt(o2 + 100, 1, outOfOrder),
		);
		expect(skipped).toEqual({ status: "gap", from: o2, to: o2 + 100 });

		// Nothing was written and the ack state did not move.
		expectBuffersEqual(
			store.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);
		const afterGap = FleetLogStore.load(rootDir);
		expect(afterGap.loadReport.repairs).toEqual([]);
		expectBuffersEqual(
			afterGap.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);

		// The repair: the daemon re-streams from the acked offset (log_gap
		// repair). Every byte of the intended stream must be present exactly
		// once afterward, across a reload too.
		const o3 = ingestAcked(afterGap, MAIN_RELPATH, chunkAt(o2, 1, l3));
		expect(o3).toBe(o2 + l3.length);
		const expected = Buffer.from(l1 + l2 + l3, "utf8");
		expectBuffersEqual(afterGap.readStored(WORKSPACE, SESSION, MAIN_RELPATH), expected);
		expectBuffersEqual(
			FleetLogStore.load(rootDir).readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			expected,
		);
	});
});

describe("FleetLogStore rewrite resync from zero", () => {
	test("higher-generation chunk truncates the stored bytes and resyncs from 0; older generations become obsolete", () => {
		const rootDir = tempDir("omp-logstore-rewrite-");
		const gen1a = recordLine("old", 1);
		const gen1b = recordLine("old", 2);
		const store = new FleetLogStore({ rootDir });
		const oldEnd = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, gen1a));
		ingestAcked(store, MAIN_RELPATH, chunkAt(oldEnd, 1, gen1b));

		// Daemon-side atomic rewrite: new file identity arrives at generation 2
		// starting at offset 0. The stored gen-1 bytes must be truncated: a
		// resync from zero, never a mixed old+new file.
		const r1 = recordLine("rewritten", 1);
		const r1End = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 2, r1));
		expect(r1End).toBe(r1.length);
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, MAIN_RELPATH), Buffer.from(r1, "utf8"));

		// Stale gen-1 resends (a pre-rewrite consumer still streaming the old
		// identity) are dropped as obsolete and never resurrect old bytes.
		const stale = store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, chunkAt(0, 1, gen1a));
		expect(stale).toEqual({ status: "obsolete" });
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, MAIN_RELPATH), Buffer.from(r1, "utf8"));

		// Continuation of the new generation appends cleanly (acked offset was
		// truly reset to the new identity's length, not the old 100-byte tail).
		const r2 = recordLine("rewritten", 2);
		const r2End = ingestAcked(store, MAIN_RELPATH, chunkAt(r1End, 2, r2));
		expect(r2End).toBe(r1.length + r2.length);
		const expected = Buffer.from(r1 + r2, "utf8");
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, MAIN_RELPATH), expected);

		// The resync is durable: reload sees only the new generation's bytes.
		const reloaded = FleetLogStore.load(rootDir);
		expect(reloaded.loadReport.repairs).toEqual([]);
		expectBuffersEqual(reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH), expected);
	});
});

describe("FleetLogStore raw main/subagent bytes and lineage identity", () => {
	test("main and subagent streams survive reload byte-identical with stable lineage kinds", () => {
		const rootDir = tempDir("omp-logstore-lineage-");
		const main = Buffer.from(
			recordLine("main", 1) + recordLine("main", 2) + recordLine("main", 3),
			"utf8",
		);
		const sub = Buffer.from(recordLine("sub", 1) + recordLine("sub", 2), "utf8");

		const store = new FleetLogStore({ rootDir });
		const m1 = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, main.toString("utf8")));
		const s1 = ingestAcked(store, SUBAGENT_RELPATH, chunkAt(0, 1, sub.toString("utf8"), true));
		expect(m1).toBe(main.length);
		expect(s1).toBe(sub.length);

		// Raw bytes preserved on the live instance…
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, MAIN_RELPATH), main);
		expectBuffersEqual(store.readStored(WORKSPACE, SESSION, SUBAGENT_RELPATH), sub);

		// …and after a true reload, with lineage identity (main vs subagent,
		// parent linkage) and durable/indexed byte counts intact.
		const reloaded = FleetLogStore.load(rootDir);
		expect(reloaded.loadReport.repairs).toEqual([]);
		expectBuffersEqual(reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH), main);
		expectBuffersEqual(reloaded.readStored(WORKSPACE, SESSION, SUBAGENT_RELPATH), sub);

		const lineage = reloaded.storedLineage(WORKSPACE, SESSION);
		expect(lineage).not.toBeNull();
		if (lineage === null) throw new Error("unreachable");
		expect(lineage.missingAssets).toBe(0);
		expect(lineage.bytes).toBe(main.length + sub.length);
		expect(lineage.ackedBytes).toBe(main.length + sub.length);
		expect(lineage.mainRelpath).toBe(MAIN_RELPATH);
		const mainFile = lineage.files.find((f) => f.relpath === MAIN_RELPATH);
		const subFile = lineage.files.find((f) => f.relpath === SUBAGENT_RELPATH);
		expect(mainFile).toMatchObject({
			kind: "main",
			status: "stored",
			bytes: main.length,
			ackedBytes: main.length,
		});
		expect(subFile).toMatchObject({
			kind: "subagent",
			status: "stored",
			parentPath: MAIN_RELPATH,
			bytes: sub.length,
			ackedBytes: sub.length,
			eof: true,
		});
	});
});

describe("FleetLogStore reload after crash-partial disagreement", () => {
	test("torn trailing record is cut back to the last complete line; complete bytes never lost", () => {
		const rootDir = tempDir("omp-logstore-torn-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const l3 = recordLine("main", 3);
		const l4 = recordLine("main", 4);
		const store = new FleetLogStore({ rootDir });
		const o1 = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		const o2 = ingestAcked(store, MAIN_RELPATH, chunkAt(o1, 1, l2));

		// Crash after the daemon fsynced a complete l3 record but before the
		// index rename, with a torn partial l4 write on top: the file is longer
		// than the index and ends without a newline.
		const l4Partial = '{"type":"message","id":"main-4","seq":4,"pad":"' + "y".repeat(37); // no newline
		const file = storedFile(rootDir, MAIN_RELPATH);
		appendFileSync(file, l3 + l4Partial);

		const reloaded = FleetLogStore.load(rootDir);
		// The complete l3 record was adopted forward (no valid byte lost) and
		// the torn l4 tail cut back to the last complete line.
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3, "utf8"),
		);
		const repair = reloaded.loadReport.repairs.find(
			(r) => r.kind === "truncated_partial_tail" && r.relpath === MAIN_RELPATH,
		);
		expect(repair).toMatchObject({ from: o2, to: o2 + l3.length });
		const after = FleetLogStore.load(rootDir);
		expect(after.loadReport.repairs).toEqual([]);

		// The daemon re-streams the dropped l4 from the healed acked offset:
		// appends cleanly, nothing duplicated, nothing valid lost.
		const healed = o2 + l3.length;
		const o4 = ingestAcked(after, MAIN_RELPATH, chunkAt(healed, 1, l4));
		expect(o4).toBe(healed + l4.length);
		expectBuffersEqual(
			after.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3 + l4, "utf8"),
		);
	});

	test("index ahead of the file: ack drops to the durable prefix, resend restores the tail", () => {
		const rootDir = tempDir("omp-logstore-short-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const l3 = recordLine("main", 3);
		const store = new FleetLogStore({ rootDir });
		const end = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		ingestAcked(store, MAIN_RELPATH, chunkAt(end, 1, l2));
		ingestAcked(store, MAIN_RELPATH, chunkAt(end + l2.length, 1, l3));
		const acked = end + l2.length + l3.length;

		// Simulated crash state: the sidecar index recorded an ack beyond the
		// bytes that survived on disk (file truncated after the index rename).
		const durable = l1.length + l2.length;
		truncateSync(storedFile(rootDir, MAIN_RELPATH), durable);

		const reloaded = FleetLogStore.load(rootDir);
		// No unsafe acceptance: the acked offset must never exceed durable bytes.
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);
		const repair = reloaded.loadReport.repairs.find(
			(r) => r.kind === "file_shorter_than_index" && r.relpath === MAIN_RELPATH,
		);
		expect(repair).toMatchObject({ from: acked, to: durable });

		// The daemon re-streams the missing tail from the healed offset: full
		// byte restoration, no duplication of the surviving prefix.
		const restored = ingestAcked(reloaded, MAIN_RELPATH, chunkAt(durable, 1, l3));
		expect(restored).toBe(acked);
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3, "utf8"),
		);
	});

	test("crash between append fsync and index rename: the unindexed file is adopted once, idempotently", () => {
		const rootDir = tempDir("omp-logstore-adopt-");
		const l1 = recordLine("main", 1);
		const store = new FleetLogStore({ rootDir });
		ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));

		// A second stream's bytes hit disk (complete, newline-terminated lines)
		// but the index rename never happened: no index entry for the relpath.
		const blob = Buffer.from("blob-line-1\nblob-line-2\n", "utf8");
		const orphanFile = storedFile(rootDir, "extra-blob.bin");
		writeFileSync(orphanFile, blob);

		const reloaded = FleetLogStore.load(rootDir);
		expectBuffersEqual(reloaded.readStored(WORKSPACE, SESSION, "extra-blob.bin"), blob);
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1, "utf8"),
		);
		const adoption = reloaded.loadReport.repairs.find(
			(r) => r.kind === "adopted_unindexed_file" && r.relpath === "extra-blob.bin",
		);
		expect(adoption).toMatchObject({ from: blob.length, to: blob.length });

		// The adoption was persisted: a second reload sees a consistent index
		// and must not re-adopt (no duplicate/offset inflation on restart).
		const again = FleetLogStore.load(rootDir);
		expect(again.loadReport.repairs).toEqual([]);
		expectBuffersEqual(again.readStored(WORKSPACE, SESSION, "extra-blob.bin"), blob);
	});

	test("missing index.json is rebuilt from files without byte loss", () => {
		const rootDir = tempDir("omp-logstore-noindex-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const store = new FleetLogStore({ rootDir });
		const end = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		ingestAcked(store, MAIN_RELPATH, chunkAt(end, 1, l2));

		// Crash between the data fsync and the first index write: the stream
		// file is durable but index.json never existed.
		unlinkSync(join(rootDir, WORKSPACE, SESSION, "index.json"));

		const reloaded = FleetLogStore.load(rootDir);
		expectBuffersEqual(
			reloaded.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);
		expect(reloaded.loadReport.repairs.some((r) => r.kind === "rebuilt_missing_index")).toBe(true);

		// State rebuilt from the durable file: an ack-precise continuation
		// lands contiguously (no gap, no duplicate)…
		const l3 = recordLine("main", 3);
		const o3 = ingestAcked(reloaded, MAIN_RELPATH, chunkAt(l1.length + l2.length, 1, l3));
		expect(o3).toBe(l1.length + l2.length + l3.length);
		expectBuffersEqual(
			FleetLogStore.load(rootDir).readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2 + l3, "utf8"),
		);
	});
});

describe("FleetLogStore read-only rejection and retention", () => {
	test("verified read-only workspace refuses ingest and session purge durably across reload; purgeWorkspace is the manual path", () => {
		const rootDir = tempDir("omp-logstore-readonly-");
		const l1 = recordLine("main", 1);
		const l2 = recordLine("main", 2);
		const store = new FleetLogStore({ rootDir });
		const end = ingestAcked(store, MAIN_RELPATH, chunkAt(0, 1, l1));
		ingestAcked(store, MAIN_RELPATH, chunkAt(end, 1, l2));

		store.markWorkspaceReadOnly(WORKSPACE);
		expect(store.isReadOnly(WORKSPACE)).toBe(true);

		// All mutation paths are refused with the typed read_only code; the
		// durable bytes stay untouched and readable.
		expectLogStoreError(
			() =>
				store.ingest(
					WORKSPACE,
					SESSION,
					MAIN_RELPATH,
					chunkAt(l1.length + l2.length, 1, recordLine("main", 3)),
				),
			"read_only",
		);
		expectLogStoreError(() => store.purgeSession(WORKSPACE, SESSION), "read_only");
		expectBuffersEqual(
			store.readStored(WORKSPACE, SESSION, MAIN_RELPATH),
			Buffer.from(l1 + l2, "utf8"),
		);

		// The flip is durable (readonly.json marker): a reloaded store still
		// refuses mutations.
		const reloaded = FleetLogStore.load(rootDir);
		expect(reloaded.isReadOnly(WORKSPACE)).toBe(true);
		expectLogStoreError(
			() =>
				reloaded.ingest(
					WORKSPACE,
					SESSION,
					MAIN_RELPATH,
					chunkAt(l1.length + l2.length, 1, recordLine("main", 3)),
				),
			"read_only",
		);

		// purgeWorkspace is the explicit manual path and works on read-only
		// workspaces; afterwards nothing is stored and the marker is gone.
		expect(reloaded.purgeWorkspace(WORKSPACE)).toEqual({ sessions: 1 });
		expect(reloaded.listStoredWorkspaces()).toEqual([]);
		const fresh = FleetLogStore.load(rootDir);
		expect(fresh.isReadOnly(WORKSPACE)).toBe(false);
		expect(fresh.listStoredWorkspaces()).toEqual([]);
	});

	test("orphaned workspaces are retained with readable bytes until explicit manual purge", () => {
		const rootDir = tempDir("omp-logstore-orphan-");
		const liveWs = "ws-live";
		const goneWs = "ws-gone";
		const verifiedWs = "ws-verified";

		// Seed three workspaces through the real store: live, orphaned
		// (unverified), and orphaned-but-verified (read-only flip).
		const seed = (ws: string, content: string): void => {
			const store = new FleetLogStore({ rootDir });
			store.ingest(ws, "s1", "s1.jsonl", chunkAt(0, 1, content));
		};
		const liveBytes = recordLine("live", 1) + recordLine("live", 2);
		const goneBytes = recordLine("gone", 1);
		const verifiedBytes = recordLine("verified", 1);
		seed(liveWs, liveBytes);
		seed(goneWs, goneBytes);
		seed(verifiedWs, verifiedBytes);
		// Verification flip for the third workspace.
		new FleetLogStore({ rootDir }).markWorkspaceReadOnly(verifiedWs);

		const store = FleetLogStore.load(rootDir);
		const orphans = store.listOrphans([liveWs]);
		expect(orphans.map((o) => o.workspaceId)).toEqual([goneWs, verifiedWs].sort());
		const gone = orphans.find((o) => o.workspaceId === goneWs);
		const verified = orphans.find((o) => o.workspaceId === verifiedWs);
		expect(gone).toMatchObject({ sessions: ["s1"], readOnly: false });
		expect(verified).toMatchObject({ sessions: ["s1"], readOnly: true });

		// Retention: neither orphan was deleted or rewritten; the raw bytes
		// are still readable from disk, and the live workspace is untouched.
		expectBuffersEqual(store.readStored(goneWs, "s1", "s1.jsonl"), Buffer.from(goneBytes, "utf8"));
		expectBuffersEqual(
			store.readStored(verifiedWs, "s1", "s1.jsonl"),
			Buffer.from(verifiedBytes, "utf8"),
		);
		expectBuffersEqual(store.readStored(liveWs, "s1", "s1.jsonl"), Buffer.from(liveBytes, "utf8"));
		expect(orphans.some((o) => o.workspaceId === liveWs)).toBe(false);

		// Explicit manual purge of the verified orphan (the ONLY removal path
		// for verified data) and of the plain orphan.
		expect(store.purgeWorkspace(goneWs)).toEqual({ sessions: 1 });
		expect(store.purgeWorkspace(verifiedWs)).toEqual({ sessions: 1 });
		expect(store.listOrphans([liveWs])).toEqual([]);
		expect(existsSync(join(rootDir, goneWs))).toBe(false);
		expect(existsSync(join(rootDir, verifiedWs))).toBe(false);

		// Non-read-only purgeSession still removes a single live session.
		expect(store.purgeSession(liveWs, "s1")).toBe(true);
		expect(store.storedLineage(liveWs, "s1")).toBeNull();
		expect(store.listStoredWorkspaces()).toEqual([]);
	});
});

describe("FleetLogStore unsafe acceptance refusals", () => {
	test("traversal, reserved, and malformed inputs are rejected before anything is written", () => {
		const rootDir = tempDir("omp-logstore-refuse-");
		const store = new FleetLogStore({ rootDir });

		expectLogStoreError(
			() =>
				store.ingest(
					WORKSPACE,
					SESSION,
					"sess-1/../escape.jsonl",
					chunkAt(0, 1, recordLine("x", 1)),
				),
			"invalid_path",
		);
		expectLogStoreError(
			() => store.ingest(WORKSPACE, SESSION, "index.json", chunkAt(0, 1, recordLine("x", 1))),
			"invalid_path",
		);
		expectLogStoreError(
			() => store.ingest(WORKSPACE, SESSION, "sess-1.jsonl.tmp", chunkAt(0, 1, recordLine("x", 1))),
			"invalid_path",
		);
		expectLogStoreError(
			() => store.ingest(WORKSPACE, SESSION, "..", chunkAt(0, 1, recordLine("x", 1))),
			"invalid_path",
		);
		expectLogStoreError(
			() => store.ingest("ws/evil", SESSION, MAIN_RELPATH, chunkAt(0, 1, recordLine("x", 1))),
			"invalid_id",
		);
		expectLogStoreError(
			() =>
				store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, {
					offset: -1,
					generation: 1,
					data: Buffer.from(recordLine("x", 1), "utf8").toString("base64"),
					eof: false,
				}),
			"invalid_chunk",
		);
		expectLogStoreError(
			() =>
				store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, {
					offset: 0,
					generation: 0,
					data: Buffer.from(recordLine("x", 1), "utf8").toString("base64"),
					eof: false,
				}),
			"invalid_chunk",
		);
		expectLogStoreError(
			() =>
				store.ingest(WORKSPACE, SESSION, MAIN_RELPATH, {
					offset: 0,
					generation: 1,
					data: "!!!not-base64!!!",
					eof: false,
				}),
			"invalid_chunk",
		);

		// Nothing was persisted by any refused call: no workspace/session
		// subtree appeared under the store root.
		const leftovers = existsSync(rootDir) ? readdirSync(rootDir) : [];
		expect(leftovers).toEqual([]);
		expect(store.storedLineage(WORKSPACE, SESSION)).toBeNull();
		expect(store.listStoredWorkspaces()).toEqual([]);
	});
});
