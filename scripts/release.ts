/**
 * omp-web release orchestrator (release-plan.md section 3).
 *
 * One command: `bun scripts/release.ts [<x.y.z>] [--dry-run] [--yes] [--no-llm]`.
 *
 * The deterministic core (commit classification, version bumping, changelog
 * skeleton, manifest generation, tarball validation) is exported for unit
 * tests; `main` wires it to git/gh/bun. The LLM changelog summarizer
 * (./release-llm) is dynamic-imported ONLY inside the release flow and
 * degrades to the deterministic fallback on any failure.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as readline from "node:readline/promises";
import { compareVersions, sha256Of } from "../cli/update";

export const GITHUB_REPO = "nibblebot/omp-web";
export const GITHUB_RELEASES_BASE = "https://github.com/nibblebot/omp-web/releases/latest/download";
export const COMMIT_URL = "https://github.com/nibblebot/omp-web/commit/";
export const MANIFEST_NAME = "release-manifest.json";
export const ARTIFACT_DIR = "dist-release/";

export type CommitClass = "breaking" | "feat" | "fix" | "other";

export interface CommitInfo {
	hash: string;
	subject: string;
	body: string;
}

export interface Group {
	cls: CommitClass;
	heading: string;
	commits: CommitInfo[];
}

/** LLM-shaped changelog draft: deterministic structure, LLM prose. Draft
 *  groups are cls-keyed (the heading mapping is ours, per the contract). */
export interface ChangelogDraft {
	overview: string | null;
	groups: { cls: CommitClass; bullets: string[] }[];
}

const HEADINGS: Record<CommitClass, string> = {
	breaking: "Breaking changes",
	feat: "Features",
	fix: "Bug fixes",
	other: "Maintenance & other",
};

const GROUP_ORDER: CommitClass[] = ["breaking", "feat", "fix", "other"];

const COMMIT_CLASSES: Record<CommitClass, true> = {
	breaking: true,
	feat: true,
	fix: true,
	other: true,
};

const USAGE = "usage: bun scripts/release.ts [<x.y.z>] [--dry-run] [--yes] [--no-llm]";

/**
 * Classify a commit subject/body (conventional-commits prefixes). A breaking
 * match wins over feat/fix; everything unrecognized (docs:, chore:, compound
 * prefixes like `fleet+ui:`, untyped subjects) is "other".
 */
export function classifyCommit(subject: string, body: string): CommitClass {
	// BREAKING CHANGE footer/note wins over everything.
	if (/BREAKING CHANGE/i.test(subject) || /BREAKING CHANGE/i.test(body)) return "breaking";
	// type!: and compound type+scope!: (e.g. "feat!:", "fleet+ui!:").
	if (/^[a-z]+(?:[a-z+]*)?!:/.test(subject)) return "breaking";
	// type(scope)!: (e.g. "feat(ui)!:").
	if (/^[a-z]+(?:[a-z+]*)?\([^)]*\)!:/.test(subject)) return "breaking";
	if (/^feat(?:\()?/.test(subject)) return "feat";
	if (/^fix(?:\()?/.test(subject)) return "fix";
	return "other";
}

/** Group commits by class, fixed order breaking/feat/fix/other; empty groups omitted. */
export function groupCommits(commits: CommitInfo[]): Group[] {
	const byClass: Record<CommitClass, CommitInfo[]> = { breaking: [], feat: [], fix: [], other: [] };
	for (const commit of commits) {
		byClass[classifyCommit(commit.subject, commit.body)].push(commit);
	}
	return GROUP_ORDER.filter((cls) => byClass[cls].length > 0).map((cls) => ({
		cls,
		heading: HEADINGS[cls],
		commits: byClass[cls],
	}));
}

/** Semver bump from classified groups: breaking -> major, feat -> minor, else patch. */
export function computeBump(groups: Group[]): "major" | "minor" | "patch" {
	if (groups.some((g) => g.cls === "breaking")) return "major";
	if (groups.some((g) => g.cls === "feat")) return "minor";
	return "patch";
}

/** Strict plain x.y.z semver (no prerelease/build segments). */
export function isValidSemver(v: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(v);
}

/** Numeric increment; throws unless `current` is a plain x.y.z. */
export function nextVersion(current: string, bump: "major" | "minor" | "patch"): string {
	if (!isValidSemver(current)) throw new Error(`not a plain x.y.z version: ${current}`);
	const [major, minor, patch] = current.split(".").map(Number);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

/** `v` newer than `current` (compareVersions: negative = a < b). */
export function isNewerVersion(v: string, current: string): boolean {
	return compareVersions(v, current) > 0;
}

/** Parse `git log --format=%H%x1f%s%x1f%b%x1e` output (entries \x1e, fields \x1f). */
export function parseGitLog(raw: string): CommitInfo[] {
	return raw
		.split("\x1e")
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const [hash, subject, body = ""] = entry.split("\x1f");
			return { hash, subject: subject ?? "", body };
		});
}

/** Deterministic changelog bullets: `<subject> ([<hash>](<COMMIT_URL><hash>))`. */
export function fallbackBullets(commits: { hash: string; subject: string }[]): string[] {
	return commits.map((c) => `${c.subject} ([${c.hash}](${COMMIT_URL}${c.hash}))`);
}

/**
 * Every commit hash in `groups` must appear in its own group's bullets
 * (string inclusion is enough). Reports per-group dropped hashes.
 */
export function validateCoverage(
	draft: ChangelogDraft,
	groups: Group[],
): { ok: boolean; missing: { cls: CommitClass; hashes: string[] }[] } {
	const missing: { cls: CommitClass; hashes: string[] }[] = [];
	for (const group of groups) {
		const draftGroup = draft.groups.find((dg) => dg.cls === group.cls);
		const joined = (draftGroup?.bullets ?? []).join("\n");
		const dropped = group.commits.filter((c) => !joined.includes(c.hash)).map((c) => c.hash);
		if (dropped.length > 0) missing.push({ cls: group.cls, hashes: dropped });
	}
	return { ok: missing.length === 0, missing };
}

/**
 * Exact changelog section format (asserted verbatim in tests):
 * `## v<version> — <date>`, blank, overview paragraph (omitted when null),
 * then per group `### <heading>` + bullets, blank between groups, trailing
 * newline.
 */
export function changelogSection(
	version: string,
	date: string,
	overview: string | null,
	groups: { heading: string; bullets: string[] }[],
): string {
	const parts: string[] = [`## v${version} — ${date}`];
	if (overview !== null) parts.push("", overview);
	for (const group of groups) parts.push("", `### ${group.heading}`, ...group.bullets);
	return parts.join("\n") + "\n";
}

/** Prepend `section` above `existing`, trimming stray blank lines; empty existing -> section. */
export function prependChangelog(existing: string, section: string): string {
	const trimmed = existing.trim();
	if (trimmed.length === 0) return section;
	return `${section.trimEnd()}\n\n${trimmed}\n`;
}

/** Tab-indented release manifest (same shape the update channel parses). */
export function makeManifest(version: string, tarball: string, sha256: string): string {
	return JSON.stringify({ version, tarball, sha256 }, null, "\t") + "\n";
}

interface RunResult {
	status: number;
	stdout: Buffer;
	stderr: Buffer;
}

/** Run a command, capturing stdout/stderr (read concurrently to avoid pipe deadlock). */
async function run(args: string[]): Promise<RunResult> {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
	]);
	const status = await proc.exited;
	return { status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function tail(buf: Buffer, max = 1500): string {
	const s = buf.toString().trim();
	return s.length === 0 ? "" : `\n${s.slice(-max)}`;
}

async function sha256File(path: string): Promise<string> {
	return sha256Of(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

/** Problems with a packed tarball (empty = valid). */
export async function validateTarball(
	tgzPath: string,
	version: string,
	sha256: string,
): Promise<string[]> {
	const problems: string[] = [];
	if (!existsSync(tgzPath)) {
		problems.push(`tarball missing: ${tgzPath}`);
		return problems;
	}
	const expectedName = `omp-web-${version}.tgz`;
	if (basename(tgzPath) !== expectedName) {
		problems.push(`tarball name ${basename(tgzPath)} does not match ${expectedName}`);
	}
	const listing = await run(["tar", "-tzf", tgzPath]);
	if (listing.status !== 0) {
		problems.push(`tar -tzf failed: ${listing.stderr.toString().trim()}`);
	} else {
		const members = listing.stdout.toString().split("\n");
		if (!members.includes("package/dist-bundle/cli.js")) {
			problems.push("tarball missing package/dist-bundle/cli.js");
		}
		const member = await run(["tar", "-xzOf", tgzPath, "package/dist-bundle/cli.js"]);
		if (member.status !== 0) {
			problems.push(
				`cannot extract package/dist-bundle/cli.js: ${member.stderr.toString().trim()}`,
			);
		} else {
			const content = member.stdout.toString();
			const firstLine = content.split("\n", 1)[0] ?? "";
			if (firstLine !== "#!/usr/bin/env bun") {
				problems.push(
					`cli.js shebang is ${JSON.stringify(firstLine)}, expected #!/usr/bin/env bun`,
				);
			}
			if (!content.includes(version)) {
				problems.push(`cli.js bundle does not contain version ${version}`);
			}
		}
	}
	const computed = await sha256File(tgzPath);
	if (computed !== sha256) {
		problems.push(`sha256 mismatch: computed ${computed}, manifest ${sha256}`);
	}
	return problems;
}

function todayLocal(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

function fail(msg: string): never {
	throw new Error(msg);
}

/** Validate an arbitrary LLM result into a ChangelogDraft (null on any shape problem). */
function normalizeDraft(value: unknown): ChangelogDraft | null {
	if (value === null || typeof value !== "object") return null;
	const raw = value as { overview?: unknown; groups?: unknown };
	if (!Array.isArray(raw.groups)) return null;
	const groups: ChangelogDraft["groups"] = [];
	for (const g of raw.groups) {
		if (g === null || typeof g !== "object") return null;
		const grp = g as { cls?: unknown; bullets?: unknown };
		if (typeof grp.cls !== "string" || !Array.isArray(grp.bullets)) return null;
		if (
			COMMIT_CLASSES[grp.cls as CommitClass] !== true ||
			!grp.bullets.every((b) => typeof b === "string")
		) {
			return null;
		}
		groups.push({ cls: grp.cls as CommitClass, bullets: grp.bullets });
	}
	const overview =
		typeof raw.overview === "string" && raw.overview.length > 0 ? raw.overview : null;
	return { overview, groups };
}

/**
 * Build the final section: LLM bullets where coverage holds, deterministic
 * fallback bullets per group otherwise; null draft -> all fallback.
 */
function buildChangelog(
	draft: ChangelogDraft | null,
	groups: Group[],
	version: string,
	date: string,
): string {
	const finalGroups: { heading: string; bullets: string[] }[] = [];
	if (draft === null) {
		for (const g of groups)
			finalGroups.push({ heading: g.heading, bullets: fallbackBullets(g.commits) });
	} else {
		const coverage = validateCoverage(draft, groups);
		for (const g of groups) {
			const dropped = coverage.missing.find((m) => m.cls === g.cls);
			const llmBullets = draft.groups.find((dg) => dg.cls === g.cls)?.bullets;
			finalGroups.push({
				heading: g.heading,
				bullets:
					dropped === undefined
						? (llmBullets ?? fallbackBullets(g.commits))
						: fallbackBullets(g.commits),
			});
		}
	}
	return changelogSection(version, date, draft?.overview ?? null, finalGroups);
}

/**
 * Release orchestrator: preconditions -> commit review -> version -> gate ->
 * changelog -> (dry-run | confirm) -> version write -> build/pack -> manifest
 * -> validate -> commit/tag/push -> gh release -> verify. Never returns a
 * failing state silently: every failure path sets process.exitCode = 1.
 */
async function release(argv: string[]): Promise<void> {
	let versionArg: string | undefined;
	let dryRun = false;
	let yes = false;
	let noLlm = false;
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--no-llm") {
			noLlm = true;
			continue;
		}
		if (arg.startsWith("-") || versionArg !== undefined) {
			console.error(`${USAGE}\nrelease: unknown flag: ${arg}`);
			process.exitCode = 1;
			return;
		}
		versionArg = arg;
	}

	// 1. Preconditions.
	const porcelain = await run(["git", "status", "--porcelain"]);
	if (porcelain.stdout.toString().trim() !== "") {
		fail(`working tree not clean:\n${porcelain.stdout.toString().trim()}`);
	}
	console.log("release: ok clean working tree");
	const branch = (await run(["git", "branch", "--show-current"])).stdout.toString().trim();
	if (branch !== "main") fail(`not on branch main (on ${branch})`);
	console.log("release: ok on branch main");
	const auth = await run(["gh", "auth", "status"]);
	if (auth.status !== 0) fail(`gh auth status failed (exit ${auth.status})${tail(auth.stderr)}`);
	console.log("release: ok gh authenticated");
	const remotes = (await run(["git", "remote"])).stdout
		.toString()
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (!remotes.includes("origin")) fail(`no origin remote (have: ${remotes.join(", ") || "none"})`);
	console.log("release: ok origin remote present");

	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
	const current = pkg.version;
	if (versionArg !== undefined && !isValidSemver(versionArg)) {
		fail(`invalid version ${versionArg} (expected plain x.y.z)`);
	}

	// 2. Review commits since the previous release.
	const describe = await run(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"]);
	const prevTag = describe.status === 0 ? describe.stdout.toString().trim() : null;
	const firstRelease = prevTag === null;
	const range = firstRelease ? "HEAD" : `${prevTag}..HEAD`;
	const logRaw = (
		await run(["git", "log", "--format=%H%x1f%s%x1f%b%x1e", range])
	).stdout.toString();
	const commits = parseGitLog(logRaw);
	const groups = groupCommits(commits);
	const countOf = (cls: CommitClass): number =>
		groups.find((g) => g.cls === cls)?.commits.length ?? 0;
	const counts = {
		breaking: countOf("breaking"),
		feat: countOf("feat"),
		fix: countOf("fix"),
		other: countOf("other"),
	};
	console.log(
		`release: ${commits.length} commits since ${prevTag ?? "the beginning"}${firstRelease ? " (first release)" : ""}`,
	);
	for (const c of commits) console.log(`release:   ${c.hash.slice(0, 8)} ${c.subject}`);
	const countParts: string[] = [];
	if (counts.breaking > 0) countParts.push(`${counts.breaking} breaking`);
	countParts.push(`${counts.feat} feat`, `${counts.fix} fix`, `${counts.other} other`);
	console.log(`release: classification: ${countParts.join(", ")}`);

	// 3. Version: explicit arg wins; else first release keeps current; else bump.
	let version: string;
	let bump: "major" | "minor" | "patch";
	if (versionArg !== undefined) {
		version = versionArg;
		bump = computeBump(groups);
		if (firstRelease) {
			if (!isNewerVersion(version, current) && version !== current) {
				fail(`version ${version} is older than current ${current}`);
			}
		} else if (!isNewerVersion(version, current)) {
			fail(`version ${version} is not newer than current ${current}`);
		}
		console.log(`release: explicit version v${version}`);
	} else if (firstRelease) {
		version = current;
		bump = computeBump(groups);
		console.log(`release: first release, keeping v${current}`);
	} else {
		bump = computeBump(groups);
		version = nextVersion(current, bump);
		console.log(`release: computed v${current} -> v${version} (${bump}: ${countParts.join(", ")})`);
	}

	// Tag absence (local + remote; ls-remote failure = remote unreachable -> fail).
	const tag = `v${version}`;
	const localTag = await run(["git", "tag", "-l", tag]);
	if (localTag.stdout.toString().trim() === tag) fail(`tag ${tag} already exists locally`);
	console.log(`release: ok tag ${tag} absent locally`);
	const remoteTag = await run(["git", "ls-remote", "origin", `refs/tags/${tag}`]);
	if (remoteTag.status !== 0) {
		fail(
			`git ls-remote origin failed (remote must exist and be reachable)${tail(remoteTag.stderr)}`,
		);
	}
	if (remoteTag.stdout.toString().trim() !== "") fail(`tag ${tag} already exists on origin`);
	console.log(`release: ok tag ${tag} absent on origin`);

	// 4. Gate (skipped in --dry-run; dry-run only previews the plan).
	// build:web runs before test: the daemon suite asserts static UI serving
	// at /, which needs dist/ (gitignored; absent on fresh worktrees).
	if (!dryRun) {
		for (const cmd of ["check:types", "format:check", "build:web", "test"]) {
			console.log(`release: running bun run ${cmd}`);
			const res = await run(["bun", "run", cmd]);
			if (res.status !== 0)
				fail(`gate failed: bun run ${cmd} (exit ${res.status})${tail(res.stderr)}`);
			console.log(`release: ok gate bun run ${cmd}`);
		}
	} else {
		console.log("release: skipping gate (--dry-run)");
	}

	// 5. Changelog (LLM-assisted, deterministic fallback).
	const date = todayLocal();
	let draft: ChangelogDraft | null = null;
	let llmUsed = false;
	if (!noLlm) {
		// Dynamic import (not static): ./release-llm is the sibling slice's
		// optional module — it may not exist yet, and tests of this file must
		// pass without it. Static import would fail the module graph at load.
		const mod = (await import("./release-llm").catch(() => null)) as {
			summarizeChangelog?: (input: unknown, opts?: unknown) => Promise<unknown>;
		} | null;
		if (mod?.summarizeChangelog !== undefined) {
			try {
				const result = await mod.summarizeChangelog({ version, groups }, {});
				draft = normalizeDraft(result);
				llmUsed = draft !== null;
			} catch (err) {
				console.error(
					`release: warning: LLM changelog unavailable (${err instanceof Error ? err.message : String(err)}); falling back`,
				);
			}
		}
	}
	if (noLlm) console.log("release: changelog: deterministic fallback (--no-llm)");
	else if (llmUsed) console.log("release: changelog: LLM prose");
	else console.log("release: changelog: deterministic fallback");
	const section = buildChangelog(draft, groups, version, date);

	// 6. Dry run: print the full plan, touch nothing.
	if (dryRun) {
		const artifactNames = [
			`${ARTIFACT_DIR}omp-web-${version}.tgz`,
			`${ARTIFACT_DIR}${MANIFEST_NAME}`,
			`${ARTIFACT_DIR}notes.md`,
		];
		console.log("release: ---- dry run (nothing will be written or pushed) ----");
		console.log(`release: repo: ${GITHUB_REPO}`);
		console.log(`release: tag: ${tag}`);
		console.log(
			`release: version: ${version}${versionArg !== undefined ? " (explicit)" : ` (${bump} bump from ${current})`}`,
		);
		console.log(`release: commits: ${commits.length} since ${prevTag ?? "the beginning"}`);
		console.log(`release: classification: ${countParts.join(", ")}`);
		console.log("release: changelog:");
		console.log(section.replace(/^/gm, "  "));
		console.log(`release: artifacts: ${artifactNames.join(", ")}`);
		console.log("release: commands that would run:");
		const planned = [
			"bun run check:types",
			"bun run format:check",
			"bun run build:web",
			"bun run test",
			"bun run build",
			"bun pm pack",
			"git add package.json CHANGELOG.md",
			`git commit -m "release: ${tag}"`,
			`git tag ${tag}`,
			"git push origin main --follow-tags",
			`gh release create ${tag} ${ARTIFACT_DIR}omp-web-${version}.tgz ${ARTIFACT_DIR}${MANIFEST_NAME} --repo ${GITHUB_REPO} --title "${tag}" --notes-file ${ARTIFACT_DIR}notes.md`,
		];
		for (const cmd of planned) console.log(`release:   ${cmd}`);
		console.log("release: dry run complete; nothing changed");
		return;
	}

	// 7. Confirm.
	if (!yes) {
		if (!process.stdin.isTTY) fail("refusing to release without a TTY; pass --yes");
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question(
			`release: create ${tag} on ${GITHUB_REPO} from ${commits.length} commits? [y/N] `,
		);
		rl.close();
		if (!/^y(?:es)?$/i.test(answer.trim())) {
			console.log("release: aborted");
			process.exitCode = 1;
			return;
		}
	}

	// 8. Version write: package.json (tab indent + trailing newline) and CHANGELOG.md.
	const pkgPath = "package.json";
	const pkgObj = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
	pkgObj.version = version;
	writeFileSync(pkgPath, JSON.stringify(pkgObj, null, "\t") + "\n");
	console.log(`release: wrote version ${version} to package.json`);
	const changelogPath = "CHANGELOG.md";
	const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
	writeFileSync(changelogPath, prependChangelog(existingChangelog, section));
	console.log(`release: wrote ${changelogPath}`);

	// 9. Build + pack, artifacts into dist-release/.
	console.log("release: running bun run build");
	const buildRes = await run(["bun", "run", "build"]);
	if (buildRes.status !== 0)
		fail(`bun run build failed (exit ${buildRes.status})${tail(buildRes.stderr)}`);
	console.log("release: ok build");
	console.log("release: running bun pm pack");
	const packRes = await run(["bun", "pm", "pack"]);
	if (packRes.status !== 0)
		fail(`bun pm pack failed (exit ${packRes.status})${tail(packRes.stderr)}`);
	console.log("release: ok packed");
	const tarballName = `omp-web-${version}.tgz`;
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	renameSync(tarballName, `${ARTIFACT_DIR}${tarballName}`);
	console.log(`release: moved ${tarballName} into ${ARTIFACT_DIR}`);

	// 10. Manifest: sha256 over the exact packed bytes.
	const tarballPath = `${ARTIFACT_DIR}${tarballName}`;
	const sha = await sha256File(tarballPath);
	writeFileSync(`${ARTIFACT_DIR}${MANIFEST_NAME}`, makeManifest(version, tarballName, sha));
	console.log(`release: wrote ${ARTIFACT_DIR}${MANIFEST_NAME} (sha256 ${sha})`);

	// 11. Validate the packaged release.
	const problems = await validateTarball(tarballPath, version, sha);
	if (problems.length > 0) {
		fail(`tarball validation failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
	console.log("release: ok tarball validated");

	// 12. Commit/tag/push.
	const addRes = await run(["git", "add", "package.json", "CHANGELOG.md"]);
	if (addRes.status !== 0) fail(`git add failed (exit ${addRes.status})${tail(addRes.stderr)}`);
	const commitRes = await run(["git", "commit", "-m", `release: ${tag}`]);
	if (commitRes.status !== 0)
		fail(`git commit failed (exit ${commitRes.status})${tail(commitRes.stderr)}`);
	console.log("release: ok committed");
	const tagRes = await run(["git", "tag", tag]);
	if (tagRes.status !== 0) fail(`git tag failed (exit ${tagRes.status})${tail(tagRes.stderr)}`);
	console.log(`release: ok tagged ${tag}`);
	const pushRes = await run(["git", "push", "origin", "main", "--follow-tags"]);
	if (pushRes.status !== 0) fail(`git push failed (exit ${pushRes.status})${tail(pushRes.stderr)}`);
	console.log("release: ok pushed to origin main");

	// 13. Release (always a full, published, non-draft/non-prerelease release).
	writeFileSync(`${ARTIFACT_DIR}notes.md`, section);
	console.log("release: running gh release create");
	const relRes = await run([
		"gh",
		"release",
		"create",
		tag,
		tarballPath,
		`${ARTIFACT_DIR}${MANIFEST_NAME}`,
		"--repo",
		GITHUB_REPO,
		"--title",
		tag,
		"--notes-file",
		`${ARTIFACT_DIR}notes.md`,
	]);
	if (relRes.status !== 0)
		fail(`gh release create failed (exit ${relRes.status})${tail(relRes.stderr)}`);
	console.log("release: ok release created");

	// 14. Verify the stable latest-download channel reports the new version,
	// then cross-check the downloadable tarball's sha256 (bounded: 12 x 5s).
	let verified = false;
	let lastErr = "unknown error";
	for (let attempt = 1; attempt <= 12 && !verified; attempt++) {
		const manifestRes = await run(["curl", "-fsSL", `${GITHUB_RELEASES_BASE}/${MANIFEST_NAME}`]);
		if (manifestRes.status === 0) {
			try {
				const remoteManifest = JSON.parse(manifestRes.stdout.toString()) as {
					version?: string;
					tarball?: string;
					sha256?: string;
				};
				if (remoteManifest.version === version) {
					const tarballRes = await run([
						"curl",
						"-fsSL",
						`${GITHUB_RELEASES_BASE}/${remoteManifest.tarball ?? tarballName}`,
					]);
					if (tarballRes.status === 0) {
						const downloadedSha = sha256Of(tarballRes.stdout);
						if (downloadedSha === remoteManifest.sha256) {
							console.log(
								`release: ok verified manifest + tarball on releases/latest (sha256 ${downloadedSha})`,
							);
							verified = true;
						} else {
							lastErr = `downloaded tarball sha256 ${downloadedSha} != manifest ${remoteManifest.sha256}`;
						}
					} else {
						lastErr = `tarball download failed (exit ${tarballRes.status}): ${tarballRes.stderr.toString().trim()}`;
					}
				} else {
					lastErr = `manifest reports ${remoteManifest.version}, waiting for ${version}`;
				}
			} catch {
				lastErr = `manifest not parseable: ${manifestRes.stdout.toString().slice(0, 200)}`;
			}
		} else {
			lastErr = `curl manifest failed (exit ${manifestRes.status}): ${manifestRes.stderr.toString().trim()}`;
		}
		if (!verified && attempt < 12) {
			console.log(`release: verify attempt ${attempt} failed (${lastErr}); retrying in 5s`);
			await Bun.sleep(5000);
		}
	}
	if (!verified) fail(`release verification failed after 12 attempts: ${lastErr}`);

	console.log("release: done");
	console.log(`release: tag ${tag}`);
	console.log(`release: release https://github.com/${GITHUB_REPO}/releases/tag/${tag}`);
	console.log(
		`release: artifacts ${ARTIFACT_DIR}${tarballName}, ${ARTIFACT_DIR}${MANIFEST_NAME}, ${ARTIFACT_DIR}notes.md`,
	);
}

/** Entry point: errors -> `release: error: <msg>` on stderr, exit code 1. */
export async function main(argv: string[]): Promise<void> {
	try {
		await release(argv);
	} catch (err) {
		console.error(`release: error: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	void main(process.argv.slice(2));
}
