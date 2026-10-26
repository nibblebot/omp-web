/**
 * Session wake tests (FLC-23): the one rule set in SessionWaker, exercised
 * through its consumer-visible surface. Sessions are controlled callback
 * sessions dialing OUT to a real SessionTransportRegistry served over loopback
 * HTTP; the fleet never dials. The respawn stand-in starts the same dialing
 * session the real child would, without waiting for it to connect.
 */

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { SessionTransportRegistry, type CallbackSocketData } from "../session-transport";
import { promptEntry, type FanoutDeps } from "../fanout";
import { Registry, type RegistryEntry } from "../registry";
import { SessionWaker } from "../session-waker";
import type { StartOptions } from "../workspace-lifecycle";
import { startCallbackSession, type CallbackSession } from "./callback-session.testkit";
import { sleep, waitFor } from "./edge.testkit";

type CreateInit = Parameters<Registry["create"]>[0];

interface Fixture {
	registry: Registry;
	transport: SessionTransportRegistry;
	waker: SessionWaker;
	/** workspaceIds of local sessions the start stand-in was asked to wake, in order (refused attempts included). */
	respawned: string[];
	/** Every lifecycle.start call, clone or local session, with its options. */
	starts: Array<{ workspaceId: string; opts?: StartOptions }>;
	/** Respawn attempts still to refuse with "launch refused". */
	refusals: { remaining: number };
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

function startFixture(opts: { redialGraceMs?: number; pairTimeoutMs?: number } = {}): Fixture {
	const dir = tempDir("omp-web-session-waker-");
	const registry = new Registry(`${dir}/state.json`);
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
	const respawned: string[] = [];
	const starts: Array<{ workspaceId: string; opts?: StartOptions }> = [];
	const refusals = { remaining: 0 };
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
	// The real lifecycle launches a child that dials out (or boots a provider
	// clone); the stand-in records the call and, for a local session, starts the
	// same dialing session without waiting for it to connect.
	const lifecycle = {
		start: async (workspaceId: string, startOpts?: StartOptions) => {
			starts.push({ workspaceId, opts: startOpts });
			const entry = registry.get(workspaceId)!;
			if (entry.workspace?.kind === "clone") return;
			respawned.push(workspaceId);
			if (refusals.remaining > 0) {
				refusals.remaining -= 1;
				throw new Error("launch refused");
			}
			dial(entry);
		},
	};
	const waker = new SessionWaker({
		registry,
		lifecycle,
		transport,
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
		starts,
		refusals,
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

/** One accepted turn: call_result ok, one assistant message, agent_end. */
function answerTurn(session: CallbackSession, callId: string, text: string): void {
	frame(session, { type: "call_result", id: callId, ok: true });
	frame(session, {
		type: "event",
		event: {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		},
	});
	frame(session, { type: "event", event: { type: "agent_end", messages: [] } });
}

describe("SessionWaker.wake: stuck non-clone sessions", () => {
	for (const status of ["reconnecting", "ready"] as const) {
		test(`a ${status} row that never re-pairs is respawned after the redial grace and resolves once paired`, async () => {
			const fx = startFixture({ redialGraceMs: 50 });
			const entry = fx.create({ status });
			await fx.waker.wake(entry);
			expect(fx.respawned).toEqual([entry.workspaceId]);
			expect(fx.transport.pairStatus(entry.workspaceId).paired).toBe(true);
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
		const session = await fx.sessionFor(entry.workspaceId);
		expect(fx.respawned).toEqual([entry.workspaceId]);
		const call = await nthPrompt(session, 0);
		expect(call.args).toEqual(["wake up"]);
		answerTurn(session, call.id, "Awake");
		expect(await result).toEqual({ workspaceId: entry.workspaceId, ok: true, text: "Awake" });
	});
});

describe("concurrent and failed wakes", () => {
	test("two concurrent wakes of one asleep row respawn once and both settle only once paired", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		const first = fx.waker.wake(entry);
		const second = fx.waker.wake(entry);
		await second;
		expect(fx.transport.pairStatus(entry.workspaceId).paired).toBe(true);
		await first;
		expect(fx.respawned).toEqual([entry.workspaceId]);
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
		expect(fx.transport.pairStatus(entry.workspaceId).paired).toBe(true);
		expect(fx.respawned).toEqual([entry.workspaceId, entry.workspaceId]);
	});
});

describe("clone wake", () => {
	test("starts the clone with a resume pick only when one is given, without waiting for the pair", async () => {
		const fx = startFixture();
		const entry = fx.create({
			status: "asleep",
			workspace: { kind: "clone", projectId: "proj", desiredState: "running" },
		});
		await fx.waker.wake(entry);
		await fx.waker.wake(entry, { resumeFile: "   " });
		await fx.waker.wake(entry, { resumeFile: "sess-42" });
		expect(fx.starts).toEqual([
			{ workspaceId: entry.workspaceId, opts: undefined },
			{ workspaceId: entry.workspaceId, opts: undefined },
			{ workspaceId: entry.workspaceId, opts: { resume: "sess-42" } },
		]);
		expect(fx.transport.pairStatus(entry.workspaceId).paired).toBe(false);
	});

	test("a local session wake passes its resume pick through the same start verb", async () => {
		const fx = startFixture();
		const entry = fx.create({ status: "asleep" });
		await fx.waker.wake(entry, { resumeFile: "/srv/proj/picked.jsonl" });
		expect(fx.starts).toEqual([
			{ workspaceId: entry.workspaceId, opts: { resume: "/srv/proj/picked.jsonl" } },
		]);
	});
});
