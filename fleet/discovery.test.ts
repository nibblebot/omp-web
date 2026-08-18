/**
 * Hermetic tests for fleet/discovery.ts: validateProjectPath (incl. `~`
 * expansion), resolveWorktreeOf against an injected fake git and real
 * tmp-dir repositories, and the probeGitState porcelain/numstat parsers.
 * No live daemons, no filesystem root scanning (removed with `roots`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseGitStatePorcelain,
	parseNumstat,
	probeGitState,
	resolveWorktreeOf,
	validateProjectPath,
} from "./discovery";
import type { GitResult, GitRunner } from "./discovery";

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

/** Fake git answering each call from `byFirstArg` (keyed by the first arg: `status` vs `diff`). */
function fakeGitByArg(byFirstArg: Record<string, GitResult>, calls: GitCall[]): GitRunner {
	return async (args, cwd) => {
		calls.push({ args, cwd });
		return byFirstArg[args[0]];
	};
}

const tmpRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tmpRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-discovery-"));
	tmpRoots.push(root);
	return root;
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

	test("expands ~ and ~/ before realpath", async () => {
		expect(await validateProjectPath("~")).toBe(await realpath(homedir()));
		// A home-relative path reaches the real child (not a literal "~" dir).
		const probe = join(homedir(), ".omp-validate-probe");
		await mkdir(probe, { recursive: true });
		try {
			expect(await validateProjectPath("~/.omp-validate-probe")).toBe(await realpath(probe));
		} finally {
			await rm(probe, { recursive: true, force: true });
		}
		// Expanded-but-missing still resolves to null, never a "~"-relative hit.
		expect(await validateProjectPath("~/.omp-validate-nope")).toBeNull();
	});
});

describe("resolveWorktreeOf", () => {
	test("a linked worktree path resolves to the main repo basename", async () => {
		const calls: GitCall[] = [];
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout: PORCELAIN_FIXTURE }, calls);
		expect(await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec })).toBe("acme");
		expect(calls).toEqual([
			{ args: ["worktree", "list", "--porcelain"], cwd: "/srv/repos/acme-wt-feature" },
		]);
	});

	test("the main checkout itself resolves to undefined", async () => {
		const exec = fakeGit({ exitCode: 0, stderr: "", stdout: PORCELAIN_FIXTURE }, []);
		expect(await resolveWorktreeOf("/srv/repos/acme", { exec })).toBeUndefined();
	});

	test("a throwing git or a nonzero exit resolves to undefined", async () => {
		const throwing: GitRunner = async () => {
			throw new Error("spawn failed");
		};
		expect(
			await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec: throwing }),
		).toBeUndefined();
		const failing = fakeGit({ exitCode: 128, stderr: "not a repo", stdout: "" }, []);
		expect(
			await resolveWorktreeOf("/srv/repos/acme-wt-feature", { exec: failing }),
		).toBeUndefined();
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
		await git(
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
			main,
		);
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

describe("parseNumstat", () => {
	test("sums added/deleted across rows; binary rows and blanks are skipped", () => {
		const stdout = [
			"3\t1\ta.ts",
			"-\t-\timg.png", // binary: not counted
			"",
			"0\t0\tmode-only.sh", // real row, zero contribution
			"2\t4\tc.ts",
			"",
		].join("\n");
		expect(parseNumstat(stdout)).toEqual({ linesAdded: 5, linesDeleted: 5 });
	});

	test("no rows or garbage yields 0/0", () => {
		expect(parseNumstat("")).toEqual({ linesAdded: 0, linesDeleted: 0 });
		expect(parseNumstat("## main\n?? x\n")).toEqual({ linesAdded: 0, linesDeleted: 0 });
	});
});

describe("probeGitState", () => {
	test("runs status + numstat and returns the parsed state with line counts", async () => {
		const statusOut = ["## main", "?? new.txt", ""].join("\n");
		const numstatOut = ["10\t2\tnew.txt", "1\t0\tREADME.md", ""].join("\n");
		const calls: GitCall[] = [];
		const exec = fakeGitByArg(
			{
				status: { exitCode: 0, stderr: "", stdout: statusOut },
				diff: { exitCode: 0, stderr: "", stdout: numstatOut },
			},
			calls,
		);
		expect(await probeGitState("/srv/repos/acme", { exec })).toEqual({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1, linesAdded: 11, linesDeleted: 2 },
		});
		expect(calls).toEqual([
			{ args: ["status", "--porcelain=v1", "--branch"], cwd: "/srv/repos/acme" },
			{ args: ["diff", "--numstat", "HEAD", "--"], cwd: "/srv/repos/acme" },
		]);
	});

	test("numstat rows sum across files; binary rows and blanks are skipped", async () => {
		const numstatOut = [
			"3\t1\ta.ts",
			"-\t-\timg.png", // binary: skipped
			"",
			"0\t0\tmode-only.sh", // counts zero but is a real row
			"2\t4\tc.ts",
			"",
		].join("\n");
		const calls: GitCall[] = [];
		const exec = fakeGitByArg(
			{
				status: { exitCode: 0, stderr: "", stdout: "## main\n" },
				diff: { exitCode: 0, stderr: "", stdout: numstatOut },
			},
			calls,
		);
		expect(await probeGitState("/srv/repos/acme", { exec })).toEqual({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 0, linesAdded: 5, linesDeleted: 5 },
		});
	});

	test("a failed numstat run still returns the parsed status state with no line fields", async () => {
		const calls: GitCall[] = [];
		const exec = fakeGitByArg(
			{
				status: { exitCode: 0, stderr: "", stdout: ["## main", "?? new.txt", ""].join("\n") },
				diff: {
					exitCode: 128,
					stderr: "fatal: ambiguous argument 'HEAD': unknown revision",
					stdout: "",
				},
			},
			calls,
		);
		expect(await probeGitState("/srv/repos/acme", { exec })).toEqual({
			branch: "main",
			git: { added: 0, modified: 0, deleted: 0, untracked: 1 },
		});
		expect(calls).toHaveLength(2); // both runs happened; the numstat failure is non-fatal
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
