/**
 * Managed-worktree path helpers + lifecycle (Phases 1 + 4).
 *
 * Managed worktrees live under the `workspaceDir` config knob (env
 * `OMP_FLEET_WORKSPACE_DIR`, flag `--workspace-dir`, default
 * `~/.omp-web/workspaces`), one directory per repo basename, with the worktree
 * name slugged underneath:
 *
 *   <workspaceDir>/<repo-basename>/<slug(name)>
 *
 * Repositories with the same basename share that directory. Creation refuses
 * an existing target path; no repository collision detection is performed.
 *
 * The lifecycle half shells out to git ONLY (never fetches, never uses
 * --force / branch -D): resolveBaseRef, createWorktree, resolveProjectRoot,
 * listProjectBranches, worktreeDeleteInfo, deleteWorktree, and the
 * registration/spawn orchestration shared by the /ctl routes and the edge
 * command handlers (registerWorktreeEntry). Deleting a worktree requires a
 * local linked Git worktree of its project (verified independently) and a
 * clean `git status --porcelain` (never --force). The cleanliness probe
 * fails CLOSED: an unreadable git state refuses the delete instead of
 * proceeding on `git worktree remove` alone.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { ProjectBranch, RegisteredProject } from "#lib/wire/protocol";
import { slugifyWorktreeName, worktreeBranchName } from "#lib/wire/worktree-name";
import { parseWorktreeList, probeGitState, runGit, validateProjectPath } from "./discovery";
import type { GitRunner, WorktreeBlock } from "./discovery";
import type { Registry, RegistryEntry } from "./registry";
import type { WorkspaceLifecycle } from "./workspace-lifecycle";

/** Map a repo realpath + worktree name to its managed path under workspaceDir. */
export function managedWorktreePath(
	workspaceDir: string,
	repoRealpath: string,
	worktreeName: string,
): string {
	return join(workspaceDir, basename(repoRealpath), slugifyWorktreeName(worktreeName));
}

/**
 * Realpath of `p` (missing paths keep their normalized form). `memo`, when
 * given, caches results for one caller's pass so each path resolves once; a
 * fresh memo per pass, since the filesystem may change between passes.
 */
export function realpathOf(p: string, memo?: Map<string, string>): string {
	const cached = memo?.get(p);
	if (cached !== undefined) return cached;
	let resolved: string;
	try {
		resolved = realpathSync(p);
	} catch {
		resolved = resolve(p);
	}
	memo?.set(p, resolved);
	return resolved;
}

/** True when `candidate` equals `root` or is strictly under it (segment-safe). */
export function isPathUnder(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `refs/heads/x` → "x"; absent (detached or bare) → undefined. */
function branchOf(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return raw.startsWith("refs/heads/") ? raw.slice("refs/heads/".length) : raw;
}

// ---------------------------------------------------------------------------
// Base ref + creation
// ---------------------------------------------------------------------------

/**
 * Resolve the base ref for a new worktree: the remote default branch
 * (`git symbolic-ref refs/remotes/origin/HEAD`, `refs/remotes/origin/`
 * prefix stripped), else the checkout's current branch
 * (`git symbolic-ref --short HEAD`), else `HEAD`. NEVER fetches.
 */
export async function resolveBaseRef(repoPath: string): Promise<string> {
	const origin = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath);
	if (origin.exitCode === 0) {
		const ref = origin.stdout.trim();
		const prefix = "refs/remotes/origin/";
		return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
	}
	const local = await runGit(["symbolic-ref", "--short", "HEAD"], repoPath);
	if (local.exitCode === 0 && local.stdout.trim() !== "") return local.stdout.trim();
	return "HEAD";
}

/** The target path already exists, so createWorktree refuses. */
export class WorktreeTargetExistsError extends Error {
	constructor(readonly target: string) {
		super(`worktree target already exists: ${target}`);
	}
}

/** The branch is checked out in another worktree, so it cannot be attached. */
export class WorktreeBranchCheckedOutError extends Error {
	constructor(readonly branch: string) {
		super(`branch is already checked out elsewhere: ${branch}`);
	}
}

/** Result of a successful createWorktree. */
export interface CreateWorktreeResult {
	/** Managed path of the new worktree (under workspaceDir). */
	path: string;
	/** Branch the worktree is on (created from the typed name, or the attached existing branch). */
	branch: string;
	/** The base ref the branch was created from (absent for existing-branch attach). */
	baseRef?: string;
}

/**
 * Create (or attach) a linked worktree for a registered project under
 * workspaceDir. The workspaceDir + repo directory are created lazily HERE
 * (first worktree creation). Refuses when the target path already exists,
 * when an existing branch is checked out in another worktree, or when git
 * rejects the operation (unknown branch/base). Returns `{ path, branch, baseRef }`.
 */
export async function createWorktree(
	project: RegisteredProject,
	name: string,
	opts: { workspaceDir: string; baseRef?: string; existingBranch?: string },
): Promise<CreateWorktreeResult> {
	const slug = slugifyWorktreeName(name);
	const target = managedWorktreePath(opts.workspaceDir, project.path, slug);
	if (existsSync(target)) throw new WorktreeTargetExistsError(target);
	// Lazy first use: the workspace root + this repo's directory.
	mkdirSync(dirname(target), { recursive: true });

	if (opts.existingBranch !== undefined) {
		const want = `refs/heads/${opts.existingBranch}`;
		const list = await runGit(["worktree", "list", "--porcelain"], project.path);
		if (list.exitCode !== 0)
			throw new Error(
				`cannot read worktree list: ${list.stderr.trim() || `git exited ${list.exitCode}`}`,
			);
		if (parseWorktreeList(list.stdout).some((block) => block.branch === want)) {
			throw new WorktreeBranchCheckedOutError(opts.existingBranch);
		}
		const verify = await runGit(["rev-parse", "--verify", want], project.path);
		if (verify.exitCode !== 0) throw new Error(`unknown branch: ${opts.existingBranch}`);
		const add = await runGit(["worktree", "add", target, opts.existingBranch], project.path);
		if (add.exitCode !== 0)
			throw new Error(
				`git worktree add failed: ${add.stderr.trim() || `git exited ${add.exitCode}`}`,
			);
	} else {
		const branch = worktreeBranchName(name);
		const valid = await runGit(["check-ref-format", "--branch", branch], project.path);
		if (valid.exitCode !== 0) throw new Error(`invalid branch name: ${branch}`);
		const baseRef =
			opts.baseRef !== undefined && opts.baseRef !== ""
				? opts.baseRef
				: await resolveBaseRef(project.path);
		const add = await runGit(["worktree", "add", "-b", branch, target, baseRef], project.path);
		if (add.exitCode !== 0)
			throw new Error(
				`git worktree add failed: ${add.stderr.trim() || `git exited ${add.exitCode}`}`,
			);
		return { path: target, branch, baseRef };
	}
	return { path: target, branch: opts.existingBranch };
}

/** A project's branch listing (the list_project_branches answer). */
export interface ProjectBranchListing {
	branches: ProjectBranch[];
	/** Configured remote names, `origin` first. */
	remotes: string[];
	/** Base for a new branch: resolveBaseRef's display name (origin's default, else the current branch). */
	defaultBase?: string;
	/** Remote listings only: true when the live `ls-remote` failed and the answer comes from the last fetch. */
	cached?: boolean;
}

/**
 * List a registered project's branches for the branch picker. Without
 * `remote` (this machine): local branches with their checked-out state.
 * With `remote`: that remote's heads from a read-only `git ls-remote
 * --symref` (bounded by the runGit timeout); when the remote cannot be
 * reached, its cached `refs/remotes/<remote>/*` refs with `cached: true`.
 * The remote name is checked against `git remote` and passed as an argv
 * element, never shell-interpolated. NEVER fetches.
 */
export async function listProjectBranches(
	mainPath: string,
	opts: { remote?: string } = {},
): Promise<ProjectBranchListing> {
	const remotes = await listRemotes(mainPath);
	if (opts.remote === undefined) {
		return {
			branches: await localBranches(mainPath),
			remotes,
			defaultBase: await resolveBaseRef(mainPath),
		};
	}
	if (!remotes.includes(opts.remote)) throw new Error(`unknown remote: ${opts.remote}`);
	const live = await liveRemoteHeads(mainPath, opts.remote);
	const heads = live ?? (await cachedRemoteHeads(mainPath, opts.remote));
	return {
		branches: heads.branches.map((name) => ({ name, checkedOut: false })),
		remotes,
		defaultBase: heads.defaultBase,
		...(live === undefined ? { cached: true } : {}),
	};
}

/** Configured remote names (`git remote`), `origin` first. */
async function listRemotes(mainPath: string): Promise<string[]> {
	const result = await runGit(["remote"], mainPath);
	if (result.exitCode !== 0) return [];
	const names = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((name) => name !== "");
	return names.includes("origin")
		? ["origin", ...names.filter((name) => name !== "origin")]
		: names;
}

/** Local branches with their checked-out state (`for-each-ref refs/heads` + worktree list). */
async function localBranches(mainPath: string): Promise<ProjectBranch[]> {
	const refs = await runGit(["for-each-ref", "refs/heads", "--format=%(refname:short)"], mainPath);
	if (refs.exitCode !== 0) {
		throw new Error(`cannot list branches: ${refs.stderr.trim() || `git exited ${refs.exitCode}`}`);
	}
	const names = refs.stdout.trim() === "" ? [] : refs.stdout.trim().split("\n");
	const worktrees = await runGit(["worktree", "list", "--porcelain"], mainPath);
	if (worktrees.exitCode !== 0) {
		throw new Error(
			`cannot list branches: ${worktrees.stderr.trim() || `git exited ${worktrees.exitCode}`}`,
		);
	}
	// A branch is checked out in at most one worktree (git refuses a second
	// checkout), so per-branch overwrite is safe.
	const checkedOut = new Map<string, string>();
	for (const block of parseWorktreeList(worktrees.stdout)) {
		const name = branchOf(block.branch);
		if (name !== undefined && block.path !== undefined) checkedOut.set(name, block.path);
	}
	return names.map((name) => {
		const worktreePath = checkedOut.get(name);
		return worktreePath === undefined
			? { name, checkedOut: false }
			: { name, checkedOut: true, worktreePath };
	});
}

/**
 * Heads of `remote` from a live, read-only `git ls-remote --symref` (the HEAD
 * symref names the remote's default branch). Undefined when the remote cannot
 * be reached (network, auth, timeout): the caller falls back to the cache.
 */
async function liveRemoteHeads(
	mainPath: string,
	remote: string,
): Promise<{ branches: string[]; defaultBase?: string } | undefined> {
	const result = await runGit(["ls-remote", "--symref", remote, "HEAD", "refs/heads/*"], mainPath);
	if (result.exitCode !== 0) return undefined;
	const branches: string[] = [];
	let defaultBase: string | undefined;
	for (const line of result.stdout.split("\n")) {
		// `ref: refs/heads/main<TAB>HEAD` (symref) or `<sha><TAB>refs/heads/<name>`.
		const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
		if (symref) {
			defaultBase = symref[1];
			continue;
		}
		const name = /\trefs\/heads\/(.+)$/.exec(line)?.[1];
		if (name !== undefined) branches.push(name);
	}
	return { branches, defaultBase };
}

/** Heads from the last fetch: local `refs/remotes/<remote>/*` (the HEAD symref excluded). */
async function cachedRemoteHeads(
	mainPath: string,
	remote: string,
): Promise<{ branches: string[]; defaultBase?: string }> {
	const prefix = `refs/remotes/${remote}/`;
	const refs = await runGit(["for-each-ref", "--format=%(refname)", prefix], mainPath);
	const branches = refs.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((ref) => ref.startsWith(prefix))
		.map((ref) => ref.slice(prefix.length))
		.filter((name) => name !== "HEAD");
	const head = await runGit(["symbolic-ref", `${prefix}HEAD`], mainPath);
	const headRef = head.stdout.trim();
	const defaultBase =
		head.exitCode === 0 && headRef.startsWith(prefix) ? headRef.slice(prefix.length) : undefined;
	return { branches, defaultBase };
}

// ---------------------------------------------------------------------------
// Discovery + delete guards
// ---------------------------------------------------------------------------

/**
 * Parsed `git worktree list --porcelain` for the repository containing
 * `path`, main checkout first; undefined when git cannot tell (not a
 * repository, git failure). Shared by the sync pass and the resolvers.
 */
export async function listWorktreeBlocks(path: string): Promise<WorktreeBlock[] | undefined> {
	const result = await runGit(["worktree", "list", "--porcelain"], path);
	return result.exitCode === 0 ? parseWorktreeList(result.stdout) : undefined;
}

/**
 * Resolve any path inside a project checkout (its main checkout, a linked
 * worktree, or a subdirectory of either) to the MAIN checkout's realpath:
 * the project identity registry.addProject stores. Throws a user-facing
 * Error for a missing path, a non-git path, or a bare repository (it has no
 * main working tree to register).
 */
export async function resolveProjectRoot(path: string): Promise<string> {
	const resolved = await validateProjectPath(path);
	if (resolved === null) throw new Error(`not a directory: ${path}`);
	const main = (await listWorktreeBlocks(resolved))?.[0];
	if (main === undefined) throw new Error(`not a git repository: ${path}`);
	if (main.bare || main.path === undefined) {
		throw new Error(`bare repository has no main checkout to register: ${path}`);
	}
	return realpathOf(main.path);
}

/**
 * The main checkout path of the repository owning `path`, or null when git
 * cannot tell (not a repo / git failure).
 */
async function mainRepoOf(path: string): Promise<string | null> {
	const result = await runGit(["worktree", "list", "--porcelain"], path);
	if (result.exitCode !== 0) return null;
	return parseWorktreeList(result.stdout)[0]?.path ?? null;
}

/**
 * True when `path` is a LINKED worktree (not the main checkout) of the
 * repository whose main checkout is `mainRepoPath`.
 */
export async function isLinkedWorktreeOf(path: string, mainRepoPath: string): Promise<boolean> {
	const list = await runGit(["worktree", "list", "--porcelain"], path);
	if (list.exitCode !== 0) return false;
	const blocks = parseWorktreeList(list.stdout);
	const main = blocks[0]?.path;
	if (main === undefined) return false;
	const resolved = realpathOf(path);
	const mainResolved = realpathOf(main);
	return (
		resolved !== mainResolved &&
		mainResolved === realpathOf(mainRepoPath) &&
		blocks.slice(1).some((block) => block.path !== undefined && realpathOf(block.path) === resolved)
	);
}

/**
 * The registered project owning `cwd`: its main checkout, or one of its
 * linked worktrees, or undefined when no registered project matches.
 * Realpath-compared; a spawn on an unregistered path stays untagged (the
 * roster shows only rows with a projectId). Used to stamp projectId on
 * spawns that arrive with just a cwd (the sidebar start action, /ctl/spawn).
 */
export async function projectIdForCwd(
	projects: RegisteredProject[],
	cwd: string,
): Promise<string | undefined> {
	const resolved = realpathOf(cwd);
	for (const project of projects) {
		if (realpathOf(project.path) === resolved) return project.projectId;
	}
	for (const project of projects) {
		if (await isLinkedWorktreeOf(resolved, project.path)) return project.projectId;
	}
	return undefined;
}

/** Guard evidence for the delete confirmation (worktree_delete_info frame). */
export interface WorktreeDeleteInfo {
	/** True only for a local linked Git worktree of its project with valid identity. */
	linked: boolean;
	/** True when git status shows any change (added/modified/deleted/untracked). */
	dirty: boolean;
	/** True when git could not be probed: the state is unproven, so deletion is refused. */
	probeFailed?: boolean;
	/** Per-file dirty counts (absent when git could not be probed). */
	git?: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
	/** Current branch (absent when detached or unreadable). */
	branch?: string;
	/** True when the branch tip is an ancestor of the main repo's base ref. */
	merged?: boolean;
	/** True when the branch has commits not in its upstream (false when no upstream). */
	unpushed?: boolean;
	/** True when the branch tracks an upstream; false means the remote state is unknown, not pushed. */
	hasUpstream?: boolean;
	/** Why the worktree's own branch cannot be deleted (protected base branch, or detached HEAD); absent when deletable. */
	branchDeleteRefused?: string;
	/** Changed paths from `git status --porcelain` (first 100; the counts stay exact). Absent when clean. */
	files?: string[];
	/** Why deletion would be refused (not linked / dirty / missing path / unreadable git state). */
	reason?: string;
}

/**
 * Guard evidence for a registered worktree: linked Git worktree identity,
 * dirty counts, and merged/unpushed branch state.
 * An unreadable git probe yields `probeFailed` evidence (nothing proves the
 * worktree is clean), never a deletable verdict. The configured creation
 * root is not deletion authority.
 */
export async function worktreeDeleteInfo(
	entry: RegistryEntry,
	opts: { probeExec?: GitRunner } = {},
): Promise<WorktreeDeleteInfo> {
	const path = entry.cwd;
	if (path === "") return { linked: false, dirty: false, reason: "entry has no worktree path" };
	if (entry.workspace?.kind !== "worktree") {
		return { linked: false, dirty: false, reason: "not a local linked worktree" };
	}
	const resolved = realpathOf(path);
	if (resolved !== resolve(path)) {
		return { linked: false, dirty: false, reason: "worktree path resolves through a symlink" };
	}
	if (!existsSync(resolved)) {
		return { linked: false, dirty: false, reason: "worktree path does not exist" };
	}
	// Legacy records carry no source.local; Git names the main checkout.
	const mainPath = entry.workspace.source?.local ?? (await mainRepoOf(resolved));
	if (mainPath === null || !(await isLinkedWorktreeOf(resolved, mainPath))) {
		return { linked: false, dirty: false, reason: "path is not a linked Git worktree" };
	}
	const state = await probeGitState(resolved, { exec: opts.probeExec });
	if (state === undefined) {
		// Fail closed: nothing proves the worktree clean (or dirty), so the
		// evidence is explicitly unproven and the confirm refuses to delete.
		return {
			linked: true,
			dirty: false,
			probeFailed: true,
			reason: "worktree git state could not be read; deleting is refused",
		};
	}
	const counts = state.git;
	const dirty =
		counts.added > 0 || counts.modified > 0 || counts.deleted > 0 || counts.untracked > 0;
	const info: WorktreeDeleteInfo = { linked: true, dirty };
	info.git = { ...state.git };
	if (dirty) info.files = await dirtyFiles(resolved, opts.probeExec);
	if (state.branch !== undefined) {
		info.branch = state.branch;
		info.merged = await branchMergedInto(mainPath, state.branch, await resolveBaseRef(mainPath));
		const upstream = await branchUpstream(resolved);
		info.hasUpstream = upstream.hasUpstream;
		info.unpushed = upstream.unpushed;
	}
	const refused = await ownBranchRefusal(mainPath, state.branch);
	if (refused !== undefined) info.branchDeleteRefused = refused;
	if (dirty) info.reason = "worktree has uncommitted changes";
	return info;
}

/** True when `branch`'s tip is reachable from `baseRef` (git branch --merged). */
async function branchMergedInto(
	repoPath: string,
	branch: string,
	baseRef: string,
): Promise<boolean> {
	const result = await runGit(["branch", "--merged", baseRef], repoPath);
	if (result.exitCode !== 0) return false;
	for (const line of result.stdout.split("\n")) {
		// Current branch is prefixed with `*`; `+` marks the checked-out branch.
		if (line.replace(/^[*+]/, "").trim() === branch) return true;
	}
	return false;
}

/** Changed paths from `git status --porcelain=v1` (first 100; counts are exact elsewhere). */
async function dirtyFiles(worktreePath: string, exec: GitRunner = runGit): Promise<string[]> {
	const result = await exec(["status", "--porcelain=v1"], worktreePath).catch(() => null);
	if (!result || result.exitCode !== 0) return [];
	return result.stdout
		.split("\n")
		.filter((line) => line.length > 3)
		.map((line) => line.slice(3))
		.slice(0, 100);
}

/**
 * Upstream state of the worktree's branch. `hasUpstream` is false when the
 * branch tracks nothing (remote state unknown, never "pushed"); `unpushed`
 * counts commits not in `@{u}` and is false without an upstream.
 */
async function branchUpstream(
	worktreePath: string,
): Promise<{ hasUpstream: boolean; unpushed: boolean }> {
	const upstream = await runGit(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
		worktreePath,
	);
	if (upstream.exitCode !== 0) return { hasUpstream: false, unpushed: false };
	const result = await runGit(["rev-list", "--count", "@{u}..HEAD"], worktreePath);
	if (result.exitCode !== 0) return { hasUpstream: true, unpushed: false };
	const count = Number.parseInt(result.stdout.trim(), 10);
	return { hasUpstream: true, unpushed: Number.isFinite(count) && count > 0 };
}

/** Deletion was refused: the worktree has uncommitted changes (409-class, no --force in v1). */
export class WorktreeDirtyError extends Error {
	constructor(readonly path: string) {
		super(`worktree has uncommitted changes: ${path}`);
	}
}

/**
 * Deletion was refused: `git status` in the worktree could not be read, so a
 * clean tree cannot be proven. Fails closed (no --force, no removal attempt).
 */
export class WorktreeProbeFailedError extends Error {
	constructor(readonly path: string) {
		super(`worktree cleanliness could not be verified (git state unreadable): ${path}`);
	}
}

/** What deleteWorktree removed. */
export interface DeleteWorktreeResult {
	/** The removed worktree path. */
	path: string;
	/** Branch the worktree was on (absent when detached). */
	branch?: string;
	/** Set only when a branch was requested: true when `git branch -d` removed it. */
	branchDeleted?: boolean;
	/** Why the requested branch was left in place (another branch, protected, detached, or git refused). */
	branchDeleteRefused?: string;
}

/**
 * Remove a local linked Git worktree after its identity and dirty guards.
 * With `opts.deleteBranch`, the branch step runs ONLY when the branch the
 * worktree is checked out on (probed here, not remembered) equals that name
 * and the branch is not protected; otherwise the branch is left in place and
 * the reason is reported. Branch removal uses `git branch -d` (never -D). An
 * unreadable git state refuses the delete (fail closed) instead of removing
 * on identity alone.
 *
 * `probeExec` overrides the git runner used for the cleanliness probe ONLY
 * (tests inject a failing one); the linked-worktree identity check and the
 * removal itself always use real git.
 */
export async function deleteWorktree(
	entry: RegistryEntry,
	opts: { deleteBranch?: string; probeExec?: GitRunner } = {},
): Promise<DeleteWorktreeResult> {
	const path = entry.cwd;
	if (path === "" || entry.workspace?.kind !== "worktree") {
		throw new Error(`not a local linked worktree: ${path}`);
	}
	const resolved = realpathOf(path);
	if (resolved !== resolve(path))
		throw new Error(`worktree path resolves through a symlink: ${path}`);
	if (!existsSync(resolved)) throw new Error(`worktree path does not exist: ${path}`);
	const mainPath = entry.workspace.source?.local ?? (await mainRepoOf(resolved));
	if (mainPath === null || !(await isLinkedWorktreeOf(resolved, mainPath))) {
		throw new Error(`path is not a linked Git worktree: ${path}`);
	}
	const state = await probeGitState(resolved, { exec: opts.probeExec });
	if (state === undefined) throw new WorktreeProbeFailedError(path);
	if (
		state.git.added > 0 ||
		state.git.modified > 0 ||
		state.git.deleted > 0 ||
		state.git.untracked > 0
	) {
		throw new WorktreeDirtyError(path);
	}
	const remove = await runGit(["worktree", "remove", resolved], mainPath);
	if (remove.exitCode !== 0) {
		throw new Error(
			`git worktree remove failed: ${remove.stderr.trim() || `git exited ${remove.exitCode}`}`,
		);
	}
	const result: DeleteWorktreeResult = { path: resolved };
	const branch = state.branch;
	if (branch !== undefined) result.branch = branch;
	const requested = opts.deleteBranch;
	if (requested) {
		const refused = await branchDeleteRefusal(mainPath, branch, requested);
		if (refused === undefined) {
			const del = await runGit(["branch", "-d", requested], mainPath);
			result.branchDeleted = del.exitCode === 0;
			if (del.exitCode !== 0) {
				result.branchDeleteRefused = `git refused to delete ${requested}: ${del.stderr.trim() || `git exited ${del.exitCode}`}`;
			}
		} else {
			result.branchDeleted = false;
			result.branchDeleteRefused = refused;
		}
	}
	return result;
}

/**
 * Why `requested` must not be deleted after its worktree is removed
 * (undefined = deletable). Only the branch the worktree is ON is eligible: a
 * worktree switched to another branch leaves the requested one in place.
 */
async function branchDeleteRefusal(
	mainPath: string,
	branch: string | undefined,
	requested: string,
): Promise<string | undefined> {
	if (branch !== requested) {
		const on = branch ?? "a detached HEAD";
		return `worktree is on ${on}, not ${requested}; ${requested} was left in place`;
	}
	return ownBranchRefusal(mainPath, branch);
}

/**
 * Why the worktree's OWN branch must not be deleted (undefined = deletable):
 * a detached HEAD has no branch, and a protected branch is never deleted.
 * Protected: resolveBaseRef's branch (origin's default branch when origin HEAD
 * is set, else the main checkout's branch) and the main checkout's current
 * branch.
 */
async function ownBranchRefusal(
	mainPath: string,
	branch: string | undefined,
): Promise<string | undefined> {
	if (branch === undefined) return "worktree is on a detached HEAD; there is no branch to delete";
	const current = await runGit(["symbolic-ref", "--short", "HEAD"], mainPath);
	const protectedNames = [await resolveBaseRef(mainPath)];
	if (current.exitCode === 0) protectedNames.push(current.stdout.trim());
	if (protectedNames.includes(branch)) {
		return `${branch} is a base branch of this project and is never deleted`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Roster registration + spawn orchestration (shared by /ctl + edge)
// ---------------------------------------------------------------------------

/** The slice of the workspace lifecycle (host runtime) that roster registration drives. */
export type HostSessions = Pick<
	WorkspaceLifecycle,
	"spawnHost" | "ensureHostRunning" | "resolveTemplateName"
>;

/**
 * Register a roster entry for an existing worktree path and optionally spawn
 * a daemon on it (start:true). Shared by the /ctl route, the edge command
 * handler, and the sync pass (which adopts worktrees created outside
 * omp-web). The entry is tagged with the project's projectId and name; when
 * start:false it is registered asleep (wakeable via spawn_resume; the
 * lifecycle only spawns, attach is client-side).
 */
export async function registerWorktreeEntry(
	registry: Registry,
	host: HostSessions,
	project: RegisteredProject,
	worktreePath: string,
	opts: { start?: boolean } = {},
): Promise<RegistryEntry> {
	if (opts.start) {
		// host.spawnHost creates the entry (worktreeOf auto-resolved from
		// git) and launches the child; tag the project id right after.
		const entry = await host.spawnHost({ cwd: worktreePath, reuse: true });
		registry.update(entry.daemonId, {
			projectId: project.projectId,
			worktreeOf: project.name,
			workspace: {
				...entry.workspace,
				kind: "worktree",
				projectId: project.projectId,
				source: { local: project.path },
				desiredState: "running",
			},
		});
		return registry.get(entry.daemonId) ?? entry;
	}
	// Mirror spawnHost's field shape (name/project = worktree
	// basename) so a started and an unstarted worktree render identically
	// except status; worktreeOf carries the owning project's name. The
	// resolved template NAME is stored like spawnHost stores it; ensureHostRunning
	// keys off entry.template.
	return registry.create({
		name: basename(worktreePath),
		cwd: worktreePath,
		project: basename(worktreePath),
		worktreeOf: project.name,
		projectId: project.projectId,
		workspace: {
			kind: "worktree",
			projectId: project.projectId,
			source: { local: project.path },
			desiredState: "stopped",
		},
		labels: [],
		status: "asleep",
		template: host.resolveTemplateName(worktreePath),
	});
}

/**
 * Register the DEFAULT WORKSPACE of a registered project: a roster entry for
 * the repo's main checkout, mapped to the repo CWD. The main checkout is the
 * repo itself, so this never creates anything under workspaceDir. With
 * opts.start the main checkout is spawned via the host runtime (template/labels
 * passthrough) and the fresh entry is tagged with the projectId; otherwise it
 * is registered asleep (kind "direct") and wakeable via spawn_resume/attach;
 * a respawn with no lastSessionFile is a fresh start. An existing row for the
 * checkout (realpath match) is reused. Shared by the /ctl route, the edge
 * command handler, and the sync pass.
 */
export async function registerProjectMainEntry(
	registry: Registry,
	host: HostSessions,
	project: RegisteredProject,
	opts: { start?: boolean; template?: string; labels?: string[]; realpaths?: Map<string, string> },
): Promise<RegistryEntry> {
	// Dedup: an entry already mapped to this repo's realpath IS the default
	// workspace; reuse it, never create a second row for the same checkout.
	const existing = registry
		.list()
		.find((entry) => realpathOf(entry.cwd, opts.realpaths) === project.path);
	if (existing !== undefined) {
		if (existing.projectId === undefined) {
			registry.update(existing.daemonId, { projectId: project.projectId });
		}
		if (opts.start && existing.status === "asleep") {
			await host.ensureHostRunning(existing);
		}
		return registry.get(existing.daemonId) ?? existing;
	}
	if (opts.start) {
		// host.spawnHost creates the entry (resolveWorktreeOf leaves main
		// checkouts untagged) and launches the child; tag the project id
		// right after.
		const entry = await host.spawnHost({
			cwd: project.path,
			template: opts.template,
			labels: opts.labels,
			reuse: true,
		});
		registry.update(entry.daemonId, { projectId: project.projectId });
		return registry.get(entry.daemonId) ?? entry;
	}
	// Mirror spawnHost's field shape for the main checkout (name and
	// project = the repo name) so a started and an unstarted default
	// workspace render identically except status, including the resolved
	// template NAME (respawn keys off entry.template). NO worktreeOf: main
	// checkouts stay untagged; SidebarGroups' hasMain depends on that.
	return registry.create({
		name: project.name,
		cwd: project.path,
		project: project.name,
		projectId: project.projectId,
		labels: opts.labels ?? [],
		status: "asleep",
		template: host.resolveTemplateName(project.path, opts.template),
	});
}
