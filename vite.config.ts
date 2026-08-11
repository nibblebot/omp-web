import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [solidPlugin()],
	server: {
		port: 4713,
		proxy: {
			"/ws": { target: "ws://localhost:4721", ws: true },
			"/download": { target: "http://localhost:4721" },
			// Roster-mode control API (omp-fleet edge) — dev against `omp-fleet serve` on 4722.
			"/ctl": { target: "http://localhost:4722" },
		},
	},
});
