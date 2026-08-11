/**
 * Hermetic tests for orchestrator/discovery.ts: porcelain fixture parsing
 * (main + two linked worktrees, one detached) through an injected fake git,
 * real tmp-dir git repositories end-to-end (git init + git worktree add),
 * the 60s cache, missing-root tolerance, and validateProjectPath. No live
 * daemons.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listProjects, validateProjectPath } from "./discovery";
import type { GitResult, GitRunner } from "./discovery";
import type { ProjectEntry } from "../src/protocol";

/** `git worktree list --porcelain` for acme: main + feature worktree + detached worktree. */
const PORCELAIN_FIXTURE = [
	"worktree /srv/repos/acme",
	"HEAD 1111111111111111111111111111111111111111",
	"branch refs/heads/main",
	"",
	"worktree /srv/repos/acme-wt-feature",
	"HEAD 2222222222222222222222222222222222222222",
	"branch refs/heads/feature/x",
	"",
	"worktree /srv/repos/acme-wt-detached",
	"HEAD 3333333333333333333333333333333333333333",
	"detached",
	"",
].join("\n");

/** Entries listProjects must produce from PORCELAIN_FIXTURE. */
const FIXTURE_ENTRIES: ProjectEntry[] = [
	{ name: "acme", path: "/srv/repos/acme", isWorktree: false, branch: "main" },
	{ name: "acme-wt-feature", path: "/srv/repos/acme-wt-feature", isWorktree: true, worktreeOf: "acme", branch: "feature/x" },
	{ name: "acme-wt-detached", path: "/srv/repos/acme-wt-detached", isWorktree: true, worktreeOf: "acme" },
];

/** Porcelain for a lone repo whose main worktree is rooted at `cwd`. */
function fixtureFor(cwd: string): GitResult {
	return {
		exitCode: 0,
		stderr: "",
		stdout: [`worktree ${cwd}`, "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", ""].join("\n"),
	};
}

/** Recorded git invocation. */
interface GitCall {
	args: string[];
	cwd: string;
}

function fakeGit(result: GitResult, calls: GitCall[]): GitRunner {
	return async (args, cwd) => {
		calls.push({ args, cwd });
		return result;
	};
}

const tmpRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tmpRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
	listProjects.clearCache();
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-discovery-"));
	tmpRoots.push(root);
	return root;
}

/** Create `<dir>/.git` as a directory (main checkout) or file (linked worktree). */
async function makeGit(dir: string, asDir = false): Promise<void> {
	await mkdir(dir, { recursive: true });
	if (asDir) await mkdir(join(dir, ".git"));
	else await writeFile(join(dir, ".git"), "gitdir: /nowhere\n");
}

/** Run a real git command, throwing on failure. */
async function git(args: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
	]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
}

describe("listProjects", () => {
	test("parses a porcelain fixture: main + 2 worktrees, one detached", async () => {
		const root = await makeRoot();
		await makeGit(join(root, "acme"), true); // .git as a directory
		await makeGit(join(root, "acme-wt-feature")); // .git as a file
		await makeGit(join(root, "acme-wt-detached"));
		const calls: GitCall[] = [];
		const projects = await listProjects(
			[root],
			{ exec: fakeGit({ exitCode: 0, stdout: PORCELAIN_FIXTURE, stderr: "" }, calls) },
		);
		expect(calls).toHaveLength(3); // one git run per discovered repo
		for (const call of calls) expect(call.args).toEqual(["worktree", "list", "--porcelain"]);
		expect(calls.map((c) => c.cwd).sort()).toEqual(
			[join(root, "acme"), join(root, "acme-wt-feature"), join(root, "acme-wt-detached")].sort(),
		);
		// Every repo answers with the full fixture; dedupe by path keeps one copy.
		expect(projects).toEqual(FIXTURE_ENTRIES);
	});

	test("a porcelain block without a branch line has no branch", async () => {
		const root = await makeRoot();
		const repo = join(root, "fresh");
		await makeGit(repo);
		const projects = await listProjects([root], {
			exec: fakeGit(
				{
					exitCode: 0,
					stderr: "",
					stdout: [`worktree ${repo}`, "HEAD 0000000000000000000000000000000000000000", ""].join("\n"),
				},
				[],
			),
		});
		expect(projects).toEqual([{ name: "fresh", path: repo, isWorktree: false }]);
	});

	test("a throwing git degrades that repo to a plain entry", async () => {
		const root = await makeRoot();
		const good = join(root, "good");
		const bad = join(root, "bad");
		await makeGit(good);
		await makeGit(bad);
		const projects = await listProjects([root], {
			exec: async (_args, cwd) => {
				if (cwd === bad) throw new Error("git not installed");
				return fixtureFor(cwd);
			},
		});
		expect(projects).toHaveLength(2);
		expect(projects).toContainEqual({ name: "good", path: good, isWorktree: false, branch: "main" });
		expect(projects).toContainEqual({ name: "bad", path: bad, isWorktree: false });
	});

	test("a nonzero git exit degrades to a plain entry", async () => {
		const root = await makeRoot();
		await makeGit(join(root, "bogus"));
		const projects = await listProjects([root], {
			exec: fakeGit({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }, []),
		});
		expect(projects).toEqual([{ name: "bogus", path: join(root, "bogus"), isWorktree: false }]);
	});

	test("caches for 60s: second call does not re-exec; clearCache rescans", async () => {
		const root = await makeRoot();
		await makeGit(join(root, "repo-a"));
		const calls: GitCall[] = [];
		const exec: GitRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return fixtureFor(cwd);
		};
		const first = await listProjects([root], { exec });
		expect(calls).toHaveLength(1);
		const second = await listProjects([root], { exec });
		expect(calls).toHaveLength(1); // cache hit: no re-exec
		expect(second).toEqual(first);
		// A newly added repo is invisible while the cache is warm.
		await makeGit(join(root, "repo-b"));
		expect(await listProjects([root], { exec })).toEqual(first);
		// Different roots → separate cache entry.
		const otherRoot = await makeRoot();
		await makeGit(join(otherRoot, "other"));
		const other = await listProjects([otherRoot], { exec });
		expect(calls).toHaveLength(2);
		expect(other).toEqual([{ name: "other", path: join(otherRoot, "other"), isWorktree: false, branch: "main" }]);
		// clearCache() forces a rescan that sees the new repo.
		listProjects.clearCache();
		const refreshed = await listProjects([root], { exec });
		expect(calls).toHaveLength(4); // repo-a + repo-b (added above) both rescanned
		expect(refreshed).toHaveLength(2);
		expect(refreshed).toContainEqual({ name: "repo-a", path: join(root, "repo-a"), isWorktree: false, branch: "main" });
		expect(refreshed).toContainEqual({ name: "repo-b", path: join(root, "repo-b"), isWorktree: false, branch: "main" });
	});

	test("missing roots are skipped silently and never exec git", async () => {
		const root = await makeRoot();
		await makeGit(join(root, "only"));
		const calls: GitCall[] = [];
		const exec = fakeGit({ exitCode: 0, stdout: PORCELAIN_FIXTURE, stderr: "" }, calls);
		const projects = await listProjects([join(root, "gone"), join(root, "gone", "deep"), root], { exec });
		expect(calls).toHaveLength(1); // only the real root ran git
		expect(projects).toEqual(FIXTURE_ENTRIES);
	});

	test("empty roots yields no projects", async () => {
		expect(await listProjects([])).toEqual([]);
	});

	test("a root that is a file is skipped", async () => {
		const root = await makeRoot();
		const file = join(root, "not-a-dir");
		await writeFile(file, "x");
		expect(await listProjects([file])).toEqual([]);
	});

	test("real git: init + worktree add end-to-end", async () => {
		const root = await makeRoot();
		const main = join(root, "main-repo");
		await mkdir(main);
		await git(["init", "-b", "main"], main);
		await writeFile(join(main, "README.md"), "# main\n");
		await git(["add", "."], main);
		await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], main);
		await git(["worktree", "add", join(root, "wt-feature"), "-b", "feature/x"], main);
		await git(["worktree", "add", "--detach", join(root, "wt-detached"), "HEAD"], main);

		const projects = await listProjects([root]);
		expect(projects).toHaveLength(3);
		// The first worktree block is the main repo, so it leads the list.
		expect(projects[0]).toEqual({ name: "main-repo", path: main, isWorktree: false, branch: "main" });
		const byPath = new Map(projects.map((p) => [p.path, p]));
		expect(byPath.get(join(root, "wt-feature"))).toEqual({
			name: "wt-feature",
			path: join(root, "wt-feature"),
			isWorktree: true,
			worktreeOf: "main-repo",
			branch: "feature/x",
		});
		expect(byPath.get(join(root, "wt-detached"))).toEqual({
			name: "wt-detached",
			path: join(root, "wt-detached"),
			isWorktree: true,
			worktreeOf: "main-repo",
		});
	});

	test("real git: a bogus .git file degrades to a plain entry", async () => {
		const root = await makeRoot();
		await makeGit(join(root, "bogus")); // .git file pointing at a nonexistent gitdir
		const projects = await listProjects([root]);
		expect(projects).toEqual([{ name: "bogus", path: join(root, "bogus"), isWorktree: false }]);
	});
});

describe("validateProjectPath", () => {
	test("returns the realpath of an existing directory", async () => {
		const dir = await makeRoot();
		expect(await validateProjectPath(dir)).toBe(await realpath(dir));
	});

	test("resolves a symlink to its target directory", async () => {
		const root = await makeRoot();
		const target = join(root, "target");
		await mkdir(target);
		const link = join(root, "link");
		await symlink(target, link);
		expect(await validateProjectPath(link)).toBe(await realpath(target));
	});

	test("null for missing paths", async () => {
		const root = await makeRoot();
		expect(await validateProjectPath(join(root, "missing"))).toBeNull();
		expect(await validateProjectPath(join(root, "missing", "deep"))).toBeNull();
	});

	test("null for an existing file", async () => {
		const root = await makeRoot();
		const file = join(root, "file.txt");
		await writeFile(file, "x");
		expect(await validateProjectPath(file)).toBeNull();
	});
});
