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
			"#/w/d7/s/x/extra/a/b/c",
			"#/w/d7/s/x/activities/job/%E0%A4%A",
			"#/w/d7/s/x/activities/Job/j1",
			"#/w/d7/s/x/agents/a1",
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

	test("a workspace route with a dock-shaped tail is a dock, anything else without a session marker is none", () => {
		// `#/w/s/x` is workspace "s" with dock "x": the session marker is only the third segment.
		expect(parseRoute("#/w/s/x")).toEqual({
			kind: "workspace",
			workspaceId: "s",
			dock: { kind: "x" },
		});
		expect(parseRoute("#/w/d7/x/y")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/x/y/z/w")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/s")).toEqual({ kind: "none" });
	});

	test("a workspace-level dock route has no session segment and round trips", () => {
		const bare: Route = { kind: "workspace", workspaceId: "d7", dock: { kind: "activities" } };
		const item: Route = {
			kind: "workspace",
			workspaceId: "d7",
			dock: { kind: "activities", item: { type: "job", id: "j 1" } },
		};
		expect(formatRoute(bare)).toBe("#/w/d7/activities");
		expect(parseRoute("#/w/d7/activities")).toEqual(bare);
		expect(formatRoute(item)).toBe("#/w/d7/activities/job/j%201");
		expect(parseRoute("#/w/d7/activities/job/j%201")).toEqual(item);
		expect(parseRoute("#/w/d7/activities/job")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/agents/a1")).toEqual({ kind: "none" });
	});

	test("a dock segment round trips, with an optional item", () => {
		const review: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "review" },
		};
		const activities: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "activities" },
		};
		const subagent: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "activities", item: { type: "subagent", id: "a 1/2" } },
		};
		const job: Route = {
			kind: "session",
			workspaceId: "d7",
			sessionId: "x",
			dock: { kind: "activities", item: { type: "job", id: "j1" } },
		};
		expect(formatRoute(review)).toBe("#/w/d7/s/x/review");
		expect(parseRoute("#/w/d7/s/x/review")).toEqual(review);
		expect(formatRoute(activities)).toBe("#/w/d7/s/x/activities");
		expect(parseRoute("#/w/d7/s/x/activities")).toEqual(activities);
		expect(formatRoute(subagent)).toBe("#/w/d7/s/x/activities/subagent/a%201%2F2");
		expect(parseRoute("#/w/d7/s/x/activities/subagent/a%201%2F2")).toEqual(subagent);
		expect(formatRoute(job)).toBe("#/w/d7/s/x/activities/job/j1");
		expect(parseRoute("#/w/d7/s/x/activities/job/j1")).toEqual(job);
	});

	test("a dock segment with an item missing its id or with extra segments parses to none", () => {
		expect(parseRoute("#/w/d7/s/x/activities/job")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/s/x/activities/job/")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/s/x/activities/job/j1/extra")).toEqual({ kind: "none" });
		expect(parseRoute("#/w/d7/s/x/Activities")).toEqual({ kind: "none" });
	});
});
