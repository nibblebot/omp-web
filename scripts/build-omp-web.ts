#!/usr/bin/env bun
/**
 * build (`bun run build`) — produce the installable omp-web bundle
 * (dist-bundle/cli.js + dist-bundle/providers/* + dist-bundle/image/*).
 *
 * UI-embed pipeline: vite build → regenerate server/embedded-dist.ts →
 * restore the stub in a finally. Then the cli/omp-web.ts dispatcher is
 * bundled with bun build (NOT --compile): all @oh-my-pi/* packages stay
 * external because `bun install -g` installs them as real dependencies
 * next to the bundle — hence no pi-natives embed. The provider executables
 * (runtime/providers/*.ts) get the same single-file treatment into
 * dist-bundle/providers/ with shebang + exec bit preserved — the installed
 * fleet spawns them directly. The reproducible session-runtime image
 * definition (runtime/image/) is copied verbatim into dist-bundle/image/.
 * The package version is stamped in via define so `--version` works from an
 * arbitrary cwd without a path-based package.json lookup.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STUB = `export const EMBEDDED_DIST: Record<string, string> = {};\n`;
const ROOT = join(import.meta.dir, "..");
const EMBEDDED_DIST_FILE = join(ROOT, "server", "embedded-dist.ts");
const DIST_DIR = join(ROOT, "dist");
const OUTFILE = join(ROOT, "dist-bundle", "cli.js");
const PROVIDERS_DIR = join(ROOT, "dist-bundle", "providers");
/** Provider executables (P9.1): key = shipped filename, value = source entry. */
const PROVIDER_SOURCES: Record<string, string> = {
	"bwrap-provider.js": join(ROOT, "runtime", "providers", "bwrap-provider.ts"),
	"kubernetes-provider.js": join(ROOT, "runtime", "providers", "kubernetes-provider.ts"),
};
/** Reproducible session-runtime image definition, shipped verbatim. */
const IMAGE_SRC = join(ROOT, "runtime", "image");
const IMAGE_DST = join(ROOT, "dist-bundle", "image");

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

/** Copy every file under `src` into `dst`, preserving the relative layout. */
function copyDir(src: string, dst: string): void {
	for (const rel of listFiles(src, src)) {
		const to = join(dst, rel);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(src, rel), to);
	}
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
	// 5. Provider executables (P9.1): one single-file bundle per provider,
	//    shipped next to cli.js. The installed fleet runs these files
	//    directly (`<executable> <op>` with one JSON request on stdin), so
	//    both the shebang AND the exec bit are hard contracts. Missing
	//    sources fail the build loudly — a package silently missing a
	//    provider is not an installable product.
	mkdirSync(PROVIDERS_DIR, { recursive: true });
	for (const source of Object.values(PROVIDER_SOURCES)) {
		if (!existsSync(source)) {
			throw new Error(
				`provider entrypoint missing: ${source} — the provider lane must land it before the build gate`,
			);
		}
	}
	const providerBuild = await Bun.build({
		entrypoints: Object.values(PROVIDER_SOURCES),
		outdir: PROVIDERS_DIR,
		minify: true,
		target: "bun",
		external: ["@oh-my-pi/*"],
	});
	if (!providerBuild.success) {
		throw new Error(providerBuild.logs.map((log) => log.message).join("\n"));
	}
	for (const output of providerBuild.outputs) {
		chmodSync(output.path, 0o755);
		const providerHead = readFileSync(output.path, "utf8").slice(0, 18);
		if (providerHead !== "#!/usr/bin/env bun") {
			throw new Error(`provider bundle lost its shebang (got ${JSON.stringify(providerHead)}…)`);
		}
	}
	// 6. Reproducible session-runtime image definition (P9.1): ship the
	//    Containerfile + entrypoint verbatim under dist-bundle/image/. The
	//    image build consumes the repo root as its context, so the shipped
	//    copy stays byte-identical to runtime/image/.
	if (!existsSync(join(IMAGE_SRC, "Containerfile"))) {
		throw new Error(
			`runtime image definition missing under ${IMAGE_SRC} — the Kubernetes lane must land it before the build gate`,
		);
	}
	copyDir(IMAGE_SRC, IMAGE_DST);
	console.log(`built ${OUTFILE}`);
	console.log(
		`shipped providers + image: ${Object.keys(PROVIDER_SOURCES)
			.map((name) => join("dist-bundle", "providers", name))
			.join(", ")}; dist-bundle/image/`,
	);
} finally {
	// embedded-dist.ts stays a stub in the tree; it exists only for the build.
	writeFileSync(EMBEDDED_DIST_FILE, STUB);
}
