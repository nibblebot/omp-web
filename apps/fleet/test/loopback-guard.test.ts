/**
 * Loopback browser-request guard (FEDGE-02): a loopback peer is exempt from
 * browser auth, so a page the user visits could reach the control plane through
 * the browser's loopback route (DNS rebinding, cross-site POST). Foreign Host,
 * Origin, and Sec-Fetch-Site values are refused, mutations must be
 * application/json, and header-less CLI calls keep working. Covers the control
 * plane directly and the UI proxy in front of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { cleanupTempDirs } from "#lib/testkit/temp-dir.testkit";
import type { FleetServer } from "../server";
import { startUiServer, type UiServer } from "../ui-server";
import { fleetPaths, startTestFleet } from "./server.testkit";

afterAll(cleanupTempDirs);

/** Raw HTTP/1.1 request over loopback: node:http keeps the Host header we set. */
function rawRequest(
	port: number,
	path: string,
	headers: Record<string, string>,
	body: string,
): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
		res.resume();
		resolve(res.statusCode ?? 0);
	});
	req.on("error", reject);
	req.end(body);
	return promise;
}

const JSON_HEADERS = { "content-type": "application/json" };
const BODY = JSON.stringify({});

describe("loopback browser guard on the control plane", () => {
	let fleet: FleetServer;

	beforeAll(async () => {
		fleet = await startTestFleet(fleetPaths(), {});
	});

	afterAll(async () => {
		await fleet.close();
	});

	test("a foreign Origin on a loopback mutation is refused", async () => {
		const status = await rawRequest(
			fleet.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, origin: "https://evil.example" },
			BODY,
		);
		expect(status).toBe(403);
	});

	test("Sec-Fetch-Site cross-site on a loopback mutation is refused", async () => {
		const status = await rawRequest(
			fleet.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, "sec-fetch-site": "cross-site" },
			BODY,
		);
		expect(status).toBe(403);
	});

	test("a foreign Host on a loopback request is refused (DNS rebinding)", async () => {
		const status = await rawRequest(
			fleet.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, host: "evil.example:4722" },
			BODY,
		);
		expect(status).toBe(403);
	});

	test("a non-JSON body on a mutation is refused with 415", async () => {
		const status = await rawRequest(
			fleet.port,
			"/ctl/projects",
			{ "content-type": "text/plain" },
			BODY,
		);
		expect(status).toBe(415);
	});

	test("a loopback Origin (any port) and a loopback Host are admitted", async () => {
		const status = await rawRequest(
			fleet.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, origin: "http://localhost:5173", host: "localhost:4722" },
			BODY,
		);
		expect(status).not.toBe(403);
		expect(status).not.toBe(415);
	});

	test("a header-less CLI JSON call is admitted", async () => {
		const status = await rawRequest(fleet.port, "/ctl/projects", JSON_HEADERS, BODY);
		expect(status).not.toBe(403);
		expect(status).not.toBe(415);
	});
});

describe("loopback browser guard through the UI proxy", () => {
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

	test("a foreign Host at the UI port is refused before proxying", async () => {
		const status = await rawRequest(
			ui.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, host: "evil.example:4723" },
			BODY,
		);
		expect(status).toBe(403);
	});

	test("a foreign Origin at the UI port is refused before proxying", async () => {
		const status = await rawRequest(
			ui.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, origin: "https://evil.example" },
			BODY,
		);
		expect(status).toBe(403);
	});

	test("a same-origin loopback request at the UI port still proxies", async () => {
		const status = await rawRequest(
			ui.port,
			"/ctl/projects",
			{ ...JSON_HEADERS, origin: `http://127.0.0.1:${ui.port}` },
			BODY,
		);
		expect(status).not.toBe(403);
		expect(status).not.toBe(502);
	});
});
