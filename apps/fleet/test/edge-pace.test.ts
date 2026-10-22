/**
 * Edge priming pace (kata 0tas): a browser attach whose history is far past the
 * edge's byte cap is paced by the browser's drain (stream_open `ack`, stream_ack)
 * instead of being cut mid-priming when the browser drains slower than the
 * daemon writes, while a browser that stopped reading is still dropped and the
 * daemon's burst stays parked upstream (memory in the fleet stays bounded).
 *
 * The daemon is the callback-daemon testkit driving a session-shaped sender that
 * honors the credit window exactly as apps/session/daemon-control.ts does. The
 * browser is a raw socket so the test controls when it reads (pause/resume), so
 * nothing depends on a sleep length. Real sockets are the point: the stall and
 * drain behavior under test is the platform's, not something fake timers reach.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
	ENVELOPE_MAX_BYTES,
	STREAM_ACK_WINDOW_BYTES,
	type CallbackEnvelope,
} from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	cleanupTempDirs,
	serveEdge,
	sleep,
	testEviction,
	testWaker,
	waitFor,
} from "./edge.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";

afterAll(cleanupTempDirs);

const CONFIG: FleetConfig = {
	templates: { local: { command: "true" } },
	defaultTemplate: "local",
	workspaceDir: "/tmp/fleet-test-ws",
	bind: "127.0.0.1",
};

/** 24 MiB of priming: far past the 4 MiB cap plus every kernel socket buffer on the path. */
const FRAMES = 48;
const FRAME_BYTES = 512 * 1024;

interface Rig {
	registry: Registry;
	transport: DaemonTransportRegistry;
	edge: FleetEdge;
	port: number;
	daemons: CallbackDaemon[];
	close(): Promise<void>;
}

async function startRig(opts: { stallMs?: number; keepaliveMs?: number } = {}): Promise<Rig> {
	const dir = tempDir("omp-web-edge-pace-");
	const statePath = join(dir, "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new DaemonTransportRegistry();
	let callbackBase = "";
	const { lifecycle } = makeHostLifecycle({
		registry,
		config: CONFIG,
		transport,
		statePath,
		callbackUrl: () => callbackBase,
	});
	const edge = new FleetEdge(
		{
			registry,
			lifecycle,
			sync: new ProjectSync(registry, lifecycle),
			eviction: testEviction(registry, lifecycle),
			waker: testWaker(registry, lifecycle, transport),
			config: CONFIG,
			eventLog: new FleetEventLog(),
			transport,
			fleet: { port: 0, startedAt: Date.now(), statePath, configPath: null, bind: "127.0.0.1" },
		},
		opts,
	);
	const served = serveEdge(edge, transport);
	callbackBase = `http://127.0.0.1:${served.port}`;
	const daemons: CallbackDaemon[] = [];
	return {
		registry,
		transport,
		edge,
		port: served.port,
		daemons,
		async close() {
			for (const daemon of daemons) await daemon.stop();
			edge.close();
			lifecycle.close();
			transport.close();
			served.stop();
		},
	};
}

async function connectRemote(
	rig: Rig,
	name: string,
): Promise<{ daemonId: string; daemon: CallbackDaemon }> {
	const entry = rig.registry.create({
		name,
		cwd: `/${name}`,
		project: name,
		labels: [],
		status: "connecting",
	});
	const token = randomBytes(32).toString("hex");
	await rig.transport.enrollWorkspace(entry.daemonId, 1, token);
	const daemon = startCallbackDaemon({
		url: `http://127.0.0.1:${rig.port}`,
		workspaceId: entry.daemonId,
		generation: 1,
		token,
	});
	rig.daemons.push(daemon);
	await daemon.waitConnected(5000);
	return { daemonId: entry.daemonId, daemon };
}

/** A browser /events stream on a raw socket: the test decides when it reads. */
class RawBrowser {
	readonly clientId = crypto.randomUUID();
	bytes = 0;
	ready = false;
	readonly ended = Promise.withResolvers<void>();
	isEnded = false;
	readonly #socket: Socket;
	#tail = "";

	constructor(readonly port: number) {
		this.#socket = createConnection({ host: "127.0.0.1", port });
		const end = (): void => {
			this.isEnded = true;
			this.ended.resolve();
		};
		this.#socket.on("data", (chunk: Buffer) => {
			this.bytes += chunk.byteLength;
			const text = this.#tail + chunk.toString("latin1");
			if (text.includes('"type":"ready"')) this.ready = true;
			// The chunked body's terminator: the edge ended the response (the
			// connection itself stays open for keep-alive).
			if (text.includes("\r\n0\r\n\r\n")) end();
			this.#tail = text.slice(-32);
		});
		this.#socket.on("close", end);
		this.#socket.on("end", end);
		this.#socket.on("error", end);
		this.#socket.write(
			`GET /events?client=${this.clientId} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`,
		);
	}

	/** Stop reading: the kernel buffers fill, then the edge's queue does. */
	pause(): void {
		this.#socket.pause();
	}

	resume(): void {
		this.#socket.resume();
	}

	destroy(): void {
		this.#socket.destroy();
	}

	async attach(daemonId: string): Promise<void> {
		const res = await fetch(`http://127.0.0.1:${this.port}/command`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-client-id": this.clientId },
			body: JSON.stringify({ type: "attach", id: crypto.randomUUID(), sessionId: daemonId }),
		});
		if (!res.ok) throw new Error(`attach rejected (HTTP ${res.status})`);
	}
}

function controlType(env: CallbackEnvelope): string | undefined {
	const payload = env.payload;
	if (typeof payload !== "object" || payload === null || !("type" in payload)) return undefined;
	return typeof payload.type === "string" ? payload.type : undefined;
}

/** One field of an envelope's payload object, or undefined. */
function payloadField(env: CallbackEnvelope, key: string): unknown {
	const payload = env.payload;
	return typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined;
}

/** The wire seq a stream_ack control acknowledges. */
function ackedSeq(env: CallbackEnvelope): number {
	const seq = payloadField(env, "seq");
	if (typeof seq !== "number") throw new Error("stream_ack without a numeric seq");
	return seq;
}

function controls(daemon: CallbackDaemon, streamId: string, type: string): CallbackEnvelope[] {
	return daemon
		.received()
		.filter((e) => e.kind === "control" && e.streamId === streamId && controlType(e) === type);
}

/** The stream_open the edge sent for the single browser stream: its id and whether it asked for ack pacing. */
async function openedStream(daemon: CallbackDaemon): Promise<{ streamId: string; ack: boolean }> {
	const open = await waitFor(
		() =>
			daemon.received().find((e) => e.kind === "control" && controlType(e) === "stream_open") ??
			null,
		5000,
		"stream_open",
	);
	return { streamId: open.streamId, ack: payloadField(open, "ack") === true };
}

/**
 * A session-shaped priming burst: `FRAMES` history frames and a closing `ready`.
 * With `honorCredit` it keeps at most the credit window of unacknowledged frames
 * in flight, exactly as the session's paced prime does; without it (an older
 * session) it writes everything at once. `parked` resolves the first time the
 * sender had to wait for credit.
 */
function startPrimer(daemon: CallbackDaemon, streamId: string, honorCredit: boolean) {
	const parked = Promise.withResolvers<void>();
	const inflight: Array<{ seq: number; bytes: number }> = [];
	let acked = 0;
	let sentBytes = 0;
	let finished = false;
	let stopped = false;
	const pad = "x".repeat(FRAME_BYTES);
	const refresh = (): void => {
		for (const env of controls(daemon, streamId, "stream_ack")) {
			acked = Math.max(acked, ackedSeq(env));
		}
		while (inflight.length > 0 && inflight[0]!.seq <= acked) inflight.shift();
		if (controls(daemon, streamId, "stream_close").length > 0) stopped = true;
	};
	const run = (async () => {
		try {
			await burst();
		} finally {
			finished = true;
		}
	})();
	async function burst(): Promise<void> {
		for (let i = 0; i < FRAMES && !stopped; i++) {
			if (honorCredit) {
				for (;;) {
					refresh();
					const unacked = inflight.reduce((sum, f) => sum + f.bytes, 0);
					if (stopped || unacked + ENVELOPE_MAX_BYTES <= STREAM_ACK_WINDOW_BYTES) break;
					parked.resolve();
					await sleep(5);
				}
				if (stopped) return;
			}
			const seq = daemon.send(streamId, "frame", { type: "history", chunk: i, pad });
			inflight.push({ seq, bytes: FRAME_BYTES });
			sentBytes += FRAME_BYTES;
		}
		if (!stopped) daemon.send(streamId, "frame", { type: "ready" });
	}
	return {
		parked: parked.promise,
		run,
		get sentBytes() {
			return sentBytes;
		},
		get finished() {
			return finished;
		},
		stop() {
			stopped = true;
		},
	};
}

describe("edge priming pace", () => {
	test("a browser that is not reading holds the daemon's burst at the credit window instead of being cut; it then receives every frame", async () => {
		const rig = await startRig();
		const browser = new RawBrowser(rig.port);
		try {
			const { daemonId, daemon } = await connectRemote(rig, "paced");
			browser.pause();
			await browser.attach(daemonId);
			const { streamId, ack } = await openedStream(daemon);
			expect(ack).toBe(true);
			const primer = startPrimer(daemon, streamId, true);
			// The burst runs into the credit window while the browser reads nothing:
			// upstream backpressure, not an edge-side queue growing toward the cap.
			await primer.parked;
			expect(primer.finished).toBe(false);
			expect(primer.sentBytes).toBeLessThan(FRAMES * FRAME_BYTES);
			expect(browser.isEnded).toBe(false);
			expect(controls(daemon, streamId, "stream_close")).toHaveLength(0);
			// The browser starts reading: the whole priming arrives, no stream_reset-less EOF.
			browser.resume();
			await primer.run;
			await waitFor(() => (browser.ready ? true : null), 20_000, "ready frame");
			expect(browser.isEnded).toBe(false);
			expect(browser.bytes).toBeGreaterThanOrEqual(FRAMES * FRAME_BYTES);
			expect(controls(daemon, streamId, "stream_close")).toHaveLength(0);
			// The edge acknowledged as the queue drained, cumulatively and in order.
			const seqs = controls(daemon, streamId, "stream_ack").map(ackedSeq);
			expect(seqs.length).toBeGreaterThan(FRAMES / 4);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);

	test("a browser that stops reading is dropped after the stall limit, while the daemon's burst stays parked", async () => {
		const rig = await startRig({ stallMs: 150, keepaliveMs: 25 });
		const browser = new RawBrowser(rig.port);
		try {
			const { daemonId, daemon } = await connectRemote(rig, "stuck");
			browser.pause();
			await browser.attach(daemonId);
			const { streamId } = await openedStream(daemon);
			const primer = startPrimer(daemon, streamId, true);
			await primer.parked;
			// The edge ends the stream and tells the daemon; nothing keeps it open.
			await waitFor(
				() => (controls(daemon, streamId, "stream_close").length > 0 ? true : null),
				10_000,
				"stream_close after the stall limit",
			);
			await primer.run;
			expect(primer.finished).toBe(true);
			expect(primer.sentBytes).toBeLessThan(FRAMES * FRAME_BYTES);
			// The cut is the existing drop-and-resume: buffered bytes flush, then a clean end.
			browser.resume();
			await browser.ended.promise;
			expect(browser.ready).toBe(false);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);

	test("a daemon that ignores the credit window still hits the cap drop", async () => {
		const rig = await startRig();
		const browser = new RawBrowser(rig.port);
		try {
			const { daemonId, daemon } = await connectRemote(rig, "ignoring");
			browser.pause();
			await browser.attach(daemonId);
			const { streamId, ack } = await openedStream(daemon);
			expect(ack).toBe(true);
			const primer = startPrimer(daemon, streamId, false);
			await primer.run;
			await waitFor(
				() => (controls(daemon, streamId, "stream_close").length > 0 ? true : null),
				10_000,
				"stream_close after the cap drop",
			);
			browser.resume();
			await browser.ended.promise;
			expect(browser.ready).toBe(false);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);
});
