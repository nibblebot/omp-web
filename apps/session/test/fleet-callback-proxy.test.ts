/**
 * The pair socket honors the configured proxy and never falls back to a direct
 * dial. Bun's fetch reads HTTP(S)_PROXY / NO_PROXY on its own but its WebSocket
 * client ignores them, so FleetCallback resolves the explicit `proxy` option or
 * the environment itself and hands the result to the dial. The proxy
 * (lib/testkit/connect-proxy.testkit.ts) is a minimal HTTP CONNECT tunnel that
 * records every target it was asked for.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { startConnectProxy, type ConnectProxy } from "#lib/testkit/connect-proxy.testkit";
import { CallbackError } from "#lib/wire/callback-protocol";
import { FleetCallback, type FleetCallbackOptions } from "../fleet-callback";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.testkit";

const WORKSPACE = "ws-proxy";
const GENERATION = 1;
const TOKEN = "e".repeat(64);

const fleets: FakeFleet[] = [];
const proxies: ConnectProxy[] = [];
const callbacks: FleetCallback[] = [];
const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
const savedEnv = new Map<string, string | undefined>(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

/** Clears every proxy variable, then applies `set`; afterAll restores the originals. */
function setProxyEnv(set: Record<string, string> = {}): void {
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, set);
}

afterAll(() => {
	for (const callback of callbacks) callback.stop();
	for (const fleet of fleets) fleet.stop();
	for (const proxy of proxies) proxy.stop();
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function makeFleet(): FakeFleet {
	const fleet = startFakeFleet({ workspaceId: WORKSPACE, generation: GENERATION, token: TOKEN });
	fleets.push(fleet);
	return fleet;
}

async function makeProxy(): Promise<ConnectProxy> {
	const proxy = await startConnectProxy();
	proxies.push(proxy);
	return proxy;
}

function makeCallback(
	fleet: FakeFleet,
	options: Partial<FleetCallbackOptions> = {},
	onError?: (error: CallbackError) => void,
): FleetCallback {
	const callback = new FleetCallback(
		{
			url: fleet.url,
			workspaceId: WORKSPACE,
			generation: GENERATION,
			token: TOKEN,
			allowHttp: true,
			backoffMinMs: 10,
			backoffMaxMs: 10,
			...options,
		},
		onError === undefined ? undefined : { onError },
	);
	callbacks.push(callback);
	return callback;
}

describe("FleetCallback proxy", () => {
	test("an explicit proxy carries the pair socket", async () => {
		setProxyEnv();
		const fleet = makeFleet();
		const proxy = await makeProxy();
		const callback = makeCallback(fleet, { proxy: proxy.url });
		await callback.start();

		expect(proxy.connects).toEqual([`127.0.0.1:${new URL(fleet.url).port}`]);
		expect(fleet.upgrades.length).toBe(1);
		expect(fleet.upgrades[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
	});

	test("the HTTP_PROXY environment is resolved for the socket, as Bun's fetch would", async () => {
		const fleet = makeFleet();
		const proxy = await makeProxy();
		setProxyEnv({ HTTP_PROXY: proxy.url });
		const callback = makeCallback(fleet);
		await callback.start();

		expect(proxy.connects).toEqual([`127.0.0.1:${new URL(fleet.url).port}`]);
	});

	test("NO_PROXY exempts the fleet host from the environment proxy", async () => {
		const fleet = makeFleet();
		const proxy = await makeProxy();
		setProxyEnv({ HTTP_PROXY: proxy.url, NO_PROXY: "localhost,127.0.0.1" });
		const callback = makeCallback(fleet);
		await callback.start();

		expect(proxy.connects).toEqual([]);
		expect(fleet.upgrades.length).toBe(1);
	});

	test("an explicit proxy wins over the environment", async () => {
		const fleet = makeFleet();
		const explicit = await makeProxy();
		const ambient = await makeProxy();
		setProxyEnv({ HTTP_PROXY: ambient.url });
		const callback = makeCallback(fleet, { proxy: explicit.url });
		await callback.start();

		expect(explicit.connects.length).toBe(1);
		expect(ambient.connects).toEqual([]);
	});

	test("a proxy that cannot be reached is a retryable failure, never a direct dial", async () => {
		setProxyEnv();
		const fleet = makeFleet();
		const dead = await startConnectProxy();
		dead.stop();
		const errors: CallbackError[] = [];
		let notify: () => void = () => {};
		const failedTwice = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const callback = makeCallback(fleet, { proxy: dead.url }, (error) => {
			errors.push(error);
			if (errors.length >= 2) notify();
		});
		void callback.start().catch(() => {});
		await failedTwice;

		expect(errors.every((error) => error.code === "retryable")).toBe(true);
		expect(fleet.upgrades.length).toBe(0);
		callback.stop();
	});

	test("an unsupported proxy scheme in the environment is a construction error", () => {
		const fleet = makeFleet();
		setProxyEnv({ HTTP_PROXY: "socks5://127.0.0.1:1080" });
		expect(() => makeCallback(fleet)).toThrow("unsupported callback proxy scheme");
	});

	test("an unsupported explicit proxy scheme is a construction error, never a direct dial", () => {
		setProxyEnv();
		const fleet = makeFleet();
		expect(() => makeCallback(fleet, { proxy: "socks5://127.0.0.1:1080" })).toThrow(
			"unsupported callback proxy scheme",
		);
	});
});
