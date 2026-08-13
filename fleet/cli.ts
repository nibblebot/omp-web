/**
 * omp-fleet CLI (Phase 2 headless control plane).
 *
 * `serve` runs the control plane in-process (foreground). Every other
 * subcommand is a thin loopback HTTP client against the control plane:
 *
 *   omp-fleet serve [--port n]
 *   omp-fleet sessions [--port n]
 *   omp-fleet projects [--port n]
 *   omp-fleet spawn <path> [--template t] [--name n] [--label k=v]…
 *   omp-fleet add <name> <url> --token <t> [--label k=v]… [--cwd c]
 *   omp-fleet provision <name> [--label k=v]…
 *   omp-fleet stop <selector>
 *   omp-fleet remove <selector>
 *   omp-fleet prompt <selector> <text> [--wait <ms>]
 *
 * Port resolution: `--port` flag, else OMP_FLEET_PORT, else 4722.
 * A refused connection prints "fleet not running — start it:
 * omp-fleet serve" and exits 1.
 */

import { startFleet } from "./server";

const DEFAULT_PORT = 4722;
const NOT_RUNNING_MESSAGE = "fleet not running — start it: omp-fleet serve";

/** Wire shapes the CLI renders (subsets of RegistryEntry / ProjectEntry). */
interface DaemonRow {
	daemonId: string;
	name: string;
	mode: string;
	status: string;
	project: string;
	cwd?: string;
	labels?: string[];
}
interface ProjectRow {
	name: string;
	path: string;
	branch?: string;
	worktreeOf?: string;
}

/** A user-facing CLI failure (bad flags, refused connection, server error). */
class CliError extends Error {}

type FlagValue = string | boolean | string[];
interface ParsedArgs {
	positionals: string[];
	flags: Map<string, FlagValue>;
}

/** Flags that repeat and accumulate (each occurrence appends). */
const MULTI_FLAGS = new Set(["label"]);

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, FlagValue>();
	const put = (name: string, value: string | boolean) => {
		if (MULTI_FLAGS.has(name)) {
			const existing = flags.get(name);
			if (Array.isArray(existing)) existing.push(value as string);
			else flags.set(name, [value as string]);
		} else {
			flags.set(name, value);
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
			if (eq >= 0) {
				put(name, arg.slice(eq + 1));
				continue;
			}
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("-")) {
				// #26: a missing value, or a value that looks like a flag
				// (e.g. --wait -1), was silently converted to a boolean true
				// and dropped by flagString/flagNumber. A non-multi flag with
				// no usable value is a user error — say so instead of
				// silently ignoring it. Multi flags keep the legacy leniency.
				if (MULTI_FLAGS.has(name)) {
					put(name, true);
				} else if (next === undefined) {
					throw new CliError(`missing value for --${name}`);
				} else {
					throw new CliError(`invalid value for --${name}: ${next}`);
				}
				continue;
			}
			put(name, next);
			i++;
		} else {
			positionals.push(arg);
		}
	}
	return { positionals, flags };
}

function flagString(flags: Map<string, FlagValue>, name: string): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Map<string, FlagValue>, name: string): number | undefined {
	const value = flags.get(name);
	if (typeof value !== "string") return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function labelList(flags: Map<string, FlagValue>): string[] | undefined {
	const value = flags.get("label");
	return Array.isArray(value) ? value : undefined;
}

function resolvePort(flags: Map<string, FlagValue>): number {
	const fromFlag = flagNumber(flags, "port");
	if (fromFlag !== undefined) {
		if (Number.isInteger(fromFlag) && fromFlag >= 0 && fromFlag <= 65535) return fromFlag;
		throw new CliError(`invalid --port: ${flags.get("port")}`);
	}
	const env = process.env.OMP_FLEET_PORT;
	if (env !== undefined && env !== "") {
		const n = Number(env);
		if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
		throw new CliError(`invalid OMP_FLEET_PORT: ${env}`);
	}
	return DEFAULT_PORT;
}

function isConnRefused(err: unknown): boolean {
	// Bun reports "ConnectionRefused" (fetch) while node-style sockets use
	// "ECONNREFUSED"; both mean the control plane isn't listening.
	const anyErr = err as { code?: unknown; cause?: { code?: unknown } };
	const code = anyErr?.code ?? anyErr?.cause?.code;
	return code === "ECONNREFUSED" || code === "ConnectionRefused";
}

/** Thin loopback client; throws {@link CliError} on refusal or non-2xx. */
async function ctl(port: number, path: string, init?: RequestInit): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${path}`, init);
	} catch (err) {
		if (isConnRefused(err)) throw new CliError(NOT_RUNNING_MESSAGE);
		throw new CliError(`request to ${path} failed: ${String(err)}`);
	}
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// Non-JSON body; fall through with null.
	}
	if (!res.ok) {
		const message =
			body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
				? (body as { error: string }).error
				: `HTTP ${res.status}`;
		throw new CliError(`fleet error (${res.status}): ${message}`);
	}
	return body;
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)));
	const format = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
	return [format(headers), ...rows.map(format)].join("\n");
}

function isDaemonRow(value: unknown): value is DaemonRow {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.daemonId === "string" && typeof row.name === "string" && typeof row.mode === "string" && typeof row.status === "string";
}

async function serveCmd(port: number): Promise<number> {
	const server = await startFleet({ port });
	console.log(`fleet listening on 127.0.0.1:${server.port}`);
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`fleet: ${signal}, shutting down`);
		try {
			await server.close();
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	await new Promise<void>(() => {});
	return 0;
}

async function sessionsCmd(port: number): Promise<number> {
	const body = await ctl(port, "/ctl/sessions");
	if (!Array.isArray(body)) throw new CliError("unexpected sessions response");
	const rows = (body as unknown[])
		.filter(isDaemonRow)
		.map((entry) => [entry.daemonId, entry.name, entry.mode, entry.status, entry.project, entry.cwd ?? "", (entry.labels ?? []).join(",")]);
	console.log(renderTable(["id", "name", "mode", "status", "project", "cwd", "labels"], rows));
	return 0;
}

async function projectsCmd(port: number): Promise<number> {
	const body = await ctl(port, "/ctl/projects");
	if (!Array.isArray(body)) throw new CliError("unexpected projects response");
	const rows = (body as unknown[]).map((project) => {
		const p = project as ProjectRow;
		return [p.name, p.path, p.branch ?? "", p.worktreeOf ?? ""];
	});
	console.log(renderTable(["name", "path", "branch", "worktreeOf"], rows));
	return 0;
}

async function spawnCmd(positionals: string[], flags: Map<string, FlagValue>, port: number): Promise<number> {
	const cwd = positionals[0];
	if (cwd === undefined) throw new CliError("usage: omp-fleet spawn <path> [--template t] [--name n] [--label k=v]…");
	const body = (await ctl(port, "/ctl/spawn", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			cwd,
			template: flagString(flags, "template"),
			name: flagString(flags, "name"),
			labels: labelList(flags),
		}),
	})) as Record<string, unknown>;
	console.log(`spawned ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`);
	return 0;
}

async function addCmd(positionals: string[], flags: Map<string, FlagValue>, port: number): Promise<number> {
	const name = positionals[0];
	const url = positionals[1];
	const token = flagString(flags, "token");
	if (name === undefined || url === undefined) {
		throw new CliError("usage: omp-fleet add <name> <url> --token <t> [--label k=v]… [--cwd c]");
	}
	const body = (await ctl(port, "/ctl/add", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			url,
			token,
			labels: labelList(flags),
			cwd: flagString(flags, "cwd"),
		}),
	})) as Record<string, unknown>;
	console.log(`added ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`);
	return 0;
}

async function provisionCmd(positionals: string[], flags: Map<string, FlagValue>, port: number): Promise<number> {
	const name = positionals[0];
	if (name === undefined) {
		throw new CliError("usage: omp-fleet provision <name> [--label k=v]…");
	}
	const body = (await ctl(port, "/ctl/provision", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			labels: labelList(flags),
		}),
	})) as Record<string, unknown>;
	console.log(`provisioned ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`);
	return 0;
}

async function stopCmd(positionals: string[], _flags: Map<string, FlagValue>, port: number): Promise<number> {
	const selector = positionals[0];
	if (selector === undefined) throw new CliError("usage: omp-fleet stop <selector>");
	const body = (await ctl(port, "/ctl/stop", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ selector }),
	})) as { stopped?: unknown };
	if (!Array.isArray(body.stopped)) throw new CliError("unexpected stop response");
	console.log(`stopped ${(body.stopped as string[]).join(", ")}`);
	return 0;
}

async function removeCmd(positionals: string[], _flags: Map<string, FlagValue>, port: number): Promise<number> {
	const selector = positionals[0];
	if (selector === undefined) throw new CliError("usage: omp-fleet remove <selector>");
	const body = (await ctl(port, "/ctl/remove", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ selector }),
	})) as { removed?: unknown };
	if (!Array.isArray(body.removed)) throw new CliError("unexpected remove response");
	console.log(`removed ${(body.removed as string[]).join(", ")}`);
	return 0;
}

interface PromptResultRow {
	daemonId: string;
	ok: boolean;
	text?: string;
	error?: string;
}

async function promptCmd(positionals: string[], flags: Map<string, FlagValue>, port: number): Promise<number> {
	const selector = positionals[0];
	const text = positionals.slice(1).join(" ");
	if (selector === undefined || text === "") {
		throw new CliError("usage: omp-fleet prompt <selector> <text> [--wait <ms>]");
	}
	const waitValue = flags.get("wait");
	const waitMs = flagNumber(flags, "wait");
	if (waitValue !== undefined && waitMs === undefined) {
		throw new CliError("usage: prompt <selector> <text> [--wait <ms>] — --wait requires a millisecond value");
	}
	if (waitMs === undefined) {
		// Fire-and-forget: server dispatches without awaiting the turn.
		const body = (await ctl(port, "/ctl/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ selector, text }),
		})) as { submitted?: unknown };
		if (!Array.isArray(body.submitted)) throw new CliError("unexpected prompt response");
		console.log(`submitted to ${(body.submitted as string[]).join(", ")}`);
		return 0;
	}
	const body = await ctl(port, "/ctl/prompt", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ selector, text, waitMs }),
	});
	if (!Array.isArray(body)) throw new CliError("unexpected prompt response");
	for (const result of body as PromptResultRow[]) {
		console.log(`== ${result.daemonId} ==`);
		if (result.ok) console.log(result.text ?? "");
		else console.log(`error: ${result.error ?? "unknown error"}`);
	}
	return 0;
}

const USAGE = `usage: omp-fleet <command> [options]

commands:
  serve                        run the control plane (loopback HTTP)
  sessions                     list sessions
  projects                     list discovered projects
  spawn <path> [--template t] [--name n] [--label k=v]…
  add <name> <url> --token <t> [--label k=v]… [--cwd c]
  provision <name> [--label k=v]…
  stop <selector>
  remove <selector>
  prompt <selector> <text> [--wait <ms>]

options:
  --port <n>   control plane port (default 4722, env OMP_FLEET_PORT)`;

export async function main(argv: string[]): Promise<number> {
	try {
		const { positionals, flags } = parseArgs(argv);
		const port = resolvePort(flags);
		const command = positionals[0];
		const rest = positionals.slice(1);
		switch (command) {
			case undefined:
			case "":
			case "help":
				console.log(USAGE);
				return 0;
			case "serve":
				return await serveCmd(port);
			case "sessions":
				return await sessionsCmd(port);
			case "projects":
				return await projectsCmd(port);
			case "spawn":
				return await spawnCmd(rest, flags, port);
			case "add":
				return await addCmd(rest, flags, port);
			case "provision":
				return await provisionCmd(rest, flags, port);
			case "stop":
				return await stopCmd(rest, flags, port);
			case "remove":
				return await removeCmd(rest, flags, port);
			case "prompt":
				return await promptCmd(rest, flags, port);
			default:
				console.error(`unknown command: ${command}`);
				console.error(USAGE);
				return 1;
		}
	} catch (err) {
		if (err instanceof CliError) {
			console.error(err.message);
			return 1;
		}
		throw err;
	}
}

if (import.meta.main) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
