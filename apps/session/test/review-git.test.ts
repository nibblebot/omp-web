import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@oh-my-pi/pi-natives/vcs";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { RepoAdapter, RepoStaleError } from "../review-git";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	cleanupTempDirs();
});

// Native VCS discovery has no init API. Construct an empty repository rather
// than invoking a shell, borrowing a checkout, or inheriting an init template.
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "omp-review-git-"));
	roots.push(cwd);
	await mkdir(join(cwd, ".git/objects"), { recursive: true });
	await mkdir(join(cwd, ".git/refs/heads"), { recursive: true });
	await mkdir(join(cwd, ".git/hooks"), { recursive: true });
	await Bun.write(join(cwd, ".git/HEAD"), "ref: refs/heads/main\n");
	await Bun.write(
		join(cwd, ".git/config"),
		"[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
	);
	const repo = git(cwd);
	if (!repo) throw new Error("native VCS did not discover disposable repository");
	await repo.configSet("user.name", "Review fixture", null);
	await repo.configSet("user.email", "review@example.invalid", null);
	await repo.configSet("commit.gpgsign", "false", null);
	await repo.configSet("core.hooksPath", join(cwd, ".git/hooks"), null);
	await repo.configSet("core.excludesFile", "/dev/null", null);
	await repo.configSet("core.attributesFile", "/dev/null", null);
	await repo.configSet("core.autocrlf", "false", null);
	await repo.configSet("diff.renames", "true", null);
	const write = (path: string, text: string | Uint8Array) => Bun.write(join(cwd, path), text);
	await write("tracked.txt", "original\n");
	await write("rename.txt", "rename fixture\n");
	await write("binary.bin", new Uint8Array([0, 1, 2, 3]));
	await repo.stageFiles(["tracked.txt", "rename.txt", "binary.bin"], null);
	await repo.commitCreate("fixture baseline", {}, null);
	return { cwd, repo, write, adapter: new RepoAdapter({ cwd }) };
}

describe("repository review mutations", () => {
	test("distinguishes index, worktree, untracked, binary and renamed files", async () => {
		const { cwd, repo, write, adapter } = await fixture();
		await write("tracked.txt", "staged\n");
		await repo.stageFiles(["tracked.txt"], null);
		await write("tracked.txt", "unstaged\n");
		await write("untracked.txt", "new\n");
		await write("binary.bin", new Uint8Array([0, 4, 5, 6]));
		await rename(join(cwd, "rename.txt"), join(cwd, "renamed.txt"));
		await repo.stageFiles(["rename.txt", "renamed.txt"], null);
		const snapshot = await adapter.snapshot();
		expect(snapshot.staged.some((file) => file.path === "tracked.txt")).toBe(true);
		expect(snapshot.unstaged.some((file) => file.path === "tracked.txt")).toBe(true);
		expect(snapshot.unstaged.find((file) => file.path === "untracked.txt")?.kind).toBe("untracked");
		expect(snapshot.staged.find((file) => file.path === "renamed.txt")?.kind).toBe("renamed");
		expect((await adapter.fileDiff("binary.bin", "unstaged")).binary).toBe(true);
	});

	test("stages only selected hunks and rejects invalid selection without changing index", async () => {
		const { repo, write, adapter } = await fixture();
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		await write("tracked.txt", `${lines.join("\n")}\n`);
		await repo.stageFiles(["tracked.txt"], null);
		await repo.commitCreate("multihunk baseline", {}, null);
		lines[1] = "first edit";
		lines[27] = "last edit";
		await write("tracked.txt", `${lines.join("\n")}\n`);
		const initial = await adapter.snapshot();
		await expect(
			adapter.stageHunks("tracked.txt", [99], initial.indexFingerprint),
		).rejects.toThrow();
		expect((await adapter.snapshot()).indexFingerprint).toBe(initial.indexFingerprint);
		const staged = await adapter.stageHunks("tracked.txt", [1], initial.indexFingerprint);
		expect(staged.staged.map((file) => file.path)).toContain("tracked.txt");
		expect(staged.unstaged.map((file) => file.path)).toContain("tracked.txt");
		const diff = await adapter.fileDiff("tracked.txt", "staged");
		expect(diff.patch).toContain("+first edit");
		expect(diff.patch).not.toContain("last edit");
	});

	test("file diffs carry hunks (unstaged) or patch text (staged, commit), never whole file text", async () => {
		const { repo, write, adapter } = await fixture();
		await write("tracked.txt", "committed change\n");
		await repo.stageFiles(["tracked.txt"], null);
		await repo.commitCreate("change tracked", {}, null);
		await write("tracked.txt", "staged change\n");
		await repo.stageFiles(["tracked.txt"], null);
		await write("tracked.txt", "worktree change\n");

		const unstaged = await adapter.fileDiff("tracked.txt", "unstaged");
		expect(unstaged.hunks).toHaveLength(1);
		expect(unstaged.hunks[0].text).toContain("+worktree change");
		expect(unstaged.patch).toBeUndefined();

		const staged = await adapter.fileDiff("tracked.txt", "staged");
		expect(staged.hunks).toEqual([]);
		expect(staged.patch).toContain("-committed change");
		expect(staged.patch).toContain("+staged change");

		const commit = await adapter.fileDiff("tracked.txt", "commit");
		expect(commit.hunks).toEqual([]);
		expect(commit.patch).toContain("-original");
		expect(commit.patch).toContain("+committed change");

		for (const answer of [unstaged, staged, commit]) {
			expect(answer).not.toHaveProperty("oldText");
			expect(answer).not.toHaveProperty("newText");
		}
	});

	test("same porcelain status with a concurrent content edit refuses stage", async () => {
		const { write, adapter } = await fixture();
		await write("tracked.txt", "first draft\n");
		const initial = await adapter.snapshot();
		await write("tracked.txt", "second draft\n");
		await expect(
			adapter.stageSelected(["tracked.txt"], initial.indexFingerprint),
		).rejects.toBeInstanceOf(RepoStaleError);
		expect((await adapter.snapshot()).staged).toHaveLength(0);
	});

	test("concurrent index content changes refuse commit without consuming its message", async () => {
		const { repo, write, adapter } = await fixture();
		await write("tracked.txt", "first index\n");
		await repo.stageFiles(["tracked.txt"], null);
		const initial = await adapter.snapshot();
		await write("tracked.txt", "second index\n");
		await repo.stageFiles(["tracked.txt"], null);
		const message = "operator draft";
		await expect(adapter.commitSelected(message, initial.indexFingerprint)).rejects.toBeInstanceOf(
			RepoStaleError,
		);
		expect((await adapter.snapshot()).head?.sha).toBe(initial.head?.sha);
		expect(message).toBe("operator draft");
	});

	test("empty selection and escaping paths never stage everything", async () => {
		const { write, adapter } = await fixture();
		await write("tracked.txt", "edited\n");
		const initial = await adapter.snapshot();
		await expect(adapter.stageSelected([], initial.indexFingerprint)).rejects.toThrow();
		for (const path of ["../outside", "/outside", "a/../../outside", "bad\0path"]) {
			await expect(adapter.stageSelected([path], initial.indexFingerprint)).rejects.toThrow();
			await expect(adapter.fileDiff(path, "unstaged")).rejects.toThrow();
		}
		expect((await adapter.snapshot()).staged).toHaveLength(0);
	});

	test("commit includes only the explicitly staged index", async () => {
		const { write, adapter } = await fixture();
		await write("tracked.txt", "staged version\n");
		const staged = await adapter.stageSelected(
			["tracked.txt"],
			(await adapter.snapshot()).indexFingerprint,
		);
		await write("untracked.txt", "must not commit\n");
		const live = await adapter.snapshot();
		expect(live.head?.sha).toBe(staged.head?.sha);
		await adapter.commitSelected("explicit commit", live.indexFingerprint);
		const after = await adapter.snapshot();
		expect(after.staged).toHaveLength(0);
		expect(after.unstaged.find((file) => file.path === "untracked.txt")?.kind).toBe("untracked");
	});

	test("failed pre-commit hook surfaces stderr and permits retry with the same draft", async () => {
		const { cwd, write, adapter } = await fixture();
		await write("tracked.txt", "edited\n");
		const staged = await adapter.stageSelected(
			["tracked.txt"],
			(await adapter.snapshot()).indexFingerprint,
		);
		const hook = join(cwd, ".git/hooks/pre-commit");
		await Bun.write(hook, "#!/bin/sh\nprintf 'fixture hook refusal\\n' >&2\nexit 1\n");
		await chmod(hook, 0o755);
		const message = "retained operator message";
		await expect(adapter.commitSelected(message, staged.indexFingerprint)).rejects.toThrow(
			"fixture hook refusal",
		);
		const after = await adapter.snapshot();
		expect(after.head?.sha).toBe(staged.head?.sha);
		expect(after.staged).toHaveLength(1);
		await rm(hook);
		await adapter.commitSelected(message, after.indexFingerprint);
		expect((await adapter.snapshot()).head?.subject).toBe(message);
	});

	test("untracked fingerprint is stat-based: same-size rewrite with restored mtime keeps it, size change moves it", async () => {
		const { cwd, write, adapter } = await fixture();
		const file = join(cwd, "untracked.txt");
		const mtimeRef = join(tempDir("omp-review-git-stamp-"), "mtime");
		const touchFrom = async (target: string, ref: string) => {
			const proc = Bun.spawn(["touch", "-r", ref, target]);
			if ((await proc.exited) !== 0) throw new Error(`touch -r ${ref} ${target} failed`);
		};
		await write("untracked.txt", "aaaa\n");
		await Bun.write(mtimeRef, "");
		await touchFrom(mtimeRef, file);
		const before = (await adapter.snapshot()).worktreeFingerprint;
		await write("untracked.txt", "bbbb\n");
		await touchFrom(file, mtimeRef);
		expect((await adapter.snapshot()).worktreeFingerprint).toBe(before);
		await write("untracked.txt", "bbbbbb\n");
		expect((await adapter.snapshot()).worktreeFingerprint).not.toBe(before);
	});
});
