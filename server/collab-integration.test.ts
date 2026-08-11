/**
 * Slice C integration test: the REAL daemon server wired end-to-end with the
 * collab relay and host adapter.
 *
 * Spawns server/index.ts as a subprocess (ephemeral port via OMPD_PORT=0),
 * drives a web client through collab_start → collab_stop, and connects a REAL
 * CollabSocket guest (pi-coding-agent's relay client) to the room: welcome +
 * snapshot-chunks, a guest prompt landing as a custom_message entry frame,
 * and the stop flow (guest `bye` + web {state:"off"}).
 *
 * The subprocess is killed with SIGTERM at the end — the in-process server is
 * NEVER stopped from the test (server.stop() would exit the whole test run).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

const repoRoot = path.resolve(import.meta.dir, "..");

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Poll `probe` on a 50ms interval until it returns non-null; throw on timeout.
 *
 * Real wall-clock polling is deliberate here: this is a subprocess integration
 * test — the awaited events arrive over real WebSocket connections from a real
 * server process, so fake timers cannot drive them.
 */
async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(50);
	}
}

/** Read the server's stdout until the listening line; resolves with the real (ephemeral) port. */
async function readServerPort(stdout: ReadableStream<Uint8Array>, timeoutMs: number): Promise<number> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("timed out waiting for the server to report its port");
		const result = await Promise.race([
			reader.read().then(r => ({ ...r, timedOut: false as const })),
			sleep(remaining).then(() => ({ value: undefined, done: true, timedOut: true as const })),
		]);
		if (result.timedOut) throw new Error("timed out waiting for the server to report its port");
		if (result.done) throw new Error("server exited before reporting its port");
		buffer += decoder.decode(result.value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			// ompd prints the OMPD| listening contract line (JSON) on stdout after bind.
			if (!line.startsWith("OMPD|")) continue;
			try {
				const parsed = JSON.parse(line.slice(5)) as { event?: string; port?: number };
				if (parsed.event === "listening" && typeof parsed.port === "number") return parsed.port;
			} catch {
				// not a contract line — keep waiting
			}
		}
	}
}

type WebFrame = { type: string; [key: string]: unknown };

/** Wire collab_status payload as the web client sees it (subset of CollabWireStatus). */
interface WireCollabStatus {
	state: string;
	error?: string;
	link?: string;
	viewLink?: string;
	relayUrl?: string;
	roomId?: string;
}

function openWebSocket(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const timer = setTimeout(() => reject(new Error("web websocket open timed out")), 15_000);
	ws.onopen = () => {
		clearTimeout(timer);
		resolve(ws);
	};
	ws.onerror = () => {
		clearTimeout(timer);
		reject(new Error("web websocket failed before open"));
	};
	return promise;
}

let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let tmpDir: string | undefined;
const webSockets: WebSocket[] = [];
const guestSockets: CollabSocket[] = [];

afterAll(async () => {
	for (const ws of webSockets) ws.close();
	for (const guest of guestSockets) guest.close();
	if (child) {
		child.kill(); // SIGTERM → the server's graceful shutdown handler runs.
		await Promise.race([child.exited, sleep(15_000)]);
	}
	if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

test("web collab_start → guest join + prompt entry → collab_stop", async () => {
	tmpDir = await mkdtemp(path.join(os.tmpdir(), "omp-web-collab-it-"));
	child = Bun.spawn(["bun", "server/index.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			OMPD_PORT: "0",
			OMPD_CWD: tmpDir,
			PI_NO_TITLE: "1",
			OMPD_COLLAB_MAX_GUESTS: "8",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	// Drain stderr so the pipe never backpressures; keep the tail for diagnostics.
	let stderrTail = "";
	const stderrReader = child.stderr.getReader();
	const stderrDecoder = new TextDecoder();
	const pumpStderr = (): Promise<void> =>
		stderrReader.read().then(result => {
			if (result.done) return;
			stderrTail = (stderrTail + stderrDecoder.decode(result.value)).slice(-4000);
			return pumpStderr();
		});
	void pumpStderr().catch(() => {});

	const port = await readServerPort(child.stdout as ReadableStream<Uint8Array>, 45_000);

	const webFrames: WebFrame[] = [];
	const ws = await openWebSocket(port);
	webSockets.push(ws);
	ws.onmessage = ev => webFrames.push(JSON.parse(String(ev.data)) as WebFrame);

	// Connect = attached on a bare ompd (Phase 6): the priming — attached with
	// the constant guard token, then history/state/collab_status — arrives at
	// open; collab_start targets the attached session directly.
	const attached = await waitFor(() => webFrames.find(f => f.type === "attached") ?? null, 10_000, "attached frame");
	expect(attached.sessionId).toBe("s1");

	// Start collab; collect frames until live (fail fast on an error status).
	webFrames.length = 0;
	ws.send(JSON.stringify({ type: "collab_start" }));
	const liveStatus = await waitFor(() => {
		// The latest collab_status: starting → live (or error) overrides the priming off.
		const frame = webFrames.findLast(f => f.type === "collab_status");
		if (!frame) return null;
		const status = frame.status as WireCollabStatus;
		if (status.state === "error") throw new Error(`collab_start failed: ${status.error}`);
		return status.state === "live" ? status : null;
	}, 20_000, "collab_status live");
	const link = liveStatus.link as string;
	expect(link).toContain("/r/");
	expect(liveStatus.relayUrl).toBe(`ws://localhost:${port}`);

	// Guest: a real CollabSocket with the full (writable) link.
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(`bad collab link: ${parsed.error}`);
	const key = await importRoomKey(parsed.key);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	guestSockets.push(guest);
	const guestFrames: CollabFrame[] = [];
	const guestClose: Array<{ reason: string; willReconnect: boolean }> = [];
	const guestControls: Array<{ t: string }> = [];
	guest.onFrame = frame => guestFrames.push(frame);
	guest.onControl = control => guestControls.push(control);
	guest.onClose = (reason, willReconnect) => guestClose.push({ reason, willReconnect });
	const { promise: opened, resolve: openedResolve, reject: openedReject } = Promise.withResolvers<void>();
	const openTimer = setTimeout(() => openedReject(new Error("guest websocket open timed out")), 15_000);
	guest.onOpen = () => {
		clearTimeout(openTimer);
		openedResolve();
	};
	guest.connect();
	await opened;
	guest.send({
		t: "hello",
		proto: COLLAB_PROTO,
		name: "integration-guest",
		writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
	});

	// Welcome + snapshot chunks until final.
	const welcome = await waitFor(() => {
		const f = guestFrames.find((f): f is Extract<CollabFrame, { t: "welcome" }> => f.t === "welcome");
		return f ?? null;
	}, 10_000, "guest welcome");
	expect(welcome.entryCount).toBeGreaterThanOrEqual(1);
	const chunks = await waitFor(() => {
		const all = guestFrames.filter(f => f.t === "snapshot-chunk");
		if (all.length === 0) return null;
		const last = all.at(-1)!;
		return last.t === "snapshot-chunk" && last.final ? all : null;
	}, 10_000, "final snapshot chunk");
	const chunkEntries = chunks.flatMap(c => (c.t === "snapshot-chunk" ? c.entries : []));
	expect(chunkEntries.length).toBeGreaterThanOrEqual(1);
	expect(chunkEntries.length).toBe(welcome.entryCount);

	// Guest prompt → custom_message entry frame carrying the guest text + name.
	guest.send({ t: "prompt", text: "hello from collab test" });
	const entryFrame = await waitFor(() => {
		const err = guestFrames.find(f => f.t === "error");
		if (err && err.t === "error") throw new Error(`guest received error: ${err.message}`);
		const frame = guestFrames.findLast(f => f.t === "entry");
		if (!frame || frame.t !== "entry") return null;
		const entry = frame.entry;
		if (entry.type !== "custom_message") return null;
		const text =
			typeof entry.content === "string"
				? entry.content
				: entry.content
						.filter(c => c.type === "text")
						.map(c => c.text)
						.join("");
		return text.includes("hello from collab test") ? frame : null;
	}, 15_000, "guest prompt entry frame");
	expect(entryFrame.entry.type).toBe("custom_message");
	const entry = entryFrame.entry;
	if (entry.type !== "custom_message") throw new Error("expected custom_message entry");
	// details: { from: <guest name> } is injected by buildCollabPort's promptFromGuest.
	const details = entry.details as { from?: string } | undefined;
	expect(details?.from).toBe("integration-guest");

	// Stop collab: the web client receives {state:"off"} and the guest is
	// torn down (bye + relay room-closed + fatal 4001 close). The adapter's
	// stop() yields one event-loop turn for the bye's seal to reach the wire
	// before closing the socket; under heavy parallel load that seal can land
	// after the close and the bye is dropped (the adapter documents the race).
	// closeRoom() is authoritative — it ALWAYS sends the TEXT room-closed
	// control and the fatal close — so the bye is the preferred signal and the
	// room teardown is the guaranteed one.
	webFrames.length = 0;
	ws.send(JSON.stringify({ type: "collab_stop" }));
	const stopped = await waitFor<{ bye?: Extract<CollabFrame, { t: "bye" }>; teardown?: true }>(() => {
		const bye = guestFrames.find((f): f is Extract<CollabFrame, { t: "bye" }> => f.t === "bye");
		if (bye) return { bye };
		if (guestClose.length > 0 || guestControls.some(c => c.t === "room-closed")) return { teardown: true };
		return null;
	}, 10_000, "guest bye or room teardown");
	if (stopped.bye) expect(stopped.bye.t).toBe("bye");
	const off = await waitFor(() => {
		const frame = webFrames.findLast(f => f.type === "collab_status");
		if (!frame) return null;
		const status = frame.status as WireCollabStatus;
		return status.state === "off" ? frame : null;
	}, 10_000, "collab_status off");
	expect(off).toBeDefined();
}, 120_000);
