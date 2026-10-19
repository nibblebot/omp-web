import { describe, expect, test } from "bun:test";
import { fleetOrigin } from "../dev-proxy";

const FLEET_PORT = "4722";

describe("fleetOrigin", () => {
	test("re-presents a LAN page's same-origin request as the loopback fleet origin", () => {
		expect(fleetOrigin("192.168.1.20:4713", "http://192.168.1.20:4713", FLEET_PORT)).toBe(
			"http://localhost:4722",
		);
	});

	test("matches the Host case-insensitively", () => {
		expect(fleetOrigin("Box.local:4713", "http://box.local:4713", FLEET_PORT)).toBe(
			"http://localhost:4722",
		);
	});

	test("leaves a cross-site Origin unchanged so the fleet guard refuses it", () => {
		expect(fleetOrigin("192.168.1.20:4713", "https://evil.example", FLEET_PORT)).toBeUndefined();
	});

	test("leaves an Origin on a different port than the Host unchanged", () => {
		expect(
			fleetOrigin("192.168.1.20:4713", "http://192.168.1.20:9999", FLEET_PORT),
		).toBeUndefined();
	});

	test("leaves a request without Origin or Host unchanged", () => {
		expect(fleetOrigin("192.168.1.20:4713", undefined, FLEET_PORT)).toBeUndefined();
		expect(fleetOrigin(undefined, "http://192.168.1.20:4713", FLEET_PORT)).toBeUndefined();
	});

	test("leaves an opaque or unparseable Origin unchanged", () => {
		expect(fleetOrigin("192.168.1.20:4713", "null", FLEET_PORT)).toBeUndefined();
		expect(fleetOrigin("192.168.1.20:4713", "not a url", FLEET_PORT)).toBeUndefined();
	});

	test("leaves a non-http(s) same-host Origin unchanged", () => {
		expect(fleetOrigin("192.168.1.20:4713", "ws://192.168.1.20:4713", FLEET_PORT)).toBeUndefined();
	});
});
