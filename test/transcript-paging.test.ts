/**
 * Transcript route paging against a private tmpdir session store — never
 * test/.fixture. One stats app per file (createStatsApp instances are fully
 * isolated, but keeping the old one-app-per-file shape is cheapest), driven
 * via in-process handleFetch.
 *
 * Cache-hit accounting: each transcript request calls loadJsonl twice
 * (once inside readRange, once for the truncated flag) and both share the
 * layer's LRU/in-flight machinery, observable via jsonlCacheStats deltas.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsConfig } from "../fleet/stats/config";
import { jsonlCacheStats } from "../fleet/stats/lib/jsonl";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { TranscriptPage } from "../shared/stats-types";

let app: StatsApp;
let dir: string;
let sessionsDir: string;

const entry = (n: number): string => JSON.stringify({ type: "message", n });

const getPage = async (file: string, qs = ""): Promise<{ status: number; page: TranscriptPage }> => {
  const path = `/ctl/stats/sessions/${file}/transcript${qs}`;
  const res = await app.handleFetch(new Request(`http://local${path}`), new URL(`http://local${path}`));
  return { status: res!.status, page: (await res!.json()) as TranscriptPage };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "paging-test-"));
  sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const cfg: StatsConfig = {
    configRoot: dir,
    statsDbPath: join(dir, "stats.db"),
    sessionsDir,
  };
  app = createStatsApp(cfg);
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.PI_MAX_JSONL_BYTES;
});

/** 11 raw lines: entries n=0..10, raw line 5 corrupt. */
const CORRUPT_MID = "corrupt-mid";
const writeCorruptMid = async (): Promise<string> => {
  const lines: string[] = [];
  for (let i = 0; i <= 10; i++) lines.push(entry(i));
  lines[5] = "BROKEN LINE";
  const p = join(sessionsDir, `${CORRUPT_MID}.jsonl`);
  await writeFile(p, `${lines.join("\n")}\n`);
  return `${CORRUPT_MID}.jsonl`;
};

describe("transcript paging", () => {
  let file: string;
  beforeAll(async () => {
    file = await writeCorruptMid();
  });

  test("response carries totalLines and truncated", async () => {
    const { status, page } = await getPage(file, "?offset=0&limit=3");
    expect(status).toBe(200);
    expect(page.totalLines).toBe(11); // 11 raw lines incl. the corrupt one
    expect(page.truncated).toBe(false);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(3);
    expect(page.entries.map((e) => e.n)).toEqual([0, 1, 2]);
    expect(page.nextOffset).toBe(3);
  });

  test("nextOffset math is stable around a mid-file corrupt line", async () => {
    const a = await getPage(file, "?offset=4&limit=2"); // window [4,6): line 5 corrupt
    expect(a.page.entries.map((e) => e.n)).toEqual([4]);
    expect(a.page.nextOffset).toBe(6);

    const b = await getPage(file, "?offset=5&limit=1"); // window inside the corrupt line
    expect(b.page.entries).toEqual([]);
    expect(b.page.nextOffset).toBe(6);

    const c = await getPage(file, "?offset=6&limit=1");
    expect(c.page.entries.map((e) => e.n)).toEqual([6]);
    expect(c.page.nextOffset).toBe(7);
  });

  test("full walk: every valid entry exactly once, EOF → null", async () => {
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const { page } = await getPage(file, `?offset=${offset}&limit=3`);
      seen.push(...page.entries.map((e) => e.n as number));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10]); // 5 absent, nothing doubled
  });

  test("offset beyond EOF and missing file", async () => {
    const far = await getPage(file, "?offset=100&limit=3");
    expect(far.page.entries).toEqual([]);
    expect(far.page.nextOffset).toBeNull();
    expect(far.page.totalLines).toBe(11);

    const missing = await getPage("nope.jsonl", "?offset=0&limit=3");
    expect(missing.status).toBe(404);
  });

  test("default limit 200 and hard cap 500", async () => {
    const lines = [];
    for (let i = 0; i < 520; i++) lines.push(entry(i));
    const big = join(sessionsDir, "big.jsonl");
    await writeFile(big, `${lines.join("\n")}\n`);

    const def = await getPage("big.jsonl"); // no params
    expect(def.page.limit).toBe(200);
    expect(def.page.entries).toHaveLength(200);
    expect(def.page.nextOffset).toBe(200);
    expect(def.page.totalLines).toBe(520);

    const capped = await getPage("big.jsonl", "?limit=9999");
    expect(capped.page.limit).toBe(500);
    expect(capped.page.entries).toHaveLength(500);
    expect(capped.page.nextOffset).toBe(500);
    expect(capped.page.totalLines).toBe(520);
  });

  test("oversized file surfaces truncated=true with complete lines only", async () => {
    const l1 = '{"n":1}\n';
    const l2 = '{"n":22}\n';
    const l3 = '{"n":333}\n';
    const capFile = join(sessionsDir, "cap.jsonl");
    await writeFile(capFile, l1 + l2 + l3); // 27 bytes
    process.env.PI_MAX_JSONL_BYTES = "20"; // cuts 3 bytes into l3

    const page = await getPage("cap.jsonl", "?offset=0&limit=10");
    expect(page.page.truncated).toBe(true);
    expect(page.page.totalLines).toBe(2);
    expect(page.page.entries.map((e) => e.n)).toEqual([1, 22]);
    expect(page.page.nextOffset).toBeNull(); // 0+10 ≥ 2 → EOF

    // paging still works on the truncated doc
    const sub = await getPage("cap.jsonl", "?offset=0&limit=1");
    expect(sub.page.entries.map((e) => e.n)).toEqual([1]);
    expect(sub.page.nextOffset).toBe(1);

    // a file within the cap is never flagged (distinct file: cache key has no cap)
    const full = join(sessionsDir, "cap-full.jsonl");
    await writeFile(full, l1 + l2 + l3);
    process.env.PI_MAX_JSONL_BYTES = "27"; // cap == file size → full parse
    const fullPage = await getPage("cap-full.jsonl", "?offset=0&limit=10");
    expect(fullPage.page.truncated).toBe(false);
    expect(fullPage.page.totalLines).toBe(3);
  });

  test("cache-hit rate across a paging walk (one parse, N hits)", async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(entry(i));
    const walk = join(sessionsDir, "walk.jsonl");
    await writeFile(walk, `${lines.join("\n")}\n`);

    const before = jsonlCacheStats();
    for (const offset of [0, 2, 4, 6, 8, 10]) {
      await getPage("walk.jsonl", `?offset=${offset}&limit=2`);
    }
    const after = jsonlCacheStats();
    const misses = after.misses - before.misses;
    const hits = after.hits - before.hits;
    expect(misses).toBe(1); // one parse for the whole walk
    expect(hits).toBe(11); // 12 loadJsonl calls (2 per request) − 1 miss
    expect(hits / (hits + misses)).toBeCloseTo(11 / 12);
  });
});
