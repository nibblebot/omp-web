/**
 * Direct coverage for the wake materialization wire contract
 * (lib/session-files/wake-materialize.ts): the record parser/encoder shared
 * by the fleet's bulk response and the daemon's callback reader, the
 * fleet-side store walk that declares a session subtree, and the
 * transfer emitter that splits it across correlations.
 *
 * Fixtures mirror the store layout the two halves agree on
 * (`logs/<workspaceId>/<sessionId>/<relpath>`); assertions pin the frozen
 * wire shapes, the typed error codes (`invalid_request` for malformed
 * records, `unavailable` for read failures) and byte identity, never error
 * wording.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	MATERIALIZE_CHUNK_RAW_BYTES,
	MATERIALIZE_TRANSFER_MAX_BYTES,
	emitMaterializeTransfer,
	encodeMaterializeRecord,
	parseMaterializeRecord,
	planMaterializeFiles,
	type MaterializeCursor,
	type MaterializeFilePlan,
	type MaterializeRecord,
} from "#lib/session-files/wake-materialize";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { CallbackError } from "#lib/wire/callback-protocol";

afterAll(cleanupTempDirs);

const SHA_A = "a".repeat(64);
const WORKSPACE_ID = "ws-1";
const SESSION_ID = "20260906T1200_sess";

/** Write every `relpath` → content pair under `root`, creating parents. */
function writeTree(root: string, files: Record<string, string | Buffer>): void {
	for (const [relpath, content] of Object.entries(files)) {
		const absolute = join(root, relpath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
}

/** Fresh store subtree `logs/<workspaceId>/<sessionId>/` holding `files`. */
function storeSubtree(
	workspaceId: string,
	sessionId: string,
	files: Record<string, string | Buffer>,
): string {
	const root = join(tempDir("wake-store-"), "logs", workspaceId, sessionId);
	mkdirSync(root, { recursive: true });
	writeTree(root, files);
	return root;
}

/** Run `fn`, require a typed {@link CallbackError}, and return it for code assertions. */
function protocolFailure(fn: () => unknown): CallbackError {
	try {
		fn();
	} catch (error) {
		if (error instanceof CallbackError) return error;
		throw error;
	}
	throw new Error("expected a CallbackError, but the call succeeded");
}

/** Records of one kind, narrowed (the parser's union is discriminated by `type`). */
function recordsOfType<T extends MaterializeRecord["type"]>(
	records: MaterializeRecord[],
	type: T,
): Array<Extract<MaterializeRecord, { type: T }>> {
	return records.filter((record): record is Extract<MaterializeRecord, { type: T }> => {
		return record.type === type;
	});
}

/** Emit one transfer and parse every NDJSON line back into records. */
function emitTransfer(
	plan: MaterializeFilePlan,
	sessionId: string,
	cursor?: MaterializeCursor,
	maxBytes?: number,
	workspaceId?: string,
): { lines: string[]; records: MaterializeRecord[] } {
	const lines = emitMaterializeTransfer(plan, sessionId, cursor, maxBytes, workspaceId);
	return { lines, records: lines.map((line) => parseMaterializeRecord(JSON.parse(line))) };
}

/** sha256 of the full file bytes, the digest every file declaration carries. */
function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("parseMaterializeRecord / encodeMaterializeRecord", () => {
	test("round-trips every record kind through the NDJSON encoder", () => {
		const records: MaterializeRecord[] = [
			{ type: "session", workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
			{
				type: "file",
				relpath: "proj/20260906T1200_sess.jsonl",
				size: 128,
				sha256: SHA_A,
				kind: "main",
				offset: 0,
			},
			{
				type: "chunk",
				relpath: "proj/20260906T1200_sess.jsonl",
				offset: 96,
				data: Buffer.from("tail bytes").toString("base64"),
			},
			{ type: "end", more: false },
			{ type: "end", more: true, cursor: { path: "proj/20260906T1200_sess.jsonl", offset: 128 } },
		];
		for (const record of records) {
			const line = encodeMaterializeRecord(record);
			// Exactly one complete NDJSON line per record.
			expect(line.endsWith("\n")).toBe(true);
			expect(line.split("\n")).toHaveLength(2);
			expect(JSON.parse(line)).toEqual(record);
			expect(parseMaterializeRecord(JSON.parse(line))).toEqual(record);
		}
	});

	test("refuses non-object records and unknown record types", () => {
		for (const value of [null, undefined, [], "session", 7, true, {}, { type: "nope" }])
			expect(protocolFailure(() => parseMaterializeRecord(value)).code).toBe("invalid_request");
	});

	test("requires two string fields on the session record and drops unknown fields", () => {
		for (const value of [
			{},
			{ type: "session" },
			{ type: "session", workspaceId: WORKSPACE_ID },
			{ type: "session", workspaceId: 7, sessionId: SESSION_ID },
			{ type: "session", workspaceId: WORKSPACE_ID, sessionId: null },
		])
			expect(protocolFailure(() => parseMaterializeRecord(value)).code).toBe("invalid_request");

		expect(
			parseMaterializeRecord({
				type: "session",
				workspaceId: WORKSPACE_ID,
				sessionId: SESSION_ID,
				generation: 9,
			}),
		).toEqual({ type: "session", workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
	});

	test("refuses a file record with a hostile or non-normalized relpath", () => {
		const base = {
			type: "file",
			size: 8,
			sha256: SHA_A,
			kind: "main",
			offset: 0,
		};
		for (const relpath of [
			"",
			"/abs.jsonl",
			"../escape.jsonl",
			"a/../b.jsonl",
			"a//b.jsonl",
			"a/./b.jsonl",
			"a\\b.jsonl",
			"proj/sess.jsonl/",
		]) {
			const error = protocolFailure(() => parseMaterializeRecord({ ...base, relpath }));
			expect({ relpath, code: error.code }).toEqual({ relpath, code: "invalid_request" });
		}
	});

	test("refuses a file record with a bad size, sha256, offset or kind", () => {
		const base = { type: "file", relpath: "proj/sess.jsonl", kind: "main" };
		const corruptions: Array<[string, unknown]> = [
			["size missing", { ...base, sha256: SHA_A, offset: 0 }],
			["size negative", { ...base, size: -1, sha256: SHA_A, offset: 0 }],
			["size fractional", { ...base, size: 1.5, sha256: SHA_A, offset: 0 }],
			["size unsafe", { ...base, size: 2 ** 53, sha256: SHA_A, offset: 0 }],
			["size a string", { ...base, size: "8", sha256: SHA_A, offset: 0 }],
			["sha256 missing", { ...base, size: 8, offset: 0 }],
			["sha256 uppercase", { ...base, size: 8, sha256: SHA_A.toUpperCase(), offset: 0 }],
			["sha256 short", { ...base, size: 8, sha256: "a".repeat(63), offset: 0 }],
			["sha256 non-hex", { ...base, size: 8, sha256: "g".repeat(64), offset: 0 }],
			["offset missing", { ...base, size: 8, sha256: SHA_A }],
			["offset negative", { ...base, size: 8, sha256: SHA_A, offset: -1 }],
			["offset fractional", { ...base, size: 8, sha256: SHA_A, offset: 0.5 }],
			["kind missing", { type: "file", relpath: base.relpath, size: 8, sha256: SHA_A, offset: 0 }],
			["kind unknown", { ...base, size: 8, sha256: SHA_A, offset: 0, kind: "transcript" }],
		];
		for (const [label, value] of corruptions) {
			const error = protocolFailure(() => parseMaterializeRecord(value));
			expect({ label, code: error.code }).toEqual({ label, code: "invalid_request" });
		}

		expect(
			parseMaterializeRecord({
				type: "file",
				relpath: "proj/sess.jsonl",
				size: 8,
				sha256: SHA_A,
				kind: "advisor",
				offset: 4,
			}),
		).toEqual({
			type: "file",
			relpath: "proj/sess.jsonl",
			size: 8,
			sha256: SHA_A,
			kind: "advisor",
			offset: 4,
		});
	});

	test("refuses a chunk record with a hostile relpath, bad offset or non-string data", () => {
		const base = { type: "chunk", relpath: "proj/sess.jsonl", offset: 0, data: "" };
		const corruptions: Array<[string, unknown]> = [
			["relpath absolute", { ...base, relpath: "/abs.jsonl" }],
			["relpath traversal", { ...base, relpath: "../escape.jsonl" }],
			["relpath empty", { ...base, relpath: "" }],
			["offset missing", { type: "chunk", relpath: base.relpath, data: "" }],
			["offset negative", { ...base, offset: -1 }],
			["offset fractional", { ...base, offset: 1.5 }],
			["offset unsafe", { ...base, offset: 2 ** 53 }],
			["data missing", { type: "chunk", relpath: base.relpath, offset: 0 }],
			["data not a string", { ...base, data: 42 }],
		];
		for (const [label, value] of corruptions) {
			const error = protocolFailure(() => parseMaterializeRecord(value));
			expect({ label, code: error.code }).toEqual({ label, code: "invalid_request" });
		}

		const payload = Buffer.from("chunk bytes").toString("base64");
		expect(
			parseMaterializeRecord({
				type: "chunk",
				relpath: "proj/sess.jsonl",
				offset: 512,
				data: payload,
				trailing: true,
			}),
		).toEqual({ type: "chunk", relpath: "proj/sess.jsonl", offset: 512, data: payload });
	});

	test("refuses an end record with a bad flag, a malformed cursor or no continuation", () => {
		const corruptions: Array<[string, unknown]> = [
			["more missing", { type: "end" }],
			["more a string", { type: "end", more: "yes" }],
			["more a number", { type: "end", more: 1 }],
			["more=true without a cursor", { type: "end", more: true }],
			["cursor null", { type: "end", more: true, cursor: null }],
			["cursor a string", { type: "end", more: true, cursor: "sess.jsonl" }],
			["cursor an array", { type: "end", more: true, cursor: ["sess.jsonl", 0] }],
			["cursor path unsafe", { type: "end", more: true, cursor: { path: "../x", offset: 0 } }],
			["cursor path missing", { type: "end", more: true, cursor: { offset: 0 } }],
			["cursor offset missing", { type: "end", more: true, cursor: { path: "x" } }],
			["cursor offset negative", { type: "end", more: true, cursor: { path: "x", offset: -1 } }],
			["cursor offset fractional", { type: "end", more: true, cursor: { path: "x", offset: 0.5 } }],
		];
		for (const [label, value] of corruptions) {
			const error = protocolFailure(() => parseMaterializeRecord(value));
			expect({ label, code: error.code }).toEqual({ label, code: "invalid_request" });
		}

		expect(parseMaterializeRecord({ type: "end", more: false })).toEqual({
			type: "end",
			more: false,
		});
		const cursor = { path: "proj/sess.jsonl", offset: 8 };
		expect(parseMaterializeRecord({ type: "end", more: true, cursor })).toEqual({
			type: "end",
			more: true,
			cursor,
		});
	});
});

describe("planMaterializeFiles", () => {
	test("returns the sorted, classified file set of one session subtree", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, {
			[`${SESSION_ID}.jsonl`]: "main\n",
			"notes.txt": "notes\n",
			[`${SESSION_ID}/sub1.jsonl`]: "sub\n",
			[`${SESSION_ID}/sub1/deep.jsonl`]: "deep\n",
			[`${SESSION_ID}/__advisor.jsonl`]: "advisor\n",
			[`${SESSION_ID}/__advisor.2.jsonl`]: "advisor two\n",
			[`${SESSION_ID}/notes.md`]: "artifact notes\n",
		});
		const contents: Record<string, string> = {
			[`${SESSION_ID}.jsonl`]: "main\n",
			"notes.txt": "notes\n",
			[`${SESSION_ID}/sub1.jsonl`]: "sub\n",
			[`${SESSION_ID}/sub1/deep.jsonl`]: "deep\n",
			[`${SESSION_ID}/__advisor.jsonl`]: "advisor\n",
			[`${SESSION_ID}/__advisor.2.jsonl`]: "advisor two\n",
			[`${SESSION_ID}/notes.md`]: "artifact notes\n",
		};

		const plan = planMaterializeFiles(root);
		expect(plan.rootDir).toBe(root);
		expect(plan.files.map((file) => [file.relpath, file.kind])).toEqual([
			[`${SESSION_ID}.jsonl`, "main"],
			[`${SESSION_ID}/__advisor.2.jsonl`, "advisor"],
			[`${SESSION_ID}/__advisor.jsonl`, "advisor"],
			[`${SESSION_ID}/notes.md`, "metadata"],
			[`${SESSION_ID}/sub1.jsonl`, "subagent"],
			[`${SESSION_ID}/sub1/deep.jsonl`, "subagent"],
			["notes.txt", "metadata"],
		]);
		expect(plan.files.map((file) => file.relpath)).toEqual(
			[...plan.files.map((file) => file.relpath)].sort(),
		);
		for (const file of plan.files) {
			expect(file.absolutePath.startsWith(`${root}/`)).toBe(true);
			expect(file.size).toBe(Buffer.byteLength(contents[file.relpath] ?? ""));
		}
	});

	test("resolves a missing or empty subtree to an empty plan", () => {
		const missing = join(tempDir("wake-missing-"), "logs", WORKSPACE_ID, "never-streamed");
		expect(planMaterializeFiles(missing)).toEqual({ rootDir: missing, files: [] });
		const empty = tempDir("wake-empty-");
		expect(planMaterializeFiles(empty)).toEqual({ rootDir: empty, files: [] });
	});

	test("never follows a symlink out of the subtree", () => {
		const outside = tempDir("wake-outside-");
		writeFileSync(join(outside, "secret.jsonl"), "secret\n");
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { [`${SESSION_ID}.jsonl`]: "main\n" });
		symlinkSync(join(outside, "secret.jsonl"), join(root, "leak.jsonl"));
		symlinkSync(outside, join(root, "leakdir"));

		const plan = planMaterializeFiles(root);
		expect(plan.files.map((file) => file.relpath)).toEqual([`${SESSION_ID}.jsonl`]);
	});
});

describe("emitMaterializeTransfer", () => {
	test("emits the lead, file, chunk and end records for a session subtree", () => {
		const mainContent = `{"type":"session","id":"minted","cwd":"/srv/proj"}\n`;
		const subContent = `${mainContent}{"type":"message","id":"m1"}\n`;
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, {
			[`${SESSION_ID}.jsonl`]: mainContent,
			[`${SESSION_ID}/sub1.jsonl`]: subContent,
		});
		const plan = planMaterializeFiles(root);
		const { lines, records } = emitTransfer(plan, SESSION_ID);

		// The lead names the workspace the store subtree was read from.
		expect(records[0]).toEqual({
			type: "session",
			workspaceId: WORKSPACE_ID,
			sessionId: SESSION_ID,
		});
		const declarations = recordsOfType(records, "file").map((file) => [
			file.relpath,
			file.kind,
			file.offset,
		]);
		expect(declarations).toEqual([
			[`${SESSION_ID}.jsonl`, "main", 0],
			[`${SESSION_ID}/sub1.jsonl`, "subagent", 0],
		]);
		const [mainFile, subFile] = recordsOfType(records, "file");
		expect(mainFile).toEqual({
			type: "file",
			relpath: `${SESSION_ID}.jsonl`,
			size: Buffer.byteLength(mainContent),
			sha256: sha256(Buffer.from(mainContent)),
			kind: "main",
			offset: 0,
		});
		expect(subFile.sha256).toBe(sha256(Buffer.from(subContent)));

		// One chunk per small file, and the bytes reassemble to the stored file.
		const chunks = recordsOfType(records, "chunk");
		expect(chunks.map((chunk) => [chunk.relpath, chunk.offset])).toEqual([
			[`${SESSION_ID}.jsonl`, 0],
			[`${SESSION_ID}/sub1.jsonl`, 0],
		]);
		expect(Buffer.from(chunks[0].data, "base64").toString("utf8")).toBe(mainContent);
		expect(Buffer.from(chunks[1].data, "base64").toString("utf8")).toBe(subContent);
		expect(records.at(-1)).toEqual({ type: "end", more: false });

		// The transfer never exceeds its budget.
		const emitted = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
		expect(emitted).toBeLessThanOrEqual(MATERIALIZE_TRANSFER_MAX_BYTES);
	});

	test("takes an explicit workspace id over the one derived from the store path", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { [`${SESSION_ID}.jsonl`]: "main\n" });
		const plan = planMaterializeFiles(root);
		const { records } = emitTransfer(plan, SESSION_ID, undefined, undefined, "ws-explicit");
		expect(records[0]).toEqual({
			type: "session",
			workspaceId: "ws-explicit",
			sessionId: SESSION_ID,
		});
	});

	test("chunks a file larger than the chunk size and reassembles it byte-for-byte", () => {
		const size = MATERIALIZE_CHUNK_RAW_BYTES + 4096;
		const payload = Buffer.allocUnsafe(size);
		for (let index = 0; index < size; index++) payload[index] = (index * 7) % 251;
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { "proj/big.jsonl": payload });
		const plan = planMaterializeFiles(root);
		const { records } = emitTransfer(plan, SESSION_ID);

		const file = recordsOfType(records, "file")[0];
		expect(file.relpath).toBe("proj/big.jsonl");
		expect(file.kind).toBe("main");
		expect(file.size).toBe(size);
		expect(file.offset).toBe(0);
		expect(file.sha256).toBe(sha256(payload));
		const chunks = recordsOfType(records, "chunk");
		expect(chunks.map((chunk) => chunk.offset)).toEqual([0, MATERIALIZE_CHUNK_RAW_BYTES]);
		const reassembled = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64")));
		expect(reassembled.equals(payload)).toBe(true);
	});

	test("splits only at record boundaries and resumes exactly at the cursor byte", () => {
		const size = MATERIALIZE_CHUNK_RAW_BYTES * 2;
		const payload = Buffer.alloc(size, "z");
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { "proj/big.jsonl": payload });
		const plan = planMaterializeFiles(root);
		const full = emitTransfer(plan, SESSION_ID);
		expect(recordsOfType(full.records, "end")).toEqual([{ type: "end", more: false }]);

		// Budget = lead + file + first chunk + the continuation record, so the
		// second chunk cannot fit: the transfer ends at the record boundary.
		const continuation = encodeMaterializeRecord({
			type: "end",
			more: true,
			cursor: { path: "proj/big.jsonl", offset: MATERIALIZE_CHUNK_RAW_BYTES },
		});
		const budget = [...full.lines.slice(0, 3), continuation].reduce(
			(total, line) => total + Buffer.byteLength(line, "utf8"),
			0,
		);
		const split = emitTransfer(plan, SESSION_ID, undefined, budget);
		expect(split.lines).toEqual([...full.lines.slice(0, 3), continuation]);
		const emitted = split.lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
		expect(emitted).toBeLessThanOrEqual(budget);

		// The daemon resumes from that cursor: the declaration is re-emitted at
		// the cursor offset and the concatenated halves are the stored file.
		const resumed = emitTransfer(plan, SESSION_ID, {
			path: "proj/big.jsonl",
			offset: MATERIALIZE_CHUNK_RAW_BYTES,
		});
		const resumedFile = recordsOfType(resumed.records, "file")[0];
		expect(resumedFile).toEqual({
			type: "file",
			relpath: "proj/big.jsonl",
			size,
			sha256: sha256(payload),
			kind: "main",
			offset: MATERIALIZE_CHUNK_RAW_BYTES,
		});
		const resumedChunks = recordsOfType(resumed.records, "chunk");
		expect(resumedChunks.map((chunk) => chunk.offset)).toEqual([MATERIALIZE_CHUNK_RAW_BYTES]);
		expect(recordsOfType(resumed.records, "end")).toEqual([{ type: "end", more: false }]);
		const firstHalf = Buffer.from(recordsOfType(split.records, "chunk")[0].data, "base64");
		const secondHalf = Buffer.concat(
			resumedChunks.map((chunk) => Buffer.from(chunk.data, "base64")),
		);
		expect(Buffer.concat([firstHalf, secondHalf]).equals(payload)).toBe(true);
	});

	test("skips files already fully sent and resumes inside the cursor's file", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, {
			"a-first.jsonl": "aaaa\n",
			"b-second.jsonl": "bbbbbbbb\n",
		});
		const plan = planMaterializeFiles(root);

		const resumed = emitTransfer(plan, SESSION_ID, { path: "b-second.jsonl", offset: 4 });
		const declarations = recordsOfType(resumed.records, "file").map((file) => [
			file.relpath,
			file.offset,
		]);
		expect(declarations).toEqual([["b-second.jsonl", 4]]);
		const chunks = recordsOfType(resumed.records, "chunk");
		expect(chunks.map((chunk) => [chunk.relpath, chunk.offset])).toEqual([["b-second.jsonl", 4]]);
		expect(Buffer.from(chunks[0].data, "base64").toString("utf8")).toBe("bbbb\n");

		// A cursor at exactly the declared size declares the file and no bytes.
		const complete = emitTransfer(plan, SESSION_ID, { path: "b-second.jsonl", offset: 9 });
		expect(recordsOfType(complete.records, "chunk")).toEqual([]);
		expect(recordsOfType(complete.records, "file")[0].offset).toBe(9);
		expect(recordsOfType(complete.records, "end")).toEqual([{ type: "end", more: false }]);
	});

	test("refuses a cursor offset beyond the declared file size", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { "a-first.jsonl": "aaaa\n" });
		const plan = planMaterializeFiles(root);
		const error = protocolFailure(() =>
			emitMaterializeTransfer(plan, SESSION_ID, { path: "a-first.jsonl", offset: 6 }),
		);
		expect(error.code).toBe("invalid_request");
	});

	test("refuses a budget too small for the lead record or a continuation record", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { [`${SESSION_ID}.jsonl`]: "main\n" });
		const plan = planMaterializeFiles(root);
		const noLead = protocolFailure(() => emitMaterializeTransfer(plan, SESSION_ID, undefined, 1));
		expect(noLead.code).toBe("invalid_request");
		const leadBytes = Buffer.byteLength(
			encodeMaterializeRecord({
				type: "session",
				workspaceId: WORKSPACE_ID,
				sessionId: SESSION_ID,
			}),
			"utf8",
		);
		const noRoom = protocolFailure(() =>
			emitMaterializeTransfer(plan, SESSION_ID, undefined, leadBytes + 1),
		);
		expect(noRoom.code).toBe("invalid_request");
	});

	test("reports an unreadable declared file as typed unavailable", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { "gone.jsonl": "gone\n" });
		const plan = planMaterializeFiles(root);
		rmSync(join(root, "gone.jsonl"));

		const error = protocolFailure(() => emitMaterializeTransfer(plan, SESSION_ID, undefined));
		expect(error.code).toBe("unavailable");
	});

	test("a same-size rewrite right after a transfer is not served a stale digest", () => {
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { [`${SESSION_ID}.jsonl`]: "aaaa" });
		const first = emitTransfer(planMaterializeFiles(root), SESSION_ID).records;
		expect(recordsOfType(first, "file")[0]?.sha256).toBe(sha256(Buffer.from("aaaa")));
		// Same byte length, rewritten right away: the memo must not serve the old digest.
		writeFileSync(join(root, `${SESSION_ID}.jsonl`), "bbbb");
		const second = emitTransfer(planMaterializeFiles(root), SESSION_ID).records;
		expect(recordsOfType(second, "file")[0]?.sha256).toBe(sha256(Buffer.from("bbbb")));
	});

	test("a resumed transfer streams only the cursor tail under the whole-file digest", () => {
		const bytes = Buffer.from("0123456789");
		const root = storeSubtree(WORKSPACE_ID, SESSION_ID, { [`${SESSION_ID}.jsonl`]: bytes });
		const cursor = { path: `${SESSION_ID}.jsonl`, offset: 4 };
		const { records } = emitTransfer(planMaterializeFiles(root), SESSION_ID, cursor);
		expect(recordsOfType(records, "file")[0]).toMatchObject({
			size: 10,
			offset: 4,
			sha256: sha256(bytes),
		});
		const chunks = recordsOfType(records, "chunk");
		expect(chunks[0]?.offset).toBe(4);
		expect(Buffer.from(chunks.map((c) => c.data).join(""), "base64").toString()).toBe("456789");
	});
});
