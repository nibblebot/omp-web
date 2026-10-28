/**
 * Static UI serving shared by the combined process (FleetEdge) and the UI
 * session (ui-server.ts): dist/ from the process cwd, then the bundle embedded
 * by build:omp-web, then a tiny placeholder page.
 *
 * Caching: `/assets/*` is content-hashed by the build, so it is `immutable`
 * for a year; everything else (index.html, favicon, feature-sizes.json) is
 * `no-cache` with an ETag, so a reload revalidates with a 304 and a release
 * shows up at once. Compression: the build writes `<file>.br` / `<file>.gz`
 * beside each compressible file (apps/web/build/precompress.ts); the best one
 * the client accepts is served as is, so serving never compresses.
 */

import type { BunFile } from "bun";
import { EMBEDDED_DIST } from "./embedded-dist";
import { acceptedCodings } from "./http-compress";

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>omp-web</title>
  </head>
  <body style="background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="text-align:center">
      <h1>omp-web</h1>
      <p>The aggregate UI has not been built into <code>dist/</code> yet.</p>
    </main>
  </body>
</html>`;

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/** Precompressed siblings, in preference order, with the file suffix the build writes. */
const ENCODINGS = [
	{ coding: "br", suffix: ".br" },
	{ coding: "gzip", suffix: ".gz" },
] as const;

/** Where the UI comes from; tests point these at a scratch bundle. */
export interface StaticUiSources {
	/** On-disk dist directory, relative to the process cwd by default. */
	distDir?: string;
	/** Embedded bundle: URL path to file path (see embedded-dist.ts). */
	embedded?: Readonly<Record<string, string>>;
}

/** True when If-None-Match lists the ETag (weak comparison) or `*`. */
function etagMatches(header: string | null, etag: string): boolean {
	if (header === null) return false;
	return header.split(",").some((tag) => {
		const value = tag.trim().replace(/^W\//, "");
		return value === "*" || value === etag;
	});
}

/** The file's validator inputs, or null when `path` is not a regular file. */
async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
	try {
		const stats = await Bun.file(path).stat();
		return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
	} catch {
		return null;
	}
}

/** Static dist/ from the process cwd, then the embedded bundle (R15), then a tiny placeholder. */
export async function serveStaticUi(
	pathname: string,
	req: Request,
	sources: StaticUiSources = {},
): Promise<Response> {
	const distDir = sources.distDir ?? "dist";
	const embedded = sources.embedded ?? EMBEDDED_DIST;
	const diskPath = pathname === "/" ? `${distDir}/index.html` : `${distDir}${pathname}`;
	// Installed-bundle path: no on-disk dist/ next to an arbitrary cwd, so
	// serve the assets embedded by build:omp-web. Keys are "/index.html" for
	// the index and pathname otherwise. A file and its precompressed siblings
	// always come from the same source.
	const embeddedKey = pathname === "/" ? "/index.html" : pathname;
	const onDisk = await statFile(diskPath);
	const plainPath = onDisk ? diskPath : embedded[embeddedKey];
	const plainStat = onDisk ?? (plainPath ? await statFile(plainPath) : null);
	if (plainPath !== undefined && plainStat !== null) {
		const pathOf = (suffix: string): string | undefined =>
			onDisk ? `${diskPath}${suffix}` : embedded[`${embeddedKey}${suffix}`];
		// The web app manifest gets its registered type explicitly instead of
		// relying on the runtime's extension table.
		const type = pathname.endsWith(".webmanifest")
			? "application/manifest+json"
			: Bun.file(plainPath).type;
		let path = plainPath;
		let stat = plainStat;
		let coding: string | null = null;
		let compressible = false;
		const accepted = acceptedCodings(req.headers.get("accept-encoding"));
		for (const { coding: candidate, suffix } of ENCODINGS) {
			const siblingPath = pathOf(suffix);
			const siblingStat = siblingPath ? await statFile(siblingPath) : null;
			if (siblingPath === undefined || siblingStat === null) continue;
			compressible = true;
			if (coding === null && accepted.has(candidate)) {
				path = siblingPath;
				stat = siblingStat;
				coding = candidate;
			}
		}
		const headers = new Headers({
			"content-type": type,
			"cache-control": pathname.startsWith("/assets/") ? IMMUTABLE : REVALIDATE,
			etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${coding === null ? "" : `-${coding}`}"`,
		});
		if (compressible) headers.set("vary", "Accept-Encoding");
		if (coding !== null) headers.set("content-encoding", coding);
		if (etagMatches(req.headers.get("if-none-match"), headers.get("etag")!)) {
			headers.delete("content-type");
			return new Response(null, { status: 304, headers });
		}
		const file: BunFile = Bun.file(path, { type });
		return new Response(file, { headers });
	}
	// A missing asset (a path with a file extension) is a 404, never the HTML
	// shell: a stale hashed bundle reference must fail visibly (FEDGE-19).
	if (/\.[A-Za-z0-9]+$/.test(pathname)) {
		return new Response("not found", {
			status: 404,
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	}
	return new Response(PLACEHOLDER_HTML, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE },
	});
}
