/**
 * omp-fleet CLI (Phase 2 headless control plane).
 *
 * `serve` runs the control plane in-process (foreground). Every other
 * subcommand is a thin loopback HTTP client against the control plane:
 *
 *   omp-fleet serve [--port n] [--workspace-dir d]
 *   omp-fleet sessions [--port n]
 *   omp-fleet projects [--port n]
 *   omp-fleet spawn <path> [--template t] [--name n] [--label k=v]…
 *   omp-fleet add-repo <path> [--start] [--template t] [--labels k=v,...]
 *   omp-fleet add <name> <url> --token <t> [--label k=v]… [--cwd c]
 *   omp-fleet provision <name> [--label k=v]…
 *   omp-fleet stop <selector>
 *   omp-fleet remove <selector>
 *   omp-fleet rm-project <selector>
 *   omp-fleet add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]
 *   omp-fleet add-worktree <project> --existing <path> [--no-start]
 *   omp-fleet rm-worktree <daemon-id> [--delete-branch]
 *   omp-fleet prompt <selector> <text> [--wait <ms>]
 *
 * Port resolution: `--port` flag, else OMP_FLEET_PORT, else 4722.
 * Managed-worktree root: `--workspace-dir` flag, else OMP_FLEET_WORKSPACE_DIR,
 * else the config-file `workspaceDir` key, else `~/.ompweb/workspaces`.
 * A refused connection prints "fleet not running — start it:
 * omp-fleet serve" and exits 1.
 */

import { realpathSync } from "node:fs";
import { LockHeldError } from "../shared/file-lock";
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

/** Flags that are bare booleans: presence = true (never consume a value); `--flag=true|false` also accepted. */
const BOOLEAN_FLAGS = new Set(["start", "no-start", "delete-branch"]);

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
				if (BOOLEAN_FLAGS.has(name)) {
					const value = arg.slice(eq + 1);
					if (value !== "true" && value !== "false")
						throw new CliError(`invalid value for --${name}: ${value}`);
					put(name, value === "true");
					continue;
				}
				put(name, arg.slice(eq + 1));
				continue;
			}
			// Bare boolean flags never consume the next argument (`--start /path`
			// must not eat the path as a value).
			if (BOOLEAN_FLAGS.has(name)) {
				put(name, true);
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

function flagBoolean(flags: Map<string, FlagValue>, name: string): boolean | undefined {
	const value = flags.get(name);
	return typeof value === "boolean" ? value : undefined;
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

/** `--labels k=v,a=b` (comma-joined single flag) → array; absent/empty → undefined. */
function labelsCsv(flags: Map<string, FlagValue>): string[] | undefined {
	const value = flagString(flags, "labels");
	if (value === undefined) return undefined;
	const labels = value
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label !== "");
	return labels.length > 0 ? labels : undefined;
}

/** Realpath of a CLI path argument, or null when it does not exist. */
function realpathOrNull(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
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
			body !== null &&
			typeof body === "object" &&
			typeof (body as { error?: unknown }).error === "string"
				? (body as { error: string }).error
				: `HTTP ${res.status}`;
		throw new CliError(`fleet error (${res.status}): ${message}`);
	}
	return body;
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, i) =>
		Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)),
	);
	const format = (cells: string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i]))
			.join("  ")
			.trimEnd();
	return [format(headers), ...rows.map(format)].join("\n");
}

function isDaemonRow(value: unknown): value is DaemonRow {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.daemonId === "string" &&
		typeof row.name === "string" &&
		typeof row.mode === "string" &&
		typeof row.status === "string"
	);
}

async function serveCmd(port: number, workspaceDir?: string): Promise<number> {
	// A second fleet on the same state file is a deterministic conflict, not
	// a retryable failure: report the live holder and exit 77.
	const server = await startFleet({ port, workspaceDir }).catch((err: unknown) => {
		if (err instanceof LockHeldError) {
			console.error(
				`fleet already running (pid ${err.holderPid}) — state locked at ${err.lockPath}`,
			);
			return null;
		}
		throw err;
	});
	if (server === null) return 77;
	// Startup banner: where the fleet listens, where its state/config live,
	// and what a previous fleet run left behind (boot statuses). The first
	// line keeps its exact shape — scripts parse the port out of it.
	console.log(`fleet listening on 127.0.0.1:${server.port}`);
	console.log(`fleet state: ${server.fleetFacts.statePath}`);
	console.log(`fleet config: ${server.fleetFacts.configPath ?? "(defaults)"}`);
	const restored = server.registry.list();
	const byStatus = new Map<string, number>();
	for (const entry of restored) byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
	const statusSummary = [...byStatus.entries()].map(([status, n]) => `${status}: ${n}`).join(", ");
	console.log(
		`fleet restored ${restored.length} session${restored.length === 1 ? "" : "s"}${statusSummary !== "" ? ` (${statusSummary})` : ""}`,
	);
	// Lifecycle events print as one human line per transition, enriched with
	// the live registry facts the message alone doesn't carry (status,
	// endpoint, pid).
	server.eventLog.onEntry = (entry) => {
		const daemon = entry.daemonId !== undefined ? server.registry.get(entry.daemonId) : undefined;
		const parts = [entry.daemonId, daemon?.name, entry.message].filter(
			(part): part is string => part !== undefined && part !== "",
		);
		let line = `fleet: ${parts.join(" ")}`;
		if (daemon) {
			// Connector transitions carry the status as the message itself;
			// other sources (exit/respawn/stop) get the live status appended.
			const details: string[] = [];
			if (daemon.status && daemon.status !== entry.message) details.push(daemon.status);
			if (daemon.endpoint) details.push(daemon.endpoint);
			if (daemon.pid !== undefined) details.push(`pid ${daemon.pid}`);
			if (details.length > 0) line += ` (${details.join(", ")})`;
		}
		console.log(line);
	};
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
		.map((entry) => [
			entry.daemonId,
			entry.name,
			entry.mode,
			entry.status,
			entry.project,
			entry.cwd ?? "",
			(entry.labels ?? []).join(","),
		]);
	console.log(renderTable(["id", "name", "mode", "status", "project", "cwd", "labels"], rows));
	return 0;
}

async function projectsCmd(port: number): Promise<number> {
	const body = (await ctl(port, "/ctl/projects")) as { projects?: unknown; registered?: unknown };
	if (!Array.isArray(body.projects)) throw new CliError("unexpected projects response");
	const rows = (body.projects as ProjectRow[]).map((p) => [
		p.name,
		p.path,
		p.branch ?? "",
		p.worktreeOf ?? "",
	]);
	console.log(renderTable(["name", "path", "branch", "worktreeOf"], rows));
	return 0;
}

async function spawnCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const cwd = positionals[0];
	if (cwd === undefined)
		throw new CliError("usage: omp-fleet spawn <path> [--template t] [--name n] [--label k=v]…");
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
	console.log(
		`spawned ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`,
	);
	return 0;
}

async function addRepoCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const path = positionals[0];
	if (path === undefined) {
		throw new CliError(
			"usage: omp-fleet add-repo <path> [--start] [--template t] [--labels k=v,...]",
		);
	}
	const body = (await ctl(port, "/ctl/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			path,
			start: flagBoolean(flags, "start"),
			template: flagString(flags, "template"),
			labels: labelsCsv(flags),
		}),
	})) as { project?: { projectId?: string; path?: string }; entry?: { daemonId?: string } };
	const project = body.project;
	const registered = `${project?.projectId ?? "?"} (${project?.path ?? path})`;
	if (body.entry?.daemonId !== undefined) {
		console.log(`registered ${registered} — spawned ${body.entry.daemonId}`);
	} else {
		console.log(`registered ${registered}`);
	}
	return 0;
}

async function rmProjectCmd(
	positionals: string[],
	_flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const selector = positionals[0];
	if (selector === undefined) {
		throw new CliError("usage: omp-fleet rm-project <selector> (projectId, realpath, or basename)");
	}
	// Resolve the selector client-side against the registered set: exact
	// projectId, exact realpath (or the selector's own realpath, so a
	// symlink/relative path still matches), or basename.
	const body = (await ctl(port, "/ctl/projects")) as {
		registered?: Array<{ projectId: string; path: string; name: string }>;
	};
	if (!Array.isArray(body.registered)) throw new CliError("unexpected projects response");
	const resolved = realpathOrNull(selector);
	const match = body.registered.find(
		(p) =>
			p.projectId === selector ||
			p.path === selector ||
			p.name === selector ||
			(resolved !== null && p.path === resolved),
	);
	if (match === undefined)
		throw new CliError(`no registered project matches selector: ${selector}`);
	const out = (await ctl(port, `/ctl/projects/${match.projectId}`, { method: "DELETE" })) as {
		removed?: unknown;
	};
	console.log(`removed project ${String(out.removed)}`);
	return 0;
}

/** Resolve a project selector (projectId, realpath, or basename) to its id. */
async function resolveProjectId(port: number, selector: string): Promise<string> {
	const body = (await ctl(port, "/ctl/projects")) as {
		registered?: Array<{ projectId: string; path: string; name: string }>;
	};
	if (!Array.isArray(body.registered)) throw new CliError("unexpected projects response");
	const resolved = realpathOrNull(selector);
	const match = body.registered.find(
		(p) =>
			p.projectId === selector ||
			p.path === selector ||
			p.name === selector ||
			(resolved !== null && p.path === resolved),
	);
	if (match === undefined)
		throw new CliError(`no registered project matches selector: ${selector}`);
	return match.projectId;
}

/**
 * add-worktree: create-new (`<project> <name>` with optional --base/--branch)
 * or add-existing (`<project> --existing <path>`). start defaults to ON
 * (--no-start disables); the server registers the roster entry and spawns
 * only when start is true.
 */
async function addWorktreeCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const project = positionals[0];
	const name = positionals[1];
	const existing = flagString(flags, "existing");
	if (project === undefined || (name === undefined) === (existing === undefined)) {
		throw new CliError(
			"usage: omp-fleet add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]\n" +
				"       omp-fleet add-worktree <project> --existing <path> [--no-start]",
		);
	}
	const projectId = await resolveProjectId(port, project);
	const start = flagBoolean(flags, "start") ?? !(flags.get("no-start") === true);
	const base = flagString(flags, "base");
	const branch = flagString(flags, "branch");
	const body = (await ctl(port, `/ctl/projects/${encodeURIComponent(projectId)}/worktrees`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(
			existing !== undefined
				? { worktreePath: existing, start }
				: { name, baseRef: base, existingBranch: branch, start },
		),
	})) as { entry?: { daemonId?: string; cwd?: string; status?: string } };
	const entry = body.entry ?? {};
	const where = String(entry.cwd ?? existing ?? name);
	if (existing !== undefined) {
		console.log(
			`registered worktree ${where} (${String(entry.daemonId ?? "?")})${start ? ` — status ${String(entry.status ?? "?")}` : " — not started"}`,
		);
	} else {
		console.log(
			`created worktree ${where} (${String(entry.daemonId ?? "?")})${start ? ` — status ${String(entry.status ?? "?")}` : " — not started"}`,
		);
	}
	return 0;
}

/** rm-worktree <daemon-id> [--delete-branch]: stop + evict + git worktree remove. */
async function rmWorktreeCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const daemonId = positionals[0];
	if (daemonId === undefined)
		throw new CliError("usage: omp-fleet rm-worktree <daemon-id> [--delete-branch]");
	const deleteBranch = flagBoolean(flags, "delete-branch");
	const body = (await ctl(port, `/ctl/worktrees/${encodeURIComponent(daemonId)}`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(deleteBranch === true ? { deleteBranch: true } : {}),
	})) as { removed?: unknown; worktree?: { path?: string; branch?: string } };
	const wt = body.worktree ?? {};
	const parts = [
		String(wt.path ?? ""),
		wt.branch !== undefined ? `branch ${wt.branch}` : "",
	].filter((part) => part !== "");
	console.log(
		`removed worktree daemon ${String(body.removed ?? daemonId)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
	);
	return 0;
}

async function addCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
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
	console.log(
		`added ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`,
	);
	return 0;
}

async function provisionCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
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
	console.log(
		`provisioned ${String(body.daemonId)} (${String(body.name)}) — status ${String(body.status)}`,
	);
	return 0;
}

async function stopCmd(
	positionals: string[],
	_flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
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

async function removeCmd(
	positionals: string[],
	_flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
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

async function promptCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const selector = positionals[0];
	const text = positionals.slice(1).join(" ");
	if (selector === undefined || text === "") {
		throw new CliError("usage: omp-fleet prompt <selector> <text> [--wait <ms>]");
	}
	const waitValue = flags.get("wait");
	const waitMs = flagNumber(flags, "wait");
	if (waitValue !== undefined && waitMs === undefined) {
		throw new CliError(
			"usage: prompt <selector> <text> [--wait <ms>] — --wait requires a millisecond value",
		);
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
  add-repo <path> [--start] [--template t] [--labels k=v,...]
  add <name> <url> --token <t> [--label k=v]… [--cwd c]
  provision <name> [--label k=v]…
  stop <selector>
  remove <selector>
  rm-project <selector>
  add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]
  add-worktree <project> --existing <path> [--no-start]
  rm-worktree <daemon-id> [--delete-branch]
  prompt <selector> <text> [--wait <ms>]

options:
  --port <n>           control plane port (default 4722, env OMP_FLEET_PORT)
  --workspace-dir <d>  managed worktree root (default ~/.ompweb/workspaces,
                       env OMP_FLEET_WORKSPACE_DIR)`;

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
				return await serveCmd(port, flagString(flags, "workspace-dir"));
			case "sessions":
				return await sessionsCmd(port);
			case "projects":
				return await projectsCmd(port);
			case "spawn":
				return await spawnCmd(rest, flags, port);
			case "add-repo":
				return await addRepoCmd(rest, flags, port);
			case "add":
				return await addCmd(rest, flags, port);
			case "provision":
				return await provisionCmd(rest, flags, port);
			case "stop":
				return await stopCmd(rest, flags, port);
			case "remove":
				return await removeCmd(rest, flags, port);
			case "rm-project":
				return await rmProjectCmd(rest, flags, port);
			case "add-worktree":
				return await addWorktreeCmd(rest, flags, port);
			case "rm-worktree":
				return await rmWorktreeCmd(rest, flags, port);
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
