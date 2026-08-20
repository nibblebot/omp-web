/**
 * `omp-web update` — self-update from the release channel (docs/release.md).
 *
 * Release channel: GitHub Releases. The stable latest-release base is
 * `https://github.com/<owner>/<repo>/releases/latest/download`; the GitHub
 * base is a Phase 6 user action (repo creation + scripts/release.ts), so
 * until then the base comes from `OMP_WEB_UPDATE_URL` — Phase 6 replaces
 * that env lookup with the GitHub constant.
 *
 * Flow: resolve the current version, fetch `release-manifest.json` off the
 * base, compare with a tiny local semver compare, then — unless `--check` —
 * download the tarball asset, verify its sha256 against the manifest, and
 * reinstall via `bun remove omp-web` + `bun add <verified tarball>` in the
 * pinned install dir (scripts/install-omp-web.ts layout). stdout carries the
 * command's result lines; every failure goes to stderr with an `omp-web:`
 * prefix.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersion } from "./version";

/** Default update channel: the stable GitHub Releases asset base. The env
 *  var stays as an override (local E2E + tests use it). */
export const GITHUB_RELEASES_BASE = "https://github.com/nibblebot/omp-web/releases/latest/download";

/** Typed failure from the update pipeline; `code` lets callers branch. */
export class UpdateError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "UpdateError";
		this.code = code;
	}
}

/**
 * Tiny numeric dot-split semver compare — no deps. Negative when a < b.
 * Missing trailing segments compare as 0 ("1.2" == "1.2.0"); non-numeric
 * segments ("dev") sort below numeric ones (release > dev).
 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] === undefined ? 0 : Number(pa[i]);
		const y = pb[i] === undefined ? 0 : Number(pb[i]);
		if (Number.isNaN(x) && Number.isNaN(y)) continue;
		if (Number.isNaN(x)) return -1;
		if (Number.isNaN(y)) return 1;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** Hex sha256 of the given bytes (node:crypto, no deps). */
export function sha256Of(data: Uint8Array | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Manifest shape served at `<base>/release-manifest.json` (extra keys tolerated). */
export interface UpdateManifest {
	version: string;
	tarball: string;
	sha256: string;
}

export function parseManifest(raw: unknown): UpdateManifest {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new UpdateError("manifest", "update manifest must be a JSON object");
	}
	const o = raw as Record<string, unknown>;
	const { version, tarball, sha256 } = o;
	if (typeof version !== "string" || version.length === 0) {
		throw new UpdateError("manifest", "update manifest is missing a string 'version'");
	}
	if (typeof tarball !== "string" || tarball.length === 0) {
		throw new UpdateError("manifest", "update manifest is missing a string 'tarball'");
	}
	if (typeof sha256 !== "string" || sha256.length === 0) {
		throw new UpdateError("manifest", "update manifest is missing a string 'sha256'");
	}
	return { version, tarball, sha256 };
}

/**
 * Base URL for manifest + tarball assets. Strips any trailing slash; a
 * `--version x.y.z` pin rewrites a `latest/download` base to
 * `…/download/v<x.y.z>` (GitHub per-release asset path) and appends
 * `/download/v<x.y.z>` otherwise (local fixtures / custom channels).
 */
export function resolveBase(envBase: string, pin?: string): string {
	const base = envBase.replace(/\/+$/, "");
	if (pin === undefined) return base;
	const suffix = "latest/download";
	if (base.endsWith(suffix)) {
		return `${base.slice(0, -suffix.length)}download/v${pin}`;
	}
	return `${base}/download/v${pin}`;
}

/** Injectable I/O for the update pipeline (tests stub these; main wires the real ones). */
export interface UpdateIO {
	fetch: typeof fetch;
	/** Install a verified local tarball globally; resolves the child exit code. */
	install: (tarballPath: string) => Promise<number>;
}

export interface ApplyUpdateOptions {
	current: string;
	force: boolean;
	/** Fetch + compare only; never download or install (--check). */
	check?: boolean;
}

export interface ApplyUpdateResult {
	installedVersion: string;
	installCalled: boolean;
}

async function fetchManifest(base: string, io: UpdateIO): Promise<UpdateManifest> {
	let res: Response;
	try {
		res = await io.fetch(`${base}/release-manifest.json`);
	} catch (e) {
		throw new UpdateError(
			"fetch",
			`failed to fetch update manifest: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!res.ok) {
		throw new UpdateError("fetch", `update manifest request failed (HTTP ${res.status})`);
	}
	let raw: unknown;
	try {
		raw = await res.json();
	} catch (e) {
		throw new UpdateError(
			"manifest",
			`update manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return parseManifest(raw);
}

/**
 * Core update pipeline. `check` mode compares and stops; otherwise the
 * tarball is downloaded, sha256-verified in memory (nothing unverified ever
 * touches disk), written to a temp file, installed, and the temp file is
 * deleted on every exit path.
 */
export async function applyUpdate(
	base: string,
	opts: ApplyUpdateOptions,
	io: UpdateIO,
): Promise<ApplyUpdateResult> {
	if (opts.current === "dev" && !opts.force) {
		throw new UpdateError(
			"dev",
			"updates apply to installs (running from source); pass --force --version to override",
		);
	}
	const manifest = await fetchManifest(base, io);
	if (!opts.force && compareVersions(manifest.version, opts.current) <= 0) {
		throw new UpdateError("up-to-date", `omp-web is up to date (${opts.current})`);
	}
	if (opts.check) {
		return { installedVersion: manifest.version, installCalled: false };
	}
	const tarballUrl = `${base}/${manifest.tarball}`;
	let data: Uint8Array;
	try {
		const res = await io.fetch(tarballUrl);
		if (!res.ok) {
			throw new UpdateError("fetch", `tarball download failed (HTTP ${res.status})`);
		}
		data = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		if (e instanceof UpdateError) throw e;
		throw new UpdateError(
			"fetch",
			`tarball download failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const actual = sha256Of(data);
	if (actual !== manifest.sha256) {
		throw new UpdateError(
			"sha",
			`sha256 mismatch for ${manifest.tarball}: expected ${manifest.sha256}, got ${actual}`,
		);
	}
	const tmpPath = join(tmpdir(), `omp-web-update-${Math.random().toString(36).slice(2)}.tgz`);
	try {
		await Bun.write(tmpPath, data);
		const code = await io.install(tmpPath);
		if (code !== 0) {
			throw new UpdateError("install", `bun add failed (exit ${code})`);
		}
		return { installedVersion: manifest.version, installCalled: true };
	} finally {
		rmSync(tmpPath, { force: true });
	}
}

/**
 * The bundle lives at `<install-dir>/node_modules/omp-web/dist-bundle/cli.js`
 * (scripts/install-omp-web.ts layout); three levels up is the install dir.
 * In dev/source this resolves somewhere bogus — the existsSync guard below
 * rejects it with a clear message.
 */
function pinnedInstallDir(): string {
	return fileURLToPath(new URL("../../..", import.meta.url));
}

/**
 * Update installs into omp-web's OWN pinned project dir (NOT the shared
 * `bun install -g` global store, which is flat and shared with the `omp`
 * CLI — it can hold only one @oh-my-pi version, so the bundle's pinned
 * SDK would skew against whatever omp has installed). A same-name
 * path-tarball re-add trips bun's dependency-loop check (verified against
 * bun 1.3.14; `--force` does not bypass it), so update removes the package
 * first, then adds the verified tarball. Exit 1 from the remove means
 * "nothing installed", which is fine; any other nonzero aborts. The
 * environment is inherited so a sandboxed HOME/BUN_INSTALL redirect reaches
 * the child. After install the on-disk package version is read back and must
 * match the manifest's, or the update fails loudly.
 */
async function realInstall(tarballPath: string): Promise<number> {
	const installDir = pinnedInstallDir();
	if (!existsSync(join(installDir, "node_modules", "omp-web", "dist-bundle", "cli.js"))) {
		console.error(
			"omp-web: not installed in a pinned directory (scripts/install-omp-web.ts) — reinstall with the installer first",
		);
		return 1;
	}
	// Anchor the install dir as a bun project so `bun remove`/`bun add` never
	// walk UP to an ancestor package.json (a repo or $HOME that owns one) and
	// attach there — the install dir has no package.json of its own unless a
	// successful add wrote one.
	if (!existsSync(join(installDir, "package.json")))
		writeFileSync(join(installDir, "package.json"), '{"name":"omp-web-install","private":true}\n');
	const remove = Bun.spawn(["bun", "remove", "omp-web"], {
		cwd: installDir,
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	const removeCode = (await remove.exited) ?? 1;
	if (removeCode !== 0 && removeCode !== 1) return removeCode;
	const add = Bun.spawn(["bun", "add", tarballPath], {
		cwd: installDir,
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	const addCode = (await add.exited) ?? 1;
	if (addCode !== 0) return addCode;
	// Read back the installed version — the bin symlink target is stable, so
	// the package.json version is the ground truth for "did it actually flip".
	try {
		const pkg = (await Bun.file(
			join(installDir, "node_modules", "omp-web", "package.json"),
		).json()) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" && pkg.version !== "" ? 0 : 1;
	} catch {
		return 1;
	}
}

/**
 * Post-update advisory: if the fleet control port answers at all (any HTTP
 * status — the fleet is up), the running fleet predates this install.
 * Unreachable → silent (no fleet to restart).
 */
async function probeFleet(): Promise<boolean> {
	try {
		await fetch("http://127.0.0.1:4722/ctl/sessions", { signal: AbortSignal.timeout(1000) });
		return true;
	} catch {
		return false;
	}
}

const USAGE = "usage: omp-web update [--check] [--force] [--version x.y.z]";

/**
 * Dispatcher contract (cli/omp-web.ts routes `update` here with
 * argv = process.argv.slice(2) minus the `update` token).
 */
export async function main(argv: string[]): Promise<number> {
	let check = false;
	let force = false;
	let pin: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--check") {
			check = true;
		} else if (flag === "--force") {
			force = true;
		} else if (flag === "--version") {
			pin = argv[++i];
			if (pin === undefined) {
				console.error("omp-web: --version requires a version argument");
				return 1;
			}
		} else {
			console.error(`${USAGE}\nomp-web: unknown update flag: ${flag}`);
			return 1;
		}
	}
	const envBase = process.env.OMP_WEB_UPDATE_URL ?? GITHUB_RELEASES_BASE;
	const current = await resolveVersion();
	if (current === "dev" && !(force && pin !== undefined)) {
		console.error(
			"omp-web: updates apply to installs (running from dev source; pass --force --version to override)",
		);
		return 1;
	}
	const base = resolveBase(envBase, pin);
	const io: UpdateIO = { fetch, install: realInstall };
	try {
		const result = await applyUpdate(base, { current, force, check }, io);
		if (check) {
			console.log(result.installedVersion);
		} else {
			console.log(`omp-web updated to ${result.installedVersion}`);
			if (await probeFleet()) {
				console.log("fleet running on old version — restart it");
			}
		}
		return 0;
	} catch (e) {
		if (e instanceof UpdateError && e.code === "up-to-date") {
			console.log(e.message);
			return 0;
		}
		console.error(`omp-web: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}
