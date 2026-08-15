/**
 * Unit tests for the client API layer (src/tx/api.ts).
 *
 * fetch is stubbed per test; no server is spawned. Verifies:
 * - non-2xx responses throw ApiError with status and the server's {error} message
 * - non-JSON (HTML) error bodies degrade to "HTTP <status>"
 * - 2xx non-JSON bodies surface as ApiError (SPA-fallback guard)
 * - the 30s abort timeout throws ApiError("Request timed out", 0)
 * - api.sync() POSTs /ctl/stats/sync and parses the payload
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, REQUEST_TIMEOUT_MS, api } from "./api";
import { encodePathSegments } from "./util/format";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(status: number): Response {
  return new Response("<!doctype html><html><body>fallback</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

describe("encodePathSegments", () => {
  test("keeps separators literal and encodes segments", () => {
    expect(encodePathSegments("proj a/sess 1.jsonl")).toBe("proj%20a/sess%201.jsonl");
    expect(encodePathSegments("a/b/c.jsonl")).toBe("a/b/c.jsonl");
  });
});

describe("fetchJson error handling", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  test("non-2xx JSON error body -> ApiError with status and server message", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      jsonResponse(503, { error: "stats.db unavailable" })) as typeof fetch;
    try {
      await api.stats("x/y.jsonl");
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(503);
      expect(err.message).toBe("stats.db unavailable");
    }
  });

  test("non-2xx non-JSON body -> ApiError with HTTP status line", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      htmlResponse(404)) as typeof fetch;
    try {
      await api.health();
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
      expect((e as ApiError).message).toBe("HTTP 404");
    }
  });

  test("2xx non-JSON body -> ApiError (SPA-fallback guard)", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      htmlResponse(200)) as typeof fetch;
    try {
      await api.health();
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(200);
      expect((e as ApiError).message).toContain("Invalid JSON response");
    }
  });

  test("abort timeout -> ApiError with status 0 and 'Request timed out'", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);

    let abortCb: (() => void) | null = null;
    globalThis.setTimeout = ((cb: () => void) => {
      abortCb = cb;
      return 42 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as typeof fetch;

    const pending = api.health();
    expect(abortCb).not.toBeNull();
    abortCb!(); // fire the 30s timer -> controller.abort() -> fetch rejects
    try {
      await pending;
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(0);
      expect(err.message).toBe("Request timed out");
    }
  });
});

describe("api.sync", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs /ctl/stats/sync and returns the payload", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return jsonResponse(200, { processed: 12, files: 3, totalMessages: 99, durationMs: 42 });
    }) as typeof fetch;

    const result = await api.sync();
    expect(result).toEqual({ processed: 12, files: 3, totalMessages: 99, durationMs: 42 });
    expect(captured!.url.endsWith("/ctl/stats/sync")).toBe(true);
    expect(captured!.init?.method).toBe("POST");
  });

  test("propagates sync endpoint failures as ApiError", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      jsonResponse(503, { error: "omp binary not found — run `npm i -g @oh-my-pi/omp-stats` or install omp" })) as typeof fetch;
    try {
      await api.sync();
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(503);
      expect((e as ApiError).message).toContain("omp binary not found");
    }
  });
});
