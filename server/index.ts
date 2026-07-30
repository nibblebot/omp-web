import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSubagentSubscriptionLevel } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ServerWebSocket } from "bun";
import type { ClientCommand, RpcMethodName, ServerFrame, SessionListEntry } from "../src/protocol";

const pkgEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"));
// → …/node_modules/@oh-my-pi/pi-coding-agent/src/index.ts
const cliPath = path.resolve(path.dirname(pkgEntry), "../dist/cli.js");
if (!existsSync(cliPath)) {
	console.error(`Compiled CLI not found at ${cliPath}; run bun install`);
	process.exit(1);
}

const cwd = process.env.OMP_WEB_CWD ?? process.cwd();
const client = new RpcClient({ cliPath, cwd });
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

function send(ws: ServerWebSocket<unknown>, frame: ServerFrame): void {
	ws.send(JSON.stringify(frame));
}

async function broadcastState(withStats = false): Promise<void> {
	const state = await client.getState();
	const stats = withStats ? await client.getSessionStats() : undefined;
	broadcast({ type: "state", state, stats });
}

async function broadcastHistory(): Promise<void> {
	broadcast({ type: "history", messages: await client.getMessages() });
}

// onSessionEvent covers the entire AgentEvent union plus session extras;
// subscribing to onEvent as well would duplicate frames.
client.onSessionEvent(event => {
	broadcast({ type: "event", event });
	// Tokens/cost/context/queue counts all change at turn end.
	if (event.type === "agent_end") void broadcastState(true).catch(() => {});
});

client.onAvailableCommandsUpdate(commands => broadcast({ type: "available_commands", commands }));

// Subagent payloads are JSON-safe snapshots per rpc-types; drop a frame rather
// than kill the relay if one ever isn't serializable.
for (const [on, type] of [
	[client.onSubagentLifecycle.bind(client), "subagent_lifecycle"],
	[client.onSubagentProgress.bind(client), "subagent_progress"],
	[client.onSubagentEvent.bind(client), "subagent_event"],
] as const) {
	on(payload => {
		try {
			broadcast({ type, payload });
		} catch (err) {
			console.error(`Dropping unserializable ${type} frame:`, err);
		}
	});
}

type Images = ImageContent[] | undefined;

// Read-only calls skip the post-mutation state broadcast.
const READ_ONLY: Partial<Record<RpcMethodName, true>> = {
	getSessionStats: true,
	getAvailableModels: true,
	getBranchMessages: true,
	getLoginProviders: true,
	getSubagents: true,
};

// Calls that replace the transcript; every tab resyncs, not just the requester.
const HISTORY_RELOAD: Partial<Record<RpcMethodName, true>> = { newSession: true, switchSession: true, branch: true };

const RPC_METHODS: Record<RpcMethodName, (args: unknown[]) => Promise<unknown>> = {
	prompt: a => client.prompt(a[0] as string, a[1] as Images),
	steer: a => client.steer(a[0] as string, a[1] as Images),
	followUp: a => client.followUp(a[0] as string, a[1] as Images),
	abort: () => client.abort(),
	abortAndPrompt: a => client.abortAndPrompt(a[0] as string, a[1] as Images),
	newSession: a => client.newSession(a[0] as string | undefined),
	compact: a => client.compact(a[0] as string | undefined),
	setModel: a => client.setModel(a[0] as string, a[1] as string),
	cycleModel: () => client.cycleModel(),
	getAvailableModels: () => client.getAvailableModels(),
	setThinkingLevel: a => client.setThinkingLevel(a[0] as ThinkingLevel),
	cycleThinkingLevel: () => client.cycleThinkingLevel(),
	setSteeringMode: a => client.setSteeringMode(a[0] as "all" | "one-at-a-time"),
	setFollowUpMode: a => client.setFollowUpMode(a[0] as "one-at-a-time"),
	setAutoCompaction: a => client.setAutoCompaction(a[0] as boolean),
	setAutoRetry: a => client.setAutoRetry(a[0] as boolean),
	abortRetry: () => client.abortRetry(),
	bash: a => client.bash(a[0] as string),
	abortBash: () => client.abortBash(),
	getSessionStats: () => client.getSessionStats(),
	exportHtml: a => client.exportHtml(a[0] as string | undefined),
	switchSession: a => client.switchSession(a[0] as string),
	branch: a => client.branch(a[0] as string),
	getBranchMessages: () => client.getBranchMessages(),
	getLoginProviders: () => client.getLoginProviders(),
	setSubagentSubscription: a => client.setSubagentSubscription(a[0] as RpcSubagentSubscriptionLevel),
	getSubagents: () => client.getSubagents(),
};

const LIST_FILES_SKIP: Record<string, true> = { ".git": true, node_modules: true };
const LIST_FILES_CEILING = 10_000;

async function listFiles(query: string, limit: number): Promise<string[]> {
	const entries: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		if (entries.length >= LIST_FILES_CEILING) return;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip
		}
		for (const d of dirents) {
			if (entries.length >= LIST_FILES_CEILING) return;
			if (LIST_FILES_SKIP[d.name]) continue;
			const rel = prefix ? `${prefix}/${d.name}` : d.name;
			if (d.isDirectory()) await walk(path.join(dir, d.name), rel);
			else entries.push(rel);
		}
	};
	await walk(cwd, "");
	const q = query.toLowerCase();
	return entries.filter(f => f.toLowerCase().includes(q)).slice(0, limit);
}

async function handleCommand(ws: ServerWebSocket<unknown>, raw: string | Buffer): Promise<void> {
	let cmd: ClientCommand;
	try {
		cmd = JSON.parse(String(raw)) as ClientCommand;
	} catch {
		send(ws, { type: "error", error: "Malformed command frame" });
		return;
	}
	try {
		switch (cmd.type) {
			case "call": {
				const method = RPC_METHODS[cmd.method];
				if (!method) throw new Error(`Unknown RPC method: ${cmd.method}`);
				const data = await method(cmd.args ?? []);
				// Post-mutation resync is best-effort: the mutation already
				// succeeded, so a resync failure must not fail the call.
				const resync = async () => {
					try {
						if (HISTORY_RELOAD[cmd.method]) await broadcastHistory();
						if (HISTORY_RELOAD[cmd.method] || !READ_ONLY[cmd.method]) await broadcastState();
					} catch (err) {
						console.error("Post-mutation resync failed:", err);
						broadcast({ type: "error", error: `resync failed: ${String(err)}` });
					}
				};
				if (HISTORY_RELOAD[cmd.method]) {
					// Resync BEFORE the call_result: picker success UI (notices,
					// modal close) must run after the transcript is replaced.
					await resync();
					send(ws, { type: "call_result", id: cmd.id, ok: true, data });
				} else {
					send(ws, { type: "call_result", id: cmd.id, ok: true, data });
					await resync();
				}
				break;
			}
			case "list_sessions": {
				const infos = await listAllSessions();
				const sessions: SessionListEntry[] = infos
					.map(i => ({
						path: i.path,
						id: i.id,
						name: i.title,
						cwd: i.cwd,
						modifiedAt: i.modified.getTime(),
						messageCount: i.messageCount,
					}))
					.sort((x, y) => y.modifiedAt - x.modifiedAt)
					.slice(0, 200);
				send(ws, { type: "sessions", sessions });
				break;
			}
			case "list_files": {
				send(ws, { type: "files", files: await listFiles(cmd.query, cmd.limit ?? 50) });
				break;
			}
			default:
				throw new Error(`Unknown command: ${JSON.stringify(cmd)}`);
		}
	} catch (err) {
		if (cmd.type === "call") send(ws, { type: "call_result", id: cmd.id, ok: false, error: String(err) });
		else send(ws, { type: "error", error: String(err) });
	}
}

// /download streams a server-side file (used by /export). The only trust
// boundary on this unauthenticated server: the canonical (realpath) target
// must live inside the system temp dir, the agent cwd (where bare-filename
// exports land), or the current session file's directory. Canonicalizing both
// sides closes symlink escapes that a lexical prefix check would miss.
async function canonicalRoots(): Promise<string[]> {
	const roots = [os.tmpdir(), cwd];
	try {
		const sessionFile = (await client.getState()).sessionFile;
		if (sessionFile) roots.push(path.dirname(sessionFile));
	} catch {
		// State unavailable: tmpdir + cwd only.
	}
	const out: string[] = [];
	for (const root of roots) {
		out.push(await realpath(root).catch(() => root));
	}
	return out;
}

function isInside(resolved: string, roots: string[]): boolean {
	return roots.some(root => {
		const rel = path.relative(root, resolved);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

const server = Bun.serve({
	port: 4711,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req)) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (url.pathname === "/download") {
			const requested = url.searchParams.get("path");
			if (!requested) return new Response("Missing path", { status: 400 });
			// Relative export paths are written by the agent into its cwd.
			const canonical = await realpath(path.resolve(cwd, requested)).catch(() => null);
			if (!canonical) return new Response("Not found", { status: 404 });
			const fileStat = await stat(canonical).catch(() => null);
			if (!fileStat?.isFile()) return new Response("Not found", { status: 404 });
			if (!isInside(canonical, await canonicalRoots())) return new Response("Forbidden", { status: 403 });
			return new Response(Bun.file(canonical));
		}
		const file = Bun.file(url.pathname === "/" ? "dist/index.html" : `dist${url.pathname}`);
		if (!(await file.exists())) return new Response("Not found", { status: 404 });
		return new Response(file);
	},
	websocket: {
		async open(ws) {
			sockets.add(ws);
			send(ws, { type: "history", messages: await client.getMessages() });
			const state = await client.getState();
			const stats = await client.getSessionStats();
			send(ws, { type: "state", state, stats });
			send(ws, { type: "available_commands", commands: await client.getAvailableCommands() });
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
