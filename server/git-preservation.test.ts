/**
 * Git preservation-evidence regressions (P7.4 delete gate): real local Git,
 * operator gitconfig identity only. Each case must keep the daemon from
 * emitting deletion-authorizing evidence for unpreserved history — a decoy
 * GIT_DIR/GIT_WORK_TREE (or PATH-shadowed git) must not redirect the local
 * probes, a mutable global-config url rewrite must not redirect the probe
 * fetch, and an unpushed annotated tag object must report preserved:false —
 * while branch/detached-HEAD ancestry and pushed tag objects stay preserved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { captureGitCredentialSettings, collectGitEvidence } from "./git-preservation";

afterAll(cleanupTempDirs);

/** One `git -C <cwd> <args>` invocation (throws on failure). */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	return stdout.trim();
}

/** Real local repo with one commit on `main` (operator git identity only). */
async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await git(dir, ["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/** Bare source remote with the checkout's `main` pushed and set as its origin. */
async function makeSource(root: string, checkoutDir: string): Promise<string> {
	const remote = join(root, "source.git");
	mkdirSync(remote, { recursive: true });
	await git(remote, ["init", "-q", "--bare", "-b", "main"]);
	const url = `file://${remote}`;
	await git(checkoutDir, ["remote", "add", "origin", url]);
	await git(checkoutDir, ["push", "-q", "origin", "refs/heads/main:refs/heads/main"]);
	return url;
}

/** Restore a mutated process.env entry without fabricating a value. */
function restoreEnv(key: "GIT_DIR" | "GIT_WORK_TREE" | "PATH", value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

describe("collectGitEvidence local checkout probes", () => {
	test("ignores a post-start GIT_DIR/GIT_WORK_TREE decoy checkout", async () => {
		const root = tempDir("omp-git-decoy-");
		const checkout = await makeRepo(join(root, "checkout"));
		const sourceUrl = await makeSource(root, checkout);
		const decoy = join(root, "decoy");
		await git(root, ["clone", "-q", `file://${join(root, "source.git")}`, decoy]);
		writeFileSync(join(checkout, "dirty.txt"), "uncommitted\n");

		const savedDir = process.env.GIT_DIR;
		const savedTree = process.env.GIT_WORK_TREE;
		try {
			process.env.GIT_DIR = join(decoy, ".git");
			process.env.GIT_WORK_TREE = decoy;
			const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl });
			// The decoy clone is clean and fully preserved; the real checkout is dirty.
			expect(result.ok).toBe(true);
			expect(result.evidence?.status).toBe("dirty");
			expect(result.evidence?.dirty?.untracked).toBe(1);
		} finally {
			restoreEnv("GIT_DIR", savedDir);
			restoreEnv("GIT_WORK_TREE", savedTree);
		}
	});

	test("ignores a post-start PATH that shadows the git executable", async () => {
		const root = tempDir("omp-git-path-");
		const checkout = await makeRepo(join(root, "checkout"));
		const sourceUrl = await makeSource(root, checkout);
		writeFileSync(join(checkout, "dirty.txt"), "uncommitted\n");
		const bin = join(root, "bin");
		mkdirSync(bin);
		const fakeGit = join(bin, "git");
		writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n");
		chmodSync(fakeGit, 0o755);

		const savedPath = process.env.PATH;
		try {
			process.env.PATH = bin;
			const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl });
			expect(result.ok).toBe(true);
			expect(result.evidence?.status).toBe("dirty");
		} finally {
			restoreEnv("PATH", savedPath);
		}
	});

	test("does not replay a mutable GIT_CONFIG_GLOBAL path into the probe", async () => {
		const root = tempDir("omp-git-global-");
		const checkout = await makeRepo(join(root, "checkout"));
		// A source URL that does not resolve on its own.
		const sourceUrl = `file://${join(root, "missing-source.git")}`;
		await git(checkout, ["remote", "add", "origin", sourceUrl]);
		// A decoy bare repo that already holds the checkout's local tip.
		const decoyRemote = join(root, "decoy.git");
		mkdirSync(decoyRemote, { recursive: true });
		await git(decoyRemote, ["init", "-q", "--bare", "-b", "main"]);
		await git(checkout, ["push", "-q", decoyRemote, "refs/heads/main:refs/heads/main"]);

		const globalConfig = join(root, "global.gitconfig");
		writeFileSync(globalConfig, "");
		const credentials = captureGitCredentialSettings({
			...process.env,
			GIT_CONFIG_GLOBAL: globalConfig,
		});

		// Post-start mutation: rewrite the stored source URL to the decoy repo.
		// Honoring this config would report the local tip preserved and
		// authorize deletion of history that exists only in the checkout.
		writeFileSync(globalConfig, `[url "file://${decoyRemote}"]\n\tinsteadOf = ${sourceUrl}\n`);
		const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl, credentials });
		expect(result.ok).toBe(true);
		expect(result.evidence?.status).toBe("unknown");
	});
});

describe("collectGitEvidence remote preservation proof", () => {
	test("reports an unpushed annotated tag object as not preserved", async () => {
		const root = tempDir("omp-git-unpushed-tag-");
		const checkout = await makeRepo(join(root, "checkout"));
		const sourceUrl = await makeSource(root, checkout);
		await git(checkout, ["tag", "-a", "v1", "-m", "annotated regression tag"]);

		const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl });
		expect(result.ok).toBe(true);
		expect(result.evidence?.status).toBe("clean");
		const refs = result.evidence?.refs ?? [];
		expect(refs.find((ref) => ref.name === "refs/tags/v1")?.preserved).toBe(false);
		expect(refs.find((ref) => ref.name === "refs/heads/main")?.preserved).toBe(true);
	});

	test("reports a pushed annotated tag object as preserved", async () => {
		const root = tempDir("omp-git-pushed-tag-");
		const checkout = await makeRepo(join(root, "checkout"));
		const sourceUrl = await makeSource(root, checkout);
		await git(checkout, ["tag", "-a", "v1", "-m", "annotated regression tag"]);
		await git(checkout, ["push", "-q", "origin", "refs/tags/v1"]);

		const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl });
		expect(result.ok).toBe(true);
		expect(result.evidence?.status).toBe("clean");
		expect(result.evidence?.refs?.find((ref) => ref.name === "refs/tags/v1")?.preserved).toBe(true);
	});

	test("keeps commit ancestry for a detached HEAD", async () => {
		const root = tempDir("omp-git-detached-");
		const checkout = await makeRepo(join(root, "checkout"));
		writeFileSync(join(checkout, "second.md"), "two\n");
		await git(checkout, ["add", "."]);
		await git(checkout, ["commit", "-q", "-m", "second"]);
		const sourceUrl = await makeSource(root, checkout);
		await git(checkout, ["checkout", "-q", "--detach", "HEAD~1"]);

		const result = await collectGitEvidence(checkout, { sourceRemote: sourceUrl });
		expect(result.ok).toBe(true);
		expect(result.evidence?.status).toBe("clean");
		expect(result.evidence?.branch).toBeNull();
		expect(result.evidence?.refs?.find((ref) => ref.name === "HEAD")?.preserved).toBe(true);
	});
});
