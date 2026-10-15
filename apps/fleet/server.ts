/**
 * omp-fleet headless control plane (Phase 2).
 *
 * A loopback-only HTTP JSON API (default port 4722, env OMP_FLEET_PORT,
 * opts.port wins; 0 = ephemeral) on a shared Bun.serve; Phase 3 adds the
 * browser SSE edge (/events + /command) on the same server. Wires the
 * persistent Registry, the callback transport and the SpawnSupervisor:
 *
 *   GET  /ctl/sessions {…}                         → DaemonEntry[]
 *   GET  /ctl/projects {…}                         → { projects: ProjectEntry[], registered: RegisteredProject[] }
 *   POST /ctl/projects {path, start?, template?, labels?} → 201 { project, entry? } | 409 { error, project }
 *   DELETE /ctl/projects/:projectId                → 200 { removed } | 409 { error }
 *   GET  /ctl/settings                             -> SettingsModel
 *   GET  /ctl/worktrees/:daemonId/delete-info      -> worktree_delete_info payload
 *   POST /ctl/spawn    {cwd, template?, name?, labels?} -> DaemonEntry
 *   POST /ctl/enroll  {name, labels?, cwd?, callbackUrl?} → 201 {entry, enrollment}
 *   POST /ctl/provision {name, labels?}            → DaemonEntry (spawn hook)
 *   POST /ctl/stop     {selector}                  → { stopped: string[] }
 *   POST /ctl/remove   {selector}                  → { removed: string[] }
 *   POST /ctl/prompt   {selector, text, waitMs?}   → PromptResult[] | { submitted: string[] }
 *   POST /ctl/settings/set {path, value, expectedRevision?, layer?}   -> SettingsModel (400 bad path/value/layer, 409 stale revision)
 *   POST /ctl/settings/unset {path, expectedRevision?, layer?}        -> SettingsModel (same errors)
 *   GET  /ctl/plugins                                 -> installed plugin summaries
 *   GET  /ctl/plugins/:name                           -> one plugin's config detail
 *   POST /ctl/plugins/:name/enabled {enabled}         -> detail after enable/disable
 *   POST /ctl/plugins/:name/features {features|null}  -> detail after feature selection
 *   POST /ctl/plugins/:name/setting {key, value|null} -> detail after setting write (null clears)
 *   POST /ctl/projects/:id/worktrees               -> create or add-existing worktree -> 201 { entry }
 *   DELETE /ctl/worktrees/:daemonId {deleteBranch?} -> worktree: stop -> remove entry -> git worktree remove
 *                    (clone workspace: verify-at-deletion gate, P7.3/P7.5)
 *   GET  /ctl/logs/orphans                         -> orphaned log-store subtrees (P7.6)
 *   POST /ctl/logs/purge {workspaceId}             -> explicit manual purge (P7.6)
 *   POST /ctl/workspaces/:id/resume-clone {sessionId, profileId?} -> fresh clone
 *                    at the pinned commit + transcript materialization + resume (P8.10)
 *
 * Browser auth (P2.2/P2.3, optional): when an operator access token is
 * configured (OMP_FLEET_BROWSER_TOKEN / --browser-access-token /
 * config browserAccessToken), the same Bun.serve additionally mounts:
 *
 *   POST /auth/login    {accessToken}  → Set-Cookie omp_session + {csrfToken, expiresAt}
 *   POST /auth/logout                  → revoke the session cookie
 *   GET  /auth/session                 → { sessionIdHash, csrfToken, expiresAt } | 401
 *
 * Non-loopback peers must then hold a live browser session for /ctl/* and the
 * edge browser routes; mutations additionally need X-Omp-Csrf + an allowed
 * Origin. Loopback peers stay exempt (the CLI precedent, R14). With no token
 * configured every route behaves exactly as before. /callback/* is NEVER
 * gated by browser auth: the DaemonTransportRegistry authenticates it with
 * the workspace enrollment credentials (P3.3, mounted first for that prefix).
 *
 * /ctl/provision runs config.spawnHook via `sh -c` with env OMP_HOOK_NAME /
 * OMP_HOOK_LABELS plus the OMP_SESSION_CALLBACK_* enrollment vars and a 60s
 * deadline. Exit 0 registers an enrolled remote entry; the hook starts the
 * session on its host. 400 when no hook is configured; 502 on hook failure
 * (the entry is removed).
 *
 * Errors: 400 invalid JSON / validation failure, 404 empty selector match,
 * 405 wrong method, 500 {error} on anything else. `waitMs` absent on
 * /ctl/prompt dispatches fire-and-forget: each match gets the prompt in the
 * background and the route returns { submitted } without awaiting the turn.
 *
 * Sessions dial the control plane over the callback pair; the fleet never
 * dials a session. Spawned children are supervised here, remote sessions are
 * enrolled and started by the operator on their host (`omp-web enroll`).
 */

import type { Server } from "bun";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DaemonStatus, RegisteredProject, PublicProviderProfile } from "#lib/wire/protocol";
import type { FleetConfig } from "./config";
import { expandTilde, loadConfig, resolveConfigPath } from "./config";
import { toPublicProfile } from "./provider-profile";
import { isLoopbackHost } from "#lib/platform/hosts";
import { acquireFileLock, type FileLock } from "#lib/platform/file-lock";
import type { DeletionGateError, RegistryEntry } from "./registry";
import { REDIAL_GRACE_MS, Registry } from "./registry";
import { sessionLiveness } from "./session-liveness";
import { validateProjectPath } from "./discovery";
import { matchSelector } from "./selectors";
import {
	SpawnSupervisor,
	enrollSessionCredential,
	releaseSessionCredential,
	withCallbackEnv,
} from "./supervisor";
import { realpathOf } from "./worktrees";
import type { FanoutDeps } from "./fanout";
import { fanOut } from "./fanout";
import { FleetEdge, toRosterEntry } from "./edge";
import { FleetEventLog, type FleetFacts } from "./events";
import {
	createFleetSettings,
	FleetSettingsError,
	type FleetSettings,
	type FleetSettingsOptions,
	type SettingsLayer,
} from "./settings";
import { createFleetPlugins, type FleetPlugins } from "./plugins";
import {
	parseFeatureSelection,
	PluginConfigError,
	type PluginStore,
} from "#lib/plugins/installed-plugins";
import { createStatsApp } from "./stats-app";
import type { StatsConfig } from "./stats-config";
import { BrowserAuthStore, clearSessionCookie } from "./browser-auth";
import { DaemonTransportRegistry } from "./daemon-transport";
import { FleetAuthGate, isLoopbackBind, peerIsLoopback, BrowserAuthError } from "./fleet-auth-gate";
import { compileTrustedProxies } from "./trusted-proxy";
import { CALLBACK_TRANSPORT_STREAM_ID, type CallbackEnvelope } from "#lib/wire/callback-protocol";
import { FleetLogStore, LogStoreError, type LogChunk, type LogIngestResult } from "./log-store";
import { createStoredApp, type StoredApp } from "./stored-sessions";
import { verifyWorkspaceLogs, type VerifyResult } from "./verify-store";
import { prepareWorkspace } from "#lib/runtime/prepare-workspace";
import { runProviderOp } from "#lib/runtime/provider-exec";
import type {
	ProviderHandle,
	ProviderProfile,
	ProviderRequest,
	ProviderResponse,
} from "#lib/runtime/provider-protocol";
import { ENROLLMENT_KEY_BYTES } from "#lib/wire/callback-protocol";
import { createHash, randomBytes } from "node:crypto";
import {
	CloneLifecycleError,
	type CloneCreateInput,
	WorkspaceLifecycle,
} from "./workspace-lifecycle";
import { CloneControlApi, lifecycleStatus } from "./clone-control";
import { materializeMissingSessionFiles, WakeMaterializeError } from "./wake-materialize";
import {
	createWorktree,
	deleteWorktree,
	mergeUnregisteredWorktrees,
	projectIdForCwd,
	registerProjectMainEntry,
	registerWorktreeEntry,
	validateUnregisteredWorktree,
	worktreeDeleteInfo,
	WorktreeDirtyError,
	WorktreeTargetExistsError,
	type CreateWorktreeResult,
} from "./worktrees";

const DEFAULT_PORT = 4722;
// P3.8 fleet log-store ack batching (docs/clone-contracts.md "Session log
// streaming"): log_ack controls ride the reserved transport stream once per
// batch. Batches flush when the accumulated-chunk budget is hit or the
// time budget elapses, whichever comes first; a high-churn session acking
// every 64 chunks bounds control chatter to ~16/s, and a quiet tail still
// acks within a second of each durable append.
const LOG_ACK_FLUSH_MS = 1_000;
const LOG_ACK_BATCH_MAX = 64;

/**
 * Post-verification provider/storage deletion hook (P7.5 step 4). P5
 * providers implement this; the local-clone default removes the workspace
 * volume after the store flipped read-only. Never removes the store, and the
 * roster removal happens AFTER this resolves (or is left delete-pending-
 * retry with remainingResources when it partially fails).
 */
export interface WorkspaceResourceDeleter {
	/** Delete the provider volume for a verified workspace; throws to leave remainingResources recorded. */
	deleteWorkspaceResources(workspaceId: string, entry: RegistryEntry): Promise<void>;
}

/**
 * Resume-onto-fresh-clone provider hook (P8.10). P5 providers implement
 * spawn; the DEFAULT fleet has NO clone provider yet, so the hook is absent
 * and the resume-clone route fails typed `unavailable` (never a fake spawn).
 */
export interface CloneResumeSpawner {
	/**
	 * Spawn the daemon for a freshly provisioned clone volume at
	 * `workspaceRoot` with a callback pair to the fleet, resuming
	 * `sessionId`. `volumeRoot` is the prepared workspace volume (contains
	 * `.checkout/`, `.home/`, `.omp-workspace-init.json`).
	 */
	spawnCloneResume(opts: {
		workspaceId: string;
		generation: number;
		volumeRoot: string;
		sessionId: string;
	}): Promise<{ endpoint?: string }>;
}

/**
 * Historical transcripts/stats API (read-only stats.db + session files),
 * mounted under /ctl/stats by the control plane. One instance per FleetServer,
 * created inside the constructor (it can then receive the log store); closed
 * in close(). The module-level singleton this replaced could not.
 */

/** Control plane as consumed by the CLI (and, in Phase 3, the edge server). */
export interface FleetServer {
	port: number;
	registry: Registry;
	supervisor: SpawnSupervisor;
	/** Daemon transport registry (callback pairs); tests drive sessions through it. */
	transport: DaemonTransportRegistry;
	/** Fleet lifecycle-event ring (backing /ctl/debug; CLI mirrors it to stdout). */
	eventLog: FleetEventLog;
	/** Durable log store (null when the fleet boots without one); the stored-session and log routes read it. */
	readonly logStore: FleetLogStore | null;
	/** Fleet-wide facts (port/startedAt/state paths) for the banner + /ctl/debug. */
	fleetFacts: FleetFacts;
	close(): Promise<void>;
}

/**
 * Secret-free provider-profile catalog (P1.3): the boot-static config's
 * providerProfiles projected through toPublicProfile, published to the
 * browser on the registered_projects frame and served by GET /ctl/profiles.
 * Absent/empty config → empty catalog (never a failure); values/executables
 * never cross this boundary.
 */
export function publicProfileCatalog(config: {
	providerProfiles?: Record<string, ProviderProfile>;
}): PublicProviderProfile[] {
	return Object.values(config.providerProfiles ?? {}).map((profile) => toPublicProfile(profile));
}

export function resolveStatePath(explicit?: string, configPath?: string): string {
	if (explicit !== undefined && explicit !== "") return resolve(expandTilde(explicit));
	const env = process.env.OMP_FLEET_STATE;
	if (env !== undefined && env !== "") return resolve(expandTilde(env));
	// Default: the state file lives NEXT TO the config file; the first-run
	// data-home choice moves config + state + workspaces together. With no
	// config that is the default data home (~/.omp-web), the historic path.
	return resolve(join(dirname(configPath ?? resolveConfigPath()), "fleet-state.json"));
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

/** `{expectedRevision?, layer?}` for settings writes; semantic checks (stale, project-layer) live in FleetSettings. */
function settingsWriteGuards(body: Record<string, unknown>): {
	expectedRevision: number | undefined;
	layer: SettingsLayer | undefined;
} {
	const expectedRevision = body["expectedRevision"];
	if (expectedRevision !== undefined && typeof expectedRevision !== "number") {
		throw new HttpError(400, "invalid field: expectedRevision");
	}
	const layer = optionalString(body, "layer");
	if (layer !== undefined && layer !== "global" && layer !== "project") {
		throw new HttpError(400, "invalid field: layer");
	}
	return { expectedRevision, layer };
}

/** Worktree route patterns (daemon ids / project ids are [^/]+ segments). */
const PROJECT_WORKTREES_ROUTE = /^\/ctl\/projects\/([^/]+)\/worktrees$/;
const WORKTREE_DELETE_ROUTE = /^\/ctl\/worktrees\/([^/]+)$/;
const WORKTREE_INFO_ROUTE = /^\/ctl\/worktrees\/([^/]+)\/delete-info$/;
/** P8.10 resume-onto-fresh-clone: POST /ctl/workspaces/:id/resume-clone. */
const WORKSPACE_RESUME_CLONE_ROUTE = /^\/ctl\/workspaces\/([^/]+)\/resume-clone$/;
/** Installed-plugin routes; the name segment is URI-encoded (scoped names contain "/"). */
const PLUGIN_DETAIL_ROUTE = /^\/ctl\/plugins\/([^/]+)$/;
const PLUGIN_WRITE_ROUTE = /^\/ctl\/plugins\/([^/]+)\/(enabled|features|setting)$/;

/**
 * Post-verification local clone deletion follows persisted volume provenance,
 * not the current default worktree destination. Validate identity and layout
 * independently so a substituted directory cannot authorize recursive removal.
 */
class LocalCloneResourceDeleter implements WorkspaceResourceDeleter {
	async deleteWorkspaceResources(workspaceId: string, entry: RegistryEntry): Promise<void> {
		const cwd = entry.cwd ?? "";
		if (cwd === "") return; // No volume to remove (a placeholder).
		const workspace = entry.workspace;
		if (workspace?.kind !== "clone" || workspaceId !== entry.daemonId) {
			throw new Error(`refusing to delete non-clone volume: ${workspaceId}`);
		}
		const realCwd = realpathOf(cwd);
		if (realCwd !== join(realpathOf(dirname(cwd)), workspaceId) || basename(cwd) !== workspaceId) {
			throw new Error(`refusing to delete substituted clone volume: ${cwd}`);
		}
		// A missing volume is already removed; never follow a renamed/symlinked
		// checkout or trust a directory name alone as clone creation evidence.
		if (!existsSync(cwd)) return;
		const marker = JSON.parse(readFileSync(join(realCwd, ".omp-workspace-init.json"), "utf8"));
		if (
			!workspace.pinnedRevision ||
			(!workspace.source?.local && !workspace.source?.remote) ||
			marker.workspaceId !== workspaceId ||
			marker.resolvedCommit !== workspace.pinnedRevision ||
			marker.source?.local !==
				(workspace.source?.local ? resolve(workspace.source.local) : undefined) ||
			marker.source?.remote !== workspace.source?.remote ||
			realpathOf(join(realCwd, ".checkout")) !== join(realCwd, ".checkout")
		) {
			throw new Error(`refusing to delete clone volume with mismatched provenance: ${cwd}`);
		}
		// The volume is the workspace root itself: .checkout + .home + the
		// init marker live under it. Remove it as a unit.
		rmSync(realCwd, { recursive: true, force: true });
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
 * Run `config.spawnHook` via `sh -c` with the provision env and a deadline.
 * The child is SIGKILLed on timeout. Exit 0 is success; a non-zero exit or
 * a timeout rejects with a 502 {@link HttpError} (stderr's last line in the
 * message on a non-zero exit).
 */
export async function runSpawnHook(
	hook: string,
	env: Record<string, string>,
	timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<void> {
	const child = Bun.spawn(["sh", "-c", hook], {
		env: { ...process.env, ...env },
		stdout: "ignore",
		stderr: "pipe",
	});
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
	const err = await stderr;
	if (child.exitCode !== 0) {
		const detail = err.trim().split("\n").at(-1);
		throw new HttpError(502, `spawn hook exited ${child.exitCode}${detail ? `: ${detail}` : ""}`);
	}
}

/**
 * Validate a session callback URL: https, or http only on a loopback host
 * (the daemon refuses any other plaintext URL). 400 otherwise.
 */
function requireCallbackUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new HttpError(400, `invalid callback URL: ${raw}`);
	}
	const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
	if (url.protocol !== "https:" && !loopbackHttp) {
		throw new HttpError(400, `callback URL must be https (or http on loopback): ${raw}`);
	}
	return raw;
}

class FleetServerImpl implements FleetServer {
	readonly port: number;
	readonly registry: Registry;
	readonly supervisor: SpawnSupervisor;
	readonly config: FleetConfig;
	readonly edge: FleetEdge;
	readonly fleetSettings: FleetSettings;
	readonly fleetPlugins: FleetPlugins;
	readonly eventLog = new FleetEventLog();
	readonly startedAt: number;
	readonly fleetFacts: FleetFacts;
	/** Optional P2.2/P2.3 browser-session auth; null when disabled (no token
	 *  configured). Loopback peer exemptions + CSRF/origin live behind this. */
	readonly authGate: FleetAuthGate | null;
	/** Optional P3.3 callback enrollment for roster daemons (mirrors the
	 *  daemon-half enrollment the fleet supervisor will hand out in P5). */
	readonly transport: DaemonTransportRegistry;
	/** P3.8 fleet log store; null when the logs dir is not writable at boot.
	 *  Loaded after the state lock is held; closed only in close(). */
	readonly logStore: FleetLogStore | null;
	/** P7.5 post-verification provider/storage deletion hook. The default
	 *  removes a local clone's volume; P5 providers inject their own. */
	readonly resourceDeleter: WorkspaceResourceDeleter;
	/** P8.10 resume-onto-fresh-clone provider spawner; absent = the route
	 *  fails typed `unavailable` (P5 providers inject their own). */
	readonly cloneResumeSpawner: CloneResumeSpawner | null;
	/** P6/P7 clone lifecycle owner (single create/ensure/stop/delete authority). */
	readonly lifecycle: WorkspaceLifecycle;
	/** P1/P8 clones control API (route layer over the lifecycle service). */
	readonly cloneApi: CloneControlApi;
	readonly cloneRoot: string;
	/** State-file lock: taken in startFleet, released in close(). */
	readonly lock: FileLock;

	/** Per-workspace log_ack batching: chunks acked since the last flush. */
	readonly #logAckChunks = new Map<string, Map<string, number>>();
	/** Per-workspace flush timer; one timer per workspace with pending acks. */
	readonly #logAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Per-workspace transport tap unsubscribe; cleared in close(). */
	readonly #logTaps = new Map<string, () => void>();
	/** Callback-pair watch per non-clone entry; unsubscribed in close(). */
	readonly #pairWatches = new Map<string, () => void>();
	/** Boot redial grace timers for enrolled sessions; cleared on pair or close(). */
	readonly #redialTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #redialGraceMs: number;
	/** Historical transcripts/stats API (P8.6): per-instance stats app,
	 *  constructed in the constructor so it can receive the log store when it
	 *  loads; closed in close(). */
	readonly #statsApp: ReturnType<typeof createStatsApp>;
	/** Stored-sessions read API (P8.5): mounted under /ctl/stored once the
	 *  fleet log store loads; null when the store is unavailable. Read-only,
	 *  never wakes compute. */
	readonly storedApp: StoredApp | null = null;

	readonly #server: Server<undefined>;
	/** Boot-time sha-256 digest of the operator browser-access token (the
	 *  store adopts it on first login; the login route verifies against it).
	 *  Empty when auth is disabled (never used). */
	readonly #expectedTokenHash: string;

	/**
	 * daemonIds mid-eviction for a poll-detected, vanished worktree. The
	 * supervisor can fire per poll tick; the first report wins and the set
	 * is cleared when the eviction settles.
	 */
	readonly #evictingWorktrees = new Set<string>();

	constructor(
		registry: Registry,
		config: FleetConfig,
		port: number,
		facts: { statePath: string; configPath: string | null },
		lock: FileLock,
		settingsOptions?: FleetSettingsOptions,
		resourceDeleter?: WorkspaceResourceDeleter,
		cloneResumeSpawner?: CloneResumeSpawner | null,
		statsConfig?: Pick<StatsConfig, "statsDbPath" | "sessionsDir">,
		serveUi = true,
		redialGraceMs = REDIAL_GRACE_MS,
		pluginStore?: () => Promise<PluginStore>,
	) {
		this.registry = registry;
		this.#redialGraceMs = redialGraceMs;
		this.config = config;
		this.lock = lock;
		this.cloneRoot = join(dirname(facts.statePath), "clones");
		this.resourceDeleter = resourceDeleter ?? new LocalCloneResourceDeleter();
		this.cloneResumeSpawner = cloneResumeSpawner ?? null;
		this.startedAt = Date.now();
		this.fleetFacts = {
			port: 0,
			startedAt: this.startedAt,
			statePath: facts.statePath,
			configPath: facts.configPath,
			bind: config.bind,
		};
		this.transport = new DaemonTransportRegistry();
		// P3.8 fleet log store: loaded under the state lock (the state dir is
		// this fleet's alone) so restarts rebuild in-memory offset state from
		// the durable index before any daemon pair streams. A boot-time logs
		// dir that cannot be created/made writable is logged and disables log
		// streaming for this process; it must not take the whole fleet down.
		let logStore: FleetLogStore | null = null;
		try {
			logStore = FleetLogStore.load(join(dirname(facts.statePath), "logs"));
		} catch (err) {
			console.error(
				`fleet: log store unavailable at ${join(dirname(facts.statePath), "logs")}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.logStore = logStore;
		// P8.5/P8.6 stored-sessions + stats store coverage: BOTH consume the
		// same secret-free provenance resolver over live registry records
		// (never tokens/endpoints). Built only when the log store loaded;
		// absent store → storedApp null and stats stays fleet-local-only.
		const storedProvenance = (
			workspaceId: string,
		):
			| {
					projectId: string;
					kind: "clone" | "worktree" | "direct";
					profileId?: string;
					branch?: string;
					pinnedRevision?: string;
					source?: { local?: string; remote?: string };
			  }
			| undefined => {
			const entry = registry.get(workspaceId);
			const record = entry?.workspace;
			if (record === undefined) return undefined;
			return {
				projectId: record.projectId,
				kind: record.kind,
				...(record.profileId !== undefined ? { profileId: record.profileId } : {}),
				...(record.branch !== undefined ? { branch: record.branch } : {}),
				...(record.pinnedRevision !== undefined ? { pinnedRevision: record.pinnedRevision } : {}),
				...(record.source !== undefined ? { source: record.source } : {}),
			};
		};
		if (logStore !== null) {
			this.storedApp = createStoredApp({
				store: logStore,
				provenance: storedProvenance,
			});
			// P8.6: stats mounts the SAME store so /ctl/stats/health reports
			// fleetStore coverage and sessions carry origin/stored labels +
			// dedup. Without this the store stays invisible to stats.
			this.#statsApp = createStatsApp({
				...statsConfig,
				stored: { store: logStore, provenance: storedProvenance },
			});
		} else {
			this.#statsApp = createStatsApp(statsConfig);
		}
		// Boot re-enrollment: enrollments are NOT memory-only. Every roster
		// entry whose workspace record persists a callback-enrollment binding
		// (digest + generation only) is re-enrolled before anything else
		// acts on the roster, so a fleet restart accepts daemon redials with
		// their original credential; the raw credential never survives the
		// process, only its sha-256 digest.
		for (const { workspaceId, enrollment } of this.registry.workspaceEnrollments()) {
			this.transport.enrollPersisted(workspaceId, enrollment.generation, enrollment.credentialHash);
		}
		// Browser auth: hash-only store next to the state file. loopbackDev is
		// ON only when the bind is a loopback address (the explicit dev cookie
		// exception, never inferred for a public bind).
		const loopbackDev = isLoopbackBind(config.bind);
		this.#expectedTokenHash = config.browserAccessTokenHash ?? "";
		const authEnabled = config.browserAccessTokenHash !== undefined;
		// Compiled trusted-proxy rules for the gate. loadConfig already
		// rejects malformed literals, but config objects constructed directly
		// (tests) could carry one; an invalid literal NEVER matches (fail
		// closed), and reaching here at all means the value was a raw config,
		// drop-and-warn rather than silently trusting a subset.
		const { rules: trustedProxyRules, invalid: invalidProxies } = compileTrustedProxies(
			config.trustedProxies ?? [],
		);
		for (const literal of invalidProxies) {
			console.error(`fleet: config: dropped invalid trusted proxy literal "${literal}"`);
		}
		this.authGate = authEnabled
			? new FleetAuthGate({
					enabled: true,
					loopbackDev,
					store: new BrowserAuthStore(join(dirname(facts.statePath), "browser-auth.json"), {
						loopbackDev,
						configuredTokenHash: config.browserAccessTokenHash,
					}),
					browserOrigin: config.browserOrigin,
					trustedProxies: trustedProxyRules,
				})
			: null;
		let edge: FleetEdge | null = null;
		this.supervisor = new SpawnSupervisor(
			registry,
			config,
			{
				transport: this.transport,
				statePath: facts.statePath,
				callbackUrl: () => this.#callbackUrl(),
				onEnrolled: (daemonId) => this.#watchPair(daemonId),
			},
			{
				onEvent: (level, message, daemonId) =>
					this.eventLog.add(level, "supervisor", message, daemonId),
				onWorktreeRemoved: (entry) => void this.#onWorktreeVanished(entry),
			},
		);
		// P6/P7 lifecycle owner: the single create/ensure/stop/delete
		// authority for provider-managed clone workspaces, shared by the
		// control-plane routes and the edge command dispatch. Constructed
		// BEFORE the edge (the edge takes it as a hook object); its deps are
		// registry/config/transport/eventLog/resourceDeleter + injected
		// log-tap attach and callback-URL provider, no edge dependency.
		this.lifecycle = new WorkspaceLifecycle({
			registry,
			config: { providerProfiles: config.providerProfiles },
			cloneRoot: this.cloneRoot,
			transport: this.transport,
			logStore: this.logStore,
			resourceDeleter: this.resourceDeleter,
			eventLog: this.eventLog,
			attachLogTap: (workspaceId) => this.#attachLogStoreTap(workspaceId),
			callbackUrl: () => this.#callbackUrl(),
		});
		this.cloneApi = new CloneControlApi({
			lifecycle: this.lifecycle,
			registry,
			config: { providerProfiles: config.providerProfiles },
			eventLog: this.eventLog,
		});
		// Historical transcripts/stats API (P8.6): per-instance, constructed
		// with the log store (fleetStore coverage) once the store loads in the
		// block above; never a bare store-less app.
		edge = new FleetEdge({
			registry,
			supervisor: this.supervisor,
			config,
			eventLog: this.eventLog,
			fleet: this.fleetFacts,
			transport: this.transport,
			lifecycle: this.lifecycle,
			logStore: this.logStore ?? undefined,
			providerProfiles: publicProfileCatalog(config),
			serveUi,
		});
		this.edge = edge;
		// Unattached settings service (the fleet control plane's /ctl/settings): lazy
		// Settings.init + ModelRegistry, no live session required. Injectable
		// provider source for tests (must not open the real auth DB).
		this.fleetSettings = createFleetSettings(settingsOptions);
		this.fleetPlugins = createFleetPlugins({ openStore: pluginStore });
		// #3: statuses persisted by a previous fleet process describe dead
		// children/sockets; map them to a truthful boot state and redial
		// remote entries BEFORE anything else starts acting on the roster.
		this.#reconcileBootStatuses();
		// Tag pre-existing local entries with their owning repo (roster
		// grouping); per-entry git failures are swallowed inside.
		void this.supervisor.backfillWorktrees();
		// Keep branch + dirty counts fresh for local entries; close() clears
		// the timer via supervisor.close().
		this.supervisor.startGitStatePolling();
		this.#server = Bun.serve({
			hostname: config.bind,
			port,
			// SSE responses are long-lived and quiet between 15s keepalive
			// pings; Bun's default 10s fetch idleTimeout would kill them.
			idleTimeout: 0,
			fetch: (req, srv) => this.#fetch(req, srv.requestIP(req)?.address),
		});
		this.port = this.#server.port!;
		this.fleetFacts.port = this.port;
		// P6.3: provider-managed clone workspaces reconcile SEPARATELY; their
		// compute survived the restart (it is not an in-memory child), so the
		// legacy boot downgrade above must never touch them. Runs AFTER the
		// port binds so checkout callbacks dial a real address. Inspect-
		// before-act: reattach live sandboxes, recreate desired-running ones,
		// leave desired-stopped ones alone. Fire-and-forget; failures log.
		void this.lifecycle.reconcile();
		// P8.9 wake materialization: the transport serves stored session
		// bytes over the bulk channel from this store.
		if (this.logStore !== null) {
			this.transport.setMaterializeStore(this.logStore);
			// Log taps ride the daemon callback pairs. Enrollment is the tap's
			// gate (the transport authenticates every envelope against it).
			// Boot enrollments above include persisted re-enrollments (a fleet
			// restart accepts daemon redials with their original credential),
			// so the static attach below covers every tap the fleet will ever
			// need; runtime attach on enrollment is added with P5.
			for (const workspaceId of this.transport.enrolledWorkspaceIds()) {
				this.#attachLogStoreTap(workspaceId);
			}
		}
	}

	async close(): Promise<void> {
		const errors: unknown[] = [];
		try {
			this.edge.close();
		} catch (err) {
			errors.push(err);
		}
		// Unsubscribe before transport.close() so a pair dropping during
		// shutdown cannot write status. Sessions keep running; enrollments stay.
		for (const unwatch of this.#pairWatches.values()) unwatch();
		this.#pairWatches.clear();
		for (const timer of this.#redialTimers.values()) clearTimeout(timer);
		this.#redialTimers.clear();
		this.#closeLogStoreWiring();
		try {
			this.transport.close();
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
			this.lifecycle.close();
		} catch (err) {
			errors.push(err);
		}
		try {
			this.#statsApp.close();
		} catch (err) {
			errors.push(err);
		}
		// Release the state lock last: another fleet may start on this state
		// path once everything above is torn down. release() never throws.
		this.lock.release();
		if (errors.length > 0) throw errors[0];
	}

	// --- fleet log store (P3.8; docs/clone-contracts.md "Fleet log store") ---

	/**
	 * Per-workspace log-frame tap: durability-append daemon log chunks and
	 * ack via batched transport controls. Attached at startup for every
	 * enrolled workspace (transport enrollments are never revoked at
	 * runtime today, so the static attach covers the live fleet). Unknown
	 * workspaces never reach here: the transport gates every envelope by
	 * enrollment. Also fire-and-forget (a slow disk must not stall the
	 * daemon connection pump); the daemon's ring window absorbs slack and
	 * its acked-offset resume point is only ever advanced by acked chunks.
	 */
	#attachLogStoreTap(workspaceId: string): void {
		if (this.#logTaps.has(workspaceId)) return;
		const store = this.logStore;
		if (store === null) return;
		const unsubscribe = this.transport.onDaemonEnvelope(workspaceId, (envelope) => {
			this.#onLogEnvelope(store, workspaceId, envelope);
		});
		this.#logTaps.set(workspaceId, unsubscribe);
	}

	/**
	 * One daemon callback envelope on a log-tapped workspace. Frame chunks
	 * append to the store; a `control` envelope carrying the additive
	 * workspace-side session-deletion notice (P7.6) purges that session's
	 * fleet copy; the workspace wins. Read-only workspaces refuse the purge
	 * (their verified store is Retention's; explicit purgeWorkspace is the
	 * manual path).
	 */
	#onLogEnvelope(store: FleetLogStore, workspaceId: string, envelope: CallbackEnvelope): void {
		if (envelope.kind === "control") {
			const payload = envelope.payload as { type?: unknown; sessionId?: unknown };
			if (payload?.type === "session_deleted") {
				const sessionId = payload.sessionId;
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				try {
					store.purgeSession(workspaceId, sessionId);
				} catch {
					// Read-only (verified) or invalid id: the workspace's
					// verified state wins; nothing to surface.
				}
			}
			return;
		}
		if (envelope.kind !== "frame") return;
		const streamId = envelope.streamId;
		if (!streamId.startsWith("logs/")) return;
		const rest = streamId.slice("logs/".length);
		const slash = rest.indexOf("/");
		if (slash <= 0) return; // Malformed; nothing to append.
		const sessionId = rest.slice(0, slash);
		const relpath = rest.slice(slash + 1);
		if (relpath.length === 0) return;
		let result: LogIngestResult;
		try {
			result = store.ingest(workspaceId, sessionId, relpath, envelope.payload as LogChunk);
		} catch (err) {
			// Read-only (verified), invalid ids/paths, or a malformed chunk:
			// the workspace's verified state wins; nothing to ack. A truly
			// unexpected store failure (disk) is surfaced once per workspace.
			if (err instanceof LogStoreError && err.code !== "read_only") {
				console.error(`fleet: log store rejected ${streamId} (${err.code}): ${err.message}`);
			}
			return;
		}
		if (result.status === "acked") {
			const pending = this.#pendingLogAcks(workspaceId);
			pending.set(streamId, result.offset);
			this.#armLogAckFlush(workspaceId);
			if (pending.size >= LOG_ACK_BATCH_MAX) this.#flushLogAcks(workspaceId);
		} else if (result.status === "gap") {
			// The daemon owns repair: it re-streams [from, to) once this
			// lands. Sent immediately; the gap is a stall, not chatter.
			// The envelope's streamId names the AFFECTED log stream (the
			// daemon half's handleControl requires it: controls on the
			// reserved transport stream carry the target in the payload or
			// the envelope, and a missing target is an invalid_request; a
			// mid-file hole would otherwise gap-lock permanently).
			void this.transport
				.sendToDaemon(workspaceId, {
					streamId,
					kind: "control",
					payload: { type: "log_gap", from: result.from, to: result.to },
				})
				.then(
					() => {
						// Sent; the daemon repairs.
					},
					() => {
						// No live pair; the daemon's ring/continuity check
						// will re-raise the same gap after reconnect.
					},
				);
		}
		// duplicate / obsolete: post-reconnect re-send below the acked
		// offset, or a stale generation; nothing to do.
	}

	/** Pending log_ack offsets per stream, flushed when a flush lands. */
	#pendingLogAcks(workspaceId: string): Map<string, number> {
		let pending = this.#logAckChunks.get(workspaceId);
		if (pending === undefined) {
			pending = new Map();
			this.#logAckChunks.set(workspaceId, pending);
		}
		return pending;
	}

	#armLogAckFlush(workspaceId: string): void {
		if (this.#logAckTimers.has(workspaceId)) return;
		const timer = setTimeout(() => {
			this.#flushLogAcks(workspaceId);
		}, LOG_ACK_FLUSH_MS);
		this.#logAckTimers.set(workspaceId, timer);
	}

	/**
	 * Send one batched control envelope to the daemon with every pending
	 * acked offset, then clear the batch. Never throws.
	 */
	#flushLogAcks(workspaceId: string): void {
		const timer = this.#logAckTimers.get(workspaceId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#logAckTimers.delete(workspaceId);
		}
		const pending = this.#logAckChunks.get(workspaceId);
		if (pending === undefined || pending.size === 0) return;
		this.#logAckChunks.delete(workspaceId);
		const offsets: Record<string, number> = {};
		for (const [streamId, offset] of pending) offsets[streamId] = offset;
		void this.transport
			.sendToDaemon(workspaceId, {
				streamId: CALLBACK_TRANSPORT_STREAM_ID,
				kind: "control",
				payload: { type: "log_ack", offsets },
			})
			.then(
				() => {
					// Sent; nothing further to do.
				},
				() => {
					// No live down half (reconnect in progress): the batch is
					// dropped; the daemon re-streams from its last acked
					// offset once the pair is live again, so nothing is lost.
				},
			);
	}

	/** Cancel pending log-ack flush timers and detach all taps (close()). */
	#closeLogStoreWiring(): void {
		for (const timer of this.#logAckTimers.values()) clearTimeout(timer);
		this.#logAckTimers.clear();
		this.#logAckChunks.clear();
		for (const unsubscribe of this.#logTaps.values()) unsubscribe();
		this.#logTaps.clear();
	}

	/**
	 * Watch one entry's callback pair. Idempotent: the watch lives until
	 * close(), so re-enrolling the same daemon keeps its subscription.
	 */
	#watchPair(daemonId: string): void {
		if (this.#pairWatches.has(daemonId)) return;
		this.#pairWatches.set(
			daemonId,
			this.transport.onPairChange(daemonId, (status) =>
				this.#onPairChange(daemonId, status.paired),
			),
		);
	}

	/** Drops a removed entry's pair watch and any pending redial grace. */
	#forgetPair(daemonId: string): void {
		this.#pairWatches.get(daemonId)?.();
		this.#pairWatches.delete(daemonId);
		this.#logTaps.get(daemonId)?.();
		this.#logTaps.delete(daemonId);
		this.#clearRedialGrace(daemonId);
	}

	/**
	 * Pair transitions drive the status of non-clone entries: a paired session
	 * is "ready"; a session that loses its pair while ready is "reconnecting".
	 * Connecting/asleep/error belong to the supervisor, so pair loss in those
	 * states changes nothing here.
	 */
	#onPairChange(daemonId: string, paired: boolean): void {
		const entry = this.registry.get(daemonId);
		if (entry === undefined || entry.workspace?.kind === "clone") return;
		if (paired) {
			this.#clearRedialGrace(daemonId);
			if (entry.status === "ready") return;
			this.registry.update(daemonId, { readyAt: Date.now() });
			this.#setDaemonStatus(daemonId, "ready");
		} else if (entry.status === "ready") {
			this.#setDaemonStatus(daemonId, "reconnecting");
		}
	}

	/**
	 * Status transition driven by the callback pair: registry write, the
	 * `daemon_status` broadcast, and the event ring.
	 */
	#setDaemonStatus(daemonId: string, status: DaemonStatus, error?: string): void {
		this.registry.setStatus(daemonId, status, error);
		const entry = this.registry.get(daemonId);
		if (entry === undefined) return;
		this.edge.onDaemonStatus(entry);
		this.eventLog.add(
			status === "error" ? "error" : status === "reconnecting" ? "warn" : "info",
			"server",
			status === "error" ? `error: ${error ?? "error"}` : status,
			daemonId,
		);
	}

	/** Boot grace: an enrolled session that has not redialed by the deadline is shown asleep. */
	#armRedialGrace(daemonId: string): void {
		const timer = setTimeout(() => {
			this.#redialTimers.delete(daemonId);
			if (this.registry.get(daemonId)?.status !== "reconnecting") return;
			this.#setDaemonStatus(daemonId, "asleep");
		}, this.#redialGraceMs);
		this.#redialTimers.set(daemonId, timer);
	}

	#clearRedialGrace(daemonId: string): void {
		const timer = this.#redialTimers.get(daemonId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#redialTimers.delete(daemonId);
	}

	/**
	 * Reconcile statuses persisted by a previous fleet process. A local spawned
	 * session proven dead by its live file lock or recorded pid becomes "asleep"
	 * immediately, as does an unenrolled entry. Other enrolled non-clone entries
	 * stay "reconnecting" until their pair returns or the redial grace expires.
	 * Remote entries are never probed. Inspect liveness before clearing stale
	 * readyAt and pid facts. Clones are reconciled by the workspace lifecycle.
	 */
	#reconcileBootStatuses(): void {
		for (const entry of this.registry.list()) {
			if (entry.workspace?.kind === "clone") continue;
			const enrolled = entry.workspace?.enrollment !== undefined;
			if (enrolled) this.#watchPair(entry.daemonId);
			if (entry.status === "asleep" || entry.status === "error") continue;
			const verdict = sessionLiveness(entry);
			const previousStatus = entry.status;
			const target: DaemonStatus = !enrolled || verdict === "dead" ? "asleep" : "reconnecting";
			const reason = !enrolled
				? "not enrolled"
				: verdict === "dead"
					? "local session dead"
					: verdict === "alive"
						? "local session alive"
						: "liveness unknown";
			this.registry.update(entry.daemonId, { readyAt: undefined, pid: undefined });
			this.registry.setStatus(entry.daemonId, target);
			this.eventLog.add(
				"info",
				"server",
				`boot reconcile: ${previousStatus} → ${target} (${reason})`,
				entry.daemonId,
			);
			if (target === "reconnecting") this.#armRedialGrace(entry.daemonId);
		}
	}

	/**
	 * POST /ctl/start {daemonId} (alias POST /ctl/wake): the fleet-side
	 * ensure-running entry point for CLONE workspaces (P6.1). Direct/template
	 * spawns keep their existing path (/ctl/spawn + supervisor); this route
	 * only ever runs provider-managed clone entries. On success the workspace
	 * record rides: fresh enrollment (credential persistence for the callback
	 * pair), provider handle, and desiredState "running". A missing or
	 * untyped profile is a typed `unavailable`, never a fake spawn.
	 */
	async #handleStart(req: Request): Promise<Response> {
		const body = await readJson(req);
		const daemonId = requireString(body, "daemonId");
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		if (entry.workspace?.kind !== "clone") {
			throw new HttpError(
				400,
				`daemon ${daemonId} is not a clone workspace (kind ${entry.workspace?.kind ?? "legacy"}); ` +
					"start a worktree/direct session through /ctl/spawn",
			);
		}
		// P6.1: the single lifecycle owner. Never HTTP-self-fetch; resolves
		// when the provider confirms compute running + enrollment persisted;
		// callback→ready rides the roster (lifecycleStage broadcasts).
		// Typed lifecycle failures map onto the same frozen HTTP statuses
		// as create/remove/delete (an uncertain-predecessor conflict is a
		// 409, never an untyped 500).
		try {
			await this.lifecycle.ensureCloneRunning(daemonId);
		} catch (err) {
			if (err instanceof CloneLifecycleError) {
				throw new HttpError(lifecycleStatus(err.code), err.message);
			}
			throw new HttpError(
				500,
				`clone start failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return json({
			daemonId,
			observed: "running",
		});
	}

	#fanoutDeps(): FanoutDeps {
		// P6.1 fanout trigger: prompt/wake for clones goes through the same
		// lifecycle owner; spawned and remote entries wake via the supervisor
		// and the callback pair (transport).
		return {
			registry: this.registry,
			supervisor: this.supervisor,
			transport: this.transport,
			lifecycle: this.lifecycle,
		};
	}

	/** Fleet callback base URL the sandbox daemon dials for the pair. */
	#callbackUrl(): string {
		// Explicit operator override wins; otherwise derive from the fleet's
		// own bind+port (loopback http for a loopback bind, which the daemon
		// accepts under OMP_SESSION_CALLBACK_ALLOW_HTTP=1).
		const explicit = process.env.OMP_FLEET_CALLBACK_URL;
		if (explicit !== undefined && explicit !== "") return explicit.replace(/\/+$/, "");
		return `http://${this.config.bind}:${this.port}`;
	}

	#fetch = async (req: Request, remoteAddress?: string | null): Promise<Response> => {
		const url0 = new URL(req.url);
		const path0 = url0.pathname;
		// /callback/* is the transport's, mounted BEFORE everything else and
		// NEVER gated by browser auth: the registry authenticates with the
		// workspace enrollment credentials (the callback pair from the fleet's
		// host daemon in this pass; daemon-session pairs in P5).
		if (path0.startsWith("/callback")) {
			const transportHandled = await this.transport.handleFetch(req);
			if (transportHandled !== null) return transportHandled;
		}
		// Browser auth: /auth/* is public (the login/session/logout surface),
		// mounted BEFORE the browser-session gate so the client can always
		// probe. Disabled (no token configured) → the session route still
		// answers 404 and everything below behaves exactly as before.
		if (path0.startsWith("/auth/")) return await this.#handleAuth(req);
		// Everything remaining is protected when browser auth is enabled:
		// the edge's browser routes (/events, /command, /ctl/*, static) AND
		// the control-plane /ctl/* routes. Non-loopback clients must hold a
		// live browser session; mutations additionally need the X-Omp-Csrf
		// header and an allowed Origin. Loopback clients (CLI + local UI
		// dev) are exempt; the R14 precedent, so fleet/cli.ts keeps
		// working. The client is the socket peer unless the peer is a
		// configured trusted proxy, whose X-Forwarded-For first hop wins
		// (P2.3); forwarded headers from any untrusted peer are ignored, so
		// a non-loopback deployment behind an unlisted proxy still requires
		// a session.
		if (this.authGate !== null) {
			// Data routes (/events, /command, /ctl/*) and every mutation are
			// gated. The static UI shell stays public: it carries no data, and
			// the client must boot to reach /auth/login at all. A fresh browser
			// loads the shell, probes /auth/session (404 disabled / 401
			// signed-out), and signs in from there.
			const isDataRoute = path0 === "/events" || path0 === "/command" || path0.startsWith("/ctl");
			const isMutation = req.method !== "GET" && req.method !== "HEAD";
			if (isDataRoute || isMutation) {
				const client = this.authGate.clientAddress(req, remoteAddress);
				if (!peerIsLoopback(client)) {
					const session = this.authGate.authenticate(req, client);
					if (session === null) return json({ error: "unauthorized" }, 401);
					if (req.method !== "GET" && req.method !== "HEAD") {
						if (!this.authGate.requireCsrf(req, session)) return json({ error: "forbidden" }, 403);
						if (!this.authGate.checkOrigin(req)) return json({ error: "forbidden" }, 403);
					}
				}
			}
		}
		// Edge routes first: /events (SSE), /command (POST), the /ctl routes,
		// and static dist. null = not an edge route.
		const edgeHandled = await this.edge.handleFetch(req);
		if (edgeHandled !== null) return edgeHandled;
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			// Historical transcripts/stats API: /ctl/stats/* is stats-owned
			// (statsApp returns null for unowned paths; the control-plane
			// switch below owns the 404/405 for those).
			if (path.startsWith("/ctl/stats")) {
				const statsHandled = await this.#statsApp.handleFetch(req, url);
				if (statsHandled !== null) return statsHandled;
			}
			if (path.startsWith("/ctl/stored") && this.storedApp !== null) {
				const storedHandled = await this.storedApp.handleFetch(req, url);
				if (storedHandled !== null) return storedHandled;
			}
			if (req.method === "GET") {
				// Delete-confirmation evidence for one worktree daemon.
				const infoMatch = WORKTREE_INFO_ROUTE.exec(path);
				if (infoMatch) return await this.#handleWorktreeDeleteInfo(infoMatch[1]);
				// Installed-plugin detail: GET /ctl/plugins/:name (name URI-encoded).
				const pluginMatch = PLUGIN_DETAIL_ROUTE.exec(path);
				if (pluginMatch) {
					return await this.#pluginRoute(() =>
						this.fleetPlugins.get(decodeURIComponent(pluginMatch[1])),
					);
				}
				switch (path) {
					case "/ctl/sessions":
						return json(this.registry.list().map(toRosterEntry));
					case "/ctl/profiles":
						// P1.3: secret-free provider-profile catalog for CLI/browser.
						return json(this.cloneApi.profiles());
					case "/ctl/projects": {
						// The registered set is the only project source (no root
						// scanning). Each registered project also contributes its
						// unregistered linked worktrees (deduped by realpath,
						// roster cwds excluded).
						const projects = await mergeUnregisteredWorktrees(
							this.registry.projects(),
							this.registry.list().map((entry) => entry.cwd),
						);
						return json({ projects, registered: this.registry.projects() });
					}
					case "/ctl/plugins":
						// Installed-plugin list: unattached fleet, lock-file backed.
						return await this.#pluginRoute(() => this.fleetPlugins.list());
					case "/ctl/settings":
						// Unattached settings model: the fleet service lazily
						// initializes the process-global Settings singleton +
						// ModelRegistry, no session.
						return json(await this.fleetSettings.getModel());
					case "/ctl/logs/orphans":
						// P7.6: log-store subtrees with no live roster identity
						// (deleted-without-verification workspaces), never
						// auto-GC'd; explicit POST /ctl/logs/purge removes them.
						return json(await this.#handleLogOrphans());
					default:
						return json({ error: "not found" }, 404);
				}
			}
			if (req.method === "POST") {
				// Create-new ({name, baseRef?, existingBranch?, start?}) or
				// add-existing ({worktreePath, start?}) for one project.
				const worktreesMatch = PROJECT_WORKTREES_ROUTE.exec(path);
				if (worktreesMatch) return await this.#handleCreateOrAddWorktree(req, worktreesMatch[1]);
				// Installed-plugin writes: POST /ctl/plugins/:name/{enabled|features|setting}.
				const pluginWriteMatch = PLUGIN_WRITE_ROUTE.exec(path);
				if (pluginWriteMatch) {
					return await this.#handlePluginWrite(req, pluginWriteMatch[1], pluginWriteMatch[2]);
				}
				switch (path) {
					case "/ctl/projects":
						return await this.#handleAddProject(req);
					case "/ctl/clones":
						// P1.3/P8: create a clone workspace (frozen contract).
						// Validate the payload, then delegate ENTIRELY to the
						// lifecycle service, the same create the edge uses.
						return await this.#handleCreateClone(req);
					case "/ctl/spawn":
						return await this.#handleSpawn(req);
					case "/ctl/enroll":
						return await this.#handleEnroll(req);
					case "/ctl/provision":
						return await this.#handleProvision(req);
					// P6.1 clone lifecycle: ensure-running / wake for a
					// provider-managed clone workspace (P8 UI rides later).
					case "/ctl/start":
					case "/ctl/wake":
						return await this.#handleStart(req);
					case "/ctl/stop":
						return await this.#handleStop(req);
					case "/ctl/remove":
						return await this.#handleRemove(req);
					case "/ctl/prompt":
						return await this.#handlePrompt(req);
					case "/ctl/settings/set":
						return await this.#handleSettingsWrite(req, false);
					case "/ctl/settings/unset":
						return await this.#handleSettingsWrite(req, true);
					case "/ctl/logs/purge":
						// P7.6 explicit manual purge of orphaned (or verified
						// read-only) workspace logs. Never automatic.
						return await this.#handleLogPurge(req);
					case "/ctl/auth/revoke-all":
						// P2.2 browser-session lifecycle: revoke every session,
						// then clear the cookie. Mutations inherit the
						// session + CSRF + origin gate (GET-only would be
						// a no-op; this is a mutation).
						if (this.authGate === null) break;
						this.authGate.revokeAll();
						return new Response(JSON.stringify({ ok: true }), {
							headers: {
								"content-type": "application/json",
								"set-cookie": clearSessionCookie(isLoopbackBind(this.config.bind)),
							},
						});
					case "/ctl/auth/rotate-token": {
						// P2.2: rotate the operator access token (hash in,
						// sessions revoked, cookie cleared).
						if (this.authGate === null) break;
						const authBody = await readJson(req);
						const accessToken =
							typeof authBody.accessToken === "string" ? authBody.accessToken : "";
						if (accessToken === "") {
							throw new HttpError(400, "missing or invalid field: accessToken");
						}
						const hash = createHash("sha256").update(accessToken, "utf8").digest("hex");
						this.authGate.rotateAccessToken(hash);
						return new Response(JSON.stringify({ ok: true }), {
							headers: {
								"content-type": "application/json",
								"set-cookie": clearSessionCookie(isLoopbackBind(this.config.bind)),
							},
						});
					}
					default: {
						const resumeCloneMatch = WORKSPACE_RESUME_CLONE_ROUTE.exec(path);
						if (resumeCloneMatch) {
							return await this.#handleResumeClone(req, resumeCloneMatch[1]);
						}
						return json({ error: "not found" }, 404);
					}
				}
			}
			if (req.method === "DELETE") {
				const projectMatch = /^\/ctl\/projects\/([^/]+)$/.exec(path);
				if (projectMatch) return await this.#handleRemoveProject(projectMatch[1]);
				// DELETE /ctl/worktrees/:daemonId. Worktree workspaces keep the
				// legacy path (stop → remove entry → git worktree remove)
				// UNCHANGED. Clone workspaces run the verify-at-deletion gate
				// (P7.3/P7.5): admission refusal on active work, writer
				// quiesce, fleet-store verification, read-only flip, provider
				// deletion, THEN roster removal.
				const worktreeMatch = WORKTREE_DELETE_ROUTE.exec(path);
				if (worktreeMatch) return await this.#handleDeleteWorkspace(req, worktreeMatch[1]);
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

	async #handleAuth(req: Request): Promise<Response> {
		// /auth/* is PUBLIC by design (it IS the login surface); mounted
		// before the browser-session gate. With auth disabled every /auth/*
		// route answers 404 so clients probe the disabled state.
		if (this.authGate === null) return json({ error: "not found" }, 404);
		const url = new URL(req.url);
		const path = url.pathname;
		const gate = this.authGate;
		switch (`${req.method} ${path}`) {
			case "POST /auth/login": {
				let body: Record<string, unknown>;
				try {
					body = await readJson(req);
				} catch (err) {
					if (err instanceof HttpError) return json({ error: err.message }, 400);
					throw err;
				}
				const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
				if (accessToken === "") {
					return json({ error: "missing or invalid field: accessToken" }, 400);
				}
				try {
					const login = gate.login(accessToken, this.#expectedTokenHash);
					return new Response(
						JSON.stringify(gate.sessionBody(login.sessionId, login.csrfToken, login.expiresAt)),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								"set-cookie": login.setCookie,
							},
						},
					);
				} catch (err) {
					if (err instanceof BrowserAuthError) {
						const status = err.code === "unauthorized" ? 401 : 400;
						return json({ error: { code: err.code, message: err.message } }, status);
					}
					throw err;
				}
			}
			case "POST /auth/logout": {
				const sessionId = gate.sessionCookie(req);
				if (sessionId !== null) gate.logout(sessionId);
				return new Response(JSON.stringify({ ok: true }), {
					headers: {
						"content-type": "application/json",
						"set-cookie": clearSessionCookie(isLoopbackBind(this.config.bind)),
					},
				});
			}
			case "GET /auth/session": {
				const resolved = gate.resolveSession(req);
				if (resolved === null) {
					return json({ error: { code: "unauthorized", message: "no session" } }, 401);
				}
				const { session, csrfToken } = resolved;
				return json(gate.sessionBody(session.sessionIdHash, csrfToken, session.expiresAt));
			}
			default:
				return json({ error: "not found" }, 404);
		}
	}
	/** P2.2/P2.3: parse + validate the create_clone payload, then delegate
	 *  entirely to the lifecycle service (the SAME create the edge uses).
	 *  Never performs HTTP self-fetch; no duplicate lifecycle exists. */
	async #handleCreateClone(req: Request): Promise<Response> {
		const body = await readJson(req);
		// Shape-check the payload as CloneCreateInput (the frozen contract).
		const input: CloneCreateInput = {
			projectId: typeof body["projectId"] === "string" ? body["projectId"] : "",
			name: typeof body["name"] === "string" ? body["name"] : "",
			profileId: typeof body["profileId"] === "string" ? body["profileId"] : "",
			source:
				typeof body["source"] === "object" && body["source"] !== null
					? (body["source"] as { local?: string; remote?: string })
					: undefined,
			revision: typeof body["revision"] === "string" ? body["revision"] : undefined,
			branch: typeof body["branch"] === "string" ? body["branch"] : undefined,
			start: typeof body["start"] === "boolean" ? body["start"] : undefined,
		};
		try {
			return await this.cloneApi.createClone(input);
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (err instanceof CloneLifecycleError) {
				throw new HttpError(lifecycleStatus(err.code), err.message);
			}
			throw new HttpError(
				500,
				`clone creation failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async #handleSpawn(req: Request): Promise<Response> {
		const body = await readJson(req);
		const cwd = requireString(body, "cwd");
		const template = optionalString(body, "template");
		const name = optionalString(body, "name");
		const labels = optionalLabels(body);
		// NUL cannot exist in a shell command string; reject it at the
		// boundary. (Quoting in supervisor #launch is the real injection
		// defense; this only keeps NUL out of the wire/state.)
		if (name !== undefined && name.includes("\0")) {
			throw new HttpError(400, "invalid field: name must not contain NUL");
		}
		if (labels !== undefined && labels.some((label) => label.includes("\0"))) {
			throw new HttpError(400, "labels must not contain NUL");
		}
		const resolved = await validateProjectPath(cwd);
		if (resolved === null) throw new HttpError(400, `not a directory: ${cwd}`);
		const entry = await this.supervisor.spawn({ cwd: resolved, template, name, labels });
		// A cwd belonging to a registered project (main checkout or a linked
		// worktree) tags the entry with that projectId so the roster groups it
		// under the project. Unregistered paths stay untagged (fallback group).
		const projectId = await projectIdForCwd(this.registry.projects(), resolved);
		if (projectId !== undefined) this.registry.update(entry.daemonId, { projectId });
		return json(toRosterEntry(this.registry.get(entry.daemonId) ?? entry));
	}

	/**
	 * POST /ctl/projects { path, start?, template?, labels? }: register the
	 * project's realpath (registry.addProject validates + realpath-normalizes
	 * and dedups). A path that is not an existing directory or git repo is
	 * the registry's validation error surfaced as 400; a realpath that is
	 * already registered dedups to the EXISTING project → 409 carrying it.
	 * The project's default workspace is registered via
	 * registerProjectMainEntry: a roster entry for the repo's main checkout
	 * mapped to the repo CWD, never a linked worktree.
	 *   - start:true → the main checkout is spawned (template/labels
	 *     passthrough) and the fresh entry is tagged + returned as `entry`;
	 *   - otherwise → the entry is created asleep (surfacing purely via the
	 *     roster broadcast, wakeable via spawn_resume/attach).
	 * Staged: registration happens first, so a failed spawn reports 500
	 * (stage named in the message) but the project stays registered.
	 * Returns 201 { project, entry? }.
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
		try {
			const entry = await registerProjectMainEntry(this.registry, this.supervisor, project, {
				start,
				template,
				labels,
			});
			// `entry` only when spawned: an asleep default workspace surfaces
			// purely via the roster broadcast.
			return json({ project, ...(start && entry ? { entry: toRosterEntry(entry) } : {}) }, 201);
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
	 * disk); the never-started default workspace (a provably-empty roster
	 * placeholder) is dropped with it. 409 when real roster entries still
	 * reference it; the message names the blocking daemon ids
	 * (registry.removeProject). Unknown ids → 404.
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

	/**
	 * POST /ctl/enroll { name, labels?, cwd?, callbackUrl? }: create a remote
	 * roster entry and mint its callback credential. The token is returned
	 * once; the session host runs `omp-web session` with it and dials the
	 * callback URL. 201 with the public roster projection and the enrollment.
	 */
	async #handleEnroll(req: Request): Promise<Response> {
		const body = await readJson(req);
		const name = requireString(body, "name");
		const labels = optionalLabels(body);
		const cwd = optionalString(body, "cwd");
		const callbackUrl = requireCallbackUrl(
			optionalString(body, "callbackUrl") ?? this.#callbackUrl(),
		);
		const entry = this.registry.create({
			name,
			cwd: cwd ?? "",
			project: cwd ? basename(cwd) : "",
			labels: labels ?? [],
			mode: "remote",
			status: "connecting",
		});
		const enrollment = enrollSessionCredential(this.transport, this.registry, entry.daemonId);
		this.#watchPair(entry.daemonId);
		this.#attachLogStoreTap(entry.daemonId);
		this.eventLog.add("info", "server", `enrolled ${entry.name} (${callbackUrl})`, entry.daemonId);
		return json(
			{
				entry: toRosterEntry(entry),
				enrollment: {
					workspaceId: entry.daemonId,
					generation: enrollment.generation,
					token: enrollment.credential,
					callbackUrl,
				},
			},
			201,
		);
	}

	/**
	 * POST /ctl/provision { name, labels? }: create an enrolled remote entry
	 * and run `config.spawnHook` via `sh -c` with the provision env
	 * (OMP_HOOK_NAME / OMP_HOOK_LABELS plus the callback vars). Hook exit 0
	 * is success; any failure removes the entry and revokes its credential.
	 * 400 when no hook is configured; 502 on hook failure or timeout.
	 */
	async #handleProvision(req: Request): Promise<Response> {
		const hook = this.config.spawnHook;
		if (hook === undefined || hook === "") {
			throw new HttpError(400, "no spawn hook configured");
		}
		const callbackUrl = requireCallbackUrl(this.#callbackUrl());
		const body = await readJson(req);
		const name = requireString(body, "name");
		const labels = optionalLabels(body);
		const entry = this.registry.create({
			name,
			cwd: "",
			project: "",
			labels: labels ?? [],
			mode: "remote",
			status: "connecting",
		});
		const enrollment = enrollSessionCredential(this.transport, this.registry, entry.daemonId);
		this.#watchPair(entry.daemonId);
		this.#attachLogStoreTap(entry.daemonId);
		const env = withCallbackEnv(
			{ OMP_HOOK_NAME: name, OMP_HOOK_LABELS: (labels ?? []).join(",") },
			{ url: callbackUrl, daemonId: entry.daemonId, enrollment },
		);
		try {
			await runSpawnHook(hook, env);
		} catch (err) {
			releaseSessionCredential(this.transport, this.registry, entry.daemonId);
			this.#forgetPair(entry.daemonId);
			this.registry.remove(entry.daemonId);
			throw err;
		}
		this.eventLog.add("info", "server", `provisioned ${entry.name} (spawn hook)`, entry.daemonId);
		return json(toRosterEntry(entry));
	}

	async #handleStop(req: Request): Promise<Response> {
		const body = await readJson(req);
		const selector = requireString(body, "selector");
		const matches = matchSelector(this.registry.list(), selector);
		if (matches.length === 0) throw new HttpError(404, `no daemon matches selector: ${selector}`);
		const stopped: string[] = [];
		for (const entry of matches) {
			if (entry.workspace?.kind === "clone") {
				// P6.5: provider-owned clone; proof-bearing provider stop via
				// the single lifecycle owner (desiredState stopped, status
				// asleep, enrollment revoked). Never the legacy paths.
				await this.lifecycle.stopClone(entry.daemonId);
			} else if (entry.mode === "spawned") {
				await this.supervisor.stop(entry.daemonId);
			} else {
				// Remote entries have no child: stop shuts the session down over
				// the pair if live, then revokes the enrollment.
				await this.supervisor.stop(entry.daemonId);
				this.eventLog.add("info", "server", `stopped (${entry.mode})`, entry.daemonId);
			}
			stopped.push(entry.daemonId);
		}
		return json({ stopped });
	}

	/**
	 * A poll-detected, on-disk worktree removal: the daemon's cwd vanished
	 * between git-state poll ticks (git worktree remove run outside the
	 * fleet). Mirror #handleRemove's eviction: prune/drop + registry.remove
	 * (the roster broadcast rides registry.onChange automatically), then
	 * announce ONE worktree_removed toast. Never fired for UI-initiated
	 * delete_worktree/remove paths, which evict directly and must not toast.
	 */
	async #onWorktreeVanished(entry: RegistryEntry): Promise<void> {
		// P6.3/P7: a clone workspace's compute is provider-owned and its
		// volume never vanishes under it (unlike a git worktree); the
		// lifecycle + boot reconcile own clone eviction. Never route a clone
		// through this legacy worktree-eviction path.
		if (entry.workspace?.kind === "clone") return;
		// Dedup: consecutive poll ticks can report the same vanished worktree
		// before the eviction settles, and a concurrent UI delete_worktree/
		// remove may have already evicted the entry (presence check below).
		if (this.#evictingWorktrees.has(entry.daemonId)) return;
		if (!this.registry.get(entry.daemonId)) return;
		this.#evictingWorktrees.add(entry.daemonId);
		try {
			await this.supervisor.prune(entry.daemonId);
			this.#forgetPair(entry.daemonId);
			this.#markStoreOrphanIfStored(entry);
			this.registry.remove(entry.daemonId);
			this.eventLog.add(
				"info",
				"server",
				`worktree vanished on disk: ${entry.cwd}`,
				entry.daemonId,
			);
			// `this.edge` is assigned AFTER the supervisor in the constructor,
			// but this hook can only fire during git-state polling, which
			// starts after the edge assignment, so optional chaining guards any
			// earlier synchronous trigger regardless.
			this.edge?.announceWorktreeRemoved({
				daemonId: entry.daemonId,
				name: entry.name,
				cwd: entry.cwd,
			});
		} finally {
			this.#evictingWorktrees.delete(entry.daemonId);
		}
	}

	/**
	 * P7.6 orphan provenance: when a roster identity is removed WITHOUT a
	 * passed verification gate but its fleet log-store subtree survives,
	 * persist a storeOrphan marker so Retention can distinguish
	 * deleted-without-verification logs (manual purge only) from verified
	 * read-only history. Never fired for the verified clone-delete path (the
	 * store flips read-only instead); the log store itself is never touched.
	 */
	#markStoreOrphanIfStored(entry: RegistryEntry): void {
		const store = this.logStore;
		if (store === null) return;
		const workspaceId = entry.daemonId;
		if (store.isReadOnly(workspaceId)) return; // Verified; not an orphan.
		// Only mark when a subtree actually exists (a store with no data has
		// nothing to retain).
		if (!existsSync(join(store.rootDir, workspaceId))) return;
		if (this.registry.storeOrphans()[workspaceId] !== undefined) return;
		const gate = entry.workspace?.deletion;
		this.registry.markStoreOrphan(
			workspaceId,
			gate?.state === "delete-pending-retry"
				? `removed while deletion was pending retry (${gate.error?.code ?? "retryable"}); logs kept as orphaned`
				: "removed without deletion verification; logs kept as orphaned",
		);
	}

	async #handleRemove(req: Request): Promise<Response> {
		const body = await readJson(req);
		const selector = requireString(body, "selector");
		const matches = matchSelector(this.registry.list(), selector);
		if (matches.length === 0) throw new HttpError(404, `no daemon matches selector: ${selector}`);
		const removed: string[] = [];
		let verified: string[] = [];
		for (const entry of matches) {
			if (entry.workspace?.kind === "clone") {
				// P7.5: clone-safe remove MUST route through the SAME verified
				// gate as DELETE; no kind-blind roster eviction can bypass
				// it. The lifecycle owner runs the whole gate (admission →
				// quiesce → Git guard → store verification → read-only flip →
				// provider deletion → volume deletion → roster removal).
				try {
					const result = await this.lifecycle.deleteClone(entry.daemonId);
					verified.push(...result.verified);
				} catch (err) {
					if (err instanceof CloneLifecycleError) {
						throw new HttpError(lifecycleStatus(err.code), err.message);
					}
					throw err;
				}
			} else {
				// Legacy direct/worktree eviction: prune drops the per-daemon
				// supervisor state and revokes the enrollment, so a removed
				// daemon leaks nothing.
				await this.supervisor.prune(entry.daemonId);
				this.#forgetPair(entry.daemonId);
				this.#markStoreOrphanIfStored(entry);
				this.registry.remove(entry.daemonId);
			}
			this.eventLog.add("info", "server", "removed", entry.daemonId);
			removed.push(entry.daemonId);
		}
		return json({ removed, ...(verified.length > 0 ? { verified } : {}) });
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
	 * POST /ctl/settings/set {path, value, expectedRevision?, layer?} and
	 * POST /ctl/settings/unset {path, expectedRevision?, layer?}: coerce +
	 * persist (or remove) one schema setting through the unattached fleet
	 * settings service and return a fresh model. Unknown paths, uncoercible
	 * values and project-layer writes are client errors (400, safe messages);
	 * a stale expectedRevision is 409; anything else falls through to the
	 * request-level 500 catch.
	 */
	async #handleSettingsWrite(req: Request, unset: boolean): Promise<Response> {
		const body = await readJson(req);
		const path = requireString(body, "path");
		const { expectedRevision, layer } = settingsWriteGuards(body);
		try {
			if (unset) return json(await this.fleetSettings.unset(path, expectedRevision, layer));
			// value is arbitrary JSON (boolean/number/string/array/object);
			// coercion happens schema-side, so never requireString it.
			return json(await this.fleetSettings.set(path, body["value"], expectedRevision, layer));
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (err instanceof FleetSettingsError) throw new HttpError(err.status, err.message);
			throw new HttpError(400, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Installed-plugin writes for the unattached fleet (lock-file backed, see
	 * apps/fleet/plugins.ts). Client errors are 400/404 with safe messages and
	 * setting values are never echoed. Secret settings carry only `set`, so no
	 * response can leak a token.
	 */
	async #handlePluginWrite(req: Request, rawName: string, action: string): Promise<Response> {
		const body = await readJson(req);
		return await this.#pluginRoute(() => {
			const name = decodeURIComponent(rawName);
			if (action === "enabled") {
				const enabled = body["enabled"];
				if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
				return this.fleetPlugins.setEnabled(name, enabled);
			}
			if (action === "features") {
				return this.fleetPlugins.setFeatures(name, parseFeatureSelection(body["features"]));
			}
			const key = requireString(body, "key");
			if (!("value" in body)) throw new HttpError(400, "setting value required (null clears it)");
			return this.fleetPlugins.setSetting(name, key, body["value"]);
		});
	}

	/** Maps plugin-service failures to HTTP: client errors keep their status and message. */
	async #pluginRoute(run: () => Promise<unknown>): Promise<Response> {
		try {
			return json(await run());
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (err instanceof PluginConfigError) throw new HttpError(err.status, err.message);
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
			return json({ entry: toRosterEntry(entry) }, 201);
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
		return json({ entry: toRosterEntry(entry) }, 201);
	}

	/**
	 * GET /ctl/worktrees/:daemonId/delete-info: guard evidence for the
	 * delete confirmation (worktree_delete_info payload). Never deletes.
	 */
	async #handleWorktreeDeleteInfo(daemonId: string): Promise<Response> {
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		const info = await worktreeDeleteInfo(entry);
		return json({ daemonId, ...info });
	}

	/**
	 * DELETE /ctl/worktrees/:daemonId. Routes by workspace kind:
	 *   - kind "clone" → the verify-at-deletion gate (P7.3/P7.5);
	 *   - everything else (worktree/direct/legacy) → the unchanged legacy
	 *     worktree delete path (stop → evict → git worktree remove).
	 */
	async #handleDeleteWorkspace(req: Request, daemonId: string): Promise<Response> {
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		if (entry.workspace?.kind === "clone") {
			// P7.3/P7.5: the clone verify-at-deletion gate lives in the ONE
			// lifecycle owner (admission → quiesce with proven stop → Git
			// guard → store verification against the volume → read-only
			// flip → provider deletion → volume deletion → roster removal).
			// The worktree/direct path below is unchanged.
			try {
				const result = await this.lifecycle.deleteClone(daemonId);
				return json(result);
			} catch (err) {
				if (err instanceof CloneLifecycleError) {
					throw new HttpError(lifecycleStatus(err.code), err.message);
				}
				throw err;
			}
		}
		return await this.#handleDeleteWorktree(req, daemonId);
	}

	/**
	 * P7.6: log-store subtrees with no live roster identity (and no
	 *  delete-pending-retry workspace). Retention-governed: never auto-GC'd. */
	async #handleLogOrphans(): Promise<unknown> {
		const store = this.logStore;
		if (store === null) return { orphans: [] };
		const live = new Set(this.registry.list().map((entry) => entry.daemonId));
		const orphans = store.listOrphans([...live]);
		// Orphaned workspaces carry a registry-level storeOrphan marker
		// (deleted without verification); surface it with the listing.
		const marked = this.registry.storeOrphans();
		return {
			orphans: orphans.map((orphan) => ({
				...orphan,
				storeOrphan: orphan.workspaceId in marked,
			})),
		};
	}

	/** P7.6 explicit manual purge (never automatic). Removes one workspace's
	 *  stored logs (orphaned or verified read-only) and its storeOrphan
	 *  marker. A live, non-read-only workspace is refused; its store is
	 *  still being written. */
	async #handleLogPurge(req: Request): Promise<Response> {
		const store = this.logStore;
		if (store === null) throw new HttpError(503, "fleet log store unavailable");
		const body = await readJson(req);
		const workspaceId = requireString(body, "workspaceId");
		const liveEntry = this.registry.get(workspaceId);
		if (liveEntry && !store.isReadOnly(workspaceId)) {
			throw new HttpError(
				409,
				`workspace ${workspaceId} is live and its store is still writable; purge only applies to orphaned or verified read-only logs`,
			);
		}
		const result = store.purgeWorkspace(workspaceId);
		if (this.registry.storeOrphans()[workspaceId] !== undefined) {
			this.registry.clearStoreOrphan(workspaceId);
		}
		return json({ purged: workspaceId, sessions: result.sessions });
	}

	/**
	 * POST /ctl/workspaces/:id/resume-clone (P8.10): the explicit
	 * "resume onto fresh clone" action for an ORPHANED (deleted-workspace)
	 * session. Resolves the workspace's clone provenance, source +
	 * pinnedRevision, retained on the store-orphan marker at removal,
	 * provisions a fresh volume at the pinned commit via
	 * runtime/prepare-workspace.ts (which NEVER substitutes an upstream
	 * commit: an unresolvable source/pin is a typed failure), materializes
	 * the requested session's stored transcripts into the volume's agent
	 * sessions dir, then spawns the daemon with callback flags + --resume
	 * via the injected provider hook.
	 *
	 * Typed failures reuse the frozen vocabulary: 400 `invalid_request` for
	 * a live workspace or malformed input, 404 when no orphaned session/
	 * provenance exists, 409 when the store has no transcripts for the
	 * session, and 503 `unavailable` when the clone source/pin is
	 * unresolvable, the log store is absent, or no clone provider hook
	 * exists (P5-blocked, never a fake spawn).
	 */
	async #handleResumeClone(req: Request, workspaceId: string): Promise<Response> {
		const body = await readJson(req);
		const sessionId = requireString(body, "sessionId");
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
			throw new HttpError(400, `invalid field: sessionId (${sessionId})`);
		}
		const optionalProfileId = optionalString(body, "profileId");

		const store = this.logStore;
		if (store === null) throw new HttpError(503, "fleet log store unavailable");

		// The workspace must be GONE (orphaned). A live workspace wakes via
		// the daemon's own materialize path, never this route.
		const liveEntry = this.registry.get(workspaceId);
		if (liveEntry !== undefined) {
			throw new HttpError(
				409,
				`workspace ${workspaceId} is still registered; resume-onto-fresh-clone applies only to deleted workspaces`,
			);
		}
		const orphan = this.registry.storeOrphans()[workspaceId];
		const provenance = orphan?.provenance;
		const source = provenance?.source;
		const pinnedRevision = provenance?.pinnedRevision;
		const sourceOk =
			source !== undefined && (source.local !== undefined || source.remote !== undefined);
		if (
			orphan === undefined ||
			!sourceOk ||
			typeof pinnedRevision !== "string" ||
			pinnedRevision.length === 0
		) {
			throw new HttpError(
				404,
				`no resumable clone provenance for workspace ${workspaceId} (the source or pinned commit was not retained)`,
			);
		}

		// The requested session must have stored transcripts (the fleet store
		// is the only source, never upstream substitution). Validated store
		// path API, never raw path construction.
		if (store.storedSessionDir(workspaceId, sessionId) === null) {
			throw new HttpError(
				409,
				`no stored transcripts for session ${sessionId} in workspace ${workspaceId}`,
			);
		}

		// P5 gate: without a clone provider the spawn cannot happen. Fail
		// typed `unavailable` rather than faking a spawn.
		const spawner = this.cloneResumeSpawner;
		if (spawner === null) {
			throw new HttpError(
				503,
				"resume-onto-fresh-clone is unavailable: no clone provider is configured (P5)",
			);
		}

		// Provision the fresh volume at the pinned commit. prepareWorkspace
		// enforces the pin: an unresolvable source/commit is a typed
		// failure, never a silent upstream substitution.
		const volumeRoot = join(this.cloneRoot, workspaceId);
		let prepared;
		try {
			prepared = await prepareWorkspace({
				workspaceId,
				workspaceRoot: volumeRoot,
				source,
				revision: pinnedRevision,
			});
		} catch (err) {
			throw new HttpError(
				503,
				`clone preparation failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Materialize the requested session's transcripts into the fresh
		// volume's agent sessions dir (`.home/agent/sessions`), exactly the
		// tree the daemon's tailer will stream. Use the store directly: the
		// fresh daemon has no callback pair YET (the pair is established at
		// spawn below), so materialization is a fleet-local copy.
		// (The daemon-side /callback/bulk materialize path covers LIVE
		// workspaces; resume-onto-fresh-clone materializes fleet-side before
		// the daemon exists.) The fill is fill-missing-only (the fresh
		// volume has nothing, so every stored file is written) and validates
		// relpaths with the frozen manifest predicate + isPathUnder.
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");
		let materialized = 0;
		try {
			const outcome = materializeMissingSessionFiles({
				store,
				workspaceId,
				sessionId,
				sessionsDir,
			});
			materialized = outcome.written;
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (err instanceof WakeMaterializeError) {
				const message = `transcript materialization failed for session ${sessionId}: ${err.message}`;
				if (err.code === "unavailable") {
					throw new HttpError(409, message);
				}
				throw new HttpError(500, message);
			}
			throw new HttpError(
				500,
				`transcript materialization failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (materialized === 0) {
			throw new HttpError(
				409,
				`no stored transcripts for session ${sessionId} in workspace ${workspaceId}`,
			);
		}

		// Spawn the daemon (callback pair + --resume). The provider hook
		// owns the daemon launch; a failure is a typed provider failure.
		try {
			await spawner.spawnCloneResume({
				workspaceId,
				generation: 1,
				volumeRoot,
				sessionId,
			});
		} catch (err) {
			throw new HttpError(
				503,
				`daemon spawn failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		void optionalProfileId;
		return json({
			resumed: workspaceId,
			sessionId,
			provisioned: true,
			materializedFiles: materialized,
			checkoutDir: prepared.checkoutDir,
		});
	}

	/**
	 * DELETE /ctl/worktrees/:daemonId {deleteBranch?}: stop the daemon,
	 * evict it from the roster, then git-remove the local linked worktree
	 * (and optionally `git branch -d` it). Linked-worktree identity and dirty
	 * guards run BEFORE any mutation: a refusal (403 not linked / 409 dirty;
	 * never --force) leaves the roster and daemon untouched.
	 * Session transcripts live under the agent dir, never inside the worktree;
	 * the current default creation directory has no role in deletion.
	 */
	async #handleDeleteWorktree(req: Request, daemonId: string): Promise<Response> {
		// The body is optional (`{ deleteBranch?: boolean }`); a bodyless
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
		const info = await worktreeDeleteInfo(entry);
		if (!info.linked) throw new HttpError(403, info.reason ?? `not a linked worktree: ${path}`);
		if (info.dirty)
			throw new HttpError(409, info.reason ?? `worktree has uncommitted changes: ${path}`);
		// Stop + evict (removal-time cleanup: #24 prune drops supervisor state).
		if (entry.workspace?.kind !== "clone") {
			await this.supervisor.prune(daemonId);
			this.#forgetPair(daemonId);
		}
		this.registry.remove(daemonId);
		// Git removal; the guards are re-asserted inside (race backstop).
		let deleted: Awaited<ReturnType<typeof deleteWorktree>>;
		try {
			deleted = await deleteWorktree(entry, { deleteBranch });
		} catch (err) {
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
		bind?: string;
		browserAccessToken?: string;
		browserOrigin?: string;
		/** CLI `--trusted-proxy` literals (repeatable/csv); forwarded headers
		 *  honored only from these proxies. */
		trustedProxy?: string[];
		settings?: FleetSettingsOptions;
		/** Test seam: hermetic stats.db/sessions locations. Production leaves
		 *  this unset so stats resolves the operator defaults ($PI_CONFIG_DIR). */
		statsConfig?: Pick<StatsConfig, "statsDbPath" | "sessionsDir">;
		/** Serve the static UI and its routes (default true). The control-only process passes false. */
		serveUi?: boolean;
		/** Test seam: redial grace before a session with no pair is marked asleep (default REDIAL_GRACE_MS). */
		redialGraceMs?: number;
		/** Test seam: plugin lock store (the real SDK-backed store otherwise). */
		pluginStore?: () => Promise<PluginStore>;
	} = {},
): Promise<FleetServer> {
	const configPath = resolveConfigPath(opts.configPath);
	const config = await loadConfig(opts.configPath, {
		workspaceDir: opts.workspaceDir,
		bind: opts.bind,
		browserAccessToken: opts.browserAccessToken,
		browserOrigin: opts.browserOrigin,
		trustedProxy: opts.trustedProxy,
	});
	const statePath = resolveStatePath(opts.statePath, configPath);
	// One fleet per state file: the O_EXCL pidfile lock fails loudly when a
	// second fleet starts against the same state (no clobbering writes).
	// The lock is handed to the server and released in close(); any failure
	// below releases it before rethrowing.
	const lock = acquireFileLock(`${statePath}.lock`, "omp-fleet");
	try {
		const registry = new Registry(statePath);
		await registry.load();
		// Browser auth + non-loopback binds: opening the bind address must
		// never create an unauthenticated control plane (P2.3). A
		// non-loopback bind without browser auth configured is a startup
		// error, mirroring the daemon's R14 rule.
		if (!isLoopbackHost(config.bind) && config.browserAccessTokenHash === undefined) {
			throw new Error(
				`refusing to bind non-loopback address "${config.bind}" without browser auth; ` +
					"set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)",
			);
		}
		return new FleetServerImpl(
			registry,
			config,
			resolvePort(opts.port),
			{
				statePath,
				// Null when no config file exists at the resolved location (defaults apply).
				configPath: existsSync(configPath) ? configPath : null,
			},
			lock,
			opts.settings,
			undefined,
			null,
			opts.statsConfig,
			opts.serveUi,
			opts.redialGraceMs,
			opts.pluginStore,
		);
	} catch (err) {
		lock.release();
		throw err;
	}
}
