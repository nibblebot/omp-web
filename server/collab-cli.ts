#!/usr/bin/env bun
/**
 * Collab CLI: start (or stop) the collab room for a daemon session and print
 * the `omp join` links — no browser needed.
 *
 *   bun server/collab-cli.ts                 # start collab, print write + view links
 *   bun server/collab-cli.ts --join          # …and immediately `omp join` the write link
 *   bun server/collab-cli.ts --view --join   # …join with the read-only (view) link
 *   bun server/collab-cli.ts --stop          # stop the collab room
 *   bun server/collab-cli.ts --session s2    # act on handle s2 (default: the last session)
 *   bun server/collab-cli.ts --list          # list live sessions (handles) for --session
 *   bun server/collab-cli.ts --port 4711     # daemon WS port (env OMP_WEB_PORT also works)
 *
 * The daemon must be running (`bun dev:server`). The room link is generated
 * server-side on collab_start; this client drives the same WS protocol the
 * web UI uses.
 */

import { spawn } from "bun";
import type { ClientCommand, CollabWireStatus, LiveSessionEntry, ServerFrame } from "../src/protocol";

interface Options {
	port: number;
	session: string | null;
	join: boolean;
	view: boolean;
	stop: boolean;
	list: boolean;
}

function usage(): string {
	return `Usage: bun server/collab-cli.ts [--join] [--view] [--stop] [--list] [--session <handle>] [--port <port>]`;
}

function parseArgs(argv: string[]): Options | null {
	const opts: Options = { port: Number(process.env.OMP_WEB_PORT ?? 4711), session: null, join: false, view: false, stop: false, list: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--join":
				opts.join = true;
				break;
			case "--view":
				opts.view = true;
				break;
			case "--stop":
				opts.stop = true;
				break;
			case "--list":
				opts.list = true;
				break;
			case "--session": {
				const value = argv[++i];
				if (!value) return null;
				opts.session = value;
				break;
			}
			case "--port": {
				const value = argv[++i];
				if (!value || !/^\d+$/.test(value)) return null;
				opts.port = Number(value);
				break;
			}
			case "-h":
			case "--help":
				console.log(usage());
				process.exit(0);
				break;
			default:
				console.error(`Unknown flag: ${arg}\n${usage()}`);
				process.exit(1);
		}
	}
	return opts;
}

/** Open the daemon's /ws socket; auto-attaches to the most recent session. */
function openSocket(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	let settled = false;
	const settle = (err: Error | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (err) reject(err);
		else resolve(ws);
	};
	const timer = setTimeout(() => {
		ws.close();
		settle(new Error(`timed out connecting to ws://127.0.0.1:${port}/ws — is the daemon running? (bun dev:server; port from --port or OMP_WEB_PORT)`));
	}, 5_000);
	ws.onopen = () => settle(null);
	ws.onerror = () => {};
	ws.onclose = () => settle(new Error(`connection to ws://127.0.0.1:${port}/ws closed before opening`));
	return promise;
}

interface FrameCollector {
	statuses: CollabWireStatus[];
	errors: string[];
	sessions: LiveSessionEntry[];
	sessionId: string | null;
}

function collect(ws: WebSocket): FrameCollector {
	const c: FrameCollector = { statuses: [], errors: [], sessions: [], sessionId: null };
	ws.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as ServerFrame;
		if (frame.type === "attached") c.sessionId = frame.sessionId;
		else if (frame.type === "collab_status") c.statuses.push(frame.status);
		else if (frame.type === "error") c.errors.push(frame.error);
		else if (frame.type === "live_sessions") c.sessions = frame.sessions;
	};
	return c;
}

function send(ws: WebSocket, cmd: ClientCommand): void {
	ws.send(JSON.stringify(cmd));
}

function printLinks(roomId: string, link: string, viewLink: string): void {
	console.log(`room: ${roomId}`);
	console.log(`omp join ${link}`);
	console.log(`omp join ${viewLink}  # read-only (view)`);
}

async function waitUntil(cond: () => boolean, timeoutMs: number, fail: () => Error): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await Bun.sleep(50);
	}
	throw fail();
}

/**
 * Poll the collector until the collab room is live. Handles the already-active
 * race by re-attaching to re-prime the current status; throws on error
 * statuses, global error frames, and timeout.
 */
async function awaitLiveRoom(
	ws: WebSocket,
	c: FrameCollector,
	timeoutMs: number,
	port: number,
): Promise<Extract<CollabWireStatus, { state: "live" }>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const status of c.statuses) {
			if (status.state === "live") return status;
			if (status.state === "error") throw new Error(`collab_start failed: ${status.error}`);
		}
		const error = c.errors.at(-1);
		if (error?.includes("collab already active for this session")) {
			// The primed live frame lost a race with the rejection; re-attach
			// to re-prime the current status.
			send(ws, { type: "attach", sessionId: c.sessionId ?? "" });
		} else if (error) {
			throw new Error(`collab_start failed: ${error}`);
		}
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for the collab room (is the daemon on port ${port}?)`);
}

async function main(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts) {
		console.error(usage());
		return 1;
	}

	const ws = await openSocket(opts.port);
	const c = collect(ws);

	if (opts.list) {
		send(ws, { type: "list_live_sessions" });
		try {
			await waitUntil(
				() => c.sessions.length > 0 || c.errors.length > 0,
				5_000,
				() => new Error("timed out waiting for the session roster"),
			);
		} catch (err) {
			console.error(String(err));
			ws.close();
			return 1;
		}
		if (c.errors.length > 0) {
			console.error(`list_live_sessions failed: ${c.errors.at(-1)}`);
			ws.close();
			return 1;
		}
		for (const s of c.sessions) {
			console.log(`${s.sessionId}\t${s.name ?? "(unnamed)"}\t${s.cwd}${s.isStreaming ? "\tstreaming" : ""}`);
		}
		ws.close();
		return 0;
	}

	if (opts.session) {
		send(ws, { type: "attach", sessionId: opts.session });
	}

	if (opts.stop) {
		send(ws, { type: "collab_stop" });
		let sawActive = false;
		try {
			await waitUntil(
				() => {
					if (c.statuses.some(s => s.state === "live" || s.state === "starting")) sawActive = true;
					const error = c.errors.at(-1);
					if (error?.includes("collab is not active")) return true;
					if (c.statuses.some(s => s.state === "off" && sawActive)) return true;
					if (error && !error.includes("collab is not active")) throw new Error(`collab_stop failed: ${error}`);
					return false;
				},
				10_000,
				() => new Error("timed out waiting for the collab room to stop"),
			);
		} catch (err) {
			console.error(String(err));
			ws.close();
			return 1;
		}
		if (c.errors.some(e => e.includes("collab is not active"))) console.log("collab is not active");
		else console.log("collab stopped");
		ws.close();
		return 0;
	}

	// Start: the first status is the attach priming (off or live); a room that
	// is already live prints immediately. Otherwise collab_start transitions
	// off → live/error.
	send(ws, { type: "collab_start" });
	let live: Extract<CollabWireStatus, { state: "live" }>;
	try {
		live = await awaitLiveRoom(ws, c, 10_000, opts.port);
	} catch (err) {
		console.error(String(err));
		ws.close();
		return 1;
	}
	ws.close();

	printLinks(live.roomId, live.link, live.viewLink);

	if (opts.join) {
		const link = opts.view ? live.viewLink : live.link;
		console.error(`\nOpening: omp join ${link}`);
		const child = spawn(["omp", "join", link], { stdio: ["inherit", "inherit", "inherit"] });
		return await child.exited;
	}
	return 0;
}

const exitCode = await main();
process.exit(exitCode);
