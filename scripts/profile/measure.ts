/**
 * Measurement window: CPU, RSS and per-hop traffic over one stretch of a rep.
 *
 * - CPU: cumulative utime+stime from /proc per process group (fleet, each
 *   session tree, Chromium tree) differenced between open and close.
 * - RSS: peak of the window's own 250 ms snapshots (open and close included).
 * - H1 (browser <-> fleet): frames and bytes from the synthetic client, which
 *   is authoritative for what the browser would have received.
 * - H2 (fleet <-> session callback pair): bytes only, from the fleet-side
 *   sockets' kernel counters (`ss -ti` bytes_sent/bytes_received), attributed
 *   to a session by the owning pid of the mate socket. Frames per second are
 *   not observable on H2 without touching production code, so none are
 *   reported. Connections that close inside the window lose their last bytes.
 */
import { monotonicNs } from "./clock";
import { LoopLagProbe } from "./loop-lag";
import type { DropRecord, ProfileClient } from "./client";
import {
	cpuDelta,
	type Sampler,
	type SamplerSnapshot,
	socketCounters,
	type SocketConn,
	type SocketCounters,
} from "./sampler";
import { metric, type MetricReading } from "./types";

const KIB_PER_MIB = 1024;
const MS_PER_S = 1000;

export interface TrafficClass {
	/** Session label, `harness` (the browser client and control calls), or `other`. */
	owner: string;
	toPeerBytes: number;
	fromPeerBytes: number;
	connections: number;
}

/** Owner of each non-fleet-side socket's pid, from the labelled pid sets. */
export type PidOwner = (pid: number) => string;

function mateOf(conn: SocketConn, all: SocketConn[]): SocketConn | undefined {
	return all.find(
		(c) => !c.fleetSide && c.localPort === conn.peerPort && c.peerPort === conn.localPort,
	);
}

/** Per-owner byte delta between two counter reads, seen from the fleet side. */
export function classifyTraffic(
	before: SocketCounters,
	after: SocketCounters,
	owner: PidOwner,
): Record<string, TrafficClass> {
	const prev = new Map<string, SocketConn>();
	for (const c of before.connections) if (c.fleetSide) prev.set(`${c.localPort}|${c.peerPort}`, c);
	const out: Record<string, TrafficClass> = {};
	for (const conn of after.connections) {
		if (!conn.fleetSide) continue;
		const mate = mateOf(conn, after.connections);
		const who = mate?.pid === undefined ? "other" : owner(mate.pid);
		const base = prev.get(`${conn.localPort}|${conn.peerPort}`);
		const cls = (out[who] ??= { owner: who, toPeerBytes: 0, fromPeerBytes: 0, connections: 0 });
		cls.connections++;
		cls.toPeerBytes += conn.bytesSent - (base?.bytesSent ?? 0);
		cls.fromPeerBytes += conn.bytesReceived - (base?.bytesReceived ?? 0);
	}
	return out;
}

export interface WindowSpec {
	sampler: Sampler;
	fleetPort: number;
	/** Process group labels that are session roles (`s1`..), for metric naming. */
	sessionLabels: string[];
	clients: ProfileClient[];
	owner: PidOwner;
}

interface ClientMark {
	drops: number;
	excluded: number;
	frames: number;
	frameBytes: number;
	bytesDown: number;
	bytesUp: number;
}

export class MeasureWindow {
	readonly #spec: WindowSpec;
	readonly #startNs: bigint;
	readonly #snap: SamplerSnapshot;
	readonly #counters: SocketCounters;
	readonly #marks: ClientMark[];
	readonly #peak: Record<string, number> = {};
	readonly #timer: NodeJS.Timeout;
	readonly #lag = new LoopLagProbe();

	private constructor(spec: WindowSpec, counters: SocketCounters) {
		this.#spec = spec;
		this.#counters = counters;
		this.#snap = spec.sampler.snapshot();
		this.#startNs = monotonicNs();
		this.#marks = spec.clients.map((c) => ({
			drops: c.dropLog.length,
			excluded: c.excludedDeltas,
			frames: c.frames,
			frameBytes: c.frameBytes,
			bytesDown: c.bytesDown,
			bytesUp: c.bytesUp,
		}));
		this.#lag.start();
		this.#observeRss(this.#snap);
		this.#timer = setInterval(() => this.#observeRss(spec.sampler.snapshot()), 250);
		// A rep that throws never closes its window; do not keep the process alive for it.
		this.#timer.unref();
	}

	static async open(spec: WindowSpec): Promise<MeasureWindow> {
		return new MeasureWindow(spec, await socketCounters(spec.fleetPort));
	}

	#observeRss(snap: SamplerSnapshot): void {
		for (const [label, rss] of Object.entries(snap.rssKiB)) {
			if (rss > (this.#peak[label] ?? 0)) this.#peak[label] = rss;
		}
	}

	/** Close the window; returns the metrics plus the raw per-owner traffic for notes. */
	async close(): Promise<{
		metrics: Record<string, MetricReading>;
		traffic: Record<string, TrafficClass>;
		windowMs: number;
		/** Unexpected downlink ends (edge drop-and-resume) the clients recovered from inside the window. */
		drops: DropRecord[];
	}> {
		clearInterval(this.#timer);
		const lag = this.#lag.stop();
		const end = this.#spec.sampler.snapshot();
		this.#observeRss(end);
		const endNs = monotonicNs();
		const counters = await socketCounters(this.#spec.fleetPort);
		const seconds = Number(endNs - this.#startNs) / 1e9;
		const windowMs = seconds * MS_PER_S;
		const cpu = cpuDelta(this.#snap, end);
		const metrics: Record<string, MetricReading> = {};
		metrics["window.ms"] = metric(windowMs, "ms", "info");
		// The harness's own event loop: client receive stamps are taken on this thread.
		metrics["harness.loop-lag.p50"] = metric(lag.p50, "ms", "info");
		metrics["harness.loop-lag.p99"] = metric(lag.p99, "ms", "info");
		metrics["harness.loop-lag.max"] = metric(lag.max, "ms", "info");
		metrics["harness.loop-lag.stalls"] = metric(lag.stalls, "count", "info");

		const drops: DropRecord[] = [];
		let excluded = 0;
		let frames = 0;
		let frameBytes = 0;
		let down = 0;
		let up = 0;
		this.#spec.clients.forEach((c, i) => {
			// Clients created after open (S1 opens fresh connections per attach) start from zero.
			const m = this.#marks[i] ?? {
				drops: 0,
				excluded: 0,
				frames: 0,
				frameBytes: 0,
				bytesDown: 0,
				bytesUp: 0,
			};
			drops.push(...c.dropLog.slice(m.drops));
			excluded += c.excludedDeltas - m.excluded;
			frames += c.frames - m.frames;
			frameBytes += c.frameBytes - m.frameBytes;
			down += c.bytesDown - m.bytesDown;
			up += c.bytesUp - m.bytesUp;
		});
		metrics["h1.drops"] = metric(drops.length, "count", "lower");
		metrics["h1.drops/min"] = metric((drops.length / seconds) * 60, "count", "lower");
		const recovered = drops.flatMap((d) => (d.recoveryMs === undefined ? [] : [d.recoveryMs]));
		if (recovered.length > 0) {
			Object.assign(metrics, percentileMetrics("h1.recovery", recovered));
		}
		metrics["stream.excluded-deltas"] = metric(excluded, "count", "info");
		metrics["h1.frames"] = metric(frames, "count", "info");
		metrics["h1.frames/s"] = metric(frames / seconds, "frames/s", "info");
		metrics["h1.down.bytes/s"] = metric(down / seconds, "bytes/s", "info");
		metrics["h1.up.bytes/s"] = metric(up / seconds, "bytes/s", "info");
		metrics["h1.frame-bytes/frame"] = metric(
			frames === 0 ? 0 : frameBytes / frames,
			"bytes",
			"info",
		);

		const fleetCpu = cpu["fleet"] ?? 0;
		let sessionCpu = 0;
		for (const label of this.#spec.sessionLabels) sessionCpu += cpu[label] ?? 0;
		metrics["cpu.fleet.ms"] = metric(fleetCpu, "ms", "lower");
		metrics["cpu.sessions.ms"] = metric(sessionCpu, "ms", "lower");
		for (const label of this.#spec.sessionLabels) {
			metrics[`cpu.${label}.ms`] = metric(cpu[label] ?? 0, "ms", "lower");
		}
		if (cpu["chromium"] !== undefined)
			metrics["cpu.chromium.ms"] = metric(cpu["chromium"], "ms", "info");
		metrics["cpu.fleet.pct-of-core"] = metric((fleetCpu / windowMs) * 100, "%", "lower");
		if (frames > 0) {
			const per1k = frames / 1000;
			metrics["cpu.fleet+sessions.ms/1k-h1-frames"] = metric(
				(fleetCpu + sessionCpu) / per1k,
				"ms/1k-frames",
				"lower",
			);
			metrics["cpu.fleet.ms/1k-h1-frames"] = metric(fleetCpu / per1k, "ms/1k-frames", "lower");
			metrics["cpu.sessions.ms/1k-h1-frames"] = metric(sessionCpu / per1k, "ms/1k-frames", "lower");
		}
		for (const [label, kib] of Object.entries(this.#peak)) {
			if (kib === 0) continue;
			const better = label === "chromium" ? "info" : "lower";
			metrics[`rss.${label}.peak-MiB`] = metric(kib / KIB_PER_MIB, "MiB", better);
			const endKiB = end.rssKiB[label];
			if (endKiB !== undefined && endKiB > 0) {
				metrics[`rss.${label}.end-MiB`] = metric(endKiB / KIB_PER_MIB, "MiB", "info");
			}
		}

		const traffic = classifyTraffic(this.#counters, counters, this.#spec.owner);
		let h2To = 0;
		let h2From = 0;
		for (const cls of Object.values(traffic)) {
			if (cls.owner === "harness" || cls.owner === "other") continue;
			h2To += cls.toPeerBytes;
			h2From += cls.fromPeerBytes;
		}
		if (counters.available) {
			metrics["h2.fleet-to-sessions.bytes/s"] = metric(h2To / seconds, "bytes/s", "info");
			metrics["h2.sessions-to-fleet.bytes/s"] = metric(h2From / seconds, "bytes/s", "info");
			const h2Total = h2To + h2From;
			if (frames > 0) {
				metrics["h2.bytes-per-h1-frame"] = metric(h2Total / frames, "bytes", "info");
			}
		}
		return { metrics, traffic, windowMs, drops };
	}
}

/** Nanosecond samples to p50/p95/p99 readings, named `<prefix>.p50` etc, in ms. */
export function percentileMetrics(
	prefix: string,
	samplesMs: number[],
	clock: "clock-monotonic-ffi" | "chromium-wall-clock" = "clock-monotonic-ffi",
): Record<string, MetricReading> {
	const out: Record<string, MetricReading> = {};
	if (samplesMs.length === 0) return out;
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const rank = (p: number): number =>
		sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
	out[`${prefix}.p50`] = metric(rank(50), "ms", "lower", clock);
	out[`${prefix}.p95`] = metric(rank(95), "ms", "lower", clock);
	out[`${prefix}.p99`] = metric(rank(99), "ms", "lower", clock);
	out[`${prefix}.n`] = metric(sorted.length, "count", "info");
	return out;
}
