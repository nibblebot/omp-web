import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [solidPlugin()],
	server: {
		port: 4713,
		proxy: {
			"/ws": { target: "ws://localhost:4711", ws: true },
			"/download": { target: "http://localhost:4711" },
		},
	},
});
