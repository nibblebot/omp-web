import { describe, expect, test } from "bun:test";
import { isLoopbackHost } from "#lib/platform/hosts";

// isLoopbackHost gates the daemon's R14 token requirement, the fleet's
// non-loopback bind refusal, and the callback HTTP-loopback exception:
// a false positive skips an auth gate.
describe("isLoopbackHost", () => {
	test.each(["localhost", "LocalHost", "127.0.0.1", "127.255.255.255", "::1", "0:0:0:0:0:0:0:1"])(
		"%s is loopback",
		(host) => {
			expect(isLoopbackHost(host)).toBe(true);
		},
	);

	test.each(["::ffff:127.0.0.1", "::FFFF:7f00:1"])("IPv4-mapped %s is loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(true);
	});

	test.each([
		"0.0.0.0",
		"128.0.0.1",
		"126.255.255.255",
		"::",
		"::2",
		"::ffff:10.0.0.1",
		"example.com",
		"localhost.example.com",
		"",
	])("%s is not loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(false);
	});

	// Not IP literals, so they would resolve as hostnames, possibly off-loopback.
	test.each(["127.a.b.c", "127.0.0.999", "127.1", "127.0.0.01"])(
		"non-literal %s is not loopback",
		(host) => {
			expect(isLoopbackHost(host)).toBe(false);
		},
	);
});
