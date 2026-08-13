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
 * and NOT echoed — machine noise; fleet: the control API responding, surfaced
 * from the probeFleetReady poll). Every transition to ready logs one
 * `✓ <name> ready` runner line; once every child in the mode has been ready
 * at least once, a compact stack summary is printed once per full readiness
 * (re-armed when a session restart brings the stack back). Ctrl-C (or
 * vite/fleet exiting) tears down the rest. The omp-session child is
 * different: idle exit is a FEATURE (no attached clients → clean shutdown),
 * so a session exit just restarts it with backoff — it never nukes the
 * stack.
 */

import type { Subprocess } from "bun";
import { join } from "node:path";
import { OMP_SESSION_PREFIX } from "../shared/protocol";

const ROOT = join(import.meta.dir, "..");
const FLEET_HTTP = "http://127.0.0.1:4722";
const FLEET_PORT = Number(new URL(FLEET_HTTP).port);
/** Fallbacks for readiness that arrives without a parseable port. */
const VITE_PORT_DEFAULT = 4713;
const SESSION_PORT_DEFAULT = 4721;

interface Child {
	name: string;
	cmd: string[];
	env?: Record<string, string>;
}

const MODES: Record<string, { children: Child[]; open: string }> = {
	session: {
		children: [
			{ name: "session", cmd: ["bun", "--watch", "server/index.ts"] },
			{ name: "vite", cmd: ["bunx", "vite"] },
		],
		open: "open http://localhost:4713 (UI with HMR; omp-session on :4721)",
	},
	fleet: {
		children: [
			// OMP_DEV_FLEET switches vite's /events + /command + /download proxy to omp-fleet
			// (:4722), so the roster UI runs with HMR — no dist/ build needed.
			{ name: "vite", cmd: ["bunx", "vite"], env: { OMP_DEV_FLEET: "1" } },
			{
				name: "fleet",
				cmd: ["bun", "fleet/cli.ts", "serve"],
				env: {
					// Sidebar spawns use the default `local` template, which runs the
					// production `omp-session` binary — not built in dev. Point it at
					// the source entry instead (absolute: spawned children inherit
					// the fleet's cwd, and the repo isn't necessarily it).
					OMP_FLEET_LOCAL_TEMPLATE: `bun ${join(ROOT, "server", "index.ts")} --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}`,
				},
			},
			// No session child: attaching is a deliberate UI action (spawn/add
			// from the roster sidebar), never a dev-runner default.
		],
		open: "open http://localhost:4713 (roster UI with HMR; spawn/add a session from the sidebar)",
	},
};

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

function markReady(name: string, port: number, detail: string): void {
	const st = states.get(name);
	if (st === undefined || st.status === "ready") return;
	st.status = "ready";
	st.port = port;
	st.readyOnce = true;
	log(`✓ ${name} ready — ${detail} (pid ${st.pid})`);
	checkSummary();
}

function checkSummary(): void {
	if (!summaryArmed) return;
	for (const child of mode.children) {
		const st = states.get(child.name);
		if (st === undefined || !st.readyOnce) return;
	}
	summaryArmed = false;
	const fleetMode = modeArg === "fleet";
	const uiPort = states.get("vite")?.port ?? VITE_PORT_DEFAULT;
	log("stack ready");
	log(
		`  ${"ui".padEnd(9)}http://localhost:${uiPort}  ${
			fleetMode ? "(vite, HMR, proxies /events /command /ctl → fleet)" : "(vite, HMR, proxies /events /command → session)"
		}`,
	);
	if (fleetMode) {
		const fleetPort = states.get("fleet")?.port ?? FLEET_PORT;
		log(`  ${"fleet".padEnd(9)}http://127.0.0.1:${fleetPort}  (control plane + edge)`);
		log("  no session attached — spawn/add one from the roster sidebar");
	} else {
		const sessionPort = states.get("session")?.port ?? SESSION_PORT_DEFAULT;
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
 * watch for its `Local:` line. Fleet needs no hook: its readiness is probed by
 * probeFleetReady (control API answering).
 */
function stdoutHook(name: string): ((line: string) => string | false | void) | undefined {
	if (name === "session") {
		return (line) => {
			if (!line.startsWith(OMP_SESSION_PREFIX)) return;
			let port = SESSION_PORT_DEFAULT;
			try {
				const parsed = JSON.parse(line.slice(OMP_SESSION_PREFIX.length)) as { event?: string; port?: number };
				if (typeof parsed.port === "number") port = parsed.port;
			} catch {
				// not parseable — readiness still happened, keep the default port
			}
			markReady("session", port, `dev session on ws://127.0.0.1:${port}`);
			return false;
		};
	}
	if (name === "vite") {
		return (line) => {
			const m = line.replace(ANSI_RE, "").match(/Local:\s+http:\/\/localhost:(\d+)/);
			if (m) markReady("vite", Number(m[1]), `ui on http://localhost:${m[1]}`);
		};
	}
	return undefined;
}

/**
 * Fleet mode: poll omp-fleet's control API until it answers — that first
 * successful poll is fleet's readiness signal. Nothing is registered: adding
 * a session is a deliberate UI action, not a dev-runner default.
 */
async function probeFleetReady(): Promise<void> {
	while (!shuttingDown) {
		try {
			const res = await fetch(`${FLEET_HTTP}/ctl/sessions`);
			if (res.ok) {
				markReady("fleet", FLEET_PORT, `control+edge on ${FLEET_HTTP}`);
				return;
			}
		} catch {
			// fleet not listening yet
		}
		await Bun.sleep(250);
	}
}

if (host !== undefined) {
	// Expose vite only: the /events, /command, /download, /ctl proxies run server-side, so
	// remote browsers reach the loopback backends through vite. omp-session
	// hard-requires --token off-loopback and the fleet edge is loopback-only
	// by design — neither needs to change.
	for (const child of mode.children) {
		if (child.name === "vite") child.cmd.push("--host", host);
	}
}
if (allowHosts !== undefined) {
	for (const child of mode.children) {
		if (child.name === "vite") child.env = { ...child.env, OMP_DEV_ALLOW_HOSTS: allowHosts };
	}
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
const fatalExits: Promise<{ name: string; code: number | null }>[] = [];
let restartBackoffMs = RESTART_BACKOFF_MIN_MS;

function launch(child: Child): void {
	const proc = Bun.spawn(child.cmd, { cwd: ROOT, env: { ...process.env, ...child.env }, stdout: "pipe", stderr: "pipe" });
	procs.set(child.name, proc);
	states.set(child.name, { name: child.name, status: "starting", pid: proc.pid, readyOnce: false });
	void pipePrefixed(proc.stdout, child.name, process.stdout, stdoutHook(child.name));
	void pipePrefixed(proc.stderr, child.name, process.stderr);
	if (RESTARTABLE[child.name] === true) {
		const startedAt = Date.now();
		void proc.exited.then((code) => {
			procs.delete(child.name);
			if (shuttingDown) return;
			const st = states.get(child.name);
			if (st !== undefined) st.status = "restarting";
			// A restart re-arms the summary: it reprints once the stack is
			// fully ready again (ports/pids from the fresh process).
			summaryArmed = true;
			if (Date.now() - startedAt > RESTART_RESET_AFTER_MS) restartBackoffMs = RESTART_BACKOFF_MIN_MS;
			const delay = restartBackoffMs;
			restartBackoffMs = Math.min(restartBackoffMs * 2, RESTART_BACKOFF_MAX_MS);
			log(`${child.name} exited (${code ?? "signal"}) — idle exit is expected; restarting in ${delay / 1000}s (the rest of the stack stays up)`);
			setTimeout(() => {
				if (!shuttingDown) launch(child);
			}, delay);
		});
	} else {
		fatalExits.push(
			proc.exited.then((code) => {
				const st = states.get(child.name);
				if (st !== undefined) st.status = "exited";
				return { name: child.name, code };
			}),
		);
	}
}

for (const child of mode.children) launch(child);

log(`mode: ${modeArg} — ${mode.open}`);
if (host !== undefined) log(`vite listening on ${host}:4713 — the UI (and full agent control through it) is reachable from the network with no auth; trusted networks only`);
if (allowHosts !== undefined) log(`vite allowedHosts: ${allowHosts === "*" ? "all Host headers allowed" : allowHosts}`);
if (modeArg === "fleet") void probeFleetReady();

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
const first = await Promise.race(fatalExits);
log(`${first.name} exited (${first.code ?? "signal"}) — shutting down`);
await shutdown(first.code ?? 1);
