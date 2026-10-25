/**
 * Fan-out prompt correlation tests over the callback pair. Every session is a
 * controlled callback session (callback-session.testkit.ts) dialing OUT to a
 * real SessionTransportRegistry served over loopback HTTP; the fleet never
 * dials. The session plays the session half: it reads the `prompt` call off
 * its down leg, answers with call_result and mirrors turn frames on the
 * control stream, exactly like the real session (the call_result for a call
 * precedes that call's turn frames; it is the acceptance verdict that scopes
 * correlation, audit #21). Covers promptEntry's correlation contract (own-turn
 * agent_end only, unrelated frames ignored), per-session serialization of
 * concurrent fan-outs, fanOut's order preservation across mixed outcomes, and
 * the wake path: spawned asleep entries respawn and wait for the pair,
 * unpaired entries fail with a typed error.
 */

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { SessionTransportRegistry, type CallbackSocketData } from "../session-transport";
import { fanOut, promptEntry, type FanoutDeps } from "../fanout";
import { Registry, type RegistryEntry } from "../registry";
import { SessionWaker } from "../session-waker";
import type { WorkspaceLifecycle } from "../workspace-lifecycle";
import { startCallbackSession, type CallbackSession } from "./callback-session.testkit";
import { sleep, waitFor } from "./edge.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";

type CreateInit = Parameters<Registry["create"]>[0];

interface Fixture {
	deps: FanoutDeps;
	registry: Registry;
	transport: SessionTransportRegistry;
	/** The lifecycle the fixture's waker wakes through (tests may override start). */
	lifecycle: WorkspaceLifecycle;
	/** workspaceIds the stubbed lifecycle.start was asked to wake, in order. */
	respawned: string[];
	/** Register a spawned entry in the registry. */
	create(overrides?: Partial<CreateInit>): RegistryEntry;
	/** Enroll the entry and start its session dialing out (does not wait for the pair). */
	dial(entry: RegistryEntry): CallbackSession;
	/** Resolves with the session once one exists for the entry (dialed by the test or by respawn). */
	sessionFor(workspaceId: string): Promise<CallbackSession>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startFixture(): Fixture {
	const dir = tempDir("omp-web-fanout-");
	const statePath = `${dir}/state.json`;
	const registry = new Registry(statePath);
	const transport = new SessionTransportRegistry();
	const server: Server<CallbackSocketData> = Bun.serve<CallbackSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req, srv) => {
			const handled = await transport.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
		websocket: transport.websocket,
	});
	const url = `http://127.0.0.1:${server.port}`;
	const config: FleetConfig = {
		templates: {},
		defaultTemplate: "local",
		workspaceDir: `${dir}/ws`,
		bind: "127.0.0.1",
	};
	const { lifecycle } = makeHostLifecycle({
		registry,
		config,
		transport,
		statePath,
		callbackUrl: () => `${url}/callback`,
	});
	const respawned: string[] = [];
	const sessions = new Map<string, PromiseWithResolvers<CallbackSession>>();
	const slot = (workspaceId: string): PromiseWithResolvers<CallbackSession> => {
		let existing = sessions.get(workspaceId);
		if (!existing) {
			existing = Promise.withResolvers<CallbackSession>();
			sessions.set(workspaceId, existing);
		}
		return existing;
	};
	const dial = (entry: RegistryEntry): CallbackSession => {
		const token = randomBytes(32).toString("hex");
		transport.enrollWorkspace(entry.workspaceId, 1, token);
		const session = startCallbackSession({
			url,
			workspaceId: entry.workspaceId,
			generation: 1,
			token,
		});
		cleanups.push(() => session.stop());
		slot(entry.workspaceId).resolve(session);
		return session;
	};
	// The real lifecycle launches a child that dials out; the stand-in starts
	// the same dialing session without waiting for it to connect.
	lifecycle.start = async (workspaceId) => {
		respawned.push(workspaceId);
		dial(registry.get(workspaceId)!);
	};
	cleanups.push(async () => {
		lifecycle.close();
		transport.close();
		await server.stop(true);
	});
	return {
		deps: {
			registry,
			transport,
			waker: new SessionWaker({ registry, lifecycle, transport }),
		},
		registry,
		transport,
		lifecycle,
		respawned,
		create(overrides = {}) {
			return registry.create({
				name: `proj-${registry.list().length}`,
				cwd: "/srv/proj",
				project: "proj",
				status: "ready",
				...overrides,
			});
		},
		dial,
		sessionFor: (workspaceId) => slot(workspaceId).promise,
	};
}

/** Dial the entry's session and wait until the fleet sees the pair. */
async function pair(fx: Fixture, entry: RegistryEntry): Promise<CallbackSession> {
	const session = fx.dial(entry);
	await session.waitConnected(5000);
	await waitFor(
		() => (fx.transport.pairStatus(entry.workspaceId).paired ? true : null),
		5000,
		"pair up",
	);
	return session;
}

/** The nth `prompt` call the session has received on its down leg. */
async function nthPrompt(
	session: CallbackSession,
	n: number,
): Promise<{ id: string; args: unknown[] }> {
	return await waitFor(
		() => {
			const commands = session.received().filter((env) => env.kind === "command");
			const payload = commands[n]?.payload;
			if (
				typeof payload === "object" &&
				payload !== null &&
				"type" in payload &&
				payload.type === "call" &&
				"method" in payload &&
				payload.method === "prompt" &&
				"id" in payload &&
				typeof payload.id === "string" &&
				"args" in payload &&
				Array.isArray(payload.args)
			) {
				return { id: payload.id, args: payload.args };
			}
			return null;
		},
		5000,
		`prompt call ${n}`,
	);
}

function frame(session: CallbackSession, payload: unknown): void {
	session.send(CALLBACK_CONTROL_STREAM_ID, "frame", payload);
}

function sendEvent(session: CallbackSession, event: Record<string, unknown>): void {
	frame(session, { type: "event", workspaceId: "s1", event });
}

function assistantText(session: CallbackSession, text: string): void {
	sendEvent(session, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

/** One accepted turn: call_result ok, one assistant message, agent_end. */
function answerTurn(session: CallbackSession, callId: string, text: string): void {
	frame(session, { type: "call_result", id: callId, ok: true });
	assistantText(session, text);
	sendEvent(session, { type: "agent_end", messages: [] });
}

describe("promptEntry", () => {
	test("happy path: last assistant text + usage from agent_end; the prompt call reaches the session", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(session, 0);
		expect(call.args).toEqual(["hi"]);
		frame(session, { type: "call_result", id: call.id, ok: true });
		sendEvent(session, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Hello " },
					{ type: "toolCall", name: "bash", input: {} }, // non-text parts are skipped
					{ type: "text", text: "world" },
				],
			},
		});
		assistantText(session, "Final answer");
		sendEvent(session, { type: "agent_end", usage: { tokens: 42 }, messages: [] });
		expect(await result).toEqual({
			workspaceId: entry.workspaceId,
			ok: true,
			text: "Final answer",
			usage: { tokens: 42 },
		});
		expect(fx.respawned).toEqual([]);
	});

	test("an unrelated broadcast error frame does not settle a fan-out", async () => {
		// Regression (audit #21): a broadcast {type:"error"} frame (e.g. a
		// concurrent browser turn failing) carries no call id and must not
		// settle our prompt, even after our call_result acceptance.
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(session, 0);
		frame(session, { type: "call_result", id: call.id, ok: true });
		frame(session, { type: "error", error: "another turn blew up" });
		assistantText(session, "Survived");
		sendEvent(session, { type: "agent_end", messages: [] });
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Survived" });
	});

	test("rejects on abort events after our call is accepted", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(session, 0);
		frame(session, { type: "call_result", id: call.id, ok: true });
		sendEvent(session, { type: "abort_turn_started", reason: "user" });
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: false, error: "aborted" });
	});

	test("times out with error 'timeout' when the session never answers", async () => {
		const fx = startFixture();
		const entry = fx.create();
		await pair(fx, entry);
		const result = await promptEntry(fx.deps, entry, "hi", 100);
		expect(result).toEqual({ workspaceId: entry.workspaceId, ok: false, error: "timeout" });
	});

	test("rejects on call_result ok:false for our call id", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(session, 0);
		frame(session, { type: "call_result", id: call.id, ok: false, error: "not_ready" });
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: false, error: "not_ready" });
	});

	test("a browser-driven agent_end before our call_result acceptance does not settle", async () => {
		// Regression (audit #21): the control stream carries every concurrent
		// turn. An agent_end from a browser-driven turn that precedes our own
		// call_result acceptance must be ignored; we settle only on our own
		// turn's agent_end.
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(session, 0);
		assistantText(session, "Browser turn");
		sendEvent(session, { type: "agent_end", messages: [] });
		answerTurn(session, call.id, "Our turn");
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Our turn" });
	});

	test("serializes concurrent prompts to one session; each settles on its own turn", async () => {
		// Regression (audit #21): two concurrent fan-outs to the same session
		// must not both settle on the FIRST agent_end. The per-session queue
		// sends the second call only after the first turn fully settles.
		const fx = startFixture();
		const entry = fx.create();
		const session = await pair(fx, entry);
		const first = promptEntry(fx.deps, entry, "one", 5000);
		const second = promptEntry(fx.deps, entry, "two", 5000);
		const firstCall = await nthPrompt(session, 0);
		expect(firstCall.args).toEqual(["one"]);
		// Give a mis-serialized second call time to arrive; it must not.
		await sleep(100);
		expect(session.received().filter((env) => env.kind === "command")).toHaveLength(1);
		answerTurn(session, firstCall.id, "First turn");
		expect(await first).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "First turn" });
		const secondCall = await nthPrompt(session, 1);
		expect(secondCall.args).toEqual(["two"]);
		answerTurn(session, secondCall.id, "Second turn");
		expect(await second).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Second turn" });
	});

	test("an asleep spawned entry is respawned and the prompt waits for its pair", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		const result = promptEntry(fx.deps, entry, "wake up", 5000);
		const session = await fx.sessionFor(entry.workspaceId);
		expect(fx.respawned).toEqual([entry.workspaceId]);
		const call = await nthPrompt(session, 0);
		expect(call.args).toEqual(["wake up"]);
		answerTurn(session, call.id, "Awake");
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Awake" });
	});

	test("a spawned entry already connecting is waited on, not respawned", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "connecting" });
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		await sleep(50);
		const session = fx.dial(entry);
		const call = await nthPrompt(session, 0);
		answerTurn(session, call.id, "Arrived");
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Arrived" });
		expect(fx.respawned).toEqual([]);
	});

	test("a respawn that fails reports its error without sending a prompt", async () => {
		const fx = startFixture();
		fx.lifecycle.start = async () => {
			throw new Error("launch refused");
		};
		const entry = fx.create({ status: "asleep" });
		const result = await promptEntry(fx.deps, entry, "hi", 500);
		expect(result).toEqual({ workspaceId: entry.workspaceId, ok: false, error: "launch refused" });
	});

	test("without a callback transport the prompt fails with a typed error", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const deps: FanoutDeps = { registry: fx.registry, waker: fx.deps.waker };
		const result = await promptEntry(deps, entry, "hi", 500);
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.workspaceId).toBe(entry.workspaceId);
	});
});

describe("fanOut", () => {
	test("preserves entry order across mixed ok/error outcomes for paired and asleep entries", async () => {
		const fx = startFixture();
		const paired = fx.create({ name: "paired" });
		const asleep = fx.create({ name: "asleep", status: "asleep" });
		const pairedSession = await pair(fx, paired);
		const results = fanOut(fx.deps, [paired, asleep], "hi", 5000);

		const pairedCall = await nthPrompt(pairedSession, 0);
		frame(pairedSession, {
			type: "call_result",
			id: pairedCall.id,
			ok: false,
			error: "first failed",
		});
		const asleepSession = await fx.sessionFor(asleep.workspaceId);
		const asleepCall = await nthPrompt(asleepSession, 0);
		answerTurn(asleepSession, asleepCall.id, "Second ok");

		const settled = await results;
		expect(settled.map((r) => r.workspaceId)).toEqual([paired.workspaceId, asleep.workspaceId]);
		expect(settled[0]).toEqual({
			workspaceId: paired.workspaceId,
			ok: false,
			error: "first failed",
		});
		expect(settled[1]).toEqual({ workspaceId: asleep.workspaceId, ok: true, text: "Second ok" });
		expect(fx.respawned).toEqual([asleep.workspaceId]);
	});
});
