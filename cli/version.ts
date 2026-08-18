/**
 * omp-web version resolution, shared by the dispatcher (`--version`) and
 * `omp-web update`'s current-version comparison.
 *
 * Order: the build-time define stamp (scripts/build-omp-web.ts) wins, then
 * package.json one level up from this module (repo root in dev; the package
 * root next to dist-bundle/ in the installed layout), else "dev".
 */

/** Stamped by scripts/build-omp-web.ts via bun's `define`; undeclared at
 *  runtime in dev, where `typeof` on the missing identifier yields
 *  "undefined" without throwing. */
declare const __OMP_WEB_VERSION__: string | undefined;

export async function resolveVersion(): Promise<string> {
	if (typeof __OMP_WEB_VERSION__ === "string") return __OMP_WEB_VERSION__;
	try {
		const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string") return pkg.version;
	} catch {}
	return "dev";
}
