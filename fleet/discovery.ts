/**
 * Project discovery helpers for the fleet.
 *
 * There is NO filesystem root scanning: projects enter the fleet only by
 * explicit registration (see registry.ts), and the directory-picker UI
 * browses via fs-browse.ts. What lives here are the git-backed helpers
 * shared by registry/supervisor/worktrees:
 *
 * `validateProjectPath` resolves a path (`~`/`~/` expanded) to its
 * realpath, or null unless it is an existing directory.
 *
 * `resolveWorktreeOf` answers the owning-repo basename for one path (spawn
 * cwd tagging): undefined for a main checkout or when git can't tell.
 *
 * `probeGitState` + `parseGitStatePorcelain` + `parseNumstat` parse one
 * repo's dirty state for worktree-delete evidence and daemon git polling.
 */

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import { expandTilde } from "./config";

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

export interface GitOptions {
	/** Override the git invocation (tests); defaults to a real `git` spawn. */
	exec?: GitRunner;
}

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

/** Realpath of `p` (`~`/`~/` expanded), or null unless it is an existing directory. */
export async function validateProjectPath(p: string): Promise<string | null> {
	const resolved = await realpath(expandTilde(p)).catch(() => null);
	if (!resolved) return null;
	const st = await stat(resolved).catch(() => null);
	return st?.isDirectory() ? resolved : null;
}

/**
 * Resolve the owning repo of a spawn cwd: the basename of the MAIN worktree
 * of the repository containing `path`, or undefined when `path` IS the main
 * checkout or git can't tell (not a repo, spawn failure, nonzero exit,
 * unparseable output). One uncached git call — spawn/backfill are rare, and
 * the result is persisted on the registry entry. Realpaths are compared so a
 * cwd naming the main checkout through a symlink still counts as the main
 * checkout.
 */
export async function resolveWorktreeOf(
	path: string,
	options?: GitOptions,
): Promise<string | undefined> {
	const exec = options?.exec ?? runGit;
	const result = await exec(["worktree", "list", "--porcelain"], path).catch(() => null);
	if (!result || result.exitCode !== 0) return undefined;
	const mainPath = parseWorktreeList(result.stdout)[0]?.path;
	if (!mainPath) return undefined;
	const resolved = await realpath(path).catch(() => path);
	const mainResolved = await realpath(mainPath).catch(() => mainPath);
	return mainResolved === resolved ? undefined : basename(mainPath);
}

/** Parsed `git status --porcelain=v1 --branch` for one repo (probeGitState). */
export interface GitState {
	/** Current branch; undefined when detached (or absent from the header). */
	branch?: string;
	/** Dirty-state file counts (all-zero for a clean repo). */
	git: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		/** Staged+unstaged added lines vs HEAD (numstat); absent when the numstat probe failed. */
		linesAdded?: number;
		/** Staged+unstaged deleted lines vs HEAD (numstat); absent when the numstat probe failed. */
		linesDeleted?: number;
	};
}

/** Branch name from a `## ` header (the text AFTER `## `); undefined when detached. */
function branchFromHeader(header: string): string | undefined {
	// Detached HEAD reads `## HEAD (no branch)`.
	if (header.startsWith("HEAD (no branch)")) return undefined;
	// An empty repo (no commits yet) reads `## No commits yet on X`.
	if (header.startsWith("No commits yet on ")) return header.slice("No commits yet on ".length);
	// `## main...origin/main [ahead 1]`: cut at the upstream `...` (refnames
	// can't contain it); a space cut also defends a no-upstream `[ahead N]`
	// suffix. Branch names can't contain spaces either, so both are safe.
	const cut = header.search(/\.\.\.| /);
	if (cut === -1) return header;
	const branch = header.slice(0, cut);
	return branch === "" ? undefined : branch;
}

/**
 * Parse `git status --porcelain=v1 --branch` output into the current branch
 * and per-file dirty counts. The `## <branch>` header is REQUIRED — a real
 * `--branch` run always emits it, even in an empty repo — so unparseable
 * output (garbage, a different command's stdout) returns undefined instead
 * of masquerading as a clean repo. Per-file XY codes: `??` untracked;
 * X or Y == 'A' added; X or Y == 'D' deleted; anything else (M/T/R/C/U)
 * modified.
 */
export function parseGitStatePorcelain(stdout: string): GitState | undefined {
	let headerSeen = false;
	let branch: string | undefined;
	const git = { added: 0, modified: 0, deleted: 0, untracked: 0 };
	for (const line of stdout.split("\n")) {
		if (line.startsWith("## ")) {
			headerSeen = true;
			if (branch === undefined) branch = branchFromHeader(line.slice("## ".length));
			continue;
		}
		if (line.length < 2) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") git.untracked++;
		else if (x === "A" || y === "A") git.added++;
		else if (x === "D" || y === "D") git.deleted++;
		else git.modified++;
	}
	if (!headerSeen) return undefined;
	return { ...(branch !== undefined ? { branch } : {}), git };
}

/**
 * Parse `git diff --numstat HEAD --` output, summing the
 * `<added>\t<deleted>\t<path>` rows. Binary rows (`-\t-`) and blank lines
 * are skipped; anything else unparseable is ignored. Returns 0/0 when
 * nothing matched.
 */
export function parseNumstat(stdout: string): { linesAdded: number; linesDeleted: number } {
	let linesAdded = 0;
	let linesDeleted = 0;
	for (const line of stdout.split("\n")) {
		const [added, deleted] = line.split("\t");
		if (added === undefined || deleted === undefined) continue; // blank or not a numstat row
		if (added === "-" || deleted === "-") continue; // binary file
		const a = Number(added);
		const d = Number(deleted);
		if (Number.isNaN(a) || Number.isNaN(d)) continue;
		linesAdded += a;
		linesDeleted += d;
	}
	return { linesAdded, linesDeleted };
}

/**
 * Probe one repo's git state: `git status --porcelain=v1 --branch` via the
 * injectable GitRunner (like resolveWorktreeOf). Returns undefined on spawn
 * failure, nonzero exit, or unparseable output — the caller (supervisor
 * git-state polling) treats that as "no state", never as a clean repo. On
 * success a best-effort `git diff --numstat HEAD --` run is merged into
 * `git`: a failed numstat run (spawn error, nonzero exit — e.g. a fresh
 * repo without commits) leaves the line fields absent — never 0-by-default,
 * never fails the whole probe.
 */
export async function probeGitState(
	cwd: string,
	options?: GitOptions,
): Promise<GitState | undefined> {
	const exec = options?.exec ?? runGit;
	const result = await exec(["status", "--porcelain=v1", "--branch"], cwd).catch(() => null);
	if (!result || result.exitCode !== 0) return undefined;
	const state = parseGitStatePorcelain(result.stdout);
	if (state === undefined) return undefined;
	const numstat = await exec(["diff", "--numstat", "HEAD", "--"], cwd).catch(() => null);
	if (!numstat || numstat.exitCode !== 0) return state;
	return { ...state, git: { ...state.git, ...parseNumstat(numstat.stdout) } };
}
