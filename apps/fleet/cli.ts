/**
 * omp-web fleet CLI (headless control plane), reached as `omp-web <verb>`
 * (apps/cli/omp-web.ts routes here) or `bun apps/fleet/cli.ts <verb>`.
 *
 * Bare `omp-web` (no verb, flags allowed) runs the control plane and the UI
 * on one port (foreground). `control` runs the control plane alone; `ui` runs
 * the UI daemon (static UI plus a reverse proxy to the control plane) on its
 * own port. `help` prints usage. Every other subcommand is a thin loopback
 * HTTP client against the control plane:
 *
 *   omp-web [--port n] [--workspace-dir d] [--bind addr]
 *                     [--browser-access-token t] [--browser-origin o]
 *                     [--trusted-proxy ip-or-cidr]… [--no-open] [--verbose]
 *   omp-web control [--port n] [--workspace-dir d] [--bind addr]
 *                     [--browser-access-token t] [--browser-origin o]
 *                     [--trusted-proxy ip-or-cidr]… [--verbose]
 *   omp-web ui [--port n] [--control-port n] [--browser-origin o] [--no-open]
 *   omp-web sessions [--port n]
 *   omp-web projects [--port n]
 *   omp-web profiles [--port n]
 *   omp-web spawn <path> [--template t] [--name n] [--label k=v]…
 *   omp-web add-repo <path> [--start] [--template t] [--labels k=v,...]
 *   omp-web add-clone <project> <name> --profile <id>
 *                        [--local path | --remote url] [--revision rev]
 *                        [--branch b] [--no-start]
 *   omp-web start <selector>
 *   omp-web stop <selector>
 *   omp-web remove <selector>
 *   omp-web rm-project <selector>
 *   omp-web add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]
 *   omp-web rm-worktree <daemon-id> [--delete-branch <name>]
 *   omp-web prompt <selector> <text> [--wait <ms>]
 *
 * Port resolution: `--port` flag, else OMP_FLEET_PORT, else 4722. For `ui`,
 * `--port` is the UI listen port (default 4723; OMP_FLEET_PORT does not apply)
 * and `--control-port` (else OMP_FLEET_PORT, else 4722) names the control plane.
 * Default worktree directory: `--workspace-dir` flag, else OMP_FLEET_WORKSPACE_DIR,
 * else the config-file `workspaceDir` key, else `~/.omp-web/workspaces`.
 * Bind address / browser auth: `--bind`, `--browser-access-token`,
 * `--browser-origin`, and `--trusted-proxy` flags, else OMP_FLEET_BIND /
 * OMP_FLEET_BROWSER_TOKEN / OMP_FLEET_BROWSER_ORIGIN / (OMP_FLEET_TRUSTED_PROXY
 * csv), else the config-file keys (see fleet/config.ts). `ui` and the control
 * plane both read the browser origin: set the same value on each (flag, env,
 * or config) when a reverse proxy serves the UI on a public origin.
 * A refused connection prints NOT_RUNNING_MESSAGE and exits 1.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { LockHeldError } from "#lib/platform/file-lock";
import { isInteractiveDesktop, openBrowser } from "#lib/platform/open-browser";
import { loadConfig, resolveConfigPath } from "./config";
import { offerFirstRunSetup } from "./first-run";
import { DEFAULT_PORT, resolveStatePath, startFleet, type FleetServer } from "./server";
import { runProfilePreflight } from "./preflight";
import { DEFAULT_UI_PORT, startUiServer, type UiServer } from "./ui-server";

const NOT_RUNNING_MESSAGE = "omp-web not running. Start it: omp-web";

/** Wire shapes the CLI renders (subsets of RegistryEntry / RegisteredProject). */
interface DaemonRow {
	daemonId: string;
	name: string;
	projectId?: string;
	status: string;
	project: string;
	cwd?: string;
	labels?: string[];
}
interface ProjectRow {
	projectId: string;
	name: string;
	path: string;
	missing?: boolean;
}

/** Wire shape of GET /ctl/profiles entries (PublicProviderProfile; secret-free). */
interface ProfileRow {
	id: string;
	provider: string;
	resources?: { cpu?: string; memory?: string };
	network?: string;
	storageClassName?: string;
	secretRefNames?: string[];
}

/** A user-facing CLI failure (bad flags, refused connection, server error). */
class CliError extends Error {}

type FlagValue = string | boolean | string[];
interface ParsedArgs {
	positionals: string[];
	flags: Map<string, FlagValue>;
}

/** Flags that repeat and accumulate (each occurrence appends). */
const MULTI_FLAGS: Record<string, true> = { label: true, "trusted-proxy": true };

/** Flags that are bare booleans: presence = true (never consume a value); `--flag=true|false` also accepted. */
const BOOLEAN_FLAGS: Record<string, true> = {
	start: true,
	"no-start": true,
	"no-open": true,
	verbose: true,
	help: true,
};

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, FlagValue>();
	const put = (name: string, value: string | boolean) => {
		if (Object.hasOwn(MULTI_FLAGS, name)) {
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
				if (Object.hasOwn(BOOLEAN_FLAGS, name)) {
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
			if (Object.hasOwn(BOOLEAN_FLAGS, name)) {
				put(name, true);
				continue;
			}
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("-")) {
				// #26: a missing value, or a value that looks like a flag
				// (e.g. --wait -1), was silently converted to a boolean true
				// and dropped by flagString/flagNumber. Multi flags included:
				// a bare --trusted-proxy must never reach the security path
				// as a boolean (FPS-19).
				if (next === undefined) throw new CliError(`missing value for --${name}`);
				throw new CliError(`invalid value for --${name}: ${next}`);
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

/** Every `--trusted-proxy` occurrence (repeatable); each value may itself be
 *  comma-splittable; loadConfig splits occurrences, mirroring `label`. */
function trustedProxyList(flags: Map<string, FlagValue>): string[] | undefined {
	const value = flags.get("trusted-proxy");
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

/** `--<name> n` as a port (0-65535); undefined when the flag is absent or not a number. */
function portFlag(flags: Map<string, FlagValue>, name: string): number | undefined {
	const fromFlag = flagNumber(flags, name);
	if (fromFlag === undefined) return undefined;
	if (Number.isInteger(fromFlag) && fromFlag >= 0 && fromFlag <= 65535) return fromFlag;
	throw new CliError(`invalid --${name}: ${flags.get(name)}`);
}

/** OMP_FLEET_PORT as a port (0-65535); undefined when unset or empty. */
function envPort(): number | undefined {
	const env = process.env.OMP_FLEET_PORT;
	if (env === undefined || env === "") return undefined;
	const n = Number(env);
	if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
	throw new CliError(`invalid OMP_FLEET_PORT: ${env}`);
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
		typeof row.status === "string"
	);
}

async function serveCmd(
	port: number,
	workspaceDir: string | undefined,
	serveOpts: {
		bind?: string;
		browserAccessToken?: string;
		browserOrigin?: string;
		trustedProxy?: string[];
	},
	loop: ServeLoopOptions,
): Promise<number> {
	// First-run auto-offer: no config file + an interactive terminal → verify
	// the omp stack, then ask whether to configure omp-web before booting.
	const offerConfigPath = await offerFirstRunSetup(workspaceDir);
	// A second fleet on the same state file is a deterministic conflict, not
	// a retryable failure: report the live holder and exit 77.
	const server = await startFleet({
		port,
		workspaceDir,
		configPath: offerConfigPath,
		serveUi: loop.serveUi,
		...serveOpts,
	}).catch((err: unknown) => {
		if (err instanceof LockHeldError) {
			console.error(
				`fleet already running (pid ${err.holderPid}). State locked at ${err.lockPath}`,
			);
			return null;
		}
		throw err;
	});
	if (server === null) return 77;
	return serveLoop(server, loop);
}

/** How {@link serveLoop} presents a booted fleet. */
export interface ServeLoopOptions {
	/** False for `omp-web control` (no UI on this port). */
	serveUi: boolean;
	/** Print state/config paths and every lifecycle event, not only warn/error. */
	verbose: boolean;
	/** Open the browser at the UI after the ready line. */
	open: boolean;
}

/**
 * Run a booted fleet in the foreground: print the ready line, mirror
 * lifecycle events (warn/error only unless verbose) to stdout, and block until
 * SIGINT/SIGTERM (then close the server and exit 0). The first line keeps its
 * exact shape; scripts parse the port and session counts out of it.
 */
export async function serveLoop(server: FleetServer, opts: ServeLoopOptions): Promise<number> {
	const sessions = server.registry.list().length;
	const counts = `${sessions} session${sessions === 1 ? "" : "s"}`;
	const { bind } = server.fleetFacts;
	const host = bind === "127.0.0.1" || bind === "::1" || bind === "localhost" ? "localhost" : bind;
	console.log(
		`omp-web${opts.serveUi ? "" : " control"} listening on http://${host}:${server.port} (${counts})`,
	);
	if (opts.verbose) {
		console.log(`state: ${server.fleetFacts.statePath}`);
		console.log(`config: ${server.fleetFacts.configPath ?? "(defaults)"}`);
	}
	// Lifecycle events print as one line each (warn/error only unless
	// verbose); each stands on its message alone.
	server.eventLog.onEntry = (entry) => {
		if (!opts.verbose && entry.level === "info") return;
		const daemon = entry.daemonId !== undefined ? server.registry.get(entry.daemonId) : undefined;
		const parts = [entry.daemonId, daemon?.name, entry.message];
		const shown = parts.filter((part): part is string => part !== undefined && part !== "");
		console.log(`omp-web: ${shown.join(" ")}`);
	};
	if (opts.open) openBrowser(`http://localhost:${server.port}`, "omp-web");
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (opts.verbose) console.error(`omp-web: ${signal}, shutting down`);
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

/**
 * `omp-web ui`: the UI daemon (static UI + reverse proxy to the control
 * plane) in the foreground until SIGINT/SIGTERM. `port` is the UI listen
 * port; `controlPort` is where the control plane listens.
 */
async function uiCmd(
	port: number,
	controlPort: number,
	open: boolean,
	browserOrigin?: string,
): Promise<number> {
	let ui: UiServer;
	try {
		const config = await loadConfig(resolveConfigPath(), { browserOrigin });
		ui = startUiServer({ port, controlPort, browserOrigin: config.browserOrigin });
	} catch (err) {
		const code = (err as { code?: unknown } | null)?.code;
		const message = err instanceof Error ? err.message : String(err);
		if (code === "EADDRINUSE" || /EADDRINUSE|in use/i.test(message)) {
			throw new CliError(`omp-web ui: port ${port} is in use`);
		}
		throw err;
	}
	const url = `http://localhost:${ui.port}`;
	console.log(`omp-web ui listening on ${url} (control :${controlPort})`);
	// One probe: a UI started before its control plane keeps running (the
	// proxy answers once control is up), but say so instead of failing quietly.
	try {
		await fetch(`http://127.0.0.1:${controlPort}/ctl/sessions`, {
			signal: AbortSignal.timeout(1500),
		});
	} catch {
		console.error(`omp-web ui: no control plane on :${controlPort} yet`);
	}
	if (open) openBrowser(url, "omp-web");
	let closing = false;
	const shutdown = async () => {
		if (closing) return;
		closing = true;
		try {
			await ui.close();
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
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
			entry.status,
			entry.project,
			entry.cwd ?? "",
			(entry.labels ?? []).join(","),
		]);
	console.log(renderTable(["id", "name", "status", "project", "cwd", "labels"], rows));
	return 0;
}

async function projectsCmd(port: number): Promise<number> {
	const body = (await ctl(port, "/ctl/projects")) as { projects?: unknown };
	if (!Array.isArray(body.projects)) throw new CliError("unexpected projects response");
	const roster = await ctl(port, "/ctl/sessions");
	const worktrees = new Map<string, number>();
	if (Array.isArray(roster)) {
		for (const row of roster) {
			if (!isDaemonRow(row) || row.projectId === undefined) continue;
			worktrees.set(row.projectId, (worktrees.get(row.projectId) ?? 0) + 1);
		}
	}
	const rows = (body.projects as ProjectRow[]).map((p) => [
		p.projectId,
		p.name,
		p.path,
		String(worktrees.get(p.projectId) ?? 0),
		p.missing === true ? "yes" : "",
	]);
	console.log(renderTable(["id", "name", "path", "worktrees", "missing"], rows));
	return 0;
}

/** profiles: GET /ctl/profiles, the secret-free provider profile catalog. */
async function profilesCmd(port: number): Promise<number> {
	const body = (await ctl(port, "/ctl/profiles")) as { profiles?: unknown };
	if (!Array.isArray(body.profiles)) throw new CliError("unexpected profiles response");
	const profiles = body.profiles as ProfileRow[];
	if (profiles.length === 0) {
		console.log("no provider profiles configured (set providerProfiles in the fleet config)");
		return 0;
	}
	const rows = profiles.map((p) => [
		p.id,
		p.provider,
		p.resources?.cpu ?? "",
		p.resources?.memory ?? "",
		p.storageClassName ?? "",
		(p.secretRefNames ?? []).join(","),
		p.network ?? "",
	]);
	console.log(
		renderTable(["id", "provider", "cpu", "memory", "storage", "secrets", "network"], rows),
	);
	return 0;
}

async function spawnCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const cwd = positionals[0];
	if (cwd === undefined)
		throw new CliError("usage: omp-web spawn <path> [--template t] [--name n] [--label k=v]…");
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
		`spawned ${String(body.daemonId)} (${String(body.name)}), status ${String(body.status)}`,
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
			"usage: omp-web add-repo <path> [--start] [--template t] [--labels k=v,...]",
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
		console.log(`registered ${registered}, spawned ${body.entry.daemonId}`);
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
		throw new CliError("usage: omp-web rm-project <selector> (projectId, realpath, or basename)");
	}
	const projectId = await resolveProjectId(port, selector);
	const out = (await ctl(port, `/ctl/projects/${projectId}`, { method: "DELETE" })) as {
		removed?: unknown;
	};
	console.log(`removed project ${String(out.removed)}`);
	return 0;
}

/** Resolve a project selector (projectId, realpath, or basename) to its id. */
async function resolveProjectId(port: number, selector: string): Promise<string> {
	const body = (await ctl(port, "/ctl/projects")) as { projects?: unknown };
	if (!Array.isArray(body.projects)) throw new CliError("unexpected projects response");
	const resolved = realpathOrNull(selector);
	const match = (body.projects as ProjectRow[]).find(
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
 * add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]:
 * create a git worktree for the project. start defaults to ON (--no-start
 * disables); the server spawns only when start is true.
 */
async function addWorktreeCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const project = positionals[0];
	const name = positionals[1];
	if (project === undefined || name === undefined) {
		throw new CliError(
			"usage: omp-web add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]",
		);
	}
	const projectId = await resolveProjectId(port, project);
	const start = flagBoolean(flags, "start") ?? !(flags.get("no-start") === true);
	const base = flagString(flags, "base");
	const branch = flagString(flags, "branch");
	const body = (await ctl(port, `/ctl/projects/${encodeURIComponent(projectId)}/worktrees`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, baseRef: base, existingBranch: branch, start }),
	})) as { entry?: { daemonId?: string; cwd?: string; status?: string } };
	const entry = body.entry ?? {};
	console.log(
		`created worktree ${String(entry.cwd ?? name)} (${String(entry.daemonId ?? "?")})${start ? `, status ${String(entry.status ?? "?")}` : ", not started"}`,
	);
	return 0;
}

/**
 * add-clone <project> <name> --profile <id> [--local path | --remote url]
 * [--revision rev] [--branch b] [--no-start]: create an independent clone
 * workspace via POST /ctl/clones (P8.7). The source has exactly one member
 * when given; an omitted source defaults server-side to the registered
 * project's local path. Clone revision input is `revision` (never baseRef).
 * start defaults to ON (--no-start disables), mirroring add-worktree.
 */
async function addCloneCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const project = positionals[0];
	const name = positionals[1];
	const profileId = flagString(flags, "profile");
	const local = flagString(flags, "local");
	const remote = flagString(flags, "remote");
	if (
		project === undefined ||
		name === undefined ||
		profileId === undefined ||
		(local !== undefined && remote !== undefined)
	) {
		throw new CliError(
			"usage: omp-web add-clone <project> <name> --profile <id>\n" +
				"       [--local path | --remote url] [--revision rev] [--branch b] [--no-start]",
		);
	}
	const projectId = await resolveProjectId(port, project);
	const start = flagBoolean(flags, "start") ?? !(flags.get("no-start") === true);
	const source = local !== undefined ? { local } : remote !== undefined ? { remote } : undefined;
	const body = (await ctl(port, "/ctl/clones", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			name,
			profileId,
			...(source !== undefined ? { source } : {}),
			revision: flagString(flags, "revision"),
			branch: flagString(flags, "branch"),
			start,
		}),
	})) as { entry?: { daemonId?: string; cwd?: string; status?: string; lifecycleStage?: string } };
	const entry = body.entry ?? {};
	const where = String(entry.cwd ?? name);
	const stage = entry.lifecycleStage !== undefined ? ` ${entry.lifecycleStage}` : "";
	console.log(
		`created clone ${where} (${String(entry.daemonId ?? "?")})${start ? `, status ${String(entry.status ?? "?")}${stage}` : ", not started"}`,
	);
	return 0;
}

/**
 * preflight --profile <id>: local (no control-plane RPC) production-profile
 * preflight (P5.6). Loads the config file exactly like the server does (env
 * OMP_FLEET_CONFIG honored), runs the apps/fleet/preflight.ts battery against the
 * profile (the fleet's host rows plus the rows the provider executable
 * reports through its `preflight` op), prints one line per check with
 * remediation on failures, and exits non-zero when any check fails.
 * Additive: profile configs are optional, so a fleet with none is untouched.
 */
async function preflightCmd(flags: Map<string, FlagValue>): Promise<number> {
	const profileId = flagString(flags, "profile");
	if (profileId === undefined) {
		throw new CliError("usage: omp-web preflight --profile <id>");
	}
	const configPath = resolveConfigPath();
	const config = await loadConfig(configPath);
	const profile = config.providerProfiles?.[profileId];
	if (profile === undefined) {
		throw new CliError(
			`no provider profile "${profileId}" in ${configPath}: configure providerProfiles."${profileId}" first`,
		);
	}
	const dataHome = dirname(resolveStatePath(undefined, configPath));
	const result = await runProfilePreflight(profile, {
		workspaceRoot: join(dataHome, "clones"),
		logsRoot: join(dataHome, "logs"),
		// A callback URL is only reachability-class-checked once the fleet
		// has one to pass.
	});
	const lines: string[] = [`profile ${profile.id}: ${result.ok ? "ready" : "NOT ready"}`];
	for (const check of result.checks) {
		lines.push(`  [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}`);
		if (!check.ok && check.remediation !== undefined) {
			lines.push(`      fix: ${check.remediation}`);
		}
	}
	console.log(lines.join("\n"));
	return result.ok ? 0 : 1;
}

/** rm-worktree <daemon-id> [--delete-branch <name>]: stop + evict + git worktree
 *  remove (worktree kind), or the verify-at-deletion gate for clone
 *  workspaces (same DELETE route; the server dispatches by kind). */
async function rmWorktreeCmd(
	positionals: string[],
	flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const daemonId = positionals[0];
	if (daemonId === undefined)
		throw new CliError("usage: omp-web rm-worktree <daemon-id> [--delete-branch <name>]");
	const deleteBranch = flagString(flags, "delete-branch");
	const body = (await ctl(port, `/ctl/worktrees/${encodeURIComponent(daemonId)}`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(deleteBranch === undefined ? {} : { deleteBranch }),
	})) as { removed?: unknown; worktree?: { path?: string; branch?: string }; verified?: unknown[] };
	const wt = body.worktree ?? {};
	const parts = [
		String(wt.path ?? ""),
		wt.branch !== undefined ? `branch ${wt.branch}` : "",
	].filter((part) => part !== "");
	const removedLabel =
		body.verified !== undefined
			? `removed clone workspace daemon ${String(body.removed ?? daemonId)} (verified ${(body.verified as unknown[]).length} session${(body.verified as unknown[]).length === 1 ? "" : "s"})`
			: `removed worktree daemon ${String(body.removed ?? daemonId)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
	console.log(removedLabel);
	return 0;
}

/**
 * start <selector>: fleet-side ensure-running for a clone workspace
 * (POST /ctl/start, server alias of /ctl/wake; P6.1). The route accepts a
 * daemon id only, so the selector (id or exact roster name) is resolved
 * client-side against /ctl/sessions first. The server refuses non-clone
 * entries; direct/template sessions keep /ctl/spawn.
 */
async function startCmd(
	positionals: string[],
	_flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const selector = positionals[0];
	if (selector === undefined) throw new CliError("usage: omp-web start <selector>");
	const roster = await ctl(port, "/ctl/sessions");
	if (!Array.isArray(roster)) throw new CliError("unexpected sessions response");
	const matches = (roster as unknown[])
		.filter(isDaemonRow)
		.filter((row) => row.daemonId === selector || row.name === selector);
	if (matches.length === 0) {
		throw new CliError(`no session matches selector: ${selector}`);
	}
	const first = matches[0];
	if (matches.some((row) => row.daemonId !== first.daemonId)) {
		throw new CliError(`selector ${selector} matches multiple daemons; use a daemon id`);
	}
	const body = (await ctl(port, "/ctl/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ daemonId: first.daemonId }),
	})) as { observed?: string; pid?: number };
	console.log(
		`started ${first.daemonId}, observed ${String(body.observed ?? "?")}` +
			(body.pid !== undefined ? ` (pid ${body.pid})` : ""),
	);
	return 0;
}

async function stopCmd(
	positionals: string[],
	_flags: Map<string, FlagValue>,
	port: number,
): Promise<number> {
	const selector = positionals[0];
	if (selector === undefined) throw new CliError("usage: omp-web stop <selector>");
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
	if (selector === undefined) throw new CliError("usage: omp-web remove <selector>");
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
		throw new CliError("usage: omp-web prompt <selector> <text> [--wait <ms>]");
	}
	const waitValue = flags.get("wait");
	const waitMs = flagNumber(flags, "wait");
	if (waitValue !== undefined && waitMs === undefined) {
		throw new CliError(
			"usage: prompt <selector> <text> [--wait <ms>]. --wait requires a millisecond value",
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

const USAGE = `usage: omp-web [options] | omp-web <command> [options]

commands:
  (none)                       control plane + UI on one port
  control                      control plane only; no UI on this port
  ui                           UI daemon: static UI + proxy to the control plane
  sessions                     list sessions
  projects                     list registered projects (id, name, path, worktrees, missing)
  profiles                     list provider profiles (secret-free catalog)
  spawn <path> [--template t] [--name n] [--label k=v]…
  add-repo <path> [--start] [--template t] [--labels k=v,...]
  add-clone <project> <name> --profile <id> [--local path | --remote url]
                               [--revision rev] [--branch b] [--no-start]
  start <selector>             ensure a clone workspace is running (wake)
  stop <selector>
  remove <selector>
  rm-project <selector>
  preflight --profile <id>
  add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]
  rm-worktree <daemon-id> [--delete-branch <name>]
  prompt <selector> <text> [--wait <ms>]

options:
  --port <n>           control plane port (default 4722, env OMP_FLEET_PORT);
                       ui: its listen port (default 4723)
  --control-port <n>   ui: control plane to proxy to (default 4722, env OMP_FLEET_PORT)
  --no-open            bare, ui: do not open the UI in a browser; otherwise it opens
                       only when run from an interactive local terminal
  --verbose            bare/control: also print state and config paths and every event
  --workspace-dir <d>  Default worktree directory (default ~/.omp-web/workspaces,
                       env OMP_FLEET_WORKSPACE_DIR)
  --bind <addr>        control plane + browser edge bind address (default
                       127.0.0.1, env OMP_FLEET_BIND)
  --browser-access-token <t>
                       browser-auth operator token; stored only as its
                       sha-256 digest (env OMP_FLEET_BROWSER_TOKEN)
  --browser-origin <o> public origin browsers use when a reverse proxy serves the
                       UI: the proxy must set it, or the fleet refuses its
                       mutations. The ui command reads it too, so set the same value on
                       both (env OMP_FLEET_BROWSER_ORIGIN, config browserOrigin)
  --trusted-proxy <ip-or-cidr>
                       trusted reverse proxy whose X-Forwarded-For / -Proto
                       headers are honored (repeatable; env
                       OMP_FLEET_TRUSTED_PROXY csv, config trustedProxies
                       key); forwarded headers are ignored from any other
                       peer, never trusted by default`;

export async function main(argv: string[]): Promise<number> {
	try {
		const { positionals, flags } = parseArgs(argv);
		const port = portFlag(flags, "port") ?? envPort() ?? DEFAULT_PORT;
		const command = positionals[0];
		const rest = positionals.slice(1);
		// `--help` on any verb (or bare) prints usage instead of running it.
		switch (flagBoolean(flags, "help") === true ? "help" : command) {
			case "help":
				console.log(USAGE);
				return 0;
			case undefined:
			case "":
			case "control": {
				const serveUi = command !== "control";
				// Only a person at an interactive terminal gets a browser tab;
				// agents, scripts, and supervisors never do.
				const open = serveUi && flagBoolean(flags, "no-open") !== true && isInteractiveDesktop();
				return await serveCmd(
					port,
					flagString(flags, "workspace-dir"),
					{
						bind: flagString(flags, "bind"),
						browserAccessToken: flagString(flags, "browser-access-token"),
						browserOrigin: flagString(flags, "browser-origin"),
						trustedProxy: trustedProxyList(flags),
					},
					{ serveUi, verbose: flagBoolean(flags, "verbose") === true, open },
				);
			}
			case "ui":
				return await uiCmd(
					portFlag(flags, "port") ?? DEFAULT_UI_PORT,
					portFlag(flags, "control-port") ?? envPort() ?? DEFAULT_PORT,
					flagBoolean(flags, "no-open") !== true && isInteractiveDesktop(),
					flagString(flags, "browser-origin"),
				);
			case "sessions":
				return await sessionsCmd(port);
			case "projects":
				return await projectsCmd(port);
			case "profiles":
				return await profilesCmd(port);
			case "spawn":
				return await spawnCmd(rest, flags, port);
			case "add-repo":
				return await addRepoCmd(rest, flags, port);
			case "add-clone":
				return await addCloneCmd(rest, flags, port);
			case "start":
				return await startCmd(rest, flags, port);
			case "stop":
				return await stopCmd(rest, flags, port);
			case "remove":
				return await removeCmd(rest, flags, port);
			case "rm-project":
				return await rmProjectCmd(rest, flags, port);
			case "preflight":
				// Local verb: no control plane needed, but resolvePort stays
				// consistent with every other invocation.
				return await preflightCmd(flags);
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
