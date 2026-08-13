#!/usr/bin/env bun
/**
 * Collab CLI: start (or stop) the collab room for the daemon's session and
 * print the `omp join` links — no browser needed.
 *
 *   bun server/collab-cli.ts                 # start collab, print write + view links
 *   bun server/collab-cli.ts --join          # …and immediately `omp join` the write link
 *   bun server/collab-cli.ts --view --join   # …join with the read-only (view) link
 *   bun server/collab-cli.ts --stop          # stop the collab room
 *   bun server/collab-cli.ts --port 4721     # daemon HTTP port (env OMP_SESSION_PORT also works)
 *
 * The daemon must be running (`bun dev:server`). Connect = attached on a
 * bare omp-session: the /events stream primes the single boot session's
 * collab status on open. The room link is generated server-side on
 * collab_start; this client drives the same OMP_PROTO 2 transport the web UI
 * uses (GET /events down, POST /command up).
 */

import { spawn } from "bun";
import type { ClientCommand, CollabWireStatus, ServerFrame } from "../shared/protocol";
import { parseSseUnits, SSE_PING_EVENT } from "../shared/sse";

interface Options {
	port: number;
	join: boolean;
	view: boolean;
	stop: boolean;
}

function usage(): string {
	return `Usage: bun server/collab-cli.ts [--join] [--view] [--stop] [--port <port>]`;
}

function parseArgs(argv: string[]): Options | null {
	const opts: Options = { port: Number(process.env.OMP_SESSION_PORT ?? 4721), join: false, view: false, stop: false };
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

/**
 * Open the daemon's /events stream; connect = attached (single boot session).
 * Resolves once the stream is established; frames accumulate on the returned
 * collector as they arrive. Loopback is R14-exempt, so no token is needed.
 */
function openEvents(port: number): Promise<{ close: () => void; frames: FrameCollector }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ close: () => void; frames: FrameCollector }>();
	const controller = new AbortController();
	const frames: FrameCollector = { statuses: [], errors: [] };
	const timer = setTimeout(() => {
		controller.abort();
		reject(
			new Error(
				`timed out connecting to http://127.0.0.1:${port}/events — is the daemon running? (bun dev:server; port from --port or OMP_SESSION_PORT)`,
			),
		);
	}, 5_000);
	void (async () => {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
			if (!res.ok || !res.body) throw new Error(`GET /events returned ${res.status}`);
			clearTimeout(timer);
			resolve({ close: () => controller.abort(), frames });
			for await (const unit of parseSseUnits(res.body)) {
				if (unit.kind !== "event" || unit.event === SSE_PING_EVENT) continue;
				const frame = JSON.parse(unit.data) as ServerFrame;
				if (frame.type === "collab_status") frames.statuses.push(frame.status);
				else if (frame.type === "error") frames.errors.push(frame.error);
			}
		} catch (err) {
			if (controller.signal.aborted) return; // close() — expected teardown
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	})();
	return promise;
}

interface FrameCollector {
	statuses: CollabWireStatus[];
	errors: string[];
}

/** POST one command; every command carries an id (idempotency/dedup). */
async function send(port: number, cmd: ClientCommand): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}/command`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(cmd),
	});
	if (!res.ok) throw new Error(`POST /command returned ${res.status}`);
}

function printLinks(roomId: string, link: string, viewLink: string): void {
	console.log(`room: ${roomId}`);
	console.log(`omp join ${link}`);
	console.log(`omp join ${viewLink}  # read-only (view)`);
}

/**
 * Poll the collector until the collab room is live. The open priming carries
 * the current status, so an already-live room prints immediately; otherwise
 * collab_start transitions off → live. Throws on collab_status error frames,
 * global error frames that arrive AFTER our collab_start was sent (except
 * the already-active notice), and timeout. `errorBase` is the collector's
 * error count at the moment collab_start was sent — global errors the
 * daemon broadcasts for UNRELATED failures (fireAndForgetPrompt, resync,
 * non-call commands) must not be read as collab_start failures (#17);
 * collab failures proper arrive as collab_status error frames above.
 */
async function awaitLiveRoom(
	frames: FrameCollector,
	errorBase: number,
	timeoutMs: number,
	port: number,
): Promise<Extract<CollabWireStatus, { state: "live" }>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const status of frames.statuses) {
			if (status.state === "live") return status;
			if (status.state === "error") throw new Error(`collab_start failed: ${status.error}`);
		}
		const error = frames.errors.length > errorBase ? frames.errors.at(-1) : undefined;
		if (error && !error.includes("collab already active for this session")) {
			throw new Error(`collab_start failed: ${error}`);
		}
		// "collab already active": another client started the room — the live
		// status arrives via the adapter's onStatusChange broadcast, so just wait.
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

	const { close, frames } = await openEvents(opts.port);

	if (opts.stop) {
		await send(opts.port, { type: "collab_stop", id: crypto.randomUUID() });
		// #17: correlate global error frames only after our collab_stop was
		// sent — the daemon broadcasts global errors for unrelated failures
		// (fireAndForgetPrompt, resync, non-call commands) too.
		const errorBase = frames.errors.length;
		let sawActive = false;
		try {
			await waitUntil(
				() => {
					if (frames.statuses.some(s => s.state === "live" || s.state === "starting")) sawActive = true;
					const error = frames.errors.length > errorBase ? frames.errors.at(-1) : undefined;
					if (error?.includes("collab is not active")) return true;
					if (frames.statuses.some(s => s.state === "off" && sawActive)) return true;
					if (error && !error.includes("collab is not active")) throw new Error(`collab_stop failed: ${error}`);
					return false;
				},
				10_000,
				() => new Error("timed out waiting for the collab room to stop"),
			);
		} catch (err) {
			console.error(String(err));
			close();
			return 1;
		}
		if (frames.errors.slice(errorBase).some(e => e.includes("collab is not active"))) console.log("collab is not active");
		else console.log("collab stopped");
		close();
		return 0;
	}

	// Start: the first status is the open priming (off or live); a room that
	// is already live prints immediately. Otherwise collab_start transitions
	// off → live/error.
	await send(opts.port, { type: "collab_start", id: crypto.randomUUID() });
	// #17: only errors that arrive after collab_start was sent can be this
	// CLI's failure; pre-existing global errors (from other activity on the
	// daemon) are not.
	const errorBase = frames.errors.length;
	let live: Extract<CollabWireStatus, { state: "live" }>;
	try {
		live = await awaitLiveRoom(frames, errorBase, 10_000, opts.port);
	} catch (err) {
		console.error(String(err));
		close();
		return 1;
	}
	close();

	printLinks(live.roomId, live.link, live.viewLink);

	if (opts.join) {
		const link = opts.view ? live.viewLink : live.link;
		console.error(`\nOpening: omp join ${link}`);
		const child = spawn(["omp", "join", link], { stdio: ["inherit", "inherit", "inherit"] });
		return await child.exited;
	}
	return 0;
}

async function waitUntil(cond: () => boolean, timeoutMs: number, fail: () => Error): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await Bun.sleep(50);
	}
	throw fail();
}

const exitCode = await main();
process.exit(exitCode);
