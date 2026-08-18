#!/usr/bin/env bun
/**
 * build (`bun run build`) — produce the installable omp-web bundle
 * (dist-bundle/cli.js).
 *
 * Mirrors scripts/build-omp-session.ts's UI-embed pipeline (vite build →
 * regenerate server/embedded-dist.ts → restore the stub in a finally), then
 * bundles the cli/omp-web.ts dispatcher with bun build (NOT --compile): all
 * @oh-my-pi/* packages stay external because `bun install -g` installs them
 * as real dependencies next to the bundle — hence no pi-natives embed and no
 * legacyPiModulesStub here (those exist only for the self-contained binary).
 * The package version is stamped in via define so `--version` works from an
 * arbitrary cwd without a path-based package.json lookup.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STUB = `export const EMBEDDED_DIST: Record<string, string> = {};\n`;
const ROOT = join(import.meta.dir, "..");
const EMBEDDED_DIST_FILE = join(ROOT, "server", "embedded-dist.ts");
const DIST_DIR = join(ROOT, "dist");
const OUTFILE = join(ROOT, "dist-bundle", "cli.js");

/** Recursively list file paths under `dir`, slash-normalized, relative to `base`. */
function listFiles(dir: string, base: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(abs, base));
		else if (entry.isFile())
			out.push(
				abs
					.slice(base.length + 1)
					.split("\\")
					.join("/"),
			);
	}
	return out;
}

/** Build the temporary embedded-dist.ts module for the current dist/ contents. */
function generateEmbeddedDist(): string {
	const files = listFiles(DIST_DIR, DIST_DIR)
		.filter((f) => !f.startsWith("."))
		.sort();
	const indexAt = files.indexOf("index.html");
	if (indexAt === -1) {
		throw new Error(`vite build produced no dist/index.html; got: ${files.join(", ")}`);
	}
	const imports = files.map(
		(f, i) => `import f${i} from ${JSON.stringify(`../dist/${f}`)} with { type: "file" };`,
	);
	// Unlike the compile build (whose file imports become absolute $bunfs
	// paths), a plain bundle emits outfile-RELATIVE strings that Bun.file would
	// resolve against the process cwd — broken for an installed bin run from
	// anywhere. Anchor them to this module's URL instead (in the bundle, that
	// is dist-bundle/cli.js, next to the copied asset files).
	const entries: string[] = [];
	for (const [i, f] of files.entries()) {
		if (f === "index.html") continue;
		entries.push(`\t${JSON.stringify(`/${f}`)}: new URL(f${i}, import.meta.url).pathname,`);
	}
	entries.push(`\t"/": new URL(f${indexAt}, import.meta.url).pathname,`);
	entries.push(`\t"/index.html": new URL(f${indexAt}, import.meta.url).pathname,`);
	return `${imports.join("\n")}\n\nexport const EMBEDDED_DIST: Record<string, string> = {\n${entries.join("\n")}\n};\n`;
}

const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version =
	pkg !== null && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string"
		? pkg.version
		: null;
if (version === null) {
	throw new Error("package.json has no string version to stamp into the bundle");
}

try {
	// 1. UI bundle (vite owns dist/ and wipes it).
	await Bun.$`bunx vite build`.cwd(ROOT);
	// 2. Regenerate the embedded-asset module for both edge.ts and server/index.ts.
	writeFileSync(EMBEDDED_DIST_FILE, generateEmbeddedDist());
	// 3. Bundle the dispatcher. Bun preserves the entrypoint shebang; verified
	//    below rather than assumed.
	const OUTDIR = join(ROOT, "dist-bundle");
	rmSync(OUTDIR, { recursive: true, force: true });
	mkdirSync(OUTDIR, { recursive: true });
	const build = await Bun.build({
		entrypoints: [join(ROOT, "cli", "omp-web.ts")],
		outdir: OUTDIR,
		minify: true,
		target: "bun",
		external: ["@oh-my-pi/*"],
		define: { __OMP_WEB_VERSION__: JSON.stringify(version) },
	});
	if (!build.success) {
		throw new Error(build.logs.map((log) => log.message).join("\n"));
	}
	// Bun names the output after the entrypoint (omp-web.js); normalize to cli.js.
	const produced = build.outputs.find((output) => output.path.endsWith(".js"))?.path;
	if (!produced) {
		throw new Error("bun build produced no js output file");
	}
	if (produced !== OUTFILE) {
		renameSync(produced, OUTFILE);
	}
	// 4. Shebang is a hard contract (bun install -g links this file as the bin).
	const head = readFileSync(OUTFILE, "utf8").slice(0, 18);
	if (head !== "#!/usr/bin/env bun") {
		throw new Error(`bundle lost its shebang (got ${JSON.stringify(head)}…)`);
	}
	console.log(`built ${OUTFILE}`);
} finally {
	// embedded-dist.ts stays a stub in the tree; it exists only for the build.
	writeFileSync(EMBEDDED_DIST_FILE, STUB);
}
