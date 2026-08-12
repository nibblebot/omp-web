/**
 * Fan-out prompt correlation tests. A fake omp-session primes hello_ok/state/ready
 * on dial and responds to `{type:"call", method:"prompt"}` per-test: happy
 * path emits assistant message_end events + agent_end (with usage), error
 * frames, abort events, or nothing (timeout). Covers promptEntry's
 * correlation contract and fanOut's order preservation across mixed
 * ok/error outcomes, plus the asleep → redial wake path for non-spawned
 * entries.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { OMP_PROTO, SSE_DELTA_SEQ_START, SSE_EVENT_NAME } from "../src/protocol";
import { encodeSseEvent } from "../src/sse";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import { fanOut, promptEntry, type FanoutDeps } from "./fanout";
import { Registry, type RegistryEntry } from "./registry";
import { SpawnSupervisor } from "./supervisor";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-fanout-"));
	tmpDirs.push(dir);
	return join(dir, "state.json");
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(25);
	}
}

type CreateInit = Parameters<Registry["create"]>[0];

function baseInit(overrides: Partial<CreateInit> = {}): CreateInit {
	return {
		name: "proj-a",
		cwd: "/srv/proj",
		project: "proj-a",
		labels: [],
		mode: "attached",
		...overrides,
	};
}

async function loadedRegistry(): Promise<Registry> {
	const registry = new Registry(tmpStatePath());
	await registry.load();
	return registry;
}

interface FakeStream {
	/** Push a delta frame (seq from the fake's delta counter). */
	send(frame: unknown): void;
	/** Push a frame with an explicit seq (priming). */
	write(frame: unknown, seq: number): void;
	/** Cleanly end the stream (daemon dormant — clean close). */
	close(): void;
	/** Internal: true once the stream has been closed. */
	closed?: boolean;
}

interface FakeServer {
	server: Server<undefined>;
	port: number;
	url: string;
	openCount: number;
	streams: FakeStream[];
	received: unknown[];
	/** Delta seq counter: response events start at SSE_DELTA_SEQ_START. */
	nextSeq: number;
	stop(): void;
}

interface FakeOptions {
	helloCwd?: string;
	onOpen?: (fake: FakeServer, stream: FakeStream) => void;
	onCommand?: (fake: FakeServer, stream: FakeStream, frame: unknown) => void;
}

/** Fake omp-session: primes hello_ok (cwd /srv/proj) → state → ready on every dial. */
function startFake(opts: FakeOptions = {}): FakeServer {
	const encoder = new TextEncoder();
	const fake: FakeServer = {
		server: null as unknown as Server<undefined>,
		port: 0,
		url: "",
		openCount: 0,
		streams: [],
		received: [],
		nextSeq: SSE_DELTA_SEQ_START,
		stop() {
			this.server.stop(true);
		},
	};
	fake.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					let frame: unknown;
					try {
						frame = await req.json();
					} catch {
						return new Response("malformed", { status: 400 });
					}
					fake.received.push(frame);
					const stream = fake.streams.at(-1);
					if (stream && opts.onCommand) opts.onCommand(fake, stream, frame);
					return Response.json({ commandId: (frame as { id?: string }).id ?? "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			fake.openCount++;
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const stream: FakeStream = {
				send(frame) {
					controller!.enqueue(
						encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, fake.nextSeq++)),
					);
				},
				write(frame, seq) {
					controller!.enqueue(encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, seq)));
				},
				close() {
					stream.closed = true;
					controller!.close();
				},
			};
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					controller = ctrl;
					fake.streams.push(stream);
					if (opts.onOpen) opts.onOpen(fake, stream);
					else prime(stream, opts.helloCwd);
				},
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	fake.port = fake.server.port ?? 0;
	fake.url = `ws://127.0.0.1:${fake.port}`;
	return fake;
}

function prime(stream: FakeStream, helloCwd = "/srv/proj"): void {
	stream.write(
		{
			type: "hello_ok",
			proto: OMP_PROTO,
			name: "fake",
			cwd: helloCwd,
			pid: 4242,
			version: "test",
			sessionFile: "/srv/proj/sess.jsonl",
		},
		1,
	);
	stream.write(
		{
			type: "state",
			sessionId: "s1",
			state: { sessionId: "s1", sessionFile: "/srv/proj/sess.jsonl", isStreaming: false },
		},
		2,
	);
	stream.write({ type: "ready", readyAt: Date.now() }, 3);
}

function sendEvent(stream: FakeStream, event: Record<string, unknown>): void {
	stream.send({ type: "event", sessionId: "s1", event });
}

/** Assistant text part helper for message_end frames. */
function assistantMessage(content: unknown[]): Record<string, unknown> {
	return { role: "assistant", content };
}

/** Happy-path responder: two assistant messages (last one wins), then agent_end with usage. */
function happyResponder(_fake: FakeServer, stream: FakeStream, frame: unknown): void {
	const call = frame as { type?: string };
	if (call.type !== "call") return;
	sendEvent(stream, {
		type: "message_end",
		message: assistantMessage([
			{ type: "text", text: "Hello " },
			{ type: "toolCall", name: "bash", input: {} }, // non-text parts are skipped
			{ type: "text", text: "world" },
		]),
	});
	sendEvent(stream, { type: "message_end", message: assistantMessage([{ type: "text", text: "Final answer" }]) });
	sendEvent(stream, { type: "agent_end", usage: { tokens: 42 }, messages: [] });
}

/** Build registry + connector + supervisor and one ready entry on the fake. */
async function readyEntry(fake: FakeServer): Promise<{ deps: FanoutDeps; registry: Registry; connector: DaemonConnector; entry: RegistryEntry }> {
	const registry = await loadedRegistry();
	const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50 });
	const config: FleetConfig = { roots: [], templates: {}, defaultTemplate: "local" };
	const supervisor = new SpawnSupervisor(registry, connector, config);
	const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok-a" }));
	connector.connect(entry.daemonId);
	await connector.waitReady(entry.daemonId, 2000);
	return { deps: { registry, connector, supervisor }, registry, connector, entry };
}

describe("promptEntry", () => {
	test("happy path: last assistant text + usage from agent_end; call frame is correct", async () => {
		const fake = startFake({ onCommand: happyResponder });
		const { deps, connector, entry } = await readyEntry(fake);
		const result = await promptEntry(deps, entry, "hi", 2000);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: true, text: "Final answer", usage: { tokens: 42 } });
		expect(fake.received).toHaveLength(1);
		const call = fake.received[0] as { type?: string; id?: string; method?: string; args?: unknown[] };
		expect(call.type).toBe("call");
		expect(call.method).toBe("prompt");
		expect(call.args).toEqual(["hi"]);
		expect(typeof call.id).toBe("string");
		await connector.close();
		fake.stop();
	});

	test("rejects on {type:error} frames", async () => {
		const fake = startFake({
			onCommand: (_fake, stream, frame) => {
				if ((frame as { type?: string }).type === "call") {
					stream.send({ type: "error", error: "boom" });
				}
			},
		});
		const { deps, connector, entry } = await readyEntry(fake);
		const result = await promptEntry(deps, entry, "hi", 2000);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "boom" });
		await connector.close();
		fake.stop();
	});

	test("rejects on abort events", async () => {
		const fake = startFake({
			onCommand: (_fake, stream, frame) => {
				if ((frame as { type?: string }).type === "call") {
					sendEvent(stream, { type: "abort_turn_started", reason: "user" });
				}
			},
		});
		const { deps, connector, entry } = await readyEntry(fake);
		const result = await promptEntry(deps, entry, "hi", 2000);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "aborted" });
		await connector.close();
		fake.stop();
	});

	test("times out with error 'timeout' when the daemon never answers", async () => {
		const fake = startFake({ onCommand: () => {} });
		const { deps, connector, entry } = await readyEntry(fake);
		const result = await promptEntry(deps, entry, "hi", 50);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "timeout" });
		await connector.close();
		fake.stop();
	});

	test("rejects on call_result ok:false for our call id", async () => {
		const fake = startFake({
			onCommand: (_fake, stream, frame) => {
				const call = frame as { type?: string; id?: string };
				if (call.type === "call") {
					stream.send({ type: "call_result", id: call.id, ok: false, error: "not_ready" });
				}
			},
		});
		const { deps, connector, entry } = await readyEntry(fake);
		const result = await promptEntry(deps, entry, "hi", 2000);
		expect(result).toEqual({ daemonId: entry.daemonId, ok: false, error: "not_ready" });
		await connector.close();
		fake.stop();
	});

	test("wakes an asleep attached entry (redial) before prompting", async () => {
		const fake = startFake({
			onOpen: (fake, stream) => {
				prime(stream);
				if (fake.openCount === 1) {
					// Clean end after priming: the entry goes asleep.
					setTimeout(() => {
						try {
							stream.close();
						} catch {
							// Already closed.
						}
					}, 20);
				}
			},
			onCommand: happyResponder,
		});
		const { deps, registry, connector, entry } = await readyEntry(fake);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "asleep" ? "asleep" : null), 2000, "asleep");
		const result = await promptEntry(deps, entry, "hi", 2000);
		expect(result.ok).toBe(true);
		expect(result.text).toBe("Final answer");
		expect(fake.openCount).toBe(2); // wake redial + prompt on the fresh socket
		await connector.close();
		fake.stop();
	});

	test("wakes an idle-dropped ready entry (socket gone, stale ready status) before prompting", async () => {
		// Regression: an entry whose socket the idle policy dropped still reads
		// "ready" in the registry. promptEntry must redial and succeed, not
		// trust the stale status and fail with "daemon not connected".
		const fake = startFake({ onCommand: happyResponder });
		const registry = await loadedRegistry();
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50, idleDropMs: 30 });
		const config: FleetConfig = { roots: [], templates: {}, defaultTemplate: "local" };
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok-a" }));
		connector.connect(entry.daemonId);
		await connector.waitReady(entry.daemonId, 2000);
		// Arm the idle policy (drop happens only after a retain/release pair).
		connector.retain(entry.daemonId);
		connector.release(entry.daemonId);
		await waitFor(() => (!connector.isConnected(entry.daemonId) ? "dropped" : null), 2000, "idle drop");
		expect(registry.get(entry.daemonId)?.status).toBe("ready"); // stale
		const result = await promptEntry({ registry, connector, supervisor }, entry, "hi", 2000);
		expect(result.ok).toBe(true);
		expect(result.text).toBe("Final answer");
		expect(fake.openCount).toBe(2); // redial + prompt on the fresh socket
		await connector.close();
		fake.stop();
	});

	test("returns an error result when the daemon cannot be woken", async () => {
		// A cwd-mismatched daemon lands in error status; the wake path's
		// waitReady rejects with the error and promptEntry reports it.
		const fake = startFake({ helloCwd: "/elsewhere" });
		const registry = await loadedRegistry();
		const connector = new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50 });
		const config: FleetConfig = { roots: [], templates: {}, defaultTemplate: "local" };
		const supervisor = new SpawnSupervisor(registry, connector, config);
		const entry = registry.create(baseInit({ endpoint: fake.url, token: "tok-a" }));
		connector.connect(entry.daemonId);
		await waitFor(() => (registry.get(entry.daemonId)?.status === "error" ? "error" : null), 2000, "error");
		const result = await promptEntry({ registry, connector, supervisor }, entry, "hi", 200);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("cwd mismatch");
		await connector.close();
		fake.stop();
	});
});

describe("fanOut", () => {
	test("preserves entry order across mixed ok/error outcomes", async () => {
		// Each daemon has its own endpoint (real fleets never share one); the
		// per-daemon POST /command → SSE stream routing stays unambiguous.
		const failing = startFake({
			onCommand: (_fake, stream, frame) => {
				if ((frame as { type?: string }).type === "call") {
					stream.send({ type: "error", error: "first failed" });
				}
			},
		});
		const ok = startFake({
			onCommand: (_fake, stream, frame) => {
				if ((frame as { type?: string }).type === "call") {
					sendEvent(stream, { type: "message_end", message: assistantMessage([{ type: "text", text: "Second ok" }]) });
					sendEvent(stream, { type: "agent_end", messages: [] });
				}
			},
		});
		const { deps, registry, connector, entry: first } = await readyEntry(failing);
		const second = registry.create(baseInit({ name: "proj-b", cwd: "/srv/proj", project: "proj-b", endpoint: ok.url, token: "tok-b" }));
		connector.connect(second.daemonId);
		await connector.waitReady(second.daemonId, 2000);
		const results = await fanOut(deps, [first, second], "hi", 2000);
		expect(results.map((r) => r.daemonId)).toEqual([first.daemonId, second.daemonId]);
		expect(results[0]).toEqual({ daemonId: first.daemonId, ok: false, error: "first failed" });
		expect(results[1]).toEqual({ daemonId: second.daemonId, ok: true, text: "Second ok" });
		await connector.close();
		failing.stop();
		ok.stop();
	});
});
