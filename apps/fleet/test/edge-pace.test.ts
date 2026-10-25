/**
 * Edge priming pace (kata 0tas): a browser attach whose history is far past the
 * edge's byte cap is paced by the browser's drain (stream_open ack pacing,
 * stream_ack) instead of being cut mid-priming when the browser drains slower
 * than the session writes, while a browser that stopped reading is still dropped
 * and the session's burst stays parked upstream (memory in the fleet stays
 * bounded).
 *
 * The session is the callback-session testkit driving a session-shaped sender that
 * honors the credit window exactly as apps/session/session-control.ts does. The
 * browser is a raw socket so the test controls when it reads (pause/resume), so
 * nothing depends on a sleep length. Real sockets are the point: the stall and
 * drain behavior under test is the platform's, not something fake timers reach.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	ENVELOPE_MAX_BYTES,
	STREAM_ACK_WINDOW_BYTES,
	type CallbackEnvelope,
} from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { SessionTransportRegistry } from "../session-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import { type CallbackSession, startCallbackSession } from "./callback-session.testkit";
import {
	cleanupTempDirs,
	serveEdge,
	sleep,
	testEviction,
	testWaker,
	waitFor,
} from "./edge.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import { RawBrowserSocket } from "./raw-browser-socket.testkit";

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
	transport: SessionTransportRegistry;
	edge: FleetEdge;
	port: number;
	sessions: CallbackSession[];
	close(): Promise<void>;
}

async function startRig(opts: { stallMs?: number; keepaliveMs?: number } = {}): Promise<Rig> {
	const dir = tempDir("omp-web-edge-pace-");
	const statePath = join(dir, "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new SessionTransportRegistry();
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
	const sessions: CallbackSession[] = [];
	return {
		registry,
		transport,
		edge,
		port: served.port,
		sessions,
		async close() {
			for (const session of sessions) await session.stop();
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
): Promise<{ workspaceId: string; session: CallbackSession }> {
	const entry = rig.registry.create({
		name,
		cwd: `/${name}`,
		project: name,
		status: "connecting",
	});
	const token = randomBytes(32).toString("hex");
	await rig.transport.enrollWorkspace(entry.workspaceId, 1, token);
	const session = startCallbackSession({
		url: `http://127.0.0.1:${rig.port}`,
		workspaceId: entry.workspaceId,
		generation: 1,
		token,
	});
	rig.sessions.push(session);
	await session.waitConnected(5000);
	return { workspaceId: entry.workspaceId, session };
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

function controls(session: CallbackSession, streamId: string, type: string): CallbackEnvelope[] {
	return session
		.received()
		.filter((e) => e.kind === "control" && e.streamId === streamId && controlType(e) === type);
}

/** The stream_open the edge sent for the single browser stream: its id. */
async function openedStream(session: CallbackSession): Promise<{ streamId: string }> {
	const open = await waitFor(
		() =>
			session.received().find((e) => e.kind === "control" && controlType(e) === "stream_open") ??
			null,
		5000,
		"stream_open",
	);
	return { streamId: open.streamId };
}

/**
 * A session-shaped priming burst: `FRAMES` history frames and a closing `ready`.
 * With `honorCredit` it keeps at most the credit window of unacknowledged frames
 * in flight, exactly as the session's paced prime does; without it (a session that
 * ignores the credit window) it writes everything at once. `parked` resolves the first time the
 * sender had to wait for credit.
 */
function startPrimer(session: CallbackSession, streamId: string, honorCredit: boolean) {
	const parked = Promise.withResolvers<void>();
	const inflight: Array<{ seq: number; bytes: number }> = [];
	let acked = 0;
	let sentBytes = 0;
	let finished = false;
	let stopped = false;
	const pad = "x".repeat(FRAME_BYTES);
	const refresh = (): void => {
		for (const env of controls(session, streamId, "stream_ack")) {
			acked = Math.max(acked, ackedSeq(env));
		}
		while (inflight.length > 0 && inflight[0]!.seq <= acked) inflight.shift();
		if (controls(session, streamId, "stream_close").length > 0) stopped = true;
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
			const seq = session.send(streamId, "frame", { type: "history", chunk: i, pad });
			inflight.push({ seq, bytes: FRAME_BYTES });
			sentBytes += FRAME_BYTES;
		}
		if (!stopped) session.send(streamId, "frame", { type: "ready" });
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
	test("a browser that is not reading holds the session's burst at the credit window instead of being cut; it then receives every frame", async () => {
		const rig = await startRig();
		const browser = new RawBrowserSocket(rig.port);
		try {
			await browser.open();
			const { workspaceId, session } = await connectRemote(rig, "paced");
			browser.pause();
			browser.send({ type: "attach", workspaceId });
			const { streamId } = await openedStream(session);
			const primer = startPrimer(session, streamId, true);
			// The burst runs into the credit window while the browser reads nothing:
			// upstream backpressure, not an edge-side queue growing toward the cap.
			await primer.parked;
			expect(primer.finished).toBe(false);
			expect(primer.sentBytes).toBeLessThan(FRAMES * FRAME_BYTES);
			expect(browser.isClosed).toBe(false);
			expect(controls(session, streamId, "stream_close")).toHaveLength(0);
			// The browser starts reading: the whole priming arrives, the socket is never closed.
			browser.resume();
			await primer.run;
			await browser.waitForFrame((f) => f.type === "ready", "ready frame", 20_000);
			expect(browser.isClosed).toBe(false);
			expect(browser.closeInfo).toBeNull();
			expect(browser.bytes).toBeGreaterThanOrEqual(FRAMES * FRAME_BYTES);
			expect(browser.frames.filter((f) => f.type === "history")).toHaveLength(FRAMES);
			expect(controls(session, streamId, "stream_close")).toHaveLength(0);
			// The edge acknowledged as the queue drained, cumulatively and in order.
			const seqs = controls(session, streamId, "stream_ack").map(ackedSeq);
			expect(seqs.length).toBeGreaterThan(FRAMES / 4);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);

	test("a browser that stops reading is dropped after the stall limit, while the session's burst stays parked", async () => {
		const rig = await startRig({ stallMs: 150, keepaliveMs: 25 });
		const browser = new RawBrowserSocket(rig.port);
		try {
			await browser.open();
			const { workspaceId, session } = await connectRemote(rig, "stuck");
			browser.pause();
			browser.send({ type: "attach", workspaceId });
			const { streamId } = await openedStream(session);
			const primer = startPrimer(session, streamId, true);
			await primer.parked;
			// The edge ends the stream and tells the session; nothing keeps it open.
			await waitFor(
				() => (controls(session, streamId, "stream_close").length > 0 ? true : null),
				10_000,
				"stream_close after the stall limit",
			);
			await primer.run;
			expect(primer.finished).toBe(true);
			expect(primer.sentBytes).toBeLessThan(FRAMES * FRAME_BYTES);
			// The cut is the typed drop: once the browser reads again, the buffered
			// bytes arrive, then the 4503 close; the priming never completed.
			browser.resume();
			expect((await browser.end())?.code).toBe(4503);
			expect(browser.frames.some((f) => f.type === "ready")).toBe(false);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);

	test("a session that ignores the credit window still hits the cap drop", async () => {
		const rig = await startRig();
		const browser = new RawBrowserSocket(rig.port);
		try {
			await browser.open();
			const { workspaceId, session } = await connectRemote(rig, "ignoring");
			browser.pause();
			browser.send({ type: "attach", workspaceId });
			const { streamId } = await openedStream(session);
			const primer = startPrimer(session, streamId, false);
			await primer.run;
			await waitFor(
				() => (controls(session, streamId, "stream_close").length > 0 ? true : null),
				10_000,
				"stream_close after the cap drop",
			);
			browser.resume();
			expect((await browser.end())?.code).toBe(4503);
			expect(browser.frames.some((f) => f.type === "ready")).toBe(false);
		} finally {
			browser.destroy();
			await rig.close();
		}
	}, 60_000);
});
