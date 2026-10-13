/**
 * Fleet edge realtime daemon-activity tests: per-daemon
 * {type:"daemon_activity"} frames derived from the frames each session
 * mirrors onto its callback pair's control stream (state -> streaming,
 * ui_request / ui_request_end -> blocked). The only daemon is the shared
 * callback-pair fake dialing OUT to a real DaemonTransportRegistry; the
 * fleet never dials a session.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { Registry } from "../registry";
import { SpawnSupervisor } from "../supervisor";
import { startCallbackDaemon, type CallbackDaemon } from "./callback-daemon.testkit";
import { FAKE_CWD, FAKE_STATE, openBrowser, waitFor, type BrowserSocket } from "./edge.testkit";

afterAll(cleanupTempDirs);

/** One browser's daemon_activity frames for one daemon, in arrival order. */
function activityFrames(browser: BrowserSocket, daemonId: string) {
	return browser.frames.flatMap((f) =>
		f.type === "daemon_activity" && f.daemonId === daemonId ? [f] : [],
	);
}

function stateFrame(isStreaming: boolean) {
	return { type: "state", state: { ...FAKE_STATE, isStreaming } };
}

function dialogOpen(id: string) {
	return { type: "ui_request", id, method: "confirm", params: {} };
}

function dialogEnd(id: string) {
	return { type: "ui_request_end", id };
}

describe("edge realtime daemon activity (callback control stream)", () => {
	/** Registry + transport + edge on one port serving both /callback and the edge routes. */
	async function setup() {
		const tmp = tempDir("omp-web-edge-activity-");
		const statePath = join(tmp, "state.json");
		const registry = new Registry(statePath);
		await registry.load();
		const config: FleetConfig = {
			templates: { local: { command: "true" } },
			defaultTemplate: "local",
			workspaceDir: join(tmp, "workspaces"),
			bind: "127.0.0.1",
		};
		const transport = new DaemonTransportRegistry();
		const supervisor = new SpawnSupervisor(registry, config, {
			transport,
			statePath,
			callbackUrl: () => "https://fleet.test/callback",
		});
		const edge = new FleetEdge({
			registry,
			supervisor,
			config,
			eventLog: new FleetEventLog(),
			transport,
			fleet: { port: 0, startedAt: Date.now(), statePath, configPath: null, bind: "127.0.0.1" },
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (req) =>
				(await transport.handleFetch(req)) ??
				(await edge.handleFetch(req)) ??
				new Response("not found", { status: 404 }),
		});
		const port = server.port;
		if (port === undefined) throw new Error("edge test server bound no port");
		const url = `http://127.0.0.1:${port}`;
		const daemons: CallbackDaemon[] = [];
		const browsers: BrowserSocket[] = [];
		return {
			registry,
			edge,
			port,
			/** A paired, ready spawned (non-clone) roster entry and its connected callback daemon. */
			async addDaemon(name: string) {
				const entry = registry.create({
					name,
					cwd: FAKE_CWD,
					project: "fake-proj",
					labels: [],
					mode: "spawned",
					status: "ready",
				});
				const token = randomBytes(32).toString("hex");
				transport.enrollWorkspace(entry.daemonId, 1, token);
				const daemon = startCallbackDaemon({
					url,
					workspaceId: entry.daemonId,
					generation: 1,
					token,
				});
				daemons.push(daemon);
				await daemon.waitConnected();
				return { entry, daemon };
			},
			async browser() {
				const browser = await openBrowser(port);
				browsers.push(browser);
				await browser.waitForFrame((f) => f.type === "roster", "roster priming");
				return browser;
			},
			async teardown() {
				for (const browser of browsers) browser.close();
				for (const daemon of daemons) await daemon.stop();
				edge.close();
				await supervisor.close();
				transport.close();
				server.stop(true);
			},
		};
	}

	test("state / ui_request / ui_request_end derive streaming+blocked; unchanged values emit nothing", async () => {
		const s = await setup();
		try {
			const { entry, daemon } = await s.addDaemon("act");
			// Nothing derivable yet: activity unknown, but the pair is live.
			expect(s.edge.daemonActivity(entry.daemonId)).toMatchObject({ known: false, live: true });
			const browser = await s.browser();
			expect(activityFrames(browser, entry.daemonId)).toHaveLength(0);

			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 1 ? "ok" : null),
				3000,
				"streaming activity",
			);
			expect(activityFrames(browser, entry.daemonId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});
			expect(s.edge.daemonActivity(entry.daemonId)).toMatchObject({
				known: true,
				streaming: true,
				blocked: false,
			});

			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 2 ? "ok" : null),
				3000,
				"blocked activity",
			);
			expect(activityFrames(browser, entry.daemonId).at(-1)).toMatchObject({
				streaming: true,
				blocked: true,
			});

			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 3 ? "ok" : null),
				3000,
				"unblocked activity",
			);
			expect(activityFrames(browser, entry.daemonId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});

			// Same-value state, an end for a dialog that is not open, then a
			// genuine change. The stream is ordered, so once the final change
			// has surfaced any duplicate frame would already be counted.
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 4 ? "ok" : null),
				3000,
				"re-block broadcast",
			);
			expect(activityFrames(browser, entry.daemonId).at(-1)).toMatchObject({ blocked: true });

			// Re-opening the already-open dialog is not a change; closing it
			// turns the daemon back to unblocked.
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 5 ? "ok" : null),
				3000,
				"unblock after replayed open",
			);
			expect(activityFrames(browser, entry.daemonId).at(-1)).toMatchObject({ blocked: false });
			expect(activityFrames(browser, entry.daemonId)).toHaveLength(5);
		} finally {
			await s.teardown();
		}
	});

	test("a new browser stream primes the known activity of a ready daemon", async () => {
		const s = await setup();
		try {
			const { entry, daemon } = await s.addDaemon("primed");
			// Derive activity before any browser exists.
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (s.edge.daemonActivity(entry.daemonId).known ? "known" : null),
				3000,
				"activity derived",
			);
			const browser = await openBrowser(s.port);
			try {
				await browser.waitForFrame(
					(f) =>
						f.type === "daemon_activity" &&
						f.daemonId === entry.daemonId &&
						f.streaming === true &&
						f.blocked === false,
					"primed activity",
				);
			} finally {
				browser.close();
			}
		} finally {
			await s.teardown();
		}
	});

	test("activity is tracked per daemon", async () => {
		const s = await setup();
		try {
			const a = await s.addDaemon("alpha");
			const b = await s.addDaemon("beta");
			const browser = await s.browser();
			a.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			b.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("only-b"));
			await waitFor(
				() =>
					activityFrames(browser, a.entry.daemonId).length === 1 &&
					activityFrames(browser, b.entry.daemonId).length === 1
						? "ok"
						: null,
				3000,
				"one activity frame per daemon",
			);
			expect(activityFrames(browser, a.entry.daemonId)[0]).toMatchObject({
				streaming: true,
				blocked: false,
			});
			expect(activityFrames(browser, b.entry.daemonId)[0]).toMatchObject({
				streaming: false,
				blocked: true,
			});
		} finally {
			await s.teardown();
		}
	});

	test("a removed daemon emits no further activity", async () => {
		const s = await setup();
		try {
			const { entry, daemon } = await s.addDaemon("gone");
			// A second, still-registered daemon whose activity change is the
			// ordered barrier frame (see below).
			const sentinel = await s.addDaemon("sentinel");
			const browser = await s.browser();
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (activityFrames(browser, entry.daemonId).length === 1 ? "ok" : null),
				3000,
				"first activity",
			);
			s.registry.remove(entry.daemonId);
			// Stale frames for the removed daemon race the removal; none may
			// surface. The sentinel's activity change is driven AFTER them on
			// the same browser stream, so once it arrives every earlier frame
			// for the removed daemon has been processed and dropped.
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("late"));
			sentinel.daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await browser.waitForFrame(
				(f) => f.type === "daemon_activity" && f.daemonId === sentinel.entry.daemonId,
				"sentinel activity",
			);
			expect(activityFrames(browser, entry.daemonId)).toHaveLength(1);
			expect(activityFrames(browser, entry.daemonId)[0]).toMatchObject({
				streaming: true,
				blocked: false,
			});
		} finally {
			await s.teardown();
		}
	});

	test("daemon_activity frames carry only daemonId, streaming, and blocked", async () => {
		const s = await setup();
		try {
			const { entry, daemon } = await s.addDaemon("shape");
			const browser = await s.browser();
			daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await browser.waitForFrame(
				(f) => f.type === "daemon_activity" && f.daemonId === entry.daemonId,
				"activity",
			);
			for (const frame of activityFrames(browser, entry.daemonId)) {
				expect(Object.keys(frame).sort()).toEqual(["blocked", "daemonId", "streaming", "type"]);
			}
		} finally {
			await s.teardown();
		}
	});
});
