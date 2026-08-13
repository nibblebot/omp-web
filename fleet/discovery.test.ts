/**
 * Hermetic tests for fleet/discovery.ts: porcelain fixture parsing
 * (main + two linked worktrees, one detached) through an injected fake git,
 * real tmp-dir git repositories end-to-end (git init + git worktree add),
 * the 60s cache, missing-root tolerance, validateProjectPath, and
 * resolveWorktreeOf. No live daemons.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listProjects, parseGitStatePorcelain, probeGitState, resolveWorktreeOf, validateProjectPath } from "./discovery";
import type { GitResult, GitRunner } from "./discovery";
import type { ProjectEntry } from "../shared/protocol";

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

describe("resolveWorktreeOf", () => {
	test("a linked worktree path resolves to the main repo basename", async () => {
		const calls: GitCall[] = [];
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout: PORCELAIN_FIXTURE }, calls);
		expect(await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec })).toBe("acme");
		expect(calls).toEqual([{ args: ["worktree", "list", "--porcelain"], cwd: "/srv/repos/acme-wt-feature" }]);
	});

	test("the main checkout itself resolves to undefined", async () => {
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout: PORCELAIN_FIXTURE }, []);
		expect(await resolveWorktreeOf("/srv/repos/acme", { exec })).toBeUndefined();
	});

	test("a throwing git or a nonzero exit resolves to undefined", async () => {
		const throwing: GitRunner = async () => {
			throw new Error("spawn failed");
		};
		expect(await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec: throwing })).toBeUndefined();
		const failing = fakeGit({ exitCode: 128, stderr: "not a repo", stdout: "" }, []);
		expect(await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec: failing })).toBeUndefined();
	});

	test("unparseable output resolves to undefined", async () => {
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout: "garbage\n" }, []);
		expect(await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec })).toBeUndefined();
	});

	test("real git: worktree path → main basename; main checkout → undefined", async () => {
		const root = await makeRoot();
		const main = join(root, "main-repo");
		await mkdir(main);
		await git(["init", "-b", "main"], main);
		await writeFile(join(main, "README.md"), "# main\n");
		await git(["add", "."], main);
		await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], main);
		const wt = join(root, "wt-feature");
		await git(["worktree", "add", wt, "-b", "feature/x"], main);

		expect(await resolveWorktreeOf(wt)).toBe("main-repo");
		expect(await resolveWorktreeOf(main)).toBeUndefined();
	});
});

describe("parseGitStatePorcelain", () => {
	/** Counts shorthand for the parsed git object. */
	const zero = { added: 0, modified: 0, deleted: 0, untracked: 0 };

	test("a clean repo: header only, all counts zero", () => {
		expect(parseGitStatePorcelain("## main\n")).toEqual({ branch: "main", git: zero });
	});

	test("a dirty repo counts A/M/D/?? lines", () => {
		const stdout = [
			"## main",
			" M file-m.txt",
			"A  file-a.txt",
			" D file-d.txt",
			"?? file-u.txt",
			"",
		].join("\n");
		expect(parseGitStatePorcelain(stdout)).toEqual({
			branch: "main",
			git: { added: 1, modified: 1, deleted: 1, untracked: 1 },
		});
	});

	test("staged+unstaged combos: A beats D, everything else counts modified", () => {
		const stdout = [
			"## feature/x",
			"MM file-mm.txt", // staged M + unstaged M
			"AM file-am.txt", // staged A + unstaged M
			"AD file-ad.txt", // staged A + unstaged D → added (A checked first)
			" R file-r.txt", // unstaged rename
			"R  file-r2.txt", // staged rename
			"UU file-uu.txt", // unmerged
			"T  file-t.txt", // type change
			" C file-c.txt", // unstaged copy
			"",
		].join("\n");
		expect(parseGitStatePorcelain(stdout)).toEqual({
			branch: "feature/x",
			git: { added: 2, modified: 6, deleted: 0, untracked: 0 },
		});
	});

	test("detached HEAD: `## HEAD (no branch)` → branch undefined", () => {
		const stdout = ["## HEAD (no branch)", "?? notes.txt", " M tracked.txt", ""].join("\n");
		expect(parseGitStatePorcelain(stdout)).toEqual({
			git: { added: 0, modified: 1, deleted: 0, untracked: 1 },
		});
	});

	test("empty repo: `## No commits yet on X` still names the branch", () => {
		const stdout = ["## No commits yet on main", "?? first.txt", ""].join("\n");
		expect(parseGitStatePorcelain(stdout)).toEqual({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1 },
		});
	});

	test("upstream tracking + `[ahead N]` suffix: the branch is cut at `...`", () => {
		const stdout = ["## main...origin/main [ahead 1]", " M x", ""].join("\n");
		expect(parseGitStatePorcelain(stdout)).toEqual({
			branch: "main",
			git: { added: 0, modified: 1, deleted: 0, untracked: 0 },
		});
	});

	test("unparseable output (no `## ` header) is undefined, never a clean repo", () => {
		expect(parseGitStatePorcelain("garbage\n")).toBeUndefined();
		expect(parseGitStatePorcelain("")).toBeUndefined();
	});
});

describe("probeGitState", () => {
	test("runs status --porcelain=v1 --branch and returns the parsed state", async () => {
		const stdout = ["## main", "?? new.txt", ""].join("\n");
		const calls: GitCall[] = [];
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout }, calls);
		expect(await probeGitState("/srv/repos/acme", { exec })).toEqual({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1 },
		});
		expect(calls).toEqual([{ args: ["status", "--porcelain=v1", "--branch"], cwd: "/srv/repos/acme" }]);
	});

	test("spawn failure, nonzero exit, and unparseable output all resolve to undefined", async () => {
		const throwing: GitRunner = async () => {
			throw new Error("spawn failed");
		};
		expect(await probeGitState("/srv/repos/acme", { exec: throwing })).toBeUndefined();
		const failing = fakeGit({ exitCode: 128, stderr: "not a repo", stdout: "" }, []);
		expect(await probeGitState("/srv/repos/acme", { exec: failing })).toBeUndefined();
		const garbage = fakeGit({ exitCode: 0, stderr: "", stdout: "not porcelain\n" }, []);
		expect(await probeGitState("/srv/repos/acme", { exec: garbage })).toBeUndefined();
	});
});
