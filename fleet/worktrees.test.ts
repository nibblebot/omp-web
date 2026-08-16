import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredProject } from "../shared/protocol";
import { Registry } from "./registry";
import {
	createWorktree,
	deleteWorktree,
	isLinkedWorktreeOf,
	listUnregisteredWorktrees,
	managedWorktreePath,
	registerWorktreeEntry,
	resolveBaseRef,
	slugifyWorktreeName,
	WorktreeBranchCheckedOutError,
	WorktreeDirtyError,
	WorktreeNotOwnedError,
	WorktreeTargetExistsError,
	worktreeDeleteInfo,
} from "./worktrees";

const tmpDirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-fleet-worktrees-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function sha1Prefix(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 4);
}

/** One `git -C <cwd> <args>` invocation (real git; repos are local + hermetic). */
async function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
	]);
	return { exitCode: await proc.exited, stdout, stderr };
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A local repo with one commit on `main` (no remote). */
async function makeRepo(dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await gitOk(dir, ["init", "-q", "-b", "main"]);
	await gitOk(dir, ["config", "user.email", "test@example.com"]);
	await gitOk(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await gitOk(dir, ["add", "."]);
	await gitOk(dir, ["commit", "-q", "-m", "init"]);
}

/** A repo cloned from a local file:// remote — clone sets origin/HEAD. */
async function makeClonedRepo(): Promise<{ clone: string }> {
	const remote = tmpDir();
	const clone = tmpDir();
	await makeRepo(remote);
	await gitOk(remote, ["clone", "-q", `file://${remote}`, clone]);
	return { clone };
}

function projectFor(repoPath: string, projectId = "p1"): RegisteredProject {
	return { projectId, path: repoPath, name: repoPath.split("/").pop()!, addedAt: 0 };
}

/** The repo's main-checkout path owning `worktreePath` (porcelain block 0). */
async function mainRepoOf(path: string): Promise<string | null> {
	const result = await git(path, ["worktree", "list", "--porcelain"]);
	if (result.exitCode !== 0) return null;
	const line = result.stdout.split("\n").find((l) => l.startsWith("worktree "));
	return line ? line.slice("worktree ".length) : null;
}

describe("slugifyWorktreeName", () => {
	test("lowercases and turns runs of non-alphanumerics into single dashes", () => {
		expect(slugifyWorktreeName("My Feature Branch")).toBe("my-feature-branch");
		expect(slugifyWorktreeName("feat/UI (v2)!")).toBe("feat-ui-v2");
		expect(slugifyWorktreeName("feature__with___underscores")).toBe("feature-with-underscores");
	});

	test("trims leading and trailing dashes", () => {
		expect(slugifyWorktreeName("--Foo--")).toBe("foo");
		expect(slugifyWorktreeName("--foo")).toBe("foo");
		expect(slugifyWorktreeName("foo--")).toBe("foo");
		expect(slugifyWorktreeName("!! heading !!")).toBe("heading");
	});

	test("falls back to `worktree` when nothing alphanumeric remains", () => {
		expect(slugifyWorktreeName("")).toBe("worktree");
		expect(slugifyWorktreeName("   ")).toBe("worktree");
		expect(slugifyWorktreeName("!!!")).toBe("worktree");
		expect(slugifyWorktreeName("日本語")).toBe("worktree");
	});

	test("keeps digits", () => {
		expect(slugifyWorktreeName("Fix 2026/Q1")).toBe("fix-2026-q1");
	});
});

describe("managedWorktreePath", () => {
	test("composes <workspaceDir>/<repo-basename>/<slug(name)>", () => {
		const ws = tmpDir();
		expect(managedWorktreePath(ws, "/home/u/src/omp-fleet", "Feature Branch")).toBe(
			join(ws, "omp-fleet", "feature-branch"),
		);
	});

	test("no suffix when no marker exists", () => {
		const ws = tmpDir();
		expect(managedWorktreePath(ws, "/home/u/src/omp-fleet", "x")).toBe(join(ws, "omp-fleet", "x"));
	});

	test("no suffix when the marker names the same repo realpath", () => {
		const ws = tmpDir();
		const repo = "/home/u/src/omp-fleet";
		const dir = join(ws, "omp-fleet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".ompweb-repo"), `${repo}\n`);
		expect(managedWorktreePath(ws, repo, "x")).toBe(join(ws, "omp-fleet", "x"));
	});

	test("suffixes the basename with a sha1 prefix when a different repo owns the directory", () => {
		const ws = tmpDir();
		const repoA = "/home/u/src/omp-fleet";
		const repoB = "/home/v/src/omp-fleet";
		const dir = join(ws, "omp-fleet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".ompweb-repo"), repoA);
		expect(managedWorktreePath(ws, repoB, "x")).toBe(join(ws, `omp-fleet-${sha1Prefix(repoB)}`, "x"));
	});

	test("deterministic: the same inputs always map to the same path", () => {
		const ws = tmpDir();
		const repoA = "/home/u/src/omp-fleet";
		const repoB = "/home/v/src/omp-fleet";
		const dir = join(ws, "omp-fleet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".ompweb-repo"), repoA);
		const first = managedWorktreePath(ws, repoB, "My Branch");
		expect(first).toBe(join(ws, `omp-fleet-${sha1Prefix(repoB)}`, "my-branch"));
		expect(managedWorktreePath(ws, repoB, "My Branch")).toBe(first);
	});
});

describe("resolveBaseRef", () => {
	test("returns the origin default branch when origin/HEAD is set (no fetch)", async () => {
		const { clone } = await makeClonedRepo();
		expect(await resolveBaseRef(clone)).toBe("main");
	});

	test("falls back to the local checkout's current branch without a remote", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		expect(await resolveBaseRef(repo)).toBe("main");
	});

	test("falls back to HEAD on a detached checkout", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		await gitOk(repo, ["checkout", "-q", "--detach", "HEAD"]);
		expect(await resolveBaseRef(repo)).toBe("HEAD");
	});
});

describe("createWorktree", () => {
	test("creates the managed worktree: slug path, branch, marker, base ref", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const created = await createWorktree(projectFor(repo), "Feature Branch", { workspaceDir: ws });
		const target = join(ws, repo.split("/").pop()!, "feature-branch");
		expect(created.path).toBe(target);
		expect(created.branch).toBe("feature-branch");
		expect(created.baseRef).toBe("main");
		expect(existsSync(target)).toBe(true);
		// Ownership marker records the owning repo realpath.
		expect(readFileSync(join(ws, repo.split("/").pop()!, ".ompweb-repo"), "utf8").trim()).toBe(repo);
		// git agrees: the worktree is listed and the branch exists at base's commit.
		const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
		expect(list).toContain(`worktree ${target}`);
		expect(list).toContain("branch refs/heads/feature-branch");
		expect((await gitOk(repo, ["rev-parse", "--verify", "refs/heads/feature-branch"]))).toBe(
			await gitOk(repo, ["rev-parse", "refs/heads/main"]),
		);
	});

	test("refuses when the target path already exists", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		await createWorktree(projectFor(repo), "dup", { workspaceDir: ws });
		await expect(createWorktree(projectFor(repo), "dup", { workspaceDir: ws })).rejects.toBeInstanceOf(
			WorktreeTargetExistsError,
		);
		// A pre-existing directory at the target also refuses.
		const target = join(ws, repo.split("/").pop()!, "occupied");
		mkdirSync(target, { recursive: true });
		await expect(createWorktree(projectFor(repo), "occupied", { workspaceDir: ws })).rejects.toBeInstanceOf(
			WorktreeTargetExistsError,
		);
	});

	test("refuses an existing branch that is checked out elsewhere", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		// `main` is checked out in the main checkout — cannot attach it.
		await expect(
			createWorktree(projectFor(repo), "x", { workspaceDir: ws, existingBranch: "main" }),
		).rejects.toBeInstanceOf(WorktreeBranchCheckedOutError);
	});

	test("attaches an existing not-checked-out branch", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		await gitOk(repo, ["branch", "feature"]);
		const ws = tmpDir();
		const created = await createWorktree(projectFor(repo), "attach-me", { workspaceDir: ws, existingBranch: "feature" });
		expect(created.branch).toBe("feature");
		expect(created.baseRef).toBeUndefined();
		const target = join(ws, repo.split("/").pop()!, "attach-me");
		expect(existsSync(target)).toBe(true);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(`branch refs/heads/feature`);
	});

	test("refuses an unknown existing branch", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		await expect(
			createWorktree(projectFor(repo), "x", { workspaceDir: ws, existingBranch: "nope" }),
		).rejects.toThrow(/unknown branch: nope/);
	});
});

describe("listUnregisteredWorktrees", () => {
	test("lists linked worktrees minus registered paths, never the main checkout", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "alpha", { workspaceDir: ws });
		const b = await createWorktree(projectFor(repo), "beta", { workspaceDir: ws });
		// Nothing registered: both linked worktrees, main checkout excluded.
		const all = await listUnregisteredWorktrees(repo, []);
		expect(all).toHaveLength(2);
		const paths = all.map((p) => p.path);
		expect(paths).toContain(a.path);
		expect(paths).toContain(b.path);
		expect(paths.some((p) => p === repo)).toBe(false);
		for (const entry of all) {
			expect(entry.isWorktree).toBe(true);
			expect(entry.worktreeOf).toBe(repo.split("/").pop()!);
			expect(typeof entry.branch).toBe("string");
		}
		// One registered: only the other remains.
		const rest = await listUnregisteredWorktrees(repo, [a.path]);
		expect(rest).toHaveLength(1);
		expect(rest[0].path).toBe(b.path);
	});

	test("degrades to an empty list when git cannot read the repo", async () => {
		const notARepo = tmpDir();
		expect(await listUnregisteredWorktrees(notARepo, [])).toEqual([]);
	});
});

describe("isLinkedWorktreeOf", () => {
	test("true only for a linked worktree of the given main checkout", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const other = tmpDir();
		await makeRepo(other);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "alpha", { workspaceDir: ws });
		expect(await isLinkedWorktreeOf(a.path, repo)).toBe(true);
		expect(await isLinkedWorktreeOf(repo, repo)).toBe(false); // main checkout is not a linked worktree
		expect(await isLinkedWorktreeOf(a.path, other)).toBe(false); // owned by a different repo
	});
});

describe("worktreeDeleteInfo", () => {
	test("rejects an out-of-tree path as not owned", async () => {
		const outside = tmpDir();
		expect(await worktreeDeleteInfo(outside, tmpDir())).toEqual({
			owned: false,
			dirty: false,
			reason: "not a managed worktree (path outside workspaceDir)",
		});
	});

	test("clean managed worktree: owned, clean, merged, no upstream", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "clean", { workspaceDir: ws });
		const info = await worktreeDeleteInfo(a.path, ws);
		expect(info.owned).toBe(true);
		expect(info.dirty).toBe(false);
		expect(info.git).toEqual({ added: 0, modified: 0, deleted: 0, untracked: 0 });
		expect(info.branch).toBe("clean");
		expect(info.merged).toBe(true); // no commits: tip is the base's tip
		expect(info.unpushed).toBe(false); // no upstream: unknown → false
	});

	test("dirty worktree reports counts and a refusal reason", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "dirty", { workspaceDir: ws });
		writeFileSync(join(a.path, "scratch.txt"), "new\n");
		const info = await worktreeDeleteInfo(a.path, ws);
		expect(info.owned).toBe(true);
		expect(info.dirty).toBe(true);
		expect(info.git?.untracked).toBe(1);
		expect(info.reason).toBe("worktree has uncommitted changes");
	});

	test("unmerged branch with unpushed commits reports both", async () => {
		const { clone } = await makeClonedRepo();
		const ws = tmpDir();
		const a = await createWorktree(projectFor(clone), "feat", { workspaceDir: ws });
		// A local commit ahead of origin/main, upstream set: unpushed.
		writeFileSync(join(a.path, "new.txt"), "n\n");
		await gitOk(a.path, ["add", "."]);
		await gitOk(a.path, ["commit", "-q", "-m", "feat"]);
		await gitOk(a.path, ["branch", "--set-upstream-to=origin/main"]);
		const info = await worktreeDeleteInfo(a.path, ws);
		expect(info.owned).toBe(true);
		expect(info.dirty).toBe(false);
		expect(info.branch).toBe("feat");
		expect(info.merged).toBe(false); // feat is not reachable from main
		expect(info.unpushed).toBe(true); // 1 commit ahead of origin/main
	});

	test("missing path under workspaceDir reports owned with a not-found reason", async () => {
		const ws = tmpDir();
		const info = await worktreeDeleteInfo(join(ws, "repo", "ghost"), ws);
		expect(info.owned).toBe(true);
		expect(info.dirty).toBe(false);
		expect(info.reason).toBe("worktree path does not exist");
	});
});

describe("deleteWorktree", () => {
	test("removes a clean managed worktree and -d's a merged branch", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "gone", { workspaceDir: ws });
		const result = await deleteWorktree(a.path, ws, { deleteBranch: true });
		expect(result.path).toBe(a.path);
		expect(result.branch).toBe("gone");
		expect(result.branchDeleted).toBe(true);
		expect(existsSync(a.path)).toBe(false);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(a.path);
		expect((await gitOk(repo, ["branch", "--list", "gone"]))).toBe("");
	});

	test("refuses a dirty worktree (no --force), leaving it in place", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "keep", { workspaceDir: ws });
		writeFileSync(join(a.path, "scratch.txt"), "new\n");
		await expect(deleteWorktree(a.path, ws, { deleteBranch: true })).rejects.toBeInstanceOf(WorktreeDirtyError);
		expect(existsSync(a.path)).toBe(true);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(a.path);
	});

	test("refuses a path outside workspaceDir — nothing out-of-tree is ever removed", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		// A plain directory outside the workspace root.
		const outside = tmpDir();
		await expect(deleteWorktree(outside, ws)).rejects.toBeInstanceOf(WorktreeNotOwnedError);
		expect(existsSync(outside)).toBe(true);
		// A REAL git worktree created outside workspaceDir is refused too.
		const rogue = join(tmpDir(), "rogue");
		await gitOk(repo, ["worktree", "add", "-b", "rogue", rogue]);
		await expect(deleteWorktree(rogue, ws)).rejects.toBeInstanceOf(WorktreeNotOwnedError);
		expect(existsSync(rogue)).toBe(true);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(rogue);
	});

	test("never -D: an unmerged branch survives branch -d", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "unmerged", { workspaceDir: ws });
		writeFileSync(join(a.path, "new.txt"), "n\n");
		await gitOk(a.path, ["add", "."]);
		await gitOk(a.path, ["commit", "-q", "-m", "unmerged"]);
		const result = await deleteWorktree(a.path, ws, { deleteBranch: true });
		expect(existsSync(a.path)).toBe(false);
		expect(result.branch).toBe("unmerged");
		expect(result.branchDeleted).toBe(false); // git branch -d refused (unmerged)
		expect((await gitOk(repo, ["branch", "--list", "unmerged"]))).toBe("unmerged");
	});

	test("a missing path is a no-op success", async () => {
		const ws = tmpDir();
		const ghost = join(ws, "repo", "ghost");
		const result = await deleteWorktree(ghost, ws);
		expect(result.path).toBe(ghost);
	});
});

describe("registerWorktreeEntry", () => {
	test("start:false registers an asleep spawned entry tagged with the project", async () => {
		const repo = tmpDir();
		await makeRepo(repo);
		const ws = tmpDir();
		const a = await createWorktree(projectFor(repo), "tagged", { workspaceDir: ws });
		const registry = new Registry(join(tmpDir(), "state.json"));
		await registry.load();
		const entry = await registerWorktreeEntry(registry, {} as never, projectFor(repo, "p7"), a.path, { start: false });
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
		expect(entry.cwd).toBe(a.path);
		expect(entry.projectId).toBe("p7");
		expect(entry.worktreeOf).toBe(repo.split("/").pop()!);
		expect(registry.get(entry.daemonId)).toBeDefined();
	});
});
