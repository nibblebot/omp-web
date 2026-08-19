/**
 * Fleet edge realtime daemon-activity tests: per-daemon
 * {type:"daemon_activity"} derivation (state → streaming, ui_request /
 * ui_request_end → blocked) and the browser-gated retain-all that keeps every
 * READY daemon's connector stream live (suspending its idle auto-exit) while
 * ≥1 browser /events stream is open. Standalone per-test edge mounts over a
 * FAKE pipe daemon — same hermetic pattern as edge-pipe.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "../shared/testkit";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import { FleetEdge } from "./edge";
import { FleetEventLog } from "./events";
import { Registry } from "./registry";
import { SpawnSupervisor } from "./supervisor";
import {
	FAKE_CWD,
	FAKE_TOKEN,
	openBrowser,
	serveEdge,
	sleep,
	startPipeFake,
	waitFor,
	type PipeFake,
} from "./edge.testkit";

/** Collect only the browser's daemon_activity frames for one daemon. */
function activityFrames(
	browser: { frames: unknown[] },
	daemonId: string,
): Array<{ streaming: boolean; blocked: boolean }> {
	return browser.frames.filter(
		(f): f is { type: "daemon_activity"; daemonId: string; streaming: boolean; blocked: boolean } =>
			typeof f === "object" &&
			f !== null &&
			(f as { type?: string }).type === "daemon_activity" &&
			(f as { daemonId?: string }).daemonId === daemonId,
	);
}

describe("edge realtime daemon activity (browser-gated retain-all)", () => {
	/** Build a registry + connector + ready daemon + edge over one fake pipe daemon. */
	async function setup() {
		const tmp = tempDir("omp-web-edge-activity-");
		const registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		const connector = new DaemonConnector(registry, undefined, {
			backoffMinMs: 10,
			backoffMaxMs: 50,
			idleDropMs: 60_000,
		});
		const daemon = startPipeFake({ heartbeatMs: 30 });
		const entry = registry.create({
			name: "act",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "remote",
			endpoint: daemon.url,
			token: FAKE_TOKEN,
			status: "connecting",
		});
		const config: FleetConfig = {
			templates: {},
			defaultTemplate: "local",
			workspaceDir: "/tmp/fleet-test-ws",
		};
		const supervisor = new SpawnSupervisor(registry, connector, config);
		// Count retain/release so the tests assert the lifecycle (exactly-once).
		let retains = 0;
		let releases = 0;
		const origRetain = connector.retain.bind(connector);
		connector.retain = (daemonId: string) => {
			retains++;
			origRetain(daemonId);
		};
		const origRelease = connector.release.bind(connector);
		connector.release = (daemonId: string) => {
			releases++;
			origRelease(daemonId);
		};
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
		const served = serveEdge(edge);
		return {
			registry,
			connector,
			supervisor,
			daemon,
			entry,
			edge,
			served,
			counts: () => ({ retains, releases }),
		};
	}

	async function ready(s: Awaited<ReturnType<typeof setup>>) {
		s.connector.connect(s.entry.daemonId);
		await s.connector.waitReady(s.entry.daemonId, 3000);
		expect(s.registry.get(s.entry.daemonId)?.status).toBe("ready");
	}

	async function teardown(s: Awaited<ReturnType<typeof setup>>) {
		s.edge.close();
		await s.supervisor.close();
		await s.connector.close();
		s.daemon.close();
		s.served.stop();
	}

	test("a browser stream open retains + dials every READY daemon; closing releases it exactly once", async () => {
		const s = await setup();
		try {
			await ready(s);
			expect(s.counts().retains).toBe(0);
			// Open a browser: the ready daemon is retained + kept dialed.
			const browser = await openBrowser(s.served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster priming");
			expect(s.counts().retains).toBe(1);
			expect(s.connector.isConnected(s.entry.daemonId)).toBe(true);
			// A second browser must not double-retain (guarded re-entry).
			const browser2 = await openBrowser(s.served.port);
			await browser2.waitForFrame((f) => f.type === "roster", "roster priming");
			expect(s.counts().retains).toBe(1);
			// Last browser closes → every retain released (idle-drop re-armed).
			browser.close();
			browser2.close();
			await waitFor(() => (s.counts().releases === 1 ? "released" : null), 3000, "released");
			expect(s.counts().releases).toBe(1);
		} finally {
			await teardown(s);
		}
	});

	test("state / ui_request / ui_request_end derive streaming+blocked; repeat values emit no duplicate frame", async () => {
		const s = await setup();
		try {
			await ready(s);
			const browser = await openBrowser(s.served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster priming");
			// Every wait targets the frame COUNT: value predicates would match
			// stale earlier frames (blocked:true looks identical across opens)
			// and race ahead of SSE delivery.
			const count = () => activityFrames(browser, s.entry.daemonId).length;
			const last = () => activityFrames(browser, s.entry.daemonId).at(-1);
			const waitCount = async (n: number, what: string) => {
				await waitFor(() => (count() === n ? "ok" : null), 3000, what);
			};
			const open = count(); // priming may already carry a known value
			// state → streaming:true (unknown→known counts as a change).
			s.daemon.emitDelta({
				type: "state",
				state: { sessionId: "s1", isStreaming: true, controlRecordCount: 0 } as never,
			});
			await waitCount(open + 1, "streaming activity");
			expect(last()).toMatchObject({ streaming: true, blocked: false });
			// ui_request → blocked:true.
			s.daemon.emitDelta({ type: "ui_request", id: "r1", method: "confirm", params: {} });
			await waitCount(open + 2, "blocked activity");
			expect(last()).toMatchObject({ streaming: true, blocked: true });
			// ui_request_end → blocked:false.
			s.daemon.emitDelta({ type: "ui_request_end", id: "r1" });
			await waitCount(open + 3, "unblocked activity");
			expect(last()).toMatchObject({ streaming: true, blocked: false });
			// Repeats of the same values must NOT emit another frame; only the
			// re-open (a genuine change) does.
			s.daemon.emitDelta({
				type: "state",
				state: { sessionId: "s1", isStreaming: true, controlRecordCount: 1 } as never,
			});
			s.daemon.emitDelta({ type: "ui_request_end", id: "r1" }); // already closed
			s.daemon.emitDelta({ type: "ui_request", id: "r1", method: "confirm", params: {} }); // re-open → blocked:true (a change!)
			await waitCount(open + 4, "re-block broadcast");
			expect(last()).toMatchObject({ streaming: true, blocked: true });
		} finally {
			await teardown(s);
		}
	});

	test("a new browser stream primes the current known activity for a ready daemon", async () => {
		const s = await setup();
		try {
			await ready(s);
			// Derive activity BEFORE any browser opens (no broadcast with no clients).
			s.daemon.emitDelta({
				type: "state",
				state: { sessionId: "s1", isStreaming: true, controlRecordCount: 0 } as never,
			});
			// Open a browser: priming carries the known {streaming:true}.
			const browser = await openBrowser(s.served.port);
			await browser.waitForFrame(
				(f) =>
					f.type === "daemon_activity" &&
					f.daemonId === s.entry.daemonId &&
					f.streaming === true &&
					f.blocked === false,
				"primed activity",
			);
		} finally {
			await teardown(s);
		}
	});

	test("a watched daemon going dormant (asleep) is released and emits no further activity frames", async () => {
		const s = await setup();
		try {
			await ready(s);
			const browser = await openBrowser(s.served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster priming");
			expect(s.counts().retains).toBe(1);
			expect(s.counts().releases).toBe(0);
			// The daemon goes dormant: a CLEAN end of its /events stream (the real
			// daemon's idle auto-exit closes it before exiting) → status "asleep".
			// daemon.close() would nuke the server mid-stream — an UNCLEAN end →
			// reconnecting/redial, never asleep. kill() closes the controllers.
			s.daemon.kill();
			await waitFor(() => (s.counts().releases === 1 ? "released" : null), 3000, "released");
			expect(s.counts().releases).toBe(1);
			await waitFor(
				() => (s.registry.get(s.entry.daemonId)?.status === "asleep" ? "asleep" : null),
				3000,
				"daemon asleep",
			);
			const before = activityFrames(browser, s.entry.daemonId).length;
			await sleep(150);
			// No activity frame follows the dormancy.
			expect(activityFrames(browser, s.entry.daemonId).length).toBe(before);
		} finally {
			await teardown(s);
		}
	});

	test("daemon_activity frames never carry sessionId / token / endpoint fields", async () => {
		const s = await setup();
		try {
			await ready(s);
			const browser = await openBrowser(s.served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster priming");
			s.daemon.emitDelta({
				type: "state",
				state: { sessionId: "s1", isStreaming: true, controlRecordCount: 0 } as never,
			});
			await browser.waitForFrame(
				(f) => f.type === "daemon_activity" && f.daemonId === s.entry.daemonId,
				"activity",
			);
			for (const f of activityFrames(browser, s.entry.daemonId)) {
				const record = f as unknown as Record<string, unknown>;
				expect(record).not.toHaveProperty("token");
				expect(record).not.toHaveProperty("endpoint");
				expect(record).not.toHaveProperty("sessionId");
			}
		} finally {
			await teardown(s);
		}
	});
});
