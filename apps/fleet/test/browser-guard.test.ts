/**
 * Direct cases for browser-guard.ts: the Host / Origin / Sec-Fetch-Site rules
 * for loopback peers, the configured public origin, and fail-closed parsing.
 */
import { describe, expect, test } from "bun:test";
import { browserRequestAllowed, isJsonRequest } from "../browser-guard";

function req(headers: Record<string, string>): Request {
	return new Request("http://127.0.0.1:4722/ctl/projects", { method: "POST", headers });
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
});

describe("isJsonRequest", () => {
	test("accepts application/json with parameters and any case", () => {
		expect(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
		expect(isJsonRequest(req({ "content-type": "Application/JSON" }))).toBe(true);
	});

	test("refuses other media types and a missing Content-Type", () => {
		expect(isJsonRequest(req({ "content-type": "text/plain" }))).toBe(false);
		expect(isJsonRequest(req({ "content-type": "application/jsonx" }))).toBe(false);
		expect(isJsonRequest(req({}))).toBe(false);
	});
});
