/**
 * Summary construction, markdown rendering and persistence for the profiling
 * harness. `Summary` is plain JSON (see types.ts); the markdown is a
 * human-readable view of the same data and is never parsed back.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { formatNumber, summarizeMetric } from "./stats";
import type {
	AffinityRecord,
	HostFingerprint,
	MetricReading,
	MetricStat,
	PinPlan,
	RepResult,
	ScenarioSummary,
	Summary,
} from "./types";

export interface BuildSummaryInput {
	startedAt: string;
	finishedAt: string;
	args: Record<string, unknown>;
	fingerprint: HostFingerprint;
	perturbed: string[];
	extras?: Record<string, unknown>;
	scenarios: Array<{ id: string; title: string; description: string; results: RepResult[] }>;
}

export interface SummaryPaths {
	jsonPath: string;
	mdPath: string;
}

/**
 * Splits each scenario's results into warmups and measured reps and
 * aggregates every metric over the measured reps. The metric set is the union
 * across reps; a metric absent from some reps is aggregated over the reps that
 * have it (`n` shows how many). Non-finite readings are dropped, so a metric
 * with only non-finite readings does not appear.
 */
export function buildSummary(input: BuildSummaryInput): Summary {
	const scenarios: ScenarioSummary[] = input.scenarios.map((s) => {
		const warmups = s.results.filter((r) => r.warmup);
		const reps = s.results.filter((r) => !r.warmup);
		const valid = reps.filter((r) => r.failed === undefined);
		const readings = new Map<string, MetricReading[]>();
		for (const rep of valid) {
			for (const [name, reading] of Object.entries(rep.metrics)) {
				if (!Number.isFinite(reading.value)) continue;
				const list = readings.get(name);
				if (list === undefined) readings.set(name, [reading]);
				else list.push(reading);
			}
		}
		const metrics: Record<string, MetricStat> = {};
		for (const name of [...readings.keys()].sort()) {
			try {
				metrics[name] = summarizeMetric(readings.get(name)!);
			} catch (err) {
				throw new Error(
					`scenario ${s.id}, metric ${name}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return {
			id: s.id,
			title: s.title,
			description: s.description,
			reps,
			warmups,
			failedReps: reps.length - valid.length,
			metrics,
		};
	});
	const summary: Summary = {
		schema: 1,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		args: input.args,
		fingerprint: input.fingerprint,
		perturbed: input.perturbed,
		scenarios,
	};
	if (input.extras !== undefined) summary.extras = input.extras;
	return summary;
}

/** One-line pin plan: core lists per role, or `unpinned: reason`. */
export function describePin(pin: PinPlan): string {
	if (!pin.enabled) return `unpinned: ${pin.disabledReason ?? "no reason recorded"}`;
	const sessions = pin.sessions.length > 0 ? pin.sessions.join(", ") : "none";
	return `fleet ${pin.fleet}; sessions ${sessions}; chromium ${pin.chromium}; fake model ${pin.fakeModel ?? "inside harness"}; harness ${pin.harness}`;
}

/** Escapes text for a markdown table cell. */
function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Metric name prefix used for grouping rows: the segment before the first `.`, `/` or `:`. */
function metricGroup(name: string): string {
	const idx = name.search(/[./:]/);
	return idx > 0 ? name.slice(0, idx) : name;
}

const MAX_EXTRA_ARRAY = 20;

/** JSON.stringify replacer capping arrays at MAX_EXTRA_ARRAY items with a count note. */
function truncateArrays(_key: string, value: unknown): unknown {
	if (Array.isArray(value) && value.length > MAX_EXTRA_ARRAY) {
		return [
			...value.slice(0, MAX_EXTRA_ARRAY),
			`... ${value.length - MAX_EXTRA_ARRAY} more of ${value.length} items truncated`,
		];
	}
	return value;
}

function renderAffinity(scenario: ScenarioSummary): string[] {
	const all: Array<{ rep: RepResult; rec: AffinityRecord }> = [];
	for (const rep of [...scenario.warmups, ...scenario.reps]) {
		for (const rec of rep.affinity) all.push({ rep, rec });
	}
	if (all.length === 0) return ["Affinity verification: no records."];
	const roles = new Map<string, { total: number; bad: number; repinned: number }>();
	for (const { rec } of all) {
		const stat = roles.get(rec.role) ?? { total: 0, bad: 0, repinned: 0 };
		stat.total += 1;
		if (!rec.ok) stat.bad += 1;
		if (rec.repinned) stat.repinned += 1;
		roles.set(rec.role, stat);
	}
	const lines = ["Affinity verification (all reps incl. warmups):", ""];
	for (const [role, stat] of [...roles].sort(([a], [b]) => a.localeCompare(b))) {
		const repinned = stat.repinned > 0 ? `, ${stat.repinned} needed a re-pin` : "";
		lines.push(
			`- ${role}: ${stat.bad === 0 ? "ok" : "NOT OK"} (${stat.total - stat.bad}/${stat.total} ok${repinned})`,
		);
	}
	const bad = all.filter(({ rec }) => !rec.ok);
	if (bad.length > 0) {
		lines.push("", "Reps with failed affinity:", "");
		for (const { rep, rec } of bad) {
			const label = rep.warmup ? "warmup" : `rep ${rep.rep}`;
			lines.push(
				`- ${label}: ${rec.role} pid ${rec.pid}, expected \`${rec.expected}\`, seen ${rec.seen.map((s) => `\`${s}\``).join(", ") || "none"} (${rec.threads} threads)`,
			);
		}
	}
	return lines;
}

function renderScenario(scenario: ScenarioSummary): string[] {
	const lines = [`## ${scenario.title} (\`${scenario.id}\`)`, "", scenario.description.trim(), ""];
	const names = Object.keys(scenario.metrics).sort();
	if (names.length === 0) {
		lines.push("No metrics recorded.", "");
	} else {
		lines.push(
			"| metric | unit | median | min | max | MAD | n | clock |",
			"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
		);
		let group: string | undefined;
		for (const name of names) {
			const stat = scenario.metrics[name]!;
			const g = metricGroup(name);
			if (g !== group) {
				group = g;
				lines.push(`| **${cell(g)}** | | | | | | | |`);
			}
			lines.push(
				`| ${cell(name)} | ${stat.unit} | ${formatNumber(stat.median)} | ${formatNumber(stat.min)} | ${formatNumber(stat.max)} | ${formatNumber(stat.mad)} | ${stat.n} | ${stat.clock ?? ""} |`,
			);
		}
		lines.push("");
	}
	lines.push(
		`Measured reps: ${scenario.reps.length - scenario.failedReps} valid, ${scenario.failedReps} failed (failed reps are excluded from every aggregate above); warmups: ${scenario.warmups.length}.`,
		"",
	);
	for (const rep of scenario.reps) {
		if (rep.failed !== undefined) lines.push(`- FAILED rep ${rep.rep}: ${rep.failed}`);
	}
	if (scenario.failedReps > 0) lines.push("");

	const last = scenario.reps.at(-1) ?? scenario.warmups.at(-1);
	if (last !== undefined) {
		const notes = [...new Set(last.notes)];
		if (notes.length > 0) {
			lines.push(`Notes (${last.warmup ? "warmup" : `rep ${last.rep}`}):`, "");
			for (const note of notes) lines.push(`- ${note}`);
			lines.push("");
		}
	}
	lines.push(...renderAffinity(scenario), "");
	return lines;
}

/** Harness event-loop lag above which client receive stamps are not trustworthy (see loop-lag.ts). */
export const LOOP_LAG_WARN_MS = 5;

/**
 * Harness warnings: valid measured reps whose harness event loop stalled
 * (p99 lag over LOOP_LAG_WARN_MS). Client stamps are taken on that loop, so such
 * a rep's stream latency and command RTT include harness delay.
 */
export function harnessWarnings(summary: Summary): string[] {
	const out: string[] = [];
	for (const scenario of summary.scenarios) {
		for (const rep of scenario.reps) {
			const p99 = rep.metrics["harness.loop-lag.p99"]?.value;
			if (rep.failed !== undefined || p99 === undefined || p99 <= LOOP_LAG_WARN_MS) continue;
			const max = rep.metrics["harness.loop-lag.max"]?.value ?? p99;
			out.push(
				`${scenario.id} rep ${rep.rep}: harness event-loop lag p99 ${formatNumber(p99)} ms (max ${formatNumber(max)} ms) exceeds ${LOOP_LAG_WARN_MS} ms; its stream latency and RTT include harness delay`,
			);
		}
	}
	return out;
}

/** Renders the whole summary as markdown (fingerprint, args, legend, scenarios, extras). */
export function renderSummaryMarkdown(summary: Summary): string {
	const fp = summary.fingerprint;
	const lines: string[] = [
		"# omp-web profile summary",
		"",
		`Started ${summary.startedAt}, finished ${summary.finishedAt}.`,
		"",
		"## Host fingerprint",
		"",
		`- CPU: ${fp.cpuModel}`,
		`- Logical CPUs: ${fp.logicalCpus}`,
		`- Governor: ${fp.governor}`,
		`- Pinning: ${describePin(fp.pin)}`,
		`- Bun: ${fp.bun}`,
		`- SDK (pi-coding-agent): ${fp.sdk}`,
		`- Chromium: ${fp.chromium === undefined ? "not run" : `${fp.chromium}${fp.chromiumPath === undefined ? "" : ` (${fp.chromiumPath})`}`}`,
		`- Git: ${fp.gitCommit}${fp.gitDirty ? " (dirty)" : " (clean)"}`,
		`- OS: ${fp.os}`,
		`- Transport: ${fp.transport}`,
		"",
		"## Run arguments",
		"",
		"```json",
		JSON.stringify(summary.args, null, "\t"),
		"```",
		"",
	];
	if (summary.perturbed.length > 0) {
		lines.push(
			`> **WARNING: perturbed run** (${summary.perturbed.join(", ")}). Profiling/heap instrumentation was on; timings are not comparable with unperturbed runs.`,
			"",
		);
	}
	const warnings = harnessWarnings(summary);
	if (warnings.length > 0) {
		lines.push("## Harness warnings", "", ...warnings.map((w) => `- WARNING: ${w}`), "");
	}
	lines.push(
		"## Clock sources",
		"",
		"- `clock-monotonic-ffi`: libc `clock_gettime(CLOCK_MONOTONIC)` via bun:ffi, shared across processes (fake model, fleet, harness, client).",
		"- `chromium-wall-clock`: wall-clock milliseconds from the Chromium page (`Date.now()` / `performance.timeOrigin`); differences against Bun-side stamps include wall-vs-monotonic skew.",
		"- Metrics with no clock are rates or counters.",
		"",
	);
	for (const scenario of summary.scenarios) lines.push(...renderScenario(scenario));
	if (summary.extras !== undefined) {
		for (const [key, value] of Object.entries(summary.extras)) {
			lines.push(
				`## Extra: ${key}`,
				"",
				"```json",
				JSON.stringify(value, truncateArrays, "\t") ?? "null",
				"```",
				"",
			);
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Writes `summary.json` (tab-indented) and `summary.md` into `outDir`, creating it if needed. */
export async function writeSummary(outDir: string, summary: Summary): Promise<SummaryPaths> {
	await mkdir(outDir, { recursive: true });
	const jsonPath = join(outDir, "summary.json");
	const mdPath = join(outDir, "summary.md");
	await Bun.write(jsonPath, `${JSON.stringify(summary, null, "\t")}\n`);
	await Bun.write(mdPath, renderSummaryMarkdown(summary));
	return { jsonPath, mdPath };
}

const BASELINE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Saved baselines, relative to the repo root. Inside the gitignored
 * `.profile-out/`: a baseline is only comparable on the host and pinning that
 * recorded it, so it stays local. Conclusions worth keeping go in
 * `scripts/profile/results/` as prose.
 */
export const BASELINES_DIR = ".profile-out/baselines";

/**
 * Writes `<baselinesDir>/<name>.json` and `.md`. `name` must match
 * `^[a-z0-9][a-z0-9._-]*$` (no path separators, no leading dot). Existing
 * baselines are never replaced unless `opts.overwrite` is true.
 */
export async function saveBaseline(
	summary: Summary,
	name: string,
	baselinesDir: string,
	opts: { overwrite?: boolean } = {},
): Promise<SummaryPaths> {
	if (!BASELINE_NAME.test(name)) {
		throw new Error(
			`invalid baseline name ${JSON.stringify(name)}: must match ${BASELINE_NAME.source}`,
		);
	}
	const jsonPath = join(baselinesDir, `${name}.json`);
	const mdPath = join(baselinesDir, `${name}.md`);
	if (opts.overwrite !== true) {
		for (const path of [jsonPath, mdPath]) {
			if (existsSync(path))
				throw new Error(`baseline already exists: ${path} (pass overwrite to replace it)`);
		}
	}
	await mkdir(baselinesDir, { recursive: true });
	await Bun.write(jsonPath, `${JSON.stringify(summary, null, "\t")}\n`);
	await Bun.write(mdPath, renderSummaryMarkdown(summary));
	return { jsonPath, mdPath };
}
