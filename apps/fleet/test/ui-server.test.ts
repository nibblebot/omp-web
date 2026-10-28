/**
 * UI server wire tests: startUiServer in front of a real control plane
 * (startFleet) and in front of fake upstreams (a stand-in /ws and
 * /callback/ws control plane). Covers static serving, proxied JSON, the
 * forwarded-header rewrite, upstream status passthrough, the 502 when the
 * control plane is down, the auth gate as seen through the proxy, the control
 * plane's serveUi=false 404,
 * and the callback and browser WebSocket bridges.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
	BROWSER_SOCKET_PATH,
	browserCloseFor,
	browserCloseFromCode,
	browserSocketUrl,
	seqFrameMessage,
} from "#lib/wire/browser-socket";
import {
	CALLBACK_PROTO_HEADER,
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CALLBACK_WS_PATH,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	callbackErrorFromClose,
} from "#lib/wire/callback-protocol";
import { OMP_PROTO } from "#lib/wire/protocol";
import type { FleetConfig } from "../config";
import { SessionTransportRegistry } from "../session-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import type { FleetServer } from "../server";
import {
	BRIDGE_MAX_BYTES,
	BROWSER_BRIDGE_HIGH_WATER_BYTES,
	startUiServer,
	type BridgeSample,
	type UiServer,
} from "../ui-server";
import { cleanupTempDirs, serveEdge, testEviction, testWaker } from "./edge.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import { fleetPaths, startTestFleet, waitFor } from "./server.testkit";

afterAll(cleanupTempDirs);

const SERVES_NO_UI = "this omp-web control plane serves no UI; run: omp-web ui";

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
		waker: testWaker(registry, lifecycle, undefined),
		config,
		eventLog: new FleetEventLog(),
		fleet: { port: 0, startedAt: Date.now(), statePath, configPath: null, bind: "127.0.0.1" },
		serveUi,
	});
	return serveEdge(edge);
}

describe("ui server proxy", () => {
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

	test("passes the control plane's gzip through, and sends plain JSON to a client that refuses it", async () => {
		const url = `http://127.0.0.1:${ui.port}/ctl/settings`;
		const plain = await fetch(url, { headers: { "accept-encoding": "identity" } });
		expect(plain.status).toBe(200);
		expect(plain.headers.get("content-encoding")).toBeNull();
		const body = await plain.text();
		expect(body.length).toBeGreaterThan(1024);
		const gzipped = await fetch(url, { headers: { "accept-encoding": "gzip" } });
		expect(gzipped.headers.get("content-encoding")).toBe("gzip");
		expect(await gzipped.text()).toBe(body);
		// fetch's default Accept-Encoding (gzip, br) reaches the control plane too.
		expect(await (await fetch(url)).text()).toBe(body);
	});

	test("a plain GET /ws is refused with 426, not served as the UI shell", async () => {
		const res = await fetch(`http://127.0.0.1:${ui.port}/ws`);
		expect(res.status).toBe(426);
	});
});

describe("ui server when the control plane is down", () => {
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

describe("ui server auth gate", () => {
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

describe("ui server proxy forwarded headers and upstream status", () => {
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

describe("ui server callback WebSocket bridge", () => {
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

describe("ui server browser WebSocket bridge", () => {
	/** 64 MiB in 64 KiB frames: more than the kernel buffers on the path, so the burst only fits if the forwarder absorbs it. */
	const FLOOD_CHUNK_BYTES = 64 * 1024;
	const FLOOD_MESSAGES = 1024;
	/** The stand-in's stall rule (CLIENT_STALL_MS, shortened). */
	const STALL_MS = 300;

	interface FakeBrowserSocket {
		/** Messages the stand-in control plane received, in order. */
		received: string[];
		closes: { code: number; reason: string }[];
		flooded: number;
		/** A "flood" command started the pump (a drain after any other send must not). */
		flooding: boolean;
		/** The flood pump stopped because the socket's send buffer was above high water. */
		stalled: boolean;
		stallTimer: Timer | null;
		/** The stand-in applied its stall rule and closed the socket 4503. */
		stallClosed: boolean;
	}

	let upstream: Server<FakeBrowserSocket>;
	let ui: UiServer;
	const upgrades: { url: URL; headers: Headers }[] = [];
	const sockets: FakeBrowserSocket[] = [];
	let stallRule = false;

	/** Send flood frames while the socket has room; drain resumes it. A stall with no drain for STALL_MS closes it 4503. */
	function pump(ws: ServerWebSocket<FakeBrowserSocket>): void {
		const state = ws.data;
		if (!state.flooding) return;
		if (state.stallTimer !== null) {
			clearTimeout(state.stallTimer);
			state.stallTimer = null;
		}
		while (state.flooded < FLOOD_MESSAGES) {
			if (ws.getBufferedAmount() > BROWSER_BRIDGE_HIGH_WATER_BYTES) {
				state.stalled = true;
				if (stallRule) {
					state.stallTimer = setTimeout(() => {
						state.stallClosed = true;
						const close = browserCloseFor("slow_consumer", "browser stopped draining");
						ws.close(close.code, close.reason);
					}, STALL_MS);
				}
				return;
			}
			const index = state.flooded++;
			const frame = JSON.stringify({ type: "flood", pad: "x".repeat(FLOOD_CHUNK_BYTES) });
			if (ws.send(seqFrameMessage(index, frame)) === 0) throw new Error("stand-in send dropped");
		}
	}

	beforeAll(() => {
		upstream = Bun.serve<FakeBrowserSocket>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname !== BROWSER_SOCKET_PATH) return new Response("nope", { status: 404 });
				upgrades.push({ url, headers: req.headers });
				const data: FakeBrowserSocket = {
					received: [],
					closes: [],
					flooded: 0,
					flooding: false,
					stalled: false,
					stallTimer: null,
					stallClosed: false,
				};
				sockets.push(data);
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				perMessageDeflate: false,
				maxPayloadLength: BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
				open(ws) {
					ws.send(seqFrameMessage(1, JSON.stringify({ type: "hello_ok", proto: OMP_PROTO })));
				},
				message(ws, message) {
					const text = String(message);
					ws.data.received.push(text);
					if (text === "flood") {
						ws.data.flooding = true;
						pump(ws);
					} else if (text.startsWith("close:")) {
						const code = Number(text.slice("close:".length));
						ws.close(code, browserCloseFor("proto_mismatch", "old build").reason);
					} else ws.send(`echo:${text}`);
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

	/** Dial the UI's /ws; messages and the close are collected from the first event on. */
	function dialBrowser(
		port: number,
		params: { clientId: string | null; after: number | null; token?: string },
		headers: Record<string, string> = {},
	): DialedSession {
		const url = browserSocketUrl(`http://127.0.0.1:${port}`, {
			clientId: params.clientId,
			after: params.after,
			proto: OMP_PROTO,
			token: params.token ?? null,
		});
		const ws = new BunWebSocket(url, { headers });
		const messages: string[] = [];
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
		});
		ws.addEventListener("message", (event) => {
			messages.push((event as unknown as MessageEvent<string>).data);
		});
		return { ws, messages, closed };
	}

	test("streams messages both ways in order, replays headers and the query upstream, and appends X-Forwarded-For", async () => {
		const client = dialBrowser(
			ui.port,
			{ clientId: "tab-1", after: 1030, token: "t0k" },
			{
				cookie: "omp_session=abc123",
				origin: `http://127.0.0.1:${ui.port}`,
				"user-agent": "omp-test/1",
				"x-forwarded-for": "203.0.113.9",
			},
		);
		await waitFor(() => client.messages.length === 1, 5000, "first upstream message");
		expect(JSON.parse(client.messages[0]!)).toEqual({
			seq: 1,
			frame: { type: "hello_ok", proto: OMP_PROTO },
		});

		const sent = Array.from({ length: 50 }, (_, index) => `m${index}`);
		for (const text of sent) client.ws.send(text);
		// A command-sized message crosses whole, above the callback pair's own cap.
		const large = `large:${"y".repeat(3 * 1024 * 1024)}`;
		client.ws.send(large);
		await waitFor(() => client.messages.length === 2 + sent.length, 10_000, "echoes");
		expect(client.messages.slice(1, 1 + sent.length)).toEqual(sent.map((text) => `echo:${text}`));
		expect(client.messages.at(-1)).toBe(`echo:${large}`);
		const socket = sockets.at(-1)!;
		expect(socket.received).toEqual([...sent, large]);

		const { url, headers } = upgrades.at(-1)!;
		expect(url.pathname).toBe(BROWSER_SOCKET_PATH);
		expect(url.search).toBe(`?client=tab-1&after=1030&proto=${OMP_PROTO}&token=t0k`);
		expect(headers.get("cookie")).toBe("omp_session=abc123");
		expect(headers.get("origin")).toBe(`http://127.0.0.1:${ui.port}`);
		expect(headers.get("user-agent")).toBe("omp-test/1");
		expect(headers.get("x-forwarded-for")).toBe("203.0.113.9, 127.0.0.1");
		expect(headers.get("x-forwarded-proto")).toBe("http");
		expect(headers.get("x-forwarded-host")).toBe(`127.0.0.1:${ui.port}`);

		client.ws.close(1000, "done");
		await client.closed;
		await waitFor(() => socket.closes.length === 1, 5000, "upstream close");
		expect(socket.closes[0]).toEqual({ code: 1000, reason: "done" });
	});

	test("typed closes pass through both ways with their code and reason", async () => {
		const fromUpstream = dialBrowser(ui.port, { clientId: "tab-2", after: null });
		await waitFor(() => fromUpstream.messages.length === 1, 5000, "first upstream message");
		fromUpstream.ws.send("close:4426");
		expect(await fromUpstream.closed).toEqual({
			code: 4426,
			reason: "proto_mismatch: old build",
		});

		const fromBrowser = dialBrowser(ui.port, { clientId: "tab-3", after: null });
		await waitFor(() => fromBrowser.messages.length === 1, 5000, "first upstream message");
		const socket = sockets.at(-1)!;
		fromBrowser.ws.close(4400, "protocol_violation: bad message");
		await fromBrowser.closed;
		await waitFor(() => socket.closes.length === 1, 5000, "upstream close");
		expect(socket.closes[0]).toEqual({ code: 4400, reason: "protocol_violation: bad message" });
	});

	test("an unreachable control plane closes the browser socket 4503", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const deadPort = probe.port!;
		await probe.stop(true);
		const orphan = startUiServer({ port: 0, controlPort: deadPort });
		try {
			const client = dialBrowser(orphan.port, { clientId: "tab-4", after: null });
			const close = await client.closed;
			expect(close.code).toBe(4503);
			expect(browserCloseFromCode(close.code, close.reason)?.kind).toBe("slow_consumer");
			expect(close.reason).toContain(`unreachable on :${deadPort}`);
			expect(client.messages).toEqual([]);
		} finally {
			await orphan.close();
		}
	});

	test("a foreign Origin is refused with a typed 4403 before it reaches the control plane", async () => {
		const before = upgrades.length;
		const client = dialBrowser(
			ui.port,
			{ clientId: "tab-5", after: null },
			{ origin: "https://evil.example" },
		);
		const close = await client.closed;
		expect(close.code).toBe(4403);
		expect(browserCloseFromCode(close.code, close.reason)?.kind).toBe("forbidden");
		expect(client.messages).toEqual([]);
		expect(upgrades.length).toBe(before);
	});

	test("a binary message is a protocol violation: 4400, nothing forwarded", async () => {
		const client = dialBrowser(ui.port, { clientId: "tab-6", after: null });
		await waitFor(() => client.messages.length === 1, 5000, "first upstream message");
		const socket = sockets.at(-1)!;
		client.ws.send(new Uint8Array([1, 2, 3]));
		const close = await client.closed;
		expect(close.code).toBe(4400);
		expect(browserCloseFromCode(close.code, close.reason)?.kind).toBe("protocol_violation");
		await waitFor(() => socket.closes.length === 1, 5000, "upstream close");
		expect(socket.received).toEqual([]);
	});

	/**
	 * A browser that stops reading while the control plane floods it: runs `check` once the flood has
	 * stalled at the stand-in, with the forwarder's samples and the stand-in socket.
	 */
	async function withStuckBrowser(
		run: (stuck: {
			client: DialedSession;
			samples: BridgeSample[];
			socket: FakeBrowserSocket;
		}) => Promise<void>,
	): Promise<void> {
		const samples: BridgeSample[] = [];
		const gated = startUiServer({
			port: 0,
			controlPort: upstream.port!,
			observeBridge: (sample) => samples.push(sample),
		});
		try {
			const client = dialBrowser(gated.port, { clientId: "tab-slow", after: null });
			await waitFor(() => client.messages.length === 1, 5000, "first upstream message");
			const socket = sockets.at(-1)!;
			client.ws.pause();
			client.ws.send("flood");
			await waitFor(() => socket.stalled, 10_000, "upstream send buffer full");
			await run({ client, samples, socket });
		} finally {
			stallRule = false;
			await gated.close();
		}
	}

	/** Flood frames carry their index as seq: the delivered ones are exactly 0..n-1 in order. */
	function expectFloodInOrder(messages: string[]): void {
		messages.slice(1).forEach((text, index) => {
			expect((JSON.parse(text) as { seq: number }).seq).toBe(index);
		});
	}

	test("a stuck browser behind the forwarder stops the upstream reads and the forwarder holds only its bound", async () => {
		await withStuckBrowser(async ({ client, samples, socket }) => {
			// The burst is bigger than every buffer on the path: it is held back at the control plane.
			// The first stall is not yet the end: the kernel buffers between the stand-in and the
			// forwarder still drain until the forwarder's paused reads fill them, slower under load.
			// So wait for the flood to stop moving, then require that it stopped short of the burst.
			// Real time on purpose: the quiet window is kernel TCP flow control, which fake timers do not drive.
			let flooded = -1;
			const deadline = Date.now() + 10_000;
			while (socket.flooded !== flooded && Date.now() < deadline) {
				flooded = socket.flooded;
				await Bun.sleep(300);
			}
			expect(socket.flooded).toBe(flooded);
			expect(flooded).toBeLessThan(FLOOD_MESSAGES);
			// What the forwarder buffered for the browser stopped at the high-water mark plus what one
			// paused read chunk could still dispatch.
			const peak = Math.max(...samples.map((sample) => sample.clientBuffered));
			expect(peak).toBeGreaterThan(BROWSER_BRIDGE_HIGH_WATER_BYTES);
			expect(peak).toBeLessThanOrEqual(BROWSER_BRIDGE_HIGH_WATER_BYTES + 2 * 1024 * 1024);

			client.ws.resume();
			await waitFor(
				() => client.messages.length === 1 + FLOOD_MESSAGES,
				30_000,
				"flood delivered after the browser resumed",
			);
			expect(socket.flooded).toBe(FLOOD_MESSAGES);
			expectFloodInOrder(client.messages);
			client.ws.close();
			await client.closed;
		});
	});

	test("the control plane's stall rule drops a stuck browser behind the forwarder with 4503", async () => {
		stallRule = true;
		await withStuckBrowser(async ({ client, socket }) => {
			await waitFor(() => socket.stallClosed, 10_000, "stand-in stall rule");
			client.ws.resume();
			const close = await client.closed;
			expect(close.code).toBe(4503);
			// What was delivered before the drop is a gap-free prefix: the browser resumes with `after`.
			expect(client.messages.length).toBeLessThan(1 + FLOOD_MESSAGES);
			expectFloodInOrder(client.messages);
		});
	});
});
