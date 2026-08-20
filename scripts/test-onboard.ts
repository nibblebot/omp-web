#!/usr/bin/env bun
/**
 * test-onboard — OFFLINE end-to-end walk of the omp-web distribution + onboarding path.
 *
 * Phase 5 gate (docs/release.md "Remaining actions"): everything proven
 * locally before anything is published. Runs in a sandboxed HOME +
 * BUN_INSTALL with a local `bun pm pack` tarball and a local manifest
 * fixture — no network beyond the dependency registry for `bun add` / the
 * poison install, no GitHub, no npm publish.
 *
 * Walk:
 *   1. bun run build → bun pm pack → omp-web-<version>.tgz
 *   2. POISON the sandbox global store with @oh-my-pi/pi-ai 17.3.5 (the omp
 *      CLI's version — the skew that broke `bun install -g`-based installs),
 *      then install the tarball into a dedicated pinned dir
 *      (scripts/install-omp-web.ts); assert the symlink points there, the
 *      pinned pi-ai is 17.1.8, and `omp-web --version` prints the version
 *      despite the poisoned store
 *   3. fixture repo (git init + commit) with one linked worktree
 *   4. first-run config written to ~/.omp-web/config.json (the serve offer's
 *      TTY-gated write, done directly here — workspaceDir only)
 *   5. BARE `omp-web` from an arbitrary cwd (= fleet serve): banner line 1
 *      intact + real embedded UI, then the repo registered + linked worktree
 *      adopted over the loopback /ctl API (the UI picker's path)
 *   6. spawn a session on the registered project (fleet local template now spawns
 *      `omp-web session` — PATH must include $BUN_INSTALL/bin); assert it reaches
 *      ready and its cwd matches the project
 *   7. update round-trip: version bumped to 0.2.0, rebuilt bundle, fixture
 *      Bun.serve hosts release-manifest.json + the 0.2.0 tarball;
 *      OMP_WEB_UPDATE_URL → omp-web update (bun remove + bun add in the pinned
 *      dir); assert the symlink still resolves and `omp-web --version` prints 0.2.0
 *
 * Usage: bun scripts/test-onboard.ts [--keep]   (--keep leaves the sandbox dir)
 * Exit 0 when every assertion passes, 1 otherwise.
 *
 * NOTE: any crash or failure still runs cleanup (kills spawned processes,
 * restores package.json, removes sandbox + tarballs) via the outer try/finally.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = join(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const pkgPath = join(ROOT, "package.json");
const originalPkg = readFileSync(pkgPath, "utf8");

const sandbox = mkdtempSync(join(tmpdir(), "omp-web-onboard-"));
const home = join(sandbox, "home");
const bunInstall = join(sandbox, "bun");
const binDir = join(bunInstall, "bin");
const bin = join(binDir, "omp-web");
const dataHome = join(home, ".omp-web");
// Fresh HOME + BUN_INSTALL for the install.sh step: the curl-pipe installer
// must work standalone (its own data home + its own bun bin link), not
// piggyback the pinned-install sandbox above.
const instHome = join(sandbox, "home-installer");
const instDataHome = join(instHome, ".omp-web");
const instBunInstall = join(sandbox, "bun-installer");
const instBin = join(instBunInstall, "bin", "omp-web");
const fixture = join(sandbox, "fixture");
const repoDir = join(sandbox, "repo");
const wtDir = join(sandbox, "wt");
const serveCwd = join(sandbox, "serve-cwd");
const OMP_PORT = 48271; // fixed test port; the state lock is per-sandbox
const UPDATE_PORT = 48272;
const INSTALLER_PORT = 48273;

let failures = 0;
let fatal: string | null = null;
let v1 = "";
let v2 = "0.2.0";
let tgz = "";
let tgz2 = "";
let fixtureServer: { stop(): void } | null = null;
const started: { proc: Subprocess; name: string }[] = [];

function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail !== "" ? ` — ${detail}` : ""}`);
	}
}

function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
	// Strip the product's own env knobs from the inherited shell: a dev
	// shell's OMP_FLEET_STATE points the sandboxed fleet at the developer's
	// real (locked) state file, and OMP_FLEET_LOCAL_TEMPLATE would replace the
	// installed bundle's spawn template with the source entry — defeating the
	// installed-mode assertions. Script-provided knobs ride `extra` (applied
	// after the scrub, so they survive).
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" &&
				!entry[0].startsWith("OMP_FLEET_") &&
				!entry[0].startsWith("OMP_SESSION_") &&
				!entry[0].startsWith("OMP_WEB_"),
		),
	);
	return {
		...inherited,
		HOME: home,
		BUN_INSTALL: bunInstall,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		...extra,
	};
}

async function run(
	name: string,
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd ?? ROOT,
		env: opts.env ?? sandboxEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = opts.timeoutMs ?? 60_000;
	const timer = setTimeout(() => {
		proc.kill();
		console.error(`FAIL ${name} — timed out after ${timeout}ms`);
	}, timeout);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	const code = (await proc.exited) as number;
	return { code, stdout, stderr };
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url, init);
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {}
	return { status: res.status, body };
}

/** Start a long-running omp-web process; killed on exit. Lines land in
 *  stdout/stderr as they arrive (a whole-stream read only flushes at exit,
 *  which never comes for serve/setup). */
function startDetached(
	name: string,
	args: string[],
	env: Record<string, string>,
	cwd: string,
): { proc: Subprocess; stdout: string[]; stderr: string[] } {
	const proc = Bun.spawn([bin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const out: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
	const pump = (stream: ReadableStream<Uint8Array>, target: string[]) => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					if (buf !== "") target.push(buf);
					break;
				}
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) !== -1) {
					target.push(buf.slice(0, nl));
					buf = buf.slice(nl + 1);
				}
			}
		})();
	};
	pump(proc.stdout, out.stdout);
	pump(proc.stderr, out.stderr);
	started.push({ proc, name });
	return { proc, ...out };
}

async function killAll(): Promise<void> {
	for (const s of [...started].reverse()) {
		try {
			s.proc.kill("SIGTERM");
		} catch {}
	}
	await sleep(1500);
}

function mkdirp(p: string): void {
	rmSync(p, { recursive: true, force: true });
	mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------------------
try {
	// 1. Build + pack
	// ---------------------------------------------------------------------------
	console.log("== 1. build + pack ==");
	const pkg = JSON.parse(originalPkg) as { version: string };
	v1 = pkg.version;
	let r = await run("bun run build", ["bun", "run", "build"]);
	check("bun run build succeeds", r.code === 0, r.stderr.slice(-300));
	check(
		"bundle has shebang",
		r.code === 0 &&
			readFileSync(join(ROOT, "dist-bundle", "cli.js"), "utf8").startsWith("#!/usr/bin/env bun"),
	);
	check(
		"embedded-dist restored to stub",
		r.code === 0 &&
			readFileSync(join(ROOT, "server", "embedded-dist.ts"), "utf8").includes(
				"EMBEDDED_DIST: Record<string, string> = {}",
			),
	);

	const pack = await run("bun pm pack", ["bun", "pm", "pack"]);
	tgz = join(ROOT, `omp-web-${v1}.tgz`);
	check(
		"pack produces omp-web-<v>.tgz",
		pack.code === 0 && existsSync(tgz),
		pack.stderr.slice(-200),
	);

	// 2. Pinned install (dedicated dir) + symlink + version. First POISON the
	// shared global store with a NEWER @oh-my-pi (17.3.5 — what the omp CLI
	// installs): a `bun install -g`-based omp-web would inherit it and crash
	// (missing exports, e.g. zodToWireSchema). The dedicated-dir install must
	// be immune — its own node_modules pins the tarball's versions.
	// ---------------------------------------------------------------------------
	console.log("== 2. pinned install ==");
	r = await run(
		"poison global store with pi-ai 17.3.5",
		["bun", "install", "-g", "@oh-my-pi/pi-ai@17.3.5"],
		{
			timeoutMs: 180_000,
		},
	);
	check("store poisoned with pi-ai 17.3.5", r.code === 0, r.stderr.slice(-300));
	r = await run(
		"install:omp-web",
		["bun", "scripts/install-omp-web.ts", tgz, "--prefix", dataHome],
		{
			timeoutMs: 180_000,
		},
	);
	check("install:omp-web succeeds", r.code === 0, r.stderr.slice(-300));
	check("$BUN_INSTALL/bin/omp-web exists", existsSync(bin));
	const linkTarget = existsSync(bin) ? realpathSync(bin) : "";
	check(
		"bin symlinks into the pinned install dir",
		linkTarget === join(dataHome, "install", "node_modules", "omp-web", "dist-bundle", "cli.js"),
		linkTarget,
	);
	check(
		"pinned pi-ai is 17.1.8 (not the store's 17.3.5)",
		JSON.parse(
			readFileSync(
				join(dataHome, "install", "node_modules", "@oh-my-pi", "pi-ai", "package.json"),
				"utf8",
			),
		).version === "17.1.8",
	);
	r = await run("--version", [bin, "--version"]);
	check(
		`--version prints ${v1} despite the poisoned store`,
		r.code === 0 && r.stdout.trim() === v1,
		r.stdout.trim(),
	);

	// Anchor a poisoned ANCESTOR project: with no package.json of its own,
	// `bun add` walks UP from the install dir and attaches to the nearest
	// project root, silently installing node_modules into it.
	// The install dir's own anchor must prevent that.
	const ancestorPkg = join(sandbox, "package.json");
	const ancestorMarker = JSON.stringify({ name: "onboard-ancestor", private: true });
	writeFileSync(ancestorPkg, ancestorMarker);
	r = await run(
		"install:omp-web (poisoned ancestor project)",
		["bun", "scripts/install-omp-web.ts", tgz, "--prefix", dataHome],
		{ timeoutMs: 180_000 },
	);
	check("reinstall succeeds with poisoned ancestor", r.code === 0, r.stderr.slice(-300));
	check(
		"ancestor package.json untouched (no walk-up attach)",
		readFileSync(ancestorPkg, "utf8") === ancestorMarker,
		readFileSync(ancestorPkg, "utf8"),
	);
	check(
		"no node_modules in the ancestor project",
		!existsSync(join(sandbox, "node_modules")),
		"found ancestor node_modules",
	);
	check(
		"install dir package.json exists after install",
		existsSync(join(dataHome, "install", "package.json")),
		"",
	);
	// Keep the poisoned ancestor around: the update round-trip (step 7) runs
	// `bun remove`/`bun add` in the same pinned dir, and must also stay
	// anchored instead of attaching to it.

	// 2b. install.sh (bun-only, curl-pipe style): a FRESH HOME + BUN_INSTALL
	// + data home. The fixture server hosts the release assets at the
	// download-URL shape install.sh hits; the script must resolve "latest"
	// from the GitHub API (real network is off-limits here — the sandboxed
	// OMP_WEB_INSTALL_DIR / OMP_WEB_INSTALLER_API / OMP_WEB_DOWNLOAD_BASE
	// fixtures cover it), verify the sha256 from the release manifest,
	// bun-add into its own pinned dir, and symlink the bin. No tarball or
	// downloads beyond the fixture. This is exactly what a user running the
	// one-liner gets.
	// ---------------------------------------------------------------------------
	console.log("== 2b. install.sh ==");
	mkdirp(instHome);
	writeFileSync(join(instHome, ".gitconfig"), `[user]\n\tname = e2e\n\temail = e2e@test\n`);
	mkdirp(fixture);
	copyFileSync(tgz, join(fixture, `omp-web-${v1}.tgz`));
	writeFileSync(
		join(fixture, "release-manifest.json"),
		JSON.stringify(
			{
				version: v1,
				tarball: `omp-web-${v1}.tgz`,
				sha256: createHash("sha256").update(readFileSync(tgz)).digest("hex"),
			},
			null,
			2,
		),
	);
	fixtureServer = Bun.serve({
		port: INSTALLER_PORT,
		fetch(req) {
			const url = new URL(req.url);
			// The GitHub API shape install.sh hits for "latest": tag_name in
			// a releases/latest JSON body.
			if (url.pathname === "/repos/nibblebot/omp-web/releases/latest") {
				return Response.json({ tag_name: `v${v1}` });
			}
			const name = basename(url.pathname);
			const file =
				name === "release-manifest.json" || name === `omp-web-${v1}.tgz` ? join(fixture, name) : "";
			if (file !== "" && existsSync(file)) return new Response(readFileSync(file));
			return new Response("not found", { status: 404 });
		},
	});
	const installerServer = fixtureServer;
	const installerEnv = {
		...sandboxEnv(),
		HOME: instHome,
		BUN_INSTALL: instBunInstall,
		OMP_WEB_INSTALL_DIR: instDataHome,
		OMP_WEB_INSTALLER_API: `http://127.0.0.1:${INSTALLER_PORT}`,
		OMP_WEB_DOWNLOAD_BASE: `http://127.0.0.1:${INSTALLER_PORT}/dl`,
	};
	// install.sh's own bun is whatever the host has; the sandbox redirects
	// only the pieces the script controls.
	r = await run(
		"install.sh (fresh HOME + data home)",
		["sh", join(ROOT, "scripts", "install.sh")],
		{ env: installerEnv, timeoutMs: 180_000 },
	);
	check("install.sh succeeds", r.code === 0, r.stderr.slice(-400));
	check("install.sh bin exists", existsSync(instBin), "");
	const instLink = existsSync(instBin) ? realpathSync(instBin) : "";
	check(
		"install.sh bin symlinks into its pinned install dir",
		instLink === join(instDataHome, "install", "node_modules", "omp-web", "dist-bundle", "cli.js"),
		instLink,
	);
	r = await run("install.sh --version", [instBin, "--version"]);
	check("install.sh --version prints v1", r.code === 0 && r.stdout.trim() === v1, r.stdout.trim());
	r = await run(
		"install.sh reinstall is idempotent (same version)",
		["sh", join(ROOT, "scripts", "install.sh")],
		{ env: installerEnv, timeoutMs: 180_000 },
	);
	check("install.sh reinstall succeeds", r.code === 0, r.stderr.slice(-400));
	check(
		"install.sh ancestor package.json untouched",
		readFileSync(ancestorPkg, "utf8") === ancestorMarker,
		readFileSync(ancestorPkg, "utf8"),
	);
	check(
		"no node_modules in the ancestor project (install.sh)",
		!existsSync(join(sandbox, "node_modules")),
		"found ancestor node_modules",
	);
	installerServer.stop();

	// 3. Fixture repo + linked worktree
	// ---------------------------------------------------------------------------
	console.log("== 3. fixture repo ==");
	const gitEnv = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "e2e",
		GIT_AUTHOR_EMAIL: "e2e@test",
		GIT_COMMITTER_NAME: "e2e",
		GIT_COMMITTER_EMAIL: "e2e@test",
		HOME: home,
	};
	r = await run("git init", ["git", "init", "-b", "main", repoDir], { env: gitEnv });
	check("git init", r.code === 0, r.stderr.slice(-200));
	writeFileSync(join(repoDir, "README.md"), "fixture\n");
	r = await run("git add", ["git", "-C", repoDir, "add", "-A"], { env: gitEnv });
	check("git add", r.code === 0, r.stderr.slice(-200));
	r = await run("git commit", ["git", "-C", repoDir, "commit", "-m", "init"], { env: gitEnv });
	check("git commit", r.code === 0, r.stderr.slice(-200));
	r = await run(
		"git worktree add",
		["git", "-C", repoDir, "worktree", "add", "-b", "e2e-wt", wtDir],
		{ env: gitEnv },
	);
	check("git worktree add", r.code === 0, r.stderr.slice(-200));

	// 4. First-run config: the serve offer is TTY-gated, so this scripted
	// walk writes the same file the offer would (data home + workspaceDir
	// only — fleet/cli.ts writeConfigFile is the one writer).
	// ---------------------------------------------------------------------------
	console.log("== 4. config ==");
	mkdirSync(join(dataHome, "workspaces"), { recursive: true });
	const configPath = join(dataHome, "config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({ workspaceDir: join(dataHome, "workspaces") }, null, 2)}\n`,
	);
	check("config.json written", existsSync(configPath));
	if (existsSync(configPath)) {
		const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { workspaceDir?: string };
		check(
			"config.json has workspaceDir",
			cfg.workspaceDir === join(dataHome, "workspaces"),
			JSON.stringify(cfg),
		);
		check("config.json has no roots", !("roots" in cfg), JSON.stringify(cfg));
	}

	// 5. BARE omp-web from an arbitrary cwd (= serve), then register the
	// project + adopt the worktree over the loopback API (the picker's path)
	// ---------------------------------------------------------------------------
	console.log("== 5. serve (bare) ==");
	mkdirp(serveCwd);
	const serve = startDetached(
		"serve",
		[],
		sandboxEnv({ OMP_FLEET_PORT: String(OMP_PORT) }),
		serveCwd,
	);
	const serveDeadline = Date.now() + 30_000;
	let banner = "";
	while (
		Date.now() < serveDeadline &&
		!banner.includes(`fleet listening on 127.0.0.1:${OMP_PORT}`)
	) {
		await sleep(200);
		banner = serve.stdout.join("\n");
	}
	check(
		"serve prints fleet listening banner",
		banner.includes(`fleet listening on 127.0.0.1:${OMP_PORT}`),
		banner !== "" ? banner : `(no stdout; stderr: ${serve.stderr.join("\n").slice(-300)})`,
	);
	check("serve banner shows the config path", banner.includes("config: " + configPath), banner);
	// The state file lives next to the config (the data-home choice moves
	// config + state + workspaces together).
	check(
		"serve banner shows state next to the config",
		banner.includes("state: " + join(dataHome, "fleet-state.json")),
		banner,
	);
	check(
		"serve banner shows the Web UI link",
		banner.includes(`Web UI: http://localhost:${OMP_PORT}`),
		banner,
	);
	// UI served from an arbitrary cwd:
	const ui = await fetch(`http://127.0.0.1:${OMP_PORT}/`);
	const uiHtml = await ui.text();
	check(
		"embedded UI served from arbitrary cwd",
		ui.ok && uiHtml.includes("<!doctype html>"),
		uiHtml.slice(0, 80),
	);
	// Register the first repo (start:false — the E2E spawns explicitly later).
	const addRes = await fetch(`http://127.0.0.1:${OMP_PORT}/ctl/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: repoDir, start: false }),
	});
	const addBody = (await addRes.json()) as { project?: { projectId?: string; path?: string } };
	check(
		"project registered via /ctl/projects",
		addRes.status === 201 && addBody.project?.projectId !== undefined,
		JSON.stringify(addBody),
	);
	const projectId = addBody.project?.projectId ?? "";
	// Adopt the linked worktree (the API the setup wizard used to call).
	const adoptRes = await fetch(`http://127.0.0.1:${OMP_PORT}/ctl/projects/${projectId}/worktrees`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ worktreePath: wtDir, start: false }),
	});
	check(
		"linked worktree adopted via /ctl/projects/:id/worktrees",
		adoptRes.status === 201,
		await adoptRes.text(),
	);
	const projects = await fetchJson(`http://127.0.0.1:${OMP_PORT}/ctl/projects`);
	const projectsBody = projects.body as {
		projects: { path: string }[];
		registered: { projectId: string; path: string }[];
	};
	check(
		"registered project visible via /ctl/projects",
		Array.isArray(projectsBody?.registered) &&
			projectsBody.registered.some((p) => p.path === repoDir),
		JSON.stringify(projectsBody),
	);
	const adopted = projectsBody?.projects ?? [];
	check(
		"adopted worktree gone from the unregistered list",
		!adopted.some((p: { path: string }) => p.path === wtDir),
		JSON.stringify(adopted),
	);

	// 6. spawn a session on the registered project
	// ---------------------------------------------------------------------------
	console.log("== 6. spawn ==");
	const spawnRes = await fetch(`http://127.0.0.1:${OMP_PORT}/ctl/spawn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: repoDir }),
	});
	const spawnBody = (await spawnRes.json()) as { daemonId?: string };
	check(
		"spawn accepted",
		spawnRes.ok && typeof spawnBody.daemonId === "string",
		JSON.stringify(spawnBody),
	);
	const daemonId = spawnBody.daemonId ?? "";
	const readyDeadline = Date.now() + 60_000;
	let sessions: { daemonId: string; status: string; cwd?: string; projectId?: string }[] = [];
	while (Date.now() < readyDeadline) {
		await sleep(500);
		const s = await fetchJson(`http://127.0.0.1:${OMP_PORT}/ctl/sessions`);
		sessions = (s.body as { daemonId: string; status: string; cwd?: string }[]) ?? [];
		if (sessions.some((e) => e.daemonId === daemonId && e.status === "ready")) break;
	}
	const entry = sessions.find((e) => e.daemonId === daemonId);
	check("spawned daemon reaches ready", entry?.status === "ready", JSON.stringify(entry));
	check("daemon cwd matches project", entry?.cwd === repoDir, entry?.cwd);
	// The spawn route stamps projectId (fleet/worktrees.ts projectIdForCwd) so
	// the roster groups the daemon under the registered project.
	const projectEntry = sessions.find((e) => e.daemonId === daemonId);
	const p1 = projectsBody?.registered?.[0];
	check(
		"daemon tagged with the registered projectId",
		projectEntry?.projectId === p1?.projectId,
		`entry=${JSON.stringify(projectEntry)} project=${JSON.stringify(p1)}`,
	);

	// 7. update round-trip (fixture manifest + 0.2.0 tarball)
	// ---------------------------------------------------------------------------
	console.log("== 7. update ==");
	// Build a v0.2.0 bundle: bump package.json, rebuild, pack, restore.
	writeFileSync(pkgPath, originalPkg.replace(`"version": "${v1}"`, `"version": "${v2}"`));
	r = await run("bun run build (0.2.0)", ["bun", "run", "build"], { timeoutMs: 120_000 });
	check("0.2.0 build succeeds", r.code === 0, r.stderr.slice(-300));
	// Pack with the bumped package.json (bun pm pack names the tarball from it), then restore.
	r = await run("pack 0.2.0", ["bun", "pm", "pack"]);
	tgz2 = join(ROOT, `omp-web-${v2}.tgz`);
	check("0.2.0 tarball produced", r.code === 0 && existsSync(tgz2), r.stderr.slice(-200));
	writeFileSync(pkgPath, originalPkg); // restore immediately after packing
	if (!existsSync(tgz2)) throw new Error("no 0.2.0 tarball — aborting update step");
	const sha = createHash("sha256").update(readFileSync(tgz2)).digest("hex");
	mkdirp(fixture);
	copyFileSync(tgz2, join(fixture, `omp-web-${v2}.tgz`));
	writeFileSync(
		join(fixture, "release-manifest.json"),
		JSON.stringify({ version: v2, tarball: `omp-web-${v2}.tgz`, sha256: sha }, null, 2),
	);
	fixtureServer = Bun.serve({
		port: UPDATE_PORT,
		fetch(req) {
			const name = basename(new URL(req.url).pathname);
			const file =
				name === "release-manifest.json" || name === `omp-web-${v2}.tgz` ? join(fixture, name) : "";
			if (file !== "" && existsSync(file)) return new Response(readFileSync(file));
			return new Response("not found", { status: 404 });
		},
	});
	const updateEnv = sandboxEnv({
		OMP_WEB_UPDATE_URL: `http://127.0.0.1:${UPDATE_PORT}/latest/download`,
	});
	r = await run("omp-web update --check", [bin, "update", "--check"], { env: updateEnv });
	check("update --check reports 0.2.0", r.code === 0 && r.stdout.trim() === v2, r.stdout.trim());

	r = await run("omp-web update", [bin, "update"], { env: updateEnv, timeoutMs: 180_000 });
	check("update applies", r.code === 0, r.stderr.slice(-300));
	const newLink = realpathSync(bin);
	check(
		"bin still symlinks into the pinned install dir",
		newLink === join(dataHome, "install", "node_modules", "omp-web", "dist-bundle", "cli.js"),
		newLink,
	);
	r = await run("--version after update", [bin, "--version"]);
	check(`--version prints ${v2}`, r.code === 0 && r.stdout.trim() === v2, r.stdout.trim());
	// The update path runs bun remove/add in the pinned dir — must not walk
	// up into the poisoned ancestor.
	check(
		"update ancestor package.json untouched",
		readFileSync(ancestorPkg, "utf8") === ancestorMarker,
		readFileSync(ancestorPkg, "utf8"),
	);
	check(
		"no node_modules in the ancestor project (update)",
		!existsSync(join(sandbox, "node_modules")),
		"found ancestor node_modules",
	);
} catch (err) {
	fatal = err instanceof Error ? err.message : String(err);
} finally {
	// Guaranteed cleanup on every path (including crashes): kill spawned
	// processes, restore package.json, drop tarballs + the sandbox.
	await killAll();
	try {
		writeFileSync(pkgPath, originalPkg);
	} catch {}
	for (const t of [tgz, tgz2]) {
		try {
			rmSync(t, { force: true });
		} catch {}
	}
	try {
		fixtureServer?.stop();
	} catch {}
	if (!KEEP) {
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {}
	} else {
		console.log(`sandbox kept at ${sandbox}`);
	}
}

if (fatal !== null) {
	failures++;
	console.error(`FATAL: ${fatal}`);
}
console.log(
	failures === 0 ? `\nPASS — ${v1}→${v2} onboarding walk complete` : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
