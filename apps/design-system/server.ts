import { join } from "node:path";
import { isInteractiveDesktop, openBrowser } from "#lib/platform/open-browser";
import { bundleConfig, root, type ViewName, VIEWS } from "./bundle";

/**
 * Design system server for one standalone page, picked by the first argument:
 * `stories` (component stories, `bun run design`) or `demo` (the App view,
 * `bun run demo`). It bundles that page's entry with Bun.build (`bundle.ts`, in
 * memory, nothing written to disk) and serves it with Bun.serve. Components come
 * straight from apps/web; only the page chrome lives here. The bundle is rebuilt
 * on every top-level page load so a refresh shows current sources. Inspector
 * frames (`?embed=`) reuse the current bundle instead. The server answers no
 * fetches beyond the page and its two assets: fixture routes and the fake
 * session run in the page (session.ts), exactly as in the static demo build
 * (`build.ts`). Startup opens the page in the default browser only from an
 * interactive local terminal with a display and no agent/CI marker
 * (`isInteractiveDesktop`), matching `bun run dev` and `omp-web`.
 */
const arg = process.argv[2];
if (arg !== "stories" && arg !== "demo") {
	console.error("usage: bun apps/design-system/server.ts <stories|demo>");
	process.exit(2);
}
const viewName: ViewName = arg;
const view = VIEWS[viewName];
const port = Number(process.env[view.portEnv] ?? view.port);

interface Bundle {
	js: Blob;
	css: Blob | null;
}

async function build(): Promise<Bundle> {
	const result = await Bun.build(bundleConfig(viewName, "dev"));
	if (!result.success) {
		throw new Error(result.logs.map((log) => String(log)).join("\n") || "bundle failed");
	}
	const js = result.outputs.find((o) => o.kind === "entry-point");
	if (!js) throw new Error("bundle has no entry point output");
	const css = result.outputs.find((o) => o.path.endsWith(".css")) ?? null;
	return { js, css };
}

let bundle: Promise<Bundle> | null = null;

const server = Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);
		const { pathname } = url;
		if (pathname === "/") {
			// A top-level page load starts a fresh build; its assets await the same
			// promise. Inspector frames (`?embed=`) reuse the current bundle.
			if (!url.searchParams.has("embed") || bundle === null) {
				bundle = build();
				bundle.catch(() => undefined);
			}
			return new Response(Bun.file(join(root, "index.html")), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			});
		}
		if (pathname === "/main.js" || pathname === "/main.css") {
			try {
				bundle ??= build();
				const out = await bundle;
				const blob = pathname === "/main.js" ? out.js : out.css;
				if (!blob) return new Response("not found", { status: 404 });
				return new Response(blob, {
					headers: {
						"content-type":
							pathname === "/main.js"
								? "text/javascript; charset=utf-8"
								: "text/css; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			} catch (err) {
				bundle = null;
				const message = err instanceof Error ? err.message : String(err);
				console.error(message);
				return new Response(message, { status: 500 });
			}
		}
		return new Response("not found", { status: 404 });
	},
});

const url = `http://localhost:${server.port}/`;
console.log(`design ${viewName}: ${url}`);
if (isInteractiveDesktop()) openBrowser(url, `design ${viewName}`);
