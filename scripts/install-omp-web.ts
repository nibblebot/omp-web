#!/usr/bin/env bun
/**
 * install:omp-web — install the omp-web tarball into its OWN pinned directory.
 *
 * Why not `bun install -g <tarball>`: the global store is a FLAT node_modules
 * shared with the `omp` CLI, so it can hold only ONE version of each
 * `@oh-my-pi/*` package. bun keeps whatever omp already installed (e.g.
 * 17.3.5) instead of the tarball's pin (17.1.8), and the version-skewed
 * bundle crashes at runtime (missing exports). Installing into a dedicated
 * project dir (`bun add <tarball>`) gives omp-web its OWN node_modules with
 * the exact pinned `@oh-my-pi/*` versions — the omp CLI is untouched and the
 * bundle's runtime resolution never reaches the shared store.
 *
 * Layout:
 *   <prefix>/install/                        (a bun project: package.json + node_modules)
 *   <prefix>/install/node_modules/omp-web/dist-bundle/cli.js   (the bundle)
 *   <bin-dir>/omp-web → …/dist-bundle/cli.js   (symlink; default ~/.bun/bin)
 *
 * The prefix is where the CLI CODE lives — the DATA home (config, state,
 * workspaces) is chosen independently at first run (`Data home directory
 * [~/.omp-web]: `, any path with `~/` expansion).
 *
 * A stale `bun install -g` copy of omp-web in the global store is removed
 * (only omp-web itself — the @oh-my-pi packages there belong to omp).
 *
 * Usage: bun run install:omp-web [./omp-web-<version>.tgz] [--prefix <dir>] [--bin-dir <dir>]
 * With no tarball argument it builds + packs first (bun run build && bun pm pack)
 * and installs the freshly produced omp-web-<version>.tgz.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const USAGE =
	"usage: bun run install:omp-web [./omp-web-<version>.tgz] [--prefix <dir>] [--bin-dir <dir>]";

function fail(message: string): never {
	console.error(`install:omp-web: ${message}`);
	console.error(USAGE);
	process.exit(1);
}

function parseArgs(argv: string[]): { tarball: string; prefix: string; binDir: string } {
	let tarball = "";
	let prefix = join(homedir(), ".omp-web");
	let binDir = join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--prefix") prefix = resolve(argv[++i] ?? "");
		else if (arg === "--bin-dir") binDir = resolve(argv[++i] ?? "");
		else if (arg.startsWith("--")) fail(`unknown option: ${arg}`);
		else if (tarball === "") tarball = resolve(arg);
		else fail(`unexpected argument: ${arg}`);
	}
	if (prefix === "" || binDir === "") fail("empty --prefix/--bin-dir");
	return { tarball, prefix, binDir };
}

/** With no tarball argument: build + pack, then use the fresh artifact. */
async function resolveTarball(tarball: string): Promise<string> {
	if (tarball !== "") {
		if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`);
		return tarball;
	}
	console.log("install:omp-web: no tarball given — running bun run build + bun pm pack");
	const build = Bun.spawn(["bun", "run", "build"], { cwd: ROOT });
	if (((await build.exited) ?? 1) !== 0) fail("bun run build failed");
	const pack = Bun.spawn(["bun", "pm", "pack"], { cwd: ROOT });
	if (((await pack.exited) ?? 1) !== 0) fail("bun pm pack failed");
	const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version?: unknown };
	if (typeof pkg.version !== "string" || pkg.version === "") fail("package.json has no version");
	const fresh = join(ROOT, `omp-web-${pkg.version}.tgz`);
	if (!existsSync(fresh)) fail(`pack produced no tarball at ${fresh}`);
	return fresh;
}

const { tarball, prefix, binDir } = parseArgs(process.argv.slice(2));
const resolvedTarball = await resolveTarball(tarball);
const installDir = join(prefix, "install");
const bundlePath = join(installDir, "node_modules", "omp-web", "dist-bundle", "cli.js");
const binPath = join(binDir, "omp-web");

// 1. Install (or upgrade) the tarball into the dedicated project dir. A
//    same-name path-tarball re-add trips bun's dependency-loop check, so
//    upgrades remove first (tolerating "nothing installed").
//
//    The install dir must be a bun project of its own: `bun add` with no
//    local package.json walks UP to the nearest project root, so without
//    this the first install would attach to the nearest ancestor of the
//    install dir (a repo under ~, $HOME, or a --prefix nested in a project)
//    and drop node_modules there.
mkdirSync(installDir, { recursive: true });
if (!existsSync(join(installDir, "package.json")))
	writeFileSync(join(installDir, "package.json"), '{"name":"omp-web-install","private":true}\n');
const remove = Bun.spawn(["bun", "remove", "omp-web"], { cwd: installDir });
const removeCode = (await remove.exited) ?? 1;
if (removeCode !== 0 && removeCode !== 1) fail(`bun remove failed (exit ${removeCode})`);
const add = Bun.spawn(["bun", "add", resolvedTarball], { cwd: installDir });
const addCode = (await add.exited) ?? 1;
if (addCode !== 0) fail(`bun add failed (exit ${addCode})`);
if (!existsSync(bundlePath)) fail(`bundle missing after install: ${bundlePath}`);

// 2. Link the bin.
mkdirSync(binDir, { recursive: true });
rmSync(binPath, { force: true });
symlinkSync(bundlePath, binPath);

// 3. Drop any stale `bun install -g` copy (the @oh-my-pi globals stay — omp's).
const stale = Bun.spawn(["bun", "remove", "-g", "omp-web"]);
const staleCode = (await stale.exited) ?? 1;
if (staleCode !== 0 && staleCode !== 1)
	console.error(`install:omp-web: warning: bun remove -g omp-web failed (exit ${staleCode})`);

console.log(`install:omp-web: installed ${resolvedTarball}`);
console.log(`install:omp-web: bundle at ${bundlePath}`);
console.log(`install:omp-web: linked ${binPath} → ${bundlePath}`);
console.log("\u001b[1mrun `omp-web --version` to verify installation\u001b[0m");
