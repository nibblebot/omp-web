/**
 * Session wake tests (FLC-23): the one rule set in SessionWaker, exercised
 * through its consumer-visible surface. Sessions are controlled callback
 * daemons dialing OUT to a real DaemonTransportRegistry served over loopback
 * HTTP; the fleet never dials. The respawn stand-in starts the same dialing
 * daemon the real child would, without waiting for it to connect.
 */

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { DaemonTransportRegistry } from "../daemon-transport";
import { promptEntry, type FanoutDeps } from "../fanout";
import { Registry, type RegistryEntry } from "../registry";
import { SessionWaker, type WakeLifecycle } from "../session-waker";
import { startCallbackDaemon, type CallbackDaemon } from "./callback-daemon.testkit";
import { sleep, waitFor } from "./edge.testkit";

type CreateInit = Parameters<Registry["create"]>[0];

interface Fixture {
	registry: Registry;
	transport: DaemonTransportRegistry;
	waker: SessionWaker;
	/** daemonIds the respawn stand-in was asked to wake, in order (refused attempts included). */
	respawned: string[];
	/** Respawn attempts still to refuse with "launch refused". */
	refusals: { remaining: number };
	/** Register a spawned entry in the registry. */
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

function startFixture(
	opts: { redialGraceMs?: number; pairTimeoutMs?: number; lifecycle?: WakeLifecycle } = {},
): Fixture {
	const dir = tempDir("omp-web-session-waker-");
	const registry = new Registry(`${dir}/state.json`);
	const transport = new DaemonTransportRegistry();
	const server: Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req) =>
			(await transport.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	const url = `http://127.0.0.1:${server.port}`;
	const respawned: string[] = [];
	const refusals = { remaining: 0 };
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
	const host = {
		ensureHostRunning: async (entry: RegistryEntry) => {
			respawned.push(entry.daemonId);
			if (refusals.remaining > 0) {
				refusals.remaining -= 1;
				throw new Error("launch refused");
			}
			dial(entry);
		},
	};
	const waker = new SessionWaker({
		registry,
		host,
		transport,
		lifecycle: opts.lifecycle,
		redialGraceMs: opts.redialGraceMs ?? 50,
		pairTimeoutMs: opts.pairTimeoutMs ?? 5000,
	});
	cleanups.push(async () => {
		transport.close();
		await server.stop(true);
	});
	return {
		registry,
		transport,
		waker,
		respawned,
		refusals,
		create(overrides = {}) {
			return registry.create({
				name: `proj-${registry.list().length}`,
				cwd: "/srv/proj",
				project: "proj",
				labels: [],
				status: "ready",
				...overrides,
			});
		},
		dial,
		daemonFor: (daemonId) => slot(daemonId).promise,
	};
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

/** One accepted turn: call_result ok, one assistant message, agent_end. */
function answerTurn(daemon: CallbackDaemon, callId: string, text: string): void {
	frame(daemon, { type: "call_result", id: callId, ok: true });
	frame(daemon, {
		type: "event",
		sessionId: "s1",
		event: {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		},
	});
	frame(daemon, { type: "event", sessionId: "s1", event: { type: "agent_end", messages: [] } });
}

describe("SessionWaker.wake: stuck non-clone sessions", () => {
	for (const status of ["reconnecting", "ready"] as const) {
		test(`a ${status} row that never re-pairs is respawned after the redial grace and resolves once paired`, async () => {
			const fx = startFixture({ redialGraceMs: 50 });
			const entry = fx.create({ status });
			await fx.waker.wake(entry);
			expect(fx.respawned).toEqual([entry.daemonId]);
			expect(fx.transport.pairStatus(entry.daemonId).paired).toBe(true);
		});
	}

	test("a reconnecting row that re-pairs inside the redial grace is not respawned", async () => {
		const fx = startFixture({ redialGraceMs: 2000 });
		const entry = fx.create({ status: "reconnecting" });
		const redial = sleep(30).then(() => fx.dial(entry));
		await fx.waker.wake(entry);
		await redial;
		expect(fx.respawned).toEqual([]);
	});
});

describe("prompt to a stuck session", () => {
	test("a prompt to a reconnecting unpaired row wakes it instead of timing out", async () => {
		const fx = startFixture({ redialGraceMs: 50 });
		const entry = fx.create({ status: "reconnecting" });
		const deps: FanoutDeps = { registry: fx.registry, transport: fx.transport, waker: fx.waker };
		const result = promptEntry(deps, entry, "wake up", 5000);
		const daemon = await fx.daemonFor(entry.daemonId);
		expect(fx.respawned).toEqual([entry.daemonId]);
		const call = await nthPrompt(daemon, 0);
		expect(call.args).toEqual(["wake up"]);
		answerTurn(daemon, call.id, "Awake");
		expect(await result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Awake" });
	});
});

describe("concurrent and failed wakes", () => {
	test("two concurrent wakes of one asleep row respawn once and both settle only once paired", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		const first = fx.waker.wake(entry);
		const second = fx.waker.wake(entry);
		await second;
		expect(fx.transport.pairStatus(entry.daemonId).paired).toBe(true);
		await first;
		expect(fx.respawned).toEqual([entry.daemonId]);
	});

	test("a failed wake rejects every concurrent caller, and the next wake retries from scratch", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		fx.refusals.remaining = 1;
		const first = fx.waker.wake(entry);
		const second = fx.waker.wake(entry);
		await expect(first).rejects.toThrow("launch refused");
		await expect(second).rejects.toThrow("launch refused");
		await fx.waker.wake(entry);
		expect(fx.transport.pairStatus(entry.daemonId).paired).toBe(true);
		expect(fx.respawned).toEqual([entry.daemonId, entry.daemonId]);
	});
});

describe("clone wake", () => {
	test("ensures the clone with a resume pick only when one is given, without waiting for the pair", async () => {
		const calls: Array<{ daemonId: string; opts?: { resumeSessionId?: string } }> = [];
		const fx = startFixture({
			lifecycle: {
				ensureCloneRunning: async (daemonId, opts) => {
					calls.push({ daemonId, opts });
				},
			},
		});
		const entry = fx.create({
			status: "asleep",
			workspace: { kind: "clone", projectId: "proj", desiredState: "running" },
		});
		await fx.waker.wake(entry);
		await fx.waker.wake(entry, { resumeFile: "   " });
		await fx.waker.wake(entry, { resumeFile: "sess-42" });
		expect(calls).toEqual([
			{ daemonId: entry.daemonId, opts: undefined },
			{ daemonId: entry.daemonId, opts: undefined },
			{ daemonId: entry.daemonId, opts: { resumeSessionId: "sess-42" } },
		]);
		expect(fx.transport.pairStatus(entry.daemonId).paired).toBe(false);
	});
});
