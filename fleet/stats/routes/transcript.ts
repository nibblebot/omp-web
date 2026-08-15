/**
 * Transcript + subagents routes.
 *
 * - GET /ctl/stats/sessions/:file/transcript?offset=&limit=
 *   Paginated raw JSONL entries for one session file. `offset` is the
 *   0-based JSONL LINE index (line 0 is the fixed 256 B title slot),
 *   `limit` defaults to 200 and is capped at 500. Entries are returned
 *   unmodified — rendering is the client's job.
 * - GET /ctl/stats/sessions/:file/subagents
 *   For a main session `proj/<name>.jsonl`, subagent transcripts live
 *   recursively under `proj/<name>/` (including `__advisor.jsonl`).
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { json, errorJson } from "../http";
import { decodeFileParam, toRel } from "../paths";
import { loadJsonl, readRange } from "../lib/jsonl";
import { sessionsRootReal, isInsideRoot, resolveContained } from "../lib/session-paths";
import type { AppCtx, Route } from "../types";
import type { SubagentInfo, TranscriptPage } from "../../../shared/stats-types";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function parsePaging(url: URL): { offset: number; limit: number } {
  const rawOffset = url.searchParams.get("offset");
  const rawLimit = url.searchParams.get("limit");
  const offset = rawOffset === null ? 0 : Number.parseInt(rawOffset, 10);
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
  return {
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

const transcriptRoute = (cfg: AppCtx["cfg"]): Route => ({
  method: "GET",
  pattern: /^\/ctl\/stats\/sessions\/(.+)\/transcript$/,
  handler: async ({ url, params }) => {
    const rel = decodeFileParam(cfg.sessionsDir, params[0]!);
    if (!rel) return errorJson("session not found", 404);
    const abs = resolveContained(cfg.sessionsDir, rel);
    if (!abs) return errorJson("session not found", 404);
    if (!existsSync(abs) || !statSync(abs).isFile()) return errorJson("session not found", 404);
    const { offset, limit } = parsePaging(url);
    try {
      const { entries, nextOffset, totalLines } = await readRange(abs, offset, limit);
      const doc = await loadJsonl(abs); // cache hit — for the truncated flag
      return json({
        entries,
        nextOffset,
        offset,
        limit,
        totalLines,
        truncated: doc?.truncated ?? false,
      } satisfies TranscriptPage);
    } catch {
      return errorJson("failed to read session", 500);
    }
  },
});

const subagentsRoute = (cfg: AppCtx["cfg"]): Route => ({
  method: "GET",
  pattern: /^\/ctl\/stats\/sessions\/(.+)\/subagents$/,
  handler: ({ params }) => {
    const rel = decodeFileParam(cfg.sessionsDir, params[0]!);
    if (!rel) return errorJson("session not found", 404);
    if (!rel.endsWith(".jsonl")) return errorJson("not a session file", 400);

    // Missing-file semantics: the main session file must exist on disk — a
    // deleted session's subagents listing is 404, matching transcript/stats.
    const mainAbs = join(cfg.sessionsDir, rel);
    if (!existsSync(mainAbs) || !statSync(mainAbs).isFile()) {
      return errorJson("session not found", 404);
    }

    const dirRel = rel.slice(0, rel.length - ".jsonl".length);
    const dirAbs = join(cfg.sessionsDir, dirRel);
    const subagents: SubagentInfo[] = [];
    if (existsSync(dirAbs)) {
      try {
        // The walk root itself must stay inside sessionsDir (it could be a
        // symlinked intermediate dir pointing outside).
        const root = sessionsRootReal(cfg.sessionsDir);
        if (root === null) return errorJson("session not found", 404);
        const dirReal = realpathSync.native(dirAbs);
        if (!isInsideRoot(root, dirReal)) return errorJson("session not found", 404);
        const walk = (abs: string, baseRel: string): void => {
          for (const dirent of readdirSync(abs, { withFileTypes: true })) {
            const childAbs = join(abs, dirent.name);
            // Skip entries whose realpath escapes the tree (symlinked child
            // dir/file, or one that vanished mid-walk) rather than erroring.
            let childReal: string;
            try {
              childReal = realpathSync.native(childAbs);
            } catch {
              continue;
            }
            if (!isInsideRoot(dirReal, childReal)) continue;
            const childRel = baseRel === "" ? dirent.name : `${baseRel}/${dirent.name}`;
            if (dirent.isDirectory()) {
              walk(childAbs, childRel);
            } else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
              const st = statSync(childReal);
              subagents.push({
                file: toRel(cfg.sessionsDir, childAbs),
                name: dirent.name,
                size: st.size,
                mtimeMs: st.mtimeMs,
              });
            }
          }
        };
        walk(dirAbs, dirRel);
      } catch {
        // Directory vanished or unreadable mid-walk — return what we have.
      }
    }
    subagents.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    );
    return json({ subagents });
  },
});

export function register(ctx: AppCtx, routes: Route[]): void {
  routes.push(transcriptRoute(ctx.cfg), subagentsRoute(ctx.cfg));
}
