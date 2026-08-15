/**
 * Security wave 3 regression tests (2026-08 audit Phase 6):
 *
 *  - Symlink escape: every `:file` handler (transcript, stats, subagents)
 *    rejects paths whose realpath escapes sessionsDir — file symlinks,
 *    dir symlinks, and symlinked intermediate dirs → 404; real files → 200.
 *  - Subagents recursive walk skips symlinked children pointing outside
 *    the session's own tree and 404s when the walk root itself escapes.
 *  - Unowned paths (non-stats, unknown under /ctl/stats) → handleFetch null:
 *    the fleet control plane's own 404/405 handling owns those — the stats
 *    app never serves index.html or HTML of any kind.
 *  - /ctl/stats/health redacts the $HOME prefix to "~" in displayed paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStatsApp, type StatsApp } from "../fleet/stats/index";
import type { StatsConfig } from "../fleet/stats/config";

let tmp: string;
let sessionsDir: string;
let outsideDir: string;
let cfg: StatsConfig;
let app: StatsApp;

const get = (p: string): Promise<Response | null> =>
  app.handleFetch(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
const enc = (p: string): string => encodeURIComponent(p);

const TITLE_LINE = JSON.stringify({ type: "title", title: "Real Session" });
const MSG_LINE = JSON.stringify({ type: "message", id: "m1", text: "hello" });

beforeAll(() => {
  tmp = mkdtempSync(join(homedir(), ".omp-sec-"));
  sessionsDir = join(tmp, "sessions");
  outsideDir = join(tmp, "outside");
  mkdirSync(join(sessionsDir, "proj"), { recursive: true });
  mkdirSync(join(sessionsDir, "proj", "real", "child"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // Real main session.
  writeFileSync(join(sessionsDir, "proj", "real.jsonl"), `${TITLE_LINE}\n${MSG_LINE}\n`);
  // Real subagent child inside the main session's tree.
  writeFileSync(join(sessionsDir, "proj", "real", "child", "one.jsonl"), `${MSG_LINE}\n`);
  // A second main session whose subagent dir is a symlink escape (walk root).
  writeFileSync(join(sessionsDir, "proj", "leakmain.jsonl"), `${MSG_LINE}\n`);

  // Secret files OUTSIDE sessionsDir — only reachable through a symlink.
  writeFileSync(join(outsideDir, "secret.jsonl"), `${TITLE_LINE}\n${MSG_LINE}\n`);
  writeFileSync(join(outsideDir, "leak.jsonl"), `${MSG_LINE}\n`);

  // Escape fixtures:
  // 1. file symlink — sessions/proj/escape.jsonl -> outside/secret.jsonl
  symlinkSync(join(outsideDir, "secret.jsonl"), join(sessionsDir, "proj", "escape.jsonl"));
  // 2. dir symlink — sessions/evil -> outside
  symlinkSync(outsideDir, join(sessionsDir, "evil"));
  // 3. intermediate dir symlink — sessions/proj/nested -> outside
  symlinkSync(outsideDir, join(sessionsDir, "proj", "nested"));
  // 4. subagent walk-root symlink — sessions/proj/leakmain -> outside
  symlinkSync(outsideDir, join(sessionsDir, "proj", "leakmain"));
  // 5. subagent child symlink — sessions/proj/real/leak -> outside
  symlinkSync(outsideDir, join(sessionsDir, "proj", "real", "leak"));

  cfg = {
    configRoot: tmp,
    statsDbPath: join(tmp, "stats.db"),
    sessionsDir,
  };
  app = createStatsApp(cfg);
});

afterAll(() => {
  app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("symlink escape containment", () => {
  test("transcript via a FILE symlink pointing outside → 404", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/escape.jsonl")}/transcript`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  test("transcript via a DIR symlink pointing outside → 404", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("evil/secret.jsonl")}/transcript`);
    expect(res.status).toBe(404);
  });

  test("transcript behind a symlinked INTERMEDIATE dir → 404", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/nested/secret.jsonl")}/transcript`);
    expect(res.status).toBe(404);
  });

  test("stats via a symlinked file → 404", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/escape.jsonl")}/stats`);
    expect(res.status).toBe(404);
  });

  test("transcript on a REAL file still works → 200", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/real.jsonl")}/transcript`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; totalLines: number };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.totalLines).toBe(2);
  });

  test("stats on a REAL file still works → 200", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/real.jsonl")}/stats`);
    expect(res.status).toBe(200);
  });

  test("subagents via a walk-root symlink dir → 404", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/leakmain.jsonl")}/subagents`);
    expect(res.status).toBe(404);
  });

  test("subagents walk skips symlinked children escaping the tree", async () => {
    const res = await get(`/ctl/stats/sessions/${enc("proj/real.jsonl")}/subagents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subagents: Array<{ name: string; file: string }> };
    expect(body.subagents.some((s) => s.name === "one.jsonl")).toBe(true);
    // Neither the symlinked child dir (leak.jsonl inside it) nor its
    // contents appear in the listing.
    expect(body.subagents.some((s) => s.file.includes("leak"))).toBe(false);
    expect(body.subagents.some((s) => s.name === "leak.jsonl")).toBe(false);
  });
});

describe("unowned paths", () => {
  test("GET /api (exact, no trailing slash) → null; the fleet control plane 404s it", async () => {
    const res = await get("/api");
    expect(res).toBeNull();
  });

  test("GET /api/<unknown> → null too", async () => {
    const res = await get("/api/definitely-not-a-route");
    expect(res).toBeNull();
  });

  test("GET /ctl/stats/<unknown> → null (fleet's own 404 takes over)", async () => {
    const res = await get("/ctl/stats/definitely-not-a-route");
    expect(res).toBeNull();
  });

  test("wrong method on a known stats path → null (fleet 405s)", async () => {
    const res = await app.handleFetch(
      new Request("http://localhost/ctl/stats/sessions", { method: "DELETE" }),
      new URL("http://localhost/ctl/stats/sessions"),
    );
    expect(res).toBeNull();
  });
});

describe("health $HOME redaction", () => {
  test("statsDbPath and sessionsDir start with ~ when under $HOME", async () => {
    const res = await get("/ctl/stats/health");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const h = (await res!.json()) as { statsDbPath: string; sessionsDir: string };
    expect(h.sessionsDir).toBe("~" + sessionsDir.slice(homedir().length));
    expect(h.statsDbPath).toBe("~" + cfg.statsDbPath.slice(homedir().length));
  });
});
