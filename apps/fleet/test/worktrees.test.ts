import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RegisteredProject } from "#lib/wire/protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { slugifyWorktreeName, worktreeBranchName } from "#lib/wire/worktree-name";
import type { GitRunner } from "../discovery";
import { Registry, type RegistryEntry } from "../registry";
import {
	createWorktree,
	deleteWorktree,
	type HostSessions,
	isLinkedWorktreeOf,
	listProjectBranches,
	listWorktreeBlocks,
	managedWorktreePath,
	registerProjectMainEntry,
	registerWorktreeEntry,
	resolveBaseRef,
	resolveProjectRoot,
	WorktreeBranchCheckedOutError,
	WorktreeDirtyError,
	WorktreeProbeFailedError,
	WorktreeTargetExistsError,
	worktreeDeleteInfo,
} from "../worktrees";

afterAll(cleanupTempDirs);

/** One `git -C <cwd> <args>` invocation (real git; repos are local + hermetic). */
async function git(
	cwd: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

/** A repo cloned from a local file:// remote, so clone sets origin/HEAD. */
async function makeClonedRepo(): Promise<{ clone: string }> {
	const remote = tempDir("omp-web-worktrees-");
	const clone = tempDir("omp-web-worktrees-");
	await makeRepo(remote);
	await gitOk(remote, ["clone", "-q", `file://${remote}`, clone]);
	return { clone };
}

function projectFor(repoPath: string, projectId = "p1"): RegisteredProject {
	return { projectId, path: repoPath, name: repoPath.split("/").pop()!, addedAt: 0 };
}

function worktreeEntry(path: string, repoPath?: string): RegistryEntry {
	return {
		workspaceId: "d1",
		name: basename(path),
		cwd: path,
		project: "repo",
		status: "asleep",
		registeredAt: 0,
		workspace: {
			kind: "worktree",
			projectId: "p1",
			desiredState: "stopped",
			...(repoPath !== undefined ? { source: { local: repoPath } } : {}),
		},
	};
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

describe("worktreeBranchName", () => {
	test("keeps `/`, lowercases, dashes other runs", () => {
		expect(worktreeBranchName("feat/login x")).toBe("feat/login-x");
		expect(worktreeBranchName("Feature Branch")).toBe("feature-branch");
	});

	test("drops components and suffixes git refuses", () => {
		expect(worktreeBranchName("a//b")).toBe("a/b");
		expect(worktreeBranchName(".hidden/x.lock")).toBe("hidden/x");
		expect(worktreeBranchName("x..y")).toBe("x.y");
		expect(worktreeBranchName("feat/ ok ")).toBe("feat/ok");
	});

	test("falls back to the folder slug when nothing usable remains", () => {
		expect(worktreeBranchName("///")).toBe("worktree");
	});
});

describe("managedWorktreePath", () => {
	test("composes <workspaceDir>/<repo-basename>/<slug(name)>", () => {
		const ws = tempDir("omp-web-worktrees-");
		expect(managedWorktreePath(ws, "/home/u/src/omp-web", "Feature Branch")).toBe(
			join(ws, "omp-web", "feature-branch"),
		);
	});
});

describe("resolveBaseRef", () => {
	test("returns the origin default branch when origin/HEAD is set (no fetch)", async () => {
		const { clone } = await makeClonedRepo();
		expect(await resolveBaseRef(clone)).toBe("main");
	});

	test("falls back to the local checkout's current branch without a remote", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		expect(await resolveBaseRef(repo)).toBe("main");
	});

	test("falls back to HEAD on a detached checkout", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		await gitOk(repo, ["checkout", "-q", "--detach", "HEAD"]);
		expect(await resolveBaseRef(repo)).toBe("HEAD");
	});
});

describe("createWorktree", () => {
	test("creates the worktree: slug path, branch, no marker, base ref", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const created = await createWorktree(projectFor(repo), "feat/Login fix", { workspaceDir: ws });
		// Folder is the slug; the branch keeps `/`.
		const target = join(ws, repo.split("/").pop()!, "feat-login-fix");
		expect(created.path).toBe(target);
		expect(created.branch).toBe("feat/login-fix");
		expect(created.baseRef).toBe("main");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(ws, basename(repo), ".omp-web-repo"))).toBe(false);
		// git agrees: the worktree is listed and the branch exists at base's commit.
		const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
		expect(list).toContain(`worktree ${target}`);
		expect(list).toContain("branch refs/heads/feat/login-fix");
		expect(await gitOk(repo, ["rev-parse", "--verify", "refs/heads/feat/login-fix"])).toBe(
			await gitOk(repo, ["rev-parse", "refs/heads/main"]),
		);
	});

	test("same-basename repos share a parent without markers and reject an occupied target", async () => {
		const root = tempDir("omp-web-worktrees-");
		const repoA = join(root, "a", "repo");
		const repoB = join(root, "b", "repo");
		for (const repo of [repoA, repoB]) {
			mkdirSync(repo, { recursive: true });
			await gitOk(repo, ["init", "-q", "-b", "main"]);
			writeFileSync(join(repo, "readme.md"), "hello\n");
			await gitOk(repo, ["add", "."]);
			await gitOk(repo, ["commit", "-q", "-m", "init"]);
		}
		const ws = tempDir("omp-web-worktrees-");
		const projectA = projectFor(repoA, "a");
		const projectB = projectFor(repoB, "b");
		const first = await createWorktree(projectA, "First Feature", { workspaceDir: ws });
		const second = await createWorktree(projectB, "Second Feature", { workspaceDir: ws });
		expect(first.path).toBe(join(ws, "repo", "first-feature"));
		expect(second.path).toBe(join(ws, "repo", "second-feature"));
		expect(existsSync(join(ws, "repo", ".omp-web-repo"))).toBe(false);
		expect(await mainRepoOf(first.path)).toBe(repoA);
		expect(await mainRepoOf(second.path)).toBe(repoB);
		writeFileSync(join(first.path, "readme.md"), "original worktree edits\n");
		writeFileSync(join(first.path, "scratch.txt"), "original untracked work\n");
		const firstHead = await gitOk(first.path, ["rev-parse", "HEAD"]);
		const firstRegistration = await gitOk(repoA, ["worktree", "list", "--porcelain"]);
		const secondRegistration = await gitOk(repoB, ["worktree", "list", "--porcelain"]);
		await expect(
			createWorktree(projectB, "First Feature", { workspaceDir: ws }),
		).rejects.toBeInstanceOf(WorktreeTargetExistsError);
		expect(readFileSync(join(first.path, "readme.md"), "utf8")).toBe("original worktree edits\n");
		expect(readFileSync(join(first.path, "scratch.txt"), "utf8")).toBe("original untracked work\n");
		expect(await gitOk(first.path, ["rev-parse", "HEAD"])).toBe(firstHead);
		expect(await gitOk(repoA, ["worktree", "list", "--porcelain"])).toBe(firstRegistration);
		expect(await gitOk(repoB, ["worktree", "list", "--porcelain"])).toBe(secondRegistration);
		expect(
			(await git(repoB, ["show-ref", "--verify", "refs/heads/first-feature"])).exitCode,
		).not.toBe(0);
		expect(existsSync(join(ws, "repo", ".omp-web-repo"))).toBe(false);
	});

	test("refuses when the target path already exists", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		await createWorktree(projectFor(repo), "dup", { workspaceDir: ws });
		await expect(
			createWorktree(projectFor(repo), "dup", { workspaceDir: ws }),
		).rejects.toBeInstanceOf(WorktreeTargetExistsError);
		// A pre-existing directory at the target also refuses.
		const target = join(ws, repo.split("/").pop()!, "occupied");
		mkdirSync(target, { recursive: true });
		await expect(
			createWorktree(projectFor(repo), "occupied", { workspaceDir: ws }),
		).rejects.toBeInstanceOf(WorktreeTargetExistsError);
	});

	test("refuses an existing branch that is checked out elsewhere", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		// `main` is checked out in the main checkout, so it cannot be attached.
		await expect(
			createWorktree(projectFor(repo), "x", { workspaceDir: ws, existingBranch: "main" }),
		).rejects.toBeInstanceOf(WorktreeBranchCheckedOutError);
	});

	test("attaches an existing not-checked-out branch", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		await gitOk(repo, ["branch", "feature"]);
		const ws = tempDir("omp-web-worktrees-");
		const created = await createWorktree(projectFor(repo), "attach-me", {
			workspaceDir: ws,
			existingBranch: "feature",
		});
		expect(created.branch).toBe("feature");
		expect(created.baseRef).toBeUndefined();
		const target = join(ws, repo.split("/").pop()!, "attach-me");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(ws, basename(repo), ".omp-web-repo"))).toBe(false);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(
			`branch refs/heads/feature`,
		);
	});

	test("refuses an unknown existing branch", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		await expect(
			createWorktree(projectFor(repo), "x", { workspaceDir: ws, existingBranch: "nope" }),
		).rejects.toThrow(/unknown branch: nope/);
	});
});

describe("listWorktreeBlocks", () => {
	test("lists every worktree block, the main checkout first", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "listed-a", { workspaceDir: ws });
		const blocks = await listWorktreeBlocks(repo);
		expect(blocks?.map((block) => block.path)).toEqual([repo, a.path]);
	});

	test("is undefined when git cannot read the path", async () => {
		expect(await listWorktreeBlocks(tempDir("omp-web-worktrees-"))).toBeUndefined();
	});
});

describe("resolveProjectRoot", () => {
	test("resolves a main checkout, a linked worktree, and a subdirectory to the main checkout", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const linked = await createWorktree(projectFor(repo), "rooted", { workspaceDir: ws });
		mkdirSync(join(repo, "nested"));
		expect(await resolveProjectRoot(repo)).toBe(repo);
		expect(await resolveProjectRoot(linked.path)).toBe(repo);
		expect(await resolveProjectRoot(join(repo, "nested"))).toBe(repo);
	});

	test("refuses non-git, missing, and bare paths with a user-facing reason", async () => {
		const plain = tempDir("omp-web-worktrees-");
		await expect(resolveProjectRoot(plain)).rejects.toThrow(`not a git repository: ${plain}`);
		const missing = join(plain, "ghost");
		await expect(resolveProjectRoot(missing)).rejects.toThrow(`not a directory: ${missing}`);
		const bareParent = tempDir("omp-web-worktrees-");
		const bare = join(bareParent, "bare.git");
		await gitOk(bareParent, ["init", "-q", "--bare", bare]);
		await expect(resolveProjectRoot(bare)).rejects.toThrow(
			`bare repository has no main checkout to register: ${bare}`,
		);
	});
});

describe("listProjectBranches", () => {
	test("reports local branches with checkout state, remotes origin-first, and the default base", async () => {
		const { clone } = await makeClonedRepo();
		const ws = tempDir("omp-web-worktrees-");
		await gitOk(clone, ["branch", "topic"]);
		const linked = await createWorktree(projectFor(clone), "wt", { workspaceDir: ws });
		const listing = await listProjectBranches(clone);
		const byName = new Map(listing.branches.map((branch) => [branch.name, branch]));
		expect(byName.get("main")?.checkedOut).toBe(true);
		expect(byName.get("wt")).toMatchObject({ checkedOut: true, worktreePath: linked.path });
		expect(byName.get("topic")?.checkedOut).toBe(false);
		expect(listing.remotes).toEqual(["origin"]);
		expect(listing.defaultBase).toBe("main");
		expect(listing.cached).toBeUndefined();
	});

	test("lists a remote's live branches", async () => {
		const { clone } = await makeClonedRepo();
		const listing = await listProjectBranches(clone, { remote: "origin" });
		expect(listing.branches.map((branch) => branch.name)).toContain("main");
		expect(listing.cached).toBeUndefined();
	});

	test("falls back to cached remote-tracking branches when the live probe fails", async () => {
		const { clone } = await makeClonedRepo();
		const missing = join(tempDir("omp-web-worktrees-"), "gone.git");
		await gitOk(clone, ["remote", "set-url", "origin", missing]);
		const listing = await listProjectBranches(clone, { remote: "origin" });
		expect(listing.cached).toBe(true);
		expect(listing.branches.map((branch) => branch.name)).toContain("main");
	});

	test("an unknown remote is refused by name", async () => {
		const { clone } = await makeClonedRepo();
		await expect(listProjectBranches(clone, { remote: "nope" })).rejects.toThrow(
			"unknown remote: nope",
		);
	});
});

describe("isLinkedWorktreeOf", () => {
	test("true only for a linked worktree of the given main checkout", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const other = tempDir("omp-web-worktrees-");
		await makeRepo(other);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "alpha", { workspaceDir: ws });
		expect(await isLinkedWorktreeOf(a.path, repo)).toBe(true);
		expect(await isLinkedWorktreeOf(repo, repo)).toBe(false); // main checkout is not a linked worktree
		expect(await isLinkedWorktreeOf(a.path, other)).toBe(false); // linked to a different repo
		mkdirSync(join(a.path, "nested"));
		expect(await isLinkedWorktreeOf(join(a.path, "nested"), repo)).toBe(false);
	});
});

describe("worktreeDeleteInfo", () => {
	test("a plain directory without repository provenance is not a linked worktree", async () => {
		const outside = tempDir("omp-web-worktrees-");
		expect(await worktreeDeleteInfo(worktreeEntry(outside))).toEqual({
			linked: false,
			dirty: false,
			reason: "path is not a linked Git worktree",
		});
	});

	test("clean linked worktree: linked, clean, merged, no upstream", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "clean", { workspaceDir: ws });
		const info = await worktreeDeleteInfo(worktreeEntry(a.path, repo));
		expect(info.linked).toBe(true);
		expect(info.dirty).toBe(false);
		expect(info.git).toEqual({
			added: 0,
			modified: 0,
			deleted: 0,
			untracked: 0,
			linesAdded: 0,
			linesDeleted: 0,
		});
		expect(info.branch).toBe("clean");
		expect(info.merged).toBe(true); // no commits: tip is the base's tip
		expect(info.unpushed).toBe(false); // no upstream: unknown → false
		expect(info.hasUpstream).toBe(false); // no upstream: remote state unknown
	});

	test("dirty worktree reports counts and a refusal reason", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "dirty", { workspaceDir: ws });
		writeFileSync(join(a.path, "scratch.txt"), "new\n");
		const info = await worktreeDeleteInfo(worktreeEntry(a.path, repo));
		expect(info.linked).toBe(true);
		expect(info.dirty).toBe(true);
		expect(info.git?.untracked).toBe(1);
		expect(info.files).toEqual(["scratch.txt"]);
		expect(info.reason).toBe("worktree has uncommitted changes");
	});

	test("an unreadable git probe reports unproven evidence that refuses deletion", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "unproven-info", { workspaceDir: ws });
		const entry = worktreeEntry(a.path, repo);
		// Spawn failure / nonzero exit: no git state, so nothing proves cleanliness.
		const failingProbe: GitRunner = async () => ({
			exitCode: 128,
			stdout: "",
			stderr: "fatal: not a git repository",
		});
		expect(await worktreeDeleteInfo(entry, { probeExec: failingProbe })).toEqual({
			linked: true,
			dirty: false,
			probeFailed: true,
			reason: "worktree git state could not be read; deleting is refused",
		});
		// A readable probe reports the same worktree without the marker.
		const readable = await worktreeDeleteInfo(entry);
		expect(readable).toMatchObject({ linked: true, dirty: false });
		expect(readable.probeFailed).toBeUndefined();
		expect(readable.branch).toBe("unproven-info");
	});

	test("unmerged branch with unpushed commits reports both", async () => {
		const { clone } = await makeClonedRepo();
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(clone), "feat", { workspaceDir: ws });
		// A local commit ahead of origin/main, upstream set: unpushed.
		writeFileSync(join(a.path, "new.txt"), "n\n");
		await gitOk(a.path, ["add", "."]);
		await gitOk(a.path, ["commit", "-q", "-m", "feat"]);
		await gitOk(a.path, ["branch", "--set-upstream-to=origin/main"]);
		const info = await worktreeDeleteInfo(worktreeEntry(a.path, clone));
		expect(info.linked).toBe(true);
		expect(info.dirty).toBe(false);
		expect(info.branch).toBe("feat");
		expect(info.merged).toBe(false); // feat is not reachable from main
		expect(info.unpushed).toBe(true); // 1 commit ahead of origin/main
		expect(info.hasUpstream).toBe(true);
	});

	test("missing path refuses deletion with a not-found reason", async () => {
		const ws = tempDir("omp-web-worktrees-");
		const info = await worktreeDeleteInfo(worktreeEntry(join(ws, "repo", "ghost")));
		expect(info.linked).toBe(false);
		expect(info.dirty).toBe(false);
		expect(info.reason).toBe("worktree path does not exist");
	});
});

describe("deleteWorktree", () => {
	test("removes a clean linked worktree and -d's a merged branch", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "gone", { workspaceDir: ws });
		const result = await deleteWorktree(worktreeEntry(a.path, repo), { deleteBranch: "gone" });
		expect(result.path).toBe(a.path);
		expect(result.branch).toBe("gone");
		expect(result.branchDeleted).toBe(true);
		expect(existsSync(a.path)).toBe(false);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(a.path);
		expect(await gitOk(repo, ["branch", "--list", "gone"])).toBe("");
	});

	test("refuses a dirty worktree (no --force), leaving it in place", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "keep", { workspaceDir: ws });
		writeFileSync(join(a.path, "scratch.txt"), "new\n");
		await expect(
			deleteWorktree(worktreeEntry(a.path, repo), { deleteBranch: "keep" }),
		).rejects.toBeInstanceOf(WorktreeDirtyError);
		expect(existsSync(a.path)).toBe(true);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(a.path);
	});

	test("an unreadable git probe fails closed: no removal, branch untouched", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "unproven", { workspaceDir: ws });
		const entry = worktreeEntry(a.path, repo);
		const branchBefore = await gitOk(repo, ["rev-parse", "refs/heads/unproven"]);
		// Spawn failure / nonzero exit: no git state, so cleanliness is unproven.
		const failingProbe = async (): Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}> => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
		const refusal = deleteWorktree(entry, {
			deleteBranch: "unproven",
			probeExec: failingProbe,
		});
		await expect(refusal).rejects.toBeInstanceOf(WorktreeProbeFailedError);
		await expect(refusal).rejects.toThrow("cleanliness could not be verified");
		expect(existsSync(a.path)).toBe(true);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(a.path);
		expect(await gitOk(repo, ["rev-parse", "refs/heads/unproven"])).toBe(branchBefore);
	});

	test("deletes a clean attached linked worktree", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const { path } = await createWorktree(projectFor(repo), "attached", { workspaceDir: ws });
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(path);
		const entry = worktreeEntry(path, repo);
		expect((await worktreeDeleteInfo(entry)).linked).toBe(true);
		await deleteWorktree(entry);
		expect(existsSync(path)).toBe(false);
		expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(path);
	});

	test("never -D: an unmerged branch survives branch -d", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "unmerged", { workspaceDir: ws });
		writeFileSync(join(a.path, "new.txt"), "n\n");
		await gitOk(a.path, ["add", "."]);
		await gitOk(a.path, ["commit", "-q", "-m", "unmerged"]);
		const result = await deleteWorktree(worktreeEntry(a.path, repo), {
			deleteBranch: "unmerged",
		});
		expect(existsSync(a.path)).toBe(false);
		expect(result.branch).toBe("unmerged");
		expect(result.branchDeleted).toBe(false); // git branch -d refused (unmerged)
		expect(await gitOk(repo, ["branch", "--list", "unmerged"])).toBe("unmerged");
	});

	test("a missing linked path is refused", async () => {
		const ghost = join(tempDir("omp-web-worktrees-"), "repo", "ghost");
		await expect(deleteWorktree(worktreeEntry(ghost))).rejects.toThrow(
			"worktree path does not exist",
		);
	});

	test("a registered linked worktree remains deletable after the configured creation root changes", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const oldRoot = tempDir("omp-web-worktrees-");
		const created = await createWorktree(projectFor(repo), "registered", { workspaceDir: oldRoot });
		const entry = await registerWorktreeEntry(
			registry,
			{ resolveTemplateName: () => "test" } as unknown as HostSessions,
			projectFor(repo),
			created.path,
		);
		const newRoot = tempDir("omp-web-worktrees-");
		await createWorktree(projectFor(repo), "new-root", { workspaceDir: newRoot });
		expect((await worktreeDeleteInfo(entry)).linked).toBe(true);
		await deleteWorktree(entry);
		expect(existsSync(created.path)).toBe(false);
	});

	test("the main checkout and a plain directory are not deletable linked worktrees", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		for (const path of [repo, tempDir("omp-web-worktrees-")]) {
			const entry = worktreeEntry(path, repo);
			expect(await worktreeDeleteInfo(entry)).toMatchObject({
				linked: false,
				reason: "path is not a linked Git worktree",
			});
			await expect(deleteWorktree(entry)).rejects.toThrow("not a linked Git worktree");
			expect(existsSync(path)).toBe(true);
		}
	});

	test("symlink substitution cannot authorize removal of another repository's linked worktree", async () => {
		const repo = join(tempDir("omp-web-worktrees-"), "repo");
		await makeRepo(repo);
		const externalRepo = join(tempDir("omp-web-worktrees-"), "repo");
		await makeRepo(externalRepo);
		const created = await createWorktree(projectFor(repo), "original", {
			workspaceDir: tempDir("omp-web-worktrees-"),
		});
		const external = await createWorktree(projectFor(externalRepo), "external", {
			workspaceDir: tempDir("omp-web-worktrees-"),
		});
		const entry = worktreeEntry(created.path, repo);
		await gitOk(repo, ["worktree", "remove", created.path]);
		symlinkSync(external.path, created.path, "dir");
		expect(await worktreeDeleteInfo(entry)).toMatchObject({
			linked: false,
			reason: "worktree path resolves through a symlink",
		});
		await expect(deleteWorktree(entry)).rejects.toThrow("resolves through a symlink");
		expect(existsSync(external.path)).toBe(true);
		expect((await git(externalRepo, ["worktree", "list", "--porcelain"])).stdout).toContain(
			external.path,
		);
	});

	test("a substituted linked worktree from a foreign same-name repository is refused", async () => {
		const repo = join(tempDir("omp-web-worktrees-"), "repo");
		const foreignRepo = join(tempDir("omp-web-worktrees-"), "repo");
		await makeRepo(repo);
		await makeRepo(foreignRepo);
		const created = await createWorktree(projectFor(repo), "original", {
			workspaceDir: tempDir("omp-web-worktrees-"),
		});
		const entry = worktreeEntry(created.path, repo);
		await gitOk(repo, ["worktree", "remove", created.path]);
		await gitOk(foreignRepo, ["worktree", "add", "-b", "substitute", created.path]);
		expect((await worktreeDeleteInfo(entry)).linked).toBe(false);
		await expect(deleteWorktree(entry)).rejects.toThrow("not a linked Git worktree");
		expect(existsSync(created.path)).toBe(true);
	});
});

describe("deleteWorktree branch safety", () => {
	test("deleteBranch names the probed branch: a worktree switched to another branch keeps it", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "feat", { workspaceDir: ws });
		await gitOk(a.path, ["branch", "other"]);
		await gitOk(a.path, ["switch", "-q", "other"]);
		const result = await deleteWorktree(worktreeEntry(a.path, repo), { deleteBranch: "feat" });
		expect(existsSync(a.path)).toBe(false);
		expect(result.branch).toBe("other");
		expect(result.branchDeleted).toBe(false);
		expect(result.branchDeleteRefused).toBe(
			"worktree is on other, not feat; feat was left in place",
		);
		expect(await gitOk(repo, ["branch", "--list", "other"])).toBe("other");
		expect(await gitOk(repo, ["branch", "--list", "feat"])).toBe("feat");
	});

	test("a protected base branch is never deleted, even when the worktree is on it", async () => {
		const { clone } = await makeClonedRepo();
		const ws = tempDir("omp-web-worktrees-");
		await gitOk(clone, ["switch", "-q", "-c", "trunk"]);
		const a = await createWorktree(projectFor(clone), "base", {
			workspaceDir: ws,
			existingBranch: "main",
		});
		const result = await deleteWorktree(worktreeEntry(a.path, clone), { deleteBranch: "main" });
		expect(existsSync(a.path)).toBe(false);
		expect(result.branchDeleted).toBe(false);
		expect(result.branchDeleteRefused).toBe(
			"main is a base branch of this project and is never deleted",
		);
		expect(await gitOk(clone, ["branch", "--list", "main"])).toBe("main");
	});

	test("a detached worktree has no branch to delete", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "det", { workspaceDir: ws });
		await gitOk(a.path, ["checkout", "-q", "--detach"]);
		const result = await deleteWorktree(worktreeEntry(a.path, repo), { deleteBranch: "det" });
		expect(existsSync(a.path)).toBe(false);
		expect(result.branchDeleted).toBe(false);
		expect(result.branchDeleteRefused).toBe(
			"worktree is on a detached HEAD, not det; det was left in place",
		);
		expect(await gitOk(repo, ["branch", "--list", "det"])).toBe("det");
	});
});

describe("registerWorktreeEntry", () => {
	test("start:false registers an asleep entry tagged with the project", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const ws = tempDir("omp-web-worktrees-");
		const a = await createWorktree(projectFor(repo), "tagged", { workspaceDir: ws });
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const entry = await registerWorktreeEntry(
			registry,
			{ resolveTemplateName: () => "test" } as unknown as HostSessions,
			projectFor(repo, "p7"),
			a.path,
			{ start: false },
		);
		expect(entry.status).toBe("asleep");
		expect(entry.cwd).toBe(a.path);
		expect(entry.projectId).toBe("p7");
		expect(entry.worktreeOf).toBe(repo.split("/").pop()!);
		// The resolved template name is stored like spawn() stores it, since
		// respawn() keys off entry.template.
		expect(entry.template).toBe("test");
		expect(registry.get(entry.workspaceId)).toBeDefined();
	});

	test("registration records the worktree workspace both asleep and started", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const statePath = join(tempDir("omp-web-worktrees-"), "state.json");
		const registry = new Registry(statePath);
		await registry.load();
		const host = {
			resolveTemplateName: () => "test",
			spawnHost: async ({ cwd }: { cwd: string }) =>
				registry.create({
					name: basename(cwd),
					cwd,
					project: projectFor(repo).name,
					worktreeOf: projectFor(repo).name,
					status: "connecting",
				}),
		} as unknown as HostSessions;
		for (const start of [false, true]) {
			const created = await createWorktree(projectFor(repo), `registered-${start}`, {
				workspaceDir: tempDir("omp-web-worktrees-"),
			});
			const entry = await registerWorktreeEntry(registry, host, projectFor(repo), created.path, {
				start,
			});
			expect(entry.workspace).toMatchObject({
				kind: "worktree",
				projectId: "p1",
				desiredState: start ? "running" : "stopped",
				source: { local: repo },
			});
			registry.flush();
			const reloaded = new Registry(statePath);
			await reloaded.load();
			expect(reloaded.get(entry.workspaceId)?.workspace).toMatchObject({
				kind: "worktree",
				desiredState: start ? "running" : "stopped",
				source: { local: repo },
			});
		}
	});
});

describe("registerProjectMainEntry", () => {
	test("start:false creates an asleep main-checkout entry with the exact field shape", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const entry = await registerProjectMainEntry(
			registry,
			{ resolveTemplateName: () => "test" } as unknown as HostSessions,
			projectFor(repo, "p7"),
			{ start: false },
		);
		expect(entry).toMatchObject({
			name: repo.split("/").pop(),
			cwd: repo,
			project: repo.split("/").pop(),
			projectId: "p7",
			status: "asleep",
		});
		// NO worktreeOf: the main checkout is the repo itself and stays
		// untagged (SidebarGroups' hasMain depends on it), unlike a
		// registered worktree, which carries the owning repo's name.
		expect(entry.worktreeOf).toBeUndefined();
		// The resolved template name is always stored (respawn keys off it).
		expect(entry.template).toBe("test");
		expect(registry.get(entry.workspaceId)).toBeDefined();
	});

	test("start:false stores the template on the asleep entry when given", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const entry = await registerProjectMainEntry(
			registry,
			{
				resolveTemplateName: (_cwd: string, explicit?: string) => explicit ?? "test",
			} as unknown as HostSessions,
			projectFor(repo, "p7"),
			{ start: false, template: "local" },
		);
		expect(entry.template).toBe("local");
		expect(entry.status).toBe("asleep");
	});

	test("start:false rejects an unknown explicit template at registration (the entry would be unwakeable)", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const host = {
			resolveTemplateName: (_cwd: string, explicit?: string) => {
				if (explicit === "bogus") throw new Error(`unknown spawn template: ${explicit}`);
				return explicit ?? "test";
			},
		} as unknown as HostSessions;
		await expect(
			registerProjectMainEntry(registry, host, projectFor(repo, "p7"), {
				start: false,
				template: "bogus",
			}),
		).rejects.toThrow("unknown spawn template: bogus");
		expect(registry.list()).toHaveLength(0);
	});

	test("dedup: a pre-existing entry on the same cwd is reused and tagged, never duplicated", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const existing = registry.create({
			name: "pre",
			cwd: repo,
			project: "pre",
			status: "asleep",
		});
		expect(existing.projectId).toBeUndefined();
		const entry = await registerProjectMainEntry(registry, {} as never, projectFor(repo, "p7"), {
			start: false,
		});
		expect(entry.workspaceId).toBe(existing.workspaceId);
		expect(registry.list()).toHaveLength(1);
		expect(registry.get(existing.workspaceId)?.projectId).toBe("p7");
	});

	test("dedup + start:true on an asleep pre-existing entry respawns it instead of spawning a second row", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		const existing = registry.create({
			name: "pre",
			cwd: repo,
			project: "pre",
			status: "asleep",
			projectId: "p7",
		});
		let respawnedId: string | undefined;
		const host = {
			start: async (workspaceId: string) => {
				respawnedId = workspaceId;
			},
		} as unknown as HostSessions;
		const entry = await registerProjectMainEntry(registry, host, projectFor(repo, "p7"), {
			start: true,
		});
		expect(respawnedId).toBe(existing.workspaceId);
		expect(entry.workspaceId).toBe(existing.workspaceId);
		expect(registry.list()).toHaveLength(1);
	});

	test("start:true spawns the main checkout with the template and tags the fresh entry", async () => {
		const repo = tempDir("omp-web-worktrees-");
		await makeRepo(repo);
		const registry = new Registry(join(tempDir("omp-web-worktrees-"), "state.json"));
		await registry.load();
		let spawnInit: { cwd: string; template?: string; reuse?: boolean } | undefined;
		const host = {
			spawnHost: async (init: { cwd: string; template?: string; reuse?: boolean }) => {
				spawnInit = init;
				return registry.create({
					name: basename(init.cwd),
					cwd: init.cwd,
					project: basename(init.cwd),
					...(init.template !== undefined ? { template: init.template } : {}),
				});
			},
		} as unknown as HostSessions;
		const entry = await registerProjectMainEntry(registry, host, projectFor(repo, "p7"), {
			start: true,
			template: "local",
		});
		expect(spawnInit).toEqual({
			cwd: repo,
			template: "local",
			reuse: true,
		});
		expect(entry.projectId).toBe("p7");
		expect(registry.get(entry.workspaceId)?.projectId).toBe("p7");
		expect(registry.list()).toHaveLength(1);
	});
});
