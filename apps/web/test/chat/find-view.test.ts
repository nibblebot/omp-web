/** The find card's parsing of the SDK's FindToolDetails: normal, timed out (partial) and malformed shapes. */
import { describe, expect, test } from "bun:test";
import {
	accountingLine,
	findCallOf,
	judgedLabel,
	parseFindDetails,
	parseFindTimeout,
	rangeLabel,
	scoreTone,
	timeoutProgress,
} from "../../components/chat/tools/find-view";

const stats = {
	listed: 10,
	requests: 4,
	failed: 1,
	unanswered: 0,
	judged: 10,
	filesRead: 3,
	fileBytes: 100,
	inputTokens: 12_400,
	outputTokens: 50,
	cost: 0.0123,
	apiMs: 900,
	failures: ["verify: 429"],
};

const details = {
	query: "retry backoff",
	keywords: ["retry", "backoff"],
	threshold: 0.3,
	coverage: "partial",
	elapsedMs: 4_200,
	scopePath: "apps/session/",
	stats,
	hits: [
		{
			rel: "a.ts",
			contentScore: 0.9,
			linesSeen: 40,
			truncated: true,
			ranges: [
				{ start: 5, end: 5, p: 0.4, snippet: "weak" },
				{ start: 10, end: 14, p: 0.9, snippet: "strong" },
			],
		},
		{ rel: "omp://doc/b", contentScore: 0.2, linesSeen: 8, truncated: false, ranges: [] },
	],
};

describe("parseFindDetails", () => {
	test("reads a normal result", () => {
		const view = parseFindDetails(details);
		expect(view).not.toBeNull();
		expect(view).toMatchObject({
			query: "retry backoff",
			scope: "apps/session/",
			keywords: ["retry", "backoff"],
			threshold: 0.3,
			coverage: "partial",
			timeout: undefined,
			filesRead: 3,
			requests: 4,
			failed: 1,
			failures: ["verify: 429"],
		});
		expect(view!.hits.map((hit) => hit.path)).toEqual(["a.ts", "omp://doc/b"]);
		// Ranges come back strongest first.
		expect(view!.hits[0]!.ranges.map((range) => range.snippet)).toEqual(["strong", "weak"]);
		expect(judgedLabel(view!.hits[0]!)).toBe("40 lines judged, partial");
		expect(judgedLabel(view!.hits[1]!)).toBe("8 lines judged");
		expect(rangeLabel(view!.hits[0]!.ranges[0]!)).toBe("10-14");
		expect(rangeLabel(view!.hits[0]!.ranges[1]!)).toBe("5");
		expect(accountingLine(view!)).toBe(
			"3 files read \u00b7 \u03c4 0.30 \u00b7 12.4k tokens \u00b7 $0.012 \u00b7 4s",
		);
	});

	test("carries a timed-out result's verified and passage counts", () => {
		const view = parseFindDetails({ ...details, timeout: { verified: 12, passages: 40 } });
		expect(view!.timeout).toEqual({ verified: 12, passages: 40 });
		expect(timeoutProgress(view!.timeout!)).toBe("12 of 40 verified");
		expect(view!.hits).toHaveLength(2);
	});

	test("a zero-hit result is still a result", () => {
		const view = parseFindDetails({ ...details, hits: [] });
		expect(view!.hits).toEqual([]);
	});

	test("details that are not a find result give null", () => {
		for (const bad of [undefined, null, "text", 4, [], {}, { hits: "x" }, { query: "q" }]) {
			expect(parseFindDetails(bad)).toBeNull();
		}
	});

	test("drops malformed hits, ranges and stats instead of failing", () => {
		const view = parseFindDetails({
			hits: [
				null,
				"x",
				{ contentScore: 0.5 },
				{
					rel: "ok.ts",
					contentScore: "high",
					ranges: [null, { start: "1" }, { start: 3, p: 7, snippet: 9 }],
				},
			],
			stats: "nope",
			keywords: ["a", 3, ""],
			coverage: "bogus",
			elapsedMs: Number.NaN,
		});
		expect(view!.hits).toEqual([
			{
				path: "ok.ts",
				score: 1,
				linesSeen: undefined,
				truncated: false,
				ranges: [{ start: 3, end: 3, p: 1, snippet: "" }],
			},
		]);
		expect(view).toMatchObject({
			keywords: ["a"],
			coverage: undefined,
			failed: 0,
			failures: [],
			filesRead: undefined,
			elapsedMs: undefined,
		});
		expect(accountingLine(view!)).toBe("");
	});
});

describe("parseFindTimeout", () => {
	test("needs two non-negative counts", () => {
		expect(parseFindTimeout({ verified: 0, passages: 5 })).toEqual({ verified: 0, passages: 5 });
		expect(parseFindTimeout({ verified: 1 })).toBeUndefined();
		expect(parseFindTimeout({ verified: -1, passages: 5 })).toBeUndefined();
		expect(parseFindTimeout({ verified: "1", passages: "5" })).toBeUndefined();
		expect(parseFindTimeout(null)).toBeUndefined();
		expect(parseFindDetails({ hits: [], timeout: "soon" })!.timeout).toBeUndefined();
	});
});

describe("findCallOf and scoreTone", () => {
	test("reads the call arguments defensively", () => {
		expect(findCallOf({ query: "q", grep_keywords: ["a", 1], path: "src" })).toEqual({
			query: "q",
			keywords: ["a"],
			path: "src",
		});
		expect(findCallOf(null)).toEqual({ query: undefined, keywords: [], path: undefined });
		expect(findCallOf({ query: 3, path: "" })).toEqual({
			query: undefined,
			keywords: [],
			path: undefined,
		});
	});

	test("buckets scores like the TUI gauge", () => {
		expect([0.95, 0.7, 0.69, 0.4, 0.39].map(scoreTone)).toEqual([
			"strong",
			"strong",
			"plausible",
			"plausible",
			"weak",
		]);
	});
});
