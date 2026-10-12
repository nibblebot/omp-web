import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleFixtureRoute } from "./fixtures/routes";
import { solidPlugin } from "./solid-plugin";
import { virtualModulesPlugin } from "./virtual-modules";

/**
 * Design system server: bundles the showcase client with Bun.build (in
 * memory, nothing written to disk) and serves it with Bun.serve. Components
 * come straight from apps/web; only the shell lives here. The bundle is rebuilt on
 * every top-level page load so a refresh shows current sources. Inspector frames
 * (`/?embed=`) reuse the current bundle instead.
 */
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.OMP_DESIGN_PORT ?? 4799);

interface Bundle {
	js: Blob;
	css: Blob | null;
}

async function build(): Promise<Bundle> {
	const result = await Bun.build({
		entrypoints: [join(root, "main.tsx")],
		target: "browser",
		conditions: ["browser", "solid"],
		plugins: [solidPlugin, virtualModulesPlugin()],
		// state.ts guards its dev-only `window.__ompState` handle on this.
		define: { "import.meta.env.DEV": "true", "import.meta.env.BASE_URL": JSON.stringify("/") },
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
	async fetch(req, srv) {
		const url = new URL(req.url);
		const { pathname } = url;
		// The fixture SSE stream pings every 15s (like the fleet edge); Bun's
		// default 10s idle timeout would cut it between pings and force reconnects.
		if (pathname === "/events") srv.timeout(req, 0);
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
		if (/^\/(ctl|auth|events|command)(\/|$)/.test(pathname)) {
			return Response.json(NO_FLEET, { status: 404 });
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(`design system: http://localhost:${server.port}/`);
