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
import { SSE_DELTA_SEQ_START } from "#lib/wire/protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
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
