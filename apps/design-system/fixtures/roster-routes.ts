import type { FsBrowseDir, FsBrowseResult, RecentRootsResult } from "../../web/store/projects";

/**
 * Route answers for the roster stories. Kept apart from roster.ts because
 * routes.ts runs on the design server, which must not load the web store.
 */

const HOME = "/home/joshua";
const OMP_WEB = "/home/joshua/Repos/omp-web";
const WORKTREES = "/home/joshua/Repos/omp-web-worktrees";

/** Directory tree served by GET /ctl/fs/browse, keyed by canonical path. */
const fsTree: Record<string, FsBrowseDir[]> = {
	"/home": [{ name: "joshua", path: HOME, hasGit: false }],
	[HOME]: [
		{ name: "Repos", path: `${HOME}/Repos`, hasGit: false },
		{ name: "Documents", path: `${HOME}/Documents`, hasGit: false },
	],
	[`${HOME}/Repos`]: [
		{ name: "omp-web", path: OMP_WEB, hasGit: true },
		{ name: "omp-web-worktrees", path: `${HOME}/Repos/omp-web-worktrees`, hasGit: false },
		{ name: "localaction", path: `${HOME}/Repos/localaction`, hasGit: true },
		{ name: "nixos-config", path: `${HOME}/Repos/nixos-config`, hasGit: true },
		{ name: "scratch", path: `${HOME}/Repos/scratch`, hasGit: true },
		{ name: "empty", path: `${HOME}/Repos/empty`, hasGit: false },
	],
	[OMP_WEB]: [
		{ name: "apps", path: `${OMP_WEB}/apps`, hasGit: false },
		{ name: "lib", path: `${OMP_WEB}/lib`, hasGit: false },
		{ name: "docs", path: `${OMP_WEB}/docs`, hasGit: false },
	],
	[WORKTREES]: [
		{ name: "design-fixtures", path: `${WORKTREES}/design-fixtures`, hasGit: true },
		{ name: "review-anchors", path: `${WORKTREES}/review-anchors`, hasGit: true },
		{ name: "tx-pagination", path: `${WORKTREES}/tx-pagination`, hasGit: true },
	],
	[`${HOME}/Repos/scratch`]: [
		{ name: "src", path: `${HOME}/Repos/scratch/src`, hasGit: false },
		{ name: "test", path: `${HOME}/Repos/scratch/test`, hasGit: false },
	],
	[`${HOME}/Repos/empty`]: [],
	[`${HOME}/Documents`]: [
		{ name: "notes", path: `${HOME}/Documents/notes`, hasGit: false },
		{ name: "journal", path: `${HOME}/Documents/journal`, hasGit: false },
		{ name: "recipes", path: `${HOME}/Documents/recipes`, hasGit: false },
	],
	[`${HOME}/Documents/notes`]: [],
	[`${HOME}/Documents/journal`]: [],
	[`${HOME}/Documents/recipes`]: [],
};

/** Every folder some listing shows; the ones without a listing of their own above are empty. */
const listedDirs = new Set(Object.values(fsTree).flatMap((dirs) => dirs.map((dir) => dir.path)));

/** Answer for GET /ctl/fs/browse: a canned listing, or the edge's 400 reason for a path no listing shows. */
export function rosterFsBrowse(path: string | null): FsBrowseResult | Response {
	const canonical = path ?? HOME;
	const dirs = fsTree[canonical] ?? (listedDirs.has(canonical) ? [] : undefined);
	if (dirs === undefined) {
		return Response.json({ error: `not a directory: ${canonical}` }, { status: 400 });
	}
	return {
		path: canonical,
		parent: canonical === HOME ? "/home" : canonical.slice(0, canonical.lastIndexOf("/")),
		dirs,
		truncated: false,
	};
}

/** Answer for GET /ctl/fs/recent-roots: canned recent Git roots; the registered one is flagged. */
export const rosterRecentRoots: RecentRootsResult = {
	roots: [
		{ path: OMP_WEB, registered: true },
		{ path: `${HOME}/Repos/scratch`, registered: false },
	],
};
