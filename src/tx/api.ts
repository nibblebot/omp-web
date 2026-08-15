/**
 * Typed client for the fleet stats API (historical transcripts/stats view).
 * Wire types are single-sourced from shared/stats-types.ts — do not mirror.
 * All requests use relative /ctl/stats paths: vite proxies /ctl to the fleet
 * control plane (loopback :4722) in dev; same-origin in prod.
 */

import type {
  Health,
  LongestCall,
  RawEntry,
  SessionsResponse,
  SessionStats,
  SessionSummary,
  SubagentInfo,
  SyncResult,
  ToolStat,
  TranscriptPage,
} from "../../shared/stats-types";
import { encodePathSegments } from "./util/format";

export type {
  Health,
  LongestCall,
  RawEntry,
  SessionsResponse,
  SessionStats,
  SessionSummary,
  SubagentInfo,
  SyncResult,
  ToolStat,
  TranscriptPage,
} from "../../shared/stats-types";

/** Fetch failure carrying the HTTP status; message prefers the server's `{error}`. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const REQUEST_TIMEOUT_MS = 30_000;

/** Append search params to a relative path — no origin resolution (the caller's origin serves /ctl). */
function withParams(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s === "" ? path : `${path}?${s}`;
}

async function fetchJson<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  init?: RequestInit,
): Promise<T> {
  const url = withParams(path, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as unknown;
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
        ) {
          message = (body as { error: string }).error;
        }
      } catch {
        // non-JSON error body — keep the status line
      }
      throw new ApiError(message, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      // 2xx with a non-JSON body — surface it as an error.
      throw new ApiError(`Invalid JSON response from ${path}`, res.status);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError("Request timed out", 0);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => fetchJson<Health>("/ctl/stats/health"),

  sessions: (q?: string) => fetchJson<SessionsResponse>("/ctl/stats/sessions", { q }),

  stats: (file: string) => fetchJson<SessionStats>(`/ctl/stats/sessions/${encodePathSegments(file)}/stats`),

  transcript: (file: string, offset: number | null, limit: number) =>
    fetchJson<TranscriptPage>(`/ctl/stats/sessions/${encodePathSegments(file)}/transcript`, {
      offset: offset ?? undefined,
      limit,
    }),

  /** Server envelope is { subagents: SubagentInfo[] }; accept a bare array defensively too. */
  subagents: async (file: string): Promise<SubagentInfo[]> => {
    const data = (await fetchJson<unknown>(
      `/ctl/stats/sessions/${encodePathSegments(file)}/subagents`,
    )) as
      | SubagentInfo[]
      | { subagents?: SubagentInfo[] };
    return Array.isArray(data) ? data : (data.subagents ?? []);
  },

  /** Shell out to `omp stats --summary` on the server and re-probe its stats.db handle. */
  sync: (): Promise<SyncResult> => fetchJson<SyncResult>("/ctl/stats/sync", undefined, { method: "POST" }),
};
