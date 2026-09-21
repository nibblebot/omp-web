#!/usr/bin/env bun
/**
 * mirror-patches re-hosts the installed omp-web package's `patchedDependencies`
 * map into the ROOT project that owns its node_modules.
 *
 * Why this exists: bun applies `patchedDependencies` only from the root
 * project's package.json. A dependency that declares its own map (the omp-web
 * tarball does, for the pi-agent-core tokenizer fix) is ignored, the pinned
 * `@oh-my-pi/*` packages would install unpatched, and the bundle would run the
 * slow path the patch removes. Verified against bun 1.4.2: a tarball-installed
 * package's `patchedDependencies` is not applied, and a `file:` dependency
 * pointing inside that package fails to resolve, so the map has to be mirrored
 * into the project root by the installer.
 *
 * The patch files themselves are copied out of the package into the project
 * root at the same relative path. They MUST live outside
 * `node_modules/omp-web`: the update path removes the package before re-adding
 * it, and bun resolves declared patch files during that add, so a patch
 * shipped only inside the package (the previous install's own copy) would be
 * missing and the add would fail with "Couldn't find patch file". Version-keyed
 * patch filenames keep a previous release's entries inert (bun ignores a spec
 * that matches no installed package) until this script replaces the map.
 *
 * Usage: bun mirror-patches.ts [project-dir]   (default: cwd)
 * The project dir must contain `node_modules/omp-web`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "omp-web";

function fail(message: string): never {
	console.error(`mirror-patches: ${message}`);
	process.exit(1);
}

const projectDir = resolve(process.argv[2] ?? process.cwd());
const packageDir = join(projectDir, "node_modules", PACKAGE);
const packageJsonPath = join(packageDir, "package.json");
if (!existsSync(packageJsonPath)) fail(`no ${packageJsonPath}; install ${PACKAGE} first`);

function readJson(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			fail(`${path} is not a JSON object`);
		return parsed as Record<string, unknown>;
	} catch (err) {
		fail(`${path} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const declared = readJson(packageJsonPath).patchedDependencies;
const mirrored: Record<string, string> = {};
if (declared !== undefined) {
	if (declared === null || typeof declared !== "object" || Array.isArray(declared))
		fail(`${PACKAGE} patchedDependencies is not an object`);
	for (const [spec, patchPath] of Object.entries(declared as Record<string, unknown>)) {
		if (typeof patchPath !== "string" || patchPath === "")
			fail(`${PACKAGE} patchedDependencies[${spec}] is not a path string`);
		const source = join(packageDir, patchPath);
		if (!existsSync(source)) fail(`${PACKAGE} declares ${patchPath} but ${source} does not exist`);
		// Rebase to the project root: same relative path, one level up out of
		// node_modules/omp-web, so it survives the package being replaced.
		const destination = join(projectDir, patchPath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(source, destination);
		mirrored[spec] = patchPath;
	}
}

const rootJsonPath = join(projectDir, "package.json");
if (!existsSync(rootJsonPath)) fail(`no ${rootJsonPath}; the project dir must be a bun project`);
const root = readJson(rootJsonPath);
if (Object.keys(mirrored).length > 0) root.patchedDependencies = mirrored;
else delete root.patchedDependencies;
writeFileSync(rootJsonPath, `${JSON.stringify(root, null, 2)}\n`);

const specs = Object.keys(mirrored);
console.log(
	specs.length === 0
		? `mirror-patches: ${PACKAGE} declares no patches; cleared the project map`
		: `mirror-patches: mirroring ${specs.join(", ")} into ${projectDir}`,
);

// Re-resolve so bun applies the (re)copied patches to the hoisted packages.
// Always run: a patch whose FILE content changed between two releases that pin
// the same dependency version must be re-applied, not just re-declared.
const install = Bun.spawn([process.execPath, "install"], {
	cwd: projectDir,
	stdout: "inherit",
	stderr: "inherit",
});
const code = (await install.exited) ?? 1;
if (code !== 0) fail(`bun install failed (exit ${code})`);
