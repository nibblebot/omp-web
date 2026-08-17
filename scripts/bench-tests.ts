/**
 * Suite benchmark harness.
 *
 * Runs `bun test` with the same worker pinning as scripts/test.ts
 * (`--parallel=<physicalCores()>`, `--timeout 15000`, `--retry 0`) plus the
 * JUnit reporter, parses the XML, and appends one JSONL record per
 * invocation to the gitignored `.bench/history.jsonl` at the repo root.
 *
 * Subcommands:
 *   run [--runs N] [-- <bun test args...>]  bench the suite (default); N>1 stores per-run
 *                                           samples in `runs[]`, and any run with failures
 *                                           stores junit-parsed "file > test" names in `failures[]`
 *   report [--last N]                        per-file stats (mean/sd/p50/p95/CV%) across
 *                                           successful records, Welch t vs baseline, plus the
 *                                           existing Δbase/Δprev columns
 *   flakes [--last N]                        classify failed tests as broken (ALWAYS) vs flaky
 *                                           (INTERMITTENT); exit 0 always (it is a report)
 *   baseline                                 point .bench/baseline at the latest record
 *
 * No new dependencies; the JUnit scan is a small hand-rolled tag scanner.
 * Run from the repo root (like `bun run test`); extra args after the
 * subcommand are forwarded to `bun test` (mirrors scripts/test.ts).
 */
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { physicalCores } from "./test";

const repoRoot = resolve(import.meta.dir, "..");
const benchDir = join(repoRoot, ".bench");
const historyFile = join(benchDir, "history.jsonl");
const baselineFile = join(benchDir, "baseline");

export interface FileSuite {
	path: string;
	/** Sum of `<testcase time>` seconds → ms, 1 decimal. */
	ms: number;
}

export interface Counts {
	pass: number;
	fail: number;
	skip: number;
}

export interface RunSample {
	wallMs: number;
	files: Record<string, number>;
	counts: Counts;
}

export interface BenchRecord {
	ts: number;
	gitSha: string | null;
	dirty: boolean | null;
	bun: string;
	machine: { cpu: string; physical: number; logical: number; workers: number };
	wallMs: number;
	files: Record<string, number>;
	counts: Counts;
	failed: boolean;
	/** Files with >15% max/min spread across `--runs` (empty when N=1). */
	noisy: string[];
	/** v2 (--runs N>1): per-run samples; absent on v1 records. */
	runs?: RunSample[];
	/** v2: junit-parsed "file > test" names, present on any record with failures. */
	failures?: string[];
}

// --- Statistics ------------------------------------------------------------

/** Arithmetic mean; 0 for an empty input. */
export function mean(vals: number[]): number {
	if (vals.length === 0) return 0;
	let sum = 0;
	for (const v of vals) sum += v;
	return sum / vals.length;
}

/** Sample standard deviation (n-1 denominator); 0 when fewer than 2 samples. */
export function sd(vals: number[]): number {
	if (vals.length < 2) return 0;
	const m = mean(vals);
	let sum = 0;
	for (const v of vals) sum += (v - m) * (v - m);
	return Math.sqrt(sum / (vals.length - 1));
}

/**
 * Linear-interpolated percentile (R-7, like PERCENTILE.INC): sorted values,
 * index p*(n-1), interpolating between neighbors. NaN for an empty input.
 */
export function percentile(vals: number[], p: number): number {
	if (vals.length === 0) return NaN;
	const s = [...vals].sort((a, b) => a - b);
	if (s.length === 1) return s[0];
	const idx = p * (s.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return s[lo];
	return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

/**
 * Welch's t statistic comparing two samples; NaN when either side has fewer
 * than 2 values (variance undefined). |t| > 2 is the normal-approximation
 * significance threshold — adequate when each side has >= 3 samples.
 */
export function welch(a: number[], b: number[]): number {
	if (a.length < 2 || b.length < 2) return NaN;
	const na = a.length;
	const nb = b.length;
	const denom = sd(a) ** 2 / na + sd(b) ** 2 / nb;
	if (denom === 0) return NaN;
	return (mean(a) - mean(b)) / Math.sqrt(denom);
}

/**
 * Per-file ms samples across records: `runs[]` samples when the record is
 * v2, else the v1 per-file median. Callers filter failed records when the
 * stats must come from successful runs only.
 */
export function collectFileSamples(records: BenchRecord[], path: string): number[] {
	const out: number[] = [];
	for (const r of records) {
		if (r.runs && r.runs.length > 0) {
			let found = false;
			for (const run of r.runs) {
				const ms = run.files[path];
				if (ms !== undefined) {
					out.push(ms);
					found = true;
				}
			}
			if (!found && r.files[path] !== undefined) out.push(r.files[path]);
		} else if (r.files[path] !== undefined) {
			out.push(r.files[path]);
		}
	}
	return out;
}

// --- JUnit parsing ---------------------------------------------------------

/** Decode the few XML entities that can appear in attribute values. */
function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return m ? decodeXml(m[1]) : null;
}

function numAttr(tag: string, name: string): number {
	const v = attr(tag, name);
	return v === null ? 0 : Number(v) || 0;
}

/**
 * Parse bun's JUnit XML. Empirically (bun 1.3.14): the root `<testsuites>`
 * aggregates; a per-file `<testsuite name="<path>" file="<path>" tests=
 * failures= skipped= time="0">` sits at depth 1, with describe blocks nested
 * deeper; the per-file `time` attr is always "0" (bun quirk), so per-file
 * duration is the sum of its `<testcase time="<seconds>">` attrs. A testcase
 * with `<failure>`/`<error>` children is a failed test, reported as
 * "<depth-1 suite path> > <test name>". Returns empty data when the XML is
 * absent (bun writes no JUnit file when a test module fails to load).
 */
export function parseJunitXml(xml: string): {
	files: FileSuite[];
	counts: Counts;
	failures: string[];
} {
	const fileMs = new Map<string, number>();
	const fileTests = new Map<string, number>();
	const fileFailures = new Map<string, number>();
	const fileSkips = new Map<string, number>();
	const failures: string[] = [];
	const re = /<(testsuites|testsuite|testcase)\b([^>]*?)(\/?)>|<\/(testsuite|testcase)>/g;
	let depth = 0;
	let depth1Path: string | null = null;
	const openCases: { start: number; path: string; name: string }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const tagName = m[0].startsWith("</") ? m[4] : m[1];
		if (m[0].startsWith("</")) {
			if (tagName === "testsuite") {
				depth -= 1;
				if (depth === 0) depth1Path = null;
			} else if (tagName === "testcase") {
				const open = openCases.pop();
				if (
					open &&
					/<(failure|error)\b/.test(xml.slice(open.start, re.lastIndex - "</testcase>".length))
				) {
					failures.push(`${open.path} > ${open.name}`);
				}
			}
			continue;
		}
		const tag = m[2] ?? "";
		if (tagName === "testsuites") continue;
		if (tagName === "testsuite") {
			if (m[3] !== "/") depth += 1;
			if (depth === 1) {
				const path = attr(tag, "file") ?? attr(tag, "name") ?? "";
				if (path) {
					fileTests.set(path, numAttr(tag, "tests"));
					fileFailures.set(path, numAttr(tag, "failures"));
					fileSkips.set(path, numAttr(tag, "skipped"));
					depth1Path = path;
				}
			}
			continue;
		}
		const path = attr(tag, "file");
		if (path) fileMs.set(path, (fileMs.get(path) ?? 0) + numAttr(tag, "time") * 1000);
		if (m[3] !== "/") {
			openCases.push({
				start: re.lastIndex,
				path: depth1Path ?? attr(tag, "file") ?? "",
				name: attr(tag, "name") ?? "",
			});
		}
	}
	const files: FileSuite[] = [];
	const counts: Counts = { pass: 0, fail: 0, skip: 0 };
	for (const path of fileMs.keys()) {
		const tests = fileTests.get(path) ?? 0;
		const failuresCount = fileFailures.get(path) ?? 0;
		const skips = fileSkips.get(path) ?? 0;
		files.push({ path, ms: Math.round((fileMs.get(path) ?? 0) * 10) / 10 });
		counts.pass += Math.max(0, tests - failuresCount - skips);
		counts.fail += failuresCount;
		counts.skip += skips;
	}
	return { files, counts, failures };
}

// --- Machine / git info ----------------------------------------------------

function cpuModel(): string {
	try {
		for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
			const idx = line.indexOf(":");
			if (idx !== -1 && line.slice(0, idx).trim() === "model name") {
				return line.slice(idx + 1).trim();
			}
		}
	} catch {
		// Non-Linux: no /proc/cpuinfo.
	}
	return "unknown";
}

function gitInfo(): { gitSha: string | null; dirty: boolean | null } {
	try {
		const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
		if (sha.exitCode !== 0) return { gitSha: null, dirty: null };
		const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoRoot });
		return {
			gitSha: sha.stdout.toString().trim() || null,
			dirty: status.exitCode === 0 && status.stdout.toString().trim().length > 0,
		};
	} catch {
		return { gitSha: null, dirty: null };
	}
}

// --- Record history --------------------------------------------------------

function median(vals: number[]): number {
	const s = [...vals].sort((a, b) => a - b);
	const n = s.length;
	if (n === 0) return 0;
	const mid = Math.floor(n / 2);
	return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function loadHistory(): BenchRecord[] {
	const out: BenchRecord[] = [];
	try {
		for (const line of readFileSync(historyFile, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as BenchRecord);
			} catch {
				// Skip malformed lines.
			}
		}
	} catch {
		// No history yet.
	}
	return out;
}

function readBaseline(): number | null {
	try {
		const t = Number(readFileSync(baselineFile, "utf8").trim());
		return Number.isFinite(t) ? t : null;
	} catch {
		return null;
	}
}

// --- Subcommand: run -------------------------------------------------------

function parseRunArgs(args: string[]): { runs: number; forward: string[] } {
	let runs = 1;
	const forward: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--runs") {
			const v = Number(args[i + 1]);
			if (Number.isFinite(v) && v > 0) runs = Math.floor(v);
			i += 1;
		} else if (a.startsWith("--runs=")) {
			const v = Number(a.slice("--runs=".length));
			if (Number.isFinite(v) && v > 0) runs = Math.floor(v);
		} else if (a === "--") {
			forward.push(...args.slice(i + 1));
			break;
		} else {
			forward.push(a);
		}
	}
	return { runs, forward };
}

async function runBench(args: string[]): Promise<void> {
	const { runs, forward } = parseRunArgs(args);
	const workers = Math.max(1, physicalCores());
	const tmpDir = mkdtempSync(join(tmpdir(), "omp-bench-"));
	const outXml = join(tmpDir, "junit.xml");
	const perFile = new Map<string, number[]>();
	const runSamples: RunSample[] = [];
	const failureSet = new Set<string>();
	let counts: Counts = { pass: 0, fail: 0, skip: 0 };
	let exitCode = 0;
	const walls: number[] = [];
	try {
		for (let i = 0; i < runs; i++) {
			rmSync(outXml, { force: true });
			const start = Date.now();
			const child = Bun.spawn(
				[
					"bun",
					"test",
					"--reporter=junit",
					`--reporter-outfile=${outXml}`,
					`--parallel=${workers}`,
					"--timeout",
					"15000",
					"--retry",
					"0",
					...forward,
				],
				{ cwd: repoRoot, stdio: ["inherit", "inherit", "inherit"] },
			);
			const code = (await child.exited) ?? 1;
			const wallMs = Date.now() - start;
			walls.push(wallMs);
			if (i === runs - 1) exitCode = code;
			const runFiles: Record<string, number> = {};
			let runCounts: Counts = { pass: 0, fail: 0, skip: 0 };
			try {
				const parsed = parseJunitXml(readFileSync(outXml, "utf8"));
				for (const f of parsed.files) {
					const vals = perFile.get(f.path) ?? [];
					vals.push(f.ms);
					perFile.set(f.path, vals);
					runFiles[f.path] = f.ms;
				}
				runCounts = parsed.counts;
				for (const name of parsed.failures) failureSet.add(name);
				if (i === runs - 1) counts = parsed.counts;
			} catch {
				// No JUnit output (e.g. a test module failed to load); the
				// run is recorded without per-file data and flagged by the
				// exit code.
			}
			runSamples.push({ wallMs, files: runFiles, counts: runCounts });
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
	const files: Record<string, number> = {};
	const noisy: string[] = [];
	for (const [path, vals] of perFile) {
		const med = median(vals);
		files[path] = med;
		if (vals.length > 1) {
			const spread = Math.max(...vals) - Math.min(...vals);
			if (spread > med * 0.15) noisy.push(path);
		}
	}
	const git = gitInfo();
	const record: BenchRecord = {
		ts: Date.now(),
		gitSha: git.gitSha,
		dirty: git.dirty,
		bun: Bun.version,
		machine: {
			cpu: cpuModel(),
			physical: physicalCores(),
			logical: availableParallelism(),
			workers,
		},
		wallMs: Math.round(median(walls)),
		files,
		counts,
		failed: exitCode !== 0,
		noisy,
		...(runs > 1 ? { runs: runSamples } : {}),
		...(failureSet.size > 0 ? { failures: [...failureSet].sort() } : {}),
	};
	mkdirSync(benchDir, { recursive: true });
	appendFileSync(historyFile, JSON.stringify(record) + "\n");
	console.log(
		`bench: ${runs} run(s), ${counts.pass} pass / ${counts.fail} fail / ${counts.skip} skip, ` +
			`wall ${record.wallMs}ms, workers ${workers}` +
			(noisy.length ? `, noisy: ${noisy.join(", ")}` : ""),
	);
	process.exit(exitCode);
}

// --- Subcommand: report ----------------------------------------------------

function tsLabel(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDelta(v: number | null): string {
	if (v === null) return "—".padStart(9);
	const s = `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
	return s.padStart(9);
}

function fmtStat(v: number): string {
	if (!Number.isFinite(v)) return "—".padStart(9);
	return v.toFixed(1).padStart(9);
}

function fmtPct(cv: number): string {
	if (!Number.isFinite(cv)) return "—".padStart(7);
	return `${(cv * 100).toFixed(1)}%`.padStart(7);
}

/** t value, flagged with `*` when |t| > 2; `—` when not computable. */
function fmtT(v: number): string {
	if (!Number.isFinite(v)) return "—".padStart(8);
	return `${v.toFixed(2)}${Math.abs(v) > 2 ? "*" : ""}`.padStart(8);
}

function parseLast(args: string[], dflt = 10): number {
	let n = dflt;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--last") {
			const v = Number(args[i + 1]);
			if (Number.isFinite(v) && v > 0) n = Math.floor(v);
			i += 1;
		} else if (a.startsWith("--last=")) {
			const v = Number(a.slice("--last=".length));
			if (Number.isFinite(v) && v > 0) n = Math.floor(v);
		}
	}
	return n;
}

interface ReportRow {
	path: string;
	n: number;
	med: number;
	mean: number;
	sdv: number;
	p50: number;
	p95: number;
	cv: number;
	t: number;
	deltaBase: number | null;
	deltaPrev: number | null;
}

function report(lastN: number): void {
	const records = loadHistory();
	if (records.length === 0) {
		console.error("no bench records yet — run `bun run bench run` first");
		process.exit(1);
	}
	const window = records.slice(-Math.max(1, lastN));
	const ok = window.filter((r) => !r.failed);
	const baselineTs = readBaseline();
	const baseline = baselineTs === null ? null : (records.find((r) => r.ts === baselineTs) ?? null);
	const last = ok[ok.length - 1];
	const prev = ok[ok.length - 2];
	const paths = new Set<string>();
	for (const r of ok) for (const p of Object.keys(r.files)) paths.add(p);
	const rows: ReportRow[] = [];
	for (const path of paths) {
		const samples = collectFileSamples(ok, path);
		const baseSamples = baseline ? collectFileSamples([baseline], path) : [];
		const t = samples.length >= 3 && baseSamples.length >= 3 ? welch(samples, baseSamples) : NaN;
		const m = mean(samples);
		const sdv = sd(samples);
		rows.push({
			path,
			n: samples.length,
			med: median(samples),
			mean: m,
			sdv,
			p50: percentile(samples, 0.5),
			p95: percentile(samples, 0.95),
			cv: samples.length >= 2 ? sdv / m : NaN,
			t,
			deltaBase:
				baseline && baseline.files[path] != null ? median(samples) - baseline.files[path] : null,
			deltaPrev:
				last && prev && last.files[path] != null && prev.files[path] != null
					? last.files[path] - prev.files[path]
					: null,
		});
	}
	// |t| descending; rows without a computable t (—) sort last.
	rows.sort((a, b) => {
		const ta = Number.isFinite(a.t) ? Math.abs(a.t) : 0;
		const tb = Number.isFinite(b.t) ? Math.abs(b.t) : 0;
		if (ta !== tb) return tb - ta;
		return a.path.localeCompare(b.path);
	});
	const width = Math.max(4, ...rows.map((r) => r.path.length));
	console.log(
		`${"file".padEnd(width)}  ${"median".padStart(9)}  ${"Δbase".padStart(9)}  ${"Δprev".padStart(9)}  ` +
			`${"mean".padStart(9)}  ${"sd".padStart(9)}  ${"p50".padStart(9)}  ${"p95".padStart(9)}  ` +
			`${"CV%".padStart(7)}  ${"t".padStart(8)}`,
	);
	for (const r of rows) {
		console.log(
			`${r.path.padEnd(width)}  ${r.med.toFixed(1).padStart(9)}  ${fmtDelta(r.deltaBase)}  ` +
				`${fmtDelta(r.deltaPrev)}  ${fmtStat(r.mean)}  ${fmtStat(r.n >= 2 ? r.sdv : NaN)}  ${fmtStat(r.p50)}  ` +
				`${fmtStat(r.p95)}  ${fmtPct(r.cv)}  ${fmtT(r.t)}`,
		);
	}
	const failed = window.filter((r) => r.failed).length;
	console.log(
		`wall trend: ${window
			.map((r) => `${tsLabel(r.ts)} ${r.wallMs}ms${r.failed ? "(fail)" : ""}`)
			.join(" → ")}`,
	);
	console.log(`window: ${window.length} record(s), ${ok.length} ok, ${failed} failed`);
	console.log(
		"stats: mean/sd/p50/p95/CV% over successful records' samples (runs[] when present, else v1 files median); " +
			"t = Welch's t vs baseline, * = |t| > 2 (normal-approximation threshold, adequate for n ≥ 3 per side; — when n < 3 or no baseline)",
	);
	if (baseline && last && baseline.machine.cpu !== last.machine.cpu) {
		console.warn(
			`warning: CPU differs from baseline (${baseline.machine.cpu} → ${last.machine.cpu}); ` +
				"Δbase is not apples-to-apples",
		);
	}
}

// --- Subcommand: flakes ----------------------------------------------------

interface FlakeStat {
	file: string;
	fails: number;
	ran: number;
	first: number;
	last: number;
}

function flakes(lastN: number): void {
	const records = loadHistory();
	if (records.length === 0) {
		console.error("no bench records yet — run `bun run bench run` first");
		return;
	}
	const window = records.slice(-Math.max(1, lastN));
	const stats = new Map<string, FlakeStat>();
	let noNames = 0;
	for (const r of window) {
		const failures = r.failures ?? [];
		if (r.failed && failures.length === 0) noNames += 1;
		for (const name of failures) {
			const sep = name.lastIndexOf(" > ");
			const file = sep === -1 ? "" : name.slice(0, sep);
			let s = stats.get(name);
			if (!s) {
				s = { file, fails: 0, ran: 0, first: r.ts, last: r.ts };
				stats.set(name, s);
			}
			s.fails += 1;
			if (r.ts < s.first) s.first = r.ts;
			if (r.ts > s.last) s.last = r.ts;
		}
	}
	// Records that ran each failing test's file (file present, or the test
	// itself failed there) count toward the "fails / records-in-window" ratio.
	for (const [name, s] of stats) {
		for (const r of window) {
			if (r.files[s.file] !== undefined || (r.failures ?? []).includes(name)) s.ran += 1;
		}
	}
	const broken: { name: string; s: FlakeStat }[] = [];
	const flaky: { name: string; s: FlakeStat }[] = [];
	for (const [name, s] of stats) {
		// ALWAYS fails in every record that ran it → broken; otherwise flaky.
		(s.fails === s.ran ? broken : flaky).push({ name, s });
	}
	broken.sort((a, b) => a.name.localeCompare(b.name));
	flaky.sort((a, b) => a.name.localeCompare(b.name));
	const nameWidth = Math.max(4, ...[...broken, ...flaky].map((e) => e.name.length));
	const printRow = (e: { name: string; s: FlakeStat }, cls: string) => {
		console.log(
			`${e.name.padEnd(nameWidth)}  ${`${e.s.fails}/${e.s.ran}`.padStart(7)}  ` +
				`first ${tsLabel(e.s.first)}  last ${tsLabel(e.s.last)}  ${cls}`,
		);
	};
	if (broken.length === 0 && flaky.length === 0) {
		console.log("no failures in window");
	} else {
		for (const e of broken) printRow(e, "BROKEN");
		for (const e of flaky) printRow(e, "FLAKY");
	}
	if (noNames > 0) {
		console.log(`note: ${noNames} failed record(s) have no stored failure names (v1 records)`);
	}
	console.log(`${flaky.length} flaky, ${broken.length} broken in window`);
}

// --- Subcommand: baseline --------------------------------------------------

function setBaseline(): void {
	const records = loadHistory();
	if (records.length === 0) {
		console.error("no bench records yet — run `bun run bench run` first");
		process.exit(1);
	}
	const latest = records[records.length - 1];
	mkdirSync(benchDir, { recursive: true });
	writeFileSync(baselineFile, `${latest.ts}\n`);
	console.log(
		`baseline set to ${tsLabel(latest.ts)} (${Object.keys(latest.files).length} files` +
			(latest.failed ? ", failed run)" : ")"),
	);
}

// --- Entry -----------------------------------------------------------------

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	const sub = cmd ?? "run";
	if (sub === "run") {
		await runBench(rest);
	} else if (sub === "report") {
		report(parseLast(rest));
	} else if (sub === "flakes") {
		flakes(parseLast(rest, 20));
	} else if (sub === "baseline") {
		setBaseline();
	} else {
		console.error(`unknown subcommand: ${sub} (expected run | report | flakes | baseline)`);
		process.exit(1);
	}
}
