/**
 * Fleet edge pipe tests: standalone (per-test) mounts of the edge over a
 * FAKE pipe daemon — backpressure overflow + ring replay, pipe liveness /
 * heartbeat-fed silence, redial with and without Last-Event-ID, redial
 * budget exhaustion, and delta-ring filtering / byte-bound eviction. Each
 * test owns its registry/connector/edge and cleans up in a finally.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSE_DELTA_SEQ_START } from "../shared/protocol";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import { FleetEdge } from "./edge";
import { FleetEventLog } from "./events";
import { Registry } from "./registry";
import { SpawnSupervisor } from "./supervisor";
import {
	FAKE_CWD,
	FAKE_TOKEN,
	collectReplay,
	eventMessage,
	isEventEntry,
	openBrowser,
	serveEdge,
	sleep,
	startPipeFake,
	waitFor,
	cleanupTempDirs,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

describe("edge pipe liveness and replay", () => {
	test("backpressure: overflow drops the browser stream; Last-Event-ID resume replays the ring", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-bp-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry);
		const config: FleetConfig = {
			templates: { local: { command: "true" } },
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		// The cap fits the priming (small roster) + the ring replay, but a
		// synchronous burst of roster broadcasts overflows it.
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ backpressureBytes: 4096 },
		);
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			// Priming arrives (roster + merged daemons, seqs 1..2).
			await browser.waitForFrame((f) => f.type === "roster", "priming roster");
			// One delta the browser reads, so its Last-Event-ID lands in the
			// delta range (≥ SSE_DELTA_SEQ_START) before the drop.
			const x1 = registry.create({
				name: "x1",
				cwd: "/x1",
				project: "x1",
				labels: [],
				mode: "remote",
				status: "connecting",
			});
			await browser.waitForFrame(
				(f) => f.type === "roster" && f.daemons.some((d) => d.daemonId === x1.daemonId),
				"first delta roster",
			);
			// Overflow: a synchronous burst of roster broadcasts (constant-size
			// blocks) far exceeds the cap while the browser is not reading —
			// the stream must be dropped.
			for (let i = 2; i <= 40; i++) {
				registry.update(x1.daemonId, { labels: [`v=${i}`] });
			}
			await browser.end(); // the dropped stream's body ends
			// Reconnect with Last-Event-ID: the ring replays deltas after it.
			await browser.reopen();
			// The replay delivers the ringed deltas (delta-era seqs) — the
			// final burst roster — not just the fresh priming.
			const replayed = await browser.waitForEvent(
				(ev) =>
					ev.frame.type === "roster" &&
					ev.frame.daemons.some((d) => d.daemonId === x1.daemonId && d.labels.includes("v=40")) &&
					ev.id >= SSE_DELTA_SEQ_START,
				"replayed final roster",
			);
			expect(replayed.frame.type).toBe("roster");
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("pipe liveness: a responsive daemon pipe stays up; a silent one redials without detaching the browser", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-pipe-liveness-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "pipe-live",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 3000);
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ silenceDeadlineMs: 200, pipeBackoffMinMs: 10, pipeBackoffMaxMs: 50, pipeMaxRedials: 8 },
		);
		let releases = 0;
		const origRelease = connector.release.bind(connector);
		connector.release = (daemonId: string) => {
			releases++;
			origRelease(daemonId);
		};
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// Heartbeats every 30ms keep the 200ms silence deadline fed: the
			// pipe survives far past it — no loss frame, no teardown.
			await sleep(600);
			expect(
				browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
			).toBe(false);
			// Commands still round-trip through the live pipe.
			await browser.send({ type: "call", id: "l1", method: "prompt", args: ["hi"] });
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === "l1",
				"call_result l1",
			);
			// Silence: the daemon stops sending; the deadline trips → the pipe
			// REDIALS (finding #4) instead of detaching: no error frame, no
			// retain release, and the browser stays attached via the re-priming.
			const attachedBefore = browser.frames.filter((f) => f.type === "attached").length;
			const streamsBefore = daemon.lastEventIds().length;
			daemon.pause();
			await waitFor(
				() => (daemon.lastEventIds().length > streamsBefore ? "redial" : null),
				3000,
				"pipe redial after silence",
			);
			// The redial's fresh priming reaches the SAME browser stream.
			await waitFor(
				() =>
					browser.frames.filter((f) => f.type === "attached").length > attachedBefore
						? "re-primed"
						: null,
				3000,
				"re-prime after redial",
			);
			expect(
				browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
			).toBe(false);
			expect(releases).toBe(0);
			expect(connector.isConnected(entry.daemonId)).toBe(true);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("pipe resume: a mid-stream kill redials with Last-Event-ID and the browser stays attached", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-pipe-resume-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ silenceDeadlineMs: 200, pipeBackoffMinMs: 10, pipeBackoffMaxMs: 50, pipeMaxRedials: 8 },
		);
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "pipe-resume",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// A delta raises the pipe's Last-Event-ID into the delta era. The
			// connector's control stream dials first (the wake), the pipe second.
			await browser.send({ type: "call", id: "c1", method: "prompt", args: ["hi"] });
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === "c1",
				"call_result c1",
			);
			expect(daemon.lastEventIds().length).toBe(2); // connector stream + pipe
			const deltaSeq = SSE_DELTA_SEQ_START; // c1's answer is the first delta
			// Kill ONLY the pipe (index 1): the connector's control stream keeps
			// the daemon reachable, so the redial stream below is the pipe's.
			daemon.killStream(1);
			// A delta emitted while the pipe is DOWN must be replayed after the
			// redial — ringed before the redial dials (backoff is 10-50ms).
			daemon.emitDelta({
				type: "event",
				event: { type: "notice", level: "info", message: "after-kill" },
			});
			await waitFor(
				() => (daemon.lastEventIds().length === 3 ? "redial" : null),
				3000,
				"pipe redial",
			);
			// The redial resumes from the last forwarded daemon seq.
			expect(daemon.lastEventIds()[2]).toBe(String(deltaSeq));
			// The missed delta is replayed to the STILL-ATTACHED browser on the
			// same stream — no loss frame, no user re-attach.
			await browser.waitForFrame(
				(f) =>
					f.type === "event" &&
					(f.event as { type?: string })?.type === "notice" &&
					(f.event as { message?: string })?.message === "after-kill",
				"replayed notice",
			);
			expect(
				browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
			).toBe(false);
			// The redial re-primed (the daemon always primes every open), so the
			// browser got a second attached frame — attachment survived.
			expect(
				browser.frames.filter((f) => f.type === "attached" && f.sessionId === entry.daemonId)
					.length,
			).toBeGreaterThanOrEqual(2);
			// Subsequent frames still flow without any re-attach.
			await browser.send({ type: "call", id: "c2", method: "prompt", args: ["again"] });
			await browser.waitForFrame(
				(f) => f.type === "call_result" && f.id === "c2",
				"call_result c2",
			);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("pipe resume: a kill during priming redials WITHOUT Last-Event-ID and re-primes", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-pipe-priming-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ silenceDeadlineMs: 200, pipeBackoffMinMs: 10, pipeBackoffMaxMs: 50, pipeMaxRedials: 8 },
		);
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "pipe-priming",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// The pipe has only seen priming seqs (1..k < SSE_DELTA_SEQ_START).
			// Kill it BEFORE any delta: the redial must NOT carry Last-Event-ID
			// and the daemon's full re-prime must reach the still-attached browser.
			const attachedBefore = browser.frames.filter((f) => f.type === "attached").length;
			daemon.killStream(1);
			await waitFor(
				() => (daemon.lastEventIds().length === 3 ? "redial" : null),
				3000,
				"pipe redial",
			);
			expect(daemon.lastEventIds()[2]).toBeNull(); // sub-delta lastSeq → no resume header
			await waitFor(
				() =>
					browser.frames.filter((f) => f.type === "attached").length > attachedBefore
						? "re-primed"
						: null,
				3000,
				"re-prime after redial",
			);
			expect(
				browser.frames.some((f) => f.type === "error" && f.error === "daemon connection lost"),
			).toBe(false);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("pipe terminal: redial budget exhaustion surfaces the loss frame", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-pipe-terminal-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ silenceDeadlineMs: 200, pipeBackoffMinMs: 10, pipeBackoffMaxMs: 50, pipeMaxRedials: 3 },
		);
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "pipe-dead",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		// Retain/release must BALANCE: the browser attach retains once (the
		// pipe) and the browser-gated activity watch retains once more when
		// the daemon reaches ready; on terminal death both release (pipe
		// loss + watch reconcile as the status leaves ready). Asserting a
		// literal 1 would freeze the pre-watch world.
		let retains = 0;
		const origRetain = connector.retain.bind(connector);
		connector.retain = (daemonId: string) => {
			retains++;
			origRetain(daemonId);
		};
		let releases = 0;
		const origRelease = connector.release.bind(connector);
		connector.release = (daemonId: string) => {
			releases++;
			origRelease(daemonId);
		};
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// The daemon dies for good: every redial fails, the budget
			// exhausts, and the browser finally sees the loss frame + release.
			daemon.close();
			const lost = await browser.waitForFrame(
				(f) => f.type === "error" && f.error === "daemon connection lost",
				"daemon connection lost",
				5000,
			);
			expect(lost.type).toBe("error");
			await waitFor(() => (releases >= 1 ? "released" : null), 3000, "pipe retain released");
			await waitFor(
				() => (releases === retains ? "balanced" : null),
				3000,
				"retain/release balance",
			);
			expect(releases).toBe(retains);
			expect(releases).toBeGreaterThanOrEqual(1);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("edge rings only delta frames: history/call_result/stream_reset forward live but never replay (finding #5)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-ring-filter-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "ring-filter",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 3000);
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const edge = new FleetEdge({
			registry,
			connector,
			supervisor,
			config,
			eventLog: new FleetEventLog(),
			fleet: {
				port: 0,
				startedAt: Date.now(),
				statePath: "/tmp/fleet-test-state.json",
				configPath: null,
			},
		});
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// Pipe priming is forwarded with delta-era edge seqs (hello_ok →
			// attached → history → state → available_commands → ready); of
			// those only state/ready are ringed. Wait for the priming history
			// so its edge id is a stable replay floor below state.
			const primingHistory = await browser.waitForEvent(
				(ev) => ev.frame.type === "history",
				"priming history",
			);
			// Live emissions, oldest first: a full-transcript history broadcast,
			// a call_result answer, a per-stream stream_reset, and a ringed
			// event delta. All four must ARRIVE (forwarded live, never dropped).
			daemon.emitDelta({
				type: "history",
				messages: [{ role: "user", content: "transcript body", timestamp: 0 }],
				final: true,
			});
			daemon.emitDelta({
				type: "call_result",
				id: "r1",
				ok: true,
				data: { huge: "y".repeat(5000) },
			});
			daemon.emitDelta({ type: "stream_reset", reason: "test" });
			daemon.emitDelta({
				type: "event",
				event: { type: "notice", level: "info", message: "ring-me" },
			});
			await browser.waitForFrame(
				(f) =>
					f.type === "history" &&
					f.sessionId === entry.daemonId &&
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
				(f) => f.type === "event" && (f.event as { message?: string })?.message === "ring-me",
				"live event",
			);
			// Replay from just after the priming history: the ring must hold
			// the ringed deltas (state, ready, the live event) but NOT any
			// history/call_result/stream_reset/available_commands frame —
			// those are re-derivable (re-attach priming / re-POST), exactly
			// like the daemon's own ring.
			const replay = await collectReplay(
				served.port,
				browser.clientId,
				primingHistory.id,
				(f) => f.type === "event" && (f.event as { message?: string })?.message === "ring-me",
			);
			expect(replay.some(({ frame }) => frame.type === "event")).toBe(true);
			expect(replay.some(({ frame }) => frame.type === "state")).toBe(true); // live state deltas ARE ringed
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
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("byte-bound ring eviction drops the oldest deltas; replay after eviction still works (finding #5)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-ring-bytes-"));
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "ring-bytes",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 3000);
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		// Tiny per-client ring budget (~2.5 KiB): a burst of large deltas must
		// evict the ring's head, not grow without bound.
		const edge = new FleetEdge(
			{
				registry,
				connector,
				supervisor,
				config,
				eventLog: new FleetEventLog(),
				fleet: {
					port: 0,
					startedAt: Date.now(),
					statePath: "/tmp/fleet-test-state.json",
					configPath: null,
				},
			},
			{ ringBytes: 2500 },
		);
		const served = serveEdge(edge);
		try {
			const browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "attach", sessionId: entry.daemonId });
			await browser.waitForFrame(
				(f) => f.type === "attached" && f.sessionId === entry.daemonId,
				"attached",
			);
			// Wait out the pipe priming (ready is its last frame) so the burst
			// seqs are deterministic.
			await browser.waitForFrame((f) => f.type === "ready", "priming ready");
			// A burst of large ringed deltas: each block is ~700 bytes, so 20
			// of them blow well past the 2500-byte budget and evict the head.
			const N = 20;
			for (let i = 0; i < N; i++) {
				daemon.emitDelta({
					type: "event",
					event: { type: "notice", level: "info", message: `evict-${i}` + "x".repeat(600) },
				});
			}
			await browser.waitForFrame(
				(f) =>
					f.type === "event" &&
					((f.event as { message?: string })?.message?.startsWith("evict-19") ?? false),
				"last burst delta",
			);
			const firstId = browser.events.find(
				(ev) =>
					ev.frame.type === "event" &&
					(ev.frame.event as { message?: string })?.message?.startsWith("evict-0"),
			)!.id;
			// Replay from just before the burst: only the byte-eviction-
			// surviving tail replays — the newest delta is there, the oldest is
			// gone, and the survivors are a contiguous suffix in seq order
			// (drop-and-resume semantics: the browser resumes from what the
			// ring still holds, never a corrupted tail).
			const replay = await collectReplay(
				served.port,
				browser.clientId,
				firstId - 1,
				(f) =>
					f.type === "event" &&
					((f.event as { message?: string })?.message?.startsWith("evict-19") ?? false),
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
				return m ? Number(m[1]) : NaN;
			});
			expect(indices.every(Number.isInteger)).toBe(true);
			for (let i = 1; i < indices.length; i++) expect(indices[i]).toBe(indices[i - 1] + 1);
			expect(indices[indices.length - 1]).toBe(N - 1);
			// Seq order mirrors the survivor order (oldest first).
			const seqs = replayEvents.map(({ id }) => id);
			for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
		} finally {
			edge.close();
			await supervisor.close();
			await connector.close();
			daemon.close();
			served.stop();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
