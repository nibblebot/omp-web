/**
 * Unit tests for the fleet trusted-proxy matcher (P2.3): IP/CIDR literal
 * parsing and peer matching. The gate-policy semantics (forwarded headers
 * honored only from trusted peers, forged values ignored) live in
 * fleet/server-auth.test.ts; this file covers the matcher itself.
 */
import { describe, expect, test } from "bun:test";
import { compileTrustedProxies, isTrustedProxy, parseIp, parseProxyRule } from "./trusted-proxy";

describe("parseIp", () => {
	test("parses IPv4 and IPv6 literals; rejects malformed input", () => {
		expect(parseIp("192.0.2.1")).toEqual({ bits: 0xc0000201n, width: 32 });
		expect(parseIp("::1")?.width).toBe(128);
		expect(parseIp("2001:db8::1")?.width).toBe(128);
		// IPv4-mapped IPv6 normalizes to its IPv4 form.
		const mapped = parseIp("::ffff:192.0.2.1");
		expect(mapped).toEqual({ bits: 0xc0000201n, width: 32 });
	});

	test("rejects malformed literals (never a match — fail closed)", () => {
		for (const bad of [
			"",
			"not-an-ip",
			"300.1.1.1", // out of octet range
			"127.0.0.1.5", // five parts
			"01.2.3.4", // leading zero (octal ambiguity)
			"1.2.3", // too few parts
			"127.a.0.1", // non-numeric
			"fe80::1%eth0", // zone id
			"2001:db8::1::2", // double compression
		]) {
			expect(parseIp(bad), bad).toBeNull();
		}
	});
});

describe("parseProxyRule", () => {
	test("bare IP and CIDR literals compile; host bits are masked", () => {
		expect(parseProxyRule("192.0.2.1")?.matches("192.0.2.1")).toBe(true);
		expect(parseProxyRule("192.0.2.1")?.matches("192.0.2.2")).toBe(false);

		const cidr = parseProxyRule("192.0.2.0/24");
		expect(cidr?.matches("192.0.2.200")).toBe(true);
		expect(cidr?.matches("192.0.3.1")).toBe(false);

		// Host bits in the literal are masked off, not rejected.
		const masked = parseProxyRule("192.0.2.9/24");
		expect(masked?.matches("192.0.2.200")).toBe(true);
	});

	test("rejects malformed rules (never match)", () => {
		for (const bad of ["192.0.2.0/33", "192.0.2.0/ab", "::/129", "203.0.113.9/", ""]) {
			expect(parseProxyRule(bad), bad).toBeNull();
		}
	});

	test("IPv6 CIDR and mapped-v4/v6 family isolation", () => {
		const v6 = parseProxyRule("2001:db8::/32");
		expect(v6?.matches("2001:db8::1")).toBe(true);
		expect(v6?.matches("2001:db9::1")).toBe(false);
		expect(v6?.matches("192.0.2.1")).toBe(false); // family mismatch

		// A v4 rule matches a dual-stack peer reported as IPv4-mapped IPv6.
		const v4 = parseProxyRule("192.0.2.0/24");
		expect(v4?.matches("::ffff:192.0.2.9")).toBe(true);
	});
});

describe("compileTrustedProxies + isTrustedProxy", () => {
	const { rules, invalid } = compileTrustedProxies(["203.0.113.0/24", "2001:db8::/32", "junk"]);
	test("valid rules compile; malformed literals are reported and never match", () => {
		expect(rules.length).toBe(2);
		expect(invalid).toEqual(["junk"]);
		expect(isTrustedProxy("203.0.113.9", rules)).toBe(true);
		expect(isTrustedProxy("198.51.100.7", rules)).toBe(false);
		expect(isTrustedProxy(null, rules)).toBe(false);
		expect(isTrustedProxy(undefined, rules)).toBe(false);
	});

	test("no rules → nothing is trusted (default fail closed)", () => {
		const empty = compileTrustedProxies([]);
		expect(isTrustedProxy("127.0.0.1", empty.rules)).toBe(false);
	});
});
