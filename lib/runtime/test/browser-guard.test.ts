/**
 * Direct cases for browser-guard.ts: the Host / Origin / Sec-Fetch-Site rules
 * for loopback peers, the configured public origin, and fail-closed parsing.
 */
import { describe, expect, test } from "bun:test";
import { browserRequestAllowed, isLoopbackHostname, isLoopbackIp } from "../browser-guard";

function req(headers: Record<string, string>): Request {
	return new Request("http://127.0.0.1:4722/ws", { headers });
}

describe("browserRequestAllowed", () => {
	test("admits a header-less request", () => {
		expect(browserRequestAllowed(req({}), undefined)).toBe(true);
	});

	test("admits loopback Hosts (name and IP literals)", () => {
		expect(browserRequestAllowed(req({ host: "localhost:4723" }), undefined)).toBe(true);
		expect(browserRequestAllowed(req({ host: "127.0.0.1:4722" }), undefined)).toBe(true);
		expect(browserRequestAllowed(req({ host: "[::1]:4722" }), undefined)).toBe(true);
	});

	test("refuses a foreign Host unless it is the configured browser origin", () => {
		expect(browserRequestAllowed(req({ host: "evil.example" }), undefined)).toBe(false);
		expect(browserRequestAllowed(req({ host: "ui.example.com" }), "https://ui.example.com")).toBe(
			true,
		);
		expect(
			browserRequestAllowed(req({ host: "ui.example.com:8443" }), "https://ui.example.com"),
		).toBe(false);
	});

	test("refuses an unparseable Host", () => {
		expect(browserRequestAllowed(req({ host: "a b" }), undefined)).toBe(false);
	});

	test("admits loopback http(s) Origins and refuses foreign or null Origins", () => {
		expect(browserRequestAllowed(req({ origin: "http://localhost:5173" }), undefined)).toBe(true);
		expect(browserRequestAllowed(req({ origin: "https://evil.example" }), undefined)).toBe(false);
		expect(browserRequestAllowed(req({ origin: "null" }), undefined)).toBe(false);
	});

	test("admits the configured browser origin as an Origin", () => {
		expect(
			browserRequestAllowed(req({ origin: "https://ui.example.com" }), "https://ui.example.com"),
		).toBe(true);
	});

	test("refuses cross-site Sec-Fetch-Site and admits same-origin", () => {
		expect(browserRequestAllowed(req({ "sec-fetch-site": "cross-site" }), undefined)).toBe(false);
		expect(browserRequestAllowed(req({ "sec-fetch-site": "same-origin" }), undefined)).toBe(true);
	});

	test("fails closed on an unparseable configured browser origin", () => {
		expect(browserRequestAllowed(req({}), "not a url")).toBe(false);
	});

	test("admits a dev-proxied LAN page only once its Host and Origin are the loopback fleet", () => {
		const lanOrigin = "http://192.168.1.20:4713";
		expect(
			browserRequestAllowed(req({ host: "192.168.1.20:4713", origin: lanOrigin }), undefined),
		).toBe(false);
		expect(
			browserRequestAllowed(
				req({ host: "localhost:4722", origin: "http://localhost:4722" }),
				undefined,
			),
		).toBe(true);
	});
});

describe("loopback helpers", () => {
	test("isLoopbackIp takes 127/8, ::1 and mapped forms with strict numeric parts", () => {
		expect(isLoopbackIp("127.0.0.1")).toBe(true);
		expect(isLoopbackIp("::1")).toBe(true);
		expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackIp("127.a.b.c")).toBe(false);
		expect(isLoopbackIp("10.0.0.1")).toBe(false);
		expect(isLoopbackIp(null)).toBe(false);
	});

	test("isLoopbackHostname takes localhost and bracketed IPv6 literals", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("evil.example")).toBe(false);
	});
});
