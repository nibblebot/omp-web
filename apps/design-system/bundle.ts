import { join } from "node:path";
import { buildInfoDefines } from "../web/build/build-info";
import { solidPlugin } from "./solid-plugin";
import { virtualModulesPlugin } from "./virtual-modules";

/**
 * The one Bun.build configuration of the design system pages, shared by the dev
 * server (`server.ts`, in memory, rebuilt per page load) and the static demo
 * build (`build.ts`, written to disk for GitHub Pages). Both produce
 * `main.js` and `main.css` next to `index.html`, which loads them by relative
 * URL so the page works under any path. The bundled web fonts (fontsource, via
 * apps/web/styles.css) ride along: Bun inlines every font file under 128 KB as a
 * data URL in `main.css` and emits only the larger ones (Noto Sans Latin
 * Extended) under `assets/`, which both the dev server and the static build serve.
 */
export const root = import.meta.dir;
const repoRoot = join(root, "..", "..");

export const VIEWS = {
	stories: { entry: "stories.tsx", portEnv: "OMP_DESIGN_PORT", port: 4799 },
	demo: { entry: "demo.tsx", portEnv: "OMP_DEMO_PORT", port: 4798 },
} as const;
export type ViewName = keyof typeof VIEWS;

/**
 * `dev`: readable output with an inline sourcemap and the dev-only
 * `window.__ompState` handle. `static`: minified, no sourcemap, no dev handle.
 * Minifying keeps the inspector working: component ids are string literals
 * registered against function identity (solid-plugin.ts), never `Function.name`.
 */
export type BundleMode = "dev" | "static";

export function bundleConfig(view: ViewName, mode: BundleMode): Bun.BuildConfig {
	return {
		entrypoints: [join(root, VIEWS[view].entry)],
		target: "browser",
		conditions: ["browser", "solid"],
		plugins: [solidPlugin, virtualModulesPlugin()],
		// state.ts guards its dev-only `window.__ompState` handle on DEV; the
		// build-info stamp feeds the sidebar wordmark tooltip and the debug sheet's Build section.
		// BASE_URL stays "/": the page's root-relative fetches never leave the page
		// (session.ts answers them in-page), so they need no deployment prefix.
		define: {
			"import.meta.env.DEV": JSON.stringify(mode === "dev"),
			"import.meta.env.BASE_URL": JSON.stringify("/"),
			...buildInfoDefines(repoRoot),
		},
		naming: { entry: "main.[ext]", asset: "assets/[name]-[hash].[ext]" },
		sourcemap: mode === "dev" ? "inline" : "none",
		minify: mode === "static",
	};
}
