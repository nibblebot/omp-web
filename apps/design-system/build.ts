import { copyFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { bundleConfig, root } from "./bundle";

/**
 * Static build of the demo page (`bun run build:demo`): the same bundle the dev
 * server serves (`bundle.ts`), minified, written with `index.html` to one
 * self-contained directory. Fixture routes and the fake session run in the page
 * (session.ts), and every page URL is relative, so the directory can be served
 * from any path; the Pages workflow publishes it at /omp-web/demo/.
 *
 * Usage: bun apps/design-system/build.ts [outDir]   (default apps/design-system/dist)
 *
 * The output directory is replaced, so it must be new, empty, or a previous
 * demo build (only the entries a build writes). Anything else, such as `.`, the
 * repository root or `/`, is refused before anything is deleted.
 */
const outDir = resolve(process.argv[2] ?? join(root, "dist"));
const BUILD_ENTRIES: Record<string, true> = {
	"index.html": true,
	"main.js": true,
	"main.css": true,
	assets: true,
};

const existing = await readdir(outDir).catch((err: NodeJS.ErrnoException) => {
	if (err.code === "ENOENT") return [];
	throw err;
});
const foreign = existing.filter((name) => !Object.hasOwn(BUILD_ENTRIES, name));
if (foreign.length > 0) {
	console.error(
		`build:demo: refusing to replace ${outDir}: it is not a demo build output (found ${foreign.slice(0, 5).join(", ")}). Pass a new or empty directory.`,
	);
	process.exit(2);
}
await rm(outDir, { recursive: true, force: true });
const result = await Bun.build({ ...bundleConfig("demo", "static"), outdir: outDir });
if (!result.success) {
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}
await copyFile(join(root, "index.html"), join(outDir, "index.html"));

const files = ["index.html", ...result.outputs.map((o) => relative(outDir, o.path))];
console.log(`demo: ${relative(process.cwd(), outDir) || "."}/ (${files.join(", ")})`);
