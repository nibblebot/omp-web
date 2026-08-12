#!/usr/bin/env bun
/**
 * dev — one-command dev runner.
 *
 *   bun run dev          single-session mode: omp-session (:4721, --watch) + vite (:4713 HMR)
 *   bun run dev:fleet    fleet mode: vite (:4713 HMR, /ws proxied to omp-fleet) + omp-fleet
 *                        (:4722) + an omp-session (:4721) auto-registered into the roster as "dev"
 *
 *   --host [addr]        bind vite to addr (default 0.0.0.0) for LAN access; backends stay
 *                        loopback — remote browsers reach them through vite's proxies.
 *                        No auth on the UI: trusted networks only.
 *   --allow-hosts [csv]  vite allowedHosts: bare = allow every Host header (tailscale
 *                        domains etc.), or a comma-separated allowlist.
 *
 * Child output is line-prefixed ([session] [vite] [fleet]); the runner's
 * own messages use [dev]. Ctrl-C (or any child exiting) tears down the rest.
 */

import type { Subprocess } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SESSION_URL = "ws://127.0.0.1:4721";
const FLEET_HTTP = "http://127.0.0.1:4722";

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
			// OMP_DEV_FLEET switches vite's /ws + /download proxy to omp-fleet
			// (:4722), so the roster UI runs with HMR — no dist/ build needed.
			{ name: "vite", cmd: ["bunx", "vite"], env: { OMP_DEV_FLEET: "1" } },
			{ name: "fleet", cmd: ["bun", "fleet/cli.ts", "serve"] },
			{ name: "session", cmd: ["bun", "--watch", "server/index.ts"] },
		],
		open: 'open http://localhost:4713 (roster UI with HMR; dev session auto-attached as "dev")',
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

function log(message: string): void {
	process.stdout.write(`[dev] ${message}\n`);
}

/** Forward a piped stream with a per-line `[name] ` prefix. */
async function pipePrefixed(stream: ReadableStream<Uint8Array>, name: string, out: NodeJS.WriteStream): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		let nl = pending.indexOf("\n");
		while (nl !== -1) {
			out.write(`[${name}] ${pending.slice(0, nl)}\n`);
			pending = pending.slice(nl + 1);
			nl = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) out.write(`[${name}] ${pending}\n`);
}

/**
 * Fleet mode: wait for omp-fleet's control API, then register the dev
 * omp-session unless an entry for its endpoint already exists (remote entries
 * persist across fleet restarts, so this must not pile up duplicates).
 */
async function registerDevSession(): Promise<void> {
	while (!shuttingDown) {
		try {
			const res = await fetch(`${FLEET_HTTP}/ctl/sessions`);
			if (res.ok) {
				const sessions = (await res.json()) as Array<{ endpoint?: string }>;
				if (sessions.some((s) => s.endpoint === SESSION_URL)) {
					log(`dev session already in roster (${SESSION_URL})`);
					return;
				}
				const add = await fetch(`${FLEET_HTTP}/ctl/add`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "dev", url: SESSION_URL, cwd: ROOT }),
				});
				if (add.ok) {
					const entry = (await add.json()) as { daemonId?: string };
					log(`attached dev session to roster (${entry.daemonId ?? "?"})`);
				} else {
					log(`attach failed (${add.status}): ${await add.text()}`);
				}
				return;
			}
		} catch {
			// fleet not listening yet
		}
		await Bun.sleep(250);
	}
}

if (host !== undefined) {
	// Expose vite only: the /ws, /download, /ctl proxies run server-side, so
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

const procs: Subprocess[] = [];
for (const child of mode.children) {
	const proc = Bun.spawn(child.cmd, { cwd: ROOT, env: { ...process.env, ...child.env }, stdout: "pipe", stderr: "pipe" });
	procs.push(proc);
	void pipePrefixed(proc.stdout, child.name, process.stdout);
	void pipePrefixed(proc.stderr, child.name, process.stderr);
}

log(`mode: ${modeArg} — ${mode.open}`);
if (host !== undefined) log(`vite listening on ${host}:4713 — the UI (and full agent control through it) is reachable from the network with no auth; trusted networks only`);
if (allowHosts !== undefined) log(`vite allowedHosts: ${allowHosts === "*" ? "all Host headers allowed" : allowHosts}`);
if (modeArg === "fleet") void registerDevSession();

async function shutdown(code: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const proc of procs) proc.kill();
	await Promise.all(procs.map((proc) => proc.exited));
	process.exit(code);
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

// First child to exit wins: tear the rest down and propagate its code.
const first = await Promise.race(procs.map(async (proc) => ({ code: await proc.exited })));
await shutdown(first.code ?? 1);
