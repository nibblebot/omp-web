/**
 * UI daemon wire tests: startUiServer in front of a real control plane
 * (startFleet) and in front of a fake upstream whose /events stream reports
 * when the proxy cancels it. Covers static serving, proxied JSON / command /
 * SSE, the 502 when the control plane is down, the auth gate as seen through
 * the proxy, and the control plane's serveUi=false 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { Registry } from "../registry";
import type { FleetServer } from "../server";
import { SpawnSupervisor } from "../supervisor";
import { startUiServer, type UiServer } from "../ui-server";
import { cleanupTempDirs, serveEdge } from "./edge.testkit";
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

	test("a forged X-Forwarded-For: 127.0.0.1 does not make the proxied request loopback", async () => {
		const res = await fetch(`http://127.0.0.1:${ui.port}/ctl/sessions`, {
			headers: { "x-forwarded-for": "127.0.0.1" },
		});
		expect(res.status).toBe(401);
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

	test("the default still serves the static UI", async () => {
		const on = await mountEdge(tempDir("omp-web-ui-on-"));
		try {
			const res = await fetch(`http://127.0.0.1:${on.port}/`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
		} finally {
			on.stop();
		}
	});
});

describe("ui daemon callback stream", () => {
	let upstream: Server<undefined>;
	let ui: UiServer;
	let notifyLine: () => void = () => {};

	beforeAll(() => {
		// Reads the upload chunk by chunk and answers with everything once it ends.
		// Signals as soon as the first line lands, so the test can prove the proxy forwards before the upload closes.
		upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const reader = req.body!.getReader();
				const decoder = new TextDecoder();
				let text = "";
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					text += decoder.decode(next.value, { stream: true });
					if (text.includes('{"n":1}')) notifyLine();
				}
				return new Response(text, { headers: { "content-type": "application/x-ndjson" } });
			},
		});
		if (upstream.port === undefined) throw new Error("upstream has no port");
		ui = startUiServer({ port: 0, controlPort: upstream.port });
	});

	afterAll(async () => {
		await ui.close();
		await upstream.stop(true);
	});

	test("forwards a /callback/up upload chunk by chunk, before the upload ends", async () => {
		const encoder = new TextEncoder();
		let push: (line: string) => void = () => {};
		let end: () => void = () => {};
		const upload = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (line) => controller.enqueue(encoder.encode(line));
				end = () => controller.close();
			},
		});
		const lineSeen = new Promise<void>((resolve) => {
			notifyLine = resolve;
		});
		const pending = fetch(`http://127.0.0.1:${ui.port}/callback/up`, {
			method: "POST",
			body: upload,
			duplex: "half",
		} as RequestInit);
		push('{"n":1}\n');
		// The upstream must see the first line while the upload is still open.
		await lineSeen;
		push('{"n":2}\n');
		end();
		const res = await pending;
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('{"n":1}');
		expect(body).toContain('{"n":2}');
	});
});
