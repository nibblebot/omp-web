import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// Web root: this config lives at apps/web/vite.config.ts. Root is set
// explicitly (vite defaults root to the invoking cwd, not the config dir),
// so `bun run dev:web` / `bun run build:web` work from the repository root.
const webRoot = dirname(fileURLToPath(import.meta.url));

// Dev HMR proxy: /events + /command go to the omp-fleet edge (it serves the
// roster UI and proxies each session's wire API), and /ctl to the fleet
// control plane on the same port. OMP_DEV_FLEET_PORT is picked per-run by
// scripts/dev.ts so parallel worktrees don't collide; the fixed default keeps
// `bun run dev:web` against a manually started `bun run fleet serve` working.
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

export default defineConfig({
	root: webRoot,
	plugins: [solidPlugin()],
	server: {
		port: 4713,
		allowedHosts,
		proxy: {
			// /events is a long-lived SSE stream: http-proxy pipes it through (no ws: true);
			// X-Accel-Buffering asks intermediaries not to buffer the response.
			"/events": {
				target: `http://localhost:${fleetPort}`,
				headers: { "X-Accel-Buffering": "no" },
			},
			"/command": { target: `http://localhost:${fleetPort}` },
			// Fleet control plane: same edge port.
			"/ctl": { target: `http://localhost:${fleetPort}` },
			// Browser-auth surface (P2.4): same-origin sign-in must reach the
			// fleet under HMR too, or the login modal can never work in dev.
			"/auth": { target: `http://localhost:${fleetPort}` },
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
