/**
 * The callback rows of the production-profile preflight: `callback-url` (DNS +
 * TCP, or the proxy the session would dial through) and `callback-ws`, a real
 * credential-less WebSocket upgrade to `/callback/ws`. Success is a real
 * DaemonTransportRegistry answering with its typed refusal, directly and
 * through the CONNECT proxy testkit; failures are a server that never
 * upgrades, a WebSocket endpoint that is not the fleet, a silent upgrade, and
 * a closed port. Only the two callback rows are asserted: the provider rows
 * are covered by preflight.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startConnectProxy } from "#lib/testkit/connect-proxy.testkit";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { BwrapProfile, PreflightCheck } from "#lib/runtime/provider-protocol";
import { DaemonTransportRegistry, type FleetSocketData } from "../daemon-transport";
import { runProfilePreflight } from "../preflight";

afterAll(cleanupTempDirs);

const stops: Array<() => void> = [];
afterAll(() => {
	for (const stop of stops) stop();
});

/** Short probe budget for the cases that wait it out; the real default is 5 s. */
const PROBE_TIMEOUT_MS = 400;

function fixture() {
	const root = tempDir("preflight-callback-");
	const workspaceRoot = join(root, "workspaces");
	const logsRoot = join(root, "logs");
	const tool = join(root, "tool");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(logsRoot, { recursive: true });
	writeFileSync(tool, "#!/bin/sh\nexit 0\n");
	chmodSync(tool, 0o755);
	const profile: BwrapProfile = { id: "test", provider: "bwrap", executable: tool, tools: [] };
	return { root, profile, workspaceRoot, logsRoot };
}

/** The two callback rows of a preflight against `callbackUrl`, with `env` as the operator environment. */
async function callbackRows(
	callbackUrl: string,
	env: Record<string, string> = {},
): Promise<{ url: PreflightCheck; ws: PreflightCheck | undefined }> {
	const f = fixture();
	const result = await runProfilePreflight(f.profile, {
		workspaceRoot: f.workspaceRoot,
		logsRoot: f.logsRoot,
		callbackUrl,
		callbackProbeTimeoutMs: PROBE_TIMEOUT_MS,
		env: { HOME: f.root, ...env },
	});
	return {
		url: result.checks.find((c) => c.name === "callback-url")!,
		ws: result.checks.find((c) => c.name === "callback-ws"),
	};
}

/** A real fleet callback registry mounted the way fleet/server.ts mounts it. */
function startFleet(): { url: string } {
	const registry = new DaemonTransportRegistry();
	const server = Bun.serve<FleetSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		websocket: registry.websocket,
		fetch: async (req, srv) => {
			const handled = await registry.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
	});
	stops.push(() => {
		registry.close();
		server.stop(true);
	});
	return { url: `http://127.0.0.1:${server.port}` };
}

/** A plain HTTP server that never upgrades (a proxy that strips Upgrade answers like this). */
function startPlainHttp(): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	stops.push(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

/** A WebSocket server that is not the fleet: `open` runs on the accepted socket. */
function startForeignWebSocket(open: (ws: Bun.ServerWebSocket<undefined>) => void): string {
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req, srv) =>
			srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 }),
		websocket: { open, message() {} },
	});
	stops.push(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

describe("callback WebSocket probe", () => {
	test("a real fleet registry answers the credential-less upgrade with its typed refusal: reached", async () => {
		const fleet = startFleet();
		const { url, ws } = await callbackRows(fleet.url);
		expect(url.ok).toBe(true);
		expect(url.detail).toContain("TCP connect");
		expect(ws).toBeDefined();
		expect(ws!.ok).toBe(true);
		expect(ws!.detail).toContain("reached the fleet");
		expect(ws!.detail).toMatch(/close 4\d{3}/);
		expect(ws!.detail).toContain("invalid_identity");
	});

	test("through the CONNECT proxy testkit the probe dials via the proxy and reaches the fleet", async () => {
		const fleet = startFleet();
		const proxy = await startConnectProxy();
		stops.push(() => proxy.stop());
		const { url, ws } = await callbackRows(fleet.url, { HTTP_PROXY: proxy.url });
		expect(url.ok).toBe(true);
		expect(url.detail).toContain("through proxy");
		expect(url.detail).toContain("direct DNS and TCP not checked");
		expect(ws!.ok).toBe(true);
		expect(ws!.detail).toContain("reached the fleet via proxy");
		expect(proxy.connects).toEqual([new URL(fleet.url).host]);
	});

	test("NO_PROXY keeps the probe off the proxy", async () => {
		const fleet = startFleet();
		const proxy = await startConnectProxy();
		stops.push(() => proxy.stop());
		const { ws } = await callbackRows(fleet.url, { HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1" });
		expect(ws!.ok).toBe(true);
		expect(proxy.connects).toEqual([]);
	});

	test("a plain HTTP server that does not upgrade fails with an actionable ingress remediation", async () => {
		const { url, ws } = await callbackRows(startPlainHttp());
		expect(url.ok).toBe(true);
		expect(ws!.ok).toBe(false);
		expect(ws!.detail).toContain("WebSocket upgrade to ");
		expect(ws!.detail).toContain("/callback/ws");
		expect(ws!.detail).toContain("Expected 101");
		expect(ws!.remediation).toContain("Upgrade and Connection headers");
		expect(ws!.remediation).toContain("HTTP/1.1");
	});

	test("a WebSocket endpoint that is not the fleet is named as such", async () => {
		const { ws } = await callbackRows(
			startForeignWebSocket((socket) => {
				socket.send("hello");
			}),
		);
		expect(ws!.ok).toBe(false);
		expect(ws!.detail).toContain("not the omp-web fleet");
	});

	test("an upgrade that is never answered fails at the probe budget, once", async () => {
		const started = Date.now();
		const { ws } = await callbackRows(startForeignWebSocket(() => {}));
		expect(ws!.ok).toBe(false);
		expect(ws!.detail).toContain(`did not answer within ${PROBE_TIMEOUT_MS}ms`);
		expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS * 5);
	});

	test("a closed port fails the TCP row and skips the WebSocket row", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const port = server.port;
		server.stop(true);
		const { url, ws } = await callbackRows(`http://127.0.0.1:${port}`);
		expect(url.ok).toBe(false);
		expect(url.detail).toContain("TCP connect failed");
		expect(ws).toBeUndefined();
	});

	test("an unusable proxy scheme fails the URL row with no direct fallback", async () => {
		const { url, ws } = await callbackRows("http://127.0.0.1:9", {
			HTTP_PROXY: "socks5://127.0.0.1:1080",
		});
		expect(url.ok).toBe(false);
		expect(url.detail).toContain("unsupported callback proxy scheme");
		expect(ws).toBeUndefined();
	});

	test("a path prefix in the callback URL is kept in the upgrade request", async () => {
		const seen: string[] = [];
		const server = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, srv) {
				seen.push(new URL(req.url).pathname);
				return srv.upgrade(req, { data: undefined })
					? undefined
					: new Response("no", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.close(4401, "unauthorized: test");
				},
				message() {},
			},
		});
		stops.push(() => server.stop(true));
		const { ws } = await callbackRows(`http://127.0.0.1:${server.port}/omp/`);
		expect(ws!.ok).toBe(true);
		expect(seen).toEqual(["/omp/callback/ws"]);
	});
});
