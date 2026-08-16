/**
 * Managed-worktree path helpers + lifecycle (Phases 1 + 4).
 *
 * Managed worktrees live under the `workspaceDir` config knob (env
 * `OMP_FLEET_WORKSPACE_DIR`, flag `--workspace-dir`, default
 * `~/ompweb/workspaces`), one directory per repo basename, with the worktree
 * name slugged underneath:
 *
 *   <workspaceDir>/<repo-basename>/<slug(name)>
 *
 * When a directory under workspaceDir with the same basename already belongs
 * to a DIFFERENT repo realpath, the basename is suffixed with the first 4 hex
 * chars of the sha1 of the repo realpath (`omp-fleet-a1b2` style). Ownership
 * is recorded in a `<basename>/.ompweb-repo` marker file containing the
 * owning repo's realpath; the worktree-creation flow writes it, these helpers
 * only read it. Both helpers are pure/deterministic: the same inputs map to
 * the same path (sync fs checks allowed).
 *
 * The lifecycle half shells out to git ONLY (never fetches, never uses
 * --force / branch -D): resolveBaseRef, createWorktree,
 * listUnregisteredWorktrees, worktreeDeleteInfo, deleteWorktree, and the
 * registration/spawn orchestration shared by the /ctl routes and the edge
 * command handlers (registerWorktreeEntry). Deleting a worktree is guarded
 * by an ownership test (realpath under workspaceDir — nothing outside it is
 * ever removed) and a dirty check (`git status --porcelain`; no --force in
 * v1).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { ProjectEntry, RegisteredProject } from "../shared/protocol";
import { probeGitState, validateProjectPath } from "./discovery";
import type { Registry, RegistryEntry } from "./registry";
import type { SpawnSupervisor } from "./supervisor";

/** Marker file recording the repo realpath that owns a workspaceDir entry. */
const OMPWEB_REPO_MARKER = ".ompweb-repo";

/** Lowercase a worktree name; runs of non-alphanumerics become `-`, edges trimmed. */
export function slugifyWorktreeName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "worktree" : slug;
}

/**
 * Map a repo realpath + worktree name to its managed path under workspaceDir.
 * Basenames colliding with a different repo's directory (`.ompweb-repo`
 * marker naming another realpath) get a `-<sha1(repo)[0..4]>` suffix.
 */
export function managedWorktreePath(workspaceDir: string, repoRealpath: string, worktreeName: string): string {
	let repoBasename = basename(repoRealpath);
	const marker = join(workspaceDir, repoBasename, OMPWEB_REPO_MARKER);
	if (existsSync(marker)) {
		const owner = readFileSync(marker, "utf8").trim();
		if (owner !== repoRealpath) {
			const hash = createHash("sha1").update(repoRealpath).digest("hex").slice(0, 4);
			repoBasename = `${repoBasename}-${hash}`;
		}
	}
	return join(workspaceDir, repoBasename, slugifyWorktreeName(worktreeName));
}

/** Realpath of `p` (missing paths keep their normalized form). */
export function realpathOf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** True when `candidate` equals `root` or is strictly under it (segment-safe). */
export function isPathUnder(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ---------------------------------------------------------------------------
// Git shelling
// ---------------------------------------------------------------------------

/** Result of one `git -C <cwd> <args>` invocation. */
interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** `git -C <cwd> <args>` via Bun.spawn. Callers choose args — never a fetch. */
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

/** The target path already exists — createWorktree refuses. */
export class WorktreeTargetExistsError extends Error {
	constructor(readonly target: string) {
		super(`worktree target already exists: ${target}`);
	}
}

/** The branch is checked out in another worktree — cannot attach it. */
export class WorktreeBranchCheckedOutError extends Error {
	constructor(readonly branch: string) {
		super(`branch is already checked out elsewhere: ${branch}`);
	}
}

/** Result of a successful createWorktree. */
export interface CreateWorktreeResult {
	/** Managed path of the new worktree (under workspaceDir). */
	path: string;
	/** Branch the worktree is on (created slug or attached existing branch). */
	branch: string;
	/** The base ref the branch was created from (absent for existing-branch attach). */
	baseRef?: string;
}

/**
 * Create (or attach) a managed worktree for a registered project under
 * workspaceDir. The workspaceDir + repo directory are created lazily HERE
 * (first worktree creation). Refuses when the target path already exists,
 * when an existing branch is checked out in another worktree, or when git
 * rejects the operation (unknown branch/base). Writes the `.ompweb-repo`
 * ownership marker after a successful add. Returns `{ path, branch, baseRef }`.
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
		if (list.exitCode !== 0) throw new Error(`cannot read worktree list: ${list.stderr.trim() || `git exited ${list.exitCode}`}`);
		if (parseWorktreeList(list.stdout).some((block) => block.branch === want)) {
			throw new WorktreeBranchCheckedOutError(opts.existingBranch);
		}
		const verify = await runGit(["rev-parse", "--verify", want], project.path);
		if (verify.exitCode !== 0) throw new Error(`unknown branch: ${opts.existingBranch}`);
		const add = await runGit(["worktree", "add", target, opts.existingBranch], project.path);
		if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || `git exited ${add.exitCode}`}`);
	} else {
		const baseRef = opts.baseRef !== undefined && opts.baseRef !== "" ? opts.baseRef : await resolveBaseRef(project.path);
		const add = await runGit(["worktree", "add", "-b", slug, target, baseRef], project.path);
		if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || `git exited ${add.exitCode}`}`);
		writeFileSync(join(dirname(target), OMPWEB_REPO_MARKER), `${project.path}\n`);
		return { path: target, branch: slug, baseRef };
	}
	writeFileSync(join(dirname(target), OMPWEB_REPO_MARKER), `${project.path}\n`);
	return { path: target, branch: opts.existingBranch };
}

// ---------------------------------------------------------------------------
// Discovery + delete guards
// ---------------------------------------------------------------------------

/**
 * The project's LINKED worktrees (main checkout excluded) whose realpath is
 * not among `registeredPaths`. Feeds the "Add existing" tab.
 */
export async function listUnregisteredWorktrees(projectPath: string, registeredPaths: string[]): Promise<ProjectEntry[]> {
	const result = await runGit(["worktree", "list", "--porcelain"], projectPath);
	if (result.exitCode !== 0) return [];
	const blocks = parseWorktreeList(result.stdout);
	const main = blocks[0];
	if (!main) return [];
	const registered = new Set(registeredPaths.filter((p) => p !== "").map(realpathOf));
	const out: ProjectEntry[] = [];
	for (const block of blocks.slice(1)) {
		if (!block.path) continue;
		if (registered.has(realpathOf(block.path))) continue;
		const branch = branchOf(block.branch);
		out.push({
			name: basename(block.path),
			path: block.path,
			isWorktree: true,
			worktreeOf: basename(main.path ?? projectPath),
			...(branch !== undefined ? { branch } : {}),
		});
	}
	return out;
}

/**
 * Merge each registered project's unregistered linked worktrees into a
 * discovery scan. Shared by the edge's list_projects answer and GET
 * /ctl/projects so both surfaces list the same rows: a registered project
 * whose main checkout is OUTSIDE the discovery roots still contributes its
 * unmanaged worktrees. Rows are deduped by realpath against the discovery
 * rows (discovery wins on conflict — a worktree under a discovery root is
 * not listed twice) and against worktrees added by earlier projects; roster
 * cwds are excluded per project (a daemon on that worktree means it is
 * managed). Per-project git failures degrade to [] like
 * listUnregisteredWorktrees, so a project that stopped being a repo is
 * skipped silently.
 */
export async function mergeUnregisteredWorktrees(
	discovered: ProjectEntry[],
	projects: RegisteredProject[],
	rosterCwds: string[],
): Promise<ProjectEntry[]> {
	const out = [...discovered];
	const seen = new Set(out.map((entry) => realpathOf(entry.path)));
	for (const project of projects) {
		const worktrees = await listUnregisteredWorktrees(project.path, rosterCwds);
		for (const wt of worktrees) {
			const resolved = realpathOf(wt.path);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			out.push(wt);
		}
	}
	return out;
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
	const main = await mainRepoOf(path);
	if (main === null) return false;
	const mainResolved = realpathOf(main);
	return realpathOf(path) !== mainResolved && mainResolved === realpathOf(mainRepoPath);
}

/**
 * Validate an add-existing worktree path: an existing directory, a LINKED
 * worktree of `project` (not the main checkout), and not already registered
 * (no roster cwd realpath-equals it). Returns the realpath or throws with a
 * user-safe message.
 */
export async function validateUnregisteredWorktree(
	path: string,
	project: RegisteredProject,
	registeredCwds: string[],
): Promise<string> {
	const resolved = await validateProjectPath(path);
	if (resolved === null) throw new Error(`not a directory: ${path}`);
	if (!(await isLinkedWorktreeOf(resolved, project.path))) {
		throw new Error(`not a linked worktree of ${project.name}: ${path}`);
	}
	const registered = new Set(registeredCwds.filter((cwd) => cwd !== "").map(realpathOf));
	if (registered.has(resolved)) throw new Error(`worktree already registered: ${path}`);
	return resolved;
}

/** Guard evidence for the delete confirmation (worktree_delete_info frame). */
export interface WorktreeDeleteInfo {
	/** True when the worktree's realpath is under the fleet workspaceDir. */
	owned: boolean;
	/** True when git status shows any change (added/modified/deleted/untracked). */
	dirty: boolean;
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
	/** Why deletion would be refused (not owned / dirty / missing path). */
	reason?: string;
}

/**
 * Guard evidence for deleting one worktree path: ownership (realpath under
 * workspaceDir), dirty counts (probeGitState), and the branch's
 * merged/unpushed state vs the main repo's base ref. Never deletes anything.
 */
export async function worktreeDeleteInfo(path: string, workspaceDir: string): Promise<WorktreeDeleteInfo> {
	if (path === "") return { owned: false, dirty: false, reason: "entry has no worktree path" };
	const ws = realpathOf(workspaceDir);
	const resolved = realpathOf(path);
	if (!isPathUnder(resolved, ws)) {
		return { owned: false, dirty: false, reason: "not a managed worktree (path outside workspaceDir)" };
	}
	if (!existsSync(resolved)) {
		return { owned: true, dirty: false, reason: "worktree path does not exist" };
	}
	const state = await probeGitState(resolved);
	const counts = state?.git;
	const dirty =
		counts !== undefined && (counts.added > 0 || counts.modified > 0 || counts.deleted > 0 || counts.untracked > 0);
	const info: WorktreeDeleteInfo = { owned: true, dirty };
	if (state !== undefined) {
		info.git = { ...state.git };
		if (state.branch !== undefined) {
			info.branch = state.branch;
			const mainPath = await mainRepoOf(resolved);
			if (mainPath !== null && realpathOf(mainPath) !== resolved) {
				info.merged = await branchMergedInto(mainPath, state.branch, await resolveBaseRef(mainPath));
				info.unpushed = await branchUnpushed(resolved);
			}
		}
	}
	if (dirty) info.reason = "worktree has uncommitted changes";
	return info;
}

/** True when `branch`'s tip is reachable from `baseRef` (git branch --merged). */
async function branchMergedInto(repoPath: string, branch: string, baseRef: string): Promise<boolean> {
	const result = await runGit(["branch", "--merged", baseRef], repoPath);
	if (result.exitCode !== 0) return false;
	for (const line of result.stdout.split("\n")) {
		// Current branch is prefixed with `*`; `+` marks the checked-out branch.
		if (line.replace(/^[*+]/, "").trim() === branch) return true;
	}
	return false;
}

/**
 * True when the worktree's branch has commits not in its upstream
 * (`git rev-list --count @{u}..HEAD`). A branch with NO upstream reports
 * false (the push state is unknown).
 */
async function branchUnpushed(worktreePath: string): Promise<boolean> {
	const result = await runGit(["rev-list", "--count", "@{u}..HEAD"], worktreePath);
	if (result.exitCode !== 0) return false;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(count) && count > 0;
}

/** Deletion was refused: the path is not under workspaceDir (403-class). */
export class WorktreeNotOwnedError extends Error {
	constructor(readonly path: string) {
		super(`not a managed worktree (path outside workspaceDir): ${path}`);
	}
}

/** Deletion was refused: the worktree has uncommitted changes (409-class, no --force in v1). */
export class WorktreeDirtyError extends Error {
	constructor(readonly path: string) {
		super(`worktree has uncommitted changes: ${path}`);
	}
}

/** What deleteWorktree removed. */
export interface DeleteWorktreeResult {
	/** The removed worktree path (unchanged when the path was already gone). */
	path: string;
	/** Branch the worktree was on (absent when detached or already gone). */
	branch?: string;
	/** False when a requested branch deletion was refused by `git branch -d`. */
	branchDeleted?: boolean;
}

/**
 * Remove a managed worktree: ownership + dirty guards FIRST (no --force in
 * v1; nothing outside workspaceDir is ever removed), then `git worktree
 * remove`, then optionally `git branch -d` (NEVER -D — an unmerged branch is
 * left in place and reported via `branchDeleted: false`). A path that no
 * longer exists is a no-op success (nothing to remove).
 */
export async function deleteWorktree(
	path: string,
	workspaceDir: string,
	opts: { deleteBranch?: boolean } = {},
): Promise<DeleteWorktreeResult> {
	if (path === "") throw new WorktreeNotOwnedError(path);
	const resolved = realpathOf(path);
	if (!isPathUnder(resolved, realpathOf(workspaceDir))) throw new WorktreeNotOwnedError(path);
	if (!existsSync(resolved)) return { path: resolved };
	const state = await probeGitState(resolved);
	if (
		state?.git !== undefined &&
		(state.git.added > 0 || state.git.modified > 0 || state.git.deleted > 0 || state.git.untracked > 0)
	) {
		throw new WorktreeDirtyError(path);
	}
	const mainPath = await mainRepoOf(resolved);
	if (mainPath === null) throw new Error(`cannot resolve the worktree's repository: ${path}`);
	const remove = await runGit(["worktree", "remove", resolved], mainPath);
	if (remove.exitCode !== 0) {
		throw new Error(`git worktree remove failed: ${remove.stderr.trim() || `git exited ${remove.exitCode}`}`);
	}
	const result: DeleteWorktreeResult = { path: resolved };
	const branch = state?.branch;
	if (branch !== undefined) {
		result.branch = branch;
		if (opts.deleteBranch) {
			// -d only: an unmerged branch is refused by git and left in place.
			const del = await runGit(["branch", "-d", branch], mainPath);
			result.branchDeleted = del.exitCode === 0;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Roster registration + spawn orchestration (shared by /ctl + edge)
// ---------------------------------------------------------------------------

/**
 * Register a roster entry for an existing worktree path and optionally spawn
 * a daemon on it (start:true). Shared by the /ctl route and the edge command
 * handler. The entry is mode "spawned", tagged with the project's projectId
 * and name; when start:false it is registered asleep (wakeable via
 * spawn_resume — the supervisor only spawns, attach is client-side).
 */
export async function registerWorktreeEntry(
	registry: Registry,
	supervisor: SpawnSupervisor,
	project: RegisteredProject,
	worktreePath: string,
	opts: { start?: boolean },
): Promise<RegistryEntry> {
	if (opts.start) {
		// supervisor.spawn creates the entry (worktreeOf auto-resolved from
		// git) and launches the child; tag the project id right after.
		const entry = await supervisor.spawn({ cwd: worktreePath });
		registry.update(entry.daemonId, { projectId: project.projectId, worktreeOf: project.name });
		return registry.get(entry.daemonId) ?? entry;
	}
	// Mirror supervisor.spawn's field shape (name/project = worktree
	// basename) so a started and an unstarted worktree render identically
	// except status; worktreeOf carries the owning project's name.
	return registry.create({
		name: basename(worktreePath),
		cwd: worktreePath,
		project: basename(worktreePath),
		worktreeOf: project.name,
		projectId: project.projectId,
		labels: [],
		mode: "spawned",
		status: "asleep",
	});
}
