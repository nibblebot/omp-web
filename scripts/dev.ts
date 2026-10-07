#!/usr/bin/env bun
/**
 * dev: one-command dev runner.
 *
 *   bun run dev          vite (:4713 HMR, /events + /command proxied to the omp-fleet
 *                        edge) + omp-fleet serve (:4722) + an optional auth broker
 *                        (adopted when one already runs, else spawned) that clone
 *                        sandboxes borrow credentials from. NO session is started or
 *                        attached; spawn/add one from the roster UI when you want one.
 *
 *   --host [addr]        bind vite to addr (default 0.0.0.0) for LAN access; the fleet
 *                        stays loopback; remote browsers reach it through vite's proxies.
 *                        No auth on the UI: trusted networks only.
 *   --allow-hosts [csv]  vite allowedHosts: bare = allow every Host header (tailscale
 *                        domains etc.), or a comma-separated allowlist.
 *   --state-from <path>  fork another fleet's state (a fleet-state.json file, or its
 *                        directory) into this worktree's dev fleet dir, like forking
 *                        it, so the dev UI boots with that roster/projects instead of
 *                        an empty one. Fork-once: only copied when this worktree's dev
 *                        state does not exist yet; later runs keep the diverged fork
 *                        (delete the dev state file to re-fork).
 *
 * Default: when this worktree is a linked git worktree of another checkout, the
 * dev fleet state is forked from that MAIN worktree's dev state (same fork-once
 * semantics), so a worktree's dev UI boots with the main roster/projects instead
 * of an empty one. Running in the main worktree itself (or with --state-from)
 * never self-seeds.
 *   --fresh               start on a FRESH state. Removes the worktree's existing
 *                        dev fleet state (if any) and skips the fork entirely, so
 *                        the roster boots empty. Mutually exclusive with
 *                        --state-from.
 *
 * Output model: every child's stdout/stderr is forwarded line-by-line with a
 * colored, fixed-width [name] prefix ([vite   ] [fleet  ]); the runner's own
 * messages use [dev    ]. Colors only when stdout is a TTY and NO_COLOR is
 * unset; piped output has no escapes.
 *
 * Each child is tracked through starting → ready (vite: its `Local:` line;
 * fleet: the "fleet listening" banner line). Every transition to ready logs one
 * `✓ <name> ready` runner line; once every child has been ready at least once,
 * a compact stack summary is printed once. Ctrl-C (or vite/fleet exiting) tears
 * down the rest.
 *
 * Ports: chosen at runtime so parallel worktrees don't collide. The fleet binds
 * port 0 (kernel-assigned ephemeral; the real port is read back from the banner
 * line); vite gets a probe-picked port with --strictPort. A pre-ready exit
 * (lost port race, startup crash) is retried on a fresh port, bounded, before
 * being declared fatal.
 *
 * State: the dev fleet's state file is scoped per worktree OUTSIDE the repo,
 * and its pidfile lock rides `<state>.lock` next to it: a stable
 * `<slug>-<hash8>` of the worktree realpath under `<data home>/dev-fleets/`
 * (data home = config dir, so the first-run data-home choice moves it too).
 * N worktrees running `bun run dev` plus the user's real fleet on
 * `<data home>/fleet-state.json` all coexist; nothing is written into the
 * repo. Config AND the managed-worktree root stay shared: the lock guards
 * only the state file; workspaces coordinate at path level (`.omp-web-repo`
 * markers, existing-target refusal, git's own no-double-checkout), so every
 * fleet sees and manages the same worktrees. A second `bun run dev` in the
 * SAME worktree still correctly fails on the lock (exit 77). Orphaned
 * dev-fleets dirs from deleted worktrees are inert and safe to remove by
 * hand once their dev stack is stopped (no auto-GC).
 */

import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { expandTilde, resolveConfigPath } from "../apps/fleet/config";
import { resolveOmpBinary } from "../apps/fleet/omp-check";
import { slugifyWorktreeName } from "../apps/fleet/worktrees";

const ROOT = join(import.meta.dir, "..");
/**
 * Per-worktree dev fleet data (state + its pidfile lock), outside the repo:
 * `<data home>/dev-fleets/<slug>-<hash8>/` where slug is the worktree
 * basename and hash8 the sha256 of its realpath. Deterministic per worktree
 * (dev restarts reuse the same fleet), distinct across worktrees. Only the
 * STATE is scoped; the managed-worktree root deliberately stays shared.
 */
const DEV_FLEET_DIR = (() => {
	const real = realpathSync(ROOT);
	const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
	const slug = slugifyWorktreeName(basename(real)) || "worktree";
	return join(dirname(resolveConfigPath()), "dev-fleets", `${slug}-${hash}`);
})();
/**
 * Fork-once seed: copy a source fleet-state.json into this worktree's dev
 * fleet dir when the dev state does not exist yet (a fresh fork). The source
 * may be a fleet-state.json file or its directory. Later runs keep the
 * diverged fork: like a git fork, the copy never re-syncs. When the dev
 * state already exists it is left untouched and no source is required. The
 * copy is read-only (we never mutate the source), and stale pids/liveness in
 * the fork are downgraded by the fleet's own boot reconcile. A bogus source
 * fails fast BEFORE the stack launches.
 *
 * When `source` is undefined (no explicit --state-from), the default is the
 * MAIN worktree's dev state: the sibling worktree whose common-git-dir is
 * the same repo (hash of that checkout's realpath, the same formula
 * DEV_FLEET_DIR uses). Running in the main worktree itself
 * yields its own path, which is skipped (a worktree never self-seeds; its
 * dev state already is the data). No main dev state yet → nothing to fork.
 */
function seedFleetState(source: string | undefined): void {
	const target = join(DEV_FLEET_DIR, "fleet-state.json");
	if (existsSync(target)) {
		// Fork already diverged, keep it (never re-sync). Logged so a user
		// with a small existing dev state isn't silently served stale data
		// when they expected a fresh fork.
		if (source !== undefined)
			log("fleet state exists, keeping the diverged fork (delete it to re-fork)");
		return;
	}
	// Default source: the main worktree's dev state.
	let from = source ?? mainWorktreeDevState();
	if (from === undefined) return;
	if (source !== undefined) {
		// Explicit source: accept a fleet-state.json file or a directory
		// holding one (e.g. another worktree's dev-fleets/<slug>-<hash8>/ or
		// the data home); anything else fails fast before the stack launches.
		const st = statSync(source, { throwIfNoEntry: false });
		if (st?.isDirectory()) from = join(source, "fleet-state.json");
		else if (st === undefined) throw new Error(`--state-from: not a file or directory: ${source}`);
	}
	mkdirSync(DEV_FLEET_DIR, { recursive: true });
	if (!existsSync(from)) {
		if (source !== undefined) throw new Error(`--state-from: no fleet-state.json at ${from}`);
		return; // no main dev state yet: fresh empty state, nothing to fork
	}
	// Validate parseable JSON with the registry's shape before copying;
	// a corrupt state would abort the fleet at boot, after the stack launched.
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(from, "utf8"));
	} catch (err) {
		throw new Error(`--state-from: unreadable state file ${from}: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`--state-from: ${from} is not a fleet-state.json (expected an object)`);
	}
	if (
		!("nextId" in parsed) ||
		typeof parsed.nextId !== "number" ||
		!("entries" in parsed) ||
		!Array.isArray(parsed.entries)
	) {
		throw new Error(`--state-from: ${from} is not a fleet-state.json (missing nextId/entries)`);
	}
	copyFileSync(from, target);
	log(`forked fleet state from ${from}`);
}

/**
 * The MAIN worktree's dev state path (default seed source), or
 * undefined when there is no sibling main checkout to fork from. A linked
 * worktree's git common dir is the main checkout's .git; the main checkout
 * itself has a common dir equal to its own .git, so a self-path is skipped.
 */
function mainWorktreeDevState(): string | undefined {
	let common;
	try {
		common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: ROOT })
			.toString()
			.trim();
	} catch {
		return undefined; // not a git checkout: no main worktree to fork
	}
	if (common === "" || common === ".") return undefined;
	// git-common-dir is absolute for linked worktrees (the main checkout's
	// .git path), relative for a plain repo; normalize, then resolve up from
	// the .git dir to the main checkout root.
	const mainRoot = realpathSync(join(isAbsolute(common) ? common : join(ROOT, common), ".."));
	if (realpathSync(ROOT) === mainRoot) return undefined; // we ARE the main worktree
	const hash = createHash("sha256").update(mainRoot).digest("hex").slice(0, 8);
	const slug = slugifyWorktreeName(basename(mainRoot)) || "worktree";
	return join(dirname(resolveConfigPath()), "dev-fleets", `${slug}-${hash}`, "fleet-state.json");
}

/** Fallback for readiness that arrives without a parseable port. */
const VITE_PORT_DEFAULT = 4713;

/**
 * Ports are chosen at runtime so parallel worktrees can each run `bun run dev`
 * without colliding. The fleet binds port 0 (kernel-assigned ephemeral, cannot
 * collide; the real port comes back via the "fleet listening" banner). Only
 * vite needs a fixed port (browsers bookmark it): probe-pick a free one and
 * launch with --strictPort, so a lost probe-bind race is a clean pre-ready
 * exit. Any pre-ready exit is retried on a fresh port (bounded) before being
 * declared fatal.
 */
const ports = { vite: VITE_PORT_DEFAULT, fleet: 4722 };
/**
 * Auth broker: clone sandboxes have no credential store of their own, so they
 * borrow the operator's from a broker when OMP_AUTH_BROKER_URL/TOKEN are in the
 * provider env (profile secretRefs `env:` references). The dev stack ADOPTS an
 * already-running broker that answers an authenticated probe on the default
 * bind (the credential store is global: one broker serves every worktree),
 * else spawns `omp auth-broker serve` itself and exports the pair into
 * process.env BEFORE the fleet child launches (children inherit it;
 * resolveProfileSecrets reads it at clone spawn). The broker is OPTIONAL:
 * missing omp CLI, token failure, or startup retries exhausted degrade to a
 * warning and a brokerless stack (clones run unauthenticated), never a fatal
 * exit. There is no idle-exit to disable: the broker's `idleTimeout` is
 * Bun.serve's per-connection socket timeout, not a process lifetime.
 */
const BROKER_DEFAULT_PORT = 8765;
/**
 * Broker restart backoff: doubles per ready-exit and resets after a healthy
 * uptime, so a crash loop settles at the cap instead of hot-looping.
 */
const BROKER_BACKOFF_MIN_MS = 1_000;
const BROKER_BACKOFF_MAX_MS = 30_000;
const BROKER_RESET_AFTER_MS = 60_000;
let brokerBackoffMs = BROKER_BACKOFF_MIN_MS;
let brokerUrl: string | undefined;
let brokerPort = BROKER_DEFAULT_PORT;
/** Resolved lazily by ensureBroker; buildChild("broker") reads it. */
let ompBin: string | undefined;
/** Consecutive pre-ready exits per child; reset on ready. */
const preReadyFails = new Map<string, number>();
const MAX_PREREADY_RETRIES = 5;

/** Probe-bind an ephemeral port, release it, and return it. */
function pickFreePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const srv = createServer();
	srv.unref();
	srv.once("error", reject);
	srv.listen(0, "127.0.0.1", () => {
		const addr = srv.address();
		const port = typeof addr === "object" && addr !== null ? addr.port : 0;
		srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no ephemeral port"))));
	});
	return promise;
}

/** True when 127.0.0.1:port is bindable right now. */
function isPortFree(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const srv = createServer();
	srv.unref();
	srv.once("error", () => resolve(false));
	srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
	return promise;
}

interface Child {
	name: string;
	cmd: string[];
	env?: Record<string, string>;
}

/**
 * The dev stack's children, in launch order. The fleet goes first: vite's
 * proxy needs its port.
 */
const CHILDREN = ["fleet", "vite"];

/**
 * Build a fresh Child for each launch: ports and env are baked in at call
 * time so retries/relaunches pick up re-picked ports.
 */
function buildChild(name: string): Child {
	if (name === "fleet") {
		return {
			name,
			// Port 0 = kernel-assigned ephemeral; the real port is parsed from
			// the "fleet listening on 127.0.0.1:<port>" banner. Sidebar spawns use
			// the default `local` template, which runs the production `omp-session`
			// binary, not built in dev. OMP_FLEET_LOCAL_TEMPLATE points it at the
			// source entry instead (absolute: spawned children inherit the fleet's
			// cwd, and the repo isn't necessarily it).
			cmd: ["bun", "apps/fleet/cli.ts", "serve", "--port", "0"],
			env: {
				// State (and its `.lock`) scoped per worktree under the data home:
				// parallel worktrees' dev fleets, and the user's real fleet on
				// <data home>/fleet-state.json, never contend on one state file,
				// and nothing is written into the repo. Config and the managed-
				// worktree root stay SHARED (the lock guards only state; workspaces
				// coordinate at path level).
				OMP_FLEET_STATE: join(DEV_FLEET_DIR, "fleet-state.json"),
				OMP_FLEET_LOCAL_TEMPLATE: `bun ${join(ROOT, "apps", "session", "index.ts")} --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}`,
			},
		};
	}
	if (name === "broker") {
		// Same port across restarts: the URL was baked into the fleet's env at
		// launch and cannot be updated mid-run, so a rebound broker must answer
		// where the fleet already points.
		return {
			name,
			cmd: [ompBin ?? "omp", "auth-broker", "serve", "--bind", `127.0.0.1:${brokerPort}`],
		};
	}
	// vite: launched last, once the fleet port is known; its proxy targets are
	// fixed at startup via env. --strictPort: exit on collision instead of
	// silently incrementing (the runner retries on a fresh port).
	const cmd = [
		"bunx",
		"vite",
		"--config",
		join(ROOT, "apps", "web", "vite.config.ts"),
		"--port",
		String(ports.vite),
		"--strictPort",
	];
	// --host exposes vite only: the /events, /command, /ctl proxies run
	// server-side, so remote browsers reach the loopback fleet edge through
	// vite. The edge is loopback-only by design.
	if (host !== undefined) cmd.push("--host", host);
	const env: Record<string, string> = {
		// vite's proxy target for /events + /command + /ctl; the roster UI runs
		// with HMR, no dist/ build needed.
		OMP_DEV_FLEET_PORT: String(ports.fleet),
	};
	if (allowHosts !== undefined) env.OMP_DEV_ALLOW_HOSTS = allowHosts;
	return { name: "vite", cmd, env };
}

const args = process.argv.slice(2);
let host: string | undefined;
let allowHosts: string | undefined;
let stateFrom: string | undefined;
let fresh = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "fleet") {
		// The only runtime; accepted so `bun run dev` can pass it explicitly.
	} else if (arg === "--host") {
		const next = args[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			host = next;
			i++;
		} else {
			host = "0.0.0.0";
		}
	} else if (arg.startsWith("--host=")) {
		host = arg.slice("--host=".length);
	} else if (arg === "--allow-hosts") {
		const next = args[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			allowHosts = next;
			i++;
		} else {
			allowHosts = "*";
		}
	} else if (arg.startsWith("--allow-hosts=")) {
		allowHosts = arg.slice("--allow-hosts=".length);
	} else if (arg === "--state-from") {
		const next = args[i + 1];
		if (next === undefined || next.startsWith("--")) {
			console.error("--state-from requires a path argument");
			process.exit(2);
		}
		stateFrom = expandTilde(next);
		i++;
	} else if (arg.startsWith("--state-from=")) {
		stateFrom = expandTilde(arg.slice("--state-from=".length));
	} else if (arg === "--fresh") {
		fresh = true;
	} else {
		console.error(`unrecognized argument: ${arg}`);
		console.error(
			"usage: bun scripts/dev.ts [fleet] [--host [addr]] [--allow-hosts [csv]] [--state-from <path>] [--fresh]",
		);
		process.exit(2);
	}
}
if (fresh && stateFrom !== undefined) {
	console.error("--fresh and --state-from are mutually exclusive (fresh skips seeding)");
	process.exit(2);
}

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Output: colored, fixed-width per-child prefixes. `dev` is the runner's own
// tag. Colors are gated on a TTY stdout and NO_COLOR; piped output is plain.
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CHILD_COLORS: Record<string, number> = { vite: 36, fleet: 35, broker: 34, dev: 32 };
const useColor = process.stdout.isTTY === true && !("NO_COLOR" in process.env);

function prefix(name: string): string {
	const tag = `[${name.padEnd(7)}]`;
	if (!useColor) return tag;
	return `\x1b[${CHILD_COLORS[name] ?? 39}m${tag}\x1b[0m`;
}

/** Bold wrapper, gated on the same TTY/NO_COLOR switch as prefix colors. */
function bold(s: string): string {
	return useColor ? `\x1b[1m${s}\x1b[0m` : s;
}

function log(message: string): void {
	process.stdout.write(`${prefix("dev")} ${message}\n`);
}

// Seed before ANY child launches: a --state-from copy (or the default
// main-worktree fork) happens at most once, and a bogus source must fail
// before the stack starts (never after). --fresh instead starts clean: the
// worktree's existing dev state is removed so the fleet boots EMPTY (the
// .lock is left to the fleet's own acquire: stale locks self-heal, a live
// fleet still fails exit 77) and no seeding runs.
if (fresh) {
	const existing = join(DEV_FLEET_DIR, "fleet-state.json");
	if (existsSync(existing)) {
		rmSync(existing);
		log("removed existing dev fleet state, fresh start");
	}
} else {
	seedFleetState(stateFrom);
}

// ---------------------------------------------------------------------------
// Per-child state: starting → ready → exited (any exit is fatal). `readyOnce`
// tracks "ready at least once" for the summary.
// ---------------------------------------------------------------------------

type ChildStatus = "starting" | "ready" | "exited";

interface ChildState {
	name: string;
	status: ChildStatus;
	port?: number;
	pid: number;
	readyOnce: boolean;
}

const states = new Map<string, ChildState>();
/** True once the stack summary has been printed. */
let summaryPrinted = false;
/** One-shot waiters for the next `ready` transition of a child (startup sequencing). */
const readyWaiters = new Map<string, () => void>();

/** Resolves the next time `name` becomes ready. */
function waitReady(name: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	readyWaiters.set(name, resolve);
	return promise;
}

function markReady(name: string, port: number, detail: string): void {
	const st = states.get(name);
	if (st === undefined || st.status === "ready") return;
	st.status = "ready";
	st.port = port;
	st.readyOnce = true;
	preReadyFails.set(name, 0);
	log(`✓ ${name} ready, ${detail} (pid ${st.pid})`);
	readyWaiters.get(name)?.();
	readyWaiters.delete(name);
	checkSummary();
}

function checkSummary(): void {
	if (summaryPrinted) return;
	for (const name of CHILDREN) {
		const st = states.get(name);
		if (st === undefined || !st.readyOnce) return;
	}
	summaryPrinted = true;
	const uiPort = states.get("vite")?.port ?? ports.vite;
	const fleetPort = states.get("fleet")?.port ?? ports.fleet;
	log(bold("stack ready"));
	log(
		`${bold(`  ${"ui".padEnd(9)}http://localhost:${uiPort}  `)}` +
			"(vite, HMR, proxies /events /command /ctl → fleet)",
	);
	log(`${bold(`  ${"fleet".padEnd(9)}http://127.0.0.1:${fleetPort}  `)}(control plane + edge)`);
	if (brokerUrl !== undefined)
		log(
			`${bold(`  ${"broker".padEnd(9)}${brokerUrl}  `)}(auth broker${states.get("broker")?.readyOnce === true ? "" : ", adopted, not managed by this stack"}; clone secretRefs borrow credentials)`,
		);
	log(
		`${bold(`  ${"state".padEnd(9)}${join(DEV_FLEET_DIR, "fleet-state.json")}  `)}(worktree-scoped)`,
	);
	log("  no session attached. Spawn/add one from the roster sidebar");
}

/** Forward a piped stream with a per-line `[name] ` prefix. */
async function pipePrefixed(
	stream: ReadableStream<Uint8Array>,
	name: string,
	out: NodeJS.WriteStream,
	onLine?: (line: string) => string | false | void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const writeLine = (line: string): void => {
		if (onLine !== undefined) {
			const replaced = onLine(line);
			if (replaced === false) return;
			if (typeof replaced === "string") line = replaced;
		}
		out.write(`${prefix(name)} ${line}\n`);
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		let nl = pending.indexOf("\n");
		while (nl !== -1) {
			writeLine(pending.slice(0, nl));
			pending = pending.slice(nl + 1);
			nl = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) writeLine(pending);
}

/**
 * Per-child stdout readiness hooks. Vite: watch for its `Local:` line. Fleet:
 * parse the "fleet listening on 127.0.0.1:<port>" banner (stable shape;
 * scripts parse the port out of it).
 *
 * Stale-line guard: a dead child's pipe can flush after a relaunch, so only
 * the process currently registered under `name` may move readiness/ports.
 */
function stdoutHook(
	name: string,
	proc: Subprocess,
): ((line: string) => string | false | void) | undefined {
	const current = (): boolean => procs.get(name) === proc;
	if (name === "vite") {
		return (line) => {
			if (!current()) return;
			const m = line.replace(ANSI_RE, "").match(/Local:\s+http:\/\/localhost:(\d+)/);
			if (m) markReady("vite", Number(m[1]), `ui on http://localhost:${m[1]}`);
		};
	}
	if (name === "fleet") {
		return (line) => {
			if (!current()) return;
			const m = line.replace(ANSI_RE, "").match(/fleet listening on 127\.0\.0\.1:(\d+)/);
			if (m) {
				ports.fleet = Number(m[1]);
				markReady("fleet", ports.fleet, `control+edge on http://127.0.0.1:${m[1]}`);
			}
		};
	}
	if (name === "broker") {
		return (line) => {
			if (!current()) return;
			// JSON log line on stdout: {"message":"auth-broker listening","url":…}
			const m = line.match(
				/"message":"auth-broker listening","url":"(http:\/\/127\.0\.0\.1:(\d+))"/,
			);
			if (m) {
				brokerUrl = m[1];
				markReady("broker", Number(m[2]), `auth broker on ${m[1]}`);
			}
		};
	}
	return undefined;
}

const procs = new Map<string, Subprocess>();

/** Resolves on the first child exit (post-ready, or retries exhausted). */
let fatalResolve: (result: { name: string; code: number | null }) => void;
const fatalPromise = (() => {
	const { promise, resolve } = Promise.withResolvers<{ name: string; code: number | null }>();
	fatalResolve = resolve;
	return promise;
})();
/** Resolves when the broker's startup retries are exhausted (ensureBroker races it). */
let brokerGiveUpResolve: () => void;
const brokerGiveUpPromise = (() => {
	const { promise, resolve } = Promise.withResolvers<void>();
	brokerGiveUpResolve = resolve;
	return promise;
})();

function launch(child: Child): void {
	const proc = Bun.spawn(child.cmd, {
		cwd: ROOT,
		env: { ...process.env, ...child.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	procs.set(child.name, proc);
	states.set(child.name, { name: child.name, status: "starting", pid: proc.pid, readyOnce: false });
	void pipePrefixed(proc.stdout, child.name, process.stdout, stdoutHook(child.name, proc));
	void pipePrefixed(proc.stderr, child.name, process.stderr);
	if (child.name === "broker") {
		// The broker is an OPTIONAL sidecar: its exit must never take the stack
		// down. Relaunch it on the same port (the URL was baked into the fleet's
		// env at launch and cannot change mid-run) with a bounded backoff. A
		// deliberate remove-then-kill (give-up path) leaves procs pointing
		// elsewhere, so this returns before scheduling a restart.
		const startedAt = Date.now();
		void proc.exited.then((code) => {
			if (shuttingDown || procs.get(child.name) !== proc) return;
			procs.delete(child.name);
			const st = states.get(child.name);
			if (st?.readyOnce !== true) {
				// Pre-ready exit: bound the attempts, then run brokerless for good.
				const fails = (preReadyFails.get("broker") ?? 0) + 1;
				preReadyFails.set("broker", fails);
				if (fails > MAX_PREREADY_RETRIES) {
					log(
						`broker failed ${fails} startup attempts, continuing WITHOUT it (clones run unauthenticated)`,
					);
					if (st !== undefined) st.status = "exited";
					brokerGiveUpResolve();
					return;
				}
			}
			if (st !== undefined) st.status = "starting";
			if (Date.now() - startedAt > BROKER_RESET_AFTER_MS) brokerBackoffMs = BROKER_BACKOFF_MIN_MS;
			const delay = brokerBackoffMs;
			brokerBackoffMs = Math.min(brokerBackoffMs * 2, BROKER_BACKOFF_MAX_MS);
			log(
				`broker exited (${code ?? "signal"}), restarting in ${delay / 1000}s on the same port (the rest of the stack stays up)`,
			);
			setTimeout(() => {
				if (!shuttingDown) launch(buildChild("broker"));
			}, delay);
		});
		return;
	}
	void proc.exited.then((code) => {
		if (shuttingDown) return;
		if (procs.get(child.name) !== proc) return; // superseded by a pre-ready retry
		const st = states.get(child.name);
		if (st !== undefined && !st.readyOnce) {
			// Pre-ready exit, almost always a lost port race (vite --strictPort).
			// Retry on a fresh port before declaring the stack broken.
			const fails = (preReadyFails.get(child.name) ?? 0) + 1;
			preReadyFails.set(child.name, fails);
			// Fleet exit 77 = deterministic lock conflict (another fleet holds the
			// state file, e.g. a second `bun run dev` in the SAME worktree).
			// Retrying cannot fix it, so fail immediately.
			if (child.name === "fleet" && code === 77) {
				log(`${child.name} exited before ready (77), state lock held by another fleet`);
				if (st !== undefined) st.status = "exited";
				fatalResolve({ name: child.name, code });
				return;
			}
			if (fails <= MAX_PREREADY_RETRIES) {
				void retryPreReady(child.name, code, fails);
				return;
			}
			log(`${child.name} failed ${fails} startup attempts, giving up`);
		}
		if (st !== undefined) st.status = "exited";
		fatalResolve({ name: child.name, code });
	});
}

/** Re-pick the child's port (vite; fleet rebinds ephemeral) and relaunch. */
async function retryPreReady(name: string, code: number | null, attempt: number): Promise<void> {
	if (name === "vite") ports.vite = await pickFreePort();
	log(
		`${name} exited before ready (${code ?? "signal"}), retrying on port ${name === "vite" ? ports.vite : "0 (ephemeral)"} (${attempt}/${MAX_PREREADY_RETRIES})`,
	);
	if (!shuttingDown) launch(buildChild(name));
}

// Fleet first (ephemeral bind, cannot collide), vite once the edge port is
// known. A fatal resolution during this await = startup retries exhausted on
// the fleet.
log(
	"starting omp-fleet + vite HMR (ports chosen at startup). Spawn/add a session from the sidebar",
);

/**
 * Authenticated broker probe: 200 on /v1/snapshot with OUR token means a
 * broker serving this operator's credential store already listens (another
 * worktree's dev stack, a systemd unit) and can be adopted. 401/closed means
 * a foreign occupant or nothing, so spawn our own.
 */
async function probeBroker(url: string, token: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/v1/snapshot`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Read-or-create the broker bearer via the CLI (`omp auth-broker token` is
 * idempotent: prints the existing token, creating ~/.omp/auth-broker.token
 * 0600 on first run). Never logs the token itself.
 */
async function brokerToken(bin: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([bin, "auth-broker", "token"], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		const token = out.trim().split("\n").at(-1)?.trim();
		return code === 0 && token !== undefined && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fleet-mode boot step: make an auth broker available and export
 * OMP_AUTH_BROKER_URL/TOKEN into process.env BEFORE the fleet child launches
 * (children inherit it; provider secretRefs `env:` references resolve from
 * it). Adopt-first, spawn-else; every failure degrades to a brokerless stack
 * with a warning.
 */
async function ensureBroker(): Promise<void> {
	const bin = resolveOmpBinary();
	if (bin === null) {
		log("auth broker: omp CLI not found, continuing WITHOUT it (clones run unauthenticated)");
		return;
	}
	ompBin = bin;
	const token = await brokerToken(bin);
	if (token === undefined) {
		log("auth broker: could not read/create the bearer token, continuing WITHOUT it");
		return;
	}
	const defaultUrl = `http://127.0.0.1:${BROKER_DEFAULT_PORT}`;
	if (await probeBroker(defaultUrl, token)) {
		brokerUrl = defaultUrl;
		process.env.OMP_AUTH_BROKER_URL = brokerUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = token;
		log(`auth broker: adopted the running broker at ${brokerUrl}`);
		return;
	}
	if (!(await isPortFree(BROKER_DEFAULT_PORT))) brokerPort = await pickFreePort();
	launch(buildChild("broker"));
	const settled = await Promise.race([
		waitReady("broker").then(() => "ready" as const),
		brokerGiveUpPromise.then(() => "gaveup" as const),
		new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000)),
	]);
	if (settled === "ready" && brokerUrl !== undefined) {
		process.env.OMP_AUTH_BROKER_URL = brokerUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = token;
		log(
			`auth broker: serving at ${brokerUrl}, OMP_AUTH_BROKER_URL/TOKEN exported for clone secretRefs`,
		);
		return;
	}
	if (settled === "timeout") {
		// A silent hang (never ready, no retry exhaustion): remove-then-kill so
		// the exited handler schedules no restart, then carry on without a broker.
		log("auth broker: no readiness after 15s, continuing WITHOUT it (clones run unauthenticated)");
		const proc = procs.get("broker");
		if (proc !== undefined) {
			procs.delete("broker");
			proc.kill();
		}
	}
}

await ensureBroker();
launch(buildChild("fleet"));
const boot = await Promise.race([waitReady("fleet").then(() => null), fatalPromise]);
if (boot !== null) {
	log(`${boot.name} exited (${boot.code ?? "signal"}) during startup, shutting down`);
	await shutdown(boot.code ?? 1);
}

ports.vite = await pickFreePort();
launch(buildChild("vite"));

if (host !== undefined)
	log(
		`vite listening on ${host}:${ports.vite}. The UI (and full agent control through it) is reachable from the network with no auth; trusted networks only`,
	);
if (allowHosts !== undefined)
	log(`vite allowedHosts: ${allowHosts === "*" ? "all Host headers allowed" : allowHosts}`);

async function shutdown(code: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	const running = [...procs.values()];
	for (const proc of running) proc.kill();
	await Promise.all(running.map((proc) => proc.exited));
	process.exit(code);
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

// First child (vite/fleet) to exit wins: tear the rest down and propagate its
// code.
const first = await fatalPromise;
log(`${first.name} exited (${first.code ?? "signal"}), shutting down`);
await shutdown(first.code ?? 1);
