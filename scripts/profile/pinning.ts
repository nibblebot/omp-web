/**
 * CPU pinning for the profiling harness: plan, per-thread verification, and
 * re-pin helpers built on `taskset` and `/proc/<pid>/task/<tid>/status`.
 *
 * Documented layout (i9-13900KF): P-cores are cpus 0-15 with SMT siblings
 * (2k, 2k+1); E-cores are cpus 16-31 without SMT. Each measured role gets one
 * physical P-core thread so SMT siblings stay idle.
 */
import { readdirSync, readFileSync } from "node:fs";
import { constants, cpus } from "node:os";
import type { AffinityRecord, PinPlan } from "./types";

const FLEET = "0";
const SESSIONS = ["2", "4", "6", "8"];
const CHROMIUM = "10,12";
const FAKE_MODEL = "16-23";
const HARNESS = "24-31";

function readTopology(cpu: number): string | undefined {
	try {
		return readFileSync(
			`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`,
			"utf8",
		).trim();
	} catch {
		return undefined;
	}
}

/** True when the sysfs SMT topology matches the documented layout. */
function topologyMatches(): boolean {
	for (let core = 0; core < 16; core += 2) {
		for (const cpu of [core, core + 1]) {
			const list = readTopology(cpu);
			if (list === undefined || normalizeCpuList(list) !== `${core},${core + 1}`) return false;
		}
	}
	for (let cpu = 16; cpu < 32; cpu++) {
		const list = readTopology(cpu);
		if (list === undefined || normalizeCpuList(list) !== String(cpu)) return false;
	}
	return true;
}

/**
 * Pin plan for the documented 13900KF layout. Enabled only when `taskset`
 * exists, there are at least 32 logical cpus and the sibling topology matches;
 * otherwise `{ enabled: false, disabledReason }` (lists still filled in).
 */
export function defaultPinPlan(opts?: { noPin?: boolean }): PinPlan {
	const plan: PinPlan = {
		enabled: false,
		fleet: FLEET,
		sessions: [...SESSIONS],
		chromium: CHROMIUM,
		fakeModel: FAKE_MODEL,
		harness: HARNESS,
	};
	if (opts?.noPin) {
		plan.disabledReason = "--no-pin";
	} else if (Bun.which("taskset") === null) {
		plan.disabledReason = "taskset not found";
	} else if (cpus().length < 32) {
		plan.disabledReason = `only ${cpus().length} logical cpus (need >= 32)`;
	} else if (!topologyMatches()) {
		plan.disabledReason =
			"SMT sibling topology does not match the documented layout (P-cores 2k,2k+1 for 0..15; E-cores 16..31)";
	} else {
		plan.enabled = true;
	}
	return plan;
}

/** Canonical cpu list: sorted unique ids expanded and comma joined ("16-31" -> "16,17,...,31"). */
export function normalizeCpuList(s: string): string {
	const set = new Set<number>();
	for (const part of s.trim().split(",")) {
		if (part.length === 0) continue;
		const [lo, hi] = part.split("-");
		const a = Number(lo);
		const b = hi === undefined ? a : Number(hi);
		if (!Number.isInteger(a) || !Number.isInteger(b) || b < a) continue;
		for (let cpu = a; cpu <= b; cpu++) set.add(cpu);
	}
	return [...set].sort((x, y) => x - y).join(",");
}

/** `Cpus_allowed_list` of every thread of `pid` (empty when the process is gone). Threads exiting mid-scan are skipped. */
export function readThreadAffinities(pid: number): Array<{ tid: number; cpus: string }> {
	let tids: string[];
	try {
		tids = readdirSync(`/proc/${pid}/task`);
	} catch {
		return [];
	}
	const out: Array<{ tid: number; cpus: string }> = [];
	for (const name of tids) {
		try {
			const status = readFileSync(`/proc/${pid}/task/${name}/status`, "utf8");
			const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(status);
			if (m !== null) out.push({ tid: Number(name), cpus: m[1]! });
		} catch {
			// thread exited
		}
	}
	return out;
}

/** `taskset -a -p -c <cpus> <pid>`: sets the affinity of every current thread. Throws on failure. */
export async function pinProcess(pid: number, cpuList: string): Promise<void> {
	const proc = Bun.spawn(["taskset", "-a", "-p", "-c", cpuList, String(pid)], {
		stdout: "ignore",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0)
		throw new Error(`taskset -a -p -c ${cpuList} ${pid} failed (${code}): ${err.trim()}`);
}

function inspect(role: string, pid: number, expected: string, repinned: boolean): AffinityRecord {
	const threads = readThreadAffinities(pid);
	const want = normalizeCpuList(expected);
	const seen = [...new Set(threads.map((t) => t.cpus))];
	return {
		role,
		pid,
		expected,
		threads: threads.length,
		seen,
		ok: threads.length > 0 && threads.every((t) => normalizeCpuList(t.cpus) === want),
		repinned,
	};
}

/**
 * Verifies every thread of every pid has exactly `expected` as its allowed
 * cpus. Offenders are re-pinned once with `taskset -a` and re-verified;
 * `repinned` is set on those. A process that still has mixed (or empty)
 * threads afterwards, or that is gone, reports `ok: false`.
 */
export async function ensureAffinity(
	role: string,
	pids: number[],
	expected: string,
): Promise<AffinityRecord[]> {
	return Promise.all(
		pids.map(async (pid) => {
			const first = inspect(role, pid, expected, false);
			if (first.ok || first.threads === 0) return first;
			try {
				await pinProcess(pid, expected);
			} catch {
				// verification below reports the outcome
			}
			return inspect(role, pid, expected, true);
		}),
	);
}

/**
 * Re-executes the current process under `taskset -c <plan.harness>` with
 * `PROFILE_PINNED=1`, stdio inherited, SIGINT/SIGTERM forwarded, exiting with
 * the child's status. Does nothing (returns `undefined`) when the plan is
 * disabled or `PROFILE_PINNED` is already `1`.
 *
 * Callers `await` it at the very top of main:
 * `await ensureHarnessPinned(plan);` The returned promise never resolves in the
 * parent (it calls `process.exit`), so nothing after it runs there.
 */
export function ensureHarnessPinned(plan: PinPlan): Promise<never> | undefined {
	if (!plan.enabled || process.env.PROFILE_PINNED === "1") return undefined;
	const child = Bun.spawn(
		[
			"taskset",
			"-c",
			plan.harness,
			process.execPath,
			...process.execArgv,
			...process.argv.slice(1),
		],
		{
			stdio: ["inherit", "inherit", "inherit"],
			env: { ...process.env, PROFILE_PINNED: "1" },
		},
	);
	const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
	process.on("SIGINT", forward("SIGINT"));
	process.on("SIGTERM", forward("SIGTERM"));
	return child.exited.then((code) => {
		const signal = child.signalCode;
		return process.exit(
			signal === null
				? code
				: 128 + (typeof signal === "number" ? signal : (constants.signals[signal] ?? 1)),
		);
	});
}
