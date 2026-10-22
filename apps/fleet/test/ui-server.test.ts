/**
 * UI daemon wire tests: startUiServer in front of a real control plane
 * (startFleet) and in front of a fake upstream whose /events stream reports
 * when the proxy cancels it. Covers static serving, proxied JSON / command /
 * SSE, the forwarded-header rewrite, upstream status passthrough, the 502
 * when the control plane is down, the auth gate as seen through the proxy,
 * and the control plane's serveUi=false 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	CALLBACK_PROTO_HEADER,
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CALLBACK_WS_PATH,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	callbackErrorFromClose,
} from "#lib/wire/callback-protocol";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import type { FleetServer } from "../server";
import { BRIDGE_MAX_BYTES, startUiServer, type BridgeSample, type UiServer } from "../ui-server";
import { cleanupTempDirs, serveEdge, testEviction, testWaker } from "./edge.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import { fleetPaths, startTestFleet, waitFor } from "./server.testkit";

afterAll(cleanupTempDirs);

const SERVES_NO_UI = "this omp-web control plane serves no UI; run: omp-web ui";

/** Read the SSE body until `needle` appears (or 5s), then cancel the client side. */
async function readUntil(body: ReadableStream<Uint8Array>, needle: string): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + 5000;
	let text = "";
	while (!text.includes(needle)) {
		if (Date.now() > deadline) throw new Error(`no ${needle} within 5s`);
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return text;
}

/** A standalone edge (no UI hop) with the given serveUi setting, on an ephemeral port. */
async function mountEdge(tmp: string, serveUi?: boolean) {
	const statePath = join(tmp, "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const config: FleetConfig = {
		templates: { local: { command: "true" } },
		defaultTemplate: "local",
		workspaceDir: join(tmp, "ws"),
		bind: "127.0.0.1",
	};
	const transport = new DaemonTransportRegistry();
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
		waker: testWaker(registry, lifecycle, undefined),
		config,
		eventLog: new FleetEventLog(),
		fleet: { port: 0, startedAt: Date.now(), statePath, configPath: null, bind: "127.0.0.1" },
		serveUi,
	});
	return serveEdge(edge);
}

describe("ui daemon proxy", () => {
	let fleet: FleetServer;
	let ui: UiServer;

	beforeAll(async () => {
		fleet = await startTestFleet(fleetPaths(), {});
		ui = startUiServer({ port: 0, controlPort: fleet.port });
	});

	afterAll(async () => {
		await ui.close();
		await fleet.close();
	});

	test("serves the static UI on the UI port", async () => {
		const res = await fetch(`http://127.0.0.1:${ui.port}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("a missing hashed asset is 404 text, not the HTML shell (FEDGE-19)", async () => {
		const res = await fetch(`http://127.0.0.1:${ui.port}/assets/missing-0f3c9a.js`);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect((await fetch(`http://127.0.0.1:${ui.port}/`)).status).toBe(200);
	});

	test("proxies /ctl JSON with the control plane's status and body", async () => {
		const via = await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`);
		const direct = await fetch(`http://127.0.0.1:${fleet.port}/ctl/sessions`);
		expect(via.status).toBe(direct.status);
		expect(via.status).toBe(200);
		expect(await via.json()).toEqual(await direct.json());
	});

	test("proxies POST /command with the control plane's status and body", async () => {
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "nope" }),
		};
		const via = await fetch(`http://127.0.0.1:${ui.port}/command`, init);
		const direct = await fetch(`http://127.0.0.1:${fleet.port}/command`, init);
		expect(via.status).toBe(direct.status);
		expect(await via.text()).toBe(await direct.text());
	});

	test("streams /events through the proxy, starting with the roster priming frame", async () => {
		const res = await fetch(`http://127.0.0.1:${ui.port}/events?client=${crypto.randomUUID()}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		const text = await readUntil(res.body!, '"type":"roster"');
		expect(text).toContain('"type":"roster"');
	});
});

describe("ui daemon SSE abort", () => {
	test("a client that drops /events cancels the upstream stream", async () => {
		let upstreamCancelled = false;
		const encoder = new TextEncoder();
		const fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: hi\n\n"));
						},
						cancel() {
							upstreamCancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const ui = startUiServer({ port: 0, controlPort: fake.port! });
		try {
			const res = await fetch(`http://127.0.0.1:${ui.port}/events`);
			await readUntil(res.body!, "data: hi");
			await waitFor(() => upstreamCancelled, 5000, "upstream /events cancel");
		} finally {
			await ui.close();
			fake.stop(true);
		}
	});
});

describe("ui daemon when the control plane is down", () => {
	test("answers 502 JSON naming the control port", async () => {
		const fleet = await startTestFleet(fleetPaths(), {});
		const controlPort = fleet.port;
		await fleet.close();
		const ui = startUiServer({ port: 0, controlPort });
		try {
			const res = await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`);
			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({
				error: `omp-web control plane unreachable on :${controlPort}`,
			});
		} finally {
			await ui.close();
		}
	});
});

describe("ui daemon auth gate", () => {
	let fleet: FleetServer;
	let ui: UiServer;

	beforeAll(async () => {
		fleet = await startTestFleet(fleetPaths(), {}, { browserAccessToken: "ui-test-token" });
		ui = startUiServer({ port: 0, controlPort: fleet.port });
	});

	afterAll(async () => {
		await ui.close();
		await fleet.close();
	});

	test("direct loopback stays exempt; proxied requests need a session", async () => {
		const direct = await fetch(`http://127.0.0.1:${fleet.port}/ctl/sessions`);
		expect(direct.status).toBe(200);
		const proxied = await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`);
		expect(proxied.status).toBe(401);
	});
});

describe("serveUi on the edge", () => {
	test("serveUi false answers static paths with 404 JSON", async () => {
		const off = await mountEdge(tempDir("omp-web-ui-off-"), false);
		try {
			const res = await fetch(`http://127.0.0.1:${off.port}/`);
			expect(res.status).toBe(404);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(await res.json()).toEqual({ error: SERVES_NO_UI });
		} finally {
			off.stop();
		}
	});
});

describe("ui daemon proxy forwarded headers and upstream status", () => {
	let upstream: Server<undefined>;
	let ui: UiServer;
	let seen: Headers | null = null;
	let respond: () => Response = () => Response.json({ ok: true });

	beforeAll(() => {
		upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				seen = req.headers;
				return respond();
			},
		});
		if (upstream.port === undefined) throw new Error("upstream has no port");
		ui = startUiServer({ port: 0, controlPort: upstream.port });
	});

	afterAll(async () => {
		await ui.close();
		await upstream.stop(true);
	});

	test("appends the peer to X-Forwarded-For; proto/host are set only when absent", async () => {
		seen = null;
		respond = () => Response.json({ ok: true });
		// Bare request: the UI hop adds its own peer hop, the socket scheme,
		// and the original Host it was reached on.
		expect((await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`)).status).toBe(200);
		const bare = seen!;
		expect(bare.get("x-forwarded-for")).toBe("127.0.0.1");
		expect(bare.get("x-forwarded-proto")).toBe("http");
		expect(bare.get("x-forwarded-host")).toBe(`127.0.0.1:${ui.port}`);

		// A client-present chain and explicit proto/host survive: only the
		// peer hop is appended to the chain, nothing is overwritten.
		seen = null;
		await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`, {
			headers: {
				"x-forwarded-for": "203.0.113.9, 10.0.0.1",
				"x-forwarded-proto": "https",
				"x-forwarded-host": "fleet.example.com",
			},
		});
		const chained = seen!;
		expect(chained.get("x-forwarded-for")).toBe("203.0.113.9, 10.0.0.1, 127.0.0.1");
		expect(chained.get("x-forwarded-proto")).toBe("https");
		expect(chained.get("x-forwarded-host")).toBe("fleet.example.com");
	});

	test("an upstream 5xx status and body pass through unchanged", async () => {
		// Only the connect-failure path may answer the 502 JSON; a real
		// upstream error response is the upstream's own.
		respond = () =>
			new Response("upstream boom", { status: 503, headers: { "content-type": "text/plain" } });
		const res = await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`);
		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(await res.text()).toBe("upstream boom");
	});
});

/** Bun's WebSocket client with its upgrade-header and pause options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => Bun.WebSocket;

interface UpstreamSocket {
	/** Messages the stand-in control plane received, in order. */
	received: string[];
	closes: { code: number; reason: string }[];
	flooded: number;
	/** The flood pump stopped because the socket's send buffer was full. */
	stalled: boolean;
}

/** A session-side socket dialed at the bridge: what it received and how it closed. */
interface DialedSession {
	ws: Bun.WebSocket;
	messages: string[];
	closed: Promise<{ code: number; reason: string }>;
}

describe("ui daemon callback WebSocket bridge", () => {
	const FLOOD_MESSAGES = 64;
	const FLOOD_BYTES = 1024 * 1024;
	let upstream: Server<UpstreamSocket>;
	let ui: UiServer;
	let upgradeHeaders: Headers | null = null;
	let refuseOnOpen = false;
	let lastSocket: UpstreamSocket | null = null;
	/** While set, the stand-in holds each upgrade until it resolves, so the bridge's upstream stays CONNECTING. */
	let acceptGate: Promise<void> | null = null;

	/** Send flood messages while the upstream socket has room; drain resumes it. */
	function pump(ws: ServerWebSocket<UpstreamSocket>): void {
		while (ws.data.flooded < FLOOD_MESSAGES) {
			if (ws.getBufferedAmount() > CALLBACK_WS_SEND_HIGH_WATER_BYTES) {
				ws.data.stalled = true;
				return;
			}
			const index = ws.data.flooded++;
			if (ws.send(`${index}:${"x".repeat(FLOOD_BYTES)}`) === 0) {
				throw new Error("stand-in send dropped");
			}
		}
	}

	beforeAll(() => {
		upstream = Bun.serve<UpstreamSocket>({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				if (new URL(req.url).pathname !== CALLBACK_WS_PATH)
					return new Response("nope", { status: 404 });
				await acceptGate;
				upgradeHeaders = req.headers;
				const data: UpstreamSocket = { received: [], closes: [], flooded: 0, stalled: false };
				lastSocket = data;
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				perMessageDeflate: false,
				maxPayloadLength: CALLBACK_WS_MAX_PAYLOAD_BYTES,
				open(ws) {
					if (refuseOnOpen) ws.close(4401, "unauthorized: bad credential");
					else ws.send("first");
				},
				message(ws, message) {
					const text = String(message);
					ws.data.received.push(text);
					if (text.startsWith("bulk:")) return;
					if (text === "flood") pump(ws);
					else ws.send(`echo:${text}`);
				},
				drain: pump,
				close(ws, code, reason) {
					ws.data.closes.push({ code, reason });
				},
			},
		});
		if (upstream.port === undefined) throw new Error("upstream has no port");
		ui = startUiServer({ port: 0, controlPort: upstream.port });
	});

	afterAll(async () => {
		await ui.close();
		await upstream.stop(true);
	});

	/** Dial the UI's /callback/ws; messages and the close are collected from the first event on. */
	function dial(port: number, headers: Record<string, string> = {}): DialedSession {
		const ws = new BunWebSocket(`ws://127.0.0.1:${port}${CALLBACK_WS_PATH}`, { headers });
		const messages: string[] = [];
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
		});
		ws.addEventListener("message", (event) => {
			messages.push((event as unknown as MessageEvent<string>).data);
		});
		return { ws, messages, closed };
	}

	test("pipes messages both ways in order, replays upgrade headers upstream, and passes a client close through", async () => {
		refuseOnOpen = false;
		const client = dial(ui.port, {
			authorization: "Bearer secret-credential",
			"x-omp-workspace-id": "ws-1",
			"x-omp-generation": "3",
			"x-omp-connection-id": "conn-1",
			[CALLBACK_PROTO_HEADER]: "2",
		});
		await waitFor(() => client.messages.length === 1, 5000, "first upstream message");
		expect(client.messages[0]).toBe("first");

		const sent = Array.from({ length: 50 }, (_, index) => `m${index}`);
		for (const text of sent) client.ws.send(text);
		await waitFor(() => client.messages.length === 1 + sent.length, 5000, "echoes");
		expect(client.messages.slice(1)).toEqual(sent.map((text) => `echo:${text}`));
		expect(lastSocket?.received).toEqual(sent);

		const seen = upgradeHeaders!;
		expect(seen.get("authorization")).toBe("Bearer secret-credential");
		expect(seen.get("x-omp-workspace-id")).toBe("ws-1");
		expect(seen.get("x-omp-generation")).toBe("3");
		expect(seen.get("x-omp-connection-id")).toBe("conn-1");
		expect(seen.get(CALLBACK_PROTO_HEADER)).toBe("2");
		expect(seen.get("x-forwarded-for")).toBe("127.0.0.1");
		expect(seen.get("x-forwarded-proto")).toBe("http");

		client.ws.close(1000, "done");
		await client.closed;
		const socket = lastSocket!;
		await waitFor(() => socket.closes.length === 1, 5000, "upstream close");
		expect(socket.closes[0]).toEqual({ code: 1000, reason: "done" });
	});

	test("a refusal close from the control plane reaches the session with its code and reason", async () => {
		refuseOnOpen = true;
		const client = dial(ui.port, { authorization: "Bearer stale" });
		expect(await client.closed).toEqual({ code: 4401, reason: "unauthorized: bad credential" });
		expect(client.messages).toEqual([]);
	});

	test("an unreachable control plane closes the session socket with a typed 4503 unavailable", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const deadPort = probe.port!;
		await probe.stop(true);
		const orphan = startUiServer({ port: 0, controlPort: deadPort });
		try {
			const client = dial(orphan.port);
			const close = await client.closed;
			expect(close.code).toBe(4503);
			expect(close.reason).toStartWith("unavailable: ");
			expect(callbackErrorFromClose(close.code, close.reason)?.code).toBe("unavailable");
		} finally {
			await orphan.close();
		}
	});

	test("a foreign Origin upgrade is refused before it reaches the control plane", async () => {
		const client = dial(ui.port, { origin: "https://evil.example" });
		const close = await client.closed;
		expect(close.code).not.toBe(1000);
		expect(client.messages).toEqual([]);
	});

	test("a slow session reader pauses the upstream instead of buffering the flood, and loses nothing", async () => {
		refuseOnOpen = false;
		const client = dial(ui.port);
		await waitFor(() => client.messages.length === 1, 5000, "first upstream message");
		const socket = lastSocket!;
		client.ws.pause();
		client.ws.send("flood");
		await waitFor(() => socket.stalled, 5000, "upstream send buffer full");
		// The whole flood is bigger than every buffer on the path: it must be held back upstream.
		expect(socket.flooded).toBeLessThan(FLOOD_MESSAGES);
		client.ws.resume();
		await waitFor(() => client.messages.length === 1 + FLOOD_MESSAGES, 15_000, "flood delivered");
		expect(socket.flooded).toBe(FLOOD_MESSAGES);
		client.messages.slice(1).forEach((text, index) => {
			expect(text.startsWith(`${index}:`)).toBe(true);
			expect(text.length).toBe(`${index}:`.length + FLOOD_BYTES);
		});
		client.ws.close();
		await client.closed;
	});

	test("messages queued before the upstream opens drain through the high-water gate, in order, with nothing lost", async () => {
		refuseOnOpen = false;
		const samples: BridgeSample[] = [];
		const gated = startUiServer({
			port: 0,
			controlPort: upstream.port!,
			observeBridge: (sample) => samples.push(sample),
		});
		let release!: () => void;
		acceptGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const client = dial(gated.port);
			await waitFor(() => client.ws.readyState === WebSocket.OPEN, 5000, "session socket open");
			// 7 MiB: more than the 1 MiB gate and the kernel buffers, under CONNECTION_MAX_BYTES.
			const count = 28;
			const body = "x".repeat(256 * 1024);
			for (let index = 0; index < count; index++) client.ws.send(`bulk:${index}:${body}`);
			// Everything the session sent is queued in the bridge, none of it handed upstream yet.
			await waitFor(
				() => (samples.at(-1)?.queuedBytes ?? 0) >= count * body.length,
				5000,
				"backlog queued",
			);
			expect(samples.every((sample) => sample.upstreamBuffered === 0)).toBe(true);
			const beforeOpen = samples.length;
			acceptGate = null;
			release();
			// More messages arriving while the backlog drains queue behind it.
			await waitFor(() => samples.length > beforeOpen, 5000, "flush started");
			const late = 20;
			for (let index = 0; index < late; index++) client.ws.send(`bulk:${count + index}:late`);
			client.ws.send("end");
			await waitFor(
				() => client.messages.includes("first") && client.messages.includes("echo:end"),
				15_000,
				"every message delivered",
			);
			const received = lastSocket!.received;
			expect(received.length).toBe(count + late + 1);
			received.slice(0, count).forEach((text, index) => {
				expect(text).toBe(`bulk:${index}:${body}`);
			});
			received.slice(count, count + late).forEach((text, index) => {
				expect(text).toBe(`bulk:${count + index}:late`);
			});
			expect(received.at(-1)).toBe("end");
			// No send left the upstream client with more than the high-water mark plus the one message that crossed it.
			const peak = Math.max(...samples.map((sample) => sample.upstreamBuffered));
			expect(peak).toBeLessThanOrEqual(CALLBACK_WS_SEND_HIGH_WATER_BYTES + body.length + 64);
			client.ws.close();
			await client.closed;
		} finally {
			acceptGate = null;
			release();
			await gated.close();
		}
	});

	/** A bridge whose upstream dial is held CONNECTING until `release()`, so everything the session sends queues in the bridge. */
	async function withHeldUpstream(
		run: (held: {
			client: DialedSession;
			samples: BridgeSample[];
			release: () => void;
		}) => Promise<void>,
	): Promise<void> {
		refuseOnOpen = false;
		const samples: BridgeSample[] = [];
		const gated = startUiServer({
			port: 0,
			controlPort: upstream.port!,
			observeBridge: (sample) => samples.push(sample),
		});
		let open!: () => void;
		acceptGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const release = (): void => {
			acceptGate = null;
			open();
		};
		try {
			const client = dial(gated.port);
			await waitFor(() => client.ws.readyState === WebSocket.OPEN, 5000, "session socket open");
			await run({ client, samples, release });
		} finally {
			release();
			await gated.close();
		}
	}

	test("a burst of a whole credit window is held by the bridge and relayed whole, on one pair", async () => {
		// A session at the end of its window has this much outstanding, all of it possibly in the bridge
		// at once (kernel buffers on the session hop land in one read); the bound is that window.
		const body = "x".repeat(256 * 1024);
		const count = Math.ceil(PAIR_CREDIT_WINDOW_BYTES / body.length);
		await withHeldUpstream(async ({ client, samples, release }) => {
			for (let index = 0; index < count; index++) client.ws.send(`bulk:${index}:${body}`);
			await waitFor(
				() => (samples.at(-1)?.queuedBytes ?? 0) >= count * body.length,
				5000,
				"burst queued",
			);
			expect(client.ws.readyState).toBe(WebSocket.OPEN);
			release();
			client.ws.send("end");
			await waitFor(
				() => client.messages.includes("first") && client.messages.includes("echo:end"),
				15_000,
				"every message delivered",
			);
			const received = lastSocket!.received;
			expect(received.length).toBe(count + 1);
			received.slice(0, count).forEach((text, index) => {
				expect(text).toBe(`bulk:${index}:${body}`);
			});
			expect(received.at(-1)).toBe("end");
			expect(client.ws.readyState).toBe(WebSocket.OPEN);
			// What the bridge held never passed its bound.
			const peak = Math.max(...samples.map((s) => s.queuedBytes + s.upstreamBuffered));
			expect(peak).toBeGreaterThanOrEqual(PAIR_CREDIT_WINDOW_BYTES);
			expect(peak).toBeLessThanOrEqual(BRIDGE_MAX_BYTES);
			client.ws.close();
			await client.closed;
		});
	});

	test("a session that ignores its credit window is closed retryable by the bridge instead of being buffered without bound", async () => {
		// Held upstream, so nothing the session sends leaves the bridge: past the window plus the
		// frame-overhead slack, the bridge's bound is reached.
		const body = "x".repeat(256 * 1024);
		const count = Math.ceil(BRIDGE_MAX_BYTES / body.length) + 2;
		await withHeldUpstream(async ({ client, samples }) => {
			for (let index = 0; index < count; index++) client.ws.send(`bulk:${index}:${body}`);
			const close = await client.closed;
			expect(callbackErrorFromClose(close.code, close.reason)?.code).toBe("retryable");
			expect(close.reason).toContain("backlog exceeded");
			// Everything up to the bound was queued; nothing past it.
			expect(Math.max(...samples.map((s) => s.queuedBytes))).toBeLessThanOrEqual(BRIDGE_MAX_BYTES);
		});
	});
});
