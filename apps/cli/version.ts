/**
 * omp-web version resolution, shared by the dispatcher (`--version`) and
 * `omp-web update`'s current-version comparison.
 *
 * Order: the build-time define stamp (scripts/build-omp-web.ts) wins, then
 * package.json above this module (repo root in dev; the package root next
 * to dist-bundle/ in the installed bundle layout), else "dev".
 */

/** Stamped by scripts/build-omp-web.ts via bun's `define`; undeclared at
 *  runtime in dev, where `typeof` on the missing identifier yields
 *  "undefined" without throwing. */
declare const __OMP_WEB_VERSION__: string | undefined;

export async function resolveVersion(): Promise<string> {
	if (typeof __OMP_WEB_VERSION__ === "string") return __OMP_WEB_VERSION__;
	// Two depths, one fallback chain: the installed bundle (dist-bundle/cli.js)
	// reads dist-bundle/../package.json (the package root next to
	// dist-bundle/), while dev source reads apps/cli/../../package.json (the
	// repo root). Bundling keeps this source's relative strings but re-bases
	// them at dist-bundle/, so both candidates are probed in order with the
	// nearer layout first; misses fall through to "dev".
	for (const url of [
		new URL("../package.json", import.meta.url),
		new URL("../../package.json", import.meta.url),
	]) {
		try {
			const pkg = (await Bun.file(url).json()) as { version?: unknown };
			if (typeof pkg.version === "string") return pkg.version;
		} catch {}
	}
	return "dev";
}
