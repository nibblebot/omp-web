/**
 * Unit tests for the client API layer (store/fleet-api.ts).
 *
 * fetch is stubbed per test; no server is spawned. Verifies:
 * - non-2xx responses throw ApiError with status and the server's {error} message
 * - non-JSON (HTML) error bodies degrade to "HTTP <status>"
 * - 2xx non-JSON bodies surface as ApiError (SPA-fallback guard)
 * - the 30s abort timeout throws ApiError("Request timed out", 0)
 * - api.sync() POSTs /ctl/stats/sync and parses the payload
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, encodePathSegments, REQUEST_TIMEOUT_MS, api } from "../../store/fleet-api";
import { restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";

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
		restoreBrowserGlobals();
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	});

	test("non-2xx JSON error body -> ApiError with status and server message", async () => {
		setBrowserGlobal("fetch", (async (_url: string, _init?: RequestInit) =>
			jsonResponse(503, { error: "stats.db unavailable" })) as typeof fetch);
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
		setBrowserGlobal("fetch", (async (_url: string, _init?: RequestInit) =>
			htmlResponse(404)) as typeof fetch);
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
		setBrowserGlobal("fetch", (async (_url: string, _init?: RequestInit) =>
			htmlResponse(200)) as typeof fetch);
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

		setBrowserGlobal("fetch", ((_url: string, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal;
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			});
		}) as typeof fetch);

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
	afterEach(restoreBrowserGlobals);

	test("POSTs /ctl/stats/sync and returns the payload", async () => {
		let captured: { url: string; init?: RequestInit } | null = null;
		setBrowserGlobal("fetch", (async (url: string, init?: RequestInit) => {
			captured = { url, init };
			return jsonResponse(200, { processed: 12, files: 3, totalMessages: 99, durationMs: 42 });
		}) as typeof fetch);

		const result = await api.sync();
		expect(result).toEqual({ processed: 12, files: 3, totalMessages: 99, durationMs: 42 });
		expect(captured!.url.endsWith("/ctl/stats/sync")).toBe(true);
		expect(captured!.init?.method).toBe("POST");
	});

	test("propagates sync endpoint failures as ApiError", async () => {
		setBrowserGlobal("fetch", (async (_url: string, _init?: RequestInit) =>
			jsonResponse(503, {
				error: "omp binary not found. Run `npm i -g @oh-my-pi/omp-stats` or install omp",
			})) as typeof fetch);
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

describe("api.storedRaw", () => {
	afterEach(() => {
		restoreBrowserGlobals();
	});

	/** A body that arrives in `chunks` and records whether the reader cancelled it. */
	function chunked(chunks: Uint8Array[]): { res: Response; cancelled: () => boolean } {
		let cancelled = false;
		let i = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					if (i < chunks.length) c.enqueue(chunks[i++]!);
					else c.close();
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		return { res: new Response(body), cancelled: () => cancelled };
	}

	test("asks the server for one byte past the cap and returns a file under it whole", async () => {
		let url = "";
		setBrowserGlobal("fetch", (async (u: string) => {
			url = u;
			return new Response("a\nb\n");
		}) as typeof fetch);
		const out = await api.storedRaw("ws", "s1", "main.jsonl", 100);
		expect(out).toEqual({ text: "a\nb\n", truncated: false });
		expect(new URL(url, "http://x").searchParams.get("maxBytes")).toBe("101");
	});

	test("stops reading at the cap, cancels the stream, and flags truncation", async () => {
		const enc = new TextEncoder();
		const { res, cancelled } = chunked([
			enc.encode("aaaa"),
			enc.encode("bbbb"),
			enc.encode("cccc"),
		]);
		setBrowserGlobal("fetch", (async (_url: string) => res) as typeof fetch);
		const out = await api.storedRaw("ws", "s1", "main.jsonl", 6);
		expect(out).toEqual({ text: "aaaabb", truncated: true });
		expect(cancelled()).toBe(true);
	});

	test("a cut inside a multi-byte character drops the partial character", async () => {
		const bytes = new TextEncoder().encode("ab\u00e9\u00e9"); // "é" is two bytes: cut after its first
		setBrowserGlobal("fetch", (async (_url: string) => new Response(bytes)) as typeof fetch);
		const out = await api.storedRaw("ws", "s1", "main.jsonl", 3);
		expect(out).toEqual({ text: "ab", truncated: true });
	});

	test("a file of exactly the cap is not truncated", async () => {
		setBrowserGlobal("fetch", (async (_url: string) => new Response("abcd")) as typeof fetch);
		expect(await api.storedRaw("ws", "s1", "main.jsonl", 4)).toEqual({
			text: "abcd",
			truncated: false,
		});
	});
});
