import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [solidPlugin()],
	server: {
		port: 4713,
		proxy: {
			"/ws": { target: "ws://localhost:4721", ws: true },
			"/download": { target: "http://localhost:4721" },
			// Roster-mode control API (orchestrator edge) — dev against `omp-orchestrator serve` on 4722.
			"/ctl": { target: "http://localhost:4722" },
		},
	},
});
