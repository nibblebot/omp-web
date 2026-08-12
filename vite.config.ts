import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// OMP_DEV_FLEET=1 (set by `bun run dev:fleet`): proxy /events + /command + /download to the
// omp-fleet edge instead of a standalone omp-session, so the roster UI runs
// under HMR. Either way /ctl goes to the fleet control plane.
const fleet = process.env.OMP_DEV_FLEET === "1";
const sessionTarget = fleet ? "localhost:4722" : "localhost:4721";

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
	plugins: [solidPlugin()],
	server: {
		port: 4713,
		allowedHosts,
		proxy: {
			// /events is a long-lived SSE stream: http-proxy pipes it through (no ws: true);
			// X-Accel-Buffering asks intermediaries not to buffer the response.
			"/events": { target: `http://${sessionTarget}`, headers: { "X-Accel-Buffering": "no" } },
			"/command": { target: `http://${sessionTarget}` },
			"/download": { target: `http://${sessionTarget}` },
			// Roster-mode control API (omp-fleet edge) — dev against `omp-fleet serve` on 4722.
			"/ctl": { target: "http://localhost:4722" },
		},
	},
});
