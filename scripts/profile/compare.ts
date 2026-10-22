/**
 * Baseline comparison for profiling summaries. Pure data + markdown: callers
 * decide what to do with the verdicts (the CLI always exits 0 on compare).
 * `compareSummaries` is total: missing scenarios/metrics are reported, never
 * thrown on.
 */
import { formatNumber } from "./stats";
import { describePin } from "./summary";
import type { Better, MetricUnit, Summary } from "./types";

/**
 * A median delta counts only when it exceeds `NOISE_BAND_MADS` times the
 * larger of the two sides' MADs (floored at 1% of the baseline median, so
 * zero-MAD metrics do not flag sub-percent jitter).
 */
export const NOISE_BAND_MADS = 3;

/** Relative floor of the noise band, as a fraction of |baseline median|. */
const BAND_FLOOR_FRACTION = 0.01;

/** Fewer measured reps than this on either side makes a verdict low confidence. */
const MIN_CONFIDENT_N = 3;

export type Verdict = "improved" | "regressed" | "within noise" | "info";

export interface MetricComparison {
	scenario: string;
	metric: string;
	unit: MetricUnit;
	better: Better;
	baselineMedian: number;
	currentMedian: number;
	/** current - baseline. */
	delta: number;
	/** delta / |baseline median| * 100; null when the baseline median is 0. */
	deltaPct: number | null;
	/** Half-width of the noise band: `NOISE_BAND_MADS * max(MADs, 1% of |baseline median|)`. */
	band: number;
	verdict: Verdict;
	/** True when either side has n < 3 measured reps. */
	lowConfidence: boolean;
	baselineN: number;
	currentN: number;
}

export interface ScenarioMetricRef {
	scenario: string;
	metric: string;
}

export interface Comparison {
	baselineStartedAt: string;
	currentStartedAt: string;
	baselineCommit: { commit: string; dirty: boolean };
	currentCommit: { commit: string; dirty: boolean };
	rows: MetricComparison[];
	onlyInCurrent: ScenarioMetricRef[];
	onlyInBaseline: ScenarioMetricRef[];
	scenariosOnlyInCurrent: string[];
	scenariosOnlyInBaseline: string[];
	/** Reasons the two runs may not be comparable. */
	warnings: string[];
}

function fingerprintWarnings(current: Summary, baseline: Summary): string[] {
	const warnings: string[] = [];
	const c = current.fingerprint;
	const b = baseline.fingerprint;
	const checks: Array<[string, string, string]> = [
		["CPU model", b.cpuModel, c.cpuModel],
		["logical CPUs", String(b.logicalCpus), String(c.logicalCpus)],
		["governor", b.governor, c.governor],
		["pin plan", describePin(b.pin), describePin(c.pin)],
		["Bun", b.bun, c.bun],
		["SDK", b.sdk, c.sdk],
		["Chromium", b.chromium ?? "not run", c.chromium ?? "not run"],
		["transport", b.transport, c.transport],
	];
	for (const [what, was, now] of checks) {
		if (was !== now) warnings.push(`${what} differs: baseline ${was}, current ${now}`);
	}
	if (baseline.perturbed.length > 0 || current.perturbed.length > 0) {
		const same =
			baseline.perturbed.length === current.perturbed.length &&
			baseline.perturbed.every((p, i) => p === current.perturbed[i]);
		const fmt = (p: string[]) => (p.length > 0 ? p.join(", ") : "none");
		warnings.push(
			`perturbed run${same ? " (both sides)" : "; perturbation differs"}: baseline ${fmt(baseline.perturbed)}, current ${fmt(current.perturbed)}; timings are not comparable`,
		);
	}
	const bq = baseline.args.quick;
	const cq = current.args.quick;
	if (bq !== cq) {
		warnings.push(
			`args.quick differs (baseline ${JSON.stringify(bq)}, current ${JSON.stringify(cq)}); rep counts and durations differ`,
		);
	}
	return warnings;
}

/**
 * Compares every (scenario, metric) present on both sides. The verdict is
 * `info` for info-direction metrics (and unit mismatches, which also warn);
 * otherwise `within noise` when |delta| <= band, else `improved`/`regressed`
 * by the baseline's `better`.
 */
export function compareSummaries(current: Summary, baseline: Summary): Comparison {
	const warnings = fingerprintWarnings(current, baseline);
	for (const [label, side] of [
		["current", current],
		["baseline", baseline],
	] as const) {
		for (const sc of side.scenarios) {
			if (sc.failedReps > 0) {
				warnings.push(
					`${label} ${sc.id}: ${sc.failedReps} failed rep(s) excluded from its aggregates`,
				);
			}
		}
	}
	const rows: MetricComparison[] = [];
	const onlyInCurrent: ScenarioMetricRef[] = [];
	const onlyInBaseline: ScenarioMetricRef[] = [];
	const baselineById = new Map(baseline.scenarios.map((s) => [s.id, s]));
	const currentIds = new Set(current.scenarios.map((s) => s.id));

	for (const cs of current.scenarios) {
		const bs = baselineById.get(cs.id);
		if (bs === undefined) continue;
		const names = new Set([...Object.keys(cs.metrics), ...Object.keys(bs.metrics)]);
		for (const metric of [...names].sort()) {
			const cm = cs.metrics[metric];
			const bm = bs.metrics[metric];
			if (cm === undefined) {
				onlyInBaseline.push({ scenario: cs.id, metric });
				continue;
			}
			if (bm === undefined) {
				onlyInCurrent.push({ scenario: cs.id, metric });
				continue;
			}
			const delta = cm.median - bm.median;
			const deltaPct = bm.median === 0 ? null : (delta / Math.abs(bm.median)) * 100;
			const band =
				NOISE_BAND_MADS * Math.max(bm.mad, cm.mad, BAND_FLOOR_FRACTION * Math.abs(bm.median));
			const unitMismatch = bm.unit !== cm.unit;
			if (unitMismatch) {
				warnings.push(
					`${cs.id} / ${metric}: unit differs (baseline ${bm.unit}, current ${cm.unit}); delta not meaningful`,
				);
			}
			let verdict: Verdict;
			if (
				bm.better === "info" ||
				unitMismatch ||
				!Number.isFinite(delta) ||
				!Number.isFinite(band)
			) {
				verdict = "info";
			} else if (Math.abs(delta) <= band) {
				verdict = "within noise";
			} else {
				verdict = delta < 0 === (bm.better === "lower") ? "improved" : "regressed";
			}
			rows.push({
				scenario: cs.id,
				metric,
				unit: cm.unit,
				better: bm.better,
				baselineMedian: bm.median,
				currentMedian: cm.median,
				delta,
				deltaPct,
				band,
				verdict,
				lowConfidence: verdict !== "info" && (bm.n < MIN_CONFIDENT_N || cm.n < MIN_CONFIDENT_N),
				baselineN: bm.n,
				currentN: cm.n,
			});
		}
	}
	for (const bs of baseline.scenarios) {
		if (currentIds.has(bs.id)) continue;
		for (const metric of Object.keys(bs.metrics).sort()) {
			onlyInBaseline.push({ scenario: bs.id, metric });
		}
	}
	for (const cs of current.scenarios) {
		if (baselineById.has(cs.id)) continue;
		for (const metric of Object.keys(cs.metrics).sort()) {
			onlyInCurrent.push({ scenario: cs.id, metric });
		}
	}
	return {
		baselineStartedAt: baseline.startedAt,
		currentStartedAt: current.startedAt,
		baselineCommit: {
			commit: baseline.fingerprint.gitCommit,
			dirty: baseline.fingerprint.gitDirty,
		},
		currentCommit: { commit: current.fingerprint.gitCommit, dirty: current.fingerprint.gitDirty },
		rows,
		onlyInCurrent,
		onlyInBaseline,
		scenariosOnlyInCurrent: current.scenarios
			.filter((s) => !baselineById.has(s.id))
			.map((s) => s.id),
		scenariosOnlyInBaseline: baseline.scenarios
			.filter((s) => !currentIds.has(s.id))
			.map((s) => s.id),
		warnings,
	};
}

function signed(x: number): string {
	return `${x > 0 ? "+" : ""}${formatNumber(x)}`;
}

function refList(refs: ScenarioMetricRef[]): string[] {
	return refs.map((r) => `- ${r.scenario} / ${r.metric}`);
}

export function renderComparisonMarkdown(c: Comparison): string {
	const dirty = (x: { dirty: boolean }) => (x.dirty ? " (dirty)" : "");
	const lines: string[] = [
		"# omp-web profile comparison",
		"",
		`- Baseline: commit ${c.baselineCommit.commit}${dirty(c.baselineCommit)}, started ${c.baselineStartedAt}`,
		`- Current: commit ${c.currentCommit.commit}${dirty(c.currentCommit)}, started ${c.currentStartedAt}`,
		`- Noise band: ${NOISE_BAND_MADS} x max(baseline MAD, current MAD, 1% of |baseline median|)`,
		"",
	];
	if (c.warnings.length > 0) {
		lines.push("## Warnings", "");
		for (const w of c.warnings) lines.push(`- ${w}`);
		lines.push("");
	}
	const count = (v: Verdict) => c.rows.filter((r) => r.verdict === v).length;
	lines.push(
		"## Metrics",
		"",
		`${c.rows.length} compared: ${count("improved")} improved, ${count("regressed")} regressed, ${count("within noise")} within noise, ${count("info")} info.`,
		"",
	);
	if (c.rows.length > 0) {
		lines.push(
			"| scenario | metric | baseline median | current median | delta | delta % | band | verdict |",
			"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
		);
		for (const r of c.rows) {
			const verdict = r.lowConfidence
				? `${r.verdict}; low confidence (n<${MIN_CONFIDENT_N})`
				: r.verdict;
			lines.push(
				`| ${r.scenario} | ${r.metric.replaceAll("|", "\\|")} (${r.unit}) | ${formatNumber(r.baselineMedian)} | ${formatNumber(r.currentMedian)} | ${signed(r.delta)} | ${r.deltaPct === null ? "n/a" : `${signed(r.deltaPct)}%`} | ${formatNumber(r.band)} | ${verdict} |`,
			);
		}
		lines.push("");
	}
	const sections: Array<[string, string[]]> = [
		["Scenarios only in current", c.scenariosOnlyInCurrent.map((s) => `- ${s}`)],
		["Scenarios only in baseline", c.scenariosOnlyInBaseline.map((s) => `- ${s}`)],
		["Metrics only in current", refList(c.onlyInCurrent)],
		["Metrics only in baseline", refList(c.onlyInBaseline)],
	];
	for (const [title, items] of sections) {
		if (items.length > 0) lines.push(`## ${title}`, "", ...items, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Reads a summary JSON file; throws a descriptive error unless it is a schema-1 summary. */
export async function loadSummary(path: string): Promise<Summary> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(path).json();
	} catch (err) {
		throw new Error(
			`cannot read summary ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`${path} is not a profile summary (expected a JSON object)`);
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.schema !== 1) {
		throw new Error(
			`${path} has unsupported summary schema ${JSON.stringify(obj.schema)} (expected 1); regenerate it with the current harness`,
		);
	}
	if (
		!Array.isArray(obj.scenarios) ||
		typeof obj.fingerprint !== "object" ||
		obj.fingerprint === null
	) {
		throw new Error(`${path} is not a valid schema-1 summary (missing scenarios or fingerprint)`);
	}
	return obj as unknown as Summary;
}
