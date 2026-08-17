import { describe, expect, test } from "bun:test";
import { collectFileSamples, mean, parseJunitXml, percentile, sd, welch } from "./bench-tests";
import type { BenchRecord, Counts, RunSample } from "./bench-tests";

const machine = { cpu: "test-cpu", physical: 1, logical: 1, workers: 1 };
const passCounts: Counts = { pass: 2, fail: 0, skip: 0 };

function v1Record(over: Partial<BenchRecord>): BenchRecord {
	return {
		ts: 1,
		gitSha: null,
		dirty: null,
		bun: "1.3.14",
		machine,
		wallMs: 100,
		files: { "a.test.ts": 5, "b.test.ts": 9 },
		counts: passCounts,
		failed: false,
		noisy: [],
		...over,
	};
}

function runSample(wallMs: number, files: Record<string, number>): RunSample {
	return { wallMs, files, counts: passCounts };
}

describe("mean/sd", () => {
	test("mean of empty is 0", () => {
		expect(mean([])).toBe(0);
	});
	test("mean of one element is that element", () => {
		expect(mean([7])).toBe(7);
	});
	test("sd of fewer than two samples is 0", () => {
		expect(sd([])).toBe(0);
		expect(sd([5])).toBe(0);
	});
	test("sd of identical samples is 0", () => {
		expect(sd([2, 2, 2])).toBe(0);
	});
	test("sample sd (n-1) of [1,2,3] is 1", () => {
		expect(sd([1, 2, 3])).toBeCloseTo(1, 10);
	});
});

describe("percentile", () => {
	test("empty input is NaN", () => {
		expect(percentile([], 0.5)).toBeNaN();
	});
	test("one element is that element at any p", () => {
		expect(percentile([7], 0.5)).toBe(7);
		expect(percentile([7], 0.95)).toBe(7);
	});
	test("odd count: p50 is the middle element", () => {
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
	});
	test("even count: p50 interpolates between the two middle elements", () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
	});
	test("p0 and p100 clamp to the ends", () => {
		expect(percentile([1, 2, 3, 4], 0)).toBe(1);
		expect(percentile([1, 2, 3, 4], 1)).toBe(4);
	});
	test("p95 interpolates within the top gap", () => {
		expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 10);
	});
});

describe("welch", () => {
	test("identical samples give t = 0", () => {
		expect(welch([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 10);
	});
	test("clearly separated samples give |t| > 2", () => {
		expect(Math.abs(welch([1, 2, 3, 4, 5], [100, 101, 102, 103, 104]))).toBeGreaterThan(2);
	});
	test("moderately overlapping samples stay under the threshold", () => {
		expect(Math.abs(welch([1, 2, 3, 4, 5], [2, 3, 4, 5, 6]))).toBeLessThan(2);
	});
	test("fewer than two samples on either side is NaN", () => {
		expect(welch([1], [2, 3])).toBeNaN();
		expect(welch([1, 2], [3])).toBeNaN();
		expect(welch([], [])).toBeNaN();
	});
});

describe("collectFileSamples (v1 back-compat)", () => {
	test("v1 record contributes its per-file median", () => {
		expect(collectFileSamples([v1Record({})], "a.test.ts")).toEqual([5]);
	});
	test("v1 record without the file contributes nothing", () => {
		expect(collectFileSamples([v1Record({})], "missing.test.ts")).toEqual([]);
	});
	test("v2 record contributes one sample per run", () => {
		const v2 = v1Record({
			files: { "a.test.ts": 5 },
			runs: [
				runSample(10, { "a.test.ts": 4 }),
				runSample(12, { "a.test.ts": 6 }),
				runSample(11, { "a.test.ts": 5 }),
			],
		});
		expect(collectFileSamples([v2], "a.test.ts")).toEqual([4, 6, 5]);
	});
	test("v2 record falls back to the median when a run lacks the file", () => {
		const v2 = v1Record({
			files: { "a.test.ts": 5 },
			runs: [runSample(10, { "b.test.ts": 1 }), runSample(12, { "b.test.ts": 2 })],
		});
		expect(collectFileSamples([v2], "a.test.ts")).toEqual([5]);
	});
});

describe("parseJunitXml failure names", () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2" skipped="0" time="0">
  <testsuite name="shared/sse.test.ts" file="shared/sse.test.ts" tests="2" failures="1" skipped="0" time="0" hostname="h">
    <testcase name="passes fine" classname="a" time="0.001" file="shared/sse.test.ts" line="1" assertions="1" />
    <testcase name="times out" classname="a" time="0.002" file="shared/sse.test.ts" line="2" assertions="1">
      <failure type="TimeoutError" />
    </testcase>
  </testsuite>
  <testsuite name="server/x.test.ts" file="server/x.test.ts" tests="1" failures="1" skipped="0" time="0" hostname="h">
    <testcase name="loads badly" classname="b" time="0" file="server/x.test.ts" line="1" assertions="0">
      <error type="LoadError">boom</error>
    </testcase>
  </testsuite>
</testsuites>`;

	test("failure names use the depth-1 suite path and testcase name", () => {
		const { failures } = parseJunitXml(xml);
		expect(failures).toEqual(["shared/sse.test.ts > times out", "server/x.test.ts > loads badly"]);
	});
	test("per-file ms sums testcase time attrs (testsuite time is 0)", () => {
		const { files } = parseJunitXml(xml);
		expect(files.find((f) => f.path === "shared/sse.test.ts")?.ms).toBe(3);
		expect(files.find((f) => f.path === "server/x.test.ts")?.ms).toBe(0);
	});
	test("counts roll up per suite", () => {
		const { counts } = parseJunitXml(xml);
		expect(counts).toEqual({ pass: 1, fail: 2, skip: 0 });
	});
	test("passing XML produces no failure names", () => {
		const { failures } = parseJunitXml(
			'<testsuites name="bun test"><testsuite name="a.test.ts" file="a.test.ts" tests="1" failures="0"><testcase name="ok" time="0.01" file="a.test.ts" /></testsuite></testsuites>',
		);
		expect(failures).toEqual([]);
	});
});
