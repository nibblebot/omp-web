/**
 * Project discovery for the fleet.
 *
 * `listProjects` scans each root ONE level deep for directories containing a
 * `.git` entry (directory for a main checkout, file for a linked worktree),
 * then asks git for the authoritative worktree list. The first `worktree`
 * block of `git -C <path> worktree list --porcelain` is the main repository;
 * later blocks are linked worktrees whose `worktreeOf` is the basename of the
 * main repo path. A git failure for one repo (spawn error, nonzero exit, or
 * unparseable output) degrades to a plain entry instead of failing the whole
 * scan. Results are cached in memory for 60s keyed by the joined roots;
 * `listProjects.clearCache()` drops the cache.
 *
 * `validateProjectPath` resolves a path to its realpath, or null unless it is
 * an existing directory.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ProjectEntry } from "../src/protocol";

/** Result of a git invocation (real subprocess or injected fake). */
export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Runs git for a repo. `args` are the arguments AFTER `git -C <cwd>` (the
 * default implementation spawns `git -C <cwd> <args>`); tests inject a fake.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export interface ListProjectsOptions {
	/** Override the git invocation (tests); defaults to a real `git` spawn. */
	exec?: GitRunner;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	expiresAt: number;
	projects: ProjectEntry[];
}

const cache = new Map<string, CacheEntry>();

/** Default git runner: `git -C <cwd> <args>` via Bun.spawn. */
async function runGit(args: string[], cwd: string): Promise<GitResult> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);
		return { exitCode: await proc.exited, stdout, stderr };
	} catch (err) {
		return { exitCode: 127, stdout: "", stderr: String(err) };
	}
}

/** One parsed worktree block from `git worktree list --porcelain`. */
interface WorktreeBlock {
	path?: string;
	/** Raw branch ref ("refs/heads/x"), "detached", or absent. */
	branch?: string;
}

/** Parse porcelain output into per-worktree blocks (blank-line separated). */
function parseWorktreeList(stdout: string): WorktreeBlock[] {
	const blocks: WorktreeBlock[] = [];
	let block: WorktreeBlock | null = null;
	for (const line of stdout.split("\n")) {
		if (line === "") {
			if (block) {
				blocks.push(block);
				block = null;
			}
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (block) blocks.push(block); // tolerate a missing blank separator
			block = { path: line.slice("worktree ".length) };
		} else if (block) {
			if (line.startsWith("branch ")) block.branch = line.slice("branch ".length);
			else if (line === "detached") block.branch = "detached";
		}
	}
	if (block) blocks.push(block);
	return blocks;
}

/** `branch refs/heads/x` → "x"; `detached`/absent → undefined. */
function branchOf(raw: string | undefined): string | undefined {
	if (!raw || raw === "detached") return undefined;
	return raw.startsWith("refs/heads/") ? raw.slice("refs/heads/".length) : raw;
}

function plainEntry(path: string): ProjectEntry {
	return { name: basename(path), path, isWorktree: false };
}

/**
 * Scan one discovered repo. A git failure (thrown exec, nonzero exit, or
 * unparseable output) degrades to the plain entry rather than failing the
 * whole scan.
 */
async function scanRepo(repoPath: string, exec: GitRunner): Promise<ProjectEntry[]> {
	const result = await exec(["worktree", "list", "--porcelain"], repoPath).catch(() => null);
	if (!result || result.exitCode !== 0) return [plainEntry(repoPath)];
	const blocks = parseWorktreeList(result.stdout);
	const main = blocks[0];
	if (!main) return [plainEntry(repoPath)];
	const mainPath = main.path ?? repoPath;
	const mainBranch = branchOf(main.branch);
	const projects: ProjectEntry[] = [
		{
			name: basename(mainPath),
			path: mainPath,
			isWorktree: false,
			...(mainBranch !== undefined ? { branch: mainBranch } : {}),
		},
	];
	for (const wt of blocks.slice(1)) {
		if (!wt.path) continue;
		const branch = branchOf(wt.branch);
		projects.push({
			name: basename(wt.path),
			path: wt.path,
			isWorktree: true,
			worktreeOf: basename(mainPath),
			...(branch !== undefined ? { branch } : {}),
		});
	}
	return projects;
}

/** Scan one root one level deep; missing/unreadable roots are skipped silently. */
async function scanRoot(root: string, exec: GitRunner): Promise<ProjectEntry[]> {
	const resolved = await realpath(root).catch(() => null);
	if (!resolved) return [];
	const dirents = await readdir(resolved, { withFileTypes: true }).catch(() => null);
	if (!dirents) return [];
	const projects: ProjectEntry[] = [];
	for (const child of dirents) {
		const candidate = join(resolved, child.name);
		try {
			await stat(join(candidate, ".git")); // .git dir OR file both qualify
		} catch {
			continue; // not a repo
		}
		projects.push(...(await scanRepo(candidate, exec)));
	}
	return projects;
}

async function scanAll(roots: string[], exec: GitRunner): Promise<ProjectEntry[]> {
	const projects: ProjectEntry[] = [];
	for (const root of roots) projects.push(...(await scanRoot(root, exec)));
	// Dedupe by path (first wins): overlapping roots, or a linked worktree
	// that is itself directly under a root, would otherwise report the same
	// repo twice.
	const seen = new Set<string>();
	return projects.filter((p) => {
		if (seen.has(p.path)) return false;
		seen.add(p.path);
		return true;
	});
}

/**
 * Discover projects under `roots`, each scanned ONE level deep. Cached for
 * 60s keyed by the joined roots; see clearCache().
 */
export async function listProjects(roots: string[], options?: ListProjectsOptions): Promise<ProjectEntry[]> {
	const exec = options?.exec ?? runGit;
	const key = JSON.stringify(roots);
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.projects.slice();
	const projects = await scanAll(roots, exec);
	cache.set(key, { expiresAt: now + CACHE_TTL_MS, projects });
	return projects.slice();
}

export namespace listProjects {
	/** Drop the 60s discovery cache (tests, config changes). */
	export function clearCache(): void {
		cache.clear();
	}
}

/** Realpath of `p`, or null unless it is an existing directory. */
export async function validateProjectPath(p: string): Promise<string | null> {
	const resolved = await realpath(p).catch(() => null);
	if (!resolved) return null;
	const st = await stat(resolved).catch(() => null);
	return st?.isDirectory() ? resolved : null;
}
