import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import solidPlugin from "vite-plugin-solid";
import { buildInfoDefines } from "./build/build-info.ts";
import { failOnWarningsLogger } from "./build/fail-on-warnings.ts";
import { featurePreload } from "./build/feature-preload.ts";
import { featureSizes } from "./build/feature-sizes.ts";
import { precompress } from "./build/precompress.ts";
import { fleetOrigin } from "./dev-proxy.ts";

// Web root: this config lives at apps/web/vite.config.ts. Root is set
// explicitly (vite defaults root to the invoking cwd, not the config dir),
// so `bun run build:web` works from the repository root.
const webRoot = dirname(fileURLToPath(import.meta.url));

// Dev HMR proxy: /ws (the browser socket) goes to the omp-fleet edge (it serves the
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
			const represent = (
				proxyReq: { setHeader(name: string, value: string): unknown },
				req: { headers: { host?: string; origin?: string } },
			): void => {
				const origin = fleetOrigin(req.headers.host, req.headers.origin, fleetPort);
				if (origin !== undefined) proxyReq.setHeader("origin", origin);
			};
			proxy.on("proxyReq", represent);
			proxy.on("proxyReqWs", represent);
		},
	};
}

export default defineConfig(({ command }) => ({
	root: webRoot,
	plugins: [solidPlugin(), featurePreload(), featureSizes(), precompress()],
	// A production build allows no warnings; dev keeps vite's default logger.
	customLogger: command === "build" ? failOnWarningsLogger() : undefined,
	// Sidebar footer build identity (omp-web version, git hash, omp version).
	define: buildInfoDefines(join(webRoot, "..", "..")),
	server: {
		port: 4713,
		allowedHosts,
		proxy: {
			// The browser socket (OMP_PROTO 6): one WebSocket per tab carries the
			// downlink and the command uplink. ws: true makes http-proxy tunnel the
			// upgrade; fleetProxy re-presents the Origin on it via proxyReqWs.
			"/ws": { ...fleetProxy(), ws: true },
			// Fleet control plane: same edge port.
			"/ctl": fleetProxy(),
			// Browser-auth surface: same-origin sign-in must reach the
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
}));
