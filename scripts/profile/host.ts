/** Host fingerprint of a profiling run: cpu, governor, runtime versions, git state. */
import { readdirSync, readFileSync } from "node:fs";
import { arch, cpus, release, type as osType } from "node:os";
import { join } from "node:path";
import type { HostFingerprint, PinPlan } from "./types";

/**
 * Scaling governor shared by all cpus (e.g. "powersave"), `mixed:a,b` when
 * cpus differ, `unknown` when sysfs is unreadable.
 */
export function readGovernor(): string {
	const found = new Set<string>();
	try {
		for (const name of readdirSync("/sys/devices/system/cpu")) {
			if (!/^cpu\d+$/.test(name)) continue;
			try {
				found.add(
					readFileSync(`/sys/devices/system/cpu/${name}/cpufreq/scaling_governor`, "utf8").trim(),
				);
			} catch {
				// offline cpu or no cpufreq
			}
		}
	} catch {
		return "unknown";
	}
	if (found.size === 0) return "unknown";
	if (found.size === 1) return [...found][0]!;
	return `mixed:${[...found].sort().join(",")}`;
}

/** First `model name` of /proc/cpuinfo, `unknown` when unreadable. */
export function cpuModel(): string {
	try {
		const m = /^model name\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"));
		return m === null ? "unknown" : m[1]!.trim();
	} catch {
		return "unknown";
	}
}

async function git(repoRoot: string, args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { code, out };
}

/**
 * HEAD commit and dirtiness. Changes under `.profile-out/` (runs and saved
 * baselines) are excluded from the dirty check so writing them does not mark
 * the tree dirty. `commit` is `unknown` and `dirty` false when git is
 * unavailable.
 */
export async function gitInfo(repoRoot: string): Promise<{ commit: string; dirty: boolean }> {
	try {
		const head = await git(repoRoot, ["rev-parse", "HEAD"]);
		if (head.code !== 0) return { commit: "unknown", dirty: false };
		const status = await git(repoRoot, [
			"status",
			"--porcelain",
			"--",
			".",
			":(exclude).profile-out",
		]);
		return { commit: head.out.trim(), dirty: status.code === 0 && status.out.trim().length > 0 };
	} catch {
		return { commit: "unknown", dirty: false };
	}
}

/** Version of the installed `@oh-my-pi/pi-coding-agent`, `unknown` when not installed. */
export function sdkVersion(repoRoot: string): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(repoRoot, "node_modules/@oh-my-pi/pi-coding-agent/package.json"), "utf8"),
		) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

export function bunVersion(): string {
	return Bun.version;
}

/** e.g. `Linux 7.2.10 x64`. */
export function osString(): string {
	return `${osType()} ${release()} ${arch()}`;
}

export async function collectFingerprint(opts: {
	repoRoot: string;
	pin: PinPlan;
	transport: string;
	chromium?: { name: string; path: string };
}): Promise<HostFingerprint> {
	const { commit, dirty } = await gitInfo(opts.repoRoot);
	const fp: HostFingerprint = {
		cpuModel: cpuModel(),
		logicalCpus: cpus().length,
		governor: readGovernor(),
		pin: opts.pin,
		bun: bunVersion(),
		sdk: sdkVersion(opts.repoRoot),
		gitCommit: commit,
		gitDirty: dirty,
		os: osString(),
		transport: opts.transport,
	};
	if (opts.chromium !== undefined) {
		fp.chromium = opts.chromium.name;
		fp.chromiumPath = opts.chromium.path;
	}
	return fp;
}
