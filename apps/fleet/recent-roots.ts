/**
 * Recent Git roots for the Add-project path autocomplete (`GET /ctl/fs/recent-roots`).
 *
 * Candidates come from where the operator actually works: the `cwd` recorded in
 * the header of each omp session log under `<agent dir>/sessions/<project>/`,
 * newest activity first, resolved to the nearest enclosing Git root and kept only
 * while that directory still exists. Registered project roots are merged in after
 * the recent ones. Pure read-only filesystem work: no SDK, no subprocess.
 */

import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One autocomplete candidate. */
export interface RecentRoot {
	path: string;
	/** True when the path is already a registered fleet project. */
	registered: boolean;
}

export interface RecentRootsOptions {
	/** `<agent dir>/sessions`. */
	sessionsDir: string;
	/** Registered project roots, merged after the recent ones. */
	registered?: readonly string[];
	/** Max results (default 30). */
	limit?: number;
}

/** Session-log dirs inspected per call; bounds work on very large stores. */
const MAX_PROJECT_DIRS = 300;
/** A session header is the first or second line; never read more than this. */
const HEADER_BYTES = 8192;

/** Nearest ancestor-or-self of `dir` holding a `.git` entry (dir or linked-worktree file). */
export function findGitRoot(dir: string): string | null {
	let cur = dir;
	for (;;) {
		if (existsSync(join(cur, ".git"))) return cur;
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/** `cwd` from a session log's header line, or null when absent or unreadable. */
async function readSessionCwd(file: string): Promise<string | null> {
	const handle = await open(file, "r").catch(() => null);
	if (handle === null) return null;
	try {
		const buf = Buffer.alloc(HEADER_BYTES);
		const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
		for (const line of buf.toString("utf8", 0, bytesRead).split("\n")) {
			if (!line.includes('"type":"session"')) continue;
			try {
				const parsed = JSON.parse(line) as { type?: unknown; cwd?: unknown };
				if (parsed.type === "session" && typeof parsed.cwd === "string") return parsed.cwd;
			} catch {
				// A header cut mid-line by the read window: treat as unreadable.
			}
			return null;
		}
		return null;
	} finally {
		await handle.close();
	}
}

/** Newest session log of one project dir with its mtime, or null when it has none. */
async function newestSession(dir: string): Promise<{ file: string; mtimeMs: number } | null> {
	const names = await readdir(dir).catch(() => null);
	if (names === null) return null;
	// File names lead with an ISO timestamp, so lexical order is chronological.
	const newest = names
		.filter((n) => n.endsWith(".jsonl"))
		.sort()
		.at(-1);
	if (newest === undefined) return null;
	const file = join(dir, newest);
	const st = await stat(file).catch(() => null);
	return st === null ? null : { file, mtimeMs: st.mtimeMs };
}

/** Recent Git roots (most recently used first), then registered roots not already listed. */
export async function listRecentRoots(options: RecentRootsOptions): Promise<RecentRoot[]> {
	const limit = options.limit ?? 30;
	const registered = new Set(options.registered ?? []);
	const out: RecentRoot[] = [];
	const seen = new Set<string>();
	const push = (path: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		out.push({ path, registered: registered.has(path) });
	};

	const names = (await readdir(options.sessionsDir).catch(() => [])).slice(0, MAX_PROJECT_DIRS);
	const newest = (
		await Promise.all(names.map((name) => newestSession(join(options.sessionsDir, name))))
	)
		.filter((s): s is { file: string; mtimeMs: number } => s !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { file } of newest) {
		if (out.length >= limit) break;
		const cwd = await readSessionCwd(file);
		if (cwd === null || !existsSync(cwd)) continue;
		const root = findGitRoot(cwd);
		if (root !== null) push(root);
	}
	for (const path of registered) {
		if (out.length >= limit) break;
		push(path);
	}
	return out;
}
