import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInteractiveDesktop, openBrowser } from "#lib/platform/open-browser";
import { buildInfoDefines } from "../web/build/build-info";
import { handleFixtureRoute } from "./fixtures/routes";
import { solidPlugin } from "./solid-plugin";
import { virtualModulesPlugin } from "./virtual-modules";

/**
 * Design system server for one standalone page, picked by the first argument:
 * `stories` (component stories, `bun run design`) or `demo` (the App view,
 * `bun run demo`). It bundles that page's entry with Bun.build (in memory,
 * nothing written to disk) and serves it with Bun.serve. Components come
 * straight from apps/web; only the page chrome lives here. The bundle is rebuilt
 * on every top-level page load so a refresh shows current sources. Inspector
 * frames (`/?embed=`) reuse the current bundle instead. Startup opens the page
 * in the default browser only from an interactive local terminal with a display
 * and no agent/CI marker (`isInteractiveDesktop`), matching `bun run dev` and `omp-web`.
 */
const root = dirname(fileURLToPath(import.meta.url));
const VIEWS = {
	stories: { entry: "stories.tsx", portEnv: "OMP_DESIGN_PORT", port: 4799 },
	demo: { entry: "demo.tsx", portEnv: "OMP_DEMO_PORT", port: 4798 },
} as const;
const viewName = process.argv[2];
if (viewName !== "stories" && viewName !== "demo") {
	console.error("usage: bun apps/design-system/server.ts <stories|demo>");
	process.exit(2);
}
const view = VIEWS[viewName];
const port = Number(process.env[view.portEnv] ?? view.port);

interface Bundle {
	js: Blob;
	css: Blob | null;
}

async function build(): Promise<Bundle> {
	const result = await Bun.build({
		entrypoints: [join(root, view.entry)],
		target: "browser",
		conditions: ["browser", "solid"],
		plugins: [solidPlugin, virtualModulesPlugin()],
		// state.ts guards its dev-only `window.__ompState` handle on this; the
		// build-info stamp feeds the sidebar wordmark tooltip and the debug sheet's Build section.
		define: {
			"import.meta.env.DEV": "true",
			"import.meta.env.BASE_URL": JSON.stringify("/"),
			...buildInfoDefines(join(root, "..", "..")),
		},
		sourcemap: "inline",
		minify: false,
	});
	if (!result.success) {
		throw new Error(result.logs.map((log) => String(log)).join("\n") || "bundle failed");
	}
	const js = result.outputs.find((o) => o.kind === "entry-point");
	if (!js) throw new Error("bundle has no entry point output");
	const css = result.outputs.find((o) => o.path.endsWith(".css")) ?? null;
	return { js, css };
}

let bundle: Promise<Bundle> | null = null;

const NO_FLEET = { error: "design system: no fleet behind this server" };

const server = Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);
		const { pathname } = url;
		if (pathname === "/") {
			// A top-level page load starts a fresh build; its assets await the same
			// promise. Inspector frames (`/?embed=`) reuse the current bundle.
			if (!url.searchParams.has("embed") || bundle === null) {
				bundle = build();
				bundle.catch(() => undefined);
			}
			return new Response(Bun.file(join(root, "index.html")), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			});
		}
		if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
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
		// Components fetch fleet endpoints at runtime: answer from fixtures/routes.ts,
		// else a clear 404 instead of the SPA fallback.
		const fixture = await handleFixtureRoute(req);
		if (fixture) return fixture;
		if (/^\/(ctl|auth)(\/|$)/.test(pathname)) {
			return Response.json(NO_FLEET, { status: 404 });
		}
		return new Response("not found", { status: 404 });
	},
});

const url = `http://localhost:${server.port}/`;
console.log(`design ${viewName}: ${url}`);
if (isInteractiveDesktop()) openBrowser(url, `design ${viewName}`);
