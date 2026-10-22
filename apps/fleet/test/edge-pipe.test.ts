/**
 * Fleet edge pipe tests: standalone (per-test) mounts of the edge over a
 * callback-pair daemon (callback-daemon.testkit.ts). Covers backpressure
 * overflow + ring replay, attach priming and stream lifecycle over the pair,
 * id-keyed answers reaching only the originating browser, replay refused
 * across a generation change, and delta-ring filtering / byte-bound eviction.
 * Each test owns its rig and cleans up in a finally.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CALLBACK_CONTROL_STREAM_ID, type CallbackEnvelope } from "#lib/wire/callback-protocol";
import { OMP_PROTO, SSE_DELTA_SEQ_START, type ServerFrame } from "#lib/wire/protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { createDaemonControl, type DaemonControl } from "../../session/daemon-control";
import { FleetCallback } from "../../session/fleet-callback";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import {
	type BrowserSocket,
	cleanupTempDirs,
	collectReplay,
	eventMessage,
	isEventEntry,
	openBrowser,
	serveEdge,
	sleep,
	testEviction,
	testWaker,
	waitFor,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

const CONFIG: FleetConfig = {
	templates: { local: { command: "true" } },
	defaultTemplate: "local",
	workspaceDir: "/tmp/fleet-test-ws",
	bind: "127.0.0.1",
};

interface Rig {
	registry: Registry;
	transport: DaemonTransportRegistry;
	edge: FleetEdge;
	port: number;
	daemons: CallbackDaemon[];
	close(): Promise<void>;
}

interface Remote {
	daemonId: string;
	daemon: CallbackDaemon;
}

/** One edge on loopback with the callback routes mounted, plus its registry and transport. */
async function startRig(
	opts: { backpressureBytes?: number; ringBytes?: number } = {},
): Promise<Rig> {
	const dir = tempDir("omp-web-edge-pipe-");
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
			fleet: {
				port: 0,
				startedAt: Date.now(),
				statePath,
				configPath: null,
				bind: "127.0.0.1",
			},
		},
		{ backpressureBytes: opts.backpressureBytes, ringBytes: opts.ringBytes },
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

/** Create a remote registry row, enroll its credential, and dial the callback pair. */
async function connectRemote(rig: Rig, name: string): Promise<Remote> {
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

/** Enroll generation 2 for the same workspace (no revoke) and dial it; generation 1 stops first. */
async function advanceGeneration(rig: Rig, remote: Remote): Promise<CallbackDaemon> {
	await remote.daemon.stop();
	const token = randomBytes(32).toString("hex");
	await rig.transport.enrollWorkspace(remote.daemonId, 2, token);
	const daemon = startCallbackDaemon({
		url: `http://127.0.0.1:${rig.port}`,
		workspaceId: remote.daemonId,
		generation: 2,
		token,
	});
	rig.daemons.push(daemon);
	await daemon.waitConnected(5000);
	return daemon;
}

/** Attach a browser to a daemon with a correlation id and wait for the ok attach_result. */
async function attach(browser: BrowserSocket, daemonId: string, id: string): Promise<void> {
	await browser.send({ type: "attach", id, sessionId: daemonId });
	await browser.waitForFrame(
		(f) => f.type === "attach_result" && f.id === id && f.ok,
		`attach_result ${id}`,
	);
}

function controlType(env: CallbackEnvelope): string | undefined {
	const payload = env.payload;
	if (typeof payload !== "object" || payload === null || !("type" in payload)) return undefined;
	return typeof payload.type === "string" ? payload.type : undefined;
}

function controlFrames(daemon: CallbackDaemon, type: string): CallbackEnvelope[] {
	return daemon.received().filter((env) => env.kind === "control" && controlType(env) === type);
}

/** Wait until at least `count` browser streams have been opened over the pair; return their stream ids in open order. */
async function awaitStreams(daemon: CallbackDaemon, count: number): Promise<string[]> {
	return waitFor(
		() => {
			const streams = controlFrames(daemon, "stream_open").map((env) => env.streamId);
			return streams.length >= count ? streams : null;
		},
		3000,
		`${count} stream_open`,
	);
}

/** Wait until the daemon has received at least `count` command envelopes carrying `id`. */
async function awaitCommand(daemon: CallbackDaemon, id: string, count = 1): Promise<void> {
	await waitFor(
		() => {
			const seen = commandsWithId(daemon, id);
			return seen.length >= count ? true : null;
		},
		3000,
		`command ${id} x${count}`,
	);
}

/** Command envelopes a daemon received carrying `id`. */
function commandsWithId(daemon: CallbackDaemon, id: string): CallbackEnvelope[] {
	return daemon.received().filter((env) => {
		const payload = env.payload;
		return (
			env.kind === "command" &&
			typeof payload === "object" &&
			payload !== null &&
			"id" in payload &&
			payload.id === id
		);
	});
}

describe("edge pipe backpressure and replay", () => {
	test("backpressure: overflow drops the browser stream; Last-Event-ID resume replays the ring", async () => {
		// Sizing rule, not a pinned byte count: the cap must be smaller than
		// the 40-frame synchronous burst (overflow must trigger) yet larger
		// than priming + the ring-replay tail after the drop (the resumed
		// stream's replay is enqueued synchronously, so an over-small cap
		// re-drops it mid-replay). Roster frames grow as additive fields are
		// added to DaemonEntry; keep the burst:cap ratio wide.
		const rig = await startRig({ backpressureBytes: 8_192 });
		try {
			const browser = await openBrowser(rig.port);
			// Priming arrives (roster + merged daemons, seqs 1..2).
			await browser.waitForFrame((f) => f.type === "roster", "priming roster");
			// One delta the browser reads, so its Last-Event-ID lands in the
			// delta range (>= SSE_DELTA_SEQ_START) before the drop.
			const x1 = rig.registry.create({
				name: "x1",
				cwd: "/x1",
				project: "x1",
				labels: [],
				status: "connecting",
			});
			await browser.waitForFrame(
				(f) => f.type === "roster_delta" && f.upserted.some((d) => d.daemonId === x1.daemonId),
				"first delta roster",
			);
			// Overflow: a synchronous burst of roster broadcasts (constant-size
			// blocks) far exceeds the cap while the browser is not reading, so
			// the stream must be dropped.
			for (let i = 2; i <= 40; i++) {
				rig.registry.update(x1.daemonId, { labels: [`v=${i}`] });
			}
			await browser.end(); // the dropped stream's body ends
			// Reconnect with Last-Event-ID: the ring replays deltas after it.
			await browser.reopen();
			// The replay delivers the ringed deltas (delta-era seqs), including
			// the final burst roster, not only the fresh priming.
			const replayed = await browser.waitForEvent(
				(ev) =>
					ev.frame.type === "roster_delta" &&
					ev.frame.upserted.some((d) => d.daemonId === x1.daemonId && d.labels.includes("v=40")) &&
					ev.id >= SSE_DELTA_SEQ_START,
				"replayed final roster delta",
			);
			expect(replayed.frame.type).toBe("roster_delta");
		} finally {
			await rig.close();
		}
	});
});

describe("edge pipe attach and answers over the callback pair", () => {
	test("attach primes over the pair; the browser stream rides browser/<conn> and detach sends stream_close", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "primed");
			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, remote.daemonId, "a1");
			const [stream] = await awaitStreams(remote.daemon, 1);
			expect(stream?.startsWith("browser/")).toBe(true);
			// Daemon frames on the browser stream reach the browser, stamped with the daemon id.
			remote.daemon.send(stream!, "frame", { type: "history", messages: [], final: true });
			await browser.waitForFrame(
				(f) => f.type === "history" && f.sessionId === remote.daemonId,
				"priming history stamped with the daemon id",
			);
			// Detach: closing the browser stream tears down the pair stream.
			await browser.close();
			const closed = await waitFor(
				() =>
					controlFrames(remote.daemon, "stream_close").find((env) => env.streamId === stream) ??
					null,
				3000,
				"stream_close",
			);
			expect(closed.streamId).toBe(stream);
		} finally {
			await rig.close();
		}
	});

	test("id-keyed answers reach only the browser that issued the command", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "origin");
			const a = await openBrowser(rig.port);
			await a.waitForFrame((f) => f.type === "roster", "roster A");
			await attach(a, remote.daemonId, "a1");
			const [streamA] = await awaitStreams(remote.daemon, 1);
			const b = await openBrowser(rig.port);
			await b.waitForFrame((f) => f.type === "roster", "roster B");
			await attach(b, remote.daemonId, "b1");
			const [, streamB] = await awaitStreams(remote.daemon, 2);
			const answersFor = (browser: BrowserSocket) =>
				browser.frames.filter((f) => f.type === "call_result" && f.id === "c1");

			// A issues c1. The daemon answers on both streams; the copy on B's
			// stream is consumed by the origin record and must never reach B.
			await a.send({ type: "call", id: "c1", method: "prompt", args: ["from A"] });
			await awaitCommand(remote.daemon, "c1");
			remote.daemon.send(streamA!, "frame", { type: "call_result", id: "c1", ok: true, data: "A" });
			remote.daemon.send(streamB!, "frame", { type: "call_result", id: "c1", ok: true, data: "A" });
			await a.waitForFrame((f) => f.type === "call_result" && f.id === "c1", "A's answer");
			await sleep(300); // real time: a fan-out copy would land in this window
			expect(answersFor(a)).toHaveLength(1);
			expect(answersFor(b)).toHaveLength(0);

			// B reuses the id c1 for its own command; only B settles from it.
			await b.send({ type: "call", id: "c1", method: "prompt", args: ["from B"] });
			await awaitCommand(remote.daemon, "c1", 2);
			remote.daemon.send(streamA!, "frame", { type: "call_result", id: "c1", ok: true, data: "B" });
			remote.daemon.send(streamB!, "frame", { type: "call_result", id: "c1", ok: true, data: "B" });
			await b.waitForFrame((f) => f.type === "call_result" && f.id === "c1", "B's answer");
			await sleep(300);
			expect(answersFor(b)).toHaveLength(1);
			expect(answersFor(a)).toHaveLength(1);
		} finally {
			await rig.close();
		}
	});

	test("an unanswered command is refused on replay after a generation change, not re-forwarded", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "gen");
			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, remote.daemonId, "a1");
			await awaitStreams(remote.daemon, 1);
			await browser.send({ type: "call", id: "r1", method: "prompt", args: ["lost"] });
			await awaitCommand(remote.daemon, "r1");
			// The daemon goes away before answering; generation 2 replaces it.
			const next = await advanceGeneration(rig, remote);
			expect(next.connected()).toBe(true);
			// Replay of the same command id must fail, not re-run on the new generation.
			await browser.send({ type: "call", id: "r1", method: "prompt", args: ["again"] });
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === "r1",
				"refusal for r1",
			);
			const refusal = browser.frames.find((f) => f.type === "call_result" && f.id === "r1");
			expect(refusal).toMatchObject({ ok: false, error: expect.stringContaining("generation 1") });
			// The first generation saw the call exactly once, and the replay
			// never reached the new generation.
			expect(commandsWithId(remote.daemon, "r1")).toHaveLength(1);
			expect(next.received().some((env) => env.kind === "command")).toBe(false);
		} finally {
			await rig.close();
		}
	});
});

describe("edge pipe delta ring", () => {
	test("edge rings only delta frames: history/call_result/stream_reset forward live but never replay", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "ring-filter");
			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, remote.daemonId, "a1");
			const [stream] = await awaitStreams(remote.daemon, 1);
			// Priming history gives a stable replay floor below the live frames.
			remote.daemon.send(stream!, "frame", { type: "history", messages: [], final: true });
			const primingHistory = await browser.waitForEvent(
				(ev) => ev.frame.type === "history",
				"priming history",
			);
			// Live frames, oldest first: a transcript history, a call_result,
			// a stream_reset, and a ringed event. All four must ARRIVE.
			remote.daemon.send(stream!, "frame", {
				type: "history",
				messages: [{ role: "user", content: "transcript body", timestamp: 0 }],
				final: true,
			});
			remote.daemon.send(stream!, "frame", {
				type: "call_result",
				id: "r1",
				ok: true,
				data: { huge: "y".repeat(5000) },
			});
			remote.daemon.send(stream!, "frame", { type: "stream_reset", reason: "test" });
			remote.daemon.send(stream!, "frame", {
				type: "event",
				event: { type: "notice", level: "info", message: "ring-me" },
			});
			await browser.waitForFrame(
				(f) =>
					f.type === "history" &&
					f.sessionId === remote.daemonId &&
					Array.isArray(f.messages) &&
					f.messages.length === 1,
				"live history",
			);
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === "r1",
				"live call_result",
			);
			await browser.waitForFrame((f) => f.type === "stream_reset", "live stream_reset");
			await browser.waitForFrame(
				(f) => f.type === "event" && eventMessage(f) === "ring-me",
				"live event",
			);
			// Replay from just after the priming history: only the ringed event
			// comes back; history/call_result/stream_reset are re-derivable and
			// are never replayed from the ring.
			const replay = await collectReplay(
				rig.port,
				browser.clientId,
				primingHistory.id,
				(f) => f.type === "event" && eventMessage(f) === "ring-me",
			);
			expect(replay.some(({ frame }) => frame.type === "event")).toBe(true);
			const banned = [
				"history",
				"call_result",
				"stream_reset",
				"hello_ok",
				"attached",
				"available_commands",
			];
			for (const { frame } of replay) expect(banned).not.toContain(frame.type);
		} finally {
			await rig.close();
		}
	});

	test("byte-bound ring eviction drops the oldest deltas; replay after eviction still works", async () => {
		// Tiny per-client ring budget (~2.5 KiB): a burst of large deltas must
		// evict the ring's head, not grow without bound.
		const rig = await startRig({ ringBytes: 2500 });
		try {
			const remote = await connectRemote(rig, "ring-bytes");
			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, remote.daemonId, "a1");
			const [stream] = await awaitStreams(remote.daemon, 1);
			// A burst of large ringed deltas: each block is ~700 bytes, so 20
			// of them blow well past the 2500-byte budget and evict the head.
			const N = 20;
			for (let i = 0; i < N; i++) {
				remote.daemon.send(stream!, "frame", {
					type: "event",
					event: { type: "notice", level: "info", message: `evict-${i}` + "x".repeat(600) },
				});
			}
			await browser.waitForFrame(
				(f) => f.type === "event" && eventMessage(f)?.startsWith("evict-19") === true,
				"last burst delta",
			);
			const firstId = browser.events.find(
				(ev) => ev.frame.type === "event" && eventMessage(ev.frame)?.startsWith("evict-0") === true,
			)!.id;
			// Replay from just before the burst: only the byte-eviction-
			// surviving tail replays. The newest delta is there, the oldest is
			// gone, and the survivors are a contiguous suffix in seq order
			// (drop-and-resume semantics: the browser resumes from what the
			// ring still holds, never a corrupted tail).
			const replay = await collectReplay(
				rig.port,
				browser.clientId,
				firstId - 1,
				(f) => f.type === "event" && eventMessage(f)?.startsWith("evict-19") === true,
			);
			const replayEvents = replay.filter(isEventEntry);
			expect(
				replayEvents.some(({ frame }) => eventMessage(frame)?.startsWith("evict-19") ?? false),
			).toBe(true);
			expect(
				replayEvents.some(({ frame }) => eventMessage(frame)?.startsWith("evict-0") ?? false),
			).toBe(false);
			const indices = replayEvents.map(({ frame }) => {
				const m = eventMessage(frame)?.match(/^evict-(\d+)/);
				return m ? Number(m[1]) : Number.NaN;
			});
			expect(indices.every(Number.isInteger)).toBe(true);
			for (let i = 1; i < indices.length; i++) expect(indices[i]).toBe(indices[i - 1]! + 1);
			expect(indices[indices.length - 1]).toBe(N - 1);
			// Seq order mirrors the survivor order (oldest first).
			const seqs = replayEvents.map(({ id }) => id);
			for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
		} finally {
			await rig.close();
		}
	});
});

describe("edge pipe session file over the callback pair", () => {
	test("a state frame's sessionFile on the control stream becomes lastSessionFile, and a changed one replaces it", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "session-file");
			const sessionFileOf = (): string | undefined =>
				rig.registry.get(remote.daemonId)?.lastSessionFile;
			remote.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "state",
				state: { sessionFile: "/sessions/first.jsonl" },
			});
			await waitFor(
				() => (sessionFileOf() === "/sessions/first.jsonl" ? true : null),
				3000,
				"lastSessionFile first",
			);
			remote.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "state",
				state: { sessionFile: "/sessions/second.jsonl" },
			});
			await waitFor(
				() => (sessionFileOf() === "/sessions/second.jsonl" ? true : null),
				3000,
				"lastSessionFile second",
			);
		} finally {
			await rig.close();
		}
	});

	test("a state frame's sessionPersisted marks the session file known persisted, and a changed file clears the mark", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "session-persisted");
			remote.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "state",
				state: { sessionFile: "/sessions/kept.jsonl", sessionPersisted: true },
			});
			await waitFor(
				() => (rig.registry.get(remote.daemonId)?.lastSessionPersisted === true ? true : null),
				3000,
				"lastSessionPersisted kept",
			);
			remote.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "state",
				state: { sessionFile: "/sessions/other.jsonl" },
			});
			await waitFor(
				() =>
					rig.registry.get(remote.daemonId)?.lastSessionFile === "/sessions/other.jsonl"
						? true
						: null,
				3000,
				"lastSessionFile other",
			);
			expect(rig.registry.get(remote.daemonId)?.lastSessionPersisted).toBeUndefined();
		} finally {
			await rig.close();
		}
	});

	test("GET /ctl/sessions/{id}/download is 503 while two downloads are open, and is refused with the cap reason", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "dl-cap");
			const first = rig.transport.createBulkCorrelation(remote.daemonId, { capture: true });
			const second = rig.transport.createBulkCorrelation(remote.daemonId, { capture: true });
			const url = `http://127.0.0.1:${rig.port}/ctl/sessions/${remote.daemonId}/download?path=a.txt`;
			const refused = await fetch(url);
			expect(refused.status).toBe(503);
			expect(await refused.json()).toEqual({
				error: "download unavailable: too many concurrent downloads (limit 2)",
			});
			first.cancel("freed");
			expect((await first.done).state).toBe("failed");
			second.cancel("cleanup");
			await second.done;
		} finally {
			await rig.close();
		}
	});

	test("a browser that aborts a download frees its capture slot at once", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "dl-abort");
			const url = `http://127.0.0.1:${rig.port}/ctl/sessions/${remote.daemonId}/download?path=a.txt`;
			const downloadCommands = (): number =>
				remote.daemon.received().filter((env) => {
					const payload = env.payload;
					return (
						env.kind === "command" &&
						typeof payload === "object" &&
						payload !== null &&
						"type" in payload &&
						payload.type === "download_bulk"
					);
				}).length;
			const first = new AbortController();
			const second = new AbortController();
			const firstFetch = fetch(url, { signal: first.signal }).catch((err: unknown) => err);
			const secondFetch = fetch(url, { signal: second.signal }).catch((err: unknown) => err);
			await waitFor(() => (downloadCommands() >= 2 ? true : null), 3000, "two download commands");
			first.abort();
			expect(await firstFetch).not.toBeInstanceOf(Response);
			// Both slots stay held until the edge sees the abort; then a probe capture fits.
			await waitFor(
				() => {
					try {
						rig.transport.createBulkCorrelation(remote.daemonId, { capture: true }).cancel("probe");
						return true;
					} catch {
						return null;
					}
				},
				3000,
				"aborted download releases its capture slot",
			);
			second.abort();
			expect(await secondFetch).not.toBeInstanceOf(Response);
		} finally {
			await rig.close();
		}
	});
});

/** The `i` counter of a test live frame, -1 when absent. */
function liveIndex(frame: object): number {
	return "i" in frame && typeof frame.i === "number" ? frame.i : -1;
}

interface LiveSession {
	callback: FleetCallback;
	control: DaemonControl;
}

describe("edge pipe over one real session pair", () => {
	/** A real session half: FleetCallback + daemon control, answering every command ok. */
	function startSession(
		rig: Rig,
		daemonId: string,
		token: string,
		priming: Record<string, unknown>[] = [
			{ type: "hello_ok", proto: OMP_PROTO },
			{ type: "history", messages: [], final: true },
		],
	): LiveSession {
		let control!: DaemonControl;
		const callback = new FleetCallback(
			{
				url: `http://127.0.0.1:${rig.port}`,
				workspaceId: daemonId,
				generation: 1,
				token,
				allowHttp: true,
				backoffMinMs: 25,
				backoffMaxMs: 100,
			},
			{
				onEnvelope: (envelope) => control.handleEnvelope(envelope),
				onControl: (envelope) => control.handleEnvelope(envelope),
			},
		);
		control = createDaemonControl({
			handleCommand: async (command) => {
				const id =
					typeof command === "object" && command !== null && "id" in command ? command.id : "";
				return { type: "call_result", id, ok: true };
			},
			preparePriming: async () => () => priming,
			send: (streamId, kind, payload, onEmittedSeq) =>
				callback.send({
					streamId,
					kind,
					payload,
					...(onEmittedSeq !== undefined ? { onEmittedSeq } : {}),
				}),
			bufferedBytes: (streamId) => callback.bufferedBytes(streamId),
			onDrain: (listener) => callback.onDrain(listener),
			pairLive: () => callback.status().state === "ready",
			onShutdown: () => {},
		});
		return { callback, control };
	}

	test("a long run of live traffic and commands over one pair arrives once and in order: no re-prime, no stream reset, no lost or refused command", async () => {
		const rig = await startRig();
		let session: LiveSession | undefined;
		try {
			const entry = rig.registry.create({
				name: "one-pair",
				cwd: "/one-pair",
				project: "one-pair",
				labels: [],
				status: "connecting",
			});
			const token = randomBytes(32).toString("hex");
			await rig.transport.enrollWorkspace(entry.daemonId, 1, token);
			const PAD = 8 * 1024;
			session = startSession(rig, entry.daemonId, token);
			await session.callback.start();
			const pairs: Array<string | null> = [];
			const unsubscribe = rig.transport.onPairChange(entry.daemonId, (status) =>
				pairs.push(status.paired ? status.connectionId : null),
			);

			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, entry.daemonId, "a1");
			await browser.waitForFrame((f) => f.type === "history", "priming history");

			// Live traffic and commands interleaved over the one pair (about 1.9 MiB
			// of frames, the load that used to cross several byte-budget renewals).
			const FRAMES = 240;
			const COMMANDS = 60;
			let sentCommands = 0;
			for (let i = 0; i < FRAMES; i++) {
				session.control.mirror({ type: "event", i, pad: "x".repeat(PAD) });
				if (i % 4 === 0) {
					await browser.send({ type: "call", id: `c${sentCommands++}`, method: "ping", args: [] });
				}
				if (i % 8 === 7) await sleep(2);
			}
			expect(sentCommands).toBe(COMMANDS);
			await browser.waitForFrame(
				(f) => f.type === "event" && liveIndex(f) === FRAMES - 1,
				"last live frame",
				10_000,
			);
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === `c${COMMANDS - 1}`,
				"last answer",
				10_000,
			);
			unsubscribe();

			expect(session.callback.status().reconnects).toBe(0);
			expect(session.callback.status().readyCount).toBe(1);
			// The pair was never unpaired, and the browser stream was neither re-primed nor reset.
			expect(pairs).not.toContain(null);
			expect(browser.frames.filter((f) => f.type === "history")).toHaveLength(1);
			expect(browser.frames.filter((f) => f.type === "hello_ok")).toHaveLength(1);
			expect(browser.frames.filter((f) => f.type === "stream_reset")).toEqual([]);
			// Every live frame arrived exactly once and in order.
			const live = browser.frames.filter((f) => f.type === "event").map(liveIndex);
			expect(live).toEqual(Array.from({ length: FRAMES }, (_, i) => i));
			// Every command was answered ok: none refused as "not attached".
			const answers = browser.frames.filter((f) => f.type === "call_result");
			expect(answers.map((f) => f.id).sort()).toEqual(
				Array.from({ length: COMMANDS }, (_, i) => `c${i}`).sort(),
			);
			expect(answers.every((f) => f.ok === true)).toBe(true);
		} finally {
			session?.callback.stop();
			await rig.close();
		}
	});

	test("priming a history far past the stream budget sends it once: no second attached, no stream reset (g8nh)", async () => {
		// Every pair has its own socket and connectionId, so the stream is primed
		// exactly once per pair. A history of 24 x 256 KiB (6 MiB, past the 4 MiB
		// stream cap) rides one pair under ack pacing; before the one-socket pair,
		// byte-budget renewals mid-prime reached the fleet as a fresh stream_open
		// and the session primed the whole history again.
		const rig = await startRig();
		let session: LiveSession | undefined;
		try {
			const entry = rig.registry.create({
				name: "big-history",
				cwd: "/big-history",
				project: "big-history",
				labels: [],
				status: "connecting",
			});
			const token = randomBytes(32).toString("hex");
			await rig.transport.enrollWorkspace(entry.daemonId, 1, token);
			const CHUNKS = 24;
			const priming: Record<string, unknown>[] = [
				{ type: "hello_ok", proto: OMP_PROTO },
				{ type: "attached", sessionId: "x" },
				...Array.from({ length: CHUNKS }, (_, i) => ({
					type: "history",
					messages: [],
					chunk: i,
					final: i === CHUNKS - 1,
					pad: "h".repeat(256 * 1024),
				})),
				{ type: "ready" },
			];
			session = startSession(rig, entry.daemonId, token, priming);
			await session.callback.start();

			const browser = await openBrowser(rig.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await attach(browser, entry.daemonId, "a1");
			await browser.waitForFrame((f) => f.type === "ready", "end of priming", 20_000);
			await sleep(300); // real time: a restarted prime would deliver a second copy in this window

			expect(session.callback.status().reconnects).toBe(0);
			expect(session.callback.status().readyCount).toBe(1);
			expect(browser.frames.filter((f) => f.type === "hello_ok")).toHaveLength(1);
			expect(browser.frames.filter((f) => f.type === "attached")).toHaveLength(1);
			expect(browser.frames.filter((f) => f.type === "stream_reset")).toEqual([]);
			expect(browser.frames.filter((f) => f.type === "history")).toHaveLength(CHUNKS);
		} finally {
			session?.callback.stop();
			await rig.close();
		}
	});
});

const markerOf = (f: ServerFrame): unknown => (f as unknown as { marker?: unknown }).marker;
const hostileOf = (f: ServerFrame): unknown => (f as unknown as { hostile?: unknown }).hostile;

describe("edge pipe relays the session's own frame text", () => {
	/** What the browser receives when the edge re-serializes: the parsed frame plus the stamp, through JSON. */
	function viaStringify(text: string, stamp: string | null): ServerFrame {
		const frame = JSON.parse(text) as Record<string, unknown>;
		return JSON.parse(
			JSON.stringify(stamp === null ? frame : { ...frame, sessionId: stamp }),
		) as ServerFrame;
	}

	/** Every SSE block of the browser's stream carrying a frame, as its data lines. */
	function dataLinesOf(browser: BrowserSocket): string[][] {
		return browser.rawText
			.split("\n\n")
			.filter((block) => block.startsWith("event: frame\n"))
			.map((block) => block.split("\n").filter((line) => line.startsWith("data:")));
	}

	async function attached(rig: Rig, name: string) {
		const remote = await connectRemote(rig, name);
		const browser = await openBrowser(rig.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await attach(browser, remote.daemonId, "a1");
		const [stream] = await awaitStreams(remote.daemon, 1);
		return { remote, browser, stream: stream! };
	}

	test("relayed frames deep-equal what the re-serializing path produced: non-ASCII, with and without a sessionId key, unscoped", async () => {
		const rig = await startRig();
		try {
			const { remote, browser, stream } = await attached(rig, "relay-parity");
			const cases: Array<{ text: string; stamp: boolean }> = [
				{
					text: JSON.stringify({
						type: "history",
						messages: [
							{ role: "user", content: 'é日本 \u{1F600} \u2028 "q" \\ \n tab\t', timestamp: 1 },
						],
						final: true,
					}),
					stamp: true,
				},
				{
					text: '{"type":"event","event":{"type":"notice","level":"info","message":"no id"}}',
					stamp: true,
				},
				{
					text: '{"type":"event","sessionId":"spoofed","event":{"type":"notice","level":"info","message":"has id"}}',
					stamp: true,
				},
				{ text: '{"type": "state" , "state": {"x": [1, 2.5, null, true]}}', stamp: true },
				{ text: '{"type":"attached","sessionId":"s1"}', stamp: true },
				{ text: '{"type":"ready","marker":"unscoped"}', stamp: false },
				{ text: "{}", stamp: false },
			];
			for (const { text } of cases) remote.daemon.sendRaw(stream, "frame", text);
			remote.daemon.sendRaw(stream, "frame", '{"type":"ready","marker":"done"}');
			await browser.waitForFrame((f) => markerOf(f) === "done", "last relayed frame");
			const received = browser.frames.filter(
				(f) => f.type !== "roster" && f.type !== "attach_result" && markerOf(f) !== "done",
			);
			// The browser also saw priming (roster, daemons); compare only the relayed frames.
			const relayed = received.slice(-cases.length);
			expect(relayed).toEqual(
				cases.map(({ text, stamp }) => viaStringify(text, stamp ? remote.daemonId : null)),
			);
			expect(relayed[2]).toMatchObject({ sessionId: remote.daemonId });
		} finally {
			await rig.close();
		}
	});

	test("an id-keyed answer in padded-but-single-line JSON reaches only its origin browser, stamped, equal to the re-serialized frame", async () => {
		const rig = await startRig();
		try {
			const remote = await connectRemote(rig, "relay-answer");
			const a = await openBrowser(rig.port);
			await a.waitForFrame((f) => f.type === "roster", "roster A");
			await attach(a, remote.daemonId, "a1");
			const [streamA] = await awaitStreams(remote.daemon, 1);
			const b = await openBrowser(rig.port);
			await b.waitForFrame((f) => f.type === "roster", "roster B");
			await attach(b, remote.daemonId, "b1");
			const [, streamB] = await awaitStreams(remote.daemon, 2);
			await a.send({ type: "call", id: "c9", method: "prompt", args: ["x"] });
			await awaitCommand(remote.daemon, "c9");
			const text = '{"type": "call_result", "id": "c9", "ok": true, "data": "é日本"}';
			remote.daemon.sendRaw(streamA!, "frame", text);
			remote.daemon.sendRaw(streamB!, "frame", text);
			const answer = await a.waitForFrame(
				(f) => f.type === "call_result" && f.id === "c9",
				"answer",
			);
			await sleep(300);
			expect(answer).toEqual(viaStringify(text, remote.daemonId));
			expect(a.frames.filter((f) => f.type === "call_result")).toHaveLength(1);
			expect(b.frames.filter((f) => f.type === "call_result")).toHaveLength(0);
		} finally {
			await rig.close();
		}
	});

	test("a frame with a raw newline between tokens, or non-canonical framing, arrives intact as one single-line SSE event", async () => {
		const rig = await startRig();
		try {
			const { remote, browser, stream } = await attached(rig, "relay-newline");
			const pretty =
				'{\n  "type": "event",\r\n  "event": {"type":"notice","level":"info","message":"nl é"}\n}';
			remote.daemon.sendRaw(stream, "frame", pretty);
			remote.daemon.sendRaw(
				stream,
				"frame",
				'{"type":"event","event":{"type":"notice","level":"info","message":"padded"}}',
				{ padded: true },
			);
			remote.daemon.sendRaw(stream, "frame", '{"type":"ready","marker":"done"}');
			await browser.waitForFrame((f) => markerOf(f) === "done", "last frame");
			expect(browser.frames.find((f) => f.type === "event" && eventMessage(f) === "nl é")).toEqual(
				viaStringify(pretty, remote.daemonId),
			);
			expect(
				browser.frames.find((f) => f.type === "event" && eventMessage(f) === "padded"),
			).toMatchObject({ sessionId: remote.daemonId });
			// Each frame is one SSE block with exactly one data line; no raw CR or LF split it.
			for (const lines of dataLinesOf(browser)) expect(lines).toHaveLength(1);
			expect(browser.rawText).not.toContain("\r");
		} finally {
			await rig.close();
		}
	});

	test("duplicate-key frames are handled by their parsed (last-wins) type, exactly what the browser parses", async () => {
		const rig = await startRig();
		try {
			const { remote, browser, stream } = await attached(rig, "relay-hostile");
			// Parses as `daemons`: tapped and never forwarded, whatever the first `type` says.
			remote.daemon.sendRaw(
				stream,
				"frame",
				'{"type":"history","messages":[],"final":true,"hostile":"HOSTILE-ONE","type":"daemons","daemons":[]}',
			);
			// Parses as `history`: forwarded and stamped, whatever the first `type` says.
			remote.daemon.sendRaw(
				stream,
				"frame",
				'{"type":"daemons","daemons":[],"type":"history","messages":[],"final":true,"hostile":"HOSTILE-TWO"}',
			);
			// Parses as the unscoped `ready`: forwarded WITHOUT a stamp.
			remote.daemon.sendRaw(
				stream,
				"frame",
				'{"type":"state","state":{},"type":"ready","hostile":"HOSTILE-THREE"}',
			);
			// Parses as `daemon_activity`: stripped like a broker roster.
			remote.daemon.sendRaw(
				stream,
				"frame",
				'{"type":"ready","type":"daemon_activity","hostile":"HOSTILE-FOUR"}',
			);
			remote.daemon.sendRaw(stream, "frame", '{"type":"ready","marker":"done"}');
			await browser.waitForFrame((f) => markerOf(f) === "done", "last frame");
			const hostile = browser.frames.filter((f) => typeof hostileOf(f) === "string");
			expect(hostile.map((f) => hostileOf(f))).toEqual(["HOSTILE-TWO", "HOSTILE-THREE"]);
			expect(hostile[0]).toMatchObject({ type: "history", sessionId: remote.daemonId });
			expect(hostile[1]).toMatchObject({ type: "ready" });
			expect(hostile[1]).not.toHaveProperty("sessionId");
			// The session's own text went out (duplicate keys intact), not a re-serialization.
			expect(browser.rawText).toContain('"type":"daemons","daemons":[],"type":"history"');
			expect(browser.rawText).not.toContain("HOSTILE-ONE");
			expect(browser.rawText).not.toContain("HOSTILE-FOUR");
		} finally {
			await rig.close();
		}
	});
});
