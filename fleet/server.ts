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
 * POST /ctl/settings/set {path, value}           -> SettingsModel (400 bad path/value)
 *   POST /ctl/projects/:id/worktrees               -> create or add-existing worktree -> 201 { entry }
 *   DELETE /ctl/worktrees/:daemonId {deleteBranch?} -> worktree: stop -> remove entry -> git worktree remove
 *                    (clone workspace: verify-at-deletion gate, P7.3/P7.5)
 *   GET  /ctl/logs/orphans                         -> orphaned log-store subtrees (P7.6)
 *   POST /ctl/logs/purge {workspaceId}             -> explicit manual purge (P7.6)
 *   POST /ctl/workspaces/:id/resume-clone {sessionId, profileId?} -> fresh clone
 *                    at the pinned commit + transcript materialization + resume (P8.10)
 *   POST /ctl/workspaces/:id/clear-deletion -> clear a rejected delete so the
 *                    workspace can be woken, preserved, stopped, and retried (P7.3)
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
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RegisteredProject, PublicProviderProfile } from "../shared/protocol";
import type { FleetConfig } from "./config";
import { expandTilde, loadConfig, resolveConfigPath } from "./config";
import { toPublicProfile } from "./provider-profile";
import { isLoopbackHost } from "../server/config";
import { acquireFileLock, type FileLock } from "../shared/file-lock";
import type { DeletionGateError, RegistryEntry, WorkspaceRecord } from "./registry";
import { bootStatusFor, Registry } from "./registry";
import { validateProjectPath } from "./discovery";
import { matchSelector } from "./selectors";
import { DaemonConnector } from "./connector";
import { SpawnSupervisor } from "./supervisor";
import { isValidEndpointUrl } from "./spawn-parse";
import { isPathUnder, realpathOf } from "./worktrees";
import type { FanoutDeps } from "./fanout";
import { fanOut } from "./fanout";
import { FleetEdge } from "./edge";
import { FleetEventLog, type FleetFacts } from "./events";
import { createFleetSettings, type FleetSettings, type FleetSettingsOptions } from "./settings";
import { createStatsApp } from "./stats/index";
import type { StatsConfig } from "./stats/config";
import { BrowserAuthStore, clearSessionCookie } from "./browser-auth";
import { DaemonTransportRegistry } from "./daemon-transport";
import { FleetAuthGate, isLoopbackBind, peerIsLoopback, BrowserAuthError } from "./fleet-auth-gate";
import { compileTrustedProxies } from "./trusted-proxy";
import { CALLBACK_TRANSPORT_STREAM_ID, type CallbackEnvelope } from "../shared/callback-protocol";
import { FleetLogStore, LogStoreError, type LogChunk, type LogIngestResult } from "./log-store";
import { createStoredApp, type StoredApp } from "./stored-sessions";
import { verifyWorkspaceLogs, type VerifyResult } from "../runtime/verify-store";
import { prepareWorkspace } from "../runtime/prepare-workspace";
import { runProviderOp } from "../runtime/provider-exec";
import type {
	ProviderHandle,
	ProviderProfile,
	ProviderRequest,
	ProviderResponse,
} from "../shared/provider-protocol";
import { ENROLLMENT_KEY_BYTES } from "../shared/callback-protocol";
import { createHash, randomBytes } from "node:crypto";
import {
	CloneLifecycleError,
	type CloneCreateInput,
	WorkspaceLifecycle,
} from "./workspace-lifecycle";
import { CloneControlApi, lifecycleStatus } from "./clone-control";
import { CloneQuiesce, type CloneQuiesceRequest, type CloneQuiesceReceipt } from "./clone-quiesce";
import { readCallbackEnvFile } from "../runtime/callback-env";
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
	WorktreeNotOwnedError,
	WorktreeTargetExistsError,
	type CreateWorktreeResult,
} from "./worktrees";

const DEFAULT_PORT = 4722;

// P3.8 fleet log-store ack batching (docs/clone-contracts.md "Session log
// streaming"): log_ack controls ride the reserved transport stream once per
// batch. Batches flush when the accumulated-chunk budget is hit or the
// time budget elapses, whichever comes first — a high-churn session acking
// every 64 chunks bounds control chatter to ~16/s, and a quiet tail still
// acks within a second of each durable append.
const LOG_ACK_FLUSH_MS = 1_000;
const LOG_ACK_BATCH_MAX = 64;

/** Bounded clone readiness probe (stage 4 item 4: callback readiness 60 s). */
const CLONE_READINESS_TIMEOUT_MS = 60_000;
/** Retry cadence for a pair observed before its launch is authorized (the
 *  daemon commonly dials while kubernetes ensure-running still waits on the
 *  Pod, and the authorization persists only after the provider returns). */
const CLONE_READINESS_RETRY_MS = 1_000;

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
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
	/** Fleet lifecycle-event ring (backing /ctl/debug; CLI mirrors it to stdout). */
	eventLog: FleetEventLog;
	/** Fleet-wide facts (port/startedAt/state paths) for the banner + /ctl/debug. */
	fleetFacts: FleetFacts;
	/** Clone-workspace lifecycle authority (P5-P7); exposed for the control plane and tests. */
	lifecycle: WorkspaceLifecycle;
	/** Post-verification volume/provider-state deleter, dispatched by persisted provider kind. */
	resourceDeleter: WorkspaceResourceDeleter;
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

function resolveStatePath(explicit?: string, configPath?: string): string {
	if (explicit !== undefined && explicit !== "") return expandTilde(explicit);
	const env = process.env.OMP_FLEET_STATE;
	if (env !== undefined && env !== "") return expandTilde(env);
	// Default: the state file lives NEXT TO the config file — the first-run
	// data-home choice moves config + state + workspaces together. With no
	// config that is the default data home (~/.omp-web), the historic path.
	return join(dirname(configPath ?? resolveConfigPath()), "fleet-state.json");
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
/** P8.10 resume-onto-fresh-clone: POST /ctl/workspaces/:id/resume-clone. */
const WORKSPACE_RESUME_CLONE_ROUTE = /^\/ctl\/workspaces\/([^/]+)\/resume-clone$/;
/**
 * P7.3 recovery: POST /ctl/workspaces/:id/clear-deletion clears a REJECTED
 * deletion attempt (delete-pending-retry) so the operator can wake the
 * workspace, preserve changes, stop, and retry the delete. Wake and delete
 * stay quarantined until this explicit action.
 */
const WORKSPACE_CLEAR_DELETION_ROUTE = /^\/ctl\/workspaces\/([^/]+)\/clear-deletion$/;
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

/**
 * Local clone volume deleter (P7.5): removes the workspace's own volume —
 * the checkout and session data — under the fleet workspaceDir root. Only
 * ever called AFTER the store verification gate passed and the store flipped
 * read-only; the roster removal follows this call. Never touches the fleet
 * log store (Retention owns it) and never removes anything outside the
 * managed root.
 */
class LocalCloneResourceDeleter implements WorkspaceResourceDeleter {
	private readonly workspaceRoot: string;
	constructor(workspaceDir: string) {
		this.workspaceRoot = workspaceDir;
	}
	async deleteWorkspaceResources(workspaceId: string, entry: RegistryEntry): Promise<void> {
		const cwd = entry.cwd ?? "";
		if (cwd === "") return; // No volume to remove (a placeholder).
		const realRoot = realpathOf(this.workspaceRoot);
		const realCwd = realpathOf(cwd);
		if (!isPathUnder(realCwd, realRoot)) {
			throw new Error(
				`refusing to delete clone volume outside workspaceDir: ${cwd} (workspace ${workspaceId})`,
			);
		}
		// The volume is the workspace root itself: .checkout + .home + the
		// init marker live under it. Remove it as a unit.
		rmSync(realCwd, { recursive: true, force: true });
	}
}

/**
 * Delete-time resource cleanup, dispatched by the workspace's PERSISTED
 * provider kind (stage 3 item 7):
 *   - bwrap (and every legacy record with no explicit kind) keeps the
 *     guarded local-volume path above;
 *   - kubernetes removes the fleet's private provider state only. The Pod
 *     and PVC themselves were already deleted by the lifecycle's provider
 *     delete op (UID-preconditioned, absence-waited) BEFORE this hook runs;
 *     this hook must never touch the PVC-backed volume.
 */
class ProviderKindResourceDeleter implements WorkspaceResourceDeleter {
	private readonly workspaceRoot: string;
	private readonly local: LocalCloneResourceDeleter;
	constructor(workspaceDir: string) {
		this.workspaceRoot = workspaceDir;
		this.local = new LocalCloneResourceDeleter(workspaceDir);
	}

	async deleteWorkspaceResources(workspaceId: string, entry: RegistryEntry): Promise<void> {
		// Dispatch on the PERSISTED identity: an explicit kubernetes kind, or
		// any record carrying a Kubernetes resource binding (both mean the
		// volume is a PVC owned by the provider, never a local directory).
		if (entry.workspace?.providerKind === "kubernetes" || entry.workspace?.kubernetes) {
			this.#deleteKubernetesProviderState(workspaceId, entry);
			return;
		}
		await this.local.deleteWorkspaceResources(workspaceId, entry);
	}

	/**
	 * Remove the per-resource provider state directory the fleet owns
	 * (`<workspaceDir>/.kubernetes/<resourceIdentity>/`, plus the legacy
	 * `<workspaceDir>/.provider-state/<daemonId>/` layout). Every candidate
	 * is realpath-checked against the managed root before removal; a state
	 * path outside it is refused, never deleted.
	 */
	#deleteKubernetesProviderState(workspaceId: string, entry: RegistryEntry): void {
		const realRoot = realpathOf(this.workspaceRoot);
		const candidates: string[] = [];
		const identity = entry.workspace?.kubernetes?.resourceIdentity;
		if (typeof identity === "string" && identity !== "") {
			candidates.push(join(this.workspaceRoot, ".kubernetes", identity));
		}
		candidates.push(join(this.workspaceRoot, ".provider-state", workspaceId));
		for (const candidate of candidates) {
			if (!existsSync(candidate)) continue;
			const real = realpathOf(candidate);
			if (!isPathUnder(real, realRoot)) {
				throw new Error(
					`refusing to delete provider state outside workspaceDir: ${candidate} (workspace ${workspaceId})`,
				);
			}
			rmSync(real, { recursive: true, force: true });
		}
	}
}

/** Default spawn-hook deadline (contract: 60s). */
const HOOK_TIMEOUT_MS = 60_000;

/**
 * Session identity from a main-session path: the `.jsonl` stem (the
 * slash-free lineage key). The fleet and the Pod see the same session under
 * different absolute paths, so readiness compares identities, never paths.
 */
function sessionIdOf(sessionPath: string): string {
	const base = basename(sessionPath);
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/**
 * Public projection of the fleet-private {@link WorkspaceRecord} for the
 * /ctl roster: only the fields the CLI/UI/acceptance scripts rely on
 * (kind, projectId, profileId, desiredState, pinned revision, branch). The
 * private remainder — the Kubernetes binding, clone source, provider handle,
 * enrollment credential digest, deletion receipts, source pin digest, and
 * attempted generation — never crosses a route boundary.
 */
function toPublicWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
	return {
		kind: record.kind,
		projectId: record.projectId,
		desiredState: record.desiredState,
		...(record.profileId !== undefined ? { profileId: record.profileId } : {}),
		...(record.pinnedRevision !== undefined ? { pinnedRevision: record.pinnedRevision } : {}),
		...(record.branch !== undefined ? { branch: record.branch } : {}),
	};
}

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
	port!: number;
	readonly registry: Registry;
	readonly connector: DaemonConnector;
	readonly supervisor: SpawnSupervisor;
	readonly config: FleetConfig;
	readonly edge: FleetEdge;
	readonly fleetSettings: FleetSettings;
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
	/** State-file lock: taken in startFleet, released in close(). */
	readonly lock: FileLock;

	/** Per-workspace log_ack batching: chunks acked since the last flush. */
	readonly #logAckChunks = new Map<string, Map<string, number>>();
	/** Per-workspace flush timer; one timer per workspace with pending acks. */
	readonly #logAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Per-workspace transport tap unsubscribe; cleared in close(). */
	readonly #logTaps = new Map<string, () => void>();
	/** Per-workspace readiness (pair-change) listener unsubscribe; close(). */
	readonly #readinessListeners = new Map<string, () => void>();
	/** Workspaces with a readiness probe in flight (one probe at a time). */
	readonly #readinessInFlight = new Set<string>();
	/** Workspaces whose pair dialed before the launch was authorized, with
	 *  the retention deadline for the bounded retry that probes once the
	 *  provider returns (`#armReadinessRetry`). */
	readonly #readinessRetryTimers = new Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; until: number }
	>();
	/** Launch-time session expectations (workspace → the boot session the
	 *  fleet's callback handoff required), recorded per attempt and consumed
	 *  by the first successful readiness probe. Never re-applied to later
	 *  reconnects or restarts, where the daemon's boot is already history. */
	readonly #bootSessionExpectations = new Map<string, { generation: number; sessionId: string }>();
	/** Monotonic suffix forcing a fresh prime per readiness probe (the daemon
	 *  only primes a brand-new browser stream; re-opening an existing one
	 *  replays instead of re-priming). */
	#readinessSeq = 0;
	/** Historical transcripts/stats API (P8.6): per-instance stats app,
	 *  constructed in the constructor so it can receive the log store when it
	 *  loads; closed in close(). */
	readonly #statsApp: ReturnType<typeof createStatsApp>;
	/** Stored-sessions read API (P8.5): mounted under /ctl/stored once the
	 *  fleet log store loads; null when the store is unavailable. Read-only,
	 *  never wakes compute. */
	readonly storedApp: StoredApp | null = null;

	/** Port requested at construction; Bun.serve binds it in boot(). */
	readonly #requestedPort: number;
	/** Set only after the whole boot body succeeds; boot() is idempotent. */
	#booted = false;

	#server!: Server<undefined>;
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
	) {
		this.registry = registry;
		this.config = config;
		this.lock = lock;
		this.#requestedPort = port;
		this.resourceDeleter = resourceDeleter ?? new ProviderKindResourceDeleter(config.workspaceDir);
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
		// streaming for this process — it must not take the whole fleet down.
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
		// Browser auth: hash-only store next to the state file. loopbackDev is
		// ON only when the bind is a loopback address (the explicit dev cookie
		// exception — never inferred for a public bind).
		const loopbackDev = isLoopbackBind(config.bind);
		this.#expectedTokenHash = config.browserAccessTokenHash ?? "";
		const authEnabled = config.browserAccessTokenHash !== undefined;
		// Compiled trusted-proxy rules for the gate. loadConfig already
		// rejects malformed literals, but config objects constructed directly
		// (tests) could carry one; an invalid literal NEVER matches (fail
		// closed), and reaching here at all means the value was a raw config
		// — drop-and-warn rather than silently trusting a subset.
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
			onWorktreeRemoved: (entry) => void this.#onWorktreeVanished(entry),
		});
		// Stage 3: the clone delete gate's evidence step. This collector owns
		// the fleet-side quiesce request/timeout and validates the returned
		// receipt against the fleet store; the lifecycle gate invokes it with
		// the frozen request shape and persists the receipt before provider
		// stop. Nothing here bypasses or reorders the existing gate stages.
		const cloneQuiesce = new CloneQuiesce({
			transport: this.transport,
			logStore: this.logStore,
			eventLog: this.eventLog,
		});
		// P6/P7 lifecycle owner: the single create/ensure/stop/delete
		// authority for provider-managed clone workspaces, shared by the
		// control-plane routes and the edge command dispatch. Constructed
		// BEFORE the edge (the edge takes it as a hook object); its deps are
		// registry/config/transport/eventLog/resourceDeleter + injected
		// log-tap attach, callback-URL provider, and the evidence collector.
		this.lifecycle = new WorkspaceLifecycle({
			registry,
			config: { workspaceDir: config.workspaceDir, providerProfiles: config.providerProfiles },
			transport: this.transport,
			logStore: this.logStore,
			resourceDeleter: this.resourceDeleter,
			eventLog: this.eventLog,
			attachLogTap: (workspaceId) => this.#attachLogStoreTap(workspaceId),
			callbackUrl: () => this.#callbackUrl(),
			collectCloneEvidence: (request: CloneQuiesceRequest): Promise<CloneQuiesceReceipt> =>
				cloneQuiesce.collect(request),
		});
		this.cloneApi = new CloneControlApi({
			lifecycle: this.lifecycle,
			registry,
			config: { providerProfiles: config.providerProfiles },
			eventLog: this.eventLog,
		});
		// Historical transcripts/stats API (P8.6): per-instance, constructed
		// with the log store (fleetStore coverage) once the store loads in the
		// block above — never a bare store-less app.
		edge = new FleetEdge({
			registry,
			connector: this.connector,
			supervisor: this.supervisor,
			config,
			eventLog: this.eventLog,
			fleet: this.fleetFacts,
			transport: this.transport,
			lifecycle: this.lifecycle,
			logStore: this.logStore ?? undefined,
			providerProfiles: publicProfileCatalog(config),
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
	}

	/**
	 * Finish boot (startFleet awaits this before returning): reconcile the
	 * persisted provider identities, re-enroll persisted callback
	 * credentials, register the callback consumers, then bind the HTTP
	 * routes. Split out of the constructor because identity reconciliation
	 * is async and MUST complete before any enrollment or lifecycle request
	 * is accepted (stage 1 item 4), while the callback consumers must exist
	 * before the routes that can reach them bind (stage 2 item 7).
	 */
	async boot(): Promise<void> {
		if (this.#booted) return;
		// Stage 1 item 4: resolve legacy bwrap records from their verified
		// local preparation marker and mark Kubernetes records without a
		// persisted resource binding as unavailable BEFORE callbacks enroll
		// or any lifecycle request is accepted. Idempotent; never deletes
		// provider resources.
		await this.lifecycle.reconcileIdentities();
		// Boot re-enrollment: enrollments are NOT memory-only. Every roster
		// entry whose workspace record persists a callback-enrollment binding
		// (digest + generation only) is re-enrolled before anything else
		// acts on the roster, so a fleet restart accepts daemon redials with
		// their original credential — the raw credential never survives the
		// process, only its sha-256 digest.
		for (const { workspaceId, enrollment } of this.registry.workspaceEnrollments()) {
			this.transport.enrollPersisted(workspaceId, enrollment.generation, enrollment.credentialHash);
		}
		// Register the callback CONSUMERS before the HTTP server binds the
		// fleet callback routes (stage 2 item 7): the log-store tap and the
		// internal readiness control listener must exist before any Pod can
		// reach /callback/*, or a redial that lands the instant the routes
		// bind would stream into the void. The enrollments above cover every
		// pair the fleet will accept; runtime attach on enrollment is wired
		// through #attachLogStoreTap.
		if (this.logStore !== null) {
			this.transport.setMaterializeStore(this.logStore);
		}
		for (const workspaceId of this.transport.enrolledWorkspaceIds()) {
			this.#attachLogStoreTap(workspaceId);
		}
		this.#server = Bun.serve({
			hostname: this.config.bind,
			port: this.#requestedPort,
			// SSE responses are long-lived and quiet between 15s keepalive
			// pings; Bun's default 10s fetch idleTimeout would kill them.
			idleTimeout: 0,
			fetch: (req, srv) => this.#fetch(req, srv.requestIP(req)?.address),
		});
		this.port = this.#server.port!;
		this.fleetFacts.port = this.port;
		// P6.3: provider-managed clone workspaces reconcile SEPARATELY — their
		// compute survived the restart (it is not an in-memory child), so the
		// legacy boot downgrade above must never touch them. Runs AFTER the
		// port binds so checkout callbacks dial a real address. Inspect-
		// before-act: reattach live sandboxes, recreate desired-running ones,
		// leave desired-stopped ones alone. Fire-and-forget; failures log.
		void this.lifecycle.reconcile();
		this.#booted = true;
	}

	async close(): Promise<void> {
		const errors: unknown[] = [];
		try {
			this.edge.close();
		} catch (err) {
			errors.push(err);
		}
		this.#closeLogStoreWiring();
		try {
			this.transport.close();
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
		// Enrollment is the one notification every fresh pair passes through
		// (boot re-enrollment and runtime enrollment both land here): the
		// readiness control listener rides it, independent of the store.
		this.#watchCloneReadiness(workspaceId);
		// #ensure calls this hook on every attempt, right after writing the
		// callback handoff and before the provider runs: the one place the
		// launch-time resume expectation can be captured.
		this.#recordLaunchSessionExpectation(workspaceId);
		if (this.#logTaps.has(workspaceId)) return;
		const store = this.logStore;
		if (store === null) return;
		const unsubscribe = this.transport.onDaemonEnvelope(workspaceId, (envelope) => {
			this.#onLogEnvelope(store, workspaceId, envelope);
		});
		this.#logTaps.set(workspaceId, unsubscribe);
	}

	// --- clone readiness (stage 2 item 7) ---------------------------------

	/**
	 * Register the internal readiness control listener for a clone
	 * workspace: on every authenticated pair (re)establishment — including a
	 * surviving Pod reconnecting after a fleet restart — re-run the probe.
	 * Idempotent per workspace; a pair already live at registration is
	 * probed immediately.
	 */
	#watchCloneReadiness(workspaceId: string): void {
		if (this.#readinessListeners.has(workspaceId)) return;
		const entry = this.registry.get(workspaceId);
		if (entry?.workspace?.kind !== "clone") return;
		const unsubscribe = this.transport.onPairChange(workspaceId, (status) => {
			if (status.paired && status.enrolled) void this.#checkCloneReadiness(workspaceId);
		});
		this.#readinessListeners.set(workspaceId, unsubscribe);
		const status = this.transport.pairStatus(workspaceId);
		if (status.paired && status.enrolled) void this.#checkCloneReadiness(workspaceId);
	}

	/**
	 * Fleet readiness: the authenticated pair (paired + enrolled) PLUS the
	 * daemon's own `hello_ok` and `ready` frames on an internal virtual
	 * stream, with the daemon's cwd matching the fleet's expected runtime
	 * cwd and — when the launch handoff required a boot session — the
	 * daemon's session file identifying that same session. A conclusive
	 * mismatch downgrades a pair-only "ready"; an inconclusive probe (pair
	 * vanished mid-probe) leaves the stage alone.
	 *
	 * A pair change alone is not proof the launch is authorized: kubernetes
	 * ensure-running waits on Pod readiness, so the daemon commonly dials
	 * while `authorizedGeneration` is still unpersisted. That event is
	 * deferred (bounded) rather than dropped, so the probe still validates
	 * cwd and the boot session once the provider returns.
	 */
	async #checkCloneReadiness(workspaceId: string): Promise<void> {
		if (this.#readinessInFlight.has(workspaceId)) return;
		const entry = this.registry.get(workspaceId);
		if (entry?.workspace?.kind !== "clone") return;
		if (
			entry.workspace.desiredState !== "running" ||
			entry.workspace.authorizedGeneration === undefined
		) {
			this.#armReadinessRetry(workspaceId);
			return;
		}
		this.#clearReadinessRetry(workspaceId);
		this.#readinessInFlight.add(workspaceId);
		const generation = entry.workspace.authorizedGeneration;
		const streamId = `browser/readiness-${++this.#readinessSeq}`;
		try {
			const outcome = await this.#probeCloneReadiness(entry, streamId);
			if (outcome.ok) {
				this.#consumeBootSessionExpectation(workspaceId, generation);
				this.eventLog.add(
					"info",
					"server",
					`clone ${workspaceId} readiness confirmed (${outcome.detail})`,
					workspaceId,
				);
				return;
			}
			if (!outcome.conclusive) {
				this.eventLog.add(
					"info",
					"server",
					`clone ${workspaceId} readiness inconclusive: ${outcome.message}`,
					workspaceId,
				);
				return;
			}
			this.registry.update(workspaceId, {
				lifecycleStage: "failed",
				lifecycleError: outcome.message,
			});
			this.registry.setStatus(workspaceId, "error", outcome.message);
			this.eventLog.add(
				"warn",
				"server",
				`clone ${workspaceId} readiness failed: ${outcome.message}`,
				workspaceId,
			);
		} finally {
			this.#readinessInFlight.delete(workspaceId);
		}
	}

	/**
	 * Bounded retry for a pair observed before its launch is authorized:
	 * re-check at CLONE_READINESS_RETRY_MS and probe the moment
	 * `authorizedGeneration` + desired-running land. Stops when the
	 * workspace leaves the roster, the pair drops (its own pair change
	 * re-requests a probe), or the readiness budget elapses. Never blocks a
	 * caller; the timer is unref'd like the probe's own bound.
	 */
	#armReadinessRetry(workspaceId: string, until = Date.now() + CLONE_READINESS_TIMEOUT_MS): void {
		if (this.#readinessRetryTimers.has(workspaceId)) return;
		const timer = setTimeout(() => {
			this.#readinessRetryTimers.delete(workspaceId);
			const current = this.registry.get(workspaceId);
			if (current?.workspace?.kind !== "clone") return;
			const pair = this.transport.pairStatus(workspaceId);
			if (!pair.paired || !pair.enrolled) return;
			if (
				current.workspace.desiredState === "running" &&
				current.workspace.authorizedGeneration !== undefined
			) {
				void this.#checkCloneReadiness(workspaceId);
				return;
			}
			if (Date.now() >= until) return;
			this.#armReadinessRetry(workspaceId, until);
		}, CLONE_READINESS_RETRY_MS);
		timer.unref();
		this.#readinessRetryTimers.set(workspaceId, { timer, until });
	}

	/** Cancel a deferred readiness retry (the probe is running, or close()). */
	#clearReadinessRetry(workspaceId: string): void {
		const pending = this.#readinessRetryTimers.get(workspaceId);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.#readinessRetryTimers.delete(workspaceId);
	}

	/**
	 * Capture the launch-time session expectation from the callback handoff
	 * `#ensure` just wrote (this hook runs on every attempt, before the
	 * provider call). Only an in-flight attempt — one ahead of the last
	 * authorized generation — carries a fresh resume hint: a reattach, and a
	 * boot re-enrollment of an already-running daemon, rewrite the handoff
	 * without one. The expectation is dropped once a probe validates it, so
	 * it is never re-applied after the daemon legitimately switches
	 * sessions.
	 */
	#recordLaunchSessionExpectation(workspaceId: string): void {
		const entry = this.registry.get(workspaceId);
		const record = entry?.workspace;
		if (entry === undefined || record?.kind !== "clone") return;
		const attempted = record.lastAttemptedGeneration;
		if (attempted === undefined) return;
		const authorized = record.authorizedGeneration;
		if (authorized !== undefined && authorized >= attempted) return;
		let resume: unknown;
		try {
			resume = readCallbackEnvFile(this.#cloneStateDir(entry), {
				workspaceId,
				generation: attempted,
			})?.env?.OMP_SESSION_RESUME;
		} catch {
			// Unreadable/absent handoff: no launch expectation to record.
			this.#bootSessionExpectations.delete(workspaceId);
			return;
		}
		if (typeof resume !== "string" || resume === "") {
			this.#bootSessionExpectations.delete(workspaceId);
			return;
		}
		this.#bootSessionExpectations.set(workspaceId, {
			generation: attempted,
			sessionId: sessionIdOf(resume),
		});
	}

	/** Consume a satisfied launch expectation: the daemon booted into the
	 *  required session, so later reconnects must not re-apply the hint. */
	#consumeBootSessionExpectation(workspaceId: string, generation: number): void {
		const expectation = this.#bootSessionExpectations.get(workspaceId);
		if (expectation?.generation === generation) this.#bootSessionExpectations.delete(workspaceId);
	}

	/**
	 * One bounded probe: attach a fresh internal virtual stream, ask the
	 * daemon to open it (the daemon primes hello_ok/attached/state/
	 * collab_status/ready on a NEW browser stream), and await the hello_ok +
	 * ready pair. The stream is detached and every timer cleared on all
	 * paths.
	 */
	async #probeCloneReadiness(
		entry: RegistryEntry,
		streamId: string,
	): Promise<{ ok: true; detail: string } | { ok: false; conclusive: boolean; message: string }> {
		const workspaceId = entry.daemonId;
		const expectedCwd = this.#expectedRuntimeCwd(entry);
		const requestedSession = this.#requestedSessionId(entry);
		let settle!: (
			result: { ok: true; detail: string } | { ok: false; conclusive: boolean; message: string },
		) => void;
		const result = new Promise<
			{ ok: true; detail: string } | { ok: false; conclusive: boolean; message: string }
		>((resolve) => {
			settle = resolve;
		});
		let sawHello = false;
		let sawReady = false;
		let observedCwd = "";
		let observedSession = "";
		const unsubscribe = this.transport.onDaemonEnvelope(workspaceId, (envelope) => {
			if (envelope.kind !== "frame" || envelope.streamId !== streamId) return;
			if (typeof envelope.payload !== "object" || envelope.payload === null) return;
			const payload = envelope.payload as Record<string, unknown>;
			const type = typeof payload.type === "string" ? payload.type : "";
			if (type === "hello_ok") {
				sawHello = true;
				observedCwd = typeof payload.cwd === "string" ? payload.cwd : "";
				observedSession = typeof payload.sessionFile === "string" ? payload.sessionFile : "";
				if (expectedCwd !== null && observedCwd !== "" && observedCwd !== expectedCwd) {
					settle({
						ok: false,
						conclusive: true,
						message: `daemon cwd ${observedCwd} does not match the expected ${expectedCwd}`,
					});
					return;
				}
				if (requestedSession !== null) {
					if (observedSession === "" || sessionIdOf(observedSession) !== requestedSession) {
						settle({
							ok: false,
							conclusive: true,
							message: `daemon session ${observedSession === "" ? "(none)" : observedSession} does not identify the requested session ${requestedSession}`,
						});
						return;
					}
				}
			} else if (type === "ready") {
				sawReady = true;
			}
			if (sawHello && sawReady) {
				settle({
					ok: true,
					detail: `cwd ${observedCwd === "" ? "(unchecked)" : observedCwd}, session ${observedSession === "" ? "(none requested)" : observedSession}`,
				});
			}
		});
		this.transport.attachVirtualStream(workspaceId, streamId, { deliver: () => {} });
		// A pair that drops after the stream-open send can never answer the
		// probe. Settle INCONCLUSIVE from the pair event itself (rather than
		// letting the timer report a conclusive timeout), so the reconnect's
		// own pair change runs a fresh probe instead of the clone being
		// downgraded to error for a transport hiccup.
		const unsubscribePair = this.transport.onPairChange(workspaceId, (status) => {
			if (status.paired && status.enrolled) return;
			settle({
				ok: false,
				conclusive: false,
				message: "pair dropped during the readiness probe",
			});
		});
		const timer = setTimeout(() => {
			// Belt and braces: a pair already down at the deadline is
			// inconclusive even if its change event was missed.
			const pair = this.transport.pairStatus(workspaceId);
			if (!pair.paired || !pair.enrolled) {
				settle({
					ok: false,
					conclusive: false,
					message: "pair unavailable at the readiness probe timeout",
				});
				return;
			}
			settle({
				ok: false,
				conclusive: true,
				message: `readiness probe timed out after ${CLONE_READINESS_TIMEOUT_MS}ms (hello_ok=${sawHello}, ready=${sawReady})`,
			});
		}, CLONE_READINESS_TIMEOUT_MS);
		timer.unref();
		try {
			await this.transport.sendToDaemon(workspaceId, {
				streamId,
				kind: "control",
				payload: { type: "stream_open" },
			});
			return await result;
		} catch (err) {
			// The pair teardown raced the probe: nothing to conclude.
			return {
				ok: false,
				conclusive: false,
				message: `pair unavailable during the readiness probe: ${err instanceof Error ? err.message : String(err)}`,
			};
		} finally {
			clearTimeout(timer);
			unsubscribe();
			unsubscribePair();
			this.transport.detachVirtualStream(workspaceId, streamId);
		}
	}

	/**
	 * Runtime cwd the daemon must report in hello_ok, derived from the
	 * persisted provider kind (no stored field exists):
	 *   - kubernetes: the Pod's in-pod checkout, fixed by the image
	 *     entrypoint (`OMP_WORKSPACE_DIR` = /workspace/.checkout);
	 *   - bwrap/legacy: the fleet volume's checkout,
	 *     <workspaceDir>/<daemonId>/.checkout.
	 * Null when the fleet path is unknown (empty cwd): inconclusive, skipped.
	 */
	#expectedRuntimeCwd(entry: RegistryEntry): string | null {
		if (entry.workspace?.providerKind === "kubernetes" || entry.workspace?.kubernetes) {
			return "/workspace/.checkout";
		}
		const cwd = entry.cwd ?? "";
		if (cwd === "") return null;
		return join(cwd, ".checkout");
	}

	/**
	 * The session the fleet's launch handoff required the daemon to BOOT
	 * into, or null when the current generation carries no pending
	 * expectation (a fresh start with no wake target, a boot already
	 * validated by an earlier probe, or an already-running daemon the fleet
	 * reattached). Null skips the session comparison: a hint that described
	 * a past boot must never fail a daemon that has since switched sessions.
	 */
	#requestedSessionId(entry: RegistryEntry): string | null {
		const expectation = this.#bootSessionExpectations.get(entry.daemonId);
		if (expectation === undefined) return null;
		if (entry.workspace?.authorizedGeneration !== expectation.generation) return null;
		return expectation.sessionId;
	}

	/**
	 * Fleet-side provider state dir for a clone workspace, mirroring the
	 * lifecycle layout: kubernetes by resource identity, bwrap by daemon id.
	 */
	#cloneStateDir(entry: RegistryEntry): string {
		const identity = entry.workspace?.kubernetes?.resourceIdentity;
		if (typeof identity === "string" && identity !== "") {
			return join(this.config.workspaceDir, ".kubernetes", identity);
		}
		return join(this.config.workspaceDir, ".provider-state", entry.daemonId);
	}

	/**
	 * One daemon callback envelope on a log-tapped workspace. Frame chunks
	 * append to the store; a `control` envelope carrying the additive
	 * workspace-side session-deletion notice (P7.6) purges that session's
	 * fleet copy — the workspace wins. Read-only workspaces refuse the purge
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
			// lands. Sent immediately — the gap is a stall, not chatter.
			// The envelope's streamId names the AFFECTED log stream (the
			// daemon half's handleControl requires it: controls on the
			// reserved transport stream carry the target in the payload or
			// the envelope, and a missing target is an invalid_request — a
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
		// offset, or a stale generation — nothing to do.
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
					// dropped — the daemon re-streams from its last acked
					// offset once the pair is live again, so nothing is lost.
				},
			);
	}

	/** Cancel pending log-ack flush timers and detach all taps + readiness
	 *  listeners (close()). */
	#closeLogStoreWiring(): void {
		for (const timer of this.#logAckTimers.values()) clearTimeout(timer);
		this.#logAckTimers.clear();
		this.#logAckChunks.clear();
		for (const unsubscribe of this.#logTaps.values()) unsubscribe();
		this.#logTaps.clear();
		for (const unsubscribe of this.#readinessListeners.values()) unsubscribe();
		this.#readinessListeners.clear();
		this.#readinessInFlight.clear();
		for (const pending of this.#readinessRetryTimers.values()) clearTimeout(pending.timer);
		this.#readinessRetryTimers.clear();
		this.#bootSessionExpectations.clear();
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
			// P6.3: provider-managed clone entries are NOT stale in-memory
			// children — their sandbox compute survived the restart. Never
			// downgrade them here; #reconcileCloneWorkspaces inspects and
			// reattaches/recreates them by durable provider identity.
			if (entry.workspace?.kind === "clone") continue;
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

	/**
	 * POST /ctl/start {daemonId} (alias POST /ctl/wake) — the fleet-side
	 * ensure-running entry point for CLONE workspaces (P6.1). Direct/template
	 * spawns keep their existing path (/ctl/spawn + supervisor); this route
	 * only ever runs provider-managed clone entries. On success the workspace
	 * record rides: fresh enrollment (credential persistence for the callback
	 * pair), provider handle, and desiredState "running". A missing or
	 * untyped profile is a typed `unavailable` — never a fake spawn.
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
		const current = this.registry.get(daemonId);
		// Public projection only: the provider handle, binding, enrollment
		// and clone source are fleet-private and never cross this route.
		return json({
			daemonId,
			observed: "running",
			...(current?.workspace?.authorizedGeneration !== undefined
				? { generation: current.workspace.authorizedGeneration }
				: {}),
		});
	}

	#fanoutDeps(): FanoutDeps {
		// P6.1 fanout trigger: prompt/wake for clones goes through the same
		// lifecycle owner (Transport's FanoutDeps contract: transport +
		// lifecycle are optional, direct/worktree use connector/supervisor).
		return {
			registry: this.registry,
			connector: this.connector,
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
		// dev) are exempt — the R14 precedent, so fleet/cli.ts keeps
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
			// (statsApp returns null for unowned paths — the control-plane
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
				switch (path) {
					case "/ctl/sessions":
						// Public roster projection: the fleet-private workspace
						// record (provider handle, Kubernetes binding, clone
						// source, enrollment, deletion receipts) never crosses
						// this route; only the roster-safe fields do.
						return json(
							this.registry
								.list()
								.map((entry) =>
									entry.workspace !== undefined
										? { ...entry, workspace: toPublicWorkspaceRecord(entry.workspace) }
										: entry,
								),
						);
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
					case "/ctl/settings":
						// Unattached settings model (roster mode): the fleet
						// service lazily initializes the process-global
						// Settings singleton + ModelRegistry — no session.
						return json(await this.fleetSettings.getModel());
					case "/ctl/logs/orphans":
						// P7.6: log-store subtrees with no live roster identity
						// (deleted-without-verification workspaces) — never
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
				switch (path) {
					case "/ctl/projects":
						return await this.#handleAddProject(req);
					case "/ctl/clones":
						// P1.3/P8: create a clone workspace (frozen contract).
						// Validate the payload, then delegate ENTIRELY to the
						// lifecycle service — the same create the edge uses.
						return await this.#handleCreateClone(req);
					case "/ctl/spawn":
						return await this.#handleSpawn(req);
					case "/ctl/add":
						return await this.#handleAdd(req);
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
						return await this.#handleSettingsSet(req);
					case "/ctl/logs/purge":
						// P7.6 explicit manual purge of orphaned (or verified
						// read-only) workspace logs. Never automatic.
						return await this.#handleLogPurge(req);
					case "/ctl/auth/revoke-all":
						// P2.2 browser-session lifecycle: revoke every session,
						// then clear the cookie. Mutations inherit the
						// session + CSRF + origin gate (GET-only would be
						// a no-op — this is a mutation).
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
						const clearDeletionMatch = WORKSPACE_CLEAR_DELETION_ROUTE.exec(path);
						if (clearDeletionMatch) {
							return await this.#handleClearRejectedDeletion(clearDeletionMatch[1]);
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
				// (P7.3/P7.5) — admission refusal on active work, writer
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
		// /auth/* is PUBLIC by design (it IS the login surface) — mounted
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
		// A cwd belonging to a registered project (main checkout or a linked
		// worktree) tags the entry with that projectId so the roster groups it
		// under the project. Unregistered paths stay untagged (fallback group).
		const projectId = await projectIdForCwd(this.registry.projects(), resolved);
		if (projectId !== undefined) this.registry.update(entry.daemonId, { projectId });
		return json(this.registry.get(entry.daemonId) ?? entry);
	}

	/**
	 * POST /ctl/projects { path, start?, template?, labels? }: register the
	 * project's realpath (registry.addProject validates + realpath-normalizes
	 * and dedups). A path that is not an existing directory or git repo is
	 * the registry's validation error surfaced as 400; a realpath that is
	 * already registered dedups to the EXISTING project → 409 carrying it.
	 * The project's default workspace — a roster entry for the repo's main
	 * checkout mapped to the repo CWD, never a managed worktree — is
	 * registered via registerProjectMainEntry:
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
			return json({ project, ...(start ? { entry } : {}) }, 201);
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
	 * reference it — the message names the blocking daemon ids
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
			if (entry.workspace?.kind === "clone") {
				// P6.5: provider-owned clone — proof-bearing provider stop via
				// the single lifecycle owner (desiredState stopped, status
				// asleep, enrollment revoked). Never the legacy paths.
				await this.lifecycle.stopClone(entry.daemonId);
			} else if (entry.mode === "spawned") {
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

	/**
	 * A poll-detected, on-disk worktree removal: the daemon's cwd vanished
	 * between git-state poll ticks (git worktree remove run outside the
	 * fleet). Mirror #handleRemove's eviction — prune/drop + registry.remove
	 * (the roster broadcast rides registry.onChange automatically) — then
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
			if (entry.mode === "spawned") {
				await this.supervisor.prune(entry.daemonId);
			} else {
				this.connector.drop(entry.daemonId);
			}
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
			// starts after the edge assignment — optional chaining guards any
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
				// gate as DELETE — no kind-blind roster eviction can bypass
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
				// Legacy direct/worktree eviction (unchanged): #24 prune/drop
				// the per-daemon supervisor/connector state so a removed
				// daemon leaks nothing (stderr ring, listeners, waiters).
				if (entry.mode === "spawned") {
					await this.supervisor.prune(entry.daemonId);
				} else {
					this.connector.drop(entry.daemonId);
				}
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
	 *  marker. A live, non-read-only workspace is refused — its store is
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
	 * POST /ctl/workspaces/:id/clear-deletion: the explicit operator recovery
	 * from a rejected delete gate. A `delete-pending-retry` workspace is
	 * quarantined (wake and delete both refuse) until this clears it; after
	 * clearing, the operator can wake, preserve changes, stop, and retry the
	 * delete. Only clone workspaces have a deletion gate.
	 */
	async #handleClearRejectedDeletion(daemonId: string): Promise<Response> {
		const entry = this.registry.get(daemonId);
		if (!entry) throw new HttpError(404, `unknown daemon: ${daemonId}`);
		if (entry.workspace?.kind !== "clone") {
			throw new HttpError(
				400,
				`daemon ${daemonId} has no clone deletion gate (kind ${entry.workspace?.kind ?? "legacy"})`,
			);
		}
		try {
			return json({ daemonId, cleared: this.lifecycle.clearRejectedDeletion(daemonId) });
		} catch (err) {
			if (err instanceof CloneLifecycleError) {
				throw new HttpError(lifecycleStatus(err.code), err.message);
			}
			throw err;
		}
	}

	/**
	 * POST /ctl/workspaces/:id/resume-clone (P8.10): the explicit
	 * "resume onto fresh clone" action for an ORPHANED (deleted-workspace)
	 * session. Resolves the workspace's clone provenance — source +
	 * pinnedRevision, retained on the store-orphan marker at removal —
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
	 * exists (P5-blocked — never a fake spawn).
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
		// is the only source — never upstream substitution). Validated store
		// path API — never raw path construction.
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
		const volumeRoot = join(this.config.workspaceDir, workspaceId);
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
		const server = new FleetServerImpl(
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
		);
		// Identity reconciliation + callback enrollment + listener
		// registration must all complete before the HTTP routes bind
		// (stages 1 item 4 and 2 item 7); a boot failure releases the lock.
		await server.boot();
		return server;
	} catch (err) {
		lock.release();
		throw err;
	}
}
