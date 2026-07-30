import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { ServerWebSocket } from "bun";
import type { ClientCommand, ServerFrame } from "../src/protocol";

const pkgEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"));
// → …/node_modules/@oh-my-pi/pi-coding-agent/src/index.ts
const cliPath = path.resolve(path.dirname(pkgEntry), "../dist/cli.js");
if (!existsSync(cliPath)) {
	console.error(`Compiled CLI not found at ${cliPath}; run bun install`);
	process.exit(1);
}

const client = new RpcClient({ cliPath, cwd: process.env.OMP_WEB_CWD ?? process.cwd() });
try {
	await client.start();
} catch (err) {
	console.error("Failed to start agent:", err);
	process.exit(1);
}

const sockets = new Set<ServerWebSocket<unknown>>();

function broadcast(frame: ServerFrame): void {
	const data = JSON.stringify(frame);
	for (const ws of sockets) ws.send(data);
}

// onSessionEvent covers the entire AgentEvent union plus session extras;
// subscribing to onEvent as well would duplicate frames.
client.onSessionEvent(event => broadcast({ type: "event", event }));

function send(ws: ServerWebSocket<unknown>, frame: ServerFrame): void {
	ws.send(JSON.stringify(frame));
}

async function handleCommand(ws: ServerWebSocket<unknown>, raw: string | Buffer): Promise<void> {
	try {
		const cmd = JSON.parse(String(raw)) as ClientCommand;
		switch (cmd.type) {
			case "prompt":
				// Resolves on send ack; the turn itself streams via events.
				await client.prompt(cmd.message);
				break;
			case "abort":
				await client.abort();
				break;
			case "new_session": {
				await client.newSession();
				// Resync every tab, not just the requester.
				broadcast({ type: "history", messages: await client.getMessages() });
				broadcast({ type: "state", state: await client.getState() });
				break;
			}
			default:
				throw new Error(`Unknown command: ${JSON.stringify(cmd)}`);
		}
	} catch (err) {
		send(ws, { type: "error", error: String(err) });
	}
}

const server = Bun.serve({
	port: 4711,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req)) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		const file = Bun.file(url.pathname === "/" ? "dist/index.html" : `dist${url.pathname}`);
		if (!(await file.exists())) return new Response("Not found", { status: 404 });
		return new Response(file);
	},
	websocket: {
		async open(ws) {
			sockets.add(ws);
			send(ws, { type: "history", messages: await client.getMessages() });
			send(ws, { type: "state", state: await client.getState() });
		},
		close(ws) {
			sockets.delete(ws);
		},
		message(ws, raw) {
			void handleCommand(ws, raw);
		},
	},
});

console.log(`omp-web listening on http://localhost:${server.port}`);
