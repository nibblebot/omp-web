/**
 * Directory browsing for the project directory picker (`GET /ctl/fs/browse`).
 *
 * Lists the SUBDIRECTORIES of one directory, name-sorted, each tagged with
 * `hasGit` (a `.git` entry exists — directory for a main checkout, file for
 * a linked worktree). Dot-directories are skipped in the listing only:
 * explicitly navigating INTO a dot-path still works. The requested path is
 * `~`/`~/`-expanded and canonicalized to its realpath. Entries whose stat
 * fails (dangling symlinks, permission errors) are skipped silently; a
 * missing / not-a-directory / unreadable REQUESTED path throws BrowseError,
 * which the edge route maps to 400.
 */

import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expandTilde } from "./config";

/** One subdirectory row of a browse result. */
export interface BrowseDirEntry {
	name: string;
	/** Absolute path inside the canonicalized listing (NOT itself realpathed). */
	path: string;
	/** True when `<path>/.git` exists (directory OR file — linked worktree). */
	hasGit: boolean;
}

export interface BrowseResult {
	/** Realpath-canonicalized absolute path actually listed. */
	path: string;
	/** Parent of `path`; null at the filesystem root. */
	parent: string | null;
	/** Subdirectories only, name-sorted. */
	dirs: BrowseDirEntry[];
	/** True when the listing was capped (see BrowseOptions.cap). */
	truncated: boolean;
}

/** User-fixable browse failure (bad path); the edge route maps it to 400. */
export class BrowseError extends Error {}

export interface BrowseOptions {
	/** Max dirs returned before `truncated` flips (default 500). */
	cap?: number;
}

const DEFAULT_CAP = 500;

export async function browseDirectories(
	requestedPath?: string,
	options?: BrowseOptions,
): Promise<BrowseResult> {
	const cap = options?.cap ?? DEFAULT_CAP;
	const requested =
		requestedPath === undefined || requestedPath === "" ? homedir() : expandTilde(requestedPath);
	const canonical = await realpath(resolve(requested)).catch(() => null);
	if (canonical === null) throw new BrowseError(`no such directory: ${requested}`);
	const st = await stat(canonical).catch(() => null);
	if (st === null) throw new BrowseError(`unreadable: ${canonical}`);
	if (!st.isDirectory()) throw new BrowseError(`not a directory: ${canonical}`);
	const dirents = await readdir(canonical, { withFileTypes: true }).catch(() => null);
	if (dirents === null) throw new BrowseError(`unreadable: ${canonical}`);

	const dirs: BrowseDirEntry[] = [];
	let truncated = false;
	// Sort BEFORE capping so a truncated listing is the alphabetical prefix,
	// not an arbitrary readdir-order subset.
	const names = dirents
		.map((dirent) => dirent.name)
		.filter((name) => !name.startsWith("."))
		.sort();
	for (const name of names) {
		const path = join(canonical, name);
		// stat (not lstat) follows symlinks: a symlink to a directory lists.
		// Entries that error (dangling link, permissions) are skipped.
		const entry = await stat(path).catch(() => null);
		if (!entry?.isDirectory()) continue;
		if (dirs.length === cap) {
			truncated = true;
			break;
		}
		dirs.push({ name, path, hasGit: existsSync(join(path, ".git")) });
	}
	const parent = dirname(canonical);
	return { path: canonical, parent: parent === canonical ? null : parent, dirs, truncated };
}
