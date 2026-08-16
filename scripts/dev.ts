#!/usr/bin/env bun
/**
 * dev — one-command dev runner.
 *
 *   bun run dev          fleet mode: vite (:4713 HMR, /events + /command proxied to omp-fleet)
 *                        (:4722) + omp-fleet serve. NO session is started or attached —
 *                        spawn/add one from the roster UI when you want one.
 *   bun run dev:single   single-session mode: omp-session (:4721, --watch) + vite (:4713 HMR)
 *
 *   --host [addr]        bind vite to addr (default 0.0.0.0) for LAN access; backends stay
 *                        loopback — remote browsers reach them through vite's proxies.
 *                        No auth on the UI: trusted networks only.
 *   --allow-hosts [csv]  vite allowedHosts: bare = allow every Host header (tailscale
 *                        domains etc.), or a comma-separated allowlist.
 *
 * Output model: every child's stdout/stderr is forwarded line-by-line with a
 * colored, fixed-width [name] prefix ([vite   ] [fleet  ] [session]); the
 * runner's own messages use [dev    ]. Colors only when stdout is a TTY and
 * NO_COLOR is unset — piped output has no escapes.
 *
 * Each child is tracked through starting → ready (vite: its `Local:` line;
 * session: the OMP_SESSION| contract line, which is consumed for readiness
 * and NOT echoed — machine noise; fleet: the "fleet listening" banner line).
 * Every transition to ready logs one `✓ <name> ready` runner line; once every
 * child in the mode has been ready at least once, a compact stack summary is
 * printed once per full readiness (re-armed when a session restart brings the
 * stack back). Ctrl-C (or vite/fleet exiting) tears down the rest. The
 * omp-session child is different: idle exit is a FEATURE (no attached clients
 * → clean shutdown), so a session exit just restarts it with backoff — it
 * never nukes the stack.
 *
 * Ports: chosen at runtime so parallel worktrees don't collide. fleet/session
 * bind port 0 (kernel-assigned ephemeral; the real port is read back from the
 * contract/banner line); vite gets a probe-picked port with --strictPort. A
 * pre-ready exit (lost port race, startup crash) is retried on a fresh port,
 * bounded, before being declared fatal.
 */

import type { Subprocess } from "bun";
import { createServer } from "node:net";
import { join } from "node:path";
import { OMP_SESSION_PREFIX } from "../shared/protocol";

const ROOT = join(import.meta.dir, "..");
/** Fallbacks for readiness that arrives without a parseable port. */
const VITE_PORT_DEFAULT = 4713;
const SESSION_PORT_DEFAULT = 4721;

/**
 * Ports are chosen at runtime so parallel worktrees can each run `bun run dev`
 * without colliding. fleet/session bind port 0 (kernel-assigned ephemeral —
 * cannot collide; the real port comes back via the OMP_SESSION| contract line
 * / the "fleet listening" banner). Only vite needs a fixed port (browsers
 * bookmark it): probe-pick a free one and launch with --strictPort, so a lost
 * probe-bind race is a clean pre-ready exit. Any pre-ready exit is retried on
 * a fresh port (bounded) before being declared fatal.
 */
const ports = { vite: VITE_PORT_DEFAULT, session: SESSION_PORT_DEFAULT, fleet: 4722 };
/** `--port` value for the NEXT session launch; "0" = ephemeral. */
let sessionPortArg = "0";
/** Session port vite's proxy was configured with; undefined until vite's first launch. */
let viteSessionPort: number | undefined;
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

const MODES: Record<string, { children: string[]; open: string }> = {
	session: {
		children: ["session", "vite"],
		open: "standalone: omp-session + vite HMR (ports chosen at startup; see summary)",
	},
	fleet: {
		children: ["fleet", "vite"],
		open: "roster: omp-fleet + vite HMR (ports chosen at startup) — spawn/add a session from the sidebar",
	},
};

/**
 * Build a fresh Child for each launch: ports and env are baked in at call
 * time so retries/relaunches pick up re-picked ports.
 */
function buildChild(name: string): Child {
	if (name === "session") {
		return { name, cmd: ["bun", "--watch", "server/index.ts", "--port", sessionPortArg] };
	}
	if (name === "fleet") {
		return {
			name,
			// Port 0 = kernel-assigned ephemeral; the real port is parsed from
			// the "fleet listening on 127.0.0.1:<port>" banner. Sidebar spawns use
			// the default `local` template, which runs the production `omp-session`
			// binary — not built in dev. OMP_FLEET_LOCAL_TEMPLATE points it at the
			// source entry instead (absolute: spawned children inherit the fleet's
			// cwd, and the repo isn't necessarily it).
			cmd: ["bun", "fleet/cli.ts", "serve", "--port", "0"],
			env: {
				OMP_FLEET_LOCAL_TEMPLATE: `bun ${join(ROOT, "server", "index.ts")} --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}`,
			},
		};
	}
	// vite: launched last, once the backend ports are known — its proxy targets
	// are fixed at startup via env. --strictPort: exit on collision instead of
	// silently incrementing (the runner retries on a fresh port).
	const cmd = ["bunx", "vite", "--port", String(ports.vite), "--strictPort"];
	// --host exposes vite only: the /events, /command, /download, /ctl proxies
	// run server-side, so remote browsers reach the loopback backends through
	// vite. omp-session hard-requires --token off-loopback and the fleet edge
	// is loopback-only by design — neither needs to change.
	if (host !== undefined) cmd.push("--host", host);
	const env: Record<string, string> = {};
	if (modeArg === "fleet") {
		// OMP_DEV_FLEET switches vite's /events + /command + /download proxy to
		// omp-fleet, so the roster UI runs with HMR — no dist/ build needed.
		env.OMP_DEV_FLEET = "1";
		env.OMP_DEV_FLEET_PORT = String(ports.fleet);
	} else {
		env.OMP_DEV_SESSION_PORT = String(ports.session);
	}
	if (allowHosts !== undefined) env.OMP_DEV_ALLOW_HOSTS = allowHosts;
	return { name: "vite", cmd, env };
}

const args = process.argv.slice(2);
let modeArg = "session";
let host: string | undefined;
let allowHosts: string | undefined;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--host") {
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
	} else if (MODES[arg] !== undefined && modeArg === "session") {
		modeArg = arg;
	} else {
		console.error(`unrecognized argument: ${arg}`);
		console.error(`usage: bun scripts/dev.ts [${Object.keys(MODES).join("|")}] [--host [addr]] [--allow-hosts [csv]]`);
		process.exit(2);
	}
}
const mode = MODES[modeArg];
if (mode === undefined) {
	console.error(`usage: bun scripts/dev.ts [${Object.keys(MODES).join("|")}] [--host [addr]]`);
	process.exit(2);
}

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Output: colored, fixed-width per-child prefixes. `dev` is the runner's own
// tag. Colors are gated on a TTY stdout and NO_COLOR — piped output is plain.
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CHILD_COLORS: Record<string, number> = { vite: 36, fleet: 35, session: 33, dev: 32 };
const useColor = process.stdout.isTTY === true && !("NO_COLOR" in process.env);

function prefix(name: string): string {
	const tag = `[${name.padEnd(7)}]`;
	if (!useColor) return tag;
	return `\x1b[${CHILD_COLORS[name] ?? 39}m${tag}\x1b[0m`;
}

function log(message: string): void {
	process.stdout.write(`${prefix("dev")} ${message}\n`);
}

// ---------------------------------------------------------------------------
// Per-child state: starting → ready (fatal exit: exited; restartable exit:
// restarting). `readyOnce` tracks "ready at least once" for the summary.
// ---------------------------------------------------------------------------

type ChildStatus = "starting" | "ready" | "restarting" | "exited";

interface ChildState {
	name: string;
	status: ChildStatus;
	port?: number;
	pid: number;
	readyOnce: boolean;
}

const states = new Map<string, ChildState>();
/** True until the summary has been printed for the current readiness pass. */
let summaryArmed = true;
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
	log(`✓ ${name} ready — ${detail} (pid ${st.pid})`);
	readyWaiters.get(name)?.();
	readyWaiters.delete(name);
	checkSummary();
}

function checkSummary(): void {
	if (!summaryArmed) return;
	for (const name of mode.children) {
		const st = states.get(name);
		if (st === undefined || !st.readyOnce) return;
	}
	summaryArmed = false;
	const fleetMode = modeArg === "fleet";
	const uiPort = states.get("vite")?.port ?? ports.vite;
	log("stack ready");
	log(
		`  ${"ui".padEnd(9)}http://localhost:${uiPort}  ${
			fleetMode ? "(vite, HMR, proxies /events /command /ctl → fleet)" : "(vite, HMR, proxies /events /command → session)"
		}`,
	);
	if (fleetMode) {
		const fleetPort = states.get("fleet")?.port ?? ports.fleet;
		log(`  ${"fleet".padEnd(9)}http://127.0.0.1:${fleetPort}  (control plane + edge)`);
		log("  no session attached — spawn/add one from the roster sidebar");
	} else {
		const sessionPort = states.get("session")?.port ?? ports.session;
		log(`  ${"session".padEnd(9)}ws://127.0.0.1:${sessionPort}  (dev session)`);
	}
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
 * Per-child stdout readiness hooks. Session: consume the OMP_SESSION| contract
 * line (machine noise — never echoed; readiness + port come from it). Vite:
 * watch for its `Local:` line. Fleet: parse the "fleet listening on
 * 127.0.0.1:<port>" banner (stable shape — scripts parse the port out of it).
 *
 * Stale-line guard: a dead child's pipe can flush after a relaunch, so only
 * the process currently registered under `name` may move readiness/ports.
 */
function stdoutHook(name: string, proc: Subprocess): ((line: string) => string | false | void) | undefined {
	const current = (): boolean => procs.get(name) === proc;
	if (name === "session") {
		return (line) => {
			if (!line.startsWith(OMP_SESSION_PREFIX) || !current()) return;
			let port = 0;
			try {
				const parsed = JSON.parse(line.slice(OMP_SESSION_PREFIX.length)) as { event?: string; port?: number };
				if (typeof parsed.port === "number") port = parsed.port;
			} catch {
				// not parseable — readiness still happened, keep the default port
			}
			const resolved = port > 0 ? port : SESSION_PORT_DEFAULT;
			ports.session = resolved;
			if (viteSessionPort !== undefined && viteSessionPort !== resolved) {
				// The session came back on a new port: vite's proxy target is fixed
				// at startup, so relaunch vite (same vite port) to re-point it.
				viteSessionPort = resolved;
				log(`session moved to port ${resolved} — relaunching vite to re-point its proxy`);
				void relaunchVite();
			}
			markReady("session", resolved, `dev session on ws://127.0.0.1:${resolved}`);
			return false;
		};
	}
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
	return undefined;
}

/**
 * Children whose exit is EXPECTED and must not tear down the stack: the dev
 * omp-session idle-exits when it has no attached clients (that is its
 * designed lifecycle), so it is relaunched with a bounded backoff instead.
 * A vite/fleet exit means the dev environment is actually broken and stays
 * fatal (first exit wins, everything comes down).
 */
const RESTARTABLE: Record<string, true> = { session: true };
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
/** Uptime after which the restart backoff resets (a crash loop keeps it capped). */
const RESTART_RESET_AFTER_MS = 60_000;

const procs = new Map<string, Subprocess>();
let restartBackoffMs = RESTART_BACKOFF_MIN_MS;

/** Resolves on the first FATAL exit (post-ready vite/fleet, or retries exhausted). */
let fatalResolve: (result: { name: string; code: number | null }) => void;
const fatalPromise = (() => {
	const { promise, resolve } = Promise.withResolvers<{ name: string; code: number | null }>();
	fatalResolve = resolve;
	return promise;
})();

function launch(child: Child): void {
	const proc = Bun.spawn(child.cmd, { cwd: ROOT, env: { ...process.env, ...child.env }, stdout: "pipe", stderr: "pipe" });
	procs.set(child.name, proc);
	states.set(child.name, { name: child.name, status: "starting", pid: proc.pid, readyOnce: false });
	void pipePrefixed(proc.stdout, child.name, process.stdout, stdoutHook(child.name, proc));
	void pipePrefixed(proc.stderr, child.name, process.stderr);
	if (RESTARTABLE[child.name] === true) {
		const startedAt = Date.now();
		void proc.exited.then((code) => {
			if (procs.get(child.name) === proc) procs.delete(child.name);
			if (shuttingDown) return;
			const st = states.get(child.name);
			const wasReady = st?.readyOnce === true;
			if (st !== undefined) st.status = "restarting";
			// A restart re-arms the summary: it reprints once the stack is
			// fully ready again (ports/pids from the fresh process).
			summaryArmed = true;
			if (Date.now() - startedAt > RESTART_RESET_AFTER_MS) restartBackoffMs = RESTART_BACKOFF_MIN_MS;
			const delay = restartBackoffMs;
			restartBackoffMs = Math.min(restartBackoffMs * 2, RESTART_BACKOFF_MAX_MS);
			if (wasReady) {
				log(`${child.name} exited (${code ?? "signal"}) — idle exit is expected; restarting in ${delay / 1000}s (the rest of the stack stays up)`);
				setTimeout(() => {
					if (!shuttingDown) void restartSession();
				}, delay);
				return;
			}
			// Pre-ready exit: lost the probe-bind race or a startup crash. Retry
			// on a fresh ephemeral port; only exhaust into fatal after a bounded
			// number of attempts (a real crash loop must still take the stack down).
			const fails = (preReadyFails.get(child.name) ?? 0) + 1;
			preReadyFails.set(child.name, fails);
			if (fails > MAX_PREREADY_RETRIES) {
				log(`${child.name} failed ${fails} startup attempts — giving up`);
				fatalResolve({ name: child.name, code });
				return;
			}
			log(`${child.name} exited before ready (${code ?? "signal"}) — retrying on a fresh ephemeral port (${fails}/${MAX_PREREADY_RETRIES})`);
			sessionPortArg = "0";
			setTimeout(() => {
				if (!shuttingDown) launch(buildChild("session"));
			}, delay);
		});
		return;
	}
	void proc.exited.then((code) => {
		if (shuttingDown) return;
		if (procs.get(child.name) !== proc) return; // intentionally replaced (vite relaunch)
		const st = states.get(child.name);
		if (st !== undefined && !st.readyOnce) {
			// Pre-ready exit — almost always a lost port race (vite --strictPort).
			// Retry on a fresh port before declaring the stack broken.
			const fails = (preReadyFails.get(child.name) ?? 0) + 1;
			preReadyFails.set(child.name, fails);
			if (fails <= MAX_PREREADY_RETRIES) {
				void retryPreReady(child.name, code, fails);
				return;
			}
			log(`${child.name} failed ${fails} startup attempts — giving up`);
		}
		if (st !== undefined) st.status = "exited";
		fatalResolve({ name: child.name, code });
	});
}

/** Re-pick the child's port (vite; fleet rebinds ephemeral) and relaunch. */
async function retryPreReady(name: string, code: number | null, attempt: number): Promise<void> {
	if (name === "vite") ports.vite = await pickFreePort();
	log(`${name} exited before ready (${code ?? "signal"}) — retrying on port ${name === "vite" ? ports.vite : "0 (ephemeral)"} (${attempt}/${MAX_PREREADY_RETRIES})`);
	if (!shuttingDown) launch(buildChild(name));
}

/**
 * Session restart: reuse the last port while it's still free (vite's proxy
 * target stays valid); else rebind ephemeral — the stdout hook relaunches
 * vite once the new port is known. A lost probe-bind race surfaces as a
 * pre-ready exit, handled in launch().
 */
async function restartSession(): Promise<void> {
	sessionPortArg = (await isPortFree(ports.session)) ? String(ports.session) : "0";
	launch(buildChild("session"));
}

/**
 * Kill vite and relaunch it on the SAME port (waiting for the old process to
 * release it), picking up the current backend ports for its proxy targets.
 */
async function relaunchVite(): Promise<void> {
	const proc = procs.get("vite");
	if (proc !== undefined) {
		procs.delete("vite"); // intentional: this exit is not fatal
		proc.kill();
		await proc.exited;
	}
	if (shuttingDown) return;
	summaryArmed = true;
	launch(buildChild("vite"));
}

// Backend first (ephemeral bind — cannot collide), vite once the proxy target
// port is known. A fatal resolution during this await = startup retries
// exhausted on a backend.
log(`mode: ${modeArg} — ${mode.open}`);

const backend = modeArg === "fleet" ? "fleet" : "session";
launch(buildChild(backend));
const boot = await Promise.race([waitReady(backend).then(() => null), fatalPromise]);
if (boot !== null) {
	log(`${boot.name} exited (${boot.code ?? "signal"}) during startup — shutting down`);
	await shutdown(boot.code ?? 1);
}

ports.vite = await pickFreePort();
if (modeArg !== "fleet") viteSessionPort = ports.session;
launch(buildChild("vite"));

if (host !== undefined) log(`vite listening on ${host}:${ports.vite} — the UI (and full agent control through it) is reachable from the network with no auth; trusted networks only`);
if (allowHosts !== undefined) log(`vite allowedHosts: ${allowHosts === "*" ? "all Host headers allowed" : allowHosts}`);

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

// First FATAL child (vite/fleet) to exit wins: tear the rest down and
// propagate its code. Restartable children (session) never reach this race.
const first = await fatalPromise;
log(`${first.name} exited (${first.code ?? "signal"}) — shutting down`);
await shutdown(first.code ?? 1);
