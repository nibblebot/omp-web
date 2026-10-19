/**
 * Static UI serving shared by the combined process (FleetEdge) and the UI
 * daemon (ui-server.ts): dist/ from the process cwd, then the bundle embedded
 * by build:omp-web, then a tiny placeholder page.
 */

import { EMBEDDED_DIST } from "./embedded-dist";

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

/** Static dist/ from the process cwd, then the embedded bundle (R15), then a tiny placeholder. */
export async function serveStaticUi(pathname: string): Promise<Response> {
	const file = Bun.file(pathname === "/" ? "dist/index.html" : `dist${pathname}`);
	if (await file.exists()) {
		return new Response(file);
	}
	// Installed-bundle path: no on-disk dist/ next to an arbitrary cwd, so
	// serve the assets embedded by build:omp-web. Keys are "/" for the
	// index and pathname otherwise; content-type is inferred from the file
	// extension, same as the disk branch above.
	const embedded = EMBEDDED_DIST[pathname === "/" ? "/index.html" : pathname];
	if (embedded) {
		return new Response(Bun.file(embedded));
	}
	// A missing asset (a path with a file extension) is a 404, never the HTML
	// shell: a stale hashed bundle reference must fail visibly (FEDGE-19).
	if (/\.[A-Za-z0-9]+$/.test(pathname)) {
		return new Response("not found", {
			status: 404,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(PLACEHOLDER_HTML, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
