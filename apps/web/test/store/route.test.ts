import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, type Route } from "../../store/route";

describe("route parse/format", () => {
	const roundTrips: Array<[Route, string]> = [
		[{ kind: "daemon", daemonId: "d7" }, "#/d/d7"],
		[{ kind: "session", daemonId: "d7", sessionId: "0192-abc" }, "#/d/d7/s/0192-abc"],
		[
			{ kind: "session", daemonId: "d 1/x", sessionId: "a/b?c#d%" },
			"#/d/d%201%2Fx/s/a%2Fb%3Fc%23d%25",
		],
		[{ kind: "none" }, ""],
	];
	for (const [route, hash] of roundTrips) {
		test(`round trips ${hash || "(empty)"}`, () => {
			expect(formatRoute(route)).toBe(hash);
			expect(parseRoute(hash)).toEqual(route);
		});
	}

	test("the leading slash is optional on parse", () => {
		expect(parseRoute("#d/d7/s/x")).toEqual({ kind: "session", daemonId: "d7", sessionId: "x" });
	});

	test("unknown or malformed shapes parse to none, never throw", () => {
		for (const hash of [
			"",
			"#",
			"#/",
			"#/d",
			"#/d/",
			"#/d//s/x",
			"#/d/d7/s",
			"#/d/d7/s/",
			"#/d/d7/s/x/extra",
			"#/d/d7/agent/a1",
			"#/d/%E0%A4%A/s/x",
			"#/d/d7/s/%E0%A4%A",
			"#/nope/d7",
			"#/stories/coverage",
		]) {
			expect(parseRoute(hash)).toEqual({ kind: "none" });
		}
	});

	test("legacy Analysis hashes are carried verbatim", () => {
		for (const hash of [
			"#/s/abc.jsonl",
			"#s/abc.jsonl",
			"#/stored/d7/sess-1",
			"#stored/d7/sess-1",
		]) {
			const route = parseRoute(hash);
			expect(route).toEqual({ kind: "analysis", hash });
			expect(formatRoute(route)).toBe(hash);
		}
	});

	test("a bare #/s or #/stored (no target) is not an Analysis deep link", () => {
		expect(parseRoute("#/s/")).toEqual({ kind: "none" });
		expect(parseRoute("#/stored")).toEqual({ kind: "none" });
	});

	test("a daemon route with extra segments and no session marker parses to none", () => {
		expect(parseRoute("#/d/s/x")).toEqual({ kind: "none" });
		expect(parseRoute("#/d/stored/x")).toEqual({ kind: "none" });
	});
});
