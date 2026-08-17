/**
 * JSONL layer unit tests: corrupt-line handling (entries vs lineIndex),
 * LRU cache invalidation (mtime/size), in-flight dedup, LRU bound, and the
 * byte-cap truncation path. All fixtures live in a throwaway tmpdir —
 * test/.fixture is never touched.
 *
 * Read counting: loadJsonl increments `misses` exactly once per new parse
 * and `hits` for every read avoided (cached doc or in-flight join), so the
 * cache-hit/read-share behavior is asserted through jsonlCacheStats deltas.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlCacheStats, loadJsonl, readRange } from "../fleet/stats/lib/jsonl";

let dir: string;
const f = (name: string): string => join(dir, name);
const entry = (n: number): string => JSON.stringify({ type: "message", n });

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "jsonl-test-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env.PI_MAX_JSONL_BYTES;
});

describe("loadJsonl line handling", () => {
	test("skips a corrupt mid-file line; lineIndex keeps raw line numbers", async () => {
		const p = f("mid.jsonl");
		await writeFile(p, `${entry(1)}\nNOT JSON\n${entry(2)}\n${entry(3)}\n`);
		const doc = await loadJsonl(p);
		expect(doc).not.toBeNull();
		expect(doc!.entries.map((e) => e.n)).toEqual([1, 2, 3]);
		expect(doc!.lineIndex).toEqual([0, 2, 3]); // raw 0-based lines of entries
		expect(doc!.totalLines).toBe(4);
		expect(doc!.truncated).toBe(false);
	});

	test("blank lines are raw lines (corrupt, skipped in entries)", async () => {
		const p = f("blank.jsonl");
		await writeFile(p, `${entry(1)}\n\n${entry(2)}\n`);
		const doc = await loadJsonl(p);
		expect(doc!.entries.map((e) => e.n)).toEqual([1, 2]);
		expect(doc!.lineIndex).toEqual([0, 2]);
		expect(doc!.totalLines).toBe(3);
	});

	test("final line without trailing newline still counts", async () => {
		const p = f("noeol.jsonl");
		await writeFile(p, `${entry(1)}\n${entry(2)}`);
		const doc = await loadJsonl(p);
		expect(doc!.totalLines).toBe(2);
		expect(doc!.lineIndex).toEqual([0, 1]);
	});

	test("empty file and missing/unreadable paths", async () => {
		const empty = f("empty.jsonl");
		await writeFile(empty, "");
		const doc = await loadJsonl(empty);
		expect(doc).not.toBeNull();
		expect(doc!.entries).toEqual([]);
		expect(doc!.totalLines).toBe(0);
		expect(doc!.truncated).toBe(false);

		expect(await loadJsonl(f("nope.jsonl"))).toBeNull(); // missing
		expect(await loadJsonl(dir)).toBeNull(); // a directory is not a doc
	});
});

describe("readRange raw-line windows", () => {
	let p: string;
	beforeAll(async () => {
		p = f("range.jsonl");
		await writeFile(p, `${entry(1)}\nNOT JSON\n${entry(2)}\n${entry(3)}\n`);
	});

	test("corrupt line inside the window yields a gap, never a shift", async () => {
		expect(await readRange(p, 0, 2)).toEqual({
			entries: [{ type: "message", n: 1 }],
			nextOffset: 2,
			totalLines: 4,
		});
		expect(await readRange(p, 1, 1)).toEqual({
			// window sits inside the corrupt line — a gap, no entries
			entries: [],
			nextOffset: 2,
			totalLines: 4,
		});
		expect(await readRange(p, 2, 1)).toEqual({
			entries: [{ type: "message", n: 2 }],
			nextOffset: 3,
			totalLines: 4,
		});
		expect(await readRange(p, 3, 1)).toEqual({
			entries: [{ type: "message", n: 3 }],
			nextOffset: null,
			totalLines: 4,
		});
	});

	test("full walk: every valid entry exactly once, nextOffset null at EOF", async () => {
		const seen: number[] = [];
		let offset = 0;
		for (;;) {
			const r = await readRange(p, offset, 2);
			seen.push(...r.entries.map((e) => e.n as number));
			if (r.nextOffset === null) break;
			offset = r.nextOffset;
		}
		expect(seen).toEqual([1, 2, 3]); // no dup, no drop, corrupt line absent
	});

	test("beyond EOF and missing file", async () => {
		expect(await readRange(p, 100, 2)).toEqual({ entries: [], nextOffset: null, totalLines: 4 });
		expect(await readRange(f("missing.jsonl"), 0, 2)).toEqual({
			entries: [],
			nextOffset: null,
			totalLines: 0,
		});
	});
});

describe("cache", () => {
	test("repeat load returns the same cached doc object", async () => {
		const p = f("cached.jsonl");
		await writeFile(p, `${entry(1)}\n${entry(2)}\n`);
		const before = jsonlCacheStats();
		const a = await loadJsonl(p);
		const b = await loadJsonl(p);
		expect(a).toBe(b);
		const after = jsonlCacheStats();
		expect(after.misses - before.misses).toBe(1);
		expect(after.hits - before.hits).toBe(1);
	});

	test("mtime change invalidates the cache entry", async () => {
		const p = f("mtime.jsonl");
		await writeFile(p, `${entry(1)}\n`);
		const d1 = await loadJsonl(p);
		await utimes(p, 1700000000000, 1700000000000); // same content, new mtime
		const d2 = await loadJsonl(p);
		expect(d2).not.toBe(d1);
		expect(d2!.totalLines).toBe(1);
		expect(d2!.entries).toEqual(d1!.entries);
	});

	test("size change invalidates even when mtime is pinned", async () => {
		const p = f("size.jsonl");
		await writeFile(p, `${entry(1)}\n${entry(2)}\n`);
		await utimes(p, 1700000000000, 1700000000000); // pin mtime before first load
		const d1 = await loadJsonl(p);
		await writeFile(p, `${entry(1)}\n${entry(2)}\n${entry(3)}\n`);
		await utimes(p, 1700000000000, 1700000000000); // restore mtime → only size differs
		const d2 = await loadJsonl(p);
		expect(d2).not.toBe(d1);
		expect(d2!.totalLines).toBe(3);
	});

	test("LRU bound: 101st file evicts the oldest; recency refresh protects hot files", async () => {
		const paths: string[] = [];
		for (let i = 0; i <= 100; i++) {
			const p = f(`lru-${i}.jsonl`);
			await writeFile(p, `${entry(i)}\n`);
			paths.push(p);
		}
		const before = jsonlCacheStats();
		for (let i = 0; i < 100; i++) await loadJsonl(paths[i]!); // fills the cache
		await loadJsonl(paths[0]!); // recency refresh → file 0 is now newest
		await loadJsonl(paths[100]!); // 101st distinct → evicts oldest = file 1
		const after101 = jsonlCacheStats();
		expect(after101.misses - before.misses).toBe(101); // 100 + the 101st file
		expect(after101.hits - before.hits).toBe(1); // the refresh of file 0

		const m0 = jsonlCacheStats();
		await loadJsonl(paths[0]!); // still cached (refreshed before eviction)
		const after0 = jsonlCacheStats();
		expect(after0.misses - m0.misses).toBe(0);
		expect(after0.hits - m0.hits).toBe(1);

		const m1 = jsonlCacheStats();
		await loadJsonl(paths[1]!); // evicted → re-parsed
		const after1 = jsonlCacheStats();
		expect(after1.misses - m1.misses).toBe(1);
	});

	test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"failed reads are not cached; the in-flight slot clears for retry",
		async () => {
			const p = f("unreadable.jsonl");
			await writeFile(p, `${entry(1)}\n`);
			await chmod(p, 0o000);
			try {
				const before = jsonlCacheStats();
				expect(await loadJsonl(p)).toBeNull();
				expect(await loadJsonl(p)).toBeNull();
				const after = jsonlCacheStats();
				expect(after.misses - before.misses).toBe(2); // retried, not joined to a dead read
				expect(after.hits - before.hits).toBe(0);
			} finally {
				await chmod(p, 0o644);
			}
		},
	);
});

describe("in-flight dedup", () => {
	test("concurrent loadJsonl calls share one parse", async () => {
		const p = f("dedup.jsonl");
		await writeFile(p, `${entry(1)}\n${entry(2)}\n`);
		const before = jsonlCacheStats();
		const [a, b] = await Promise.all([loadJsonl(p), loadJsonl(p)]);
		expect(a).not.toBeNull();
		expect(a).toBe(b); // same promise → same doc object
		const after = jsonlCacheStats();
		expect(after.misses - before.misses).toBe(1); // one read for two callers
		expect(after.hits - before.hits).toBe(1); // second call joined the in-flight read
	});
});

describe("byte cap truncation", () => {
	const l1 = '{"n":1}\n'; // 8 bytes
	const l2 = '{"n":22}\n'; // 9 bytes
	const l3 = '{"n":333}\n'; // 10 bytes

	test("oversized file stops at the last complete line at/before the cap", async () => {
		const p = f("cap.jsonl");
		await writeFile(p, l1 + l2 + l3); // 27 bytes
		process.env.PI_MAX_JSONL_BYTES = "20"; // cuts 3 bytes into l3
		const doc = await loadJsonl(p);
		expect(doc!.truncated).toBe(true);
		expect(doc!.entries.map((e) => e.n)).toEqual([1, 22]);
		expect(doc!.lineIndex).toEqual([0, 1]);
		expect(doc!.totalLines).toBe(2);
		expect(await readRange(p, 0, 10)).toEqual({
			entries: [{ n: 1 }, { n: 22 }],
			nextOffset: null,
			totalLines: 2,
		});
	});

	test("cap landing inside the next line still keeps only complete lines", async () => {
		const p = f("cap-boundary.jsonl");
		await writeFile(p, l1 + l2 + l3);
		process.env.PI_MAX_JSONL_BYTES = "17"; // 1 byte into l3
		const doc = await loadJsonl(p);
		expect(doc!.truncated).toBe(true);
		expect(doc!.totalLines).toBe(2);
	});

	test("cap at/above file size is not truncated", async () => {
		const p = f("cap-full.jsonl");
		await writeFile(p, l1 + l2 + l3);
		process.env.PI_MAX_JSONL_BYTES = "27";
		const doc = await loadJsonl(p);
		expect(doc!.truncated).toBe(false);
		expect(doc!.totalLines).toBe(3);
	});

	test("no complete line within the cap yields an empty doc", async () => {
		const p = f("cap-none.jsonl");
		await writeFile(p, l1);
		process.env.PI_MAX_JSONL_BYTES = "3";
		const doc = await loadJsonl(p);
		expect(doc!.truncated).toBe(true);
		expect(doc!.entries).toEqual([]);
		expect(doc!.totalLines).toBe(0);
	});

	test("cap override is a per-process test seam (keyed by mtime/size only)", async () => {
		const p = f("cap-env.jsonl");
		await writeFile(p, l1 + l2 + l3);
		process.env.PI_MAX_JSONL_BYTES = "10"; // cuts into l2
		const truncated = await loadJsonl(p);
		expect(truncated!.truncated).toBe(true);
		expect(truncated!.entries.map((e) => e.n)).toEqual([1]);
		// Documented seam: the cache key is (abs, mtimeMs, size) — NOT the cap —
		// so a later cap change must not rely on invalidation; tests use distinct
		// files per cap value. A second call with the same key stays truncated.
		process.env.PI_MAX_JSONL_BYTES = "500";
		const again = await loadJsonl(p);
		expect(again!.truncated).toBe(true);
		expect(again).toBe(truncated); // same cached doc
	});
});
