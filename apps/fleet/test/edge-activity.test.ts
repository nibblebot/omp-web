/**
 * Fleet edge realtime session-activity tests: per-session
 * {type:"session_activity"} frames derived from the frames each session
 * mirrors onto its callback pair's control stream (state and agent_start ->
 * streaming, ui_request / ui_request_end and state pendingUiRequestIds ->
 * blocked), reset when the row's process is gone. The only session is the shared
 * callback-pair fake dialing OUT to a real SessionTransportRegistry; the
 * fleet never dials a session.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import type { WireTurnOutcome } from "#lib/wire/protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { SessionTransportRegistry } from "../session-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { Registry } from "../registry";
import { ProjectSync } from "../project-sync";
import { startCallbackSession, type CallbackSession } from "./callback-session.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import {
	FAKE_CWD,
	FAKE_STATE,
	openBrowser,
	serveEdge,
	testEviction,
	testWaker,
	waitFor,
	type BrowserSocket,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

/** One browser's session_activity frames for one session, in arrival order. */
function activityFrames(browser: BrowserSocket, workspaceId: string) {
	return browser.frames.flatMap((f) =>
		f.type === "session_activity" && f.workspaceId === workspaceId ? [f] : [],
	);
}

function stateFrame(isStreaming: boolean, pendingUiRequestIds?: string[]) {
	return {
		type: "state",
		state: {
			...FAKE_STATE,
			isStreaming,
			...(pendingUiRequestIds === undefined ? {} : { pendingUiRequestIds }),
		},
	};
}

function dialogOpen(id: string) {
	return { type: "ui_request", id, method: "confirm", params: {} };
}

function dialogEnd(id: string) {
	return { type: "ui_request_end", id };
}

function agentEnd(fields: Record<string, unknown>) {
	return { type: "event", event: { type: "agent_end", ...fields } };
}

describe("edge realtime session activity (callback control stream)", () => {
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
		const transport = new SessionTransportRegistry();
		const { lifecycle } = makeHostLifecycle({
			registry,
			config,
			transport,
			statePath,
			callbackUrl: () => "https://fleet.test/callback",
		});
		const edge = new FleetEdge({
			registry,
			lifecycle,
			sync: new ProjectSync(registry, lifecycle),
			eviction: testEviction(registry, lifecycle),
			waker: testWaker(registry, lifecycle, transport),
			config,
			eventLog: new FleetEventLog(),
			transport,
			fleet: { port: 0, startedAt: Date.now(), statePath, configPath: null, bind: "127.0.0.1" },
		});
		const server = serveEdge(edge, transport);
		const port = server.port;
		const url = `http://127.0.0.1:${port}`;
		const sessions: CallbackSession[] = [];
		const browsers: BrowserSocket[] = [];
		return {
			registry,
			edge,
			port,
			/** A paired, ready spawned (non-clone) roster entry and its connected callback session. */
			async addSession(name: string) {
				const entry = registry.create({
					name,
					cwd: FAKE_CWD,
					project: "fake-proj",
					status: "ready",
				});
				const token = randomBytes(32).toString("hex");
				transport.enrollWorkspace(entry.workspaceId, 1, token);
				const session = startCallbackSession({
					url,
					workspaceId: entry.workspaceId,
					generation: 1,
					token,
				});
				sessions.push(session);
				await session.waitConnected();
				return { entry, session };
			},
			async browser() {
				const browser = await openBrowser(port);
				browsers.push(browser);
				await browser.waitForFrame((f) => f.type === "roster", "roster priming");
				return browser;
			},
			async teardown() {
				for (const browser of browsers) browser.close();
				for (const session of sessions) await session.stop();
				edge.close();
				lifecycle.close();
				transport.close();
				server.stop();
			},
		};
	}

	test("state / ui_request / ui_request_end derive streaming+blocked; unchanged values emit nothing", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("act");
			// Nothing derivable yet: activity unknown, but the pair is live.
			expect(s.edge.sessionActivity(entry.workspaceId)).toMatchObject({ known: false, live: true });
			const browser = await s.browser();
			expect(activityFrames(browser, entry.workspaceId)).toHaveLength(0);

			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 1 ? "ok" : null),
				3000,
				"streaming activity",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});
			expect(s.edge.sessionActivity(entry.workspaceId)).toMatchObject({
				known: true,
				streaming: true,
				blocked: false,
			});

			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"blocked activity",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: true,
			});

			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 3 ? "ok" : null),
				3000,
				"unblocked activity",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});

			// Same-value state, an end for a dialog that is not open, then a
			// genuine change. The stream is ordered, so once the final change
			// has surfaced any duplicate frame would already be counted.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 4 ? "ok" : null),
				3000,
				"re-block broadcast",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({ blocked: true });

			// Re-opening the already-open dialog is not a change; closing it
			// turns the session back to unblocked.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 5 ? "ok" : null),
				3000,
				"unblock after replayed open",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({ blocked: false });
			expect(activityFrames(browser, entry.workspaceId)).toHaveLength(5);
		} finally {
			await s.teardown();
		}
	});

	test("a state snapshot with pendingUiRequestIds clears a dialog whose end was lost, in one broadcast", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("lost-end");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 1 ? "ok" : null),
				3000,
				"blocked activity",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: false,
				blocked: true,
			});

			// The ui_request_end never arrives (pair drop / session restart);
			// the pair-up state snapshot reports no pending dialogs. Streaming
			// and blocked change together: one frame, not two.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true, []));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"unblocked by snapshot",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});

			// A late end for the cleared dialog is a no-op; the next genuine
			// change (ordered after it) is the barrier proving no extra frame.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r2"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 3 ? "ok" : null),
				3000,
				"re-block barrier",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({ blocked: true });
			expect(activityFrames(browser, entry.workspaceId)).toHaveLength(3);
		} finally {
			await s.teardown();
		}
	});

	test("a state snapshot naming a pending dialog blocks the session; its ui_request_end clears it", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("fresh-plane");
			const browser = await s.browser();
			// No ui_request was ever observed (dialog opened before pair-up).
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true, ["x"]));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 1 ? "ok" : null),
				3000,
				"blocked by snapshot",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: true,
			});
			expect(s.edge.sessionActivity(entry.workspaceId)).toMatchObject({
				known: true,
				blocked: true,
			});

			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("x"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"unblocked by end",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});
		} finally {
			await s.teardown();
		}
	});

	test("an agent_start event marks the session streaming; the turn-end state clears it", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("turn-start");
			const browser = await s.browser();
			// The real order: a prompt's resync state (still idle, the SDK has not
			// admitted the turn yet), then agent_start with no state frame, then
			// the turn-end state.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false, []));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"streaming from agent_start",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});

			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false, []));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 3 ? "ok" : null),
				3000,
				"idle from the turn-end state",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: false,
				blocked: false,
			});
		} finally {
			await s.teardown();
		}
	});

	test("a state frame without pendingUiRequestIds leaves delta-derived blocked untouched", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("legacy-state");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"blocked then streaming",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: true,
			});

			// The open set survived the field-less state: its end still unblocks.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogEnd("r1"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 3 ? "ok" : null),
				3000,
				"unblocked by end",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
				streaming: true,
				blocked: false,
			});
		} finally {
			await s.teardown();
		}
	});

	test("a new browser stream primes the known activity of a ready session", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("primed");
			// Derive activity before any browser exists.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (s.edge.sessionActivity(entry.workspaceId).known ? "known" : null),
				3000,
				"activity derived",
			);
			const browser = await openBrowser(s.port);
			try {
				await browser.waitForFrame(
					(f) =>
						f.type === "session_activity" &&
						f.workspaceId === entry.workspaceId &&
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

	test("a new browser stream also primes the known activity of a non-ready session", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("asleep");
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			await waitFor(
				() => (s.edge.sessionActivity(entry.workspaceId).known ? "known" : null),
				3000,
				"activity derived",
			);
			// Idle-exited: the browser may hold a stale streaming:true from
			// before it went offline, and no wake-time state would correct it.
			s.registry.setStatus(entry.workspaceId, "asleep");
			const browser = await openBrowser(s.port);
			try {
				await browser.waitForFrame(
					(f) =>
						f.type === "session_activity" &&
						f.workspaceId === entry.workspaceId &&
						f.streaming === false &&
						f.blocked === false,
					"primed activity of non-ready session",
				);
			} finally {
				browser.close();
			}
		} finally {
			await s.teardown();
		}
	});

	const goneRuntimes: { name: string; mark: (registry: Registry, id: string) => void }[] = [
		{ name: "goes asleep", mark: (registry, id) => registry.setStatus(id, "asleep") },
		{ name: "errors", mark: (registry, id) => registry.setStatus(id, "error", "gave up") },
		{
			name: "relaunches",
			mark: (registry, id) => registry.update(id, { lifecycleStage: "runtime" }),
		},
	];
	for (const gone of goneRuntimes) {
		test(`a session mid-turn with a dialog open resets to idle when its row ${gone.name}`, async () => {
			const s = await setup();
			try {
				const { entry, session } = await s.addSession("died");
				const browser = await s.browser();
				session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
					type: "event",
					event: { type: "agent_start" },
				});
				session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("r1"));
				await waitFor(
					() => (activityFrames(browser, entry.workspaceId).at(-1)?.blocked === true ? "ok" : null),
					3000,
					"streaming and blocked",
				);
				expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
					streaming: true,
				});

				// The process is gone: no state frame will ever clear what it set.
				gone.mark(s.registry, entry.workspaceId);
				await waitFor(
					() =>
						activityFrames(browser, entry.workspaceId).at(-1)?.blocked === false ? "ok" : null,
					3000,
					"reset broadcast",
				);
				expect(activityFrames(browser, entry.workspaceId).at(-1)).toMatchObject({
					streaming: false,
				});

				const late = await openBrowser(s.port);
				try {
					await late.waitForFrame(
						(f) => f.type === "session_activity" && f.workspaceId === entry.workspaceId,
						"primed activity",
					);
					expect(activityFrames(late, entry.workspaceId)).toEqual([
						expect.objectContaining({ streaming: false, blocked: false }),
					]);
				} finally {
					late.close();
				}
			} finally {
				await s.teardown();
			}
		});
	}

	test("a pair drop with a live runtime keeps the turn's activity", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("blip");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).at(-1)?.streaming === true ? "ok" : null),
				3000,
				"streaming",
			);
			s.registry.setStatus(entry.workspaceId, "reconnecting");
			// Barrier: the next broadcast must still carry the running turn.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("barrier"));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).at(-1)?.blocked === true ? "ok" : null),
				3000,
				"barrier",
			);
			expect(activityFrames(browser, entry.workspaceId).map((f) => f.streaming)).not.toContain(
				false,
			);
		} finally {
			await s.teardown();
		}
	});

	test("activity is tracked per session", async () => {
		const s = await setup();
		try {
			const a = await s.addSession("alpha");
			const b = await s.addSession("beta");
			const browser = await s.browser();
			a.session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			b.session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("only-b"));
			await waitFor(
				() =>
					activityFrames(browser, a.entry.workspaceId).length === 1 &&
					activityFrames(browser, b.entry.workspaceId).length === 1
						? "ok"
						: null,
				3000,
				"one activity frame per session",
			);
			expect(activityFrames(browser, a.entry.workspaceId)[0]).toMatchObject({
				streaming: true,
				blocked: false,
			});
			expect(activityFrames(browser, b.entry.workspaceId)[0]).toMatchObject({
				streaming: false,
				blocked: true,
			});
		} finally {
			await s.teardown();
		}
	});

	test("a removed session emits no further activity", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("gone");
			// A second, still-registered session whose activity change is the
			// ordered barrier frame (see below).
			const sentinel = await s.addSession("sentinel");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 1 ? "ok" : null),
				3000,
				"first activity",
			);
			s.registry.remove(entry.workspaceId);
			// Stale frames for the removed session race the removal; none may
			// surface. The sentinel's activity change is driven AFTER them on
			// the same browser stream, so once it arrives every earlier frame
			// for the removed session has been processed and dropped.
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", dialogOpen("late"));
			sentinel.session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			await browser.waitForFrame(
				(f) => f.type === "session_activity" && f.workspaceId === sentinel.entry.workspaceId,
				"sentinel activity",
			);
			expect(activityFrames(browser, entry.workspaceId)).toHaveLength(1);
			expect(activityFrames(browser, entry.workspaceId)[0]).toMatchObject({
				streaming: true,
				blocked: false,
			});
		} finally {
			await s.teardown();
		}
	});

	test("session_activity frames without a turn end carry only workspaceId, streaming, and blocked", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("shape");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(true));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", agentEnd({ yielded: false }));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"streaming then idle activity",
			);
			for (const frame of activityFrames(browser, entry.workspaceId)) {
				expect(Object.keys(frame).sort()).toEqual(["blocked", "streaming", "type", "workspaceId"]);
			}
		} finally {
			await s.teardown();
		}
	});

	const turnOutcomes: { name: string; lastAssistant?: unknown; expected: WireTurnOutcome }[] = [
		{ name: "complete", lastAssistant: { stopReason: "stop" }, expected: { stopReason: "stop" } },
		{
			name: "error with its message",
			lastAssistant: { stopReason: "error", errorMessage: "boom" },
			expected: { stopReason: "error", errorMessage: "boom" },
		},
		{
			name: "aborted",
			lastAssistant: { stopReason: "aborted" },
			expected: { stopReason: "aborted" },
		},
		{ name: "a run with no assistant message", expected: {} },
		{
			name: "an untrusted outcome (only well-typed outcome fields are forwarded)",
			lastAssistant: { stopReason: 7, errorMessage: { x: 1 }, content: "secret" },
			expected: {},
		},
	];
	for (const outcome of turnOutcomes) {
		test(`the turn-end flip carries endedTurn for ${outcome.name}`, async () => {
			const s = await setup();
			try {
				const { entry, session } = await s.addSession("ended");
				const browser = await s.browser();
				session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
					type: "event",
					event: { type: "agent_start" },
				});
				// The real order: the agent_end event, then the async state frame.
				session.send(
					CALLBACK_CONTROL_STREAM_ID,
					"frame",
					agentEnd({ yielded: true, isTerminal: true, lastAssistant: outcome.lastAssistant }),
				);
				session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
				await waitFor(
					() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
					3000,
					"turn-end flip",
				);
				const [start, end] = activityFrames(browser, entry.workspaceId);
				expect(start).not.toHaveProperty("endedTurn");
				expect(end).toEqual({
					type: "session_activity",
					workspaceId: entry.workspaceId,
					streaming: false,
					blocked: false,
					endedTurn: outcome.expected,
				});
			} finally {
				await s.teardown();
			}
		});
	}

	test("a yielded:false agent_end, or a non-terminal error pause, is not a turn end", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("continues");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			session.send(
				CALLBACK_CONTROL_STREAM_ID,
				"frame",
				agentEnd({ yielded: false, lastAssistant: { stopReason: "stop" } }),
			);
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			session.send(
				CALLBACK_CONTROL_STREAM_ID,
				"frame",
				agentEnd({
					isTerminal: false,
					lastAssistant: { stopReason: "error", errorMessage: "paused" },
				}),
			);
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 4 ? "ok" : null),
				3000,
				"two idle flips",
			);
			for (const frame of activityFrames(browser, entry.workspaceId)) {
				expect(frame).not.toHaveProperty("endedTurn");
			}
		} finally {
			await s.teardown();
		}
	});

	test("priming never carries endedTurn, even after a turn-end flip", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("late");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			session.send(
				CALLBACK_CONTROL_STREAM_ID,
				"frame",
				agentEnd({ yielded: true, lastAssistant: { stopReason: "stop" } }),
			);
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", stateFrame(false));
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"turn-end flip",
			);
			expect(activityFrames(browser, entry.workspaceId).at(-1)).toHaveProperty("endedTurn");

			// A browser opening afterwards is primed with the idle value only.
			const late = await openBrowser(s.port);
			try {
				await late.waitForFrame(
					(f) => f.type === "session_activity" && f.workspaceId === entry.workspaceId,
					"primed activity",
				);
				const primed = activityFrames(late, entry.workspaceId);
				expect(primed).toHaveLength(1);
				expect(Object.keys(primed[0] ?? {}).sort()).toEqual([
					"blocked",
					"streaming",
					"type",
					"workspaceId",
				]);
			} finally {
				late.close();
			}
		} finally {
			await s.teardown();
		}
	});

	test("a runtime-gone reset after a stashed turn end carries no endedTurn", async () => {
		const s = await setup();
		try {
			const { entry, session } = await s.addSession("died-after-end");
			const browser = await s.browser();
			session.send(CALLBACK_CONTROL_STREAM_ID, "frame", {
				type: "event",
				event: { type: "agent_start" },
			});
			// The turn ended but its state frame never arrived: the process died.
			session.send(
				CALLBACK_CONTROL_STREAM_ID,
				"frame",
				agentEnd({ yielded: true, lastAssistant: { stopReason: "stop" } }),
			);
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 1 ? "ok" : null),
				3000,
				"streaming activity",
			);
			s.registry.setStatus(entry.workspaceId, "asleep");
			await waitFor(
				() => (activityFrames(browser, entry.workspaceId).length === 2 ? "ok" : null),
				3000,
				"reset broadcast",
			);
			const reset = activityFrames(browser, entry.workspaceId).at(-1);
			expect(reset).toMatchObject({ streaming: false });
			expect(reset).not.toHaveProperty("endedTurn");
		} finally {
			await s.teardown();
		}
	});
});
