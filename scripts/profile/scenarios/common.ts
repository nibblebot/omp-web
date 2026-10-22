/** Helpers shared by scenario modules. */
import type { DropRecord, ProfileClient, TypeCount } from "../client";
import { percentileMetrics } from "../measure";
import { metric, type MetricReading } from "../types";
import { nsToMsList, type RunEnv } from "./env";

/** Stream latency (model write -> client receive) metrics for the client's recorded deltas. */
export async function streamMetrics(
	env: RunEnv,
	client: ProfileClient,
	notes: string[],
): Promise<Record<string, MetricReading>> {
	const joined = await env.joinStream(client);
	notes.push(
		`stream latency: ${joined.ns.length} deltas matched, ${joined.unmatched} received without a send line, ` +
			`${joined.sendOnly} sent but not received as their own frame (coalesced chunks, tool or subagent output)`,
	);
	notes.push(
		"stream latency has a ~20 ms tail by construction: the SDK agent loop sleeps 20 ms (yieldIfDue in pi-agent-core, at most once per 50 ms of streaming) and every delta that arrives meanwhile is released together, so p95/p99 sit near 20 ms regardless of transport; p50 and the share of deltas under 1 ms are what the transport can move",
	);
	const out = percentileMetrics("stream.latency", nsToMsList(joined.ns));
	out["stream.unmatched"] = metric(joined.unmatched, "count", "info");
	return out;
}

/**
 * Notes on the browser-socket drops a window saw: what preceded each close, how much of
 * the priming burst had arrived, and how long recovery took. The recovery time
 * excludes the backoff delay the web client would wait before redialing.
 */
export function dropNotes(drops: DropRecord[], notes: string[]): void {
	if (drops.length === 0) return;
	const shown = drops.slice(0, 3).map((d) => {
		const mib = (d.bytesSinceAttached / (1024 * 1024)).toFixed(2);
		const recovery =
			d.recoveryMs === undefined
				? "not recovered"
				: `recovered in ${d.recoveryMs.toFixed(0)} ms (${d.attempts} attempt${d.attempts === 1 ? "" : "s"})`;
		return `[${d.how}${d.close === undefined ? "" : ` ${d.close}`}] after ${mib} MiB / ${d.framesSinceAttached} frames since the last attached; last frames: ${d.lastTypes.join(", ")}; ${recovery}`;
	});
	notes.push(
		`${drops.length} unexpected socket close(s) (edge 4503 drop-and-resume or reset) recovered like the web client (redial with \`after\`, re-attach); latency samples of the in-flight message after each are excluded. ${shown.join(" | ")}${drops.length > 3 ? " | ..." : ""}`,
	);
}

/** Command round-trip samples (command send -> `call_result` frame) as p50/p95/p99 plus failures. */
export function rttMetrics(
	prefix: string,
	rttMs: number[],
	failures: number,
): Record<string, MetricReading> {
	const out = percentileMetrics(prefix, rttMs);
	out[`${prefix}.failures`] = metric(failures, "count", "info");
	return out;
}

/**
 * Ring-miss resyncs the stream suffered inside the window: the session drops
 * the stream (`stream_reset`) and the edge re-primes it with the whole history.
 * Large tool output overflows the per-stream replay ring, so this is part of
 * the transport's steady-state cost, reported rather than hidden.
 */
export function resyncMetrics(
	byType: Record<string, TypeCount>,
	notes: string[],
): Record<string, MetricReading> {
	const resets = byType["stream_reset"]?.frames ?? 0;
	const history = byType["history"];
	if (resets > 0) {
		notes.push(
			`${resets} stream_reset resync(s) in the window; each re-primed ${history === undefined ? 0 : Math.round(history.bytes / resets)} history bytes on average`,
		);
	}
	return {
		"resync.stream-resets": metric(resets, "count", "lower"),
		"resync.history.bytes": metric(history?.bytes ?? 0, "bytes", "lower"),
	};
}

/** One line per frame type for the md notes: `type n frames, b bytes`. */
export function frameBreakdown(byType: Record<string, TypeCount>, top = 8): string {
	const rows = Object.entries(byType)
		.sort((a, b) => b[1].bytes - a[1].bytes)
		.slice(0, top)
		.map(([type, c]) => `${type}: ${c.frames} frames / ${c.bytes} B`);
	return `H1 frames by type (largest by bytes): ${rows.join("; ")}`;
}

/** Idle-session command RTT: `count` sequential calls of a read-only method. */
export async function idleRtt(
	client: ProfileClient,
	count: number,
): Promise<{ rttMs: number[]; failures: number }> {
	const rttMs: number[] = [];
	let failures = 0;
	for (let i = 0; i < count; i++) {
		try {
			const res = await client.call("getQueuedMessages");
			if (res.ok) rttMs.push(res.rttMs);
			else failures++;
		} catch {
			failures++;
		}
	}
	return { rttMs, failures };
}

/** Median of a list (ms), 0 when empty. */
export function medianOf(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Reconnect timings as metrics under `reconnect.*`. */
export function reconnectMetrics(t: {
	openMs: number;
	firstFrameMs: number;
	resumeMs: number;
	reattachPrimedMs: number;
	replayFrames: number;
}): Record<string, MetricReading> {
	return {
		"reconnect.open.ms": metric(t.openMs, "ms", "lower", "clock-monotonic-ffi"),
		"reconnect.first-frame.ms": metric(t.firstFrameMs, "ms", "lower", "clock-monotonic-ffi"),
		"reconnect.resume.ms": metric(t.resumeMs, "ms", "lower", "clock-monotonic-ffi"),
		"reconnect.reattach-primed.ms": metric(
			t.reattachPrimedMs,
			"ms",
			"lower",
			"clock-monotonic-ffi",
		),
		"reconnect.frames": metric(t.replayFrames, "count", "info"),
	};
}

/** Replace the attached session with a new empty one (every stream resyncs its history). */
export async function freshSession(client: ProfileClient): Promise<void> {
	const res = await client.call("newSession", [], 60_000);
	if (!res.ok) throw new Error(`newSession failed: ${res.error ?? "unknown error"}`);
}

/** The tool-heavy turn shape shared by s3-tools and combined's s3 session. */
export const TOOL_CALLS_PER_TURN = 6;
export const TOOL_OUTPUT_BYTES = 40_000;
/**
 * Tool results pile up in the session's history. Past about 4 MiB an attach or re-prime is
 * dropped by the edge (measured on the previous SSE transport; re-measure on /ws), and past about 8 MiB re-attaching never completes (see s1-history-large),
 * so the session is replaced (`newSession`) before its history reaches this many bytes of tool output.
 */
export const TOOL_HISTORY_BUDGET_BYTES = 3 * 1024 * 1024;
export const TOOL_TURNS_PER_SESSION = Math.max(
	1,
	Math.floor(TOOL_HISTORY_BUDGET_BYTES / (TOOL_CALLS_PER_TURN * TOOL_OUTPUT_BYTES)),
);
