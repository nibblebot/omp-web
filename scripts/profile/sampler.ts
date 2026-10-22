/**
 * Process CPU/RSS sampler and TCP byte counters for the profiling harness.
 *
 * Sampling cost: one `readFileSync` of `/proc/<pid>/stat` per pid per tick
 * plus whatever the target's `pids()` does (a `descendantPids` scan reads one
 * stat file per process on the host, a few hundred at most). At the default
 * 250 ms interval that is well under 1 ms of CPU per tick, so the sampler does
 * not perturb the measured pinned CPUs (it runs in the harness process).
 */
import { monotonicNs } from "./clock";
import { readProcStat } from "./proc";

export interface SamplerTarget {
	label: string;
	/** Resolved at every tick so process trees that change shape are followed. */
	pids(): number[];
}

export interface SamplerSnapshot {
	/** `monotonicNs()` (CLOCK_MONOTONIC) at the moment of the read. */
	tNs: bigint;
	/** Cumulative (utime + stime) ms per label, monotonic across pid churn. */
	cpuMs: Record<string, number>;
	/** Current resident set size summed over the label's pids, KiB. */
	rssKiB: Record<string, number>;
}

export interface SamplerSample {
	/** ms since `start()`. */
	tMs: number;
	cpuMs: Record<string, number>;
	rssKiB: Record<string, number>;
}

export interface SamplerSeries {
	intervalMs: number;
	samples: SamplerSample[];
	/** Max of the sampled RSS sums per label (peak between ticks is not seen). */
	peakRssKiB: Record<string, number>;
}

interface LabelState {
	/** CPU ms of pids that exited or left the label. */
	retired: number;
	/** Last observed cumulative CPU ms per live pid. */
	last: Map<number, number>;
	peakRss: number;
}

/**
 * Samples cumulative CPU and RSS for labelled process groups.
 *
 * CPU stays monotonic under churn: when a pid disappears (or its counter goes
 * backwards, i.e. pid reuse) its last observed value moves into a per-label
 * retired accumulator; a newly seen pid contributes from 0. CPU a short-lived
 * process burned after its last observation and before exiting is lost, and
 * CPU of reaped children (cutime/cstime) is not tracked: sample often enough
 * relative to child lifetimes you care about.
 */
export class Sampler {
	readonly #targets: SamplerTarget[];
	readonly #intervalMs: number;
	readonly #state = new Map<string, LabelState>();
	readonly #samples: SamplerSample[] = [];
	#timer: NodeJS.Timeout | undefined;
	#startNs = 0n;

	constructor(targets: SamplerTarget[], intervalMs = 250) {
		this.#targets = targets;
		this.#intervalMs = intervalMs;
		for (const t of targets) this.#state.set(t.label, { retired: 0, last: new Map(), peakRss: 0 });
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#startNs = monotonicNs();
		this.#record();
		this.#timer = setInterval(() => this.#record(), this.#intervalMs);
		this.#timer.unref();
	}

	/** Reads /proc now (not the last tick). Safe before `start()`. */
	snapshot(): SamplerSnapshot {
		const { tNs, cpuMs, rssKiB } = this.#read();
		return { tNs, cpuMs, rssKiB };
	}

	/** Takes a final sample, stops the timer, returns everything recorded. */
	stop(): SamplerSeries {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
			this.#record();
		}
		const peakRssKiB: Record<string, number> = {};
		for (const [label, st] of this.#state) peakRssKiB[label] = st.peakRss;
		return { intervalMs: this.#intervalMs, samples: this.#samples, peakRssKiB };
	}

	#record(): void {
		const { tNs, cpuMs, rssKiB } = this.#read();
		this.#samples.push({ tMs: Number(tNs - this.#startNs) / 1e6, cpuMs, rssKiB });
	}

	#read(): SamplerSnapshot {
		const tNs = monotonicNs();
		const cpuMs: Record<string, number> = {};
		const rssKiB: Record<string, number> = {};
		for (const target of this.#targets) {
			const st = this.#state.get(target.label)!;
			const seen = new Set<number>();
			const alive = new Set<number>();
			let rss = 0;
			let live = 0;
			for (const pid of target.pids()) {
				if (seen.has(pid)) continue;
				seen.add(pid);
				const ps = readProcStat(pid);
				if (ps === undefined) continue;
				const cpu = ps.utimeMs + ps.stimeMs;
				const prev = st.last.get(pid);
				// Counter went backwards: pid was reused by a new process.
				if (prev !== undefined && cpu < prev) st.retired += prev;
				st.last.set(pid, cpu);
				alive.add(pid);
				live += cpu;
				rss += ps.rssKiB;
			}
			// Pids no longer reported (exited, reaped, or left the label).
			for (const [pid, last] of st.last) {
				if (alive.has(pid)) continue;
				st.retired += last;
				st.last.delete(pid);
			}
			cpuMs[target.label] = st.retired + live;
			rssKiB[target.label] = rss;
			if (rss > st.peakRss) st.peakRss = rss;
		}
		return { tNs, cpuMs, rssKiB };
	}
}

/** Per-label CPU ms burned between two snapshots. */
export function cpuDelta(a: SamplerSnapshot, b: SamplerSnapshot): Record<string, number> {
	const out: Record<string, number> = {};
	for (const label of Object.keys(b.cpuMs)) out[label] = b.cpuMs[label]! - (a.cpuMs[label] ?? 0);
	return out;
}

/** Samples with `fromMs <= tMs <= toMs`; `peakRssKiB` is recomputed over the window. */
export function windowSeries(series: SamplerSeries, fromMs: number, toMs: number): SamplerSeries {
	const samples = series.samples.filter((s) => s.tMs >= fromMs && s.tMs <= toMs);
	const peakRssKiB: Record<string, number> = {};
	for (const s of samples) {
		for (const [label, rss] of Object.entries(s.rssKiB)) {
			if (rss > (peakRssKiB[label] ?? 0)) peakRssKiB[label] = rss;
		}
	}
	return { intervalMs: series.intervalMs, samples, peakRssKiB };
}

// ---------------------------------------------------------------------------
// TCP byte counters (H2 byte observation) via `ss -ti`
// ---------------------------------------------------------------------------

export interface SocketConn {
	/** `addr:port` as printed by ss (IPv6 in brackets). */
	local: string;
	peer: string;
	localPort: number;
	peerPort: number;
	/** True when this socket is on the observed port's side (localPort === port). */
	fleetSide: boolean;
	/** Application bytes this socket sent (ss `bytes_sent`; includes unacked). */
	bytesSent: number;
	/** Bytes the peer acknowledged (ss `bytes_acked`; lags in flight data, SYN may add 1 on the client socket). */
	bytesAcked: number;
	/** Application bytes this socket received (ss `bytes_received`). */
	bytesReceived: number;
	/** Owning pid when `ss -p` could resolve it (same-user processes). */
	pid?: number;
}

export interface SocketCounters {
	port: number;
	/** False when `ss` is missing or failed; `connections` is then empty. */
	available: boolean;
	connections: SocketConn[];
}

function infoNumber(info: string, key: string): number {
	const m = new RegExp(`(?:^|\\s)${key}:(\\d+)`).exec(info);
	return m === null ? 0 : Number(m[1]);
}

/**
 * Established TCP connections touching `port` with per-socket byte counters.
 * Never throws. On loopback each connection appears twice (server socket with
 * `localPort === port`, client socket with `peerPort === port`); use
 * `fleetSide` sockets only to avoid double counting.
 */
export async function socketCounters(port: number): Promise<SocketCounters> {
	const empty: SocketCounters = { port, available: false, connections: [] };
	try {
		const proc = Bun.spawn(
			["ss", "-tinHp", "state", "established", `( sport = :${port} or dport = :${port} )`],
			{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
		);
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return empty;
		const connections: SocketConn[] = [];
		let head: string[] | undefined;
		for (const line of text.split("\n")) {
			if (line.length === 0) continue;
			if (!/^\s/.test(line)) {
				head = line.trim().split(/\s+/);
				continue;
			}
			// Info line belongs to the preceding head line: Recv-Q Send-Q Local Peer [users:(...)]
			if (head === undefined || head.length < 4) continue;
			const local = head[2]!;
			const peer = head[3]!;
			const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
			const pidMatch = /pid=(\d+)/.exec(head.slice(4).join(" "));
			const conn: SocketConn = {
				local,
				peer,
				localPort,
				peerPort: Number(peer.slice(peer.lastIndexOf(":") + 1)),
				fleetSide: localPort === port,
				bytesSent: infoNumber(line, "bytes_sent"),
				bytesAcked: infoNumber(line, "bytes_acked"),
				bytesReceived: infoNumber(line, "bytes_received"),
			};
			if (pidMatch !== null) conn.pid = Number(pidMatch[1]);
			connections.push(conn);
			head = undefined;
		}
		return { port, available: true, connections };
	} catch {
		return empty;
	}
}

export interface SocketDelta {
	/** Fleet-side connections present in `after`. */
	connections: number;
	/** Present in `after` but not `before`. */
	opened: number;
	/** Present in `before` but not `after` (their last bytes are not counted). */
	closed: number;
	/** Bytes fleet -> peer (ss `bytes_sent` on fleet-side sockets). */
	toPeerBytes: number;
	/** Bytes fleet -> peer acknowledged. */
	toPeerAckedBytes: number;
	/** Bytes peer -> fleet (ss `bytes_received` on fleet-side sockets). */
	fromPeerBytes: number;
}

/**
 * Byte delta between two `socketCounters` reads, seen from the fleet port
 * side. Connections are matched by (local, peer) address tuple; a connection
 * only in `after` counts from 0, one only in `before` is reported as closed
 * and contributes nothing (bytes between the last read and the close are
 * unobservable with ss).
 */
export function socketDelta(before: SocketCounters, after: SocketCounters): SocketDelta {
	const prev = new Map<string, SocketConn>();
	for (const c of before.connections) if (c.fleetSide) prev.set(`${c.local}|${c.peer}`, c);
	const delta: SocketDelta = {
		connections: 0,
		opened: 0,
		closed: 0,
		toPeerBytes: 0,
		toPeerAckedBytes: 0,
		fromPeerBytes: 0,
	};
	const seen = new Set<string>();
	for (const c of after.connections) {
		if (!c.fleetSide) continue;
		const key = `${c.local}|${c.peer}`;
		seen.add(key);
		const p = prev.get(key);
		delta.connections++;
		if (p === undefined) delta.opened++;
		delta.toPeerBytes += c.bytesSent - (p?.bytesSent ?? 0);
		delta.toPeerAckedBytes += c.bytesAcked - (p?.bytesAcked ?? 0);
		delta.fromPeerBytes += c.bytesReceived - (p?.bytesReceived ?? 0);
	}
	for (const key of prev.keys()) if (!seen.has(key)) delta.closed++;
	return delta;
}
