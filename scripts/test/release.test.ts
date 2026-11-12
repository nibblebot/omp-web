/**
 * Pure deterministic core tests for scripts/release.ts. No git/gh/network/
 * build: only exported functions, with tempDir() scratch dirs for the
 * tarball-validation fixtures. `main` is never called here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	GATE_COMMANDS,
	appliedBump,
	changelogSection,
	classifyCommit,
	computeBump,
	fallbackBullets,
	groupCommits,
	isNewerVersion,
	isValidSemver,
	makeManifest,
	nextVersion,
	parseGitLog,
	parseReleaseArgs,
	curatedNotes,
	foldUnreleased,
	notesProblem,
	RELEASE_NOTES_MAX_CHARS,
	prependChangelog,
	releasePlan,
	releaseTreeProblem,
	runGate,
	smokePackedTarballPlan,
	stagedProblems,
	validateCoverage,
	validateTarball,
} from "../release";
import type { ChangelogDraft, CommitClass, CommitInfo, GateRunner, Group } from "../release";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

const commit = (hash: string, subject: string, body = ""): CommitInfo => ({ hash, subject, body });

const mkGroup = (cls: CommitClass, commits: CommitInfo[] = []): Group => ({
	cls,
	heading:
		cls === "breaking"
			? "Breaking changes"
			: cls === "feat"
				? "Features"
				: cls === "fix"
					? "Bug fixes"
					: "Maintenance & other",
	commits,
});

const shaOf = (bytes: Uint8Array | Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

/** Fixture tarball: package/dist-bundle/cli.js with shebang + version string. */
async function makeFixtureTgz(dir: string, content?: string): Promise<string> {
	const cliPath = join(dir, "package", "dist-bundle", "cli.js");
	mkdirSync(join(dir, "package", "dist-bundle"), { recursive: true });
	writeFileSync(
		cliPath,
		content ?? "#!/usr/bin/env bun\n// omp-web 0.1.0 bundle\nconsole.log('hi');\n",
	);
	const tgz = join(dir, "omp-web-0.1.0.tgz");
	const proc = Bun.spawn(["tar", "-czf", tgz, "-C", dir, "package/dist-bundle/cli.js"]);
	const status = await proc.exited;
	if (status !== 0) throw new Error(`tar fixture failed (exit ${status})`);
	return tgz;
}

describe("GATE_COMMANDS + releasePlan", () => {
	test("gate is the exact argv lists in order, and the dry-run plan opens with them", () => {
		expect(GATE_COMMANDS).toEqual([
			["bun", "install", "--frozen-lockfile"],
			["bun", "run", "check:types"],
			["bun", "run", "format:check"],
			["bun", "run", "build:web"],
			["bun", "run", "test"],
			["bun", "e2e/onboarding.ts"],
		]);
		// The plan's opening lines are derived from GATE_COMMANDS, in order.
		const gateLines = GATE_COMMANDS.map((cmd) => cmd.join(" "));
		const plan = releasePlan("v0.2.0", "0.2.0");
		expect(plan.slice(0, gateLines.length)).toEqual(gateLines);
	});

	test("plan continues through build, pack, smoke and publish", () => {
		const plan = releasePlan("v0.2.0", "0.2.0");
		expect(plan.slice(GATE_COMMANDS.length)).toEqual([
			"bun run build",
			"bun pm pack",
			expect.stringContaining("omp-web-0.2.0.tgz"),
			"git add package.json CHANGELOG.md",
			`git commit -m "release: v0.2.0"`,
			"git tag v0.2.0",
			"git push origin main --follow-tags",
			expect.stringContaining("gh release create v0.2.0 dist-release/omp-web-0.2.0.tgz"),
		]);
	});
});

describe("runGate", () => {
	/** Fake runner over GATE_COMMANDS: records argv, fails the Nth call when asked. */
	function fakeRunner(failAt = -1): { runner: GateRunner; calls: string[][] } {
		const calls: string[][] = [];
		const runner: GateRunner = async (args) => {
			calls.push([...args]);
			const failed = calls.length === failAt;
			return failed
				? { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("boom\n") }
				: { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		};
		return { runner, calls };
	}

	test("runs every GATE_COMMANDS argv in order", async () => {
		const { runner, calls } = fakeRunner();
		await runGate(false, runner);
		expect(calls).toEqual(GATE_COMMANDS.map((cmd) => [...cmd]));
	});

	test("stops at the first failing command with its exit code and stderr", async () => {
		const { runner, calls } = fakeRunner(2);
		await expect(runGate(false, runner)).rejects.toThrow(
			["gate failed: bun run check:types (exit 2)", "boom"].join("\n"),
		);
		// The remaining commands never run: a failed gate aborts the release.
		expect(calls).toEqual(GATE_COMMANDS.slice(0, 2).map((cmd) => [...cmd]));
	});

	test("--dry-run skips the gate and spawns nothing", async () => {
		const { runner, calls } = fakeRunner();
		await runGate(true, runner);
		expect(calls).toEqual([]);
	});
});

describe("classifyCommit", () => {
	test("feat/fix/other plain", () => {
		expect(classifyCommit("feat: add thing", "")).toBe("feat");
		expect(classifyCommit("fix: correct thing", "")).toBe("fix");
		expect(classifyCommit("docs: update readme", "")).toBe("other");
	});

	test("feat(scope): is feat", () => {
		expect(classifyCommit("feat(ui): add button", "")).toBe("feat");
	});

	test("type!: is breaking, wins over feat/fix", () => {
		expect(classifyCommit("fix!: change the API", "")).toBe("breaking");
		expect(classifyCommit("feat!: break everything", "")).toBe("breaking");
		expect(classifyCommit("feat(scope)!: break scoped", "")).toBe("breaking");
	});

	test("BREAKING CHANGE in body is breaking", () => {
		expect(classifyCommit("feat: add z", "BREAKING CHANGE: removed x")).toBe("breaking");
		expect(classifyCommit("feat: add z", "some note\nBREAKING CHANGE: removed x")).toBe("breaking");
	});

	test("compound prefix and untyped subjects are other", () => {
		expect(classifyCommit("fleet+ui: sync roster", "")).toBe("other");
		expect(classifyCommit("untyped subject", "")).toBe("other");
	});
});

describe("computeBump", () => {
	test("breaking wins over feat", () => {
		expect(computeBump([mkGroup("breaking"), mkGroup("feat")])).toBe("major");
		expect(computeBump([mkGroup("breaking")])).toBe("major");
	});

	test("feat -> minor", () => {
		expect(computeBump([mkGroup("feat"), mkGroup("fix")])).toBe("minor");
		expect(computeBump([mkGroup("feat")])).toBe("minor");
	});

	test("only fix/other -> patch", () => {
		expect(computeBump([mkGroup("fix")])).toBe("patch");
		expect(computeBump([mkGroup("other")])).toBe("patch");
		expect(computeBump([mkGroup("fix"), mkGroup("other")])).toBe("patch");
	});
});

describe("nextVersion", () => {
	test("numeric increments", () => {
		expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
		expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
		expect(nextVersion("0.1.0", "major")).toBe("1.0.0");
		expect(nextVersion("9.9.9", "patch")).toBe("9.9.10");
	});

	test("invalid inputs throw", () => {
		expect(() => nextVersion("0.1", "patch")).toThrow();
		expect(() => nextVersion("1.2.3-beta.1", "patch")).toThrow();
		expect(() => nextVersion("v0.1.0", "patch")).toThrow();
		expect(() => nextVersion("", "patch")).toThrow();
	});
});

describe("appliedBump", () => {
	test("major clamps to minor while at 0.x.y", () => {
		expect(appliedBump("0.1.0", "major")).toBe("minor");
		expect(appliedBump("0.9.9", "major")).toBe("minor");
	});

	test("minor and patch pass through unchanged at 0.x.y", () => {
		expect(appliedBump("0.1.0", "minor")).toBe("minor");
		expect(appliedBump("0.1.0", "patch")).toBe("patch");
	});

	test("major stays major once the project is at 1.x+", () => {
		expect(appliedBump("1.0.0", "major")).toBe("major");
		expect(appliedBump("2.3.4", "major")).toBe("major");
	});

	test("invalid current falls through unchanged", () => {
		expect(appliedBump("nope", "major")).toBe("major");
	});
});

describe("isValidSemver", () => {
	test("plain x.y.z only", () => {
		expect(isValidSemver("0.1.0")).toBe(true);
		expect(isValidSemver("10.20.30")).toBe(true);
		expect(isValidSemver("0.1")).toBe(false);
		expect(isValidSemver("1.2.3.4")).toBe(false);
		expect(isValidSemver("1.2.3-rc.1")).toBe(false);
		expect(isValidSemver("1.2.3+build")).toBe(false);
		expect(isValidSemver("")).toBe(false);
	});
});

describe("isNewerVersion", () => {
	test("sane comparisons", () => {
		expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
		expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
		expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
	});
});

describe("parseGitLog", () => {
	test("multiline body, empty body, multiple commits", () => {
		// Real `git log --format=%H%x1f%s%x1f%b%x1e` appends a newline after
		// every \x1e record separator; entries 2+ must parse cleanly.
		const raw =
			"abc1234\x1ffeat: add thing\x1fBody line 1\nBody line 2\x1e\n" +
			"def5678\x1ffix: bug\x1e\n" +
			"0beef00\x1fchore: empty body\x1f\x1e\n";
		const commits = parseGitLog(raw);
		expect(commits).toHaveLength(3);
		expect(commits[0]).toEqual({
			hash: "abc1234",
			subject: "feat: add thing",
			body: "Body line 1\nBody line 2",
		});
		expect(commits[1]).toEqual({ hash: "def5678", subject: "fix: bug", body: "" });
		expect(commits[2]).toEqual({ hash: "0beef00", subject: "chore: empty body", body: "" });
	});

	test("empty input", () => {
		expect(parseGitLog("")).toEqual([]);
	});
});

describe("groupCommits", () => {
	test("fixed ordering and empty-group omission", () => {
		const groups = groupCommits([
			commit("1", "fix: a"),
			commit("2", "feat: b"),
			commit("3", "docs: c"),
			commit("4", "feat!: d"),
			commit("5", "chore: e"),
		]);
		expect(groups.map((g) => g.cls)).toEqual(["breaking", "feat", "fix", "other"]);
		expect(groups.map((g) => g.heading)).toEqual([
			"Breaking changes",
			"Features",
			"Bug fixes",
			"Maintenance & other",
		]);
		expect(groups.map((g) => g.commits.map((c) => c.hash))).toEqual([
			["4"],
			["2"],
			["1"],
			["3", "5"],
		]);
	});

	test("empty groups are omitted", () => {
		const onlyFix = groupCommits([commit("1", "fix: a")]);
		expect(onlyFix.map((g) => g.cls)).toEqual(["fix"]);
	});
});

describe("changelogSection", () => {
	const url = (hash: string) => `https://github.com/nibblebot/omp-web/commit/${hash}`;

	test("exact format without overview", () => {
		const groups = [
			{ heading: "Features", bullets: [`- add x ([abc1234](${url("abc1234")}))`] },
			{ heading: "Bug fixes", bullets: [`- fix y ([def5678](${url("def5678")}))`] },
		];
		expect(changelogSection("0.2.0", "2026-08-19", null, groups)).toBe(
			"## v0.2.0, 2026-08-19\n" +
				"\n" +
				"### Features\n" +
				`- add x ([abc1234](${url("abc1234")}))\n` +
				"\n" +
				"### Bug fixes\n" +
				`- fix y ([def5678](${url("def5678")}))\n`,
		);
	});

	test("exact format with overview", () => {
		const groups = [{ heading: "Features", bullets: ["- b"] }];
		expect(changelogSection("0.2.0", "2026-08-19", "A release.", groups)).toBe(
			"## v0.2.0, 2026-08-19\n\nA release.\n\n### Features\n- b\n",
		);
	});

	test("every bullet renders as one markdown list item", () => {
		const groups = [
			{
				heading: "Features",
				// Mixed inputs: already-bulleted, marker-less, star-prefixed,
				// and blank. All must normalize to a single `- ` bullet.
				bullets: ["already bulleted", "* star bullet", "- plus a marker", "", "  "],
			},
		];
		expect(changelogSection("0.2.0", "2026-08-19", null, groups)).toBe(
			"## v0.2.0, 2026-08-19\n" +
				"\n" +
				"### Features\n" +
				"- already bulleted\n" +
				"- star bullet\n" +
				"- plus a marker\n",
		);
	});
});

describe("fallbackBullets + validateCoverage", () => {
	test("fallbackBullets show and link an 8-character hash", () => {
		expect(fallbackBullets([commit("abc1234def5678", "feat: add x")])).toEqual([
			"- feat: add x ([abc1234d](https://github.com/nibblebot/omp-web/commit/abc1234d))",
		]);
	});

	test("coverage ok when every hash appears in its group", () => {
		const groups: Group[] = [
			mkGroup("feat", [commit("a1b2c3d4", "feat: x"), commit("e5f6a7b8", "feat: y")]),
		];
		const draft: ChangelogDraft = {
			overview: null,
			groups: [
				{
					cls: "feat",
					bullets: [
						"- x ([a1b2c3d4](https://github.com/nibblebot/omp-web/commit/a1b2c3d4))",
						"- y ([e5f6a7b8](https://github.com/nibblebot/omp-web/commit/e5f6a7b8))",
					],
				},
			],
		};
		const coverage = validateCoverage(draft, groups);
		expect(coverage.ok).toBe(true);
		expect(coverage.missing).toEqual([]);
	});

	test("dropped hash is reported per group", () => {
		const groups: Group[] = [
			mkGroup("feat", [commit("a1b2c3d4", "feat: x"), commit("e5f6a7b8", "feat: y")]),
		];
		const draft: ChangelogDraft = {
			overview: null,
			groups: [
				{
					cls: "feat",
					bullets: ["- x ([a1b2c3d4](https://github.com/nibblebot/omp-web/commit/a1b2c3d4))"],
				},
			],
		};
		const coverage = validateCoverage(draft, groups);
		expect(coverage.ok).toBe(false);
		expect(coverage.missing).toEqual([{ cls: "feat", hashes: ["e5f6a7b8"] }]);
	});
});

describe("prependChangelog", () => {
	test("existing content preserved below the new section", () => {
		const section = "## v0.2.0, 2026-08-19\n\n### Features\n- b1\n";
		const existing = "\n\n## v0.1.0, 2026-08-01\n\nOld content.\n\n";
		expect(prependChangelog(existing, section)).toBe(
			"## v0.2.0, 2026-08-19\n\n### Features\n- b1\n\n## v0.1.0, 2026-08-01\n\nOld content.\n",
		);
	});

	test("empty existing returns the section unchanged", () => {
		const section = "## v0.2.0, 2026-08-19\n\n### Features\n- b1\n";
		expect(prependChangelog("", section)).toBe(section);
	});
});

describe("foldUnreleased", () => {
	const older = "## v0.2.1, 2026-09-25\n\nOld notes.\n";

	test("without an Unreleased heading the changelog is untouched and the section is generated", () => {
		expect(foldUnreleased(older, "0.3.0", "2026-10-30", [])).toEqual({
			section: null,
			log: "",
			rest: older,
		});
	});

	test("a curated Unreleased body becomes the release section, followed by the commit log", () => {
		const existing = `## Unreleased\n\nIntro.\n\n### Breaking changes\n- one\n\n${older}`;
		const log = [
			{ heading: "Breaking changes", bullets: ["refactor!: drop x ([abc](u/abc))"] },
			{ heading: "Features", bullets: [] },
			{ heading: "Bug fixes", bullets: ["- fix: y ([def](u/def))", "  "] },
		];
		const { section, log: block, rest } = foldUnreleased(existing, "0.3.0", "2026-10-30", log);
		const expectedLog =
			"### Commits\n\n" +
			"#### Breaking changes\n- refactor!: drop x ([abc](u/abc))\n\n#### Bug fixes\n- fix: y ([def](u/def))\n";
		const expected = `## v0.3.0, 2026-10-30\n\nIntro.\n\n### Breaking changes\n- one\n\n${expectedLog}`;
		expect(section).toBe(expected);
		expect(block).toBe(expectedLog);
		expect(prependChangelog(rest, section as string)).toBe(`${expected}\n${older}`);
	});

	test("a blank Unreleased body falls back to the generated section and drops the heading", () => {
		const log = [{ heading: "Features", bullets: ["feat: z"] }];
		const { section, rest } = foldUnreleased(
			`## Unreleased\n\n\n${older}`,
			"0.3.0",
			"2026-10-30",
			log,
		);
		expect(section).toBeNull();
		expect(rest).not.toContain("Unreleased");
		expect(rest).toContain(older);
	});

	test("a ## line inside a fenced code block does not end the section", () => {
		const body = "Config:\n\n```md\n## not a heading\n```\n\nAfter the fence.";
		const { section, rest } = foldUnreleased(
			`## Unreleased\n\n${body}\n\n${older}`,
			"0.3.0",
			"d",
			[],
		);
		expect(section).toBe(`## v0.3.0, d\n\n${body}\n`);
		expect(rest.trim()).toBe(older.trim());
	});

	test("an Unreleased section with no earlier release runs to the end; no commits, no log heading", () => {
		expect(foldUnreleased("## Unreleased\n\n- first\n", "0.1.0", "d", [])).toEqual({
			section: "## v0.1.0, d\n\n- first\n",
			log: "",
			rest: "",
		});
	});
});

describe("curatedNotes", () => {
	test("link the version's CHANGELOG.md section at the tag and the compare view, then the commit log", () => {
		expect(curatedNotes("0.3.0", "2026-10-30", "v0.2.1", "### Commits\n\n- a\n")).toBe(
			"The full v0.3.0 release notes are in " +
				"[CHANGELOG.md](https://github.com/nibblebot/omp-web/blob/v0.3.0/CHANGELOG.md#v030-2026-10-30). " +
				"[Compare v0.2.1...v0.3.0](https://github.com/nibblebot/omp-web/compare/v0.2.1...v0.3.0)" +
				"\n\n### Commits\n\n- a\n",
		);
	});

	test("a first release has no compare link, and no commits leave only the link line", () => {
		expect(curatedNotes("0.1.0", "d", null, "")).toBe(
			"The full v0.1.0 release notes are in " +
				"[CHANGELOG.md](https://github.com/nibblebot/omp-web/blob/v0.1.0/CHANGELOG.md#v010-d).\n",
		);
	});
});

describe("notesProblem", () => {
	test("accepts a body at GitHub's limit and refuses one character over", () => {
		expect(notesProblem("x".repeat(RELEASE_NOTES_MAX_CHARS))).toBeNull();
		expect(notesProblem("x".repeat(RELEASE_NOTES_MAX_CHARS + 1))).toBe(
			"release notes are 125001 chars, over GitHub's 125000 limit",
		);
	});
});

describe("makeManifest", () => {
	test("tab-indented JSON with trailing newline", () => {
		const sha = "ab".repeat(32);
		expect(makeManifest("0.2.0", "omp-web-0.2.0.tgz", sha)).toBe(
			`{\n\t"version": "0.2.0",\n\t"tarball": "omp-web-0.2.0.tgz",\n\t"sha256": "${sha}"\n}\n`,
		);
	});
});

describe("validateTarball", () => {
	test("accepts a valid fixture tarball", async () => {
		const dir = tempDir("release-valid-");
		const tgz = await makeFixtureTgz(dir);
		const problems = await validateTarball(tgz, "0.1.0", shaOf(readFileSync(tgz)));
		expect(problems).toEqual([]);
	});

	test("reports a missing tarball file", async () => {
		const dir = tempDir("release-missing-");
		const problems = await validateTarball(join(dir, "nope.tgz"), "0.1.0", "0".repeat(64));
		expect(problems.some((p) => p.includes("missing"))).toBe(true);
	});

	test("reports a wrong tarball name", async () => {
		const dir = tempDir("release-name-");
		const tgz = await makeFixtureTgz(dir);
		const wrong = join(dir, "wrong-name.tgz");
		renameSync(tgz, wrong);
		const problems = await validateTarball(wrong, "0.1.0", shaOf(readFileSync(wrong)));
		expect(problems.some((p) => p.includes("does not match omp-web-0.1.0.tgz"))).toBe(true);
	});

	test("reports a missing shebang", async () => {
		const dir = tempDir("release-shebang-");
		const tgz = await makeFixtureTgz(dir, "console.log('omp-web 0.1.0 no shebang');\n");
		const problems = await validateTarball(tgz, "0.1.0", shaOf(readFileSync(tgz)));
		expect(problems.some((p) => p.includes("shebang"))).toBe(true);
	});

	test("reports a sha256 mismatch", async () => {
		const dir = tempDir("release-sha-");
		const tgz = await makeFixtureTgz(dir);
		const problems = await validateTarball(tgz, "0.1.0", "0".repeat(64));
		expect(problems.some((p) => p.includes("sha256 mismatch"))).toBe(true);
	});
});

describe("smokePackedTarballPlan", () => {
	const sandbox = join(tmpdir(), "omp-web-smoke-fixture");
	const tgz = join(tmpdir(), "omp-web-0.1.0.tgz");

	test("install argv targets the sandbox prefix + bin dir", () => {
		expect(smokePackedTarballPlan(tgz, sandbox).installArgs).toEqual([
			"bun",
			"scripts/install-omp-web.ts",
			tgz,
			"--prefix",
			join(sandbox, "datahome"),
			"--bin-dir",
			join(sandbox, "bin"),
		]);
	});

	test("relative tarball paths reach the child as absolute paths", () => {
		const plan = smokePackedTarballPlan(join("dist-release", "omp-web-0.1.0.tgz"), sandbox);
		expect(isAbsolute(plan.installArgs[2])).toBe(true);
		expect(plan.installArgs[2].endsWith(join("dist-release", "omp-web-0.1.0.tgz"))).toBe(true);
	});

	test("env confines HOME + BUN_INSTALL to the sandbox", () => {
		expect(smokePackedTarballPlan(tgz, sandbox).env).toEqual({
			HOME: join(sandbox, "home"),
			BUN_INSTALL: join(sandbox, "bun"),
		});
	});

	test("version probe runs the sandbox bin with --version", () => {
		const plan = smokePackedTarballPlan(tgz, sandbox);
		expect(plan.bin).toBe(join(sandbox, "bin", "omp-web"));
		expect(plan.versionArgs).toEqual([plan.bin, "--version"]);
	});
});

describe("parseReleaseArgs", () => {
	test("defaults: no flags, no version", () => {
		const r = parseReleaseArgs([]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args).toEqual({ dryRun: false, yes: false, noLlm: false, stage: false, go: false });
		}
	});

	test("positional version + all flags", () => {
		const r = parseReleaseArgs(["0.1.0", "--dry-run", "--yes", "--no-llm"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.version).toBe("0.1.0");
			expect(r.args.dryRun).toBe(true);
			expect(r.args.yes).toBe(true);
			expect(r.args.noLlm).toBe(true);
		}
	});

	test("--notes-file consumes the next arg", () => {
		const r = parseReleaseArgs(["0.2.0", "--notes-file", "notes/0.2.0.md"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.notesFile).toBe("notes/0.2.0.md");
			expect(r.args.version).toBe("0.2.0");
		}
	});

	test("--notes-file without a value is an error", () => {
		const r = parseReleaseArgs(["--notes-file"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("requires a path");
	});

	test("unknown flag is an error", () => {
		const r = parseReleaseArgs(["--bogus"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("--bogus");
	});

	test("a second positional is an error", () => {
		const r = parseReleaseArgs(["0.1.0", "0.2.0"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("0.2.0");
	});

	test("flag order is free and version may come last", () => {
		const r = parseReleaseArgs(["--yes", "0.1.0", "--dry-run"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.version).toBe("0.1.0");
			expect(r.args.yes).toBe(true);
			expect(r.args.dryRun).toBe(true);
		}
	});

	test("--stage and --go parse", () => {
		const stage = parseReleaseArgs(["0.2.0", "--stage"]);
		expect(stage.ok).toBe(true);
		if (stage.ok) expect(stage.args.stage).toBe(true);
		const go = parseReleaseArgs(["--go"]);
		expect(go.ok).toBe(true);
		if (go.ok) expect(go.args.go).toBe(true);
	});

	test("--stage and --go are mutually exclusive", () => {
		const r = parseReleaseArgs(["--stage", "--go"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("mutually exclusive");
	});

	test("--go rejects a version and generation flags", () => {
		for (const argv of [
			["--go", "0.2.0"],
			["--go", "--no-llm"],
			["--go", "--notes-file", "notes.md"],
		]) {
			const r = parseReleaseArgs(argv);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain("--go publishes");
		}
	});
});

describe("stagedProblems", () => {
	const MANIFEST = (sha: string) =>
		JSON.stringify({ version: "0.1.0", tarball: "omp-web-0.1.0.tgz", sha256: sha }, null, "\t") +
		"\n";
	const CHANGELOG = "# Changelog\n\n## v0.1.0, 2026-08-19\n\n### Features\n- thing\n";

	async function makeStagedDir(): Promise<string> {
		const dir = tempDir("release-staged-");
		const tgz = await makeFixtureTgz(dir);
		const sha = shaOf(readFileSync(tgz));
		writeFileSync(join(dir, "release-manifest.json"), MANIFEST(sha));
		writeFileSync(join(dir, "notes.md"), "manual notes\n");
		return dir;
	}

	test("accepts a complete valid staged dir", async () => {
		const dir = await makeStagedDir();
		expect(await stagedProblems(dir, "0.1.0", CHANGELOG)).toEqual([]);
	});

	test("reports a manifest version mismatch", async () => {
		const dir = await makeStagedDir();
		const sha = shaOf(readFileSync(join(dir, "omp-web-0.1.0.tgz")));
		writeFileSync(
			join(dir, "release-manifest.json"),
			JSON.stringify({ version: "9.9.9", tarball: "omp-web-0.1.0.tgz", sha256: sha }),
		);
		const problems = await stagedProblems(dir, "0.1.0", CHANGELOG);
		expect(problems.some((p) => p.includes("manifest version 9.9.9 != package.json 0.1.0"))).toBe(
			true,
		);
	});

	test("reports a missing notes artifact", async () => {
		const dir = await makeStagedDir();
		rmSync(join(dir, "notes.md"));
		const problems = await stagedProblems(dir, "0.1.0", CHANGELOG);
		expect(problems.some((p) => p.includes("staged notes missing"))).toBe(true);
	});

	test("reports staged notes GitHub would refuse as a release body", async () => {
		const dir = await makeStagedDir();
		writeFileSync(join(dir, "notes.md"), "x".repeat(RELEASE_NOTES_MAX_CHARS + 1));
		const problems = await stagedProblems(dir, "0.1.0", CHANGELOG);
		expect(problems.some((p) => p.includes("over GitHub's 125000 limit"))).toBe(true);
	});

	test("reports a missing manifest", async () => {
		const dir = await makeStagedDir();
		rmSync(join(dir, "release-manifest.json"));
		const problems = await stagedProblems(dir, "0.1.0", CHANGELOG);
		expect(problems.some((p) => p.includes("staged manifest missing"))).toBe(true);
	});

	test("reports a changelog lacking the version section", async () => {
		const dir = await makeStagedDir();
		const problems = await stagedProblems(dir, "0.1.0", "# Changelog\n\n## v0.0.1, old\n");
		expect(problems.some((p) => p.includes("CHANGELOG.md lacks the v0.1.0 section"))).toBe(true);
	});

	test("reports a sha256 mismatch through the manifest", async () => {
		const dir = await makeStagedDir();
		writeFileSync(join(dir, "release-manifest.json"), MANIFEST("0".repeat(64)));
		const problems = await stagedProblems(dir, "0.1.0", CHANGELOG);
		expect(problems.some((p) => p.includes("sha256 mismatch"))).toBe(true);
	});
});

describe("releaseTreeProblem", () => {
	const stagedAdd = "A  CHANGELOG.md\n";
	const stagedModify = " M package.json\n M CHANGELOG.md\n";

	test("accepts a first-release tree: staged CHANGELOG.md add only", () => {
		expect(releaseTreeProblem(stagedAdd)).toBeNull();
	});

	test("accepts a later-release tree: modified package.json + CHANGELOG.md", () => {
		expect(releaseTreeProblem(stagedModify)).toBeNull();
	});

	test("accepts the unstaged first-release variant (CHANGELOG.md add, dirty)", () => {
		expect(releaseTreeProblem("A? CHANGELOG.md\n")).toBeNull();
	});

	test("rejects a tree with no CHANGELOG.md", () => {
		const problem = releaseTreeProblem(" M package.json\n");
		expect(problem).toContain("no staged CHANGELOG.md");
	});

	test("rejects any unexpected working-tree change", () => {
		const problem = releaseTreeProblem(" M package.json\n M CHANGELOG.md\n M src/state.ts\n");
		expect(problem).toContain("src/state.ts");
	});
});
