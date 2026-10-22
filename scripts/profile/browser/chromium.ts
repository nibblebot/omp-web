/**
 * Chromium discovery and launch plumbing for the browser pass.
 *
 * Resolution order (first candidate that runs `--version` wins):
 *   1. env `PROFILE_CHROMIUM`
 *   2. the explicit `chromiumPath` argument (`--chromium-path`)
 *   3. the newest Playwright cache build (`chromium_headless_shell-*`, then
 *      `chromium-*`), launched with shared libraries found in /nix/store when
 *      the binary reports unresolved ones (NixOS hosts have no FHS libs)
 *   4. a system `chromium` / `chromium-browser` / `google-chrome` on PATH
 *
 * Process-tree helpers (`chromiumPins`, `killChromiumTree`) and the optional
 * `taskset` launch wrapper live here too.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { descendantPids, isAlive, pidsByCmdline, readProcStat } from "../proc";

export type ChromiumSource = "env" | "option" | "playwright-cache" | "system";

export interface ResolvedChromium {
	/** Product and version, e.g. `Chrome for Testing 155.0.8059.12`. */
	name: string;
	/** Dotted version from `--version` (the pass reports `browser.version()` too). */
	version: string;
	path: string;
	source: ChromiumSource;
	/** Extra environment the binary needs to start (`LD_LIBRARY_PATH` on NixOS), empty when none. */
	env: Record<string, string>;
	/** Candidates tried before this one and why they were rejected. */
	rejected: string[];
}

const VERSION_TIMEOUT_MS = 15_000;
const SYSTEM_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
const NIX_STORE = "/nix/store";

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function run(
	argv: string[],
	env?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: env === undefined ? process.env : { ...process.env, ...env },
		timeout: VERSION_TIMEOUT_MS,
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

/** `Chromium 155.0.8059.79 ` -> name `Chromium 155.0.8059.79`, version `155.0.8059.79`. */
function parseVersion(output: string): { name: string; version: string } | undefined {
	const line = output.split("\n").find((l) => /\d+\.\d+\.\d+\.\d+/.test(l));
	if (line === undefined) return undefined;
	const match = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
	if (match === null) return undefined;
	return { name: line.trim(), version: match[1]! };
}

/** Shared libraries `ldd` reports as unresolved for `binary`. */
async function missingLibs(binary: string): Promise<string[]> {
	const { out } = await run(["ldd", binary]);
	const names: string[] = [];
	for (const line of out.split("\n")) {
		const match = /^\s*(\S+)\s+=>\s+not found/.exec(line);
		if (match !== null) names.push(match[1]!);
	}
	return names;
}

/** Store paths lowest priority: merged profiles drag in unrelated library versions. */
function storeRank(dir: string): number {
	return /-(system-path|user-environment|profile|env)\//.test(dir) ? 1 : 0;
}

/**
 * Directories under /nix/store that provide each name in `libs`. One directory per
 * library: a non-merged, non-32-bit, non-dev provider, the lexicographically last
 * when several exist. Returns `undefined` when a library has no provider.
 */
async function nixLibDirs(libs: string[]): Promise<string[] | undefined> {
	if (!existsSync(NIX_STORE)) return undefined;
	const dirs = new Set<string>();
	for (const lib of libs) {
		const { out } = await run(["sh", "-c", `ls -d ${NIX_STORE}/*/lib/${lib} 2>/dev/null`]);
		const candidates = out
			.split("\n")
			.filter((p) => p !== "" && !/i686|32bit|-dev\/|aarch|musl/.test(p))
			.map((p) => p.slice(0, p.lastIndexOf("/")));
		candidates.sort((a, b) => storeRank(a) - storeRank(b) || (a < b ? 1 : -1));
		const best = candidates[0];
		if (best === undefined) return undefined;
		dirs.add(best);
	}
	return [...dirs];
}

interface Probe {
	name: string;
	version: string;
	env: Record<string, string>;
}

/** Run `--version`; on unresolved libraries retry once with a /nix/store LD_LIBRARY_PATH. */
async function probe(path: string): Promise<Probe | string> {
	if (!existsSync(path)) return `${path}: not found`;
	let first: { code: number; out: string; err: string };
	try {
		first = await run([path, "--version"]);
	} catch (err) {
		return `${path}: ${err instanceof Error ? err.message : String(err)}`;
	}
	const parsed = parseVersion(first.out);
	if (first.code === 0 && parsed !== undefined) return { ...parsed, env: {} };
	const missing = await missingLibs(path);
	if (missing.length === 0) {
		return `${path}: exit ${first.code}: ${first.err.trim().slice(0, 200)}`;
	}
	const dirs = await nixLibDirs(missing);
	if (dirs === undefined) {
		return `${path}: unresolved libraries (${missing.join(", ")}) and no /nix/store provider for all of them`;
	}
	const existing = process.env.LD_LIBRARY_PATH;
	const env = {
		LD_LIBRARY_PATH:
			existing === undefined || existing === "" ? dirs.join(":") : `${dirs.join(":")}:${existing}`,
	};
	const second = await run([path, "--version"], env);
	const reparsed = parseVersion(second.out);
	if (second.code === 0 && reparsed !== undefined) return { ...reparsed, env };
	return `${path}: still fails with /nix/store libs: ${second.err.trim().slice(0, 200)}`;
}

function playwrightCacheBinaries(): string[] {
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const rev = (name: string): number => Number(name.slice(name.lastIndexOf("-") + 1));
	const newest = (prefix: string): string[] =>
		entries
			.filter((e) => e.startsWith(prefix) && Number.isInteger(rev(e)))
			.sort((a, b) => rev(b) - rev(a));
	const out: string[] = [];
	for (const dir of newest("chromium_headless_shell-")) {
		out.push(join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"));
	}
	for (const dir of newest("chromium-")) out.push(join(root, dir, "chrome-linux64", "chrome"));
	return out;
}

const resolved = new Map<string, Promise<ResolvedChromium>>();

/**
 * Find a launchable Chromium. Results are memoised per (`chromiumPath`, env) so
 * the fingerprint and the pass share one probe. Throws listing every rejected
 * candidate when none runs.
 */
export function resolveChromium(chromiumPath?: string): Promise<ResolvedChromium> {
	const key = `${process.env.PROFILE_CHROMIUM ?? ""}\0${chromiumPath ?? ""}`;
	let pending = resolved.get(key);
	if (pending === undefined) {
		pending = resolveUncached(chromiumPath);
		resolved.set(key, pending);
		pending.catch(() => resolved.delete(key));
	}
	return pending;
}

async function resolveUncached(chromiumPath: string | undefined): Promise<ResolvedChromium> {
	const rejected: string[] = [];
	const candidates: Array<{ path: string; source: ChromiumSource }> = [];
	const fromEnv = process.env.PROFILE_CHROMIUM;
	if (fromEnv !== undefined && fromEnv !== "") candidates.push({ path: fromEnv, source: "env" });
	if (chromiumPath !== undefined) candidates.push({ path: chromiumPath, source: "option" });
	for (const path of playwrightCacheBinaries())
		candidates.push({ path, source: "playwright-cache" });
	for (const name of SYSTEM_NAMES) {
		const found = Bun.which(name);
		if (found !== null) candidates.push({ path: found, source: "system" });
	}
	for (const candidate of candidates) {
		const result = await probe(candidate.path);
		if (typeof result === "string") {
			rejected.push(result);
			// An explicit choice that does not run is an error, not a reason to silently use another browser.
			if (candidate.source === "env" || candidate.source === "option") {
				throw new Error(
					`${candidate.source === "env" ? "PROFILE_CHROMIUM" : "--chromium-path"} unusable: ${result}`,
				);
			}
			continue;
		}
		return { ...result, path: candidate.path, source: candidate.source, rejected };
	}
	throw new Error(`no launchable Chromium found:\n  ${rejected.join("\n  ") || "no candidates"}`);
}

/**
 * Executable Playwright launches: `chromium.path` itself, or a generated wrapper
 * that execs it under `taskset -c <cpus>` so the whole tree (every later child
 * and thread) is born pinned. `taskset` execs in place, so the pid is chrome's.
 */
export function launchExecutable(
	chromium: ResolvedChromium,
	scratchDir: string,
	pinCpus: string | undefined,
): string {
	if (pinCpus === undefined) return chromium.path;
	const taskset = Bun.which("taskset");
	if (taskset === null) throw new Error("pinCpus requested but taskset is not installed");
	const wrapper = join(scratchDir, "chromium-pinned.sh");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${taskset} -c ${pinCpus} "${chromium.path}" "$@"\n`);
	chmodSync(wrapper, 0o755);
	return wrapper;
}

/** Pids of `rootPid` and every descendant (renderer, gpu, utility, zygote), from /proc. Empty when gone. */
export function chromiumPins(rootPid: number): number[] {
	return descendantPids(rootPid);
}

/** The newest child of this process whose argv carries `--remote-debugging-pipe` and is not in `before`. */
export function findLaunchedRoot(before: ReadonlySet<number>): number | undefined {
	const candidates = pidsByCmdline((argv) =>
		argv.some((a) => a.includes("--remote-debugging-pipe")),
	).filter((pid) => !before.has(pid) && readProcStat(pid)?.ppid === process.pid);
	return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** Current children of this process that look like Playwright-launched Chromium roots. */
export function launchedRoots(): Set<number> {
	return new Set(
		pidsByCmdline((argv) => argv.some((a) => a.includes("--remote-debugging-pipe"))).filter(
			(pid) => readProcStat(pid)?.ppid === process.pid,
		),
	);
}

/**
 * The `--user-data-dir` Playwright gave the browser rooted at `pid`. Chromium
 * rewrites its own argv area into one space-joined string, so match with a regex
 * over the whole cmdline instead of splitting on NUL.
 */
export function userDataDirOf(pid: number): string | undefined {
	try {
		const match = /--user-data-dir=(\S+)/.exec(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * SIGKILL every process of a browser: the `rootPid` tree plus anything still
 * carrying its `--user-data-dir` (children reparented to init after the root
 * died). Waits until all are gone; returns the pids that had to be killed.
 */
export async function killChromiumTree(
	rootPid: number,
	userDataDir: string | undefined,
	known: Iterable<number> = [],
): Promise<number[]> {
	const targets = new Set<number>(known);
	for (let attempt = 0; attempt < 10; attempt++) {
		for (const pid of chromiumPins(rootPid)) targets.add(pid);
		if (userDataDir !== undefined) {
			const tag = `--user-data-dir=${userDataDir}`;
			for (const pid of pidsByCmdline((argv) => argv.some((a) => a.includes(tag))))
				targets.add(pid);
		}
		const alive = [...targets].filter((pid) => isAlive(pid));
		if (alive.length === 0) break;
		for (const pid of alive) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// exited between the check and the signal
			}
		}
		await sleep(50);
	}
	return [...targets];
}
