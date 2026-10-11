import type { FsBrowseDir, FsBrowseResult } from "../../web/store/projects";

/**
 * Route answers for the roster stories. Kept apart from roster.ts because
 * routes.ts runs on the design server, which must not load the web store.
 */

const HOME = "/home/joshua";
const OMP_WEB = "/home/joshua/Repos/omp-web";

/** Directory tree served by GET /ctl/fs/browse, keyed by canonical path. */
const fsTree: Record<string, FsBrowseDir[]> = {
	[HOME]: [
		{ name: "Repos", path: `${HOME}/Repos`, hasGit: false },
		{ name: "Documents", path: `${HOME}/Documents`, hasGit: false },
	],
	[`${HOME}/Repos`]: [
		{ name: "omp-web", path: OMP_WEB, hasGit: true },
		{ name: "omp-web-worktrees", path: `${HOME}/Repos/omp-web-worktrees`, hasGit: false },
		{ name: "localaction", path: `${HOME}/Repos/localaction`, hasGit: true },
		{ name: "nixos-config", path: `${HOME}/Repos/nixos-config`, hasGit: true },
	],
	[OMP_WEB]: [
		{ name: "apps", path: `${OMP_WEB}/apps`, hasGit: false },
		{ name: "lib", path: `${OMP_WEB}/lib`, hasGit: false },
		{ name: "docs", path: `${OMP_WEB}/docs`, hasGit: false },
	],
};

/** Answer for GET /ctl/fs/browse: a canned listing, or the edge's 400 reason for an unknown path. */
export function rosterFsBrowse(path: string | null): FsBrowseResult | Response {
	const canonical = path ?? HOME;
	const dirs = fsTree[canonical];
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
