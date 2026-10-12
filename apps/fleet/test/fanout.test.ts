/**
 * Fan-out prompt correlation tests over the callback pair. Every session is a
 * controlled callback daemon (callback-daemon.testkit.ts) dialing OUT to a
 * real DaemonTransportRegistry served over loopback HTTP; the fleet never
 * dials. The daemon plays the session half: it reads the `prompt` call off
 * its down leg, answers with call_result and mirrors turn frames on the
 * control stream, exactly like the real daemon (the call_result for a call
 * precedes that call's turn frames; it is the acceptance verdict that scopes
 * correlation, audit #21). Covers promptEntry's correlation contract (own-turn
 * agent_end only, unrelated frames ignored), per-daemon serialization of
 * concurrent fan-outs, fanOut's order preservation across mixed outcomes, and
 * the wake path: spawned asleep entries respawn and wait for the pair,
 * unpaired remote entries fail with a typed error.
 */

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { fanOut, promptEntry, type FanoutDeps } from "../fanout";
import { Registry, type RegistryEntry } from "../registry";
import { SpawnSupervisor } from "../supervisor";
import { startCallbackDaemon, type CallbackDaemon } from "./callback-daemon.testkit";
import { sleep, waitFor } from "./edge.testkit";

type CreateInit = Parameters<Registry["create"]>[0];

interface Fixture {
	deps: FanoutDeps;
	registry: Registry;
	transport: DaemonTransportRegistry;
	/** daemonIds the stubbed supervisor.respawn was asked to wake, in order. */
	respawned: string[];
	/** Register a spawned or remote entry in the registry. */
	create(overrides?: Partial<CreateInit>): RegistryEntry;
	/** Enroll the entry and start its daemon dialing out (does not wait for the pair). */
	dial(entry: RegistryEntry): CallbackDaemon;
	/** Resolves with the daemon once one exists for the entry (dialed by the test or by respawn). */
	daemonFor(daemonId: string): Promise<CallbackDaemon>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startFixture(): Fixture {
	const dir = tempDir("omp-web-fanout-");
	const statePath = `${dir}/state.json`;
	const registry = new Registry(statePath);
	const transport = new DaemonTransportRegistry();
	const server: Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req) =>
			(await transport.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	const url = `http://127.0.0.1:${server.port}`;
	const config: FleetConfig = {
		templates: {},
		defaultTemplate: "local",
		workspaceDir: `${dir}/ws`,
		bind: "127.0.0.1",
	};
	const supervisor = new SpawnSupervisor(registry, config, {
		transport,
		statePath,
		callbackUrl: () => `${url}/callback`,
	});
	const respawned: string[] = [];
	const daemons = new Map<string, PromiseWithResolvers<CallbackDaemon>>();
	const slot = (daemonId: string): PromiseWithResolvers<CallbackDaemon> => {
		let existing = daemons.get(daemonId);
		if (!existing) {
			existing = Promise.withResolvers<CallbackDaemon>();
			daemons.set(daemonId, existing);
		}
		return existing;
	};
	const dial = (entry: RegistryEntry): CallbackDaemon => {
		const token = randomBytes(32).toString("hex");
		transport.enrollWorkspace(entry.daemonId, 1, token);
		const daemon = startCallbackDaemon({
			url,
			workspaceId: entry.daemonId,
			generation: 1,
			token,
		});
		cleanups.push(() => daemon.stop());
		slot(entry.daemonId).resolve(daemon);
		return daemon;
	};
	// The real supervisor launches a child that dials out; the stand-in starts
	// the same dialing daemon without waiting for it to connect.
	supervisor.respawn = async (entry) => {
		respawned.push(entry.daemonId);
		dial(entry);
	};
	cleanups.push(async () => {
		supervisor.close();
		transport.close();
		await server.stop(true);
	});
	return {
		deps: { registry, supervisor, transport },
		registry,
		transport,
		respawned,
		create(overrides = {}) {
			return registry.create({
				name: `proj-${registry.list().length}`,
				cwd: "/srv/proj",
				project: "proj",
				labels: [],
				mode: "spawned",
				status: "ready",
				...overrides,
			});
		},
		dial,
		daemonFor: (daemonId) => slot(daemonId).promise,
	};
}

/** Dial the entry's daemon and wait until the fleet sees the pair. */
async function pair(fx: Fixture, entry: RegistryEntry): Promise<CallbackDaemon> {
	const daemon = fx.dial(entry);
	await daemon.waitConnected(5000);
	await waitFor(
		() => (fx.transport.pairStatus(entry.daemonId).paired ? true : null),
		5000,
		"pair up",
	);
	return daemon;
}

/** The nth `prompt` call the daemon has received on its down leg. */
async function nthPrompt(
	daemon: CallbackDaemon,
	n: number,
): Promise<{ id: string; args: unknown[] }> {
	return await waitFor(
		() => {
			const commands = daemon.received().filter((env) => env.kind === "command");
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

function frame(daemon: CallbackDaemon, payload: unknown): void {
	daemon.send(CALLBACK_CONTROL_STREAM_ID, "frame", payload);
}

function sendEvent(daemon: CallbackDaemon, event: Record<string, unknown>): void {
	frame(daemon, { type: "event", sessionId: "s1", event });
}

function assistantText(daemon: CallbackDaemon, text: string): void {
	sendEvent(daemon, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

/** One accepted turn: call_result ok, one assistant message, agent_end. */
function answerTurn(daemon: CallbackDaemon, callId: string, text: string): void {
	frame(daemon, { type: "call_result", id: callId, ok: true });
	assistantText(daemon, text);
	sendEvent(daemon, { type: "agent_end", messages: [] });
}

describe("promptEntry", () => {
	test("happy path: last assistant text + usage from agent_end; the prompt call reaches the daemon", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		expect(call.args).toEqual(["hi"]);
		frame(daemon, { type: "call_result", id: call.id, ok: true });
		sendEvent(daemon, {
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
		assistantText(daemon, "Final answer");
		sendEvent(daemon, { type: "agent_end", usage: { tokens: 42 }, messages: [] });
		expect(await result).toEqual({
			daemonId: entry.daemonId,
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
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		frame(daemon, { type: "call_result", id: call.id, ok: true });
		frame(daemon, { type: "error", error: "another turn blew up" });
		assistantText(daemon, "Survived");
		sendEvent(daemon, { type: "agent_end", messages: [] });
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Survived" });
	});

	test("rejects on abort events after our call is accepted", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		frame(daemon, { type: "call_result", id: call.id, ok: true });
		sendEvent(daemon, { type: "abort_turn_started", reason: "user" });
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: false, error: "aborted" });
	});

	test("times out with error 'timeout' when the daemon never answers", async () => {
		const fx = startFixture();
		const entry = fx.create();
		await pair(fx, entry);
		const result = await promptEntry(fx.deps, entry, "hi", 100);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "timeout" });
	});

	test("rejects on call_result ok:false for our call id", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		frame(daemon, { type: "call_result", id: call.id, ok: false, error: "not_ready" });
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: false, error: "not_ready" });
	});

	test("a browser-driven agent_end before our call_result acceptance does not settle", async () => {
		// Regression (audit #21): the control stream carries every concurrent
		// turn. An agent_end from a browser-driven turn that precedes our own
		// call_result acceptance must be ignored; we settle only on our own
		// turn's agent_end.
		const fx = startFixture();
		const entry = fx.create();
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		assistantText(daemon, "Browser turn");
		sendEvent(daemon, { type: "agent_end", messages: [] });
		answerTurn(daemon, call.id, "Our turn");
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Our turn" });
	});

	test("serializes concurrent prompts to one daemon; each settles on its own turn", async () => {
		// Regression (audit #21): two concurrent fan-outs to the same daemon
		// must not both settle on the FIRST agent_end. The per-daemon queue
		// sends the second call only after the first turn fully settles.
		const fx = startFixture();
		const entry = fx.create();
		const daemon = await pair(fx, entry);
		const first = promptEntry(fx.deps, entry, "one", 5000);
		const second = promptEntry(fx.deps, entry, "two", 5000);
		const firstCall = await nthPrompt(daemon, 0);
		expect(firstCall.args).toEqual(["one"]);
		// Give a mis-serialized second call time to arrive; it must not.
		await sleep(100);
		expect(daemon.received().filter((env) => env.kind === "command")).toHaveLength(1);
		answerTurn(daemon, firstCall.id, "First turn");
		expect(await first).toEqual({ daemonId: entry.daemonId, ok: true, text: "First turn" });
		const secondCall = await nthPrompt(daemon, 1);
		expect(secondCall.args).toEqual(["two"]);
		answerTurn(daemon, secondCall.id, "Second turn");
		expect(await second).toEqual({ daemonId: entry.daemonId, ok: true, text: "Second turn" });
	});

	test("an asleep spawned entry is respawned and the prompt waits for its pair", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		const result = promptEntry(fx.deps, entry, "wake up", 5000);
		const daemon = await fx.daemonFor(entry.daemonId);
		expect(fx.respawned).toEqual([entry.daemonId]);
		const call = await nthPrompt(daemon, 0);
		expect(call.args).toEqual(["wake up"]);
		answerTurn(daemon, call.id, "Awake");
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Awake" });
	});

	test("a spawned entry already connecting is waited on, not respawned", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "connecting" });
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		await sleep(50);
		const daemon = fx.dial(entry);
		const call = await nthPrompt(daemon, 0);
		answerTurn(daemon, call.id, "Arrived");
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Arrived" });
		expect(fx.respawned).toEqual([]);
	});

	test("a respawn that fails reports its error without sending a prompt", async () => {
		const fx = startFixture();
		fx.deps.supervisor.respawn = async () => {
			throw new Error("launch refused");
		};
		const entry = fx.create({ status: "asleep" });
		const result = await promptEntry(fx.deps, entry, "hi", 500);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "launch refused" });
	});

	test("a remote entry that is not paired fails as not connected, without a respawn", async () => {
		const fx = startFixture();
		const entry = fx.create({ mode: "remote", name: "far-host", status: "asleep" });
		const result = await promptEntry(fx.deps, entry, "hi", 500);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("remote session far-host is not connected");
		expect(fx.respawned).toEqual([]);
	});

	test("a paired remote entry is prompted over its pair", async () => {
		const fx = startFixture();
		const entry = fx.create({ mode: "remote", name: "far-host" });
		const daemon = await pair(fx, entry);
		const result = promptEntry(fx.deps, entry, "hi", 5000);
		const call = await nthPrompt(daemon, 0);
		answerTurn(daemon, call.id, "From afar");
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "From afar" });
	});

	test("without a callback transport the prompt fails with a typed error", async () => {
		const fx = startFixture();
		const entry = fx.create();
		const deps: FanoutDeps = { registry: fx.registry, supervisor: fx.deps.supervisor };
		const result = await promptEntry(deps, entry, "hi", 500);
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.daemonId).toBe(entry.daemonId);
	});
});

describe("fanOut", () => {
	test("preserves entry order across mixed ok/error outcomes for paired, asleep, and unpaired entries", async () => {
		const fx = startFixture();
		const paired = fx.create({ name: "paired" });
		const asleep = fx.create({ name: "asleep", status: "asleep" });
		const remote = fx.create({ name: "far-host", mode: "remote", status: "asleep" });
		const pairedDaemon = await pair(fx, paired);
		const results = fanOut(fx.deps, [paired, asleep, remote], "hi", 5000);

		const pairedCall = await nthPrompt(pairedDaemon, 0);
		frame(pairedDaemon, {
			type: "call_result",
			id: pairedCall.id,
			ok: false,
			error: "first failed",
		});
		const asleepDaemon = await fx.daemonFor(asleep.daemonId);
		const asleepCall = await nthPrompt(asleepDaemon, 0);
		answerTurn(asleepDaemon, asleepCall.id, "Second ok");

		const settled = await results;
		expect(settled.map((r) => r.daemonId)).toEqual([
			paired.daemonId,
			asleep.daemonId,
			remote.daemonId,
		]);
		expect(settled[0]).toEqual({ daemonId: paired.daemonId, ok: false, error: "first failed" });
		expect(settled[1]).toEqual({ daemonId: asleep.daemonId, ok: true, text: "Second ok" });
		expect(settled[2]?.ok).toBe(false);
		expect(settled[2]?.error).toContain("is not connected");
		expect(fx.respawned).toEqual([asleep.daemonId]);
	});
});
