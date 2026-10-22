/**
 * Shared contracts of the profiling harness (`bun run profile`). Integration
 * owner: runner/index.ts. Everything that crosses a module boundary lives here;
 * summaries are plain JSON (no bigint), clocks are labeled where they matter.
 */

// ---------------------------------------------------------------------------
// Clocks, metrics
// ---------------------------------------------------------------------------

/**
 * Where a timestamp came from. Bun processes stamp `monotonicNs()` from
 * ./clock.ts (libc clock_gettime(CLOCK_MONOTONIC) through bun:ffi: one host
 * timeline for every process; Bun's own `process.hrtime`/`Bun.nanoseconds`
 * are process-start relative and NOT comparable across processes). Chromium
 * pages stamp wall-clock `Date.now()`-derived milliseconds.
 */
export type ClockSource = "clock-monotonic-ffi" | "chromium-wall-clock";

export type MetricUnit =
	| "ms"
	| "count"
	| "frames/s"
	| "bytes/s"
	| "bytes"
	| "ms/1k-frames"
	| "MiB"
	| "ratio"
	| "%";

/** `lower`/`higher` is the improving direction; `info` is never compared as better/worse. */
export type Better = "lower" | "higher" | "info";

/** One metric value of one rep, self-describing so summaries need no registry. */
export interface MetricReading {
	value: number;
	unit: MetricUnit;
	better: Better;
	/** Clock behind a latency metric; omitted for rates/counters. */
	clock?: ClockSource;
}

export function metric(
	value: number,
	unit: MetricUnit,
	better: Better,
	clock?: ClockSource,
): MetricReading {
	return clock === undefined ? { value, unit, better } : { value, unit, better, clock };
}

// ---------------------------------------------------------------------------
// Pinning, fingerprint
// ---------------------------------------------------------------------------

/** CPU lists (taskset syntax, e.g. "2" or "16-31") per role. */
export interface PinPlan {
	enabled: boolean;
	/** Why pinning is off, when it is. */
	disabledReason?: string;
	fleet: string;
	/** Session i (0-based) runs on sessions[i]. */
	sessions: string[];
	chromium: string;
	/** Fake model process. Absent in summaries written before it got its own process (it then shared `harness`). */
	fakeModel?: string;
	/** Harness process: synthetic client, sampler, runner. */
	harness: string;
}

/** Affinity of every thread of one process role, read from /proc at one moment. */
export interface AffinityRecord {
	role: string;
	pid: number;
	/** Expected taskset list. */
	expected: string;
	threads: number;
	/** Distinct Cpus_allowed_list values seen across threads. */
	seen: string[];
	/** True when every thread's list equals `expected` (after normalisation). */
	ok: boolean;
	/** True when a re-pin was needed to make it ok. */
	repinned: boolean;
}

export interface HostFingerprint {
	cpuModel: string;
	logicalCpus: number;
	governor: string;
	pin: PinPlan;
	bun: string;
	/** @oh-my-pi/pi-coding-agent version (the pinned SDK). */
	sdk: string;
	/** Chromium name + version when a browser pass ran, else undefined. */
	chromium?: string;
	/** Which Chromium binary the browser pass drove. */
	chromiumPath?: string;
	gitCommit: string;
	gitDirty: boolean;
	os: string;
	/** Transport adapters measured in this run. */
	transport: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One measured (or warmup) repetition of one scenario. */
export interface RepResult {
	scenarioId: string;
	/** 0 = warmup, 1.. = measured reps. */
	rep: number;
	warmup: boolean;
	durationMs: number;
	metrics: Record<string, MetricReading>;
	/** Free-form facts (method caveats, per-hop byte totals) the md renders. */
	notes: string[];
	/** Affinity verification taken before the rep. */
	affinity: AffinityRecord[];
	/**
	 * Why the rep is invalid (for example the edge dropped an attach on a
	 * fixture that must not drop). A failed rep is listed and counted but
	 * excluded from every metric aggregate.
	 */
	failed?: string;
}

/** Aggregate of one metric across measured reps. */
export interface MetricStat {
	unit: MetricUnit;
	better: Better;
	clock?: ClockSource;
	n: number;
	median: number;
	min: number;
	max: number;
	/** Median absolute deviation (unscaled) across reps. */
	mad: number;
	values: number[];
}

export interface ScenarioSummary {
	id: string;
	title: string;
	/** What the scenario does and which side observes what (rendered in md). */
	description: string;
	/** Measured reps, failed ones included (see `RepResult.failed`). */
	reps: RepResult[];
	warmups: RepResult[];
	/** Measured reps excluded from `metrics` because they failed. */
	failedReps: number;
	/** Aggregates over the valid measured reps only. */
	metrics: Record<string, MetricStat>;
}

export interface Summary {
	schema: 1;
	startedAt: string;
	finishedAt: string;
	/** The CLI flags the run used. */
	args: Record<string, unknown>;
	fingerprint: HostFingerprint;
	/** Set when the cpuprofile/heap perturbation flags were on; timings are not comparable then. */
	perturbed: string[];
	scenarios: ScenarioSummary[];
	/** Extra artifacts (cpuprofile bucket tables, heap reports) keyed by name; rendered in md. */
	extras?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport adapter (browser <-> fleet, H1)
// ---------------------------------------------------------------------------

/** One decoded server frame with receive-side facts. */
export interface ReceivedFrame {
	/** Parsed JSON frame (`{ type: string, ... }`). */
	frame: { type: string; [key: string]: unknown };
	/** `monotonicNs()` (./clock) when the message carrying the frame arrived. */
	recvNs: bigint;
	/** Wire bytes of this frame as received: the UTF-8 length of its socket message (envelope included, WebSocket framing not). */
	bytes: number;
	/** Browser-socket `seq` of the frame; absent for an unsequenced frame. */
	seq?: number;
}

export interface TransportOpen {
	/** Fleet origin, e.g. `http://127.0.0.1:4722` (dialed as `ws://` on `/ws`). */
	baseUrl: string;
	/** Browser client id (`client=` query parameter). */
	clientId: string;
	/** Last seq the previous connection received (`after=` query parameter); omitted = fresh priming. */
	after?: number;
}

export interface TransportConnection {
	/** Cumulative message bytes received / sent on this connection (pings and acks included, WebSocket framing not). */
	readonly bytesDown: number;
	readonly bytesUp: number;
	/** Last frame seq seen (starts at the `after` the connection was opened with); feed to the next `open({ after })`, as the web client does. */
	readonly lastSeq: number | undefined;
	/** Once the socket closed: `<code> <reason>` of the close, for diagnostics; undefined while open. */
	readonly closeInfo: string | undefined;
	/**
	 * Resolves when the socket closes: `dropped` = this side dropped it, `error` = abnormal close (1006)
	 * or a protocol violation, `closed` = the server's close frame (4503 slow consumer is a drop-and-resume).
	 */
	readonly ended: Promise<"closed" | "dropped" | "error">;
	onFrame(cb: (received: ReceivedFrame) => void): void;
	/** Uplink: resolves when the server acks the command (`{"ack":id}`); rejects on a nack or a close before the ack. */
	send(command: Record<string, unknown>): Promise<void>;
	/** Terminate the socket without a close handshake (network loss); the server keeps its resume state. */
	drop(): void;
	close(): Promise<void>;
}

export interface TransportAdapter {
	/** Label recorded in the fingerprint and summary (`ws`). */
	readonly name: string;
	/** Dials the browser socket and resolves once it is open (the upgrade succeeded). */
	open(opts: TransportOpen): Promise<TransportConnection>;
}

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface RunOptions {
	quick: boolean;
	browser: boolean;
	heap: boolean;
	cpuprofile: boolean;
	/** Scenario ids to run; empty = all. */
	scenarios: string[];
	warmups: number;
	reps: number;
	/** Per-rep measured window; quick overrides. */
	durationMs: number;
	compare?: string;
	saveBaseline?: string;
	/** Replace an existing `saveBaseline` (`--overwrite-baseline`). */
	overwriteBaseline?: true;
	/** Run only the liveness check. */
	liveness: boolean;
	/** Out dir of this run (`.profile-out/run-<ts>`). */
	outDir: string;
	noPin: boolean;
	/** Test hook for the deliberately-broken liveness demonstration (fake model URL replaced). */
	breakFakeModel: boolean;
	chromiumPath?: string;
}
