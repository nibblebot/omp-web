/**
 * omp-fleet headless control plane (Phase 2).
 *
 * A loopback-only HTTP JSON API (default port 4722, env OMP_FLEET_PORT,
 * opts.port wins; 0 = ephemeral) on a shared Bun.serve — Phase 3 adds the
 * browser SSE edge (/events + /command) on the same server. Wires the
 * persistent Registry, the remote DaemonConnector and the SpawnSupervisor:
 *
 *   GET  /ctl/sessions {…}                         → RegistryEntry[]
 *   GET  /ctl/projects {…}                         → { projects: ProjectEntry[], registered: RegisteredProject[] }
 *   POST /ctl/projects {path, start?, template?, labels?} → 201 { project, entry? } | 409 { error, project }
 *   DELETE /ctl/projects/:projectId                → 200 { removed } | 409 { error }
 *   GET  /ctl/settings                             -> SettingsModel
 *   GET  /ctl/worktrees/:daemonId/delete-info      -> worktree_delete_info payload
 *   POST /ctl/spawn    {cwd, template?, name?, labels?} -> RegistryEntry
 *   POST /ctl/add      {name, url, token?, labels?, cwd?} → RegistryEntry
 *   POST /ctl/provision {name, labels?}            → RegistryEntry (spawn hook)
 *   POST /ctl/stop     {selector}                  → { stopped: string[] }
 *   POST /ctl/remove   {selector}                  → { removed: string[] }
 *   POST /ctl/prompt   {selector, text, waitMs?}   → PromptResult[] | { submitted: string[] }
 *   POST /ctl/settings/set {path, value}           -> SettingsModel (400 bad path/value)
 *   POST /ctl/projects/:id/worktrees               -> create or add-existing worktree -> 201 { entry }
 *   DELETE /ctl/worktrees/:daemonId {deleteBranch?} -> stop -> remove entry -> git worktree remove
 *
 * /ctl/provision runs config.spawnHook via `sh -c` with env OMP_HOOK_NAME /
 * OMP_HOOK_LABELS and a 60s deadline; the hook's last non-empty stdout line
 * must be JSON { name?, url, token, cwd? } (R6/N3 enroll contract) and the
 * result is registered as a remote entry and dialed. 400 when no hook is
 * configured, 502 on hook failure / bad output.
 *
 * Errors: 400 invalid JSON / validation failure, 404 empty selector match,
 * 405 wrong method, 500 {error} on anything else. `waitMs` absent on
 * /ctl/prompt dispatches fire-and-forget: each match gets the prompt in the
 * background and the route returns { submitted } without awaiting the turn.
 *
 * The connector's onDialFailed is wired to respawn spawned entries (the
 * supervisor serializes overlapping respawns per daemon); attached/remote
 * entries are left to their own backoff.
 */

import type { Server } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RegisteredProject } from "../shared/protocol";
import type { FleetConfig } from "./config";
import { loadConfig, resolveConfigPath } from "./config";
import type { RegistryEntry } from "./registry";
import { bootStatusFor, Registry } from "./registry";
import { listProjects, validateProjectPath } from "./discovery";
import { matchSelector } from "./selectors";
import { DaemonConnector } from "./connector";
import { SpawnSupervisor } from "./supervisor";
import { isValidEndpointUrl } from "./spawn-parse";
import type { FanoutDeps } from "./fanout";
import { fanOut } from "./fanout";
import { FleetEdge } from "./edge";
import { FleetEventLog, type FleetFacts } from "./events";
import { createFleetSettings, type FleetSettings, type FleetSettingsOptions } from "./settings";
import { createStatsApp } from "./stats/index";
import {
	createWorktree,
	deleteWorktree,
	mergeUnregisteredWorktrees,
	registerWorktreeEntry,
	validateUnregisteredWorktree,
	worktreeDeleteInfo,
	WorktreeDirtyError,
	WorktreeNotOwnedError,
	WorktreeTargetExistsError,
	type CreateWorktreeResult,
} from "./worktrees";

const DEFAULT_PORT = 4722;
const DEFAULT_STATE_PATH = join(homedir(), ".ompweb", "fleet", "state.json");

/**
 * Historical transcripts/stats API (read-only stats.db + session files),
 * mounted under /ctl/stats. One instance per process, created at boot from
 * process env; close() releases its stats.db handle on fleet shutdown.
 */
const statsApp = createStatsApp();

/** Control plane as consumed by the CLI (and, in Phase 3, the edge server). */
export interface FleetServer {
	port: number;
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
	/** Fleet lifecycle-event ring (backing /ctl/debug; CLI mirrors it to stdout). */
	eventLog: FleetEventLog;
	/** Fleet-wide facts (port/startedAt/state paths) for the banner + /ctl/debug. */
	fleetFacts: FleetFacts;
	close(): Promise<void>;
}

/** Expand a leading `~` / `~/` to os.homedir(); other paths pass through. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function resolveStatePath(explicit?: string): string {
	if (explicit !== undefined && explicit !== "") return expandTilde(explicit);
	const env = process.env.OMP_FLEET_STATE;
	if (env !== undefined && env !== "") return expandTilde(env);
	return DEFAULT_STATE_PATH;
}

function resolvePort(explicit?: number): number {
	if (explicit !== undefined) return explicit;
	const env = process.env.OMP_FLEET_PORT;
	if (env !== undefined && env !== "") {
		const n = Number(env);
		if (Number.isFinite(n)) return n;
	}
	return DEFAULT_PORT;
}

/** An error whose message is safe to return to the caller (400/404/…). */
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new HttpError(400, "request body must be a JSON object");
	}
	return raw as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new HttpError(400, `missing or invalid field: ${key}`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HttpError(400, `invalid field: ${key}`);
	return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new HttpError(400, `invalid field: ${key}`);
	return value;
}

function optionalLabels(body: Record<string, unknown>): string[] | undefined {
	const value = body["labels"];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) {
		throw new HttpError(400, "labels must be an array of strings");
	}
	return value as string[];
}

function optionalWaitMs(body: Record<string, unknown>): number | undefined {
	const value = body["waitMs"];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new HttpError(400, "waitMs must be a non-negative number");
	}
	return value;
}

/** Worktree route patterns (daemon ids / project ids are [^/]+ segments). */
const PROJECT_WORKTREES_ROUTE = /^\/ctl\/projects\/([^/]+)\/worktrees$/;
const WORKTREE_DELETE_ROUTE = /^\/ctl\/worktrees\/([^/]+)$/;
const WORKTREE_INFO_ROUTE = /^\/ctl\/worktrees\/([^/]+)\/delete-info$/;

/**
 * Reject endpoints that are not ws:// or wss:// URLs. The check itself lives
 * in spawn-parse.ts (isValidEndpointUrl) — shared with the supervisor's
 * resolved-endpoint guard and parseContractLine so every URL that reaches
 * the connector has passed the same validation.
 */
function validateEndpointUrl(raw: string): void {
	if (!isValidEndpointUrl(raw)) {
		throw new HttpError(400, `url must be ws:// or wss://: ${raw}`);
	}
}

/** Default spawn-hook deadline (contract: 60s). */
const HOOK_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const pump = async (): Promise<string> => {
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
		}
		return buffer;
	};
	return pump().catch(() => "");
}

/**
 * Run `config.spawnHook` via `sh -c` with the provision env
 * (`OMP_HOOK_NAME` / `OMP_HOOK_LABELS` comma-joined) and a deadline. The
 * child is SIGKILLed on timeout. Resolves with captured stdout/stderr; a
 * non-zero exit or a timeout rejects with a 502 {@link HttpError}.
 */
export async function runSpawnHook(
	hook: string,
	env: Record<string, string>,
	timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
	const child = Bun.spawn(["sh", "-c", hook], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = readAllText(child.stdout);
	const stderr = readAllText(child.stderr);
	const timedOut = await Promise.race([
		child.exited.then(() => false),
		sleep(timeoutMs).then(() => true),
	]);
	if (timedOut) {
		child.kill("SIGKILL");
		await child.exited.catch(() => {
			// The exit promise may reject if the process was never reaped; ignore.
		});
		throw new HttpError(502, `spawn hook timed out after ${Math.round(timeoutMs / 1000)}s`);
	}
	const [out, err] = await Promise.all([stdout, stderr]);
	if (child.exitCode !== 0) {
		const detail = err.trim().split("\n").at(-1);
		throw new HttpError(502, `spawn hook exited ${child.exitCode}${detail ? `: ${detail}` : ""}`);
	}
	return { stdout: out, stderr: err };
}

/** Hook output the provision route accepts (contract): { name?, url, token, cwd? }. */
interface HookOutput {
	name?: string;
	url: string;
	token: string;
	cwd?: string;
}

/**
 * Parse the hook's stdout: the LAST non-empty line must be JSON with at
 * least `url` and `token` (both ws:// or wss:// for url, non-empty strings).
 * Anything else is a 502 {@link HttpError}.
 */
function parseHookOutput(stdout: string): HookOutput {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const last = lines[lines.length - 1];
	if (last === undefined) {
		throw new HttpError(502, "spawn hook produced no stdout");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(last);
	} catch {
		throw new HttpError(502, `spawn hook stdout is not valid JSON: ${last}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new HttpError(502, `spawn hook stdout must be a JSON object: ${last}`);
	}
	const obj = parsed as Record<string, unknown>;
	if (
		typeof obj.url !== "string" ||
		obj.url === "" ||
		typeof obj.token !== "string" ||
		obj.token === ""
	) {
		throw new HttpError(502, "spawn hook output missing url or token");
	}
	try {
		validateEndpointUrl(obj.url);
	} catch (err) {
		throw new HttpError(502, (err as HttpError).message);
	}
	const out: HookOutput = { url: obj.url, token: obj.token };
	if (typeof obj.name === "string" && obj.name !== "") out.name = obj.name;
	if (typeof obj.cwd === "string" && obj.cwd !== "") out.cwd = obj.cwd;
	return out;
}

class FleetServerImpl implements FleetServer {
	readonly port: number;
	readonly registry: Registry;
	readonly connector: DaemonConnector;
	readonly supervisor: SpawnSupervisor;
	readonly config: FleetConfig;
	readonly edge: FleetEdge;
	readonly fleetSettings: FleetSettings;
	readonly eventLog = new FleetEventLog();
	readonly startedAt: number;
	readonly fleetFacts: FleetFacts;

	readonly #server: Server<undefined>;

	constructor(
		registry: Registry,
		config: FleetConfig,
		port: number,
		facts: { statePath: string; configPath: string | null },
		settingsOptions?: FleetSettingsOptions,
	) {
		this.registry = registry;
		this.config = config;
		this.startedAt = Date.now();
		this.fleetFacts = {
			port: 0,
			startedAt: this.startedAt,
			statePath: facts.statePath,
			configPath: facts.configPath,
		};
		let edge: FleetEdge | null = null;
		this.connector = new DaemonConnector(registry, {
			onDialFailed: (entry) => this.#onDialFailed(entry),
			onStatus: (entry) => {
				edge?.onDaemonStatus(entry);
				// #22: a spawned child that reaches the connector's "ready"
				// transition is stable — the supervisor resets its
				// consecutive-crash budget there (window-based, not lifetime).
				this.supervisor.onConnectorStatus(entry);
				// Fleet observability: every status transition lands in the ring.
				this.eventLog.add(
					entry.status === "error" ? "error" : entry.status === "reconnecting" ? "warn" : "info",
					"connector",
					entry.status === "error" ? `error: ${entry.error ?? "error"}` : entry.status,
					entry.daemonId,
				);
			},
			onReconnect: (daemonId, attempt, delayMs) => {
				this.eventLog.add(
					"warn",
					"connector",
					`reconnect scheduled (attempt ${attempt}, delay ${delayMs}ms)`,
					daemonId,
				);
			},
		});
		this.supervisor = new SpawnSupervisor(registry, this.connector, config, {
			onEvent: (level, message, daemonId) =>
				this.eventLog.add(level, "supervisor", message, daemonId),
		});
		edge = new FleetEdge({
			registry,
			connector: this.connector,
			supervisor: this.supervisor,
			config,
			eventLog: this.eventLog,
			fleet: this.fleetFacts,
		});
		this.edge = edge;
		// Unattached settings service (roster-mode /ctl/settings): lazy
		// Settings.init + ModelRegistry, no live session required. Injectable
		// provider source for tests (must not open the real auth DB).
		this.fleetSettings = createFleetSettings(settingsOptions);
		// #3: statuses persisted by a previous fleet process describe dead
		// children/sockets — map them to a truthful boot state and redial
		// remote entries BEFORE anything else starts acting on the roster.
		this.#reconcileBootStatuses();
		// Tag pre-existing local entries with their owning repo (roster
		// grouping); per-entry git failures are swallowed inside.
		void this.supervisor.backfillWorktrees();
		// Keep branch + dirty counts fresh for local entries; close() clears
		// the timer via supervisor.close().
		this.supervisor.startGitStatePolling();
		this.#server = Bun.serve({
			hostname: "127.0.0.1", // loopback-only control API + browser edge (Phase 3)
			port,
			// SSE responses are long-lived and quiet between 15s keepalive
			// pings; Bun's default 10s fetch idleTimeout would kill them.
			idleTimeout: 0,
			fetch: (req) => this.#fetch(req),
		});
		this.port = this.#server.port!;
		this.fleetFacts.port = this.port;
	}

	async close(): Promise<void> {
		const errors: unknown[] = [];
		try {
			this.edge.close();
		} catch (err) {
			errors.push(err);
		}
		try {
			await this.connector.close();
		} catch (err) {
			errors.push(err);
		}
		try {
			await this.supervisor.close();
		} catch (err) {
			errors.push(err);
		}
		try {
			this.#server.stop();
		} catch (err) {
			errors.push(err);
		}
		try {
			statsApp.close();
		} catch (err) {
			errors.push(err);
		}
		if (errors.length > 0) throw errors[0];
	}

	#onDialFailed(entry: RegistryEntry): void {
		// Respawn spawned children on transport failure (dial refused); the
		// supervisor owns the R3 --resume rule AND serializes overlapping
		// respawns per daemon (concurrent calls coalesce into one launch).
		// Attached/remote entries are dial-in only: their own backoff in the
		// connector covers retries.
		this.eventLog.add("warn", "connector", `dial failed (${entry.mode})`, entry.daemonId);
		if (entry.mode !== "spawned") return;
		void (async () => {
			try {
				await this.supervisor.respawn(entry);
			} catch (err) {
				console.error(`fleet: respawn ${entry.daemonId} failed`, err);
				this.eventLog.add(
					"error",
					"server",
					`respawn ${entry.daemonId} failed: ${err instanceof Error ? err.message : String(err)}`,
					entry.daemonId,
				);
			}
		})();
	}

	/**
	 * #3: reconcile statuses persisted by a previous fleet process. Spawned
	 * children and connector sockets died with that process, so non-terminal
	 * statuses are mapped to a truthful boot state (bootStatusFor): spawned
	 * entries → "asleep" (respawn --resume recovers), remote/attached → the
	 * connector redials immediately. Stale liveness facts (readyAt, pid) are
	 * cleared on every downgrade so the roster never shows uptime/pid for a
	 * process that is not running.
	 */
	#reconcileBootStatuses(): void {
		for (const entry of this.registry.list()) {
			const target = bootStatusFor(entry);
			if (target === null) continue;
			const patch: Partial<RegistryEntry> = { status: target };
			if (entry.readyAt !== undefined) patch.readyAt = undefined;
			if (entry.pid !== undefined) patch.pid = undefined;
			this.registry.update(entry.daemonId, patch);
			this.eventLog.add(
				"info",
				"server",
				`boot reconcile: ${entry.status} → ${target}`,
				entry.daemonId,
			);
			if (target === "connecting") {
				this.connector.connect(entry.daemonId);
			}
		}
	}

	#fanoutDeps(): FanoutDeps {
		return { registry: this.registry, connector: this.connector, supervisor: this.supervisor };
	}

	#fetch = async (req: Request): Promise<Response> => {
		// Edge routes first: /events (SSE), /command (POST), the /ctl routes,
		// and static dist. null = not an edge route.
		const edgeHandled = await this.edge.handleFetch(req);
		if (edgeHandled !== null) return edgeHandled;
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			// Historical transcripts/stats API: /ctl/stats/* is stats-owned
			// (statsApp returns null for unowned paths — the control-plane
			// switch below owns the 404/405 for those).
			if (path.startsWith("/ctl/stats")) {
				const statsHandled = await statsApp.handleFetch(req, url);
				if (statsHandled !== null) return statsHandled;
			}
			if (req.method === "GET") {
				// Delete-confirmation evidence for one worktree daemon.
				const infoMatch = WORKTREE_INFO_ROUTE.exec(path);
				if (infoMatch) return await this.#handleWorktreeDeleteInfo(infoMatch[1]);
				switch (path) {
					case "/ctl/sessions":
						return json(this.registry.list());
					case "/ctl/projects": {
						// Discovery stays ephemeral + read-only; the registered
						// set is merged alongside so clients see both. Each
						// registered project also contributes its unregistered
						// linked worktrees (deduped by realpath, roster cwds
						// excluded) so clients see them even when the main
						// checkout is outside the discovery roots.
						const projects = await mergeUnregisteredWorktrees(
							await listProjects(this.config.roots),
							this.registry.projects(),
							this.registry.list().map((entry) => entry.cwd),
						);
						return json({ projects, registered: this.registry.projects() });
					}
					case "/ctl/settings":
						// Unattached settings model (roster mode): the fleet
						// service lazily initializes the process-global
						// Settings singleton + ModelRegistry — no session.
						return json(await this.fleetSettings.getModel());
					default:
						return json({ error: "not found" }, 404);
				}
			}
			if (req.method === "POST") {
				// Create-new ({name, baseRef?, existingBranch?, start?}) or
				// add-existing ({worktreePath, start?}) for one project.
				const worktreesMatch = PROJECT_WORKTREES_ROUTE.exec(path);
				if (worktreesMatch) return await this.#handleCreateOrAddWorktree(req, worktreesMatch[1]);
				switch (path) {
					case "/ctl/projects":
						return await this.#handleAddProject(req);
					case "/ctl/spawn":
						return await this.#handleSpawn(req);
					case "/ctl/add":
						return await this.#handleAdd(req);
					case "/ctl/provision":
						return await this.#handleProvision(req);
					case "/ctl/stop":
						return await this.#handleStop(req);
					case "/ctl/remove":
						return await this.#handleRemove(req);
					case "/ctl/prompt":
						return await this.#handlePrompt(req);
					case "/ctl/settings/set":
						return await this.#handleSettingsSet(req);
					default:
						return json({ error: "not found" }, 404);
				}
			}
			if (req.method === "DELETE") {
				const projectMatch = /^\/ctl\/projects\/([^/]+)$/.exec(path);
				if (projectMatch) return await this.#handleRemoveProject(projectMatch[1]);
				// Worktree deletion: stop daemon -> remove entry -> git worktree remove.
				const worktreeMatch = WORKTREE_DELETE_ROUTE.exec(path);
				if (worktreeMatch) return await this.#handleDeleteWorktree(req, worktreeMatch[1]);
				return json({ error: "not found" }, 404);
			}
			return json({ error: "method not allowed" }, 405);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			const message = err instanceof Error ? err.message : String(err);
			console.error("fleet: control request failed", err);
			this.eventLog.add(
				"error",
				"server",
				`request ${req.method} ${new URL(req.url).pathname} failed: ${message}`,
			);
			return json({ error: message }, 500);
		}
	};

	async #handleSpawn(req: Request): Promise<Response> {
		const body = await readJson(req);
		const cwd = requireString(body, "cwd");
		const template = optionalString(body, "template");
		const name = optionalString(body, "name");
		const labels = optionalLabels(body);
		// NUL cannot exist in a shell command string; reject it at the
		// boundary. (Quoting in supervisor #launch is the real injection
		// defense — this only keeps NUL out of the wire/state.)
		if (name !== undefined && name.includes("\0")) {
			throw new HttpError(400, "invalid field: name must not contain NUL");
		}
		if (labels !== undefined && labels.some((label) => label.includes("\0"))) {
			throw new HttpError(400, "labels must not contain NUL");
		}
		const resolved = await validateProjectPath(cwd);
		if (resolved === null) throw new HttpError(400, `not a directory: ${cwd}`);
		const entry = await this.supervisor.spawn({ cwd: resolved, template, name, labels });
		return json(entry);
	}

	/**
	 * POST /ctl/projects { path, start?, template?, labels? }: register the
	 * project's realpath (registry.addProject validates + realpath-normalizes
	 * and dedups). A path that is not an existing directory or git repo is
	 * the registry's validation error surfaced as 400; a realpath that is
	 * already registered dedups to the EXISTING project → 409 carrying it.
	 * With `start: true` the main checkout is spawned via the supervisor
	 * (template/labels passthrough) and the fresh entry is tagged with the
	 * projectId. Staged: registration happens first, so a failed spawn
	 * reports 500 (stage named in the message) but the project stays
	 * registered. Returns 201 { project, entry? }.
	 */
	async #handleAddProject(req: Request): Promise<Response> {
		const body = await readJson(req);
		const path = requireString(body, "path");
		const start = optionalBoolean(body, "start") ?? false;
		const template = optionalString(body, "template");
		const labels = optionalLabels(body);
		if (labels !== undefined && labels.some((label) => label.includes("\0"))) {
			throw new HttpError(400, "labels must not contain NUL");
		}
		const before = this.registry.projects();
		let project: RegisteredProject;
		try {
			project = await this.registry.addProject(path);
		} catch (err) {
			// Validation failure (missing dir / not a git repo) → 400.
			throw new HttpError(400, err instanceof Error ? err.message : String(err));
		}
		if (before.some((p) => p.projectId === project.projectId)) {
			return json({ error: `project already registered: ${project.projectId}`, project }, 409);
		}
		if (!start) return json({ project }, 201);
		try {
			const entry = await this.supervisor.spawn({ cwd: project.path, template, labels });
			const tagged = this.registry.update(entry.daemonId, { projectId: project.projectId });
			return json({ project, entry: tagged }, 201);
		} catch (err) {
			// The project stays registered; the 500 names the stage.
			throw new HttpError(
				500,
				`project ${project.projectId} registered, spawn failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * DELETE /ctl/projects/:projectId: deregister a project (never touches
	 * disk). 409 when roster entries still reference it — the message names
	 * the blocking daemon ids (registry.removeProject). Unknown ids → 404.
	 */
	async #handleRemoveProject(projectId: string): Promise<Response> {
		try {
			this.registry.removeProject(projectId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.startsWith("unknown project id")) throw new HttpError(404, message);
			throw new HttpError(409, message);
		}
		return json({ removed: projectId });
	}

	async #handleAdd(req: Request): Promise<Response> {
		const body = await readJson(req);
		const name = requireString(body, "name");
		const url = requireString(body, "url");
		validateEndpointUrl(url);
		const token = optionalString(body, "token");
		const labels = optionalLabels(body);
		const cwd = optionalString(body, "cwd");
		const entry = this.registry.create({
			name,
			cwd: cwd ?? "",
			project: cwd ? basename(cwd) : "",
			labels: labels ?? [],
			mode: "remote",
			endpoint: url,
			token,
			status: "connecting",
		});
		this.connector.connect(entry.daemonId);
		this.eventLog.add("info", "server", `added ${entry.name} (${url})`, entry.daemonId);
		return json(entry);
	}

	/**
	 * POST /ctl/provision { name, labels? }: run `config.spawnHook` via
	 * `sh -c` with env `OMP_HOOK_NAME` / `OMP_HOOK_LABELS` (comma-joined),
	 * 60s deadline. The hook's LAST non-empty stdout line must be JSON
	 * `{ name?, url, token, cwd? }`; the result is registered as a remote
	 * entry and dialed. 400 when no hook is configured; 502 on hook
	 * failure, timeout, unparseable output, or missing url/token.
	 */
	async #handleProvision(req: Request): Promise<Response> {
		const hook = this.config.spawnHook;
		if (hook === undefined || hook === "") {
			throw new HttpError(400, "no spawn hook configured");
		}
		const body = await readJson(req);
		const name = requireString(body, "name");
		const labels = optionalLabels(body);
		const { stdout } = await runSpawnHook(hook, {
			OMP_HOOK_NAME: name,
			OMP_HOOK_LABELS: (labels ?? []).join(","),
		});
		const output = parseHookOutput(stdout);
		const entry = this.registry.create({
			name: output.name ?? name,
			cwd: output.cwd ?? "",
			project: output.cwd ? basename(output.cwd) : "",
			labels: labels ?? [],
			mode: "remote",
			endpoint: output.url,
			token: output.token,
			status: "connecting",
		});
		this.connector.connect(entry.daemonId);
		this.eventLog.add("info", "server", `provisioned ${entry.name} (spawn hook)`, entry.daemonId);
		return json(entry);
	}

	async #handleStop(req: Request): Promise<Response> {
		const body = await readJson(req);
		const selector = requireString(body, "selector");
		const matches = matchSelector(this.registry.list(), selector);
		if (matches.length === 0) throw new HttpError(404, `no daemon matches selector: ${selector}`);
		const stopped: string[] = [];
		for (const entry of matches) {
			if (entry.mode === "spawned") {
				await this.supervisor.stop(entry.daemonId);
			} else {
				this.connector.disconnect(entry.daemonId);
				this.registry.setStatus(entry.daemonId, "asleep");
			}
			this.eventLog.add("info", "server", `stopped (${entry.mode})`, entry.daemonId);
			stopped.push(entry.daemonId);
		}
		return json({ stopped });
	}

	async #handleRemove(req: Request): Promise<Response> {
		const body = await readJson(req);
		const selector = requireString(body, "selector");
		const matches = matchSelector(this.registry.list(), selector);
		if (matches.length === 0) throw new HttpError(404, `no daemon matches selector: ${selector}`);
		const removed: string[] = [];
		for (const entry of matches) {
			// #24: prune/drop the per-daemon supervisor/connector state so a
			// removed daemon leaks nothing (stderr ring, listeners, waiters,
			// retain counts) and pending waitReady() waiters reject
			// immediately instead of hanging until their timeout.
			if (entry.mode === "spawned") {
				await this.supervisor.prune(entry.daemonId);
			} else {
				this.connector.drop(entry.daemonId);
			}
			this.registry.remove(entry.daemonId);
			this.eventLog.add("info", "server", "removed", entry.daemonId);
			removed.push(entry.daemonId);
		}
		return json({ removed });
	}

	async #handlePrompt(req: Request): Promise<Response> {
		const body = await readJson(req);
		const selector = requireString(body, "selector");
		const text = requireString(body, "text");
		const waitMs = optionalWaitMs(body);
		const matches = matchSelector(this.registry.list(), selector);
		if (matches.length === 0) throw new HttpError(404, `no daemon matches selector: ${selector}`);
		if (waitMs === undefined) {
			// Fire-and-forget: dispatch to each match without awaiting turn
			// completion; the caller gets the target list back immediately.
			void fanOut(this.#fanoutDeps(), matches, text, undefined).catch((err: unknown) =>
				console.error("fleet: background prompt failed", err),
			);
			return json({ submitted: matches.map((entry) => entry.daemonId) });
		}
		const results = await fanOut(this.#fanoutDeps(), matches, text, waitMs);
		return json(results);
	}

	/**
	 * POST /ctl/settings/set {path, value}: coerce + persist one schema
	 * setting through the unattached fleet settings service and return a
	 * fresh model. Unknown paths and uncoercible values are client errors
	 * (400, safe messages from coerceSettingValue); anything else falls
	 * through to the request-level 500 catch.
	 */
	async #handleSettingsSet(req: Request): Promise<Response> {
		const body = await readJson(req);
		const path = requireString(body, "path");
		// value is arbitrary JSON (boolean/number/string/array/object) —
		// coercion happens schema-side, so never requireString it.
		const value = body["value"];
		try {
			return json(await this.fleetSettings.set(path, value));
		} catch (err) {
			if (err instanceof HttpError) throw err;
			throw new HttpError(400, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * POST /ctl/projects/:projectId/worktrees. Two shapes: create-new
	 * `{ name, baseRef?, existingBranch?, start? }` (git worktree add under
	 * workspaceDir, lazily creating the workspace root) and add-existing
	 * `{ worktreePath, start? }` (a discovered-but-unregistered linked
	 * worktree of the project). Both register a roster entry (mode
	 * "spawned", projectId + worktreeOf tagged) and spawn a daemon only when
	 * `start` is true. Staged: a failure at any stage names the stage and
	 * leaves prior stages intact (a created-but-unspawned worktree shows up
	 * in discovery / the Add-existing tab).
	 */
	async #handleCreateOrAddWorktree(req: Request, projectId: string): Promise<Response> {
		const body = await readJson(req);
		const project = this.registry.projects().find((p) => p.projectId === projectId);
		if (!project) throw new HttpError(404, `unknown project: ${projectId}`);
		const worktreePath = optionalString(body, "worktreePath");
		const start = optionalBoolean(body, "start");
		if (worktreePath === undefined) {
			// Create-new.
			const name = requireString(body, "name");
			let created: CreateWorktreeResult;
			try {
				created = await createWorktree(project, name, {
					workspaceDir: this.config.workspaceDir,
					baseRef: optionalString(body, "baseRef"),
					existingBranch: optionalString(body, "existingBranch"),
				});
			} catch (err) {
				const status = err instanceof WorktreeTargetExistsError ? 409 : 400;
				throw new HttpError(
					status,
					`create worktree failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			let entry: RegistryEntry;
			try {
				entry = await registerWorktreeEntry(this.registry, this.supervisor, project, created.path, {
					start,
				});
			} catch (err) {
				throw new HttpError(
					500,
					`spawn failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			this.eventLog.add(
				"info",
				"server",
				`worktree created ${created.path} (${created.branch})`,
				entry.daemonId,
			);
			return json({ entry }, 201);
		}
		// Add-existing: validate it is an unregistered linked worktree of the project.
		let resolved: string;
		try {
			resolved = await validateUnregisteredWorktree(
				worktreePath,
				project,
				this.registry.list().map((e) => e.cwd),
			);
		} catch (err) {
			const status =
				err instanceof Error && err.message.startsWith("worktree already registered") ? 409 : 400;
			throw new HttpError(status, err instanceof Error ? err.message : String(err));
		}
		let entry: RegistryEntry;
		try {
			entry = await registerWorktreeEntry(this.registry, this.supervisor, project, resolved, {
				start,
			});
		} catch (err) {
			throw new HttpError(500, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.eventLog.add("info", "server", `worktree registered ${resolved}`, entry.daemonId);
		return json({ entry }, 201);
	}

	/**
	 * GET /ctl/worktrees/:daemonId/delete-info: guard evidence for the
	 * delete confirmation (worktree_delete_info payload). Never deletes.
	 */
	async #handleWorktreeDeleteInfo(daemonId: string): Promise<Response> {
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		const info = await worktreeDeleteInfo(entry.cwd ?? "", this.config.workspaceDir);
		return json({ daemonId, ...info });
	}

	/**
	 * DELETE /ctl/worktrees/:daemonId {deleteBranch?}: stop the daemon,
	 * evict it from the roster, then git-remove the managed worktree (and
	 * optionally `git branch -d` it). The ownership + dirty guards run
	 * BEFORE any mutation: a refusal (403 not owned / 409 dirty — no
	 * --force in v1) leaves the roster and daemon untouched. Session
	 * transcripts live under the agent dir, never inside the worktree, so
	 * nothing outside workspaceDir is ever removed.
	 */
	async #handleDeleteWorktree(req: Request, daemonId: string): Promise<Response> {
		// The body is optional (`{ deleteBranch?: boolean }`) — a bodyless
		// DELETE must not 400.
		const raw = await req.text();
		let body: Record<string, unknown>;
		if (raw.trim() === "") {
			body = {};
		} else {
			try {
				body = JSON.parse(raw);
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				throw new HttpError(400, "request body must be a JSON object");
			}
		}
		const deleteBranch = optionalBoolean(body, "deleteBranch");
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		const path = entry.cwd ?? "";
		const info = await worktreeDeleteInfo(path, this.config.workspaceDir);
		if (!info.owned) throw new HttpError(403, info.reason ?? `not a managed worktree: ${path}`);
		if (info.dirty)
			throw new HttpError(409, info.reason ?? `worktree has uncommitted changes: ${path}`);
		// Stop + evict (removal-time cleanup: #24 prune drops supervisor state).
		if (entry.mode === "spawned") {
			await this.supervisor.prune(daemonId);
		} else {
			this.connector.drop(daemonId);
		}
		this.registry.remove(daemonId);
		// Git removal; the guards are re-asserted inside (race backstop).
		let deleted: Awaited<ReturnType<typeof deleteWorktree>>;
		try {
			deleted = await deleteWorktree(path, this.config.workspaceDir, { deleteBranch });
		} catch (err) {
			if (err instanceof WorktreeNotOwnedError) throw new HttpError(403, err.message);
			if (err instanceof WorktreeDirtyError) throw new HttpError(409, err.message);
			throw new HttpError(
				500,
				`delete worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.eventLog.add(
			"info",
			"server",
			`worktree deleted ${deleted.path}${deleted.branch !== undefined ? ` (${deleted.branch})` : ""}`,
			daemonId,
		);
		return json({ removed: daemonId, worktree: deleted });
	}
}

export async function startFleet(
	opts: {
		port?: number;
		statePath?: string;
		configPath?: string;
		workspaceDir?: string;
		settings?: FleetSettingsOptions;
	} = {},
): Promise<FleetServer> {
	const statePath = resolveStatePath(opts.statePath);
	const registry = new Registry(statePath);
	await registry.load();
	const configPath = resolveConfigPath(opts.configPath);
	const config = await loadConfig(opts.configPath, { workspaceDir: opts.workspaceDir });
	return new FleetServerImpl(
		registry,
		config,
		resolvePort(opts.port),
		{
			statePath,
			// Null when no config file exists at the resolved location (defaults apply).
			configPath: existsSync(configPath) ? configPath : null,
		},
		opts.settings,
	);
}
