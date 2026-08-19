/**
 * Pure deterministic core tests for scripts/release.ts. No git/gh/network/
 * build: only exported functions, with tempDir() scratch dirs for the
 * tarball-validation fixtures. `main` is never called here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
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
	prependChangelog,
	validateCoverage,
	validateTarball,
} from "./release";
import type { ChangelogDraft, CommitClass, CommitInfo, Group } from "./release";
import { cleanupTempDirs, tempDir } from "../shared/testkit";

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
		const raw =
			"abc1234\x1ffeat: add thing\x1fBody line 1\nBody line 2\x1e" +
			"def5678\x1ffix: bug\x1e" +
			"0beef00\x1fchore: empty body\x1f\x1e";
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
			"## v0.2.0 — 2026-08-19\n" +
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
			"## v0.2.0 — 2026-08-19\n\nA release.\n\n### Features\n- b\n",
		);
	});
});

describe("fallbackBullets + validateCoverage", () => {
	test("fallbackBullets format", () => {
		expect(fallbackBullets([commit("abc1234", "feat: add x")])).toEqual([
			"feat: add x ([abc1234](https://github.com/nibblebot/omp-web/commit/abc1234))",
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
		const section = "## v0.2.0 — 2026-08-19\n\n### Features\n- b1\n";
		const existing = "\n\n## v0.1.0 — 2026-08-01\n\nOld content.\n\n";
		expect(prependChangelog(existing, section)).toBe(
			"## v0.2.0 — 2026-08-19\n\n### Features\n- b1\n\n## v0.1.0 — 2026-08-01\n\nOld content.\n",
		);
	});

	test("empty existing returns the section unchanged", () => {
		const section = "## v0.2.0 — 2026-08-19\n\n### Features\n- b1\n";
		expect(prependChangelog("", section)).toBe(section);
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
