/**
 * Static UI caching and compression (static-ui.ts, http-compress.ts): hashed
 * assets are immutable, everything else revalidates with an ETag (304 on a
 * match), precompressed `.br`/`.gz` siblings are chosen by Accept-Encoding
 * (from dist/ and from the embedded bundle alike), and a missing asset stays a
 * 404 (FEDGE-19).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { compressJson } from "../http-compress";
import { serveStaticUi, type StaticUiSources } from "../static-ui";

afterAll(cleanupTempDirs);

const SCRIPT = "export const answer = 42;\n".repeat(200);
const HTML = "<!doctype html><title>omp</title>\n";

let dist: string;
let sources: StaticUiSources;

/** Write `name` plus `.br`/`.gz` siblings (the build's precompress step) under `dir`. */
function writeAsset(dir: string, name: string, body: string, siblings: boolean): void {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), body);
	if (!siblings) return;
	writeFileSync(join(dir, `${name}.br`), brotliCompressSync(body));
	writeFileSync(join(dir, `${name}.gz`), Bun.gzipSync(body));
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
	return serveStaticUi(path, new Request(`http://localhost${path}`, { headers }), sources);
}

beforeAll(() => {
	dist = tempDir("omp-static-ui-");
	writeAsset(dist, "assets/app-abc123.js", SCRIPT, true);
	writeAsset(dist, "index.html", HTML, false);
	writeAsset(dist, "favicon.svg", "<svg/>", false);
	writeAsset(dist, "manifest.webmanifest", "{}", false);
	writeAsset(dist, "sw.js", "self.skipWaiting();", false);
	writeAsset(dist, "icons/icon-192.png", "png", false);
	sources = { distDir: dist, embedded: {} };
});

describe("serveStaticUi caching", () => {
	test("a hashed asset is immutable", async () => {
		const res = await get("/assets/app-abc123.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	test("index.html and unhashed files revalidate", async () => {
		for (const path of ["/", "/favicon.svg"]) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(res.headers.get("etag")).toMatch(/^"[0-9a-z-]+"$/);
		}
	});

	test("a matching If-None-Match is a 304 with the same validators", async () => {
		const first = await get("/");
		const etag = first.headers.get("etag")!;
		const second = await get("/", { "if-none-match": etag });
		expect(second.status).toBe(304);
		expect(second.headers.get("etag")).toBe(etag);
		expect(second.headers.get("cache-control")).toBe("no-cache");
		expect(await second.text()).toBe("");
		expect((await get("/", { "if-none-match": `W/${etag}, "other"` })).status).toBe(304);
		expect((await get("/", { "if-none-match": '"other"' })).status).toBe(200);
	});

	test("a missing asset is a 404 text, never the HTML shell", async () => {
		const res = await get("/assets/missing-0f3c9a.js");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("text/plain");
	});
});

describe("serveStaticUi installable app", () => {
	test("the manifest, service worker and icons revalidate on every use", async () => {
		for (const path of ["/manifest.webmanifest", "/sw.js", "/icons/icon-192.png"]) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-cache");
		}
	});

	test("the manifest is served as application/manifest+json", async () => {
		const res = await get("/manifest.webmanifest");
		expect(res.headers.get("content-type")).toBe("application/manifest+json");
		expect(await res.text()).toBe("{}");
	});

	test("the service worker is JavaScript the browser will execute", async () => {
		const res = await get("/sw.js");
		expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
	});
});

describe("serveStaticUi compression", () => {
	test("serves the best precompressed sibling the client accepts", async () => {
		const gzip = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, deflate" });
		expect(gzip.headers.get("content-encoding")).toBe("gzip");
		expect(gzip.headers.get("vary")).toBe("Accept-Encoding");
		expect(gzip.headers.get("content-type")).toContain("javascript");
		expect(gunzipSync(new Uint8Array(await gzip.arrayBuffer())).toString()).toBe(SCRIPT);

		const plain = await get("/assets/app-abc123.js", { "accept-encoding": "identity" });
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(plain.headers.get("vary")).toBe("Accept-Encoding");
		expect(await plain.text()).toBe(SCRIPT);
	});

	test("prefers br over gzip and honors q=0", async () => {
		const both = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, br" });
		expect(both.headers.get("content-encoding")).toBe("br");
		expect(brotliDecompressSync(new Uint8Array(await both.arrayBuffer())).toString()).toBe(SCRIPT);
		const refused = await get("/assets/app-abc123.js", { "accept-encoding": "br;q=0, gzip" });
		expect(refused.headers.get("content-encoding")).toBe("gzip");
		const spaced = await get("/assets/app-abc123.js", { "accept-encoding": "br ;q=0, gzip ;q=1" });
		expect(spaced.headers.get("content-encoding")).toBe("gzip");
	});

	test("each encoding has its own ETag", async () => {
		const tags = await Promise.all(
			["identity", "gzip", "br"].map(async (enc) =>
				(await get("/assets/app-abc123.js", { "accept-encoding": enc })).headers.get("etag"),
			),
		);
		expect(new Set(tags).size).toBe(3);
	});

	test("a file without siblings is served as is", async () => {
		const res = await get("/favicon.svg", { "accept-encoding": "gzip, br" });
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("vary")).toBeNull();
		expect(await res.text()).toBe("<svg/>");
	});
});

describe("serveStaticUi embedded bundle", () => {
	test("serves embedded files and their siblings when dist/ has none", async () => {
		const bundle = tempDir("omp-static-embedded-");
		writeAsset(bundle, "a.js", SCRIPT, true);
		writeAsset(bundle, "page.html", HTML, false);
		const embedded: Record<string, string> = {
			"/assets/app-abc123.js": join(bundle, "a.js"),
			"/assets/app-abc123.js.gz": join(bundle, "a.js.gz"),
			"/index.html": join(bundle, "page.html"),
		};
		const from = (path: string, headers: Record<string, string> = {}) =>
			serveStaticUi(path, new Request(`http://localhost${path}`, { headers }), {
				distDir: join(bundle, "no-dist"),
				embedded,
			});
		const asset = await from("/assets/app-abc123.js", { "accept-encoding": "gzip, br" });
		expect(asset.headers.get("content-encoding")).toBe("gzip");
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect(asset.headers.get("content-type")).toContain("javascript");
		expect(gunzipSync(new Uint8Array(await asset.arrayBuffer())).toString()).toBe(SCRIPT);
		const index = await from("/");
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(index.headers.get("cache-control")).toBe("no-cache");
		expect(await index.text()).toBe(HTML);
		expect((await from("/assets/gone-1.js")).status).toBe(404);
	});
});

describe("compressJson", () => {
	const big = JSON.stringify({
		rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` })),
	});
	const req = (headers: Record<string, string> = {}, method = "GET") =>
		new Request("http://localhost/ctl/x", { method, headers });
	const json = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, { headers: { "content-type": "application/json", ...headers } });

	test("gzips a large JSON answer for a client that accepts it", async () => {
		const res = await compressJson(req({ "accept-encoding": "gzip, br" }), json(big));
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(res.headers.get("vary")).toBe("Accept-Encoding");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.byteLength).toBeLessThan(big.length / 2);
		expect(gunzipSync(bytes).toString()).toBe(big);
	});

	test("leaves small answers, clients without gzip, other types and encoded answers alone", async () => {
		const accept = { "accept-encoding": "gzip" };
		expect(
			(await compressJson(req(accept), json('{"ok":true}'))).headers.get("content-encoding"),
		).toBeNull();
		const noGzip = await compressJson(req({ "accept-encoding": "identity" }), json(big));
		expect(noGzip.headers.get("content-encoding")).toBeNull();
		expect(await noGzip.text()).toBe(big);
		const octets = new Response(big, { headers: { "content-type": "application/octet-stream" } });
		expect((await compressJson(req(accept), octets)).headers.get("content-encoding")).toBeNull();
		const encoded = await compressJson(req(accept), json(big, { "content-encoding": "br" }));
		expect(encoded.headers.get("content-encoding")).toBe("br");
		expect(
			(await compressJson(req(accept, "HEAD"), json(big))).headers.get("content-encoding"),
		).toBeNull();
	});

	test("keeps the status of an error answer", async () => {
		const res = await compressJson(
			req({ "accept-encoding": "gzip" }),
			new Response(big, { status: 409, headers: { "content-type": "application/json" } }),
		);
		expect(res.status).toBe(409);
		expect(res.headers.get("content-encoding")).toBe("gzip");
	});
});
