/**
 * omp-fleet headless control plane (Phase 2).
 *
 * A loopback-only HTTP JSON API (default port 4722, env OMP_FLEET_PORT,
 * opts.port wins; 0 = ephemeral) on a shared Bun.serve — Phase 3 adds the
 * browser SSE edge (/events + /command) on the same server. Wires the
 * persistent Registry, the remote DaemonConnector and the SpawnSupervisor:
 *
 *   GET  /ctl/sessions {…}                         → RegistryEntry[]
 *   GET  /ctl/projects {…}                         → ProjectEntry[]
 *   POST /ctl/spawn    {cwd, template?, name?, labels?} → RegistryEntry
 *   POST /ctl/add      {name, url, token?, labels?, cwd?} → RegistryEntry
 *   POST /ctl/provision {name, labels?}            → RegistryEntry (spawn hook)
 *   POST /ctl/stop     {selector}                  → { stopped: string[] }
 *   POST /ctl/remove   {selector}                  → { removed: string[] }
 *   POST /ctl/prompt   {selector, text, waitMs?}   → PromptResult[] | { submitted: string[] }
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
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { FleetConfig } from "./config";
import { loadConfig } from "./config";
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

const DEFAULT_PORT = 4722;
const DEFAULT_STATE_PATH = join(homedir(), ".omp", "fleet", "state.json");

/** Control plane as consumed by the CLI (and, in Phase 3, the edge server). */
export interface FleetServer {
	port: number;
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
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
	const child = Bun.spawn(["sh", "-c", hook], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const stdout = readAllText(child.stdout);
	const stderr = readAllText(child.stderr);
	const timedOut = await Promise.race([child.exited.then(() => false), sleep(timeoutMs).then(() => true)]);
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
	if (typeof obj.url !== "string" || obj.url === "" || typeof obj.token !== "string" || obj.token === "") {
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

	readonly #server: Server<undefined>;

	constructor(registry: Registry, config: FleetConfig, port: number) {
		this.registry = registry;
		this.config = config;
		let edge: FleetEdge | null = null;
		this.connector = new DaemonConnector(registry, {
			onDialFailed: (entry) => this.#onDialFailed(entry),
			onStatus: (entry) => {
				edge?.onDaemonStatus(entry);
				// #22: a spawned child that reaches the connector's "ready"
				// transition is stable — the supervisor resets its
				// consecutive-crash budget there (window-based, not lifetime).
				this.supervisor.onConnectorStatus(entry);
			},
		});
		this.supervisor = new SpawnSupervisor(registry, this.connector, config);
		edge = new FleetEdge({
			registry,
			connector: this.connector,
			supervisor: this.supervisor,
			config,
		});
		this.edge = edge;
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
		if (errors.length > 0) throw errors[0];
	}

	#onDialFailed(entry: RegistryEntry): void {
		// Respawn spawned children on transport failure (dial refused); the
		// supervisor owns the R3 --resume rule AND serializes overlapping
		// respawns per daemon (concurrent calls coalesce into one launch).
		// Attached/remote entries are dial-in only: their own backoff in the
		// connector covers retries.
		if (entry.mode !== "spawned") return;
		void (async () => {
			try {
				await this.supervisor.respawn(entry);
			} catch (err) {
				console.error(`fleet: respawn ${entry.daemonId} failed`, err);
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
			if (req.method === "GET") {
				switch (path) {
					case "/ctl/sessions":
						return json(this.registry.list());
					case "/ctl/projects":
						return json(await listProjects(this.config.roots));
					default:
						return json({ error: "not found" }, 404);
				}
			}
			if (req.method === "POST") {
				switch (path) {
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
					default:
						return json({ error: "not found" }, 404);
				}
			}
			return json({ error: "method not allowed" }, 405);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			console.error("fleet: control request failed", err);
			return json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
			void fanOut(this.#fanoutDeps(), matches, text, undefined)
				.catch((err: unknown) => console.error("fleet: background prompt failed", err));
			return json({ submitted: matches.map((entry) => entry.daemonId) });
		}
		const results = await fanOut(this.#fanoutDeps(), matches, text, waitMs);
		return json(results);
	}
}

export async function startFleet(opts: { port?: number; statePath?: string; configPath?: string } = {}): Promise<FleetServer> {
	const registry = new Registry(resolveStatePath(opts.statePath));
	await registry.load();
	const config = await loadConfig(opts.configPath);
	return new FleetServerImpl(registry, config, resolvePort(opts.port));
}
