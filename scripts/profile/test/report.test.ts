import { afterAll, expect, test } from "bun:test";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { join } from "node:path";
import { compareSummaries, loadSummary, renderComparisonMarkdown } from "../compare";
import { mad, median, percentile, summarizeMetric } from "../stats";
import { buildSummary, renderSummaryMarkdown, saveBaseline, writeSummary } from "../summary";
import type { HostFingerprint, RepResult, Summary } from "../types";
import { metric } from "../types";

const fingerprint: HostFingerprint = {
	cpuModel: "Test CPU",
	logicalCpus: 32,
	governor: "powersave",
	pin: {
		enabled: true,
		fleet: "2",
		sessions: ["4", "6"],
		chromium: "8-11",
		fakeModel: "12",
		harness: "0",
	},
	bun: "1.4.2",
	sdk: "1.0.0",
	chromium: "Chromium 130",
	chromiumPath: "/usr/bin/chromium",
	gitCommit: "abc1234",
	gitDirty: true,
	os: "linux 7.2",
	transport: "ws",
};

function rep(n: number, latency: number, warmup = false): RepResult {
	return {
		scenarioId: "s1",
		rep: warmup ? 0 : n,
		warmup,
		durationMs: 1000,
		metrics: {
			"latency.p50": metric(latency, "ms", "lower", "clock-monotonic-ffi"),
			"rate.frames": metric(1000, "frames/s", "higher"),
			"info.count": metric(n, "count", "info"),
		},
		notes: ["same note", "same note", `rep ${n}`],
		affinity: [
			{
				role: "fleet",
				pid: 1,
				expected: "2",
				threads: 3,
				seen: ["2"],
				ok: n !== 2,
				repinned: false,
			},
		],
	};
}

function makeSummary(latencies: number[], overrides: Partial<Summary> = {}): Summary {
	return {
		...buildSummary({
			startedAt: "2026-01-01T00:00:00Z",
			finishedAt: "2026-01-01T00:01:00Z",
			args: { quick: false },
			fingerprint,
			perturbed: [],
			scenarios: [
				{
					id: "s1",
					title: "Scenario one",
					description: "Does a thing.",
					results: [rep(0, 99, true), ...latencies.map((l, i) => rep(i + 1, l))],
				},
			],
		}),
		...overrides,
	};
}

test("median, mad, percentile", () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([4, 1, 3, 2])).toBe(2.5);
	expect(mad([1, 2, 3, 4, 100])).toBe(1);
	expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
	expect(percentile([1, 2, 3, 4], 75)).toBe(3);
	expect(percentile([1, 2, 3, 4], 0)).toBe(1);
	expect(percentile([1, 2, 3, 4], 100)).toBe(4);
	expect(() => median([])).toThrow();
});

test("summarizeMetric rejects mixed units", () => {
	expect(() => summarizeMetric([metric(1, "ms", "lower"), metric(1, "bytes", "lower")])).toThrow(
		/mixed units/,
	);
	const stat = summarizeMetric([
		metric(1, "ms", "lower", "chromium-wall-clock"),
		metric(3, "ms", "lower"),
	]);
	expect(stat).toMatchObject({ n: 2, median: 2, min: 1, max: 3, clock: "chromium-wall-clock" });
});

test("buildSummary separates warmups and tolerates missing metrics", () => {
	const lone = rep(3, 10);
	delete lone.metrics["rate.frames"];
	const summary = buildSummary({
		startedAt: "a",
		finishedAt: "b",
		args: {},
		fingerprint,
		perturbed: [],
		scenarios: [
			{
				id: "s1",
				title: "t",
				description: "d",
				results: [rep(0, 1, true), rep(1, 10), rep(2, 20), lone],
			},
		],
	});
	const s = summary.scenarios[0]!;
	expect(s.warmups).toHaveLength(1);
	expect(s.reps).toHaveLength(3);
	expect(s.metrics["latency.p50"]!.n).toBe(3);
	expect(s.metrics["rate.frames"]!.n).toBe(2);
});

test("verdicts: improved vs within noise vs low confidence vs info", () => {
	const baseline = makeSummary([100, 101, 99, 100, 100]);
	const better = compareSummaries(makeSummary([50, 51, 49, 50, 50]), baseline);
	const row = better.rows.find((r) => r.metric === "latency.p50")!;
	expect(row.verdict).toBe("improved");
	expect(row.delta).toBe(-50);
	expect(row.deltaPct).toBe(-50);
	expect(row.lowConfidence).toBe(false);

	const worse = compareSummaries(makeSummary([200, 201, 199, 200, 200]), baseline);
	expect(worse.rows.find((r) => r.metric === "latency.p50")!.verdict).toBe("regressed");

	const same = compareSummaries(makeSummary([100.2, 101, 99, 100, 100.4]), baseline);
	expect(same.rows.find((r) => r.metric === "latency.p50")!.verdict).toBe("within noise");
	expect(same.rows.find((r) => r.metric === "info.count")!.verdict).toBe("info");
	expect(same.warnings).toEqual([]);

	const few = compareSummaries(makeSummary([50, 50]), baseline);
	expect(few.rows.find((r) => r.metric === "latency.p50")!.lowConfidence).toBe(true);
	expect(renderComparisonMarkdown(few)).toContain("low confidence (n<3)");
});

test("fingerprint mismatch, perturbation and quick warnings; one-sided metrics", () => {
	const baseline = makeSummary([100, 100, 100]);
	const other = makeSummary([100, 100, 100], {
		fingerprint: {
			...fingerprint,
			governor: "performance",
			bun: "1.5.0",
			pin: { ...fingerprint.pin, fleet: "3" },
		},
		perturbed: ["cpuprofile"],
		args: { quick: true },
	});
	delete other.scenarios[0]!.metrics["rate.frames"];
	other.scenarios.push({ ...other.scenarios[0]!, id: "extra", metrics: {} });
	const c = compareSummaries(other, baseline);
	const text = c.warnings.join("\n");
	expect(text).toContain("governor differs");
	expect(text).toContain("Bun differs");
	expect(text).toContain("pin plan differs");
	expect(text).toContain("perturbed");
	expect(text).toContain("args.quick differs");
	expect(c.onlyInBaseline).toEqual([{ scenario: "s1", metric: "rate.frames" }]);
	expect(c.scenariosOnlyInCurrent).toEqual(["extra"]);
	expect(renderComparisonMarkdown(c)).toContain("Metrics only in baseline");
});

test("summary markdown carries fingerprint, affinity failures and pin plan", () => {
	const md = renderSummaryMarkdown(makeSummary([100, 110, 120]));
	expect(md).toContain("CPU: Test CPU");
	expect(md).toContain("Logical CPUs: 32");
	expect(md).toContain("Governor: powersave");
	expect(md).toContain("fleet 2; sessions 4, 6; chromium 8-11; fake model 12; harness 0");
	expect(md).toContain("Chromium: Chromium 130 (/usr/bin/chromium)");
	expect(md).toContain("abc1234 (dirty)");
	expect(md).toContain("clock-monotonic-ffi");
	expect(md).toContain("| latency.p50 | ms | 110 |");
	expect(md).toContain("fleet: NOT OK");
	expect(md).toContain("rep 2: fleet pid 1");
	expect(md).not.toContain("WARNING: perturbed");
	expect(md.match(/same note/g)).toHaveLength(1);

	const unpinned = renderSummaryMarkdown(
		makeSummary([1], {
			fingerprint: {
				...fingerprint,
				chromium: undefined,
				pin: { ...fingerprint.pin, enabled: false, disabledReason: "no taskset" },
			},
			perturbed: ["heap"],
			extras: { big: Array.from({ length: 50 }, (_, i) => i) },
		}),
	);
	expect(unpinned).toContain("unpinned: no taskset");
	expect(unpinned).toContain("Chromium: not run");
	expect(unpinned).toContain("WARNING: perturbed");
	expect(unpinned).toContain("30 more of 50 items truncated");
});

afterAll(cleanupTempDirs);

test("writeSummary, saveBaseline, loadSummary", async () => {
	const dir = tempDir("profile-report-");
	const summary = makeSummary([1, 2, 3]);
	const { jsonPath, mdPath } = await writeSummary(join(dir, "out"), summary);
	expect(await Bun.file(mdPath).exists()).toBe(true);
	expect((await loadSummary(jsonPath)).scenarios[0]!.id).toBe("s1");

	const saved = await saveBaseline(summary, "base-1.0", join(dir, "baselines"));
	expect(saved.jsonPath.endsWith("base-1.0.json")).toBe(true);
	await expect(saveBaseline(summary, "base-1.0", join(dir, "baselines"))).rejects.toThrow(/exists/);
	await saveBaseline(summary, "base-1.0", join(dir, "baselines"), { overwrite: true });
	await expect(saveBaseline(summary, "../evil", dir)).rejects.toThrow(/invalid baseline name/);

	const bad = join(dir, "bad.json");
	await Bun.write(bad, JSON.stringify({ schema: 2 }));
	await expect(loadSummary(bad)).rejects.toThrow(/schema/);
});
