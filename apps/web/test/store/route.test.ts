import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, type Route } from "../../store/route";

describe("route parse/format", () => {
	const roundTrips: Array<[Route, string]> = [
		[{ kind: "workspace", workspaceId: "d7" }, "#/w/d7"],
		[{ kind: "session", workspaceId: "d7", sessionId: "0192-abc" }, "#/w/d7/s/0192-abc"],
		[
			{ kind: "session", workspaceId: "d 1/x", sessionId: "a/b?c#d%" },
			"#/w/d%201%2Fx/s/a%2Fb%3Fc%23d%25",
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
		expect(parseRoute("#w/d7/s/x")).toEqual({ kind: "session", workspaceId: "d7", sessionId: "x" });
	});

	test("unknown or malformed shapes parse to none, never throw", () => {
		for (const hash of [
			"",
			"#",
			"#/",
			"#/d/d7",
			"#/d/d7/s/x",
			"#/w",
			"#/w/",
			"#/w//s/x",
			"#/w/d7/s",
			"#/w/d7/s/",
			"#/w/d7/s/x/extra/a/b",
			"#/w/d7/s/x/Review",
			"#/w/d7/s/x/review/%E0%A4%A",
			"#/w/d7/s/x/",
			"#/w/d7/agent/a1",
			"#/w/%E0%A4%A/s/x",
			"#/w/d7/s/%E0%A4%A",
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

	test("a session route with extra segments and no session marker parses to none", () => {
		expect(parseRoute("#/w/s/x")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/stored/x")).toEqual({ kind: "none" });
	});

	test("dock segments round trip with a kind and an optional id", () => {
		const review: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "review" },
		};
		const agent: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "agent", id: "a 1/2" },
		};
		expect(formatRoute(review)).toBe("#/w/d7/s/x/review");
		expect(parseRoute("#/w/d7/s/x/review")).toEqual(review);
		expect(formatRoute(agent)).toBe("#/w/d7/s/x/agent/a%201%2F2");
		expect(parseRoute("#/w/d7/s/x/agent/a%201%2F2")).toEqual(agent);
	});
});
