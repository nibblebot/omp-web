/**
 * Small robust statistics for the profiling harness. Reps per scenario are few
 * (3-10), so everything is order statistics (median, MAD, nearest-rank
 * percentiles) rather than mean/stddev, and nothing here is clever.
 */
import type { MetricReading, MetricStat } from "./types";

function sortedCopy(xs: readonly number[]): number[] {
	return [...xs].sort((a, b) => a - b);
}

function medianOfSorted(sorted: readonly number[]): number {
	const n = sorted.length;
	const mid = n >> 1;
	return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median; the mean of the two middle values for even counts. Throws on empty input. */
export function median(xs: readonly number[]): number {
	if (xs.length === 0) throw new Error("median of an empty list");
	return medianOfSorted(sortedCopy(xs));
}

/** Unscaled median absolute deviation: `median(|x - median(xs)|)`. Throws on empty input. */
export function mad(xs: readonly number[]): number {
	const m = median(xs);
	return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Nearest-rank percentile: the value at 1-based rank `ceil(p / 100 * n)`,
 * clamped to `[1, n]`, so the result is always an element of the input (no
 * interpolation). `p = 0` yields the minimum, `p = 100` the maximum. The input
 * need not be sorted; a sorted copy is taken (sorting an already sorted array
 * is cheap at the sizes used here). Throws on empty input or `p` outside 0-100.
 */
export function percentile(xs: readonly number[], p: number): number {
	if (xs.length === 0) throw new Error("percentile of an empty list");
	if (!(p >= 0 && p <= 100)) throw new Error(`percentile p out of range: ${p}`);
	const sorted = sortedCopy(xs);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1]!;
}

/**
 * Aggregates the readings of one metric across reps. Unit and improving
 * direction must agree across readings (a mismatch means two scenarios or
 * code paths reuse a metric name with different meaning, which is a harness
 * bug) and throw; `clock` is taken from the first reading that has one.
 * `values` keeps rep order.
 */
export function summarizeMetric(readings: readonly MetricReading[]): MetricStat {
	const first = readings[0];
	if (first === undefined) throw new Error("summarizeMetric: no readings");
	let clock = first.clock;
	for (const r of readings) {
		if (r.unit !== first.unit) {
			throw new Error(`summarizeMetric: mixed units (${first.unit} vs ${r.unit})`);
		}
		if (r.better !== first.better) {
			throw new Error(`summarizeMetric: mixed better (${first.better} vs ${r.better})`);
		}
		clock ??= r.clock;
	}
	const values = readings.map((r) => r.value);
	const sorted = sortedCopy(values);
	const stat: MetricStat = {
		unit: first.unit,
		better: first.better,
		n: values.length,
		median: medianOfSorted(sorted),
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
		mad: mad(values),
		values,
	};
	if (clock !== undefined) stat.clock = clock;
	return stat;
}

/**
 * Formats a number to 3 significant digits without trailing noise
 * (`12.30` -> `12.3`, `1234.5` -> `1230`, `0.0001234` -> `0.000123`). Values
 * outside 1e-6..1e21 use exponent notation; non-finite values render as-is.
 */
export function formatNumber(x: number): string {
	if (!Number.isFinite(x)) return String(x);
	if (x === 0) return "0";
	const abs = Math.abs(x);
	if (abs < 1e-6) return Number(x.toPrecision(3)).toExponential();
	return String(Number(x.toPrecision(3)));
}
