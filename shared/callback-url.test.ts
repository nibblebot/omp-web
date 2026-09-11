import { describe, expect, test } from "bun:test";
import { parseKubernetesCallbackOrigin } from "./callback-url";

/**
 * Boundary coverage for the Kubernetes callback-origin admission. Every case
 * is a URL spelling an operator could really configure; the IPv4-mapped and
 * `localhost.` rows cover spellings the WHATWG URL parser canonicalizes into
 * forms a naive suffix check misses.
 */

describe("parseKubernetesCallbackOrigin", () => {
	test("accepts a Pod-reachable HTTPS origin and normalizes it", () => {
		expect(parseKubernetesCallbackOrigin("https://fleet.example.com")).toBe(
			"https://fleet.example.com",
		);
		// Root slash is the only tolerated path; the result is the bare origin.
		expect(parseKubernetesCallbackOrigin("  https://fleet.example.com/  ")).toBe(
			"https://fleet.example.com",
		);
		// Host case folds; the default port drops; an explicit port stays.
		expect(parseKubernetesCallbackOrigin("https://FLEET.Example.com:443")).toBe(
			"https://fleet.example.com",
		);
		expect(parseKubernetesCallbackOrigin("https://fleet.example.com:8443")).toBe(
			"https://fleet.example.com:8443",
		);
	});

	test("accepts a non-loopback IPv6 literal, brackets preserved", () => {
		expect(parseKubernetesCallbackOrigin("https://[2001:db8::10]:9443")).toBe(
			"https://[2001:db8::10]:9443",
		);
	});

	test("rejects loopback in every canonical spelling", () => {
		const loopbacks = [
			"https://127.0.0.1",
			"https://127.9.9.9:8443",
			"https://localhost",
			"https://localhost:8443",
			// `localhost.` survives URL parsing with its trailing dot.
			"https://localhost.",
			"https://LOCALHOST../",
			"https://[::1]",
			// WHATWG canonicalizes an IPv4-mapped literal to hex groups.
			"https://[::ffff:127.0.0.1]",
			"https://[::ffff:7f00:1]",
			// Decimal/hex/abbreviated IPv4 forms fold to the same literal.
			"https://2130706433",
			"https://0x7f000001",
			"https://127.1",
		];
		for (const url of loopbacks) {
			expect(() => parseKubernetesCallbackOrigin(url)).toThrow(/loopback/);
		}
	});

	test("rejects unspecified addresses in every canonical spelling", () => {
		const unspecified = [
			"https://0.0.0.0",
			"https://[::]",
			"https://[0:0:0:0:0:0:0:0]",
			"https://[::ffff:0:0]",
			"https://[::ffff:0.0.0.0]",
		];
		for (const url of unspecified) {
			expect(() => parseKubernetesCallbackOrigin(url)).toThrow(/unspecified/);
		}
	});

	test("rejects credentials, non-root paths, queries, and fragments", () => {
		expect(() => parseKubernetesCallbackOrigin("https://user:pw@fleet.example.com")).toThrow(
			/credentials/,
		);
		expect(() => parseKubernetesCallbackOrigin("https://fleet.example.com/base")).toThrow(/path/);
		expect(() => parseKubernetesCallbackOrigin("https://fleet.example.com/?x=1")).toThrow(
			/query string/,
		);
		expect(() => parseKubernetesCallbackOrigin("https://fleet.example.com/#frag")).toThrow(
			/fragment/,
		);
	});

	test("rejects non-https, empty, and malformed values", () => {
		expect(() => parseKubernetesCallbackOrigin("http://fleet.example.com")).toThrow(/not https/);
		expect(() => parseKubernetesCallbackOrigin("  ")).toThrow(/empty/);
		expect(() => parseKubernetesCallbackOrigin("fleet.example.com")).toThrow(/not an absolute URL/);
		// Port 0 is a URL-valid spelling of "no usable port".
		expect(() => parseKubernetesCallbackOrigin("https://fleet.example.com:0")).toThrow(/port/);
	});
});
