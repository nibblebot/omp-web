/**
 * Linux `/proc` readers for the profiling harness. Synchronous fs, no
 * dependencies; every reader tolerates a process vanishing mid-read and
 * returns `undefined` / `[]` instead of throwing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface ProcStat {
	pid: number;
	ppid: number;
	/** Cumulative user CPU time in ms (utime). */
	utimeMs: number;
	/** Cumulative kernel CPU time in ms (stime). */
	stimeMs: number;
	/** Resident set size in KiB (stat `rss` pages * page size). */
	rssKiB: number;
	threads: number;
	/** Single-letter state: R S D Z T t X I ... */
	state: string;
}

export interface ProcIo {
	rchar: number;
	wchar: number;
	read_bytes: number;
	write_bytes: number;
}

let clkTck: number | undefined;
let pageSizeKiB: number | undefined;

function getconf(name: string): number | undefined {
	try {
		const out = Bun.spawnSync(["getconf", name], { stdout: "pipe", stderr: "ignore" });
		const n = Number.parseInt(out.stdout.toString().trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

/** Kernel clock ticks per second (`getconf CLK_TCK`, queried once; default 100). */
export function clockTicksPerSecond(): number {
	clkTck ??= getconf("CLK_TCK") ?? 100;
	return clkTck;
}

function pageKiB(): number {
	pageSizeKiB ??= (getconf("PAGESIZE") ?? 4096) / 1024;
	return pageSizeKiB;
}

/**
 * Parse `/proc/<pid>/stat`. The comm field is parenthesised and may itself
 * contain spaces and ')' so fields are split after the LAST ')'.
 * One file read per call; this is the only reader the Sampler hot path uses.
 */
export function readProcStat(pid: number): ProcStat | undefined {
	let raw: string;
	try {
		raw = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const close = raw.lastIndexOf(")");
	if (close < 0) return undefined;
	// Fields after comm, 0-based: [0]=state(3) [1]=ppid(4) [11]=utime(14)
	// [12]=stime(15) [17]=num_threads(20) [21]=rss(24) (man 5 proc numbering in parens).
	const f = raw.slice(close + 2).split(" ");
	if (f.length < 22) return undefined;
	const msPerTick = 1000 / clockTicksPerSecond();
	return {
		pid,
		ppid: Number(f[1]),
		utimeMs: Number(f[11]) * msPerTick,
		stimeMs: Number(f[12]) * msPerTick,
		rssKiB: Number(f[21]) * pageKiB(),
		threads: Number(f[17]),
		state: f[0] ?? "?",
	};
}

function allPids(): number[] {
	const out: number[] = [];
	try {
		for (const name of readdirSync("/proc")) {
			const n = Number(name);
			if (Number.isInteger(n) && n > 0) out.push(n);
		}
	} catch {
		// no /proc
	}
	return out;
}

/** Direct children of `pid`, from every thread's `children` file; undefined when the kernel lacks them. */
function childrenOf(pid: number): number[] | undefined {
	let tids: string[];
	try {
		tids = readdirSync(`/proc/${pid}/task`);
	} catch {
		return [];
	}
	const out: number[] = [];
	for (const tid of tids) {
		try {
			const text = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
			for (const part of text.split(" ")) if (part !== "") out.push(Number(part));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT" && tid === tids[0]) return undefined;
			// The thread exited between listing and reading.
		}
	}
	return out;
}

/** The old way: one ppid map over every process on the host (about 5 ms with ~800 processes). */
function descendantPidsByScan(root: number): number[] {
	const children = new Map<number, number[]>();
	let rootSeen = false;
	for (const pid of allPids()) {
		const st = readProcStat(pid);
		if (st === undefined) continue;
		if (pid === root) rootSeen = true;
		const list = children.get(st.ppid);
		if (list === undefined) children.set(st.ppid, [pid]);
		else list.push(pid);
	}
	if (!rootSeen) return [];
	const out: number[] = [];
	const queue = [root];
	for (let i = 0; i < queue.length; i++) {
		const pid = queue[i]!;
		out.push(pid);
		const kids = children.get(pid);
		if (kids !== undefined) queue.push(...kids);
	}
	return out;
}

/**
 * `root` plus all of its transitive children; empty when root is gone. Walks the
 * kernel's per-thread `children` files, which touches only the tree itself:
 * the sampler resolves every label's tree at each tick on the harness's one JS
 * thread, and a scan of the whole host's /proc per label blocked that thread
 * long enough to delay client receive stamps (see loop-lag.ts). Falls back to
 * the scan on kernels without CONFIG_PROC_CHILDREN.
 */
export function descendantPids(root: number): number[] {
	if (!existsSync(`/proc/${root}`)) return [];
	const out: number[] = [];
	const queue = [root];
	for (let i = 0; i < queue.length; i++) {
		const pid = queue[i]!;
		out.push(pid);
		const kids = childrenOf(pid);
		if (kids === undefined) return descendantPidsByScan(root);
		queue.push(...kids);
	}
	return out;
}

/** Pids whose argv (from `/proc/<pid>/cmdline`, NUL-split) satisfies `predicate`. Kernel threads (empty cmdline) are skipped. */
export function pidsByCmdline(predicate: (argv: string[]) => boolean): number[] {
	const out: number[] = [];
	for (const pid of allPids()) {
		let raw: string;
		try {
			raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		} catch {
			continue;
		}
		if (raw.length === 0) continue;
		const argv = raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : raw.split("\0");
		if (predicate(argv)) out.push(pid);
	}
	return out;
}

/** Thread ids of `pid` (includes the main thread, tid === pid). Empty when gone. */
export function threadIds(pid: number): number[] {
	try {
		return readdirSync(`/proc/${pid}/task`)
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		return [];
	}
}

/** `/proc/<pid>/io` counters, or undefined when unreadable (gone, or not our process). */
export function readIo(pid: number): ProcIo | undefined {
	let raw: string;
	try {
		raw = readFileSync(`/proc/${pid}/io`, "utf8");
	} catch {
		return undefined;
	}
	const kv = new Map<string, number>();
	for (const line of raw.split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) kv.set(line.slice(0, i), Number(line.slice(i + 1).trim()));
	}
	const rchar = kv.get("rchar");
	const wchar = kv.get("wchar");
	const readBytes = kv.get("read_bytes");
	const writeBytes = kv.get("write_bytes");
	if (
		rchar === undefined ||
		wchar === undefined ||
		readBytes === undefined ||
		writeBytes === undefined
	) {
		return undefined;
	}
	return { rchar, wchar, read_bytes: readBytes, write_bytes: writeBytes };
}

/** True when the process exists and is not a zombie / dead. */
export function isAlive(pid: number): boolean {
	const st = readProcStat(pid);
	return st !== undefined && st.state !== "Z" && st.state !== "X";
}
