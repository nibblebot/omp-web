/**
 * Test runner wrapper: `bun test` with the worker count pinned to the
 * machine's PHYSICAL core count.
 *
 * bun's default `--parallel` uses the logical CPU count (nproc), which on
 * hyperthreaded / hybrid machines oversubscribes the physical cores. This
 * suite's daemon-spawning files thrash at 32 logical workers (~69s on an
 * 8P+16E machine) but run flat at 8-26 (~26s). One worker per physical core
 * sits in that flat zone on any machine; detect it from /proc/cpuinfo
 * (unique package/core pairs) and fall back to the logical count where
 * /proc/cpuinfo is unavailable (non-Linux).
 *
 * Extra CLI args are forwarded to `bun test` (`bun scripts/test.ts --bail 1`).
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

/** Unique (physical id, core id) pairs = physical core count on Linux. */
function physicalCores(): number {
	try {
		const lines = readFileSync("/proc/cpuinfo", "utf8").split("\n");
		const cores = new Set<string>();
		let pkg: string | null = null;
		for (const line of lines) {
			const idx = line.indexOf(":");
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (key === "physical id") pkg = value;
			else if (key === "core id" && pkg !== null) cores.add(`${pkg}/${value}`);
		}
		if (cores.size > 0) return cores.size;
	} catch {
		// No /proc/cpuinfo: fall through to the logical count.
	}
	return availableParallelism();
}

const workers = Math.max(1, physicalCores());
const child = Bun.spawn(["bun", "test", `--parallel=${workers}`, "--timeout", "15000", "--retry", "0", ...process.argv.slice(2)], {
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit((await child.exited) ?? 1);
