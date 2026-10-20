/**
 * Clone-workspace lifecycle service (clone-plan P6/P7; proposed module
 * `fleet/workspace-lifecycle.ts`). THE single create/ensure/stop/delete
 * owner for provider-managed clone workspaces, shared by the control-plane
 * HTTP handlers (POST /ctl/clones, /ctl/start|wake, /ctl/stop, DELETE
 * /ctl/worktrees/:id) and the browser edge's command dispatch (Transport's
 * `EdgeLifecycleHooks`, this class conforms to it structurally).
 *
 * Ownership rules this service enforces:
 * - One lifecycle implementation. HTTP handlers and edge commands call
 *   here; nothing self-fetches /ctl/* and no second clone lifecycle exists.
 * - Desired state, generation, provider handle, source/pin, and lifecycle
 *   progress persist BEFORE any retry-prone provider step, so a crash or a
 *   failed op resumes from durable state, never from re-resolution.
 * - Predecessor termination is proven before a generation is bumped; an
 *   uncertain predecessor (`conflict` from the provider, or a live pair at
 *   the current generation with no recoverable binding) blocks replacement.
 * - Every destructive transition runs the verify-at-deletion gate
 *   (admission → quiesce with proven stop → Git guard → store verification
 *   against the workspace volume's own session tree → read-only flip →
 *   provider deletion → volume deletion → roster removal). `deleteClone`
 *   is the only clone-removal path; no kind-blind roster eviction can bypass
 *   it.
 * - Stop preserves checkout and session logs; only the verified gate
 *   deletes. Idle handling stays fleet-owned (P6.4): this service never
 *   stops compute on its own; explicit stop/wake are the only transitions.
 * - Runtime supervision: the one runtime watch (below) restarts a
 *   desired-running clone whose provider-proven runtime died after its pair
 *   came up (new generation, predecessor proven gone, budgeted backoff shared
 *   with the local supervisor via restart-policy.ts); an explicit stop never
 *   restarts. This is not an idle stop: it never stops compute.
 *
 * The fleet server injects everything external (registry, config, callback
 * transport, log store, resource deleter, event ring, log-tap attach, and
 * the callback base URL); this module has no HTTP surface of its own.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ENROLLMENT_KEY_BYTES, type CallbackErrorCode } from "#lib/wire/callback-protocol";
import type { LifecycleStage, RegisteredProject, CloneFetchResult } from "#lib/wire/protocol";
import type { Registry, RegistryEntry, WorkspaceRecord, DeletionGateError } from "./registry";
import { PAIR_LOSS_GRACE_MS } from "./registry";
import { DEFAULT_RESTART_POLICY, RestartBudget, type RestartPolicy } from "./restart-policy";
import type { FleetConfig } from "./config";
import {
	KUBERNETES_POD_LAYOUT,
	PROVIDER_CAPABILITIES,
	type ProviderCapabilities,
} from "#lib/runtime/provider-protocol";
import { readCallbackEnv } from "#lib/runtime/provider-callback-env";
import type { DaemonTransportRegistry } from "./daemon-transport";
import type { FleetLogStore } from "./log-store";
import type { FleetEventLog } from "./events";
import type { WorkspaceResourceDeleter } from "./server";
import type { ProviderOkResponse } from "#lib/runtime/provider-protocol";
import { runProviderOp } from "#lib/runtime/provider-exec";
import {
	deriveWorkspaceBranch,
	PrepareWorkspaceError,
	prepareWorkspace,
	resolveWorkspacePin,
} from "#lib/runtime/prepare-workspace";
import { runGit } from "./discovery";
import { sha256OfFile } from "#lib/session-files/file-sha256";
import { verifyWorkspaceLogs } from "./verify-store";
import { MAX_EXPORT_BYTES, MAX_EXPORT_FILES } from "#lib/session-files/export-sessions";
import {
	WakeMaterializeError,
	materializeMissingSessionFiles,
	pickNewestSessionId,
	resolveMainSessionFile,
} from "./wake-materialize";
import type { ArchiveManifest } from "#lib/session-files/archive-manifest";
import { isNormalizedPosixRelativePath } from "#lib/session-files/archive-manifest";

/** A clone volume's git checkout. The volume root itself is not a repo. */
export function cloneCheckoutDir(volumeRoot: string): string {
	return join(volumeRoot, ".checkout");
}

// ---------------------------------------------------------------------------
// Typed errors (frozen ledger vocabulary; message text is safe to surface)
// ---------------------------------------------------------------------------

/** Error codes this service raises; the frozen ledger vocabulary. */
export type CloneLifecycleErrorCode = CallbackErrorCode;

/** Typed lifecycle failure; `message` is caller-safe (roster/HTTP/edge). */
export class CloneLifecycleError extends Error {
	constructor(
		readonly code: CloneLifecycleErrorCode,
		message: string,
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Inputs / deps
// ---------------------------------------------------------------------------

/** create_clone input (frozen contract; `id`/`type` are edge-only). */
export interface CloneCreateInput {
	projectId: string;
	name: string;
	profileId: string;
	/**
	 * Exactly one member when given; absent = the registered project's local
	 * path (kubernetes: its origin URL at the main checkout HEAD). `remoteName`
	 * names one of the project's git remotes and is resolved fleet-side.
	 */
	source?: { local?: string; remote?: string; remoteName?: string };
	/** Clone pin vocabulary (never baseRef). */
	revision?: string;
	branch?: string;
	start?: boolean;
}

/** External wiring the fleet server injects (nothing HTTP here). */
interface WorkspaceLifecycleDeps {
	registry: Registry;
	config: Pick<FleetConfig, "providerProfiles">;
	/** Private volume allocation root beside this fleet's selected state file. */
	cloneRoot: string;
	transport: DaemonTransportRegistry;
	/** Fleet log store; null when the logs dir was unwritable at boot. */
	logStore: FleetLogStore | null;
	/** Post-verification volume deleter (default = local volume removal). */
	resourceDeleter: WorkspaceResourceDeleter;
	eventLog: FleetEventLog;
	/**
	 * Attach the fleet log-store tap for a workspace's callback envelopes.
	 * Called when this service enrolls a runtime generation (the ONLY place
	 * a fresh pair can start after boot) so a fresh clone never streams into
	 * the void.
	 */
	attachLogTap(workspaceId: string): void;
	/** Fleet callback base URL the sandbox daemon dials (http loopback dev). */
	callbackUrl(): string;
	/** Runtime supervision overrides (defaults: restart-policy.ts, registry PAIR_LOSS_GRACE_MS). */
	runtime?: Partial<CloneRuntimePolicy>;
}

/** Runtime supervision knobs: the shared restart policy plus the watch cadences (tests shrink them). */
export interface CloneRuntimePolicy extends RestartPolicy {
	/** A dropped pair is not acted on (no provider inspect) before this grace; mirrors registry PAIR_LOSS_GRACE_MS. */
	pairLossGraceMs: number;
	/** Pair poll cadence of the runtime watch. */
	tickMs: number;
	/** Provider inspect cadence while the pair is down. */
	inspectEveryMs: number;
}

const DEFAULT_RUNTIME_POLICY: CloneRuntimePolicy = {
	...DEFAULT_RESTART_POLICY,
	pairLossGraceMs: PAIR_LOSS_GRACE_MS,
	tickMs: 1_000,
	inspectEveryMs: 10_000,
};

/** Supervision state of one desired-running clone runtime (see #armRuntimeWatch). */
interface RuntimeWatch {
	budget: RestartBudget;
	/**
	 * A pair has held (or the runtime was reattached) since the last explicit
	 * start. Only then does a dead runtime restart; a start whose pair never
	 * came up fails for the operator to retry.
	 */
	restartable: boolean;
	paired: boolean;
	/** Earliest time the provider is next inspected (pair down only). */
	nextInspectAt: number;
	/** Pending tick or restart-backoff timer. */
	timer: Timer | undefined;
	/** Pair-change subscription: any pair-up marks the watch restartable, even one shorter than a tick. */
	unsubscribe: () => void;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Budget for the clone-deletion `git fetch origin`; a slow or offline remote falls through to cached refs. */
const GIT_FETCH_TIMEOUT_MS = 15_000;

/** One volume file the completeness cross-check compares against the store. */
interface VolumeFile {
	sessionId: string;
	/** POSIX relpath inside the session dir (manifest rules). */
	relpath: string;
	size: number;
}

/**
 * Strict directory enumeration for the deletion gate's volume walk.
 * `absent` is reported separately from every other failure so the gate can
 * never mistake "cannot read the tree" for "empty tree".
 */
type DirEnumeration =
	| { ok: true; entries: Array<{ name: string; isDirectory(): boolean }> }
	/** The directory does not exist (ENOENT): absence, not a failure. */
	| { ok: false; absent: true }
	/** The path exists (or is unusable) and cannot be enumerated. */
	| { ok: false; absent: false; reason: string };

/**
 * Strict path probe for the deletion gate. `existsSync` reports EVERY stat
 * failure as "absent" (it swallows EACCES/EPERM, ENOTDIR, ELOOP, ...), which
 * would slide a present-but-unreadable volume root into the absent-volume
 * path; statSync keeps absence and unreadability apart.
 */
type PathProbe =
	| { ok: true }
	/** The path does not exist (ENOENT): absence, not a failure. */
	| { ok: false; absent: true }
	/** The path cannot be stat'd (ENOTDIR/EACCES/ELOOP/...): unverifiable. */
	| { ok: false; absent: false; reason: string };

/** errno code carried by a filesystem failure (undefined when it has none). */
function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code; // unknown: validated by the typeof below.
	return typeof code === "string" ? code : undefined;
}

/**
 * Probe one path for the deletion gate: only ENOENT is absence. Everything
 * else means the volume cannot be read, so completeness is unprovable.
 */
function statStrict(path: string): PathProbe {
	try {
		statSync(path);
		return { ok: true };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") return { ok: false, absent: true };
		const reason = code ?? (error instanceof Error ? error.message : String(error));
		return { ok: false, absent: false, reason: `${reason} on ${path}` };
	}
}

/**
 * Enumerate one directory for the deletion gate. ENOENT alone is absence (a
 * workspace that never opened a session has no session dir, so there is
 * nothing to compare and completeness is provable); every other failure
 * (EACCES/EPERM, ENOTDIR, ELOOP, EIO, EMFILE, ...) means the tree cannot be
 * verified and MUST NOT be read as zero files: an unreadable-but-present
 * volume is the same provability failure as an absent one.
 */
function readDirStrict(dir: string): DirEnumeration {
	try {
		return {
			ok: true,
			entries: readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
				name: string;
				isDirectory(): boolean;
			}>,
		};
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") return { ok: false, absent: true };
		const reason = code ?? (error instanceof Error ? error.message : String(error));
		return { ok: false, absent: false, reason: `${reason} reading ${dir}` };
	}
}

/** A session directory name under the agent sessions dir (the volume walk and provider inventories select by it). */
const SESSION_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The sessions-root-relative path of a session file a kubernetes runtime
 * reported (an in-pod absolute path), or undefined when it is not a normalized
 * `.jsonl` path under the in-pod agent sessions dir: never hand a runtime an
 * arbitrary path as its resume target.
 */
function podSessionRelpath(file: string | undefined): string | undefined {
	const prefix = `${KUBERNETES_POD_LAYOUT.sessionsDir}/`;
	if (file === undefined || !file.startsWith(prefix)) return undefined;
	const relpath = file.slice(prefix.length);
	return relpath.endsWith(".jsonl") && isNormalizedPosixRelativePath(relpath) ? relpath : undefined;
}

/**
 * Walk one volume session dir for regular files (no traversal, no symlinks),
 * mirroring the manifest relpath rules, bounded like the export gate. Returns
 * the refusal reason when a directory in the subtree cannot be enumerated:
 * the gate must PROVE completeness, so an unreadable subtree is never zero
 * files. ENOENT is the one benign failure (the dir vanished mid-walk, so it
 * holds nothing to compare); stat failures stay skipped/lenient, as before.
 */
function walkSessionDir(
	sessionDir: string,
	sessionId: string,
	state: { files: number; bytes: number },
	out: VolumeFile[],
	relDir = "",
): string | undefined {
	const read = readDirStrict(sessionDir);
	if (!read.ok) {
		if (read.absent) return undefined;
		const where = relDir.length === 0 ? sessionId : `${sessionId}/${relDir}`;
		return `session ${where}: ${read.reason}`;
	}
	for (const dent of read.entries) {
		const absolute = join(sessionDir, dent.name);
		let stats: Stats;
		try {
			stats = statSync(absolute);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink()) continue; // Reject symlinks (P7.2).
		if (stats.isDirectory()) {
			const nested = walkSessionDir(
				absolute,
				sessionId,
				state,
				out,
				relDir.length === 0 ? dent.name : `${relDir}/${dent.name}`,
			);
			if (nested !== undefined) return nested;
			continue;
		}
		if (!stats.isFile()) continue; // Sockets/fifos are rejected.
		if (state.files >= MAX_EXPORT_FILES || state.bytes + stats.size > MAX_EXPORT_BYTES) {
			continue; // Bound exceeded; the gate below reports the shortfall.
		}
		const rel = relativePosix(sessionDir, absolute);
		if (rel.length === 0 || !isNormalizedPosixRelativePath(rel)) continue;
		state.files += 1;
		state.bytes += stats.size;
		out.push({ sessionId, relpath: rel, size: stats.size });
	}
	return undefined;
}

function relativePosix(fromDir: string, absolute: string): string {
	const rel = absolute
		.slice(fromDir.length)
		.replace(/^[/\\]+/, "")
		.split("\\")
		.join("/");
	return rel;
}

/** Clone source as the provider receives it (exactly one member). */
type CloneSource = { local?: string; remote?: string };

/** `git remote get-url <name>` in a repo; undefined when the remote is not configured. */
async function remoteUrlOf(repoPath: string, remoteName: string): Promise<string | undefined> {
	const result = await runGit(["remote", "get-url", remoteName], repoPath);
	const url = result.stdout.trim();
	return result.exitCode === 0 && url !== "" ? url : undefined;
}

/**
 * Resolve a clone's source. Explicit members win (`remoteName` is looked up
 * among the project's git remotes). An omitted source is the project's local
 * path for fleet-prepared providers; a provider that prepares in place
 * (`preparation: "provider"`, e.g. kubernetes) cannot read fleet-host paths, so it
 * defaults to the project's `origin` URL at the main checkout HEAD commit
 * (`defaultRevision`, used when the request names no revision). Refuses with
 * the reason when origin or HEAD cannot be read.
 */
async function resolveCloneSource(
	project: RegisteredProject,
	capabilities: ProviderCapabilities,
	members: { local?: string; remote?: string; remoteName?: string },
): Promise<{ source: CloneSource; defaultRevision?: string }> {
	if (members.local !== undefined) return { source: { local: resolve(members.local) } };
	if (members.remote !== undefined) return { source: { remote: members.remote } };
	if (members.remoteName !== undefined) {
		const url = await remoteUrlOf(project.path, members.remoteName);
		if (url === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`git remote "${members.remoteName}" is not configured in ${project.path}`,
			);
		}
		return { source: { remote: url } };
	}
	if (capabilities.preparation !== "provider") return { source: { local: resolve(project.path) } };
	const origin = await remoteUrlOf(project.path, "origin");
	if (origin === undefined) {
		throw new CloneLifecycleError(
			"unavailable",
			`${project.path} has no origin remote, and this provider cannot read a fleet-host path as the clone source, so the default source is the project's origin; pass source.remote or source.remoteName`,
		);
	}
	const head = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], project.path);
	if (head.exitCode !== 0) {
		throw new CloneLifecycleError(
			"unavailable",
			`${project.path} has no commit at HEAD, and this provider cannot read a fleet-host path as the clone source, so the default source is origin at the main checkout HEAD commit`,
		);
	}
	return { source: { remote: origin }, defaultRevision: head.stdout.trim() };
}

/** Realpath of an existing path, else its resolved absolute form (comparison key for "same directory"). */
function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Commit a ref points at in a repo, or undefined when the ref does not exist. */
async function gitTip(repoPath: string, ref: string): Promise<string | undefined> {
	const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
	const sha = result.stdout.trim();
	return result.exitCode === 0 && sha !== "" ? sha : undefined;
}

/** Path of the worktree that has `ref` checked out in `git worktree list --porcelain` output, if any. */
function worktreePathOfBranch(porcelain: string, ref: string): string | undefined {
	let path: string | undefined;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch ${ref}`) return path;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The lifecycle service
// ---------------------------------------------------------------------------

/**
 * Clone workspace lifecycle owner. Conforms to Transport's `EdgeLifecycleHooks`
 * (createClone / ensureCloneRunning / stopClone / deleteClone);
 * richer method returns are assignable to the void-hook signatures.
 */
export class WorkspaceLifecycle {
	readonly #deps: WorkspaceLifecycleDeps;
	/** Workspaces with a verified delete gate in flight (serializes DELETEs). */
	readonly #deleting = new Set<string>();
	/** Per-daemon FIFO tails: lifecycle ops on one clone run strictly in order. */
	readonly #queues = new Map<string, Promise<void>>();
	/** Runtime watches: one per desired-running clone (tick or restart-backoff timer each). */
	readonly #watches = new Map<string, RuntimeWatch>();
	readonly #policy: CloneRuntimePolicy;

	constructor(deps: WorkspaceLifecycleDeps) {
		this.#deps = deps;
		this.#policy = { ...DEFAULT_RUNTIME_POLICY, ...deps.runtime };
	}

	/** Runs `fn` after every earlier lifecycle op queued for this daemon. */
	#serialized<T>(daemonId: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.#queues.get(daemonId) ?? Promise.resolve()).then(fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(daemonId, tail);
		void tail.then(() => {
			if (this.#queues.get(daemonId) === tail) this.#queues.delete(daemonId);
		});
		return run;
	}

	// ------------------------------------------------------------------
	// Public hook surface (EdgeLifecycleHooks-compatible)
	// ------------------------------------------------------------------

	/**
	 * Create a clone workspace (frozen contract). Persists the registry
	 * record (source, profile, desired state) and the resolved pin BEFORE
	 * any retry-prone step; prepares the fleet-local volume (bwrap
	 * profiles); starts it when `start` is true.
	 *
	 * Typed failures: invalid_request (bad input), unavailable (unknown
	 * profile / unresolvable source or pin / provider unavailable),
	 * conflict (a prepared clone at the same identity cannot be started
	 * safely), provider_failed (provider op failure after preparation).
	 *
	 * On PREPARATION failure the entry and its partial volume are removed
	 * and the error is typed; nothing streamed, nothing retained. On
	 * START failure after a successful preparation the entry IS retained
	 * (volume + pin are expensive and durable) with lifecycleStage
	 * "failed" + lifecycleError; retry via ensureCloneRunning (start).
	 */
	async createClone(input: CloneCreateInput): Promise<RegistryEntry> {
		const { registry, config } = this.#deps;
		const projectId = input.projectId;
		const name = input.name;
		const profileId = input.profileId;
		if (typeof projectId !== "string" || projectId.length === 0) {
			throw new CloneLifecycleError("invalid_request", "missing or invalid field: projectId");
		}
		if (typeof name !== "string" || name.trim() === "" || name.includes("\0")) {
			throw new CloneLifecycleError(
				"invalid_request",
				"missing or invalid field: name (must be non-empty, no NUL)",
			);
		}
		if (typeof profileId !== "string" || profileId.length === 0) {
			throw new CloneLifecycleError("invalid_request", "missing or invalid field: profileId");
		}
		const rawSource = input.source;
		if (
			rawSource !== undefined &&
			(rawSource === null || typeof rawSource !== "object" || Array.isArray(rawSource))
		) {
			throw new CloneLifecycleError("invalid_request", "source must be an object");
		}
		const sourceLocal = rawSource?.local;
		const sourceRemote = rawSource?.remote;
		const sourceRemoteName = rawSource?.remoteName;
		const sourceMembers = [sourceLocal, sourceRemote, sourceRemoteName].filter(
			(member) => member !== undefined,
		);
		if (
			sourceMembers.length > 1 ||
			(sourceLocal !== undefined && typeof sourceLocal !== "string") ||
			(sourceRemote !== undefined && typeof sourceRemote !== "string") ||
			(sourceRemoteName !== undefined && typeof sourceRemoteName !== "string")
		) {
			throw new CloneLifecycleError(
				"invalid_request",
				"source must carry exactly one of local (string path), remote (string URL), or remoteName (string git remote name)",
			);
		}
		if (
			input.revision !== undefined &&
			(typeof input.revision !== "string" || input.revision.trim() === "")
		) {
			throw new CloneLifecycleError("invalid_request", "revision must be a non-empty string");
		}
		if (
			input.branch !== undefined &&
			(typeof input.branch !== "string" || input.branch.trim() === "")
		) {
			throw new CloneLifecycleError("invalid_request", "branch must be a non-empty string");
		}

		const project = registry.projects().find((p) => p.projectId === projectId);
		if (project === undefined) {
			throw new CloneLifecycleError("invalid_request", `unknown project: ${projectId}`);
		}
		const profile = config.providerProfiles?.[profileId];
		if (profile === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`no resolvable provider profile "${profileId}" (no matching providerProfiles entry)`,
			);
		}

		// Exactly one source; an omitted source resolves per provider
		// (resolveCloneSource: a provider that prepares in place defaults to origin at HEAD).
		const resolved = await resolveCloneSource(project, PROVIDER_CAPABILITIES[profile.provider], {
			local: sourceLocal,
			remote: sourceRemote,
			remoteName: sourceRemoteName,
		});
		const source = resolved.source;
		const revision = input.revision ?? resolved.defaultRevision;
		const start = input.start ?? false;
		const branch = input.branch ?? deriveWorkspaceBranch(name);

		// Durable identity first; only new volumes use this fleet's private root.
		const created = registry.create({
			name: name.trim(),
			cwd: "",
			project: project.name,
			projectId,
			labels: [],
			status: "asleep",
		});
		const daemonId = created.daemonId;
		const volumeRoot = join(this.#deps.cloneRoot, daemonId);

		// Persist source/profile/desiredState BEFORE any retry-prone step.
		const record: WorkspaceRecord = {
			kind: "clone",
			projectId,
			source,
			branch,
			profileId,
			desiredState: start ? "running" : "stopped",
		};
		registry.update(daemonId, {
			cwd: volumeRoot,
			lifecycleStage: "preparation",
			lifecycleError: undefined,
		});
		registry.setWorkspace(daemonId, record);
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} created (${profile.provider})`,
			daemonId,
		);

		// Resolve the pin ONCE, for EVERY profile (fleet-owned pin
		// resolution, the k8s provider never resolves; Runtime contract).
		// prepareWorkspace (bwrap) resolves internally too, but the explicit
		// resolve here persists the full commit BEFORE any retry-prone step
		// and feeds the persisted pin into the volume prep below.
		let pinnedRevision: string | undefined;
		try {
			pinnedRevision = await resolveWorkspacePin(source, revision, {
				// The clone root is created lazily and may not exist yet on a
				// fresh fleet; the registered project path always exists.
				cwd: project.path,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code =
				err instanceof PrepareWorkspaceError
					? err.code === "invalid_request"
						? "invalid_request"
						: "unavailable"
					: "unavailable";
			// Nothing streamed and nothing retained: drop the fresh entry +
			// volume (no preparation happened yet); the typed failure is the
			// whole story.
			this.#removeEntryAndVolume(daemonId, volumeRoot);
			throw new CloneLifecycleError(code, `cannot resolve clone pin: ${message}`);
		}
		registry.updateWorkspace(daemonId, { pinnedRevision });

		// Preparation. Profiles whose capability is fleet preparation (bwrap)
		// prepare the volume here; provider-prepared profiles (kubernetes)
		// skip the fleet-side clone: the provider initializes its volume
		// in place at the persisted pin during ensure-running, reusing the
		// SAME full commit on every retry.
		if (PROVIDER_CAPABILITIES[profile.provider].preparation === "fleet") {
			try {
				await prepareWorkspace({
					workspaceId: daemonId,
					workspaceRoot: volumeRoot,
					source,
					branch,
					revision: pinnedRevision,
					sandboxEnvKeys: Object.keys(profile.secretRefs ?? {}),
				});
			} catch (err) {
				const code =
					err instanceof PrepareWorkspaceError
						? err.code
						: err instanceof Error && err.message.includes("not a git repository")
							? "invalid_request"
							: "unavailable";
				const message = err instanceof Error ? err.message : String(err);
				// Nothing streamed and nothing retained: drop the partial
				// entry + volume; the typed failure is the whole story.
				this.#removeEntryAndVolume(daemonId, volumeRoot);
				throw new CloneLifecycleError(
					code === "invalid_request" || code === "conflict" || code === "provider_failed"
						? code
						: "unavailable",
					`clone preparation failed: ${message}`,
				);
			}
		}

		if (!start) {
			// Prepared and parked: stopped clone, wakeable via start. A
			// stopped workspace has NO active lifecycle stage; clear the
			// transient "preparation" so the roster never shows an eternal
			// pulsing stage for a deliberately parked clone (start will set
			// preparation→runtime→callback→ready on wake).
			registry.update(daemonId, { lifecycleStage: undefined, lifecycleError: undefined });
			this.#deps.eventLog.add(
				"info",
				"server",
				`clone ${daemonId} prepared at ${pinnedRevision} (stopped)`,
				daemonId,
			);
			return registry.get(daemonId) ?? created;
		}

		// Start immediately: run the ensure path. A start failure after a
		// successful preparation keeps the entry (typed failed stage): the
		// volume + pin are durable and expensive; start retries in place.
		try {
			await this.#ensure(registry.get(daemonId) ?? registry.update(daemonId, {}), {
				firstStart: true,
			});
		} catch (err) {
			const code =
				err instanceof CloneLifecycleError
					? err.code
					: err instanceof Error
						? this.#codeForEnsureFailure(err)
						: "provider_failed";
			const message = err instanceof Error ? err.message : String(err);
			this.#setStage(daemonId, "failed", `${code}: ${message}`);
			registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			this.#deps.eventLog.add(
				"warn",
				"server",
				`clone ${daemonId} start after create failed (${code}): ${message}`,
				daemonId,
			);
			throw new CloneLifecycleError(
				code,
				`clone ${daemonId} prepared but start failed (${code}): ${message}; retry with start, or delete to remove it`,
			);
		}
		return registry.get(daemonId) ?? created;
	}

	/**
	 * Start/wake: ensure-running. Resolves when the provider confirms the
	 * compute is running and the enrollment is persisted; never blocks on
	 * pair readiness (callback → ready rides the roster via the bounded
	 * pair watcher). Rejects with typed errors otherwise.
	 *
	 * P8.9 wake resume: `resumeSessionId` names the session this wake
	 * should boot into (the edge pre-validates it against the fleet store
	 * listing). Fleet-visible volumes (bwrap): the wake materializes that
	 * session's cold/missing stored transcripts into the volume and hands the
	 * daemon the resolved main-file path as OMP_SESSION_RESUME (the sandbox
	 * sees the host path). Volumes the fleet cannot read (kubernetes): the
	 * hint is an in-pod path from the session's own report
	 * (`lastSessionFile`) or the store lineage, and the pod validates it at
	 * boot (exit 78 when missing). When ABSENT the wake resumes the newest
	 * session it can see (volume ∪ store; for kubernetes the recorded
	 * `lastSessionFile`, else the newest stored session), so a stopped clone
	 * wake continues its last session instead of booting fresh; a
	 * never-started clone (no sessions anywhere) still boots fresh. An
	 * EXPLICIT id that exists nowhere is a typed `unavailable`, never a
	 * silent fresh boot.
	 */
	async ensureCloneRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void> {
		await this.#serialized(daemonId, () => this.#ensureRunning(daemonId, opts));
	}

	async #ensureRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void> {
		let entry = this.#requireClone(daemonId, "start");
		const deletion = entry.workspace?.deletion;
		if (deletion !== undefined) {
			// A refused delete that ran no destructive step (no read-only store
			// flip, no provider/volume removal) left the workspace intact:
			// starting it abandons the pending delete instead of stranding the
			// row. Anything past the flip stays quarantined until the delete
			// retry completes.
			const destructive =
				deletion.remainingResources !== undefined ||
				this.#deps.logStore?.isReadOnly(daemonId) === true;
			if (deletion.state !== "delete-pending-retry" || destructive) {
				throw new CloneLifecycleError(
					deletion.state === "delete-pending-retry" ? "archive_pending" : "conflict",
					`workspace ${daemonId} is being deleted (${deletion.state}); cannot start`,
				);
			}
			this.#deps.registry.clearWorkspaceDeletion(daemonId);
			entry = this.#deps.registry.get(daemonId) ?? entry;
		}
		await this.#ensure(entry, { firstStart: false, resumeSessionId: opts?.resumeSessionId });
	}

	/** Stop: proof-bearing provider stop, desiredState stopped, enrollment
	 *  revoked. Preserves checkout + session logs (never deletes). */
	async stopClone(daemonId: string): Promise<void> {
		await this.#serialized(daemonId, () => this.#stopClone(daemonId));
	}

	async #stopClone(daemonId: string): Promise<void> {
		const entry = this.#requireClone(daemonId, "stop");
		const record = entry.workspace;
		if (record?.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				"conflict",
				`workspace ${daemonId} is being deleted (${record.deletion.state}); stop is not available`,
			);
		}
		const generation = record?.authorizedGeneration;
		const handle = this.#handleOf(entry);
		if (generation !== undefined) {
			// #runCloneOp throws a typed CloneLifecycleError on provider
			// failure; an ok response here proves the generation terminated.
			const response = await this.#runCloneOp(entry.daemonId, "stop", handle);
			if (response.observed === "running") {
				// The provider failed to prove termination: a running
				// process would violate the desired stopped state.
				throw new CloneLifecycleError(
					"conflict",
					`stop of ${daemonId} could not prove termination (observed running)`,
				);
			}
		}
		this.#deps.registry.updateWorkspace(daemonId, { desiredState: "stopped" });
		this.#disposeWatch(daemonId);
		this.#deps.registry.setStatus(daemonId, "asleep");
		// A stopped workspace has no active lifecycle stage (stop cleared
		// it): start/wake re-runs preparation→runtime→callback→ready.
		this.#deps.registry.update(daemonId, {
			lifecycleStage: undefined,
			lifecycleError: undefined,
		});
		if (generation !== undefined) {
			this.#deps.transport.revokeEnrollment(daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, generation);
		}
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} stopped (gen ${generation ?? "never-started"})`,
			daemonId,
		);
	}

	/** Verified deletion (P7.3/P7.5): the only clone-removal path. Returns the verified session list. */
	async deleteClone(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		return await this.#deleteGate(daemonId);
	}

	/**
	 * Fetch a local-source clone's branch into its project's main repo
	 * (`git fetch <clone checkout> <branch>:<branch>`, no `+`: an existing
	 * project branch is only ever fast-forwarded). Refuses, leaving the
	 * project untouched, when the clone is remote-source (it pushes upstream
	 * from inside its runtime), runs on a provider whose volume the fleet
	 * cannot read, is being deleted, has no such branch, the branch is
	 * checked out in any worktree of the project, or the update is not a
	 * fast-forward. Only committed work travels: a dirty tree stays behind.
	 */
	async fetchCloneIntoProject(daemonId: string): Promise<CloneFetchResult> {
		return await this.#serialized(daemonId, () => this.#fetchIntoProject(daemonId));
	}

	async #fetchIntoProject(daemonId: string): Promise<CloneFetchResult> {
		const entry = this.#requireClone(daemonId, "fetch into project");
		const record = entry.workspace;
		if (record?.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				"conflict",
				`workspace ${daemonId} is being deleted (${record.deletion.state}); fetch is not available`,
			);
		}
		const { profile } = this.#cloneProfile(entry);
		if (!PROVIDER_CAPABILITIES[profile.provider].volumeFleetVisible) {
			throw new CloneLifecycleError(
				"invalid_request",
				`clone ${daemonId} runs on a ${profile.provider} provider whose volume the fleet cannot read; its work leaves through its remote`,
			);
		}
		const sourceLocal = record?.source?.local;
		if (sourceLocal === undefined) {
			throw new CloneLifecycleError(
				"invalid_request",
				`clone ${daemonId} has a remote source; it pushes upstream from inside its runtime`,
			);
		}
		const project = this.#deps.registry.projects().find((p) => p.projectId === record?.projectId);
		if (project === undefined) {
			throw new CloneLifecycleError("invalid_request", `unknown project: ${record?.projectId}`);
		}
		if (project.missing === true) {
			throw new CloneLifecycleError(
				"unavailable",
				`project ${project.path} is missing on disk; cannot fetch into it`,
			);
		}
		if (realpathOrResolve(sourceLocal) !== realpathOrResolve(project.path)) {
			throw new CloneLifecycleError(
				"invalid_request",
				`clone ${daemonId} was cloned from ${sourceLocal}, not the project's local path ${project.path}`,
			);
		}
		const branch = record?.branch;
		if (branch === undefined || branch === "") {
			throw new CloneLifecycleError("invalid_request", `clone ${daemonId} records no branch`);
		}
		const ref = `refs/heads/${branch}`;
		const valid = await runGit(["check-ref-format", ref], project.path);
		if (valid.exitCode !== 0) {
			throw new CloneLifecycleError("invalid_request", `"${branch}" is not a valid branch name`);
		}
		const { checkoutDir } = this.#clonePaths(entry);
		if (!existsSync(join(checkoutDir, ".git"))) {
			throw new CloneLifecycleError(
				"unavailable",
				`clone ${daemonId} has no prepared checkout to fetch from`,
			);
		}
		const cloneTip = await gitTip(checkoutDir, ref);
		if (cloneTip === undefined) {
			throw new CloneLifecycleError(
				"conflict",
				`clone ${daemonId} has no local branch "${branch}" (its checkout is on another branch or the branch was renamed)`,
			);
		}

		// Git refuses to move a checked-out branch; name where, before it does.
		const worktrees = await runGit(["worktree", "list", "--porcelain"], project.path);
		if (worktrees.exitCode !== 0) {
			throw new CloneLifecycleError(
				"unavailable",
				`cannot list worktrees of ${project.path} (git exited ${worktrees.exitCode}); not fetching`,
			);
		}
		const checkedOutAt = worktreePathOfBranch(worktrees.stdout, ref);
		if (checkedOutAt !== undefined) {
			throw new CloneLifecycleError(
				"conflict",
				`branch "${branch}" is checked out at ${checkedOutAt}; git will not update a checked-out branch. Switch that checkout to another branch and retry`,
			);
		}

		const projectTip = await gitTip(project.path, ref);
		if (projectTip === cloneTip) {
			return {
				daemonId,
				branch,
				projectPath: project.path,
				outcome: "up-to-date",
				commit: cloneTip,
			};
		}
		// No `+` on the refspec: git itself rejects anything but a creation or fast-forward.
		const fetched = await runGit(
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				checkoutDir,
				`${ref}:${ref}`,
			],
			project.path,
			{ timeoutMs: GIT_FETCH_TIMEOUT_MS },
		);
		if (fetched.exitCode !== 0) {
			// Objects arrive before the ref update is judged, so when the project
			// branch is not an ancestor of the clone's tip the fetch was a
			// non-fast-forward refusal (the project branch is untouched).
			if (projectTip !== undefined) {
				const ancestor = await runGit(
					["merge-base", "--is-ancestor", projectTip, cloneTip],
					project.path,
				);
				if (ancestor.exitCode === 1) {
					throw new CloneLifecycleError(
						"conflict",
						`project branch "${branch}" is not an ancestor of the clone's "${branch}" (not a fast-forward); the project branch was left untouched. Reconcile the two branches (merge or rebase in the clone) and retry`,
					);
				}
			}
			const detail = fetched.stderr.trim().split("\n")[0] ?? "";
			throw new CloneLifecycleError(
				"provider_failed",
				`git fetch of "${branch}" from clone ${daemonId} failed (exit ${fetched.exitCode})${detail !== "" ? `: ${detail}` : ""}`,
			);
		}
		const commit = (await gitTip(project.path, ref)) ?? cloneTip;
		this.#log(
			"info",
			`clone ${daemonId} branch ${branch} fetched into ${project.path} (${projectTip === undefined ? "created" : "fast-forward"} ${commit.slice(0, 12)})`,
			daemonId,
		);
		return {
			daemonId,
			branch,
			projectPath: project.path,
			outcome: projectTip === undefined ? "created" : "updated",
			commit,
			...(projectTip !== undefined ? { previousCommit: projectTip } : {}),
		};
	}

	// ------------------------------------------------------------------
	// Boot reconciliation (P6.3)
	// ------------------------------------------------------------------

	/**
	 * Reconcile provider-managed clone workspaces after a fleet restart.
	 * Provider compute survived the restart (it is not an in-memory child),
	 * so this inspects durable identity BEFORE acting:
	 *   - observed running  → reattach (refresh handle, ready), same
	 *     generation, persisted credential reused; NEVER a new process;
	 *   - observed stopped/missing + desired running → ensure-running
	 *     (bumped generation after the predecessor is proven gone);
	 *   - desired stopped → leave.
	 * Failures are bounded, logged, and never hidden retry loops. Never
	 * downgrades statuses (clone entries are skipped by the legacy boot
	 * status reconcile in server.ts).
	 */
	async reconcile(): Promise<void> {
		for (const entry of this.#deps.registry.list()) {
			if (entry.workspace?.kind !== "clone") continue;
			await this.#serialized(entry.daemonId, () => this.#reconcileOne(entry.daemonId));
		}
	}

	/** One clone's boot reconcile; runs under its per-daemon queue. */
	async #reconcileOne(daemonId: string): Promise<void> {
		const entry = this.#deps.registry.get(daemonId);
		if (entry?.workspace?.kind !== "clone") return;
		const record = entry.workspace;
		// A persisted "deleting" state describes an in-flight gate of a
		// previous fleet process; nothing is running now, so it
		// reconciles to delete-pending-retry (retry by deleting again).
		if (record.deletion?.state === "deleting") {
			this.#deps.registry.setWorkspaceDeletion(entry.daemonId, {
				state: "delete-pending-retry",
				requestedAt: record.deletion.requestedAt,
				error: {
					code: "retryable",
					message: "deletion was interrupted before verification completed; retry the delete",
				},
			});
			return;
		}
		if (record.providerHandle === undefined && record.authorizedGeneration === undefined) {
			return; // Never started; nothing to inspect or reattach.
		}
		const desired = record.desiredState;
		let response: ProviderOkResponse;
		try {
			// #runCloneOp throws a typed CloneLifecycleError on provider
			// failure; an ok response here is a trustworthy observation.
			response = await this.#runCloneOp(entry.daemonId, "inspect", this.#handleOf(entry));
		} catch (err) {
			this.#log(
				"warn",
				`clone boot reconcile: inspect failed for ${entry.daemonId}: ${err instanceof Error ? err.message : String(err)}`,
				entry.daemonId,
			);
			return;
		}
		if (response.observed === "running") {
			// Reattach: same generation, refresh handle, surface liveness.
			this.#deps.registry.updateWorkspace(entry.daemonId, { providerHandle: response.handle });
			this.#deps.registry.setStatus(entry.daemonId, "ready");
			this.#setStage(entry.daemonId, "ready");
			this.#armRuntimeWatch(entry.daemonId, { restartable: true, resume: false });
			this.#log(
				"info",
				`clone boot reconcile: ${entry.daemonId} reattached (running)`,
				entry.daemonId,
			);
			return;
		}
		// stopped | missing: desired state decides.
		if (desired === "running") {
			try {
				await this.#ensure(this.#deps.registry.get(entry.daemonId) ?? entry, {
					firstStart: false,
				});
				this.#log(
					"info",
					`clone boot reconcile: ${entry.daemonId} recreated (${response.observed} → ensure-running)`,
					entry.daemonId,
				);
			} catch (err) {
				this.#log(
					"warn",
					`clone boot reconcile: ensure-running failed for ${entry.daemonId}: ${err instanceof Error ? err.message : String(err)}`,
					entry.daemonId,
				);
			}
		} else {
			this.#log(
				"info",
				`clone boot reconcile: ${entry.daemonId} left ${response.observed} (desired stopped)`,
				entry.daemonId,
			);
		}
	}

	/** Cancel timers (server close()); never stops provider compute. */
	close(): void {
		for (const daemonId of [...this.#watches.keys()]) this.#disposeWatch(daemonId);
	}

	// ------------------------------------------------------------------
	// Ensure-running (start/wake/reconcile core)
	// ------------------------------------------------------------------

	/**
	 * P6.1/P6.2 ensure-running. Inspect-before-act, then:
	 *   - running + persisted binding at the current generation → reattach:
	 *     reuse the daemon's own credential (recovered from the state file),
	 *     no generation bump, no replacement;
	 *   - running + NO recoverable binding → replacement: prove the
	 *     predecessor terminated (provider stop), THEN bump the generation
	 *     and start fresh;
	 *   - stopped/missing → start. If the workspace ran before, the
	 *     predecessor is already proven gone (the stop that parked it), so
	 *     the generation bumps to fence stale callbacks; a first start runs
	 *     at generation 1.
	 * On success: provider handle, authorized generation, desiredState
	 * running, status ready persist; lifecycleStage advances
	 * runtime → callback (pair watcher → ready).
	 */
	async #ensure(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string; recovery?: boolean },
	): Promise<ProviderOkResponse> {
		const daemonId = entry.daemonId;
		const record = entry.workspace;
		if (record?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace (kind ${record?.kind ?? "legacy"}); start a worktree/direct session through /ctl/spawn`,
			);
		}
		// A workspace mid-deletion must not re-enroll (P7.3 admission
		// barrier: "block new admission once deletion begins").
		if (record.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				record.deletion.state === "delete-pending-retry" ? "archive_pending" : "conflict",
				`workspace ${daemonId} is being deleted (${record.deletion.state}); cannot start`,
			);
		}
		const currentGen = record.authorizedGeneration;
		const handle = this.#handleOf(entry);
		this.#setStage(daemonId, "runtime");

		// Inspect first: a live sandbox must never be blindly recreated.
		// #runCloneOp throws a typed CloneLifecycleError on provider failure
		// (conflict = uncertain predecessor, unavailable, provider_failed).
		let inspect: ProviderOkResponse | null = null;
		if (currentGen !== undefined || handle !== undefined) {
			try {
				inspect = await this.#runCloneOp(entry.daemonId, "inspect", handle);
			} catch (err) {
				// Inspect unavailable is NOT a license to recreate: an
				// unknown predecessor blocks replacement (P6.2).
				throw err instanceof CloneLifecycleError
					? err
					: new CloneLifecycleError(
							"unavailable",
							`cannot inspect ${daemonId} before start: ${err instanceof Error ? err.message : String(err)}`,
						);
			}
		}

		let generation: number;
		let reuseToken: string | undefined;
		if (inspect !== null && inspect.observed === "running" && currentGen !== undefined) {
			// Reattach path. If the persisted binding matches this
			// generation AND the state-file token is recoverable, reuse it:
			// the daemon's live pair keeps its original credential.
			if (record.enrollment !== undefined && record.enrollment.generation === currentGen) {
				try {
					reuseToken = this.#persistedCallbackToken(entry, currentGen);
				} catch {
					reuseToken = undefined;
				}
			}
			if (reuseToken !== undefined) {
				generation = currentGen;
			} else {
				// Running with no recoverable binding: replacing the process
				// would create two writers on one volume. Prove the
				// predecessor terminated FIRST, then bump the generation.
				// (#runCloneOp throws on a non-ok stop; observed running
				// after an ok stop means termination is unproven.)
				const stop = await this.#runCloneOp(entry.daemonId, "stop", handle);
				if (stop.observed === "running") {
					throw new CloneLifecycleError(
						"conflict",
						`cannot replace ${daemonId}: predecessor termination is uncertain (stop did not prove); no new writer admitted`,
					);
				}
				generation = currentGen + 1;
			}
		} else {
			// stopped | missing (proven gone), or never started.
			if (opts.firstStart && currentGen === undefined) {
				generation = 1;
			} else {
				generation = (currentGen ?? 0) + 1;
			}
		}
		const reattached = reuseToken !== undefined && generation === currentGen;

		// P8.9 wake resume: when this wake is spawning a NEW daemon process
		// (not the reattach path), compute the resume target (bwrap: also
		// materialize cold/missing transcripts into the volume BEFORE the
		// provider runs). The resume hint rides the callback-env handoff
		// (OMP_SESSION_RESUME, allowlisted by the providers) so the daemon's
		// existing boot switchSession(config.resume) resumes it. Fleet-visible
		// volumes (bwrap) get the host path the sandbox sees; kubernetes gets
		// the in-pod path (the provider injects the handoff as pod env) and the
		// pod validates it at boot.
		// Computed BEFORE enrollment persists so a typed failure (an explicit
		// id that exists nowhere) never leaves a dangling enrollment behind.
		const resumeFile =
			reuseToken !== undefined && generation === currentGen
				? undefined // Reattach: same live process; no new spawn to hint.
				: await this.#resolveWakeResume(entry, opts);

		// Enroll + persist the binding BEFORE ensure-running (a live
		// credential must exist for the daemon's pair). Attach the log tap
		// at the same time so a fresh clone never streams into the void.
		// P6.2 fencing: when the generation is BUMPED (predecessor proven
		// terminated), revoke the OLD generation's enrollment first so a
		// stale credential can never authenticate against the new runtime.
		if (currentGen !== undefined && generation > currentGen) {
			this.#deps.transport.revokeEnrollment(daemonId, currentGen);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, currentGen);
		}
		const credentialHex = reuseToken ?? randomBytes(ENROLLMENT_KEY_BYTES).toString("hex");
		const digest = this.#deps.transport.enrollWorkspace(daemonId, generation, credentialHex);
		this.#deps.registry.setWorkspaceEnrollment(daemonId, { credentialHash: digest, generation });
		this.#writeCallbackEnv(entry, generation, credentialHex, resumeFile);
		this.#deps.attachLogTap(daemonId);

		try {
			// #runCloneOp throws on a non-ok provider response; an ok
			// response here is a live, current-generation runtime. The
			// generation override is REQUIRED: the bump was computed +
			// enrolled above but authorizedGeneration persists only after
			// ensure succeeds; without it the request would carry the stale
			// pre-bump generation and the provider would fence it (P6.2).
			const response = await this.#runCloneOp(entry.daemonId, "ensure-running", handle, generation);
			this.#deps.registry.updateWorkspace(daemonId, {
				providerHandle: response.handle,
				authorizedGeneration: generation,
				desiredState: "running",
			});
			if (response.observed === "running") {
				this.#deps.registry.setStatus(daemonId, "ready");
				this.#setStage(daemonId, "callback");
				// Runtime watch: callback → ready when the pair is observed
				// live, and a runtime that later dies restarts (never blocks
				// the caller). A reattached runtime already held a pair.
				this.#armRuntimeWatch(daemonId, {
					restartable: reattached,
					resume: opts.recovery === true,
				});
			}
			this.#log(
				"info",
				`clone ${daemonId} ensured running (gen ${generation}, observed ${response.observed})`,
				daemonId,
			);
			return response;
		} catch (err) {
			// A failed start must not leave a live enrollment credential or
			// a running desired state behind.
			this.#deps.transport.revokeEnrollment(daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, generation);
			throw err;
		}
	}

	// ------------------------------------------------------------------
	// The verified delete gate (P7.3/P7.5)
	// ------------------------------------------------------------------

	/**
	 * P7.3/P7.5 ordered gate for clone workspaces (behind deleteClone, the sole
	 * clone-removal path; removal cannot bypass it):
	 *   1. serialize concurrent DELETEs + reconcile a persisted "deleting"
	 *      from a previous fleet process to delete-pending-retry;
	 *   2. admission: refuse while compute is live or its pair is live
	 *      (activity is not observable fleet-side for clones, so a live
	 *      workspace is refused until explicitly stopped);
	 *   3. persist "deleting" (durable state before any destructive step);
	 *   4. quiesce: revoke the callback enrollment (no further log frames)
	 *      and PROVE the compute stopped via the provider BEFORE
	 *      verification; a stop that cannot prove termination blocks;
	 *   5. Git guard with writers stopped (dirty/untracked/stash/unpreserved
	 *      history block; no force override);
	 *   6. fleet-store verification INCLUDING an independent cross-check of
	 *      the workspace volume's own session tree; an empty store never
	 *      trivially passes when sessions existed on the volume;
	 *   7. read-only flip (only when anything is retained);
	 *   8. provider deletion → volume deletion → roster removal.
	 * Any failure before verification persists delete-pending-retry with a
	 * typed error and retains the workspace, its volume, and its store.
	 */
	async #deleteGate(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		const entry0 = this.#deps.registry.get(daemonId);
		if (!entry0) {
			throw new CloneLifecycleError("invalid_request", `unknown daemon: ${daemonId}`);
		}
		if (entry0.workspace?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace; deletion routes by kind and this gate only owns clones`,
			);
		}
		if (this.#deleting.has(daemonId)) {
			throw new CloneLifecycleError(
				"conflict",
				`deletion already in progress for workspace ${daemonId}`,
			);
		}
		this.#deleting.add(daemonId);
		try {
			return await this.#serialized(daemonId, () => this.#deleteAdmitted(daemonId));
		} finally {
			this.#deleting.delete(daemonId);
		}
	}

	/** Admission + gate for one clone, run under its per-daemon queue. */
	async #deleteAdmitted(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		// Reconcile a persisted "deleting" from a crashed previous fleet.
		let entry = this.#require(daemonId);
		const previous = entry.workspace?.deletion;
		if (previous?.state === "deleting") {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: previous.requestedAt,
				error: {
					code: "retryable",
					message: "deletion was interrupted before verification completed; retry the delete",
				},
			});
			entry = this.#deps.registry.get(daemonId) ?? entry;
		}

		// Admission. For clones, "active work" is not derivable fleet-side:
		// a ready workspace whose callback pair is live (or whose enrollment
		// is live) may carry accepted work; refuse with an actionable
		// message instead of risking mid-turn deletion. Explicitly stopped
		// workspaces (asleep, desired stopped, enrollment revoked) pass.
		const record = entry.workspace;
		const pair = this.#deps.transport.pairStatus(daemonId);
		const live =
			entry.status === "ready" &&
			(record?.desiredState === "running" || pair.enrolled || pair.paired);
		if (live) {
			throw new CloneLifecycleError(
				"writer_active",
				`workspace ${daemonId} is live with unobservable activity; stop current work (explicit stop) before deleting`,
			);
		}

		return await this.#gate(daemonId);
	}

	/** The gate body (runs under the #deleting serialization). */
	async #gate(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		const { registry, logStore, eventLog } = this.#deps;
		const requestedAt = Date.now();
		let entry = this.#require(daemonId);
		const previous = entry.workspace?.deletion;

		// Durable "deleting" before ANY destructive step (P7.3/P7.5:
		// registry identity is never removed early; cleanup state survives
		// restart). Re-entry from delete-pending-retry keeps remaining
		// resources across the retry.
		registry.setWorkspaceDeletion(daemonId, {
			state: "deleting",
			requestedAt,
			...(previous?.remainingResources !== undefined
				? { remainingResources: previous.remainingResources }
				: {}),
		});

		// Quiesce writers: revoke the callback enrollment (no further log
		// frames reach the store), then PROVE the provider compute stopped.
		// The stop is not a flush acknowledgment; only the store's verified
		// offsets + the volume cross-check prove completeness, but no writer
		// may still run while verification reads.
		if (entry.workspace?.enrollment !== undefined) {
			const gen = entry.workspace.enrollment.generation;
			this.#deps.transport.revokeEnrollment(daemonId, gen);
			registry.clearWorkspaceEnrollment(daemonId, gen);
		}
		const gen = entry.workspace?.authorizedGeneration;
		const everStarted = gen !== undefined || entry.workspace?.providerHandle !== undefined;
		if (everStarted) {
			let stop: ProviderOkResponse;
			try {
				stop = await this.#runCloneOp(entry.daemonId, "stop", this.#handleOf(entry));
			} catch (err) {
				// #runCloneOp throws a typed CloneLifecycleError on provider
				// failure; persist delete-pending-retry and retain everything.
				const code = err instanceof CloneLifecycleError ? err.code : "provider_failed";
				const message = err instanceof Error ? err.message : String(err);
				const error: DeletionGateError = {
					code: code === "conflict" ? "conflict" : "provider_failed",
					message: `cannot quiesce compute before verification: ${message}`,
				};
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error,
				});
				eventLog.add(
					"warn",
					"server",
					`delete ${daemonId} blocked: quiesce stop failed (${error.code}): ${error.message}`,
					daemonId,
				);
				throw new CloneLifecycleError(error.code, error.message);
			}
			if (stop.observed === "running") {
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error: {
						code: "conflict",
						message: "could not prove the workspace's compute terminated; deletion blocked",
					},
				});
				throw new CloneLifecycleError(
					"conflict",
					`workspace ${daemonId} compute could not be proven terminated; deletion blocked`,
				);
			}
			// The stopped generation is proven gone: persist the desired
			// stopped state so no boot reconcile races the gate.
			registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			registry.setStatus(daemonId, "asleep");
			registry.update(daemonId, { lifecycleStage: undefined, lifecycleError: undefined });
			entry = registry.get(daemonId) ?? entry;
		}

		// Git guard (P7.4), writers stopped: reject dirty files, untracked
		// files, stashes, and unpreserved local history. No force override.
		await this.#runGitGuard(daemonId);

		// Store verification. When the fleet log store is absent, deletion
		// cannot be verified and is blocked (everything retained).
		if (logStore === null) {
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error: {
					code: "unavailable",
					message: "fleet log store is unavailable; deletion cannot be verified",
				},
			});
			throw new CloneLifecycleError(
				"unavailable",
				`workspace ${daemonId} cannot be verified (log store unavailable); deletion blocked`,
			);
		}

		const record = registry.get(daemonId)?.workspace;
		// Deferred appends are acked only after commit(); verify reads the index.
		logStore.commit(daemonId);
		const verify = await verifyWorkspaceLogs({
			logsRoot: logStore.rootDir,
			workspaceId: daemonId,
			// Additive provenance: yields the store-side manifest (per-file
			// sha256/size/sessionId) used by the volume cross-check.
			registry: {
				projectId: record?.projectId,
				workspaceName: entry.name,
				...(record?.source !== undefined ? { source: record.source } : {}),
				...(record?.pinnedRevision !== undefined ? { resolvedCommit: record.pinnedRevision } : {}),
			},
		});
		if (!verify.ok) {
			const error = {
				code: verify.code,
				message: verify.message,
				...(verify.path !== undefined ? { path: verify.path } : {}),
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error,
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId} blocked: store verification failed (${verify.code}${verify.path ? ` at ${verify.path}` : ""}): ${verify.message}`,
				daemonId,
			);
			throw new CloneLifecycleError(
				verify.code === "invalid_request" ? "invalid_request" : "archive_conflict",
				`workspace ${daemonId} store verification failed (${verify.code}): ${verify.message}`,
			);
		}

		// Independent completeness cross-check (never infer completeness
		// from an empty store): the workspace volume's own session tree must
		// be byte-identical to the verified store.
		const volumeCheck = await this.#verifyVolumeAgainstStore(daemonId, verify.manifest);
		if (!volumeCheck.ok) {
			const error: DeletionGateError = {
				code: "archive_conflict",
				message: volumeCheck.message,
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error,
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId} blocked: volume/store mismatch (${volumeCheck.message})`,
				daemonId,
			);
			throw new CloneLifecycleError("archive_conflict", volumeCheck.message);
		}

		// Verified: flip the store read-only ONLY when anything is retained
		// (a never-streamed workspace leaves no store subtree to flip).
		const retained = verify.sessions.length > 0;
		if (retained) {
			logStore.markWorkspaceReadOnly(daemonId);
		}

		// Provider deletion (stop-proof + provider state clear), then volume
		// removal, then the roster transition. Partial provider failure after
		// the flip records remaining resources and stays retry-able.
		if (everStarted) {
			try {
				await this.#deleteProvider(registry.get(daemonId) ?? entry);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error: { code: "provider_failed", message },
					remainingResources: [
						typeof registry.get(daemonId)?.workspace?.providerHandle === "string"
							? (registry.get(daemonId)?.workspace?.providerHandle as string)
							: (entry.cwd ?? ""),
					],
				});
				eventLog.add(
					"warn",
					"server",
					`delete ${daemonId}: store verified + read-only, provider deletion failed (${message}); resources remain`,
					daemonId,
				);
				throw new CloneLifecycleError(
					"provider_failed",
					`workspace ${daemonId} verified read-only, but provider deletion failed: ${message}`,
				);
			}
		}

		// Volume removal (LocalCloneResourceDeleter or a P5 provider hook).
		try {
			const current = registry.get(daemonId) ?? entry;
			await this.#deps.resourceDeleter.deleteWorkspaceResources(daemonId, current);
		} catch (err) {
			void record; // kept for the remainingResources fallback below.
			const message = err instanceof Error ? err.message : String(err);
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error: { code: "provider_failed", message },
				remainingResources: [entry.cwd ?? ""],
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId}: store verified + read-only, volume removal failed (${message}); resources remain`,
				daemonId,
			);
			throw new CloneLifecycleError(
				"provider_failed",
				`workspace ${daemonId} verified read-only, but volume removal failed: ${message}`,
			);
		}

		// Finalize: roster identity removed (verified read-only store is
		// Retention's). No orphan marker: verification passed.
		registry.remove(daemonId);
		eventLog.add("info", "server", `workspace ${daemonId} deleted (verified)`, daemonId);
		return { removed: daemonId, verified: verify.sessions.map((s) => s.sessionId) };
	}

	// ------------------------------------------------------------------
	// Gate parts
	// ------------------------------------------------------------------

	/** Provider delete (runs only after the read-only flip). */
	async #deleteProvider(entry: RegistryEntry): Promise<ProviderOkResponse> {
		const generation = entry.workspace?.authorizedGeneration;
		// #runCloneOp throws a typed CloneLifecycleError on provider failure;
		// the gate's caller converts it to delete-pending-retry + remaining
		// resources.
		const response = await this.#runCloneOp(entry.daemonId, "delete", this.#handleOf(entry));
		if (generation !== undefined) {
			this.#deps.transport.revokeEnrollment(entry.daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(entry.daemonId, generation);
		}
		this.#log(
			"info",
			`clone ${entry.daemonId} provider deleted (gen ${generation ?? "never-started"}, observed ${response.observed})`,
			entry.daemonId,
		);
		return response;
	}

	/**
	 * P7.4 non-bypassable Git guard with writers stopped. Runs against the
	 * clone's `.checkout`: dirty files, untracked files, stashes, and
	 * unpreserved local history all block with actionable messages. No
	 * force override, no transcript-as-source-backup claim. Unreachable git
	 * or an unreadable checkout blocks (unknown verification status).
	 */
	async #runGitGuard(daemonId: string): Promise<void> {
		const entry = this.#require(daemonId);
		const { checkoutDir } = this.#clonePaths(entry);
		if (!existsSync(join(checkoutDir, ".git"))) {
			// A never-prepared/never-started clone has no checkout to guard;
			// the store/volume checks below are authoritative.
			return;
		}
		const fail = (message: string): never => {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: Date.now(),
				error: { code: "conflict", message },
			});
			throw new CloneLifecycleError("conflict", message);
		};

		// Dirty + untracked (writers stopped: `git status` is a read).
		const status = await runGit(["status", "--porcelain=v1"], checkoutDir);
		if (status.exitCode !== 0) {
			return fail(
				`cannot verify git state for ${daemonId} (status exited ${status.exitCode}): preserve the checkout manually and retry`,
			);
		}
		if (status.stdout.trim() !== "") {
			const lines = status.stdout.split("\n").filter((l) => l.length > 0);
			const sample = lines
				.slice(0, 5)
				.map((l) => l.slice(3))
				.join(", ");
			return fail(
				`workspace ${daemonId} has uncommitted or untracked files (${lines.length}): ${sample}…; commit/push or stash them before deletion (session transcripts are not source backup)`,
			);
		}
		// Stashes.
		const stash = await runGit(["stash", "list"], checkoutDir);
		if (stash.exitCode === 0 && stash.stdout.trim() !== "") {
			return fail(
				`workspace ${daemonId} has ${stash.stdout.trim().split("\n").length} stash(es); drop or apply them before deletion`,
			);
		}
		// Unpreserved local history: refresh origin remote-tracking refs
		// best-effort (offline is fine; the count below is conservative
		// against the last known refs), then count commits not reachable
		// from any origin ref.
		await runGit(["fetch", "--quiet", "--no-tags", "origin"], checkoutDir, {
			timeoutMs: GIT_FETCH_TIMEOUT_MS,
		});
		const unpushed = await runGit(
			["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
			checkoutDir,
		);
		if (unpushed.exitCode !== 0) {
			return fail(
				`cannot verify history preservation for ${daemonId} (rev-list exited ${unpushed.exitCode}); preserve manually and retry`,
			);
		}
		const count = Number.parseInt(unpushed.stdout.trim(), 10);
		if (Number.isFinite(count) && count > 0) {
			return fail(
				`workspace ${daemonId} has ${count} commit(s) not preserved on its configured remote; push them first (no force override)`,
			);
		}
	}

	/**
	 * Independent completeness check: the workspace volume's own session
	 * tree (`.home/agent/sessions`) must be byte-identical to the verified
	 * store. This is what makes an empty store FAIL deletion when sessions
	 * actually existed on the volume.
	 *
	 * Enumeration is strict at the root too: existence is probed with statSync
	 * (existsSync reports a present-but-unreadable root as absent) and only
	 * ENOENT proves there was nothing to compare. Any other failure to read
	 * the volume root or its session tree (EACCES/EPERM, ENOTDIR, ELOOP, ...)
	 * refuses the deletion of an ever-started workspace, because an unreadable
	 * volume is the same provability failure as an absent one — never an
	 * empty volume.
	 */
	async #verifyVolumeAgainstStore(
		daemonId: string,
		storeManifest: ArchiveManifest | undefined,
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const entry = this.#require(daemonId);
		const record = entry.workspace;
		const { volumeRoot, homeDir } = this.#clonePaths(entry);
		const sessionsDir = join(homeDir, "agent", "sessions");
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;

		// Presence is probed strictly: `existsSync` reports a present but
		// unreadable root as absent (it swallows EACCES/EPERM/ENOTDIR), which
		// would route an unverifiable volume into the absent-volume path.
		// Only ENOENT is absence.
		const root = statStrict(volumeRoot);
		const volumePresent = root.ok;
		const files: VolumeFile[] = [];
		let bounded = true;
		// "Cannot read" is NOT "empty": a volume path the fleet cannot read
		// must refuse deletion (completeness is unprovable), never silently
		// compare as zero files.
		let unreadable: { subject: string; reason: string } | undefined;
		if (!root.ok && !root.absent) {
			unreadable = { subject: "volume root", reason: root.reason };
		}
		if (root.ok) {
			const sessions = readDirStrict(sessionsDir);
			if (sessions.ok) {
				const state = { files: 0, bytes: 0 };
				for (const dir of sessions.entries) {
					if (!dir.isDirectory()) continue;
					const sid = dir.name;
					if (!SESSION_DIR_NAME.test(sid)) continue;
					const failure = walkSessionDir(join(sessionsDir, sid), sid, state, files);
					if (failure !== undefined) {
						unreadable = { subject: "volume session tree", reason: failure };
						break;
					}
				}
				if (state.files >= MAX_EXPORT_FILES || state.bytes > MAX_EXPORT_BYTES) {
					bounded = false;
				}
			} else if (!sessions.absent) {
				// The path exists but cannot be read, so there is no walk to
				// trust: unreadable, not empty.
				unreadable = {
					subject: "volume session tree",
					reason: `sessions dir: ${sessions.reason}`,
				};
			}
		}
		// An ever-started workspace whose volume cannot be read is refused: the
		// same provability failure as an absent volume with an empty store,
		// before the read-only flip, the provider delete, and volume removal.
		// A never-started clone has nothing to retain and keeps the previous
		// lenient behavior.
		if (unreadable !== undefined && everStarted) {
			return {
				ok: false,
				message: `workspace ${daemonId} ${unreadable.subject} cannot be verified (${unreadable.reason}); deletion blocked (an unreadable volume is not an empty one)`,
			};
		}

		if (volumePresent && files.length === 0 && everStarted) {
			// Volume present but no session files yet: a running/stopped
			// workspace that never opened a session. The store should be
			// empty too; verifyWorkspaceLogs already proved that (ok with
			// sessions:[]). Nothing to cross-check.
		}
		if (!volumePresent) {
			// A volume the fleet cannot read (a kubernetes claim, or a removed
			// volume): the provider proves its session inventory. A
			// never-started workspace has no volume sessions to lose.
			if (!everStarted) return { ok: true };
			return await this.#verifyProviderInventory(daemonId, storeManifest);
		}
		if (!bounded) {
			return {
				ok: false,
				message: `session tree for ${daemonId} exceeds verification bounds (${MAX_EXPORT_FILES} files / ${MAX_EXPORT_BYTES} bytes); deletion blocked`,
			};
		}
		if (files.length === 0) {
			return { ok: true }; // Nothing on the volume to compare; store empty is provably complete.
		}
		if (storeManifest === undefined) {
			return {
				ok: false,
				message: `workspace ${daemonId} has ${files.length} session file(s) on its volume but the store verification produced no manifest`,
			};
		}
		// Index the store manifest by (sessionId, path).
		const stored = new Map<string, { size: number; sha256: string }>();
		for (const file of storeManifest.files) {
			stored.set(`${file.sessionId}/${file.path}`, { size: file.size, sha256: file.sha256 });
		}
		// Every volume file must exist byte-identically in the store.
		for (const file of files) {
			const key = `${file.sessionId}/${file.relpath}`;
			const side = stored.get(key);
			if (side === undefined) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} (${file.size} bytes) is missing from the fleet store; deletion blocked (logs were not fully streamed)`,
				};
			}
			if (side.size !== file.size) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} is truncated in the fleet store (${side.size}/${file.size} bytes); deletion blocked`,
				};
			}
			const absolute = join(volumeRoot, ".home", "agent", "sessions", file.sessionId, file.relpath);
			const sha = await sha256OfFile(absolute);
			if (sha !== side.sha256) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} differs from its stored bytes; deletion blocked (rewrite not re-streamed)`,
				};
			}
		}
		return { ok: true };
	}

	/**
	 * Completeness proof for a volume the fleet cannot read: the provider
	 * lists the session files the volume holds (stopped compute, bounded like
	 * the fleet-visible walk) and every one must already be in the verified
	 * store with at least its size. Sessions are not hashed (the fleet cannot
	 * read the bytes), so a same-size rewrite is not caught here; truncation
	 * and unstreamed files are. An empty inventory proves there is nothing to
	 * lose, whatever the store holds. A provider that fails, is truncated, or
	 * does not implement `list-sessions` (rejected as `invalid_request`, or an
	 * ok response without an inventory) proves nothing: deletion is refused.
	 */
	async #verifyProviderInventory(
		daemonId: string,
		storeManifest: ArchiveManifest | undefined,
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const unverifiable = (reason: string): { ok: false; message: string } => ({
			ok: false,
			message: `cannot verify store completeness for ${daemonId}: volume is not fleet-readable and ${reason}`,
		});
		let inventory: ProviderOkResponse;
		try {
			inventory = await this.#runCloneOp(
				daemonId,
				"list-sessions",
				this.#handleOf(this.#require(daemonId)),
			);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return unverifiable(`the provider could not list its sessions (${reason})`);
		}
		if (inventory.sessions === undefined) {
			return unverifiable("the provider returned no session inventory (list-sessions unsupported)");
		}
		if (inventory.complete !== true) {
			return {
				ok: false,
				message: `session tree for ${daemonId} exceeds verification bounds (${MAX_EXPORT_FILES} files / ${MAX_EXPORT_BYTES} bytes); deletion blocked`,
			};
		}
		const stored = new Map<string, number>();
		for (const file of storeManifest?.files ?? []) {
			stored.set(`${file.sessionId}/${file.path}`, file.size);
		}
		// Same file selection as the fleet-visible walk: files inside a
		// session directory with a normalized relative path.
		for (const file of inventory.sessions) {
			const slash = file.path.indexOf("/");
			if (slash <= 0) continue;
			const sessionId = file.path.slice(0, slash);
			const relpath = file.path.slice(slash + 1);
			if (!SESSION_DIR_NAME.test(sessionId) || !isNormalizedPosixRelativePath(relpath)) continue;
			const storedSize = stored.get(file.path);
			if (storedSize === undefined) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${sessionId} file ${relpath} (${file.size} bytes) is on its volume but missing from the fleet store; deletion blocked (logs were not fully streamed)`,
				};
			}
			if (storedSize < file.size) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${sessionId} file ${relpath} is truncated in the fleet store (${storedSize}/${file.size} bytes); deletion blocked`,
				};
			}
		}
		return { ok: true };
	}

	// ------------------------------------------------------------------
	// Provider invocation / paths / enrollment handoff
	// ------------------------------------------------------------------

	/** Resolve the profile (typed unavailable when absent). */
	#cloneProfile(entry: RegistryEntry): {
		profileId: string;
		profile: NonNullable<FleetConfig["providerProfiles"]>[string];
	} {
		const profileId = entry.workspace?.profileId;
		if (entry.workspace?.kind !== "clone" || profileId === undefined) {
			throw new CloneLifecycleError(
				"invalid_request",
				`clone workspace ${entry.daemonId} is missing a provider profile (kind ${entry.workspace?.kind ?? "legacy"})`,
			);
		}
		const profile = this.#deps.config.providerProfiles?.[profileId];
		if (profile === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`clone workspace ${entry.daemonId} has no resolvable provider profile "${profileId}" (no matching providerProfiles entry)`,
			);
		}
		return { profileId, profile };
	}

	/** Persisted volume location also anchors provider identity and callback state. */
	#clonePaths(entry: RegistryEntry): {
		volumeRoot: string;
		checkoutDir: string;
		homeDir: string;
		stateDir: string;
	} {
		const volumeRoot = entry.cwd;
		if (!volumeRoot || !isAbsolute(volumeRoot)) {
			throw new CloneLifecycleError(
				"unavailable",
				`clone workspace ${entry.daemonId} has no persisted absolute volume location`,
			);
		}
		return {
			volumeRoot,
			checkoutDir: cloneCheckoutDir(volumeRoot),
			homeDir: join(volumeRoot, ".home"),
			stateDir: join(dirname(volumeRoot), ".provider-state", entry.daemonId),
		};
	}

	/** Opaque string provider handle, when one is persisted. */
	#handleOf(entry: RegistryEntry): string | undefined {
		return typeof entry.workspace?.providerHandle === "string"
			? entry.workspace.providerHandle
			: undefined;
	}

	/**
	 * One provider operation invocation, typed. Re-reads the CURRENT
	 * registry entry by daemonId so every op builds its request from ONE
	 * consistent snapshot; a stale caller entry can never send a request
	 * carrying an old generation against a freshly enrolled one (P6.2
	 * fencing). `generationOverride` is REQUIRED on the ensure-running call
	 * after a generation bump: the bump is computed and enrolled BEFORE the
	 * provider runs, but `authorizedGeneration` on the record is only
	 * persisted AFTER ensure succeeds; without the override the request
	 * would carry the stale pre-bump generation and the provider would
	 * fence it. Maps provider failures onto the frozen error vocabulary
	 * with caller-safe messages.
	 */
	async #runCloneOp(
		daemonId: string,
		op: "ensure-running" | "inspect" | "stop" | "delete" | "list-sessions",
		handle: string | undefined,
		generationOverride?: number,
	): Promise<ProviderOkResponse> {
		const entry = this.#require(daemonId);
		const { profile } = this.#cloneProfile(entry);
		const { checkoutDir, homeDir, stateDir } = this.#clonePaths(entry);
		const generation = generationOverride ?? entry.workspace?.authorizedGeneration ?? 1;
		const record = entry.workspace;
		// Every op carries the workspace's clone source + pinned full commit
		// + branch (Runtime contract): the k8s provider initializes its PVC
		// in-pod at the persisted pin from these, never resolves itself;
		// bwrap ignores them (fleet-side prepared). Additive per
		// lib/runtime/provider-protocol.ts ProviderRequest.
		const request = {
			op,
			workspaceId: daemonId,
			generation,
			workspaceDir: checkoutDir,
			homeDir,
			profile,
			...(handle !== undefined ? { handle } : {}),
			stateDir,
			...(record?.source !== undefined ? { source: record.source } : {}),
			...(record?.pinnedRevision !== undefined ? { revision: record.pinnedRevision } : {}),
			...(record?.branch !== undefined ? { branch: record.branch } : {}),
		};
		const response = await runProviderOp(profile.executable, request);
		if (response.ok) return response;
		throw new CloneLifecycleError(
			this.#codeForProviderError(response.error.code),
			`provider ${op} failed for ${entry.daemonId} (${response.error.code}): ${response.error.message}`,
		);
	}

	#codeForProviderError(code: string): CloneLifecycleErrorCode {
		switch (code) {
			case "invalid_request":
				return "invalid_request";
			case "conflict":
				return "conflict";
			case "unavailable":
				return "unavailable";
			case "retryable":
				return "retryable";
			default:
				return "provider_failed";
		}
	}

	#codeForEnsureFailure(err: Error): CloneLifecycleErrorCode {
		return err instanceof CloneLifecycleError ? err.code : "provider_failed";
	}

	/**
	 * P8.9 wake resume: compute the resume target for a NEW daemon spawn.
	 * Returns the env hint to hand the daemon (OMP_SESSION_RESUME, plus
	 * OMP_SESSION_RESUME_UNWRITTEN when the file may not exist yet), or
	 * undefined when the wake should boot fresh. Fleet-visible volumes
	 * materialize cold/missing transcripts first; volumes the fleet cannot
	 * read resolve an in-pod path instead (#resolvePodWakeResume).
	 *   - never-started clones (no sessions anywhere) → fresh;
	 *   - explicit `resumeSessionId` that exists nowhere → typed
	 *     `unavailable` (the edge pre-validates against the store, so this
	 *     only fires on a store/volume disagreement, never silent fresh);
	 *   - implicit wake → newest session (volume ∪ store) so a stopped
	 *     clone wake continues its last session.
	 * Fill-missing-only materialization: existing volume files are never
	 * overwritten (the volume may hold a newer unacked tail; the daemon's
	 * tailer re-streams it once booted). Throws CloneLifecycleError
	 * `unavailable` when an explicit target cannot be materialized.
	 */
	async #resolveWakeResume(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string },
	): Promise<Record<string, string> | undefined> {
		const daemonId = entry.daemonId;
		const { profile } = this.#cloneProfile(entry);
		const record = this.#deps.registry.get(daemonId)?.workspace;
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;
		if (!PROVIDER_CAPABILITIES[profile.provider].volumeFleetVisible) {
			return this.#resolvePodWakeResume(daemonId, opts, everStarted);
		}
		const store = this.#deps.logStore;
		const { volumeRoot } = this.#clonePaths(entry);
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");

		const explicit = opts.resumeSessionId;
		const target =
			explicit !== undefined
				? explicit
				: opts.firstStart && !everStarted
					? undefined
					: pickNewestSessionId({
							sessionsDir,
							...(store !== null ? { store, workspaceId: daemonId } : {}),
						});
		if (target === undefined) return undefined; // Nothing to resume: fresh boot.

		if (store !== null) {
			try {
				await materializeMissingSessionFiles({
					store,
					workspaceId: daemonId,
					sessionId: target,
					sessionsDir,
				});
			} catch (err) {
				if (explicit !== undefined) {
					// An explicit pick that cannot be materialized is a typed
					// failure, never a silent fresh boot over the user's pick.
					throw err instanceof WakeMaterializeError
						? new CloneLifecycleError(
								err.code === "invalid_request" ? "invalid_request" : "unavailable",
								`cannot materialize session ${target} for wake of ${daemonId}: ${err.message}`,
							)
						: new CloneLifecycleError(
								"unavailable",
								`cannot materialize session ${target} for wake of ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
							);
				}
				// Implicit pick + materialize failure: fall back to whatever
				// is already warm on the volume (never fail a plain wake over
				// a store-only cold session).
			}
		} else if (explicit !== undefined) {
			// Explicit target with no store to fill from: only acceptable
			// when the volume already has it warm.
			if (resolveMainSessionFile(sessionsDir, target) === null) {
				throw new CloneLifecycleError(
					"unavailable",
					`cannot resume session ${target} for ${daemonId}: no fleet log store and the session is not on the volume`,
				);
			}
		}

		const mainFile = resolveMainSessionFile(sessionsDir, target);
		if (mainFile === null) {
			if (explicit !== undefined) {
				throw new CloneLifecycleError(
					"unavailable",
					`cannot resume session ${target} for ${daemonId}: no transcript on the volume or in the fleet store`,
				);
			}
			return undefined; // Implicit target vanished; boot fresh.
		}
		// Stale-lock cleanup (P8.9 boot-resume): omp-session's own PID-file
		// lock (#lib/platform/file-lock) sits at `<file>.lock`. A prior sandbox lifetime
		// that was stopped without a graceful release leaves that lock file
		// behind, and its PID is namespace-relative (e.g. 2 inside bwrap),
		// so the NEW sandbox's liveness probe sees an ALIVE pid 2 and refuses
		// to boot ("session file ... is locked by another omp-session"). This
		// wake only reaches here after the predecessor generation is PROVEN
		// terminated (P6.2 stop proof precedes the generation bump), so any
		// lock beside the resume target is definitionally stale: clear it
		// before the daemon spawns. Best-effort (a missing lock is fine).
		// This is NOT the SDK's identity-scoped session ownership lease: that
		// native OS lock is released on process death, and its flock sidecars
		// must never be unlinked (doing so can split ownership across inodes).
		try {
			unlinkSync(`${mainFile}.lock`);
		} catch {
			// Absent or already cleared, nothing to do.
		}
		return { OMP_SESSION_RESUME: mainFile };
	}

	/**
	 * Wake resume for a volume the fleet cannot read (kubernetes). No
	 * inventory call and no materialization: the hint is the in-pod path the
	 * session itself reported (`lastSessionFile`, from the `state` frame of its
	 * last pair-up) or, for a session known only to the fleet store, the
	 * store's main relpath under the in-pod sessions root. The pod is the
	 * authority on whether the file exists: the daemon boots strictly and exits
	 * 78 when it is missing, never booting fresh. A reported file the daemon
	 * has not confirmed on disk (a never-prompted session) carries
	 * OMP_SESSION_RESUME_UNWRITTEN, so the daemon adopts the path instead.
	 * The fleet-side validation is the same as for bwrap's explicit pick: an
	 * explicit id that is neither the reported session nor in the store is a
	 * typed `unavailable`. (A helper-pod `list-sessions` would add a pod
	 * schedule to every Start and conflicts with a terminated pod's corpse.)
	 */
	#resolvePodWakeResume(
		daemonId: string,
		opts: { firstStart: boolean; resumeSessionId?: string },
		everStarted: boolean,
	): Record<string, string> | undefined {
		const store = this.#deps.logStore;
		const entry = this.#deps.registry.get(daemonId);
		const reportedRelpath = podSessionRelpath(entry?.lastSessionFile);
		const reportedHint =
			reportedRelpath === undefined
				? undefined
				: {
						OMP_SESSION_RESUME: `${KUBERNETES_POD_LAYOUT.sessionsDir}/${reportedRelpath}`,
						...(entry?.lastSessionPersisted === true ? {} : { OMP_SESSION_RESUME_UNWRITTEN: "1" }),
					};
		const storedHint = (sessionId: string): Record<string, string> | undefined => {
			const relpath = store?.storedLineage(daemonId, sessionId)?.mainRelpath;
			return relpath !== undefined && isNormalizedPosixRelativePath(relpath)
				? { OMP_SESSION_RESUME: `${KUBERNETES_POD_LAYOUT.sessionsDir}/${relpath}` }
				: undefined;
		};

		const explicit = opts.resumeSessionId;
		if (explicit !== undefined) {
			if (!SESSION_DIR_NAME.test(explicit)) {
				throw new CloneLifecycleError(
					"invalid_request",
					`cannot resume session ${JSON.stringify(explicit)} for ${daemonId}: not a session id`,
				);
			}
			if (reportedRelpath?.split("/").pop() === `${explicit}.jsonl`) return reportedHint;
			const stored = storedHint(explicit);
			if (stored !== undefined) return stored;
			throw new CloneLifecycleError(
				"unavailable",
				`cannot resume session ${explicit} for ${daemonId}: it is neither the session the runtime last reported nor in the fleet store`,
			);
		}
		if (opts.firstStart && !everStarted) return undefined; // Never started: nothing to resume.
		if (reportedHint !== undefined) return reportedHint;
		// No reported session (the runtime never paired): the newest stored one.
		let newest: { sessionId: string; mtimeMs: number } | undefined;
		for (const session of store?.listStoredSessions(daemonId) ?? []) {
			if (session.mainRelpath === undefined) continue;
			if (newest === undefined || session.mtimeMs > newest.mtimeMs) newest = session;
		}
		return newest === undefined ? undefined : storedHint(newest.sessionId);
	}

	/** Write the 0600 callback-enrollment handoff BEFORE ensure-running. */
	#writeCallbackEnv(
		entry: RegistryEntry,
		generation: number,
		credentialHex: string,
		extraEnv?: Record<string, string>,
	): void {
		const { stateDir } = this.#clonePaths(entry);
		mkdirSync(stateDir, { recursive: true });
		const url = this.#deps.callbackUrl();
		const allowHttp = url.startsWith("http://") ? "1" : undefined;
		const env: Record<string, string> = {
			OMP_SESSION_CALLBACK_URL: url,
			OMP_SESSION_CALLBACK_WORKSPACE: entry.daemonId,
			OMP_SESSION_CALLBACK_GENERATION: String(generation),
			OMP_SESSION_CALLBACK_TOKEN: credentialHex,
		};
		if (allowHttp !== undefined) env.OMP_SESSION_CALLBACK_ALLOW_HTTP = allowHttp;
		if (extraEnv !== undefined) {
			for (const [key, value] of Object.entries(extraEnv)) {
				if (env[key] !== undefined) {
					// Reserved: the enrollment keys own these names; never
					// allow a resume hint to shadow the callback pair.
					throw new CloneLifecycleError(
						"invalid_request",
						`refusing to overwrite callback env key ${key}`,
					);
				}
				env[key] = value;
			}
		}
		const payload = JSON.stringify({ version: 1, workspaceId: entry.daemonId, generation, env });
		const path = join(stateDir, "callback-env.json");
		// Mode 0600 exactly: an explicit 0600 fd so umask can never loosen it.
		const fd = openSync(path, "w", 0o600);
		try {
			writeSync(fd, payload);
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Recover the raw enrollment token from the provider state file so a
	 * re-ensure on the SAME generation keeps the credential the daemon
	 * already holds (restart-safe; only the digest is ever persisted).
	 */
	#persistedCallbackToken(entry: RegistryEntry, generation: number): string {
		const { stateDir } = this.#clonePaths(entry);
		const token = readCallbackEnv(
			"fleet",
			stateDir,
			entry.daemonId,
			generation,
		)?.OMP_SESSION_CALLBACK_TOKEN;
		if (token === undefined || token.length === 0) {
			throw new Error(
				`cannot recover callback token for ${entry.daemonId} generation ${generation} from the persisted state file`,
			);
		}
		return token;
	}

	// ------------------------------------------------------------------
	// Stage + readiness bookkeeping
	// ------------------------------------------------------------------

	/** Write lifecycleStage (+ optional error) and broadcast via onChange. */
	#setStage(daemonId: string, stage: LifecycleStage, error?: string): void {
		const entry = this.#deps.registry.get(daemonId);
		if (!entry) return;
		this.#deps.registry.update(daemonId, {
			lifecycleStage: stage,
			...(error !== undefined ? { lifecycleError: error } : { lifecycleError: undefined }),
		});
	}

	/**
	 * Runtime watch: supervises one desired-running clone from its start until
	 * it stops. It polls the transport pair status (in-memory, cheap) and
	 * re-inspects the provider only while the pair is down:
	 *   - pair up: lifecycleStage "ready"; the restart budget's stable window
	 *     runs, so a pair that holds forgives earlier restarts;
	 *   - pair down, runtime alive (inspect running): nothing; the session
	 *     redials. A drop is not inspected before `pairLossGraceMs`
	 *     (registry PAIR_LOSS_GRACE_MS), so a brief drop never acts;
	 *   - pair down, runtime proven not running (inspect stopped/missing):
	 *       - a pair never held since the explicit start: stage "failed" +
	 *         status "error" (a start that never came up is the operator's
	 *         to retry; never an eternal "callback" stage over a dead pid);
	 *       - otherwise the predecessor's credential is revoked and a restart
	 *         is scheduled after a jittered backoff: #ensure (inspect-proven
	 *         predecessor, fresh credential, generation + 1). Each restart
	 *         spends the budget; exhausting it surfaces stage "failed" +
	 *         status "error" with the reason.
	 * Every inspect/restart decision runs on the clone's op queue, so an
	 * explicit stop/start/delete never interleaves with it. `resume` keeps the
	 * existing watch (and its budget) across a restart's own #ensure; any other
	 * arm starts a fresh watch. Explicit stop disposes the watch.
	 */
	#armRuntimeWatch(daemonId: string, opts: { restartable: boolean; resume: boolean }): void {
		let watch = this.#watches.get(daemonId);
		if (watch !== undefined && opts.resume) {
			clearTimeout(watch.timer);
			watch.restartable = true; // A restart chain stays restartable.
		} else {
			this.#disposeWatch(daemonId);
			const created: RuntimeWatch = {
				budget: new RestartBudget(this.#policy),
				restartable: opts.restartable,
				paired: false,
				nextInspectAt: 0,
				timer: undefined,
				unsubscribe: () => {},
			};
			created.unsubscribe = this.#deps.transport.onPairChange(daemonId, (status) => {
				if (status.paired) created.restartable = true;
			});
			watch = created;
			this.#watches.set(daemonId, watch);
		}
		watch.paired = false;
		watch.nextInspectAt = Date.now() + this.#policy.inspectEveryMs;
		this.#scheduleTick(daemonId, watch);
	}

	#scheduleTick(daemonId: string, watch: RuntimeWatch): void {
		watch.timer = setTimeout(() => void this.#tick(daemonId, watch), this.#policy.tickMs);
	}

	/** Stop watching (explicit stop, close, failure); an `only` watch that was already replaced is left alone. */
	#disposeWatch(daemonId: string, only?: RuntimeWatch): void {
		const watch = this.#watches.get(daemonId);
		if (watch === undefined || (only !== undefined && watch !== only)) return;
		clearTimeout(watch.timer);
		watch.unsubscribe();
		watch.budget.dispose();
		this.#watches.delete(daemonId);
	}

	/** The entry while `watch` is still the clone's current watch and the clone is desired-running and not being deleted. */
	#watchLive(daemonId: string, watch: RuntimeWatch): RegistryEntry | undefined {
		const entry = this.#deps.registry.get(daemonId);
		if (this.#watches.get(daemonId) !== watch) return undefined;
		const record = entry?.workspace;
		if (record?.desiredState !== "running" || record.deletion?.state !== undefined)
			return undefined;
		return entry;
	}

	async #tick(daemonId: string, watch: RuntimeWatch): Promise<void> {
		watch.timer = undefined;
		if (this.#watchLive(daemonId, watch) === undefined) {
			this.#disposeWatch(daemonId, watch);
			return;
		}
		const pair = this.#deps.transport.pairStatus(daemonId);
		if (pair.paired && pair.enrolled) {
			if (!watch.paired) {
				watch.paired = true;
				watch.restartable = true;
				watch.budget.paired();
				this.#setStage(daemonId, "ready");
			}
		} else {
			if (watch.paired) {
				watch.paired = false;
				watch.budget.unpaired();
				watch.nextInspectAt = Date.now() + this.#policy.pairLossGraceMs;
			}
			if (Date.now() >= watch.nextInspectAt) {
				watch.nextInspectAt = Date.now() + this.#policy.inspectEveryMs;
				await this.#serialized(daemonId, () => this.#inspectWatched(daemonId, watch));
			}
		}
		// Re-arm unless the watch ended or a restart backoff took the timer.
		if (this.#watches.get(daemonId) === watch && watch.timer === undefined) {
			this.#scheduleTick(daemonId, watch);
		}
	}

	/** One provider inspect for a pair-down watch; runs on the clone's op queue. */
	async #inspectWatched(daemonId: string, watch: RuntimeWatch): Promise<void> {
		const entry = this.#watchLive(daemonId, watch);
		if (entry === undefined) return;
		if (this.#deps.transport.pairStatus(daemonId).paired) return; // Re-paired while queued.
		let observed: string;
		try {
			observed = (await this.#runCloneOp(daemonId, "inspect", this.#handleOf(entry))).observed;
		} catch {
			// Inspect failed (provider unavailable or a typed conflict): keep
			// polling; the next inspect retries. A genuinely dead runtime
			// reports observed != running (not an error), handled below.
			return;
		}
		if (observed === "running") return;
		if (!watch.restartable) {
			const message = `sandbox stopped before the callback pair established (observed ${observed})`;
			this.#setStage(daemonId, "failed", message);
			this.#deps.registry.setStatus(daemonId, "error", `${message}; stop and start to retry`);
			this.#disposeWatch(daemonId, watch);
			this.#log(
				"warn",
				`clone ${daemonId} callback never established; sandbox ${observed}`,
				daemonId,
			);
			return;
		}
		// Inspect proved the predecessor gone: fence its credential now, so it
		// stays dead through the backoff window (#ensure bumps the generation).
		const generation = entry.workspace?.authorizedGeneration;
		if (generation !== undefined) {
			this.#deps.transport.revokeEnrollment(daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, generation);
		}
		this.#scheduleRestart(daemonId, watch, `runtime ${observed} after its pair came up`);
	}

	/**
	 * Spend one restart from the budget and arm the backoff timer, or surface
	 * "failed"/error with `reason` when the budget is exhausted. Reused by a
	 * restart whose own #ensure failed, so provider flaps are bounded too.
	 */
	#scheduleRestart(daemonId: string, watch: RuntimeWatch, reason: string): void {
		const claim = watch.budget.next();
		if (claim === null) {
			const message = `${reason}; restart budget exhausted (${watch.budget.restartMax} restarts allowed since the last stable pair); stop and start to retry`;
			this.#setStage(daemonId, "failed", message);
			this.#deps.registry.setStatus(daemonId, "error", message);
			this.#disposeWatch(daemonId, watch);
			this.#log("error", `clone ${daemonId} ${message}`, daemonId);
			return;
		}
		this.#setStage(daemonId, "runtime");
		this.#deps.registry.setStatus(daemonId, "reconnecting");
		this.#log(
			"warn",
			`clone ${daemonId} ${reason}; restart ${claim.attempt + 1}/${watch.budget.restartMax} in ${claim.delayMs}ms`,
			daemonId,
		);
		watch.timer = setTimeout(() => {
			watch.timer = undefined;
			void this.#serialized(daemonId, () => this.#restartRuntime(daemonId, watch));
		}, claim.delayMs);
	}

	/** The restart itself: the ordinary ensure (inspect-proven predecessor, revoke, fresh credential, generation + 1). */
	async #restartRuntime(daemonId: string, watch: RuntimeWatch): Promise<void> {
		const entry = this.#watchLive(daemonId, watch);
		if (entry === undefined) return; // Explicit stop/delete won the race.
		try {
			const response = await this.#ensure(entry, { firstStart: false, recovery: true });
			if (response.observed !== "running") {
				this.#scheduleRestart(
					daemonId,
					watch,
					`provider reported ${response.observed} after restart`,
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#scheduleRestart(daemonId, watch, `restart failed: ${message}`);
		}
	}

	// ------------------------------------------------------------------
	// Internal plumbing
	// ------------------------------------------------------------------

	#require(daemonId: string): RegistryEntry {
		const entry = this.#deps.registry.get(daemonId);
		if (!entry) throw new CloneLifecycleError("invalid_request", `unknown daemon: ${daemonId}`);
		return entry;
	}

	#requireClone(daemonId: string, verb: string): RegistryEntry {
		const entry = this.#require(daemonId);
		if (entry.workspace?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace (kind ${entry.workspace?.kind ?? "legacy"}); ${verb} a worktree/direct session through its own path`,
			);
		}
		return entry;
	}

	#log(level: "info" | "warn" | "error", message: string, daemonId?: string): void {
		this.#deps.eventLog.add(level, "server", message, daemonId);
	}

	/** Remove a just-created (never-streamed) entry + its partial volume. */
	#removeEntryAndVolume(daemonId: string, volumeRoot: string): void {
		try {
			rmSync(volumeRoot, { recursive: true, force: true });
		} catch {
			// Best-effort: the volume may be mid-write; the registry removal
			// below is the durable part.
		}
		this.#deps.registry.remove(daemonId);
	}
}
