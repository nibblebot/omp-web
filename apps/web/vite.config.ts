import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import solidPlugin from "vite-plugin-solid";
import { buildInfoDefines } from "./build/build-info.ts";
import { featureSizes } from "./build/feature-sizes.ts";
import { fleetOrigin } from "./dev-proxy.ts";

// Web root: this config lives at apps/web/vite.config.ts. Root is set
// explicitly (vite defaults root to the invoking cwd, not the config dir),
// so `bun run build:web` works from the repository root.
const webRoot = dirname(fileURLToPath(import.meta.url));

// Dev HMR proxy: /events + /command go to the omp-fleet edge (it serves the
// roster UI and proxies each session's wire API), and /ctl to the fleet
// control plane on the same port. OMP_DEV_FLEET_PORT is picked per-run by
// scripts/dev.ts so parallel worktrees don't collide; the fixed default keeps
// a standalone vite against a manually started `bun apps/fleet/cli.ts` working.
const fleetPort = process.env.OMP_DEV_FLEET_PORT ?? "4722";

// OMP_DEV_ALLOW_HOSTS (set by `--allow-hosts`): "1"/"true"/"*" allows every
// Host header (e.g. tailscale domains); anything else is a comma-separated
// allowlist. Unset keeps vite's default (localhost + .local).
const allowHostsEnv = process.env.OMP_DEV_ALLOW_HOSTS;
const allowedHosts =
	allowHostsEnv === undefined
		? undefined
		: allowHostsEnv === "1" || allowHostsEnv === "true" || allowHostsEnv === "*"
			? true
			: allowHostsEnv
					.split(",")
					.map((h) => h.trim())
					.filter((h) => h.length > 0);

// Proxy target options for one fleet route. changeOrigin sends the fleet a
// loopback Host, which its browser guard admits; the configure hook
// re-presents same-origin requests (a LAN browser's page) as the loopback
// origin. See fleetOrigin for the decision and why cross-site stays refused.
function fleetProxy(): ProxyOptions {
	return {
		target: `http://localhost:${fleetPort}`,
		changeOrigin: true,
		configure: (proxy) => {
			proxy.on("proxyReq", (proxyReq, req) => {
				const origin = fleetOrigin(req.headers.host, req.headers.origin, fleetPort);
				if (origin !== undefined) proxyReq.setHeader("origin", origin);
			});
		},
	};
}

export default defineConfig({
	root: webRoot,
	plugins: [solidPlugin(), featureSizes()],
	// Sidebar footer build identity (omp-web version, git hash, omp version).
	define: buildInfoDefines(join(webRoot, "..", "..")),
	server: {
		port: 4713,
		allowedHosts,
		proxy: {
			// /events is a long-lived SSE stream: http-proxy pipes it through (no ws: true);
			// X-Accel-Buffering asks intermediaries not to buffer the response.
			"/events": { ...fleetProxy(), headers: { "X-Accel-Buffering": "no" } },
			"/command": fleetProxy(),
			// Fleet control plane: same edge port.
			"/ctl": fleetProxy(),
			// Browser-auth surface (P2.4): same-origin sign-in must reach the
			// fleet under HMR too, or the login modal can never work in dev.
			"/auth": fleetProxy(),
		},
	},
	build: {
		// Repository-root dist/: the fleet edge embeds dist/ verbatim and the
		// build script assumes vite owns and wipes it. Absolute so the
		// location never depends on the invoking cwd; emptyOutDir is explicit
		// because the target sits outside the web root.
		outDir: join(webRoot, "..", "..", "dist"),
		emptyOutDir: true,
	},
});
