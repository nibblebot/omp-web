/**
 * CPU profiling of the fleet and session daemons via Bun's own profiler, and
 * the bucketing of the resulting `.cpuprofile` files.
 *
 * PERTURBATION: profiling perturbs timings. Bun's `--cpu-prof` runs a sampling
 * thread that suspends the main thread every interval to read its stack, and
 * writes the profile at exit. Measured on Bun 1.4.2 (200k-char stream through
 * fleet + one session, 2-3 reps per mode, process CPU over the turn): session
 * 650/710 ms unprofiled, 690/690 ms at the 1 ms default interval, 690-720 ms at
 * `--cpu-prof-interval 100`; fleet 190/210 vs 210/220 vs 210-230 ms; turn wall
 * time identical (2.59 s, paced by the fake model). So roughly +0-5% CPU at
 * 100 us, inside the noise at 1 ms. Latency numbers from a profiled run MUST be
 * labelled as profiled and are not comparable to unprofiled runs; the profile
 * is for attribution (where does JS time go), not for the latency comparison.
 *
 * COVERAGE: only time the JS VM is executing is sampled. In that turn the
 * fleet burned 210 ms of CPU but only ~12 ms was sampled (100 us interval),
 * the session 690 ms vs ~210 ms sampled: native event-loop work (socket
 * syscalls, HTTP parsing, other threads) is invisible, so percentages are
 * shares of sampled JS-visible time, not of process CPU. A 1 ms interval gave
 * only 15 fleet samples in a 2.5 s window; use `intervalUs: 100` for the fleet.
 *
 * WHEN THE FILE IS WRITTEN (verified on Bun 1.4.2, fleet launched as
 * `bun <flags> apps/fleet/cli.ts control` and session daemons through the
 * spawn template):
 * - `POST /ctl/stop {selector}` on a session: written (the daemon exits via
 *   its normal shutdown path), process gone ~44 ms later (28 ms unprofiled).
 * - SIGTERM on a session or on the fleet: written; the fleet exits in ~5 ms
 *   with or without the profiler. Sessions outlive a SIGTERMed fleet by design.
 * - SIGKILL: NOT written. Never SIGKILL a process before its profile exists.
 * So the order that yields every file is the one `Stack.stop()` already uses:
 * stop each session through `/ctl/stop`, then SIGTERM the fleet.
 * The file covers the whole process lifetime (startup included), not a rep:
 * pass a `window` (epoch ms) to bucket only one rep's samples.
 *
 * FILE FORMAT (derived by reading real profiles of this stack): the Chrome
 * `.cpuprofile` shape `{ nodes, startTime, endTime, samples, timeDeltas }`.
 * - `startTime` / `endTime` are wall-clock epoch MICROseconds (1.79e15 for
 *   2026-10), so sample timestamps are comparable to `Date.now()` of the
 *   harness. `timeDeltas[i]` is the time since sample i-1 (since `startTime`
 *   for i = 0).
 * - Bun/JSC only records a sample while the VM is executing, never while the
 *   event loop is parked. The profile therefore contains NO `(idle)`,
 *   `(program)` or `(garbage collector)` nodes (only `(root)` and `(module)`),
 *   and idle shows up as very large `timeDeltas` between bursts of samples.
 *   A blocking native call is still sampled every interval (a 300 ms
 *   `spawnSync` produced ~280 samples), so a large gap means idle, not a long
 *   call. Self time of sample i is therefore the following delta
 *   `timeDeltas[i + 1]` (Chrome's convention) when it is at most
 *   `5 * sampling period`, otherwise ONE sampling period (an isolated sample
 *   after a parked stretch stands for one interval of work); the remainder of
 *   such a gap is booked to the `idle` bucket. The sampling period is the 10th percentile
 *   of the deltas (about 0.94-1.04 ms at the 1 ms default, ~0.15 ms at 100 us).
 *   GC work done on the main thread is not distinguishable in these profiles,
 *   so `gc` stays 0 unless a producer emits `(garbage collector)` nodes (V8).
 * - Native (builtin) frames have `url === ""` and `lineNumber === -1`, and
 *   carry only the bare function name: JSON.stringify is `stringify`,
 *   JSON.parse is `parse`, TextEncoder.encode is `encode`, TextDecoder.decode
 *   is `decode`, ReadableStreamDefaultController.enqueue is `enqueue`,
 *   writer/socket writes are `write` / `writeBuffered`, and Bun's
 *   stream-to-sink machinery is `onReadStreamIntoSinkChunk`,
 *   `onRSDefaultControllerPullFulfilled`, `onWSSinkWriteFulfilled`,
 *   `onNativePullFulfilled`, `boundReadStreamIntoSinkOnReady` (the session's
 *   NDJSON up-POST body alone was 723 of 3000 samples in a streaming turn).
 *   JS frames carry a `file://` url and a 0-based lineNumber.
 * - Bare `parse` / `stringify` are ambiguous (YAML, TOML, URL, Date natives
 *   have the same names); they are booked to `json-stringify-parse` unless the
 *   calling frame's name says otherwise (`parseYamlRecord` ...), which is a
 *   heuristic and may mislabel rare callers.
 */
import { basename } from "node:path";

/** Bucket ids, in report order. `idle` is excluded from the percentage base. */
export const BUCKET_NAMES = [
	"json-stringify-parse",
	"sse-ndjson-encode",
	"stream-enqueue-write",
	"other",
	"gc",
	"idle",
] as const;

export type BucketName = (typeof BUCKET_NAMES)[number];

export interface BucketStat {
	ms: number;
	/**
	 * Share of `totalMs` (active, non-idle self time) in percent. For `idle`
	 * it is the share of the whole wall window instead, so the active buckets
	 * sum to 100 and `idle` reads as "how parked was the process".
	 */
	pct: number;
}

export interface TopFunction {
	/** Function name (`(anonymous)` when the frame has none). */
	fn: string;
	/** `path:line` (1-based) of a JS frame, `[native]` for builtins. */
	url: string;
	/** Self time in ms. */
	ms: number;
}

export interface BucketedProfile {
	/** Active self time in ms: every bucket except `idle`. The percentage base. */
	totalMs: number;
	buckets: Record<BucketName, BucketStat>;
	/** Top 15 functions by self time (idle excluded). */
	top: TopFunction[];
	/** Samples considered (inside the window). */
	samples: number;
	/** Wall time covered by the considered samples (active + idle), ms. */
	windowMs: number;
	/** Sampling period inferred from the deltas, microseconds. */
	periodUs: number;
}

export interface BucketOptions {
	/** Only count samples whose timestamp lies in [fromEpochMs, toEpochMs] (`Date.now()` clock). */
	window?: { fromEpochMs: number; toEpochMs: number };
}

const TOP_N = 15;
/** Gaps longer than this many sampling periods are idle, not work. */
const IDLE_GAP_PERIODS = 5;

/**
 * `bun` argv fragment that makes a process write `<dir>/<label>.cpuprofile`
 * on exit. `dir` must be absolute, exist, and (because session templates are
 * joined into a shell command) contain no whitespace or shell metacharacters.
 * `intervalUs` is Bun's `--cpu-prof-interval` (default 1000).
 */
export function profileFlags(dir: string, label: string, intervalUs?: number): string[] {
	const safe = /^[\w@%+=:,./-]+$/;
	if (!safe.test(dir) || !safe.test(label)) {
		throw new Error(`profile dir/label must be shell-safe (got dir=${dir} label=${label})`);
	}
	return [
		"--cpu-prof",
		"--cpu-prof-dir",
		dir,
		"--cpu-prof-name",
		`${label}.cpuprofile`,
		...(intervalUs === undefined ? [] : ["--cpu-prof-interval", String(intervalUs)]),
	];
}

/** Path `profileFlags(dir, label)` makes the process write. */
export function profilePath(dir: string, label: string): string {
	return `${dir.replace(/\/$/, "")}/${label}.cpuprofile`;
}

interface CallFrame {
	functionName: string;
	url: string;
	lineNumber: number;
}

interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	children: number[];
}

interface RawProfile {
	nodes: ProfileNode[];
	startTime: number;
	samples: number[];
	timeDeltas: number[];
}

function isCallFrame(v: unknown): v is CallFrame {
	return (
		typeof v === "object" &&
		v !== null &&
		"functionName" in v &&
		typeof v.functionName === "string" &&
		"url" in v &&
		typeof v.url === "string" &&
		"lineNumber" in v &&
		typeof v.lineNumber === "number"
	);
}

function isNode(v: unknown): v is ProfileNode {
	return (
		typeof v === "object" &&
		v !== null &&
		"id" in v &&
		typeof v.id === "number" &&
		"callFrame" in v &&
		isCallFrame(v.callFrame) &&
		(!("children" in v) || v.children === undefined || Array.isArray(v.children))
	);
}

function parseProfile(raw: unknown, path: string): RawProfile {
	if (
		typeof raw !== "object" ||
		raw === null ||
		!("nodes" in raw) ||
		!Array.isArray(raw.nodes) ||
		!("samples" in raw) ||
		!Array.isArray(raw.samples) ||
		!("timeDeltas" in raw) ||
		!Array.isArray(raw.timeDeltas) ||
		!("startTime" in raw) ||
		typeof raw.startTime !== "number"
	) {
		throw new Error(`${path}: not a .cpuprofile (need nodes, samples, timeDeltas, startTime)`);
	}
	const nodes: ProfileNode[] = [];
	for (const n of raw.nodes) {
		if (!isNode(n)) throw new Error(`${path}: malformed profile node`);
		nodes.push({ id: n.id, callFrame: n.callFrame, children: n.children ?? [] });
	}
	return { nodes, startTime: raw.startTime, samples: raw.samples, timeDeltas: raw.timeDeltas };
}

/** JSON natives (url `""`). Matched on the bare builtin name; see the file doc. */
const JSON_NATIVE = /^(stringify|parse|json|JSON\.stringify|JSON\.parse)$/;
/** Callers that make a bare `parse`/`stringify` a YAML/TOML/URL/Date/path call instead of JSON. */
const NOT_JSON_CALLER = /yaml|toml|json5|jsonc|\burl\b|date|semver|path/i;
/** TextEncoder.encode / encodeInto / TextDecoder.decode builtins. */
const ENCODE_NATIVE = /^(encode|encodeInto|decode)$/;
/** Stream/sink/socket builtins: controller.enqueue, writer.write, Bun's stream-to-sink callbacks. */
const STREAM_NATIVE =
	/^(enqueue|write|writev|writeBuffered|pull|onReadStream\w*|onRSDefaultController\w*|onWSSink\w*|onNative\w*|boundReadStreamIntoSink\w*)$/;

/**
 * Repo functions classified by name and file (the url is matched as a suffix
 * so `file://` and worktree location do not matter). Derived from the encode
 * / enqueue call sites: lib/wire/sse.ts and lib/wire/callback-protocol.ts
 * build the SSE and NDJSON text; edge.ts `#enqueue`, daemon-transport.ts
 * `#writeDown` and fleet-callback.ts `#pump` are the controller.enqueue
 * loops (fleet-callback.ts `#enqueue` is the pending queue and is NOT one).
 * pi-utils json.ts `stringifyJson` is the session persistence stringify.
 */
const JS_RULES: Array<{ bucket: BucketName; url: RegExp; fn: RegExp }> = [
	{
		bucket: "sse-ndjson-encode",
		url: /lib\/wire\/(sse|callback-protocol)\.ts$/,
		fn: /^(encodeSseEvent|encodeSseEventData|encodeSseEnvelope|encodeNdjsonLine)$/,
	},
	{ bucket: "stream-enqueue-write", url: /apps\/fleet\/edge\.ts$/, fn: /^#enqueue$/ },
	{ bucket: "stream-enqueue-write", url: /apps\/fleet\/daemon-transport\.ts$/, fn: /^#writeDown$/ },
	{ bucket: "stream-enqueue-write", url: /apps\/session\/fleet-callback\.ts$/, fn: /^#pump$/ },
	{ bucket: "json-stringify-parse", url: /pi-utils\/src\/json\.ts$/, fn: /^stringifyJson$/ },
];

function isNative(frame: CallFrame): boolean {
	return frame.url === "" || frame.url === "[native code]";
}

function classify(frame: CallFrame, callerName: string): BucketName {
	const name = frame.functionName;
	if (name === "(garbage collector)") return "gc";
	if (name === "(idle)") return "idle";
	if (isNative(frame)) {
		if (JSON_NATIVE.test(name)) {
			const ambiguous = name === "parse" || name === "stringify";
			return ambiguous && NOT_JSON_CALLER.test(callerName) ? "other" : "json-stringify-parse";
		}
		if (ENCODE_NATIVE.test(name)) return "sse-ndjson-encode";
		if (STREAM_NATIVE.test(name)) return "stream-enqueue-write";
		return "other";
	}
	for (const rule of JS_RULES) {
		if (rule.fn.test(name) && rule.url.test(frame.url)) return rule.bucket;
	}
	return "other";
}

function displayUrl(frame: CallFrame): string {
	if (isNative(frame)) return "[native]";
	const path = frame.url.replace(/^file:\/\//, "");
	return frame.lineNumber >= 0 ? `${path}:${frame.lineNumber + 1}` : path;
}

/** The p10 of the positive deltas: the sampling cadence during a busy stretch. */
function samplingPeriodUs(deltas: number[]): number {
	const positive = Float64Array.from(deltas.filter((d) => d > 0));
	if (positive.length === 0) return 1000;
	positive.sort();
	return positive[Math.floor(positive.length * 0.1)] ?? 1000;
}

/** Bucket the self time of one `.cpuprofile` (see the file doc for the derivation). Profiling perturbs timings. */
export async function bucketCpuProfile(
	path: string,
	opts: BucketOptions = {},
): Promise<BucketedProfile> {
	const profile = parseProfile(await Bun.file(path).json(), path);
	const nodeById = new Map<number, ProfileNode>();
	const parentOf = new Map<number, number>();
	for (const node of profile.nodes) {
		nodeById.set(node.id, node);
		for (const child of node.children) parentOf.set(child, node.id);
	}
	const periodUs = samplingPeriodUs(profile.timeDeltas);
	const capUs = periodUs * IDLE_GAP_PERIODS;
	const ms: Record<BucketName, number> = {
		"json-stringify-parse": 0,
		"sse-ndjson-encode": 0,
		"stream-enqueue-write": 0,
		other: 0,
		gc: 0,
		idle: 0,
	};
	const selfByFrame = new Map<string, TopFunction>();
	const { samples, timeDeltas } = profile;
	const window = opts.window;
	let windowUs = 0;
	let counted = 0;
	let tUs = profile.startTime;
	for (let i = 0; i < samples.length; i++) {
		tUs += timeDeltas[i] ?? 0;
		if (
			window !== undefined &&
			(tUs < window.fromEpochMs * 1000 || tUs > window.toEpochMs * 1000)
		) {
			continue;
		}
		const node = nodeById.get(samples[i] ?? -1);
		if (node === undefined) continue;
		counted++;
		const gapUs = i + 1 < samples.length ? (timeDeltas[i + 1] ?? periodUs) : periodUs;
		const selfUs = gapUs <= capUs ? gapUs : periodUs;
		windowUs += gapUs;
		ms.idle += (gapUs - selfUs) / 1000;
		const parent = nodeById.get(parentOf.get(node.id) ?? -1);
		const bucket = classify(node.callFrame, parent?.callFrame.functionName ?? "");
		if (bucket === "idle") {
			ms.idle += selfUs / 1000;
			continue;
		}
		ms[bucket] += selfUs / 1000;
		const frame = node.callFrame;
		const key = `${frame.functionName}|${frame.url}|${frame.lineNumber}`;
		const entry = selfByFrame.get(key);
		if (entry === undefined) {
			selfByFrame.set(key, {
				fn: frame.functionName === "" ? "(anonymous)" : frame.functionName,
				url: displayUrl(frame),
				ms: selfUs / 1000,
			});
		} else {
			entry.ms += selfUs / 1000;
		}
	}
	const totalMs =
		ms["json-stringify-parse"] +
		ms["sse-ndjson-encode"] +
		ms["stream-enqueue-write"] +
		ms.other +
		ms.gc;
	const windowMs = windowUs / 1000;
	const buckets = {} as Record<BucketName, BucketStat>;
	for (const name of BUCKET_NAMES) {
		const base = name === "idle" ? windowMs : totalMs;
		buckets[name] = { ms: ms[name], pct: base > 0 ? (ms[name] / base) * 100 : 0 };
	}
	const top = [...selfByFrame.values()].sort((a, b) => b.ms - a.ms).slice(0, TOP_N);
	return { totalMs, buckets, top, samples: counted, windowMs, periodUs };
}

/**
 * Bucket several profiles (one per process). Keys are the file names without
 * the `.cpuprofile` extension, i.e. the `label` given to `profileFlags`.
 */
export async function bucketCpuProfiles(
	paths: string[],
	opts: BucketOptions = {},
): Promise<Record<string, BucketedProfile>> {
	const entries = await Promise.all(
		paths.map(
			async (path) => [basename(path, ".cpuprofile"), await bucketCpuProfile(path, opts)] as const,
		),
	);
	return Object.fromEntries(entries);
}

/** Plain-text bucket table and top list of one process, for logs and the smoke driver. */
export function formatBucketedProfile(label: string, profile: BucketedProfile): string {
	const lines = [
		`${label}: active ${profile.totalMs.toFixed(1)} ms over ${profile.samples} samples (window ${profile.windowMs.toFixed(0)} ms, period ${profile.periodUs.toFixed(0)} us)`,
	];
	for (const name of BUCKET_NAMES) {
		const b = profile.buckets[name];
		lines.push(
			`  ${name.padEnd(22)} ${b.ms.toFixed(1).padStart(9)} ms ${b.pct.toFixed(1).padStart(6)} %`,
		);
	}
	lines.push("  top self time:");
	for (const t of profile.top) {
		lines.push(`    ${t.ms.toFixed(1).padStart(8)} ms  ${t.fn}  ${t.url}`);
	}
	return lines.join("\n");
}
