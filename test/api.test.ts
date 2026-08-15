/**
 * End-to-end API tests against the generated fixture.
 *
 * Runs the stats app in-process (test/helpers.ts — createStatsApp behind a
 * real Bun.serve on an ephemeral port) with config pointing at test/.fixture,
 * which scripts/gen-tx-fixture.ts regenerates in beforeAll. All expected
 * values come from the fixture generator's exported EXPECT object — the
 * tests can never drift from the fixture data they were written against.
 *
 * NOTE on health.sessionsCount: healthRoute sessionCount() counts
 * *.jsonl-named direct children of each project dir. The fixture has 3 main
 * files on disk; the subagent directory is named WITHOUT the .jsonl
 * extension (real omp layout — a file and a directory cannot share one
 * name), so it is not counted. The sessions LIST reports 4 = 3 disk +
 * proj-d (DB-only).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api, baseUrl, repoRoot, startServer, stopServer } from "./helpers";
import { EXPECT } from "../scripts/gen-tx-fixture";

interface SessionSummaryLike {
  file: string;
  folder: string;
  title: string | null;
  turns: number;
  toolCalls: number;
  totalTokens: number;
  totalCost: number;
  errorTurns: number;
  synced: boolean;
  onDisk: boolean;
  userMessages: number;
  userChars: number;
}

interface ToolStatLike {
  name: string;
  calls: number;
  errors: number;
  pending: number;
  totalMs: number;
  avgMs: number | null;
  maxMs: number | null;
  argsChars: number;
  resultChars: number;
}

// Boundary types for our own API responses (fixture-driven, deterministic).
interface SessionsResponse {
  sessions: SessionSummaryLike[];
  total: number;
  truncated: boolean;
}
interface StatsResponse {
  turns: number;
  toolCalls: number;
  title: string | null;
  synced: boolean;
  tools: ToolStatLike[];
  longestCall: { toolName: string; toolCallId: string; durationMs: number; args: string } | null;
  latency: { p50: number | null; p90: number | null };
  totals: { tokens: number; cost: number };
  errors: unknown[];
  user: { count: number; chars: number };
}
interface SubagentLike {
  name: string;
  size: number;
  mtimeMs: number;
}
interface SubagentsResponse {
  subagents: SubagentLike[];
}
interface ToolsResponse {
  tools: Array<{ name: string; calls: number; errors: number; sessions: number }>;
}

const enc = (p: string): string => encodeURIComponent(p);

describe("session viewer api (fixture)", () => {
  beforeAll(async () => {
    const gen = Bun.spawnSync(["bun", "scripts/gen-tx-fixture.ts"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(gen.exitCode, `gen-tx-fixture failed: ${gen.stderr?.toString() ?? ""}`).toBe(0);
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  test("health", async () => {
    const res = await api("/ctl/stats/health");
    expect(res.status).toBe(200);
    const h = await res.json();
    expect(h.ok).toBe(true);
    expect(h.statsDb).toBe("ok");
    expect(h.statsDbFromCopy).toBe(false);
    expect(h.sessionsCount).toBe(EXPECT.health.sessionsCount);
    expect(h.dbCounts).toEqual(EXPECT.health.dbCounts);
  });

  test("sessions list: 4 sessions (3 disk + 1 DB-only)", async () => {
    const res = await api("/ctl/stats/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(EXPECT.sessions.count);
    expect(body.total).toBe(EXPECT.sessions.count);
    expect(body.truncated).toBe(false);
    const byFile = new Map(body.sessions.map((s) => [s.file, s]));

    const a = byFile.get(EXPECT.sessions.projA.file);
    expect(a).toBeDefined();
    expect(a!.folder).toBe(EXPECT.sessions.projA.folder);
    expect(a!.title).toBe(EXPECT.sessions.projA.title);
    expect(a!.synced).toBe(true);
    expect(a!.onDisk).toBe(true);
    expect(a!.turns).toBe(EXPECT.sessions.projA.turns);
    expect(a!.toolCalls).toBe(EXPECT.sessions.projA.toolCalls);
    expect(a!.totalTokens).toBe(EXPECT.sessions.projA.totalTokens);
    expect(a!.totalCost).toBeCloseTo(EXPECT.sessions.projA.totalCost, 9);
    expect(a!.errorTurns).toBe(EXPECT.sessions.projA.errorTurns);
    expect(a!.userMessages).toBe(EXPECT.sessions.projA.userMessages);
    expect(a!.userChars).toBe(EXPECT.sessions.projA.userChars);

    const c = byFile.get(EXPECT.sessions.projC.file);
    expect(c).toBeDefined();
    expect(c!.title).toBe(EXPECT.sessions.projC.title);
    expect(c!.synced).toBe(false); // on disk, never synced to stats.db
    expect(c!.onDisk).toBe(true);
    expect(c!.turns).toBe(0);

    const d = byFile.get(EXPECT.sessions.projD.file);
    expect(d).toBeDefined();
    expect(d!.onDisk).toBe(false); // stats.db rows, file gone
    expect(d!.synced).toBe(true);
    expect(d!.turns).toBe(EXPECT.sessions.projD.turns);
    expect(d!.toolCalls).toBe(EXPECT.sessions.projD.toolCalls);
    expect(d!.totalCost).toBeCloseTo(EXPECT.sessions.projD.totalCost, 9);
  });

  test("sessions list: q filter matches title/cwd", async () => {
    const res = await api("/ctl/stats/sessions?q=Alpha");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.file).toBe(EXPECT.sessions.projA.file);
  });

  test("sessions list: tool filter narrows to sessions using that tool", async () => {
    const res = await api("/ctl/stats/sessions?tool=web_search");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.file).toBe(EXPECT.sessions.projA.file);
  });

  test("stats proj-a: tools, errors, longest call, latency, totals", async () => {
    const res = await api(`/ctl/stats/sessions/${enc(EXPECT.sessions.projA.file)}/stats`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as StatsResponse;

    expect(s.turns).toBe(EXPECT.projAStats.turns);
    expect(s.toolCalls).toBe(EXPECT.projAStats.toolCalls);
    expect(s.title).toBe(EXPECT.sessions.projA.title);
    expect(s.synced).toBe(true);

    const tools = new Map(s.tools.map((t) => [t.name, t]));
    for (const [name, exp] of Object.entries(EXPECT.projAStats.tools)) {
      expect(tools.get(name), `tool ${name}`).toMatchObject(exp);
    }

    expect(s.longestCall).toEqual(EXPECT.projAStats.longestCall);
    expect(s.latency).toEqual(EXPECT.projAStats.latency);
    expect(s.totals.tokens).toBe(EXPECT.projAStats.totals.tokens);
    expect(s.totals.cost).toBeCloseTo(EXPECT.projAStats.totals.cost, 9);
    expect(s.errors).toEqual(EXPECT.projAStats.errors);
    expect(s.user).toEqual(EXPECT.projAStats.user);
  });

  test("stats proj-d (file missing on disk): 404 even though stats.db has rows", async () => {
    // Missing-file semantics: a :file detail for a deleted session is 404
    // regardless of DB rows. The DB-only session itself stays visible in the
    // sessions LIST with onDisk:false (asserted above).
    const res = await api(`/ctl/stats/sessions/${enc(EXPECT.sessions.projD.file)}/stats`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
  });

  test("transcript: pagination by line index, corrupt trailing line skipped", async () => {
    const file = EXPECT.sessions.projA.file;
    const limit = 3;
    const all: unknown[] = [];
    const pages: Array<{ entries: unknown[]; nextOffset: number | null }> = [];
    let offset = 0;
    for (;;) {
      const res = await api(`/ctl/stats/sessions/${enc(file)}/transcript?offset=${offset}&limit=${limit}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as { entries: unknown[]; nextOffset: number | null };
      pages.push(page);
      all.push(...page.entries);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }

    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.entries).toHaveLength(limit);
    expect(pages[0]!.nextOffset).toBe(limit); // line 3 is the next page's first line
    expect(pages[1]!.entries.length).toBeGreaterThan(0);
    expect(pages[1]!.nextOffset).toBe(2 * limit);
    expect(pages[pages.length - 1]!.nextOffset).toBeNull();

    // Every valid line is served exactly once; the truncated garbage line is skipped.
    expect(all.length).toBe(EXPECT.transcript.projAValidEntries);
    const ids = all.map((e) => (e as { id?: unknown }).id);
    expect(ids).not.toContain("msg-99");
  });

  test("subagents: listed for proj-a, empty for proj-b", async () => {
    const res = await api(`/ctl/stats/sessions/${enc(EXPECT.sessions.projA.file)}/subagents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubagentsResponse;
    const names = body.subagents.map((s) => s.name).sort();
    expect(names.join(",")).toBe(EXPECT.subagents.projA.join(","));
    expect(body.subagents.every((s) => s.size > 0 && s.mtimeMs > 0)).toBe(true);

    const b = await api(`/ctl/stats/sessions/${enc(EXPECT.sessions.projB.file)}/subagents`);
    const bb = (await b.json()) as SubagentsResponse;
    expect(bb.subagents.map((s) => s.name).sort().join(",")).toBe(EXPECT.subagents.projB.join(","));
  });

  test("subagents proj-d (file missing on disk): 404", async () => {
    // Unified missing-file semantics — a deleted session's :file detail is 404.
    const res = await api(`/ctl/stats/sessions/${enc(EXPECT.sessions.projD.file)}/subagents`);
    expect(res.status).toBe(404);
  });

  test("security: traversal and absolute-path params are rejected", async () => {
    for (const p of [EXPECT.security.traversal, EXPECT.security.absolute]) {
      const res = await fetch(`${baseUrl}${p}`);
      expect([400, 404]).toContain(res.status);
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error).toBe("string");
    }
  });

  test("tools global: web_search present with sessions:1", async () => {
    const res = await api("/ctl/stats/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ToolsResponse;
    expect(Array.isArray(body.tools)).toBe(true);
    const ws = body.tools.find((t) => t.name === "web_search");
    expect(ws).toMatchObject(EXPECT.toolsGlobal.web_search);
  });
});
