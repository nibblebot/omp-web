/**
 * Hermetic tests for fleet/fs-browse.ts: nested listings, dot-dir skipping
 * (listing only — explicit navigation into a dot-dir still works), hasGit
 * for `.git` as directory AND file, the truncation cap (stubbed via the
 * cap option), `~` expansion, missing/not-a-directory errors, and symlink
 * canonicalization. No git, no daemons.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { BrowseError, browseDirectories } from "./fs-browse";

afterAll(cleanupTempDirs);

describe("browseDirectories", () => {
	test("lists subdirectories name-sorted, files excluded", async () => {
		const root = tempDir("omp-browse-");
		mkdirSync(join(root, "zeta"));
		mkdirSync(join(root, "alpha"));
		mkdirSync(join(root, "mid", "nested"), { recursive: true });
		writeFileSync(join(root, "file.txt"), "x");
		const result = await browseDirectories(root);
		expect(result.path).toBe(await realpath(root));
		expect(result.parent).toBe(await realpath(join(root, "..")));
		expect(result.truncated).toBe(false);
		expect(result.dirs.map((d) => d.name)).toEqual(["alpha", "mid", "zeta"]);
		expect(result.dirs[1]).toEqual({
			name: "mid",
			path: join(await realpath(root), "mid"),
			hasGit: false,
		});
	});

	test("default path is the home directory", async () => {
		const result = await browseDirectories();
		expect(result.path).toBe(await realpath(homedir()));
	});

	test("dot-directories are skipped in the listing but navigable explicitly", async () => {
		const root = tempDir("omp-browse-");
		mkdirSync(join(root, ".hidden"));
		mkdirSync(join(root, ".config", "inner"), { recursive: true });
		mkdirSync(join(root, "visible"));
		const result = await browseDirectories(root);
		expect(result.dirs.map((d) => d.name)).toEqual(["visible"]);
		// Explicit navigation into a dot-path works (the skip is listing-only).
		const dot = await browseDirectories(join(root, ".config"));
		expect(dot.dirs.map((d) => d.name)).toEqual(["inner"]);
	});

	test("hasGit is true for a .git directory and a .git file alike", async () => {
		const root = tempDir("omp-browse-");
		mkdirSync(join(root, "main-checkout", ".git"), { recursive: true });
		mkdirSync(join(root, "linked-wt"));
		writeFileSync(join(root, "linked-wt", ".git"), "gitdir: /nowhere\n");
		mkdirSync(join(root, "plain"));
		const byName = new Map((await browseDirectories(root)).dirs.map((d) => [d.name, d]));
		expect(byName.get("main-checkout")?.hasGit).toBe(true);
		expect(byName.get("linked-wt")?.hasGit).toBe(true);
		expect(byName.get("plain")?.hasGit).toBe(false);
	});

	test("the cap truncates to the alphabetical prefix and flips truncated", async () => {
		const root = tempDir("omp-browse-");
		for (const name of ["a", "b", "c", "d"]) mkdirSync(join(root, name));
		writeFileSync(join(root, "e-file"), "x"); // not a dir: never counts
		const result = await browseDirectories(root, { cap: 2 });
		expect(result.dirs.map((d) => d.name)).toEqual(["a", "b"]);
		expect(result.truncated).toBe(true);
		// Exactly-at-cap is NOT truncated; trailing non-dirs don't flip it either.
		const exact = await browseDirectories(root, { cap: 4 });
		expect(exact.dirs).toHaveLength(4);
		expect(exact.truncated).toBe(false);
	});

	test("a dangling symlink and a symlink to a file are skipped; a dir symlink lists", async () => {
		const root = tempDir("omp-browse-");
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "doc.txt"), "x");
		symlinkSync(join(root, "missing"), join(root, "dangling"));
		symlinkSync(join(root, "doc.txt"), join(root, "file-link"));
		symlinkSync(join(root, "real"), join(root, "dir-link"));
		const result = await browseDirectories(root);
		expect(result.dirs.map((d) => d.name)).toEqual(["dir-link", "real"]);
	});

	test("a symlink requested path canonicalizes to the realpath", async () => {
		const root = tempDir("omp-browse-");
		mkdirSync(join(root, "target", "child"), { recursive: true });
		symlinkSync(join(root, "target"), join(root, "link"));
		const result = await browseDirectories(join(root, "link"));
		expect(result.path).toBe(await realpath(join(root, "target")));
		expect(result.dirs.map((d) => d.name)).toEqual(["child"]);
	});

	test("~ expands to the home directory", async () => {
		expect((await browseDirectories("~")).path).toBe(await realpath(homedir()));
	});

	test("~/ expansion navigates into a home-relative path", async () => {
		const probe = join(homedir(), ".omp-browse-probe");
		mkdirSync(join(probe, "inner"), { recursive: true });
		try {
			const result = await browseDirectories("~/.omp-browse-probe");
			expect(result.path).toBe(await realpath(probe));
			expect(result.dirs.map((d) => d.name)).toEqual(["inner"]);
		} finally {
			await rm(probe, { recursive: true, force: true });
		}
	});

	test("the filesystem root has a null parent", async () => {
		const result = await browseDirectories("/");
		expect(result.path).toBe("/");
		expect(result.parent).toBeNull();
	});

	test("a missing path throws BrowseError", async () => {
		const root = tempDir("omp-browse-");
		await expect(browseDirectories(join(root, "gone"))).rejects.toBeInstanceOf(BrowseError);
		await expect(browseDirectories(join(root, "gone"))).rejects.toThrow("no such directory");
	});

	test("a file path throws BrowseError (not a directory)", async () => {
		const root = tempDir("omp-browse-");
		const file = join(root, "file.txt");
		writeFileSync(file, "x");
		await expect(browseDirectories(file)).rejects.toBeInstanceOf(BrowseError);
		await expect(browseDirectories(file)).rejects.toThrow("not a directory");
	});
});
