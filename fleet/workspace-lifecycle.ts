/**
 * Clone-workspace lifecycle service (clone-plan P6/P7; proposed module
 * `fleet/workspace-lifecycle.ts`). THE single create/ensure/stop/delete
 * owner for provider-managed clone workspaces, shared by the control-plane
 * HTTP handlers (POST /ctl/clones, /ctl/start|wake, /ctl/stop, DELETE
 * /ctl/worktrees/:id) and the browser edge's command dispatch (Transport's
 * `EdgeLifecycleHooks` — this class conforms to it structurally).
 *
 * Frozen contracts: docs/clone-contracts.md ("Browser and CLI workspace
 * creation", "Provider operation protocol", "Fleet log store", "Retention",
 * "Wake", "Typed errors") and docs/clone-plan.md P6/P7.
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
 *   provider deletion → volume deletion → roster removal). `removeClone`
 *   routes through the SAME gate — no kind-blind roster eviction can bypass
 *   it.
 * - Stop preserves checkout and session logs; only the verified gate
 *   deletes. Idle handling stays fleet-owned (P6.4): this service never
 *   stops compute on its own; explicit stop/wake are the only transitions.
 *
 * The fleet server injects everything external (registry, config, callback
 * transport, log store, resource deleter, event ring, log-tap attach, and
 * the callback base URL); this module has no HTTP surface of its own.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { ENROLLMENT_KEY_BYTES } from "../shared/callback-protocol";
import type { LifecycleStage } from "../shared/protocol";
import type {
	CloneDeletionReceipt,
	DeletionGateError,
	Registry,
	RegistryEntry,
	WorkspaceRecord,
} from "./registry";
import type { FleetConfig } from "./config";
import type { DaemonTransportRegistry } from "./daemon-transport";
import type { FleetLogStore } from "./log-store";
import type { FleetEventLog } from "./events";
import type { WorkspaceResourceDeleter } from "./server";
import {
	computeSourcePinDigest,
	newResourceIdentity,
	OMP_PROVIDER_PROTO,
	providerErrorToLifecycleCode,
	validateKubernetesSource,
	type KubernetesBinding,
	type KubernetesObserved,
	type ProviderErrorCode,
	type ProviderOkResponse,
	type ProviderRequest,
	type ProviderResponse,
} from "../shared/provider-protocol";
import { acquireFileLock, LockHeldError, type FileLock } from "../shared/file-lock";
import { providerOpTimeouts, runProviderOp, type ProviderOpWaits } from "../runtime/provider-exec";
import { parseKubernetesCallbackUrl } from "../server/config";
import {
	deriveWorkspaceBranch,
	PrepareWorkspaceError,
	prepareWorkspace,
	readWorkspaceInitMarker,
	resolveWorkspacePin,
	validateWorkspaceRef,
} from "../runtime/prepare-workspace";
import { verifyWorkspaceLogs } from "../runtime/verify-store";
import { seedSandboxBaseline } from "../runtime/sandbox-baseline";
import { MAX_EXPORT_BYTES, MAX_EXPORT_FILES } from "../runtime/export-sessions";
import { RESERVED_SECRET_ENV_KEYS } from "../runtime/bwrap-args";
import {
	readCallbackEnvFile,
	writeCallbackEnvFile,
	type CallbackEnvRecord,
} from "../runtime/callback-env";
import {
	CloneQuiesceError,
	receiptAllowsDelete,
	type CloneQuiesceRequest,
	type CloneQuiesceReceipt,
} from "./clone-quiesce";
import {
	WakeMaterializeError,
	materializeMissingSessionFiles,
	pickNewestSessionId,
	resolveMainSessionFile,
} from "./wake-materialize";
import type { ArchiveManifest } from "../shared/archive-manifest";
import { isNormalizedPosixRelativePath } from "../shared/archive-manifest";

// ---------------------------------------------------------------------------
// Kubernetes binding constants (Runtime contract)
// ---------------------------------------------------------------------------

/** In-pod mount root of a kubernetes workspace's volume. */
const KUBERNETES_WORKSPACE_ROOT = "/workspace";
/**
 * In-pod agent sessions root. A kubernetes resume hint must name a POD path
 * (the fleet never sees the PVC), so a session id maps here, never to the
 * fleet-host volume path.
 */
const KUBERNETES_SESSIONS_ROOT = `${KUBERNETES_WORKSPACE_ROOT}/.home/agent/sessions`;
/**
 * Env names the kubernetes provider owns on the Pod. A profile secretRef may
 * never shadow one (it would duplicate a container env entry and could
 * override the callback pair or the workspace identity).
 */
const KUBERNETES_RESERVED_ENV_KEYS: readonly string[] = [
	"OMP_WORKSPACE_ID",
	"OMP_WORKSPACE_GENERATION",
	"OMP_WORKSPACE_TOKEN",
	"OMP_WORKSPACE_ROOT",
	"OMP_WORKSPACE_DIR",
	"OMP_PROVIDER_PROTO",
	"OMP_PREP_SOURCE_REMOTE",
	"OMP_PREP_REVISION",
	"OMP_PREP_BRANCH",
	"OMP_SESSION_RESUME_REQUIRED",
	"HOME",
	"PATH",
	"LANG",
	"TERM",
	"PI_CODING_AGENT_DIR",
];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Typed errors (frozen ledger vocabulary; message text is safe to surface)
// ---------------------------------------------------------------------------

/** Error codes this service raises; the frozen ledger vocabulary. */
export type CloneLifecycleErrorCode =
	| "invalid_request"
	| "invalid_identity"
	| "unauthorized"
	| "forbidden"
	| "unavailable"
	| "conflict"
	| "generation_obsolete"
	| "writer_active"
	| "archive_pending"
	| "archive_conflict"
	| "provider_failed"
	| "retryable";

/** Typed lifecycle failure; `message` is caller-safe (roster/HTTP/edge). */
export class CloneLifecycleError extends Error {
	constructor(
		readonly code: CloneLifecycleErrorCode,
		message: string,
	) {
		super(message);
	}
}

/** Membership test for the frozen lifecycle vocabulary (no cast at call sites). */
const LIFECYCLE_ERROR_CODES: Record<CloneLifecycleErrorCode, true> = {
	invalid_request: true,
	invalid_identity: true,
	unauthorized: true,
	forbidden: true,
	unavailable: true,
	conflict: true,
	generation_obsolete: true,
	writer_active: true,
	archive_pending: true,
	archive_conflict: true,
	provider_failed: true,
	retryable: true,
};

// ---------------------------------------------------------------------------
// Inputs / deps
// ---------------------------------------------------------------------------

/** create_clone input (frozen contract; `id`/`type` are edge-only). */
export interface CloneCreateInput {
	projectId: string;
	name: string;
	profileId: string;
	/** Exactly one member when given; absent = the registered project's local path. */
	source?: { local?: string; remote?: string };
	/** Clone pin vocabulary (never baseRef). */
	revision?: string;
	branch?: string;
	start?: boolean;
}

/** External wiring the fleet server injects (nothing HTTP here). */
export interface WorkspaceLifecycleDeps {
	registry: Registry;
	config: Pick<FleetConfig, "workspaceDir" | "providerProfiles">;
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
	/**
	 * Kubernetes final-evidence collector (stage 3). The server injects the
	 * fleet's `CloneQuiesce` collector; the gate calls it BEFORE stopping the
	 * Pod so the daemon's writers are flushed and its evidence upload is
	 * validated against the fleet store. Absent = today's behavior (no
	 * receipt collected), so bwrap-only wiring is unaffected.
	 */
	collectCloneEvidence?: (request: CloneQuiesceRequest) => Promise<CloneQuiesceReceipt>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read one piped child stream to a UTF-8 string. */
async function readTextStream(
	stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value as Buffer, { stream: true });
	}
	return out;
}

/**
 * One argv invocation via explicit argv — never a shell — with a bounded
 * wall-clock budget. Exit code 124 signals the timeout (the child is killed).
 */
async function runCommand(
	argv: string[],
	opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
	}) as Subprocess & {
		stdout: ReadableStream<Uint8Array<ArrayBufferLike>>;
		stderr: ReadableStream<Uint8Array<ArrayBufferLike>>;
	};
	// Both pipe readers start before the race so the child can never block on
	// a full pipe buffer; the bounded budget starts at spawn and covers pipe
	// EOF as well as process exit. A hung child that holds its pipes open (a
	// `kubectl get namespace` against an unreachable API server) would
	// otherwise keep the documented bound from ever firing.
	const pipes = Promise.all([readTextStream(child.stdout), readTextStream(child.stderr)]);
	const { promise: timeout, resolve: onTimeout } = Promise.withResolvers<void>();
	const timer = setTimeout(onTimeout, opts?.timeoutMs ?? 15_000);
	const drained = Promise.all([child.exited, pipes]).then(([, [stdout, stderr]]) => ({
		stdout,
		stderr,
	}));
	const outcome = await Promise.race([
		drained.then((value) => ({ timedOut: false as const, value })),
		timeout.then(() => ({ timedOut: true as const })),
	]);
	clearTimeout(timer);
	if (outcome.timedOut) {
		child.kill("SIGKILL");
		await child.exited.catch(() => {
			// Exit may reject if the child was never reaped; ignore.
		});
		// The kill closed both pipes: collect whatever the child wrote.
		const [stdout, stderr] = await pipes;
		return { exitCode: 124, stdout, stderr: `${stderr}\ncommand timed out` };
	}
	await child.exited.catch(() => {
		// Handled below through exitCode.
	});
	return {
		exitCode: child.exitCode ?? 1,
		stdout: outcome.value.stdout,
		stderr: outcome.value.stderr,
	};
}

/** One `git -C <cwd> <args>` invocation. */
async function runGit(
	args: string[],
	cwd: string,
	opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return await runCommand(["git", "-C", cwd, ...args], opts);
}

/** sha256 hex of a file read via a bounded chunk stream. */
async function sha256File(absolute: string): Promise<string> {
	const hash = createHash("sha256");
	const file = Bun.file(absolute);
	const stream = file.stream();
	const reader = stream.getReader();
	const chunk = new Uint8Array(256 * 1024);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		let offset = 0;
		while (offset < value.length) {
			const take = Math.min(chunk.length, value.length - offset);
			hash.update(value.subarray(offset, offset + take));
			offset += take;
		}
	}
	return hash.digest("hex");
}

/** One volume file the completeness cross-check compares against the store. */
interface VolumeFile {
	sessionId: string;
	/** POSIX relpath inside the session dir (manifest rules). */
	relpath: string;
	size: number;
}

/**
 * Walk one volume session dir for regular files (no traversal, no symlinks),
 * mirroring the manifest relpath rules, bounded like the export gate.
 */
function walkSessionDir(
	sessionDir: string,
	sessionId: string,
	state: { files: number; bytes: number },
	out: VolumeFile[],
): void {
	let entries;
	try {
		entries = readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		return; // Missing/unreadable session dir: nothing to enumerate.
	}
	for (const dent of entries) {
		const absolute = join(sessionDir, dent.name);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(absolute);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink()) continue; // Reject symlinks (P7.2).
		if (stats.isDirectory()) {
			walkSessionDir(absolute, sessionId, state, out);
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
}

/** Read one directory's entries (missing/unreadable → []). */
function listDir(dir: string): Array<{ name: string; isDirectory(): boolean }> {
	try {
		return readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
			name: string;
			isDirectory(): boolean;
		}>;
	} catch {
		return [];
	}
}

function relativePosix(fromDir: string, absolute: string): string {
	const rel = absolute
		.slice(fromDir.length)
		.replace(/^[/\\]+/, "")
		.split("\\")
		.join("/");
	return rel;
}

/**
 * The generation an operation must fence: the newest ATTEMPTED generation
 * whenever it is ahead of the authorized one (a failed launch created, or
 * partially created, that resource), else the authorized generation. Mirrors
 * `#ensure`'s in-flight selection so stop, delete, and start all name the same
 * generation; selecting the authorized one would make the provider's
 * generation-ownership check refuse to touch the attempted resource.
 */
function fencedGeneration(record: WorkspaceRecord | undefined): number | undefined {
	const authorized = record?.authorizedGeneration;
	const attempted = record?.lastAttemptedGeneration;
	if (attempted !== undefined && attempted > (authorized ?? 0)) return attempted;
	return authorized ?? attempted;
}

/**
 * Kubernetes wait defaults (ms), mirroring runtime/providers/kubernetes-provider.ts
 * (`ENSURE_WAIT_MS_DEFAULT`/`STOP_WAIT_MS_DEFAULT`/`DELETE_WAIT_MS_DEFAULT`,
 * which are private there). The fleet computes the provider's own invocation
 * budget from the SAME env knobs the provider reads: without them a cold pull
 * or a deletion the provider legitimately allows would be killed fleet-side at
 * the default provider-op timeout.
 */
const KUBE_ENSURE_WAIT_MS_DEFAULT = 120_000;
const KUBE_STOP_WAIT_MS_DEFAULT = 60_000;
const KUBE_DELETE_WAIT_MS_DEFAULT = 60_000;

/** One wait override from the env, parsed exactly like the provider does. */
function envWaitMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The provider waits this fleet invocation must budget for. */
function kubernetesProviderWaits(): ProviderOpWaits {
	return {
		ensureWaitMs: envWaitMs("OMP_KUBE_ENSURE_WAIT_MS", KUBE_ENSURE_WAIT_MS_DEFAULT),
		stopWaitMs: envWaitMs("OMP_KUBE_STOP_WAIT_MS", KUBE_STOP_WAIT_MS_DEFAULT),
		deleteWaitMs: envWaitMs("OMP_KUBE_DELETE_WAIT_MS", KUBE_DELETE_WAIT_MS_DEFAULT),
	};
}

/**
 * Sanitized sandbox baseline for a provider-side prepared volume (P5.5).
 *
 * A fleet-side prepared volume (bwrap) gets its baseline written directly by
 * prepareWorkspace, which runs on this host and can read the operator's agent
 * dir. A provider-side prepared volume (kubernetes) is prepared in-pod, where
 * that dir does not exist, so the documents must ride the provider request
 * instead. Running the SAME seed authority into a scratch volume keeps the two
 * paths byte-identical: one sanitizer, one role filter, one output.
 *
 * Returns undefined when there is nothing to seed (no operator config, or the
 * seed filtered everything out); the provider then leaves the volume unseeded,
 * exactly as before this path existed. Never throws: a scratch/read failure
 * must not fail the workspace operation the baseline only augments.
 */
async function sandboxBaselineDocuments(
	profile: NonNullable<FleetConfig["providerProfiles"]>[string],
): Promise<{ configYaml: string; modelsYaml?: string } | undefined> {
	let scratch: string | undefined;
	try {
		scratch = mkdtempSync(join(tmpdir(), "omp-baseline-"));
		// Roles are filtered against the env names the pod will actually
		// carry, which is exactly the profile's secretRefs key set.
		await seedSandboxBaseline(scratch, {
			sandboxEnvKeys: Object.keys(profile.secretRefs ?? {}),
		});
		const agentDir = join(scratch, ".home", "agent");
		const configPath = join(agentDir, "config.yml");
		if (!existsSync(configPath)) return undefined;
		const configYaml = readFileSync(configPath, "utf8");
		if (configYaml.trim() === "") return undefined;
		const modelsPath = join(agentDir, "models.yml");
		const modelsYaml = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : undefined;
		return {
			configYaml,
			...(modelsYaml !== undefined && modelsYaml.trim() !== "" ? { modelsYaml } : {}),
		};
	} catch {
		return undefined;
	} finally {
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Does this profile prepare its volume provider-side (in-pod)? Those are the
 * profiles that need the baseline shipped in the request; fleet-side prepared
 * profiles already seeded their volume and must not carry a second copy.
 */
function preparesVolumeProviderSide(
	profile: NonNullable<FleetConfig["providerProfiles"]>[string],
): boolean {
	return profile.provider === "kubernetes";
}

/**
 * Post-ready pair-loss poll cadence (ms). Once the pair has been observed
 * live, the watcher keeps a slower watch: a sandbox whose worker disappears
 * AFTER readiness (nothing else would re-inspect it) is probed at most once
 * per interval and demoted, never left presented as live. 5 s is slow enough
 * that a healthy live pair costs nothing (the live branch never inspects) and
 * a lost pair is detected promptly.
 */
const PAIR_POST_READY_POLL_MS = 5_000;

// ---------------------------------------------------------------------------
// The lifecycle service
// ---------------------------------------------------------------------------

/**
 * Clone workspace lifecycle owner. Conforms to Transport's `EdgeLifecycleHooks`
 * (createClone / ensureCloneRunning / stopClone / deleteClone / removeClone);
 * richer method returns are assignable to the void-hook signatures.
 */
export class WorkspaceLifecycle {
	readonly #deps: WorkspaceLifecycleDeps;
	/** Workspaces with a verified delete gate in flight (serializes DELETEs). */
	readonly #deleting = new Set<string>();
	/**
	 * Per-workspace lifecycle-operation queue. Every public mutation (create
	 * start, start/wake, stop, delete, boot reconcile) chains here so two
	 * operations on one workspace never interleave their registry reads and
	 * writes. Provider invocations additionally take the workspace file lock
	 * (cross-process), acquired inside {@link #runCloneOp}.
	 */
	readonly #queues = new Map<string, Promise<void>>();
	/** Bounded pair-readiness watchers (setTimeout id per workspace). */
	readonly #pairWatchers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(deps: WorkspaceLifecycleDeps) {
		this.#deps = deps;
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
	 * and the error is typed — nothing streamed, nothing retained. On
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
		if (
			(sourceLocal !== undefined && sourceRemote !== undefined) ||
			(sourceLocal !== undefined && typeof sourceLocal !== "string") ||
			(sourceRemote !== undefined && typeof sourceRemote !== "string")
		) {
			throw new CloneLifecycleError(
				"invalid_request",
				"source must carry exactly one of local (string path) or remote (string URL)",
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

		// Resolve the profile FIRST (stage 1 item 3): a kubernetes clone's
		// source, environment, and binding admissions all depend on it.
		const profile = config.providerProfiles?.[profileId];
		if (profile === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`no resolvable provider profile "${profileId}" (no matching providerProfiles entry)`,
			);
		}

		const project = registry.projects().find((p) => p.projectId === projectId);
		if (project === undefined) {
			throw new CloneLifecycleError("invalid_request", `unknown project: ${projectId}`);
		}

		// Exactly-one source: an omitted source defaults to the registered
		// project's own local path (frozen contract).
		let source: { local?: string; remote?: string } =
			sourceLocal !== undefined || sourceRemote !== undefined
				? {
						...(sourceLocal !== undefined ? { local: sourceLocal } : {}),
						...(sourceRemote !== undefined ? { remote: sourceRemote } : {}),
					}
				: { local: project.path };
		const start = input.start ?? false;
		const branch = input.branch ?? deriveWorkspaceBranch(name);
		try {
			validateWorkspaceRef(branch);
		} catch (err) {
			throw new CloneLifecycleError(
				"invalid_request",
				err instanceof Error ? err.message : `invalid branch name: ${JSON.stringify(branch)}`,
			);
		}

		// Kubernetes admission (stage 1 item 3, stage 2 items 1/5): a
		// kubernetes clone needs a validated remote source, an explicit
		// context + namespace, a usable callback URL, and a secretRef set
		// that shadows no reserved Pod env name. The binding's namespace UID
		// is resolved HERE, before registration, because the provider treats
		// it as authoritative on every operation and never tolerates a
		// placeholder.
		let kubernetes: KubernetesBinding | undefined;
		let kubernetesRemote: string | undefined;
		if (profile.provider === "kubernetes") {
			if (source.remote === undefined) {
				throw new CloneLifecycleError(
					"invalid_request",
					`kubernetes profile "${profileId}" requires a remote source (input.source.remote); a local path is a fleet-host path the in-pod provider cannot reach`,
				);
			}
			try {
				kubernetesRemote = validateKubernetesSource(source.remote);
			} catch (err) {
				throw new CloneLifecycleError(
					"invalid_request",
					err instanceof Error ? err.message : `invalid kubernetes source: ${source.remote}`,
				);
			}
			source = { remote: kubernetesRemote }; // validated text verbatim; never a local member
			const context = profile.context;
			if (context === undefined || context === "") {
				throw new CloneLifecycleError(
					"invalid_request",
					`kubernetes profile "${profileId}" has no context (providerProfiles.${profileId}.context); the provider never falls back to the ambient current-context`,
				);
			}
			const namespace = profile.namespace;
			if (namespace === undefined || namespace === "") {
				throw new CloneLifecycleError(
					"invalid_request",
					`kubernetes profile "${profileId}" has no namespace (providerProfiles.${profileId}.namespace)`,
				);
			}
			this.#validateKubernetesEnvironment(profile);
			const namespaceUid = await this.#resolveNamespaceUid(context, namespace);
			kubernetes = { resourceIdentity: newResourceIdentity(), context, namespace, namespaceUid };
		}

		// Resolve the pin ONCE, before registration, for EVERY profile
		// (fleet-owned pin resolution — the k8s provider never resolves;
		// Runtime contract). One Registry.create below then persists the
		// complete workspace atomically.
		let pinnedRevision: string;
		try {
			pinnedRevision = await resolveWorkspacePin(source, input.revision, {
				// The workspaceDir is created lazily and may not exist yet on a
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
			// Nothing was registered yet, so nothing is retained.
			throw new CloneLifecycleError(code, `cannot resolve clone pin: ${message}`);
		}
		const sourcePinDigest =
			kubernetesRemote !== undefined
				? computeSourcePinDigest(kubernetesRemote, pinnedRevision, branch)
				: undefined;

		// Durable identity + the COMPLETE workspace record in ONE atomic
		// save (stage 1 item 3): provider kind, binding, pin, and digest all
		// persist before any retry-prone step.
		const record: WorkspaceRecord = {
			kind: "clone",
			projectId,
			source,
			branch,
			profileId,
			providerKind: kubernetes !== undefined ? "kubernetes" : "bwrap",
			desiredState: start ? "running" : "stopped",
			pinnedRevision,
			...(kubernetes !== undefined ? { kubernetes } : {}),
			...(sourcePinDigest !== undefined ? { sourcePinDigest } : {}),
		};
		const created = registry.create({
			name: name.trim(),
			cwd: "",
			project: project.name,
			projectId,
			managed: true,
			labels: [],
			mode: "spawned",
			status: "asleep",
			workspace: record,
		});
		const daemonId = created.daemonId;
		const volumeRoot = join(config.workspaceDir, daemonId);
		registry.update(daemonId, {
			cwd: volumeRoot,
			lifecycleStage: "preparation",
			lifecycleError: undefined,
		});
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} created (${profile.provider})`,
			daemonId,
		);

		// Preparation. Fleet-local volumes (bwrap) prepare here; kubernetes
		// profiles skip the fleet-side clone — the provider initializes its
		// PVC in-pod at the persisted pin during ensure-running (Runtime
		// lane), reusing the SAME full commit on every retry.
		if (profile.provider === "bwrap") {
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
			// stopped workspace has NO active lifecycle stage — clear the
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
		// successful preparation keeps the entry (typed failed stage) — the
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
	 * listing). When given, the wake materializes that session's cold/
	 * missing stored transcripts into the volume and hands the daemon the
	 * resolved main-file path as OMP_SESSION_RESUME (bwrap volumes only —
	 * the sandbox sees the host path). When ABSENT the wake resumes the
	 * newest session it can see (volume ∪ store), so a stopped clone wake
	 * continues its last session instead of booting fresh; a never-started
	 * clone (no sessions anywhere) still boots fresh. An EXPLICIT id that
	 * exists nowhere is a typed `unavailable`, never a silent fresh boot.
	 */
	async ensureCloneRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void> {
		const entry = this.#requireClone(daemonId, "start");
		if (entry.workspace?.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				entry.workspace.deletion.state === "delete-pending-retry" ? "archive_pending" : "conflict",
				`workspace ${daemonId} is being deleted (${entry.workspace.deletion.state}); cannot start`,
			);
		}
		await this.#enqueue(daemonId, () =>
			this.#ensure(this.#deps.registry.get(daemonId) ?? entry, {
				firstStart: false,
				resumeSessionId: opts?.resumeSessionId,
			}),
		);
	}

	/** Stop: proof-bearing provider stop, desiredState stopped, enrollment
	 *  revoked. Preserves checkout + session logs (never deletes). */
	async stopClone(daemonId: string): Promise<void> {
		await this.#enqueue(daemonId, async () => {
			const entry = this.#requireClone(daemonId, "stop");
			const record = entry.workspace;
			if (record?.deletion?.state !== undefined) {
				throw new CloneLifecycleError(
					"conflict",
					`workspace ${daemonId} is being deleted (${record.deletion.state}); stop is not available`,
				);
			}
			const generation = fencedGeneration(record);
			const handle = this.#handleOf(entry);
			// Kubernetes final evidence (stage 3): this is the LAST moment the
			// daemon is alive to flush its writers and upload the evidence a
			// later delete must be bound to. Collected BEFORE the provider
			// stop (which deletes the Pod) and BEFORE the enrollment is
			// revoked (which tears the callback pair down). A failure never
			// blocks the stop — stop is the operator's escape hatch — but it
			// is recorded, so a later delete reports THAT failure instead of
			// a bare "no receipt".
			if (record?.providerKind === "kubernetes" && generation !== undefined) {
				await this.#collectStopEvidence(entry, generation);
			}
			if (generation !== undefined) {
				// #runCloneOp throws a typed CloneLifecycleError on provider
				// failure; an ok response here proves the generation terminated.
				// The attempted generation is used when no launch ever
				// succeeded, so a half-created resource is still fenced.
				const response = await this.#runCloneOp(entry.daemonId, "stop", handle, generation);
				if (response.observed === "running") {
					// The provider failed to prove termination — a running
					// process would violate the desired stopped state.
					throw new CloneLifecycleError(
						"conflict",
						`stop of ${daemonId} could not prove termination (observed running)`,
					);
				}
			}
			this.#deps.registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			this.#deps.registry.setStatus(daemonId, "asleep");
			// A deliberate stop owns the entry: end the pair watch now so no
			// in-flight or pending tick can relabel the stop as a crash.
			this.#disarmPairWatcher(daemonId);
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
		});
	}

	/**
	 * Clear a REJECTED deletion attempt (a `delete-pending-retry` left by a
	 * refused gate: dirty Git evidence, missing/invalid quiesce evidence, or
	 * an incomplete store) so the user can wake the workspace, preserve its
	 * changes, stop it, and retry the delete. Never clears an in-flight
	 * deletion and never removes provider resources. Returns whether a
	 * rejected attempt was cleared.
	 *
	 * Refuses once verification has flipped the workspace log store
	 * read-only (or the gate recorded post-verification resources still to
	 * remove): waking such a workspace would stream new frames into a store
	 * that rejects them, silently dropping resumed work. Those attempts stay
	 * quarantined and are retried from their cleanup stage.
	 */
	clearRejectedDeletion(daemonId: string): boolean {
		const entry = this.#requireClone(daemonId, "clear deletion state for");
		if (this.#deleting.has(daemonId)) {
			throw new CloneLifecycleError(
				"conflict",
				`deletion for workspace ${daemonId} is in progress; cannot clear it`,
			);
		}
		const deletion = entry.workspace?.deletion;
		if (deletion?.state !== "delete-pending-retry") return false;
		if (
			deletion.remainingResources !== undefined ||
			(this.#deps.logStore?.isReadOnly(daemonId) ?? false)
		) {
			throw new CloneLifecycleError(
				"conflict",
				`workspace ${daemonId} already passed deletion verification (its store is read-only); the attempt cannot be cleared for wake; retry the delete to resume its remaining cleanup`,
			);
		}
		this.#deps.registry.updateWorkspace(daemonId, { deletion: undefined });
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} rejected deletion cleared; wake to preserve changes, stop, then retry delete`,
			daemonId,
		);
		return true;
	}

	/** Verified deletion (P7.3/P7.5). `removeClone` is an alias: clone
	 *  removal NEVER bypasses the gate. Returns the verified session list. */
	async deleteClone(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		return await this.#deleteGate(daemonId);
	}

	/** Clone-safe remove: routes through the SAME verified gate. */
	async removeClone(daemonId: string): Promise<void> {
		await this.#deleteGate(daemonId);
	}

	// ------------------------------------------------------------------
	// Boot reconciliation (P6.3)
	// ------------------------------------------------------------------

	/**
	 * Reconcile provider-managed clone workspaces after a fleet restart.
	 *
	 * 1. Identity reconciliation runs FIRST (stage 1 item 4), before callback
	 *    enrollment or any lifecycle admission: legacy records with no
	 *    persisted provider kind are resolved from the profile and the
	 *    verified local preparation marker, and a kubernetes record without a
	 *    persisted binding is marked unavailable with its resources retained
	 *    for manual recovery.
	 * 2. Provider compute survived the restart (it is not an in-memory
	 *    child), so durable identity is inspected BEFORE acting:
	 *      - observed running  → reattach (refresh handle, ready) — same
	 *        generation, persisted credential reused; NEVER a new process;
	 *      - observed stopped/missing + desired running → ensure-running
	 *        (bumped generation after the predecessor is proven gone);
	 *      - desired stopped → leave.
	 * Failures are bounded, logged, and never hidden retry loops. Never
	 * downgrades statuses (clone entries are skipped by the legacy boot
	 * status reconcile in server.ts).
	 */
	async reconcile(): Promise<void> {
		await this.reconcileIdentities();
		for (const entry of this.#deps.registry.list()) {
			if (entry.workspace?.kind !== "clone") continue;
			const record = entry.workspace;
			if (record.providerKind === "kubernetes" && record.kubernetes === undefined) {
				continue; // Unavailable identity: retained for manual recovery.
			}
			// A persisted "deleting" state describes an in-flight gate of a
			// previous fleet process — nothing is running now, so it
			// reconciles to delete-pending-retry (retry by deleting again).
			// The durable progress the gate recorded is PRESERVED: the
			// pending receipt carries the request id a retry replays against
			// the daemon's cached outcome, and remainingResources records the
			// post-verification cleanup stage to resume at.
			if (record.deletion?.state === "deleting") {
				const interrupted = record.deletion;
				this.#deps.registry.setWorkspaceDeletion(entry.daemonId, {
					state: "delete-pending-retry",
					requestedAt: interrupted.requestedAt,
					...(interrupted.receipt !== undefined ? { receipt: interrupted.receipt } : {}),
					...(interrupted.remainingResources !== undefined
						? { remainingResources: interrupted.remainingResources }
						: {}),
					error: {
						code: "retryable",
						message: "deletion was interrupted before verification completed; retry the delete",
					},
				});
				continue;
			}
			// An attempt whose launch never returned its handle still has a
			// (possibly half-created) resource: lastAttemptedGeneration is a
			// reason to inspect, not a reason to skip.
			if (
				record.providerHandle === undefined &&
				record.authorizedGeneration === undefined &&
				record.lastAttemptedGeneration === undefined
			) {
				continue; // Never started; nothing to inspect or reattach.
			}
			await this.#enqueue(entry.daemonId, () => this.#reconcileEntry(entry.daemonId));
		}
	}

	/**
	 * Resolve the persisted provider identity of every clone record
	 * (stage 1 item 4). Idempotent, never deletes provider resources, and
	 * never guesses: a legacy record is inferred bwrap only from the
	 * VERIFIED local preparation marker, and a kubernetes record is
	 * inferable only when its binding was persisted. Called by the fleet
	 * server BEFORE callback re-enrollment and before any lifecycle request
	 * is accepted (`reconcile()` also runs it first).
	 */
	async reconcileIdentities(): Promise<void> {
		for (const entry of this.#deps.registry.list()) {
			if (entry.workspace?.kind !== "clone") continue;
			const record = entry.workspace;
			const daemonId = entry.daemonId;
			if (record.providerKind === "kubernetes") {
				if (record.kubernetes === undefined) {
					this.#markIdentityUnavailable(
						entry,
						"kubernetes workspace has no persisted resource binding; its compute and storage are retained for manual recovery",
					);
				}
				continue;
			}
			if (record.providerKind === "bwrap") continue;
			// Legacy record, persisted before the provider kind was captured.
			const profileKind = this.#profileProviderKind(record.profileId);
			if (profileKind === "kubernetes" || record.kubernetes !== undefined) {
				if (record.kubernetes === undefined) {
					this.#markIdentityUnavailable(
						entry,
						`kubernetes workspace "${record.profileId ?? "unknown profile"}" has no persisted resource binding; its compute and storage are retained for manual recovery`,
					);
				} else {
					this.#deps.registry.updateWorkspace(daemonId, { providerKind: "kubernetes" });
				}
				continue;
			}
			const volumeRoot = join(this.#deps.config.workspaceDir, daemonId);
			let hasVerifiedMarker = false;
			try {
				hasVerifiedMarker = (await readWorkspaceInitMarker(volumeRoot)) !== null;
			} catch (err) {
				this.#log(
					"warn",
					`clone boot reconcile: cannot read the preparation marker for ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
					daemonId,
				);
				continue;
			}
			if (hasVerifiedMarker) {
				this.#deps.registry.updateWorkspace(daemonId, { providerKind: "bwrap" });
				this.#log(
					"info",
					`clone boot reconcile: ${daemonId} inferred providerKind bwrap from its verified preparation marker`,
					daemonId,
				);
			}
		}
	}

	/** One entry's inspect/reattach/ensure pass (runs under the op queue). */
	async #reconcileEntry(daemonId: string): Promise<void> {
		const entry = this.#deps.registry.get(daemonId);
		if (entry?.workspace?.kind !== "clone") return;
		const record = entry.workspace;
		if (record.providerKind === "kubernetes" && record.kubernetes === undefined) return;
		if (
			record.providerHandle === undefined &&
			record.authorizedGeneration === undefined &&
			record.lastAttemptedGeneration === undefined
		) {
			return;
		}
		const desired = record.desiredState;
		// A launch that never returned its handle leaves the ATTEMPTED
		// generation ahead of the authorized one. Inspect exactly that
		// attempt (never the stale authorized generation) and reconcile it
		// through the retry/stop path: a same-generation reattach here would
		// surface the workspace ready while leaving the persisted
		// authorization behind the live resource's generation.
		const attempted = fencedGeneration(record);
		const ahead =
			record.lastAttemptedGeneration !== undefined &&
			record.lastAttemptedGeneration > (record.authorizedGeneration ?? 0);
		let response: ProviderOkResponse;
		try {
			// #runCloneOp throws a typed CloneLifecycleError on provider
			// failure; an ok response here is a trustworthy observation.
			response = await this.#runCloneOp(daemonId, "inspect", this.#handleOf(entry), attempted);
		} catch (err) {
			this.#log(
				"warn",
				`clone boot reconcile: inspect failed for ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
				daemonId,
			);
			return;
		}
		if (response.observed === "running") {
			if (ahead) {
				await this.#reconcileAttempt(daemonId, attempted);
				return;
			}
			// Reattach: same generation, refresh handle, surface liveness.
			this.#deps.registry.updateWorkspace(daemonId, { providerHandle: response.handle });
			this.#deps.registry.setStatus(daemonId, "ready");
			this.#setStage(daemonId, "ready");
			this.#log("info", `clone boot reconcile: ${daemonId} reattached (running)`, daemonId);
			return;
		}
		// stopped | missing — desired state decides.
		if (desired === "running") {
			try {
				await this.#ensure(this.#deps.registry.get(daemonId) ?? entry, { firstStart: false });
				this.#log(
					"info",
					`clone boot reconcile: ${daemonId} recreated (${response.observed} → ensure-running)`,
					daemonId,
				);
			} catch (err) {
				this.#log(
					"warn",
					`clone boot reconcile: ensure-running failed for ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
					daemonId,
				);
			}
		} else {
			this.#log(
				"info",
				`clone boot reconcile: ${daemonId} left ${response.observed} (desired stopped)`,
				daemonId,
			);
		}
	}

	/**
	 * Reconcile a live ATTEMPTED generation: one whose launch persisted its
	 * attempt (generation + handoff) but never returned a handle. A workspace
	 * that should be running retries that attempt through {@link #ensure}
	 * (which reuses the attempt's generation and credential and then
	 * authorizes it); a workspace that should be stopped fences the stray
	 * generation with a PROVEN provider stop and revokes the attempt's
	 * callback enrollment. Never marks the workspace ready — nothing
	 * authorized this generation.
	 */
	async #reconcileAttempt(daemonId: string, attempt: number | undefined): Promise<void> {
		const entry = this.#deps.registry.get(daemonId);
		if (entry?.workspace?.kind !== "clone") return;
		if (entry.workspace.desiredState === "running") {
			try {
				await this.#ensure(entry, { firstStart: false });
				this.#log(
					"info",
					`clone boot reconcile: ${daemonId} retried its in-flight attempt (gen ${attempt ?? "unknown"})`,
					daemonId,
				);
			} catch (err) {
				this.#log(
					"warn",
					`clone boot reconcile: retry of the in-flight attempt failed for ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
					daemonId,
				);
			}
			return;
		}
		if (attempt === undefined) return;
		try {
			const stop = await this.#runCloneOp(daemonId, "stop", this.#handleOf(entry), attempt);
			if (stop.observed === "running") {
				this.#log(
					"warn",
					`clone boot reconcile: ${daemonId} stray attempt gen ${attempt} could not be proven stopped`,
					daemonId,
				);
				return;
			}
			// The attempt's generation is proven gone: its enrollment can no
			// longer authenticate anything, so drop it (a stale enrollment
			// would otherwise keep the stopped workspace "live" for deletion).
			const enrolled = this.#deps.registry.get(daemonId)?.workspace?.enrollment;
			if (enrolled !== undefined) {
				this.#deps.transport.revokeEnrollment(daemonId, enrolled.generation);
				this.#deps.registry.clearWorkspaceEnrollment(daemonId, enrolled.generation);
			}
			this.#deps.registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			this.#deps.registry.setStatus(daemonId, "asleep");
			this.#disarmPairWatcher(daemonId);
			this.#deps.registry.update(daemonId, {
				lifecycleStage: undefined,
				lifecycleError: undefined,
			});
			this.#log(
				"info",
				`clone boot reconcile: ${daemonId} stopped its unmanaged in-flight attempt (gen ${attempt})`,
				daemonId,
			);
		} catch (err) {
			this.#log(
				"warn",
				`clone boot reconcile: could not fence the in-flight attempt for ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
				daemonId,
			);
		}
	}

	/** Boot-unavailable provider identity: resource retained, never probed. */
	#markIdentityUnavailable(entry: RegistryEntry, message: string): void {
		this.#deps.registry.setStatus(entry.daemonId, "error", message);
		this.#setStage(entry.daemonId, "failed", message);
		this.#log("warn", `clone boot reconcile: ${entry.daemonId} ${message}`, entry.daemonId);
	}

	/** Persisted profile provider for a workspace record, when resolvable. */
	#profileProviderKind(profileId: string | undefined): "bwrap" | "kubernetes" | undefined {
		if (profileId === undefined) return undefined;
		return this.#deps.config.providerProfiles?.[profileId]?.provider;
	}

	/** Cancel timers (server close()); never stops provider compute. */
	close(): void {
		for (const timer of this.#pairWatchers.values()) clearTimeout(timer);
		this.#pairWatchers.clear();
	}

	// ------------------------------------------------------------------
	// Ensure-running (start/wake/reconcile core)
	// ------------------------------------------------------------------

	/**
	 * P6.1/P6.2 ensure-running. Inspect-before-act, then:
	 *   - an in-flight ATTEMPT (a generation whose launch wrote its handoff but
	 *     whose ensure never succeeded) is inspected at ITS generation; when
	 *     its credential is still recoverable the retry REUSES it, and only a
	 *     replacement (an unrecoverable or live-but-foreign attempt) uses a
	 *     larger generation;
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
	 * The attempted generation persists BEFORE the provider call so a launch
	 * failure leaves a retryable record of the attempt; a failure KEEPS that
	 * generation and the original handoff (never revoking the credential a
	 * live or partially created resource may already hold). On success:
	 * provider handle, authorized generation, desiredState running, status
	 * ready persist; lifecycleStage advances runtime → callback (pair watcher
	 * → ready).
	 */
	async #ensure(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string },
	): Promise<ProviderResponse> {
		const daemonId = entry.daemonId;
		entry = this.#deps.registry.get(daemonId) ?? entry;
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
		const attemptedGen = record.lastAttemptedGeneration;
		// An attempt is in flight when it is AHEAD of the last authorized
		// generation: its credential and handoff were written, but the
		// provider call never succeeded.
		const inFlightGen =
			attemptedGen !== undefined && attemptedGen > (currentGen ?? 0) ? attemptedGen : undefined;
		const handle = this.#handleOf(entry);
		this.#setStage(daemonId, "runtime");

		// Inspect first: a live sandbox must never be blindly recreated.
		// #runCloneOp throws a typed CloneLifecycleError on provider failure
		// (conflict = uncertain predecessor, unavailable, provider_failed).
		// An in-flight attempt is inspected at its OWN generation so a retry
		// sees exactly the attempt it started.
		const inspectGen = inFlightGen ?? currentGen;
		let inspect: ProviderOkResponse | null = null;
		if (inspectGen !== undefined || handle !== undefined) {
			try {
				inspect = await this.#runCloneOp(daemonId, "inspect", handle, inspectGen);
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
		let reattaching = false;
		if (inFlightGen !== undefined) {
			// Retry of a failed launch: reuse the attempt's generation and
			// credential whenever the persisted handoff still carries them,
			// so the retry reuses the credential the attempt may already have
			// handed to a live or partially created resource.
			reuseToken = this.#recoverCallbackToken(entry, inFlightGen);
			if (reuseToken !== undefined) {
				generation = inFlightGen;
				reattaching = inspect !== null && inspect.observed === "running";
			} else if (inspect !== null && inspect.observed === "running") {
				// A live attempt with no recoverable credential: replacing it
				// would put two writers on one volume, so prove the
				// predecessor terminated first, then use a LARGER generation.
				const stop = await this.#runCloneOp(daemonId, "stop", handle, inFlightGen);
				if (stop.observed === "running") {
					throw new CloneLifecycleError(
						"conflict",
						`cannot replace ${daemonId}: predecessor termination is uncertain (stop did not prove); no new writer admitted`,
					);
				}
				generation = inFlightGen + 1;
			} else {
				generation = inFlightGen + 1;
			}
		} else if (inspect !== null && inspect.observed === "running" && currentGen !== undefined) {
			// Reattach path. If the persisted binding matches this
			// generation AND the state-file token is recoverable, reuse it —
			// the daemon's live pair keeps its original credential.
			if (record.enrollment !== undefined && record.enrollment.generation === currentGen) {
				reuseToken = this.#recoverCallbackToken(entry, currentGen);
			}
			if (reuseToken !== undefined) {
				generation = currentGen;
				reattaching = true;
			} else {
				// Running with no recoverable binding: replacing the process
				// would create two writers on one volume. Prove the
				// predecessor terminated FIRST, then bump the generation.
				// (#runCloneOp throws on a non-ok stop; observed running
				// after an ok stop means termination is unproven.)
				const stop = await this.#runCloneOp(daemonId, "stop", handle, currentGen);
				if (stop.observed === "running") {
					throw new CloneLifecycleError(
						"conflict",
						`cannot replace ${daemonId}: predecessor termination is uncertain (stop did not prove); no new writer admitted`,
					);
				}
				generation = currentGen + 1;
			}
		} else {
			// stopped | missing (proven gone) — or never started.
			if (opts.firstStart && currentGen === undefined) {
				generation = 1;
			} else {
				generation = (currentGen ?? 0) + 1;
			}
		}

		// Wake resume: when this wake is spawning a NEW daemon process (not a
		// reattach of a live one), compute the resume target BEFORE the
		// provider runs. bwrap volumes materialize cold/missing transcripts
		// fleet-side and hand the HOST main-file path; kubernetes volumes are
		// not fleet-readable, so they hand the IN-POD main-file path and
		// require the daemon to restore/materialize it over the callback
		// pair (OMP_SESSION_RESUME_REQUIRED). Computed BEFORE enrollment
		// persists so a typed failure (an explicit id that exists nowhere)
		// never leaves a dangling enrollment behind.
		const resumeEnv = reattaching ? undefined : await this.#resolveWakeResume(entry, opts);

		// Enroll + persist the binding BEFORE ensure-running (a live
		// credential must exist for the daemon's pair). Attach the log tap
		// at the same time so a fresh clone never streams into the void.
		// P6.2 fencing: every enrollment that is not THIS generation is
		// revoked first, so a stale credential can never authenticate against
		// the new runtime.
		const staleGeneration = record.enrollment?.generation;
		if (staleGeneration !== undefined && staleGeneration !== generation) {
			this.#deps.transport.revokeEnrollment(daemonId, staleGeneration);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, staleGeneration);
		}
		if (currentGen !== undefined && currentGen !== generation && currentGen !== staleGeneration) {
			this.#deps.transport.revokeEnrollment(daemonId, currentGen);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, currentGen);
		}
		const credentialHex = reuseToken ?? randomBytes(ENROLLMENT_KEY_BYTES).toString("hex");
		const digest = this.#deps.transport.enrollWorkspace(daemonId, generation, credentialHex);
		this.#deps.registry.setWorkspaceEnrollment(daemonId, { credentialHash: digest, generation });
		// Record the ATTEMPT before the provider call: a crash between here
		// and the ensure response must still identify the generation whose
		// (possibly half-created) resource exists.
		this.#deps.registry.updateWorkspace(daemonId, { lastAttemptedGeneration: generation });
		this.#writeCallbackEnv(entry, generation, credentialHex, resumeEnv);
		this.#deps.attachLogTap(daemonId);

		// #runCloneOp throws on a non-ok provider response; an ok response
		// here is a live, current-generation runtime. The generation override
		// is REQUIRED: the bump was computed + enrolled above but
		// authorizedGeneration persists only after ensure succeeds — without
		// it the request would carry the stale pre-bump generation and the
		// provider would fence it (P6.2). A failure here deliberately KEEPS
		// the attempted generation and the original handoff: a retry inspects
		// this attempt and reuses its credential, and a replacement uses a
		// larger generation. Revoking on failure would strand a live or
		// partially created resource with no recoverable token.
		const response = await this.#runCloneOp(daemonId, "ensure-running", handle, generation);
		this.#deps.registry.updateWorkspace(daemonId, {
			providerHandle: response.handle,
			authorizedGeneration: generation,
			desiredState: "running",
		});
		if (response.observed === "running") {
			this.#deps.registry.setStatus(daemonId, "ready");
			this.#setStage(daemonId, "callback");
			// Bounded pair-readiness watcher: callback → ready when the
			// daemon's pair is observed live (never blocks the caller).
			this.#armPairWatcher(daemonId);
		}
		this.#log(
			"info",
			`clone ${daemonId} ensured running (gen ${generation}, observed ${response.observed})`,
			daemonId,
		);
		return response;
	}

	// ------------------------------------------------------------------
	// The verified delete gate (P7.3/P7.5)
	// ------------------------------------------------------------------

	/**
	 * P7.3/P7.5 ordered gate for clone workspaces (shared by deleteClone and
	 * removeClone — removal cannot bypass it):
	 *   1. serialize concurrent DELETEs (op queue + in-flight marker) and
	 *      reconcile a persisted "deleting" from a previous fleet process to
	 *      delete-pending-retry, preserving its cleanup state;
	 *   2. admission: refuse while compute is live or its pair is live
	 *      (activity is not observable fleet-side for clones, so a live
	 *      workspace is refused until explicitly stopped);
	 *   3. persist "deleting" (durable state before any destructive step);
	 *   4. kubernetes only: collect and VALIDATE the daemon's final evidence
	 *      upload and persist the receipt binding (pending → verified, or
	 *      invalid + block) BEFORE the Pod is stopped;
	 *   5. quiesce: revoke the callback enrollment (no further log frames)
	 *      and PROVE the compute stopped via the provider — a stop that
	 *      cannot prove termination blocks;
	 *   6. kubernetes only: a validated receipt with dirty/unknown Git
	 *      evidence refuses deletion and preserves the PVC (the ordinary stop
	 *      already ran);
	 *   7. Git guard with writers stopped (dirty/untracked/stash/unpreserved
	 *      history block; no force override);
	 *   8. fleet-store verification INCLUDING an independent cross-check of
	 *      the workspace volume's own session tree — an empty store never
	 *      trivially passes when sessions existed on the volume;
	 *   9. read-only flip (only when anything is retained);
	 *  10. provider deletion → volume deletion → roster removal.
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

		// Reconcile a persisted "deleting" from a crashed previous fleet,
		// preserving any cleanup state it had durably recorded.
		let entry = this.#deps.registry.get(daemonId) ?? entry0;
		const previous = entry.workspace?.deletion;
		if (previous?.state === "deleting") {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: previous.requestedAt,
				error: {
					code: "retryable",
					message: "deletion was interrupted before verification completed; retry the delete",
				},
				...(previous.remainingResources !== undefined
					? { remainingResources: previous.remainingResources }
					: {}),
				...(previous.receipt !== undefined ? { receipt: previous.receipt } : {}),
			});
			entry = this.#deps.registry.get(daemonId) ?? entry;
		}

		// Admission. For clones, "active work" is not derivable fleet-side: a
		// running desired state, a live enrollment, or a live callback pair
		// may carry accepted work — refuse with an actionable message instead
		// of risking mid-turn deletion. Presentation status is deliberately
		// NOT consulted: a readiness probe can set a still-running,
		// still-paired clone to "error" without stopping its provider, and
		// that workspace must not slip past this gate.
		//
		// An exception: an enrollment/pair at a generation that was ATTEMPTED
		// but never AUTHORIZED is a failed launch. No work can have been
		// accepted against it, and the gate itself owns fencing that
		// generation (stop + delete); refusing it would make the very clone
		// whose Pod is still live undeletable, because stopping it first
		// destroys the callback pair the evidence handshake needs.
		const record = entry.workspace;
		const pair = this.#deps.transport.pairStatus(daemonId);
		const failedLaunch =
			record?.lastAttemptedGeneration !== undefined &&
			record.lastAttemptedGeneration > (record.authorizedGeneration ?? 0);
		const live =
			!failedLaunch &&
			(record?.desiredState === "running" ||
				record?.enrollment !== undefined ||
				pair.enrolled ||
				pair.paired);
		if (live) {
			throw new CloneLifecycleError(
				"writer_active",
				`workspace ${daemonId} is live with unobservable activity; stop current work (explicit stop) before deleting`,
			);
		}

		this.#deleting.add(daemonId);
		try {
			return await this.#enqueue(daemonId, () => this.#gate(daemonId));
		} finally {
			this.#deleting.delete(daemonId);
		}
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
		// resources and any evidence receipt across the retry.
		registry.setWorkspaceDeletion(daemonId, {
			state: "deleting",
			requestedAt,
			...(previous?.remainingResources !== undefined
				? { remainingResources: previous.remainingResources }
				: {}),
			...(previous?.receipt !== undefined ? { receipt: previous.receipt } : {}),
		});

		// Quiesce + evidence ordering (stage 3): the daemon must still hold a
		// live callback pair when the quiesce handshake runs, so the final
		// evidence is collected BEFORE the enrollment is revoked (revoking
		// tears the pair down and leaves the collector with no connection to
		// ask). A workspace that already passed verification resumes at
		// provider deletion instead: its daemon/enrollment are gone, its store
		// is read-only, and re-running the pre-stop handshake could never
		// reach the idempotent cleanup that remainingResources exists to
		// retry.
		// A failed launch still wrote a generation whose (possibly
		// half-created) resource must be fenced; the newest ATTEMPTED
		// generation wins when it is ahead of the authorized one, or the
		// provider's generation-ownership check would refuse to touch it.
		// everStarted stays tied to a SUCCESSFUL launch so evidence is never
		// demanded of a daemon that never ran.
		const stopGen = fencedGeneration(entry.workspace);
		const everStarted =
			entry.workspace?.authorizedGeneration !== undefined ||
			entry.workspace?.providerHandle !== undefined;
		const postVerification =
			previous?.remainingResources !== undefined || (logStore?.isReadOnly(daemonId) ?? false);

		// Kubernetes final evidence (stage 3): the daemon flushes its writers
		// and uploads the evidence document BEFORE the Pod is stopped. The
		// validated receipt binds the workspace to the exact Pod/PVC/namespace
		// the store was verified against, and persists so a fleet restart can
		// replay the daemon's cached outcome. A missing or invalid receipt
		// blocks deletion with everything retained.
		let receipt = previous?.receipt;
		if (!postVerification) {
			receipt = await this.#collectDeletionEvidence(entry, requestedAt, everStarted);
			if (receipt !== undefined) entry = registry.get(daemonId) ?? entry;
		}

		// Quiesce writers: revoke the callback enrollment (no further log
		// frames reach the store), then PROVE the provider compute stopped.
		// The stop is not a flush acknowledgment — only the store's verified
		// offsets + the volume cross-check prove completeness — but no writer
		// may still run while verification reads.
		const enrollment = (registry.get(daemonId) ?? entry).workspace?.enrollment;
		if (enrollment !== undefined) {
			this.#deps.transport.revokeEnrollment(daemonId, enrollment.generation);
			registry.clearWorkspaceEnrollment(daemonId, enrollment.generation);
			entry = registry.get(daemonId) ?? entry;
		}

		// Post-verification retries never re-stop: the quiesce stop that
		// preceded verification already proved this generation terminated.
		if (!postVerification && stopGen !== undefined) {
			let stop: ProviderOkResponse;
			try {
				stop = await this.#runCloneOp(entry.daemonId, "stop", this.#handleOf(entry), stopGen);
			} catch (err) {
				// #runCloneOp throws a typed CloneLifecycleError on provider
				// failure — persist delete-pending-retry and retain everything.
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
					...(receipt !== undefined ? { receipt } : {}),
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
					...(receipt !== undefined ? { receipt } : {}),
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
			this.#disarmPairWatcher(daemonId);
			registry.update(daemonId, { lifecycleStage: undefined, lifecycleError: undefined });
			entry = registry.get(daemonId) ?? entry;
		}

		// Kubernetes evidence verdict (stage 3 item 6): delete requires a
		// matching validated receipt with CLEAN Git evidence. Dirty or
		// unknown Git evidence permits the ordinary stop above, refuses the
		// delete, and preserves the PVC; a missing receipt already blocked
		// before the stop. Nothing is removed here.
		if (receipt?.state === "verified" && receipt.validated !== undefined) {
			const verdict = receiptAllowsDelete(receipt.validated);
			if (!verdict.ok) {
				const code = this.#lifecycleCodeFromLedger(verdict.code);
				const message =
					`workspace ${daemonId} deletion refused (${verdict.code}): ${verdict.reason}; ` +
					`the workspace, its volume and its stored sessions are retained. Clear the rejected attempt (POST /ctl/workspaces/${daemonId}/clear-deletion), ` +
					"wake it to preserve changes, stop it, then retry the delete";
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					receipt,
					error: { code, message },
				});
				eventLog.add("warn", "server", `delete ${daemonId} refused: ${message}`, daemonId);
				throw new CloneLifecycleError(code, message);
			}
		}

		// Git guard (P7.4), writers stopped: reject dirty files, untracked
		// files, stashes, and unpreserved local history. No force override.
		await this.#runGitGuard(daemonId, receipt);

		// Store verification. When the fleet log store is absent, deletion
		// cannot be verified and is blocked (everything retained).
		if (logStore === null) {
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				...(receipt !== undefined ? { receipt } : {}),
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
				...(receipt !== undefined ? { receipt } : {}),
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
		const volumeCheck = await this.#verifyVolumeAgainstStore(daemonId, verify.manifest, receipt);
		if (!volumeCheck.ok) {
			const error: DeletionGateError = {
				code: "archive_conflict",
				message: volumeCheck.message,
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				...(receipt !== undefined ? { receipt } : {}),
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
		// the flip records remaining resources and stays retry-able. An
		// attempted-but-never-authorized generation still deletes: its
		// half-created Pod/PVC must not outlive the roster entry.
		if (stopGen !== undefined) {
			try {
				await this.#deleteProvider(registry.get(daemonId) ?? entry, stopGen);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					...(receipt !== undefined ? { receipt } : {}),
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
				...(receipt !== undefined ? { receipt } : {}),
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
		// Retention's). No orphan marker — verification passed.
		registry.remove(daemonId);
		eventLog.add("info", "server", `workspace ${daemonId} deleted (verified)`, daemonId);
		return { removed: daemonId, verified: verify.sessions.map((s) => s.sessionId) };
	}

	// ------------------------------------------------------------------
	// Gate parts
	// ------------------------------------------------------------------

	/** Provider delete (runs only after the read-only flip). */
	async #deleteProvider(
		entry: RegistryEntry,
		generation: number | undefined,
	): Promise<ProviderOkResponse> {
		// #runCloneOp throws a typed CloneLifecycleError on provider failure;
		// the gate's caller converts it to delete-pending-retry + remaining
		// resources. The generation is the one the stop proof fenced (a
		// failed launch's attempted generation when no launch succeeded).
		const response = await this.#runCloneOp(
			entry.daemonId,
			"delete",
			this.#handleOf(entry),
			generation,
		);
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
	async #runGitGuard(daemonId: string, receipt?: CloneDeletionReceipt): Promise<void> {
		const entry = this.#require(daemonId);
		const checkoutDir = join(entry.cwd ?? "", ".checkout");
		if (!existsSync(join(checkoutDir, ".git"))) {
			// A never-prepared/never-started clone has no checkout to guard;
			// the store/volume checks below are authoritative.
			return;
		}
		const fail = (message: string): never => {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: Date.now(),
				...(receipt !== undefined ? { receipt } : {}),
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
		// best-effort (offline is fine — the count below is conservative
		// against the last known refs), then count commits not reachable
		// from any origin ref.
		await runGit(["fetch", "--quiet", "--no-tags", "origin"], checkoutDir).catch(() => {
			// Offline: fall through to the last known remote-tracking refs.
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
	 * actually existed on the volume. A volume the fleet cannot read
	 * (kubernetes PVCs) has no tree to compare, so a VALIDATED quiesce
	 * `receipt` is the completeness authority there, including its valid
	 * empty-manifest case.
	 */
	async #verifyVolumeAgainstStore(
		daemonId: string,
		storeManifest: ArchiveManifest | undefined,
		receipt: CloneDeletionReceipt | undefined,
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const entry = this.#require(daemonId);
		const record = entry.workspace;
		const volumeRoot = entry.cwd ?? join(this.#deps.config.workspaceDir, daemonId);
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;

		// The volume is fleet-readable when its root exists.
		const volumePresent = existsSync(volumeRoot);
		const files: VolumeFile[] = [];
		let bounded = true;
		if (volumePresent && existsSync(sessionsDir)) {
			const state = { files: 0, bytes: 0 };
			const rootEntries = listDir(sessionsDir);
			for (const dir of rootEntries) {
				if (!dir.isDirectory()) continue;
				const sid = dir.name;
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid)) continue;
				walkSessionDir(join(sessionsDir, sid), sid, state, files);
			}
			if (state.files >= MAX_EXPORT_FILES || state.bytes > MAX_EXPORT_BYTES) {
				bounded = false;
			}
		}

		if (!volumePresent) {
			// A kubernetes volume is not fleet-readable, so there is no
			// volume-side tree to compare: the validated quiesce receipt is
			// the completeness authority there, INCLUDING its valid empty
			// case (a clone that started but never produced a session
			// legitimately has no volume tree and no store sessions).
			if (receipt?.state === "verified" && receipt.validated !== undefined) {
				return { ok: true };
			}
			if (everStarted && storeManifest === undefined) {
				// Store verified (storeManifest is present only on ok:true
				// with provenance) — if the store really has zero sessions
				// AND we cannot read the volume, completeness is unprovable.
				// (storeManifest undefined on a non-ok result is handled by
				// the caller; here it means ok + no manifest is impossible.)
				return {
					ok: false,
					message: `cannot verify store completeness for ${daemonId}: volume is not fleet-readable and the store has no sessions to compare`,
				};
			}
			return { ok: true }; // k8s volume with verified stored sessions, or never started.
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
			const sha = await sha256File(absolute);
			if (sha !== side.sha256) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} differs from its stored bytes; deletion blocked (rewrite not re-streamed)`,
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

	/**
	 * Workspace paths: volume root + sandbox dirs (frozen layout). The
	 * provider state dir is provider-specific: a kubernetes workspace's
	 * state is keyed by its immutable resource identity (never the roster
	 * id), so it survives independently and is removed only after confirmed
	 * resource deletion; bwrap keeps the per-daemon layout.
	 */
	#clonePaths(entry: RegistryEntry): {
		volumeRoot: string;
		checkoutDir: string;
		homeDir: string;
		stateDir: string;
	} {
		const volumeRoot = join(this.#deps.config.workspaceDir, entry.daemonId);
		const resourceIdentity = entry.workspace?.kubernetes?.resourceIdentity;
		const stateDir =
			entry.workspace?.providerKind === "kubernetes" && resourceIdentity !== undefined
				? join(this.#deps.config.workspaceDir, ".kubernetes", resourceIdentity)
				: join(this.#deps.config.workspaceDir, ".provider-state", entry.daemonId);
		return {
			volumeRoot,
			checkoutDir: join(volumeRoot, ".checkout"),
			homeDir: join(volumeRoot, ".home"),
			stateDir,
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
	 * consistent snapshot — a stale caller entry can never send a request
	 * carrying an old generation against a freshly enrolled one (P6.2
	 * fencing). `generationOverride` is REQUIRED on the ensure-running call
	 * after a generation bump and on an in-flight-attempt inspect: the bump
	 * is computed and enrolled BEFORE the provider runs, but
	 * `authorizedGeneration` on the record is only persisted AFTER ensure
	 * succeeds — without the override the request would carry the stale
	 * pre-bump generation and the provider would fence it.
	 *
	 * Every invocation is serialized per workspace under the hardened
	 * {@link acquireFileLock} (cross-process; the in-process op queue
	 * serializes the surrounding lifecycle transitions). A kubernetes request
	 * always carries the persisted binding and its exact source tuple; a
	 * bwrap request NEVER carries a binding. Provider failures map onto the
	 * frozen vocabulary with caller-safe messages.
	 */
	async #runCloneOp(
		daemonId: string,
		op: "ensure-running" | "inspect" | "stop" | "delete",
		handle: string | undefined,
		generationOverride?: number,
	): Promise<ProviderOkResponse> {
		const entry = this.#require(daemonId);
		const { profile } = this.#cloneProfile(entry);
		const { checkoutDir, homeDir, stateDir } = this.#clonePaths(entry);
		const generation = generationOverride ?? entry.workspace?.authorizedGeneration ?? 1;
		const record = entry.workspace;
		const binding = record?.providerKind === "kubernetes" ? record.kubernetes : undefined;
		if (record?.providerKind === "kubernetes" && binding === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`workspace ${daemonId} has no persisted kubernetes resource binding; its compute and storage are retained for manual recovery`,
			);
		}
		if (binding !== undefined && record?.sourcePinDigest !== undefined) {
			// The persisted digest must match the tuple this request carries:
			// the provider annotates the Pod/PVC from the request tuple, so a
			// divergent record would describe a different pin than the fleet
			// persists.
			const recomputed = computeSourcePinDigest(
				record.source?.remote ?? "",
				record.pinnedRevision ?? "",
				record.branch ?? "",
			);
			if (recomputed !== record.sourcePinDigest) {
				throw new CloneLifecycleError(
					"conflict",
					`workspace ${daemonId} source-pin digest does not match its persisted source tuple; refusing to invoke the provider`,
				);
			}
		}
		// Every op carries the workspace's clone source + pinned full commit
		// + branch (Runtime contract): the k8s provider initializes its PVC
		// in-pod at the persisted pin from these — never resolves itself;
		// bwrap ignores them (fleet-side prepared). Additive per
		// shared/provider-protocol.ts ProviderRequest.
		//
		// A provider-side prepared volume also needs the sanitized sandbox
		// baseline: it is prepared in-pod, where the operator's agent dir does
		// not exist, so the documents computed here are the only way that
		// volume boots with the same agent-behavior config as a bwrap clone.
		const baseline = preparesVolumeProviderSide(profile)
			? await sandboxBaselineDocuments(profile)
			: undefined;
		const request: ProviderRequest = {
			providerProto: OMP_PROVIDER_PROTO,
			op,
			workspaceId: daemonId,
			generation,
			workspaceDir: checkoutDir,
			homeDir,
			profile,
			stateDir,
			...(handle !== undefined ? { handle } : {}),
			...(binding !== undefined ? { kubernetes: binding } : {}),
			...(record?.source !== undefined ? { source: record.source } : {}),
			...(record?.pinnedRevision !== undefined ? { revision: record.pinnedRevision } : {}),
			...(record?.branch !== undefined ? { branch: record.branch } : {}),
			...(baseline !== undefined ? { baseline } : {}),
		};
		let lock: FileLock;
		try {
			lock = acquireFileLock(join(stateDir, "fleet-op.lock"), `omp-fleet ${process.pid}`);
		} catch (err) {
			if (err instanceof LockHeldError) {
				throw new CloneLifecycleError(
					"conflict",
					`workspace ${daemonId} provider operation is locked by ${err.holderName} (pid ${err.holderPid}); retry the operation`,
				);
			}
			throw err;
		}
		let response: ProviderResponse;
		try {
			// The provider budgets its own waits (a 120 s Pod readiness, a 60 s
			// stop, 60 s per deleted object). The invocation must cover the
			// same waits, or the fleet kills a cold pull or deletion the
			// provider itself would have completed within its documented
			// budget (P5.4).
			response = await runProviderOp(profile.executable, request, {
				timeoutMs: providerOpTimeouts(kubernetesProviderWaits())[op].invocationTimeoutMs,
			});
		} finally {
			lock.release();
		}
		if (!response.ok) {
			throw new CloneLifecycleError(
				providerErrorToLifecycleCode(response.error.code),
				`provider ${op} failed for ${daemonId} (${response.error.code}): ${response.error.message}`,
			);
		}
		this.#confirmBinding(entry, response);
		return response;
	}

	/**
	 * Cross-check the observed namespace uid against the persisted binding.
	 * The fleet never re-derives it (the provider treats the binding as
	 * authoritative); a mismatch means the namespace was replaced underneath
	 * the workspace, which is a conflict, never a silent re-anchor.
	 */
	#confirmBinding(entry: RegistryEntry, response: ProviderOkResponse): void {
		const binding = entry.workspace?.kubernetes;
		const observed = response.kubernetes;
		if (binding === undefined || observed === undefined) return;
		if (binding.namespaceUid !== observed.namespaceUid) {
			throw new CloneLifecycleError(
				"conflict",
				`workspace ${entry.daemonId} namespace uid changed (recorded ${binding.namespaceUid}, observed ${observed.namespaceUid}); inspect and recover the retained resources manually`,
			);
		}
	}

	/** Ledger/ledger-shaped code → lifecycle code (all ledger codes pass through). */
	#lifecycleCodeFromLedger(code: string): CloneLifecycleErrorCode {
		if (Object.hasOwn(LIFECYCLE_ERROR_CODES, code)) {
			return code as CloneLifecycleErrorCode;
		}
		return providerErrorToLifecycleCode(code as ProviderErrorCode);
	}

	#codeForEnsureFailure(err: Error): CloneLifecycleErrorCode {
		return err instanceof CloneLifecycleError ? err.code : "provider_failed";
	}

	/** Typed lifecycle code for a failed evidence collection/validation. */
	#evidenceErrorCode(err: unknown): CloneLifecycleErrorCode {
		if (err instanceof CloneLifecycleError) return err.code;
		if (err instanceof CloneQuiesceError) return this.#lifecycleCodeFromLedger(err.code);
		const code = (err as { code?: unknown } | null | undefined)?.code;
		if (typeof code === "string") return this.#lifecycleCodeFromLedger(code);
		return "provider_failed";
	}

	/**
	 * Persist this workspace's final quiesce evidence while the daemon is
	 * still alive (Kubernetes only; called by an explicit stop).
	 *
	 * The delete gate can only ADOPT evidence: once the Pod is gone there is
	 * no writer to quiesce and no daemon to ask, so the receipt a stop
	 * collected is a stopped workspace's only admissible authority. The
	 * handshake runs here — before the provider stop deletes the Pod and
	 * before the enrollment revocation tears the pair down — with the same
	 * request shape the gate uses, and the validated receipt is persisted in
	 * `lastEvidence` bound to this generation.
	 *
	 * A failure NEVER fails the stop: stop is the operator's escape hatch and
	 * must work even when the daemon cannot answer. The TYPED failure is
	 * persisted instead, so a later delete reports the verification failure
	 * rather than a bare missing receipt. Waking the workspace bumps the
	 * generation, so a stale receipt is never reused for other resources.
	 */
	async #collectStopEvidence(entry: RegistryEntry, generation: number): Promise<void> {
		const { registry } = this.#deps;
		const daemonId = entry.daemonId;
		const collect = this.#deps.collectCloneEvidence;
		// No collector wired (bwrap-only) and no resources to bind: keep
		// today's behavior exactly.
		if (collect === undefined) return;
		const record = entry.workspace;
		const binding = record?.kubernetes;
		if (record === undefined || binding === undefined) return;

		let observed: KubernetesObserved | undefined;
		try {
			const inspect = await this.#runCloneOp(
				daemonId,
				"inspect",
				this.#handleOf(entry),
				generation,
			);
			observed = inspect.kubernetes;
			if (observed === undefined) {
				throw new CloneLifecycleError(
					"unavailable",
					`provider inspect for ${daemonId} reported no kubernetes observation; cannot bind the stop evidence`,
				);
			}
		} catch (err) {
			this.#recordStopEvidenceFailure(daemonId, generation, randomUUID(), undefined, err);
			return;
		}
		// No Pod observed: there is no writer to quiesce and nothing new to
		// learn. A receipt an earlier stop verified for these resources stays
		// valid — the Pod cannot return at this generation.
		if (observed.podUid === null) return;

		// A receipt already verified for this exact Pod needs no second
		// handshake: the first one stopped every writer and permanently
		// closed command admission for this Pod's life, so re-collecting
		// could only replay the same outcome.
		const prior = record.lastEvidence;
		const samePod =
			prior !== undefined &&
			prior.generation === generation &&
			prior.podUid === observed.podUid &&
			prior.pvcUid === observed.pvcUid &&
			(prior.validated === undefined || prior.validated.namespaceUid === observed.namespaceUid);
		if (samePod && prior.state === "verified" && prior.validated !== undefined) return;
		// A retry of an interrupted handshake reuses the persisted request id:
		// the daemon caches its outcome under that id and replays it.
		const requestId = samePod && prior !== undefined ? prior.requestId : randomUUID();

		try {
			const collected = await collect({
				requestId,
				workspaceId: daemonId,
				generation,
				podUid: observed.podUid,
				pvcUid: observed.pvcUid,
				namespaceUid: observed.namespaceUid,
				sourceRemote: record.source?.remote ?? "",
				pinnedRevision: record.pinnedRevision ?? "",
				branch: record.branch ?? "",
				binding,
				projectId: record.projectId,
				workspaceName: entry.name,
			});
			registry.updateWorkspace(daemonId, {
				lastEvidence: {
					requestId,
					correlationId: collected.correlationId,
					generation,
					podUid: observed.podUid,
					pvcUid: observed.pvcUid,
					state: "verified",
					validated: collected.receipt,
				},
			});
			this.#deps.eventLog.add(
				"info",
				"server",
				`clone ${daemonId} stop collected final evidence (gen ${generation})`,
				daemonId,
			);
		} catch (err) {
			this.#recordStopEvidenceFailure(daemonId, generation, requestId, observed, err);
		}
	}

	/** Persist the typed failure of a stop-time evidence collection. */
	#recordStopEvidenceFailure(
		daemonId: string,
		generation: number,
		requestId: string,
		observed: KubernetesObserved | undefined,
		err: unknown,
	): void {
		const code = this.#evidenceErrorCode(err);
		const message = err instanceof Error ? err.message : String(err);
		this.#deps.registry.updateWorkspace(daemonId, {
			lastEvidence: {
				requestId,
				generation,
				podUid: observed?.podUid ?? null,
				pvcUid: observed?.pvcUid ?? null,
				state: "invalid",
				error: { code, message },
			},
		});
		this.#deps.eventLog.add(
			"warn",
			"server",
			`clone ${daemonId} stop could not collect final evidence (${code}): ${message}; a later delete reports this failure`,
			daemonId,
		);
	}

	/**
	 * Kubernetes final-evidence collection (stage 3 item 4). Runs BEFORE the
	 * Pod is stopped: the daemon flushes its writers and uploads one evidence
	 * document, which the injected collector validates against this fleet
	 * store. The receipt binding persists in three states:
	 *   - `pending`  — persisted BEFORE the request is sent, so a fleet crash
	 *                  or restart leaves a record of the attempt; its
	 *                  `requestId` is the id handed to the collector, so the
	 *                  id a retry replays names the outcome the daemon cached;
	 *   - `verified` — the validated receipt, bound to this exact
	 *                  generation/Pod/PVC/namespace;
	 *   - `invalid`  — collection or validation failed; deletion is blocked
	 *                  with the workspace, volume, and store retained.
	 * A receipt from a previous attempt is reused while it still describes
	 * these resources: the same generation, claim, and namespace. The Pod is
	 * ephemeral, so a stopped workspace (no Pod observed) reuses the receipt
	 * that was validated while its Pod was alive — first the one an explicit
	 * stop persisted in `lastEvidence`, then one a previous attempt carried;
	 * only a DIFFERENT observed Pod, generation, claim, or namespace
	 * invalidates it. When the Pod is already gone there is no writer to
	 * quiesce and no daemon to ask, so no fresh correlation is opened: the
	 * persisted receipt is the evidence, and without one the delete is
	 * refused with everything retained.
	 */
	async #collectDeletionEvidence(
		entry: RegistryEntry,
		requestedAt: number,
		everStarted: boolean,
	): Promise<CloneDeletionReceipt | undefined> {
		const { registry } = this.#deps;
		const daemonId = entry.daemonId;
		const record = entry.workspace;
		if (record?.providerKind !== "kubernetes") return undefined;
		const collect = this.#deps.collectCloneEvidence;
		const carried = record.deletion?.receipt;
		// No collector wired (or the workspace never started): keep today's
		// behavior exactly, including any carried receipt.
		if (!everStarted || collect === undefined) return carried;
		const binding = record.kubernetes;
		if (binding === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`workspace ${daemonId} has no persisted kubernetes resource binding; deletion cannot be bound to its resources`,
			);
		}
		const generation = fencedGeneration(record);
		if (generation === undefined) return carried;

		// Observe the live objects. The provider reports the namespace uid on
		// every ok response and conflicts when the namespace changed. The
		// inspect is generation-fenced to the same generation the receipt
		// binds (the attempted one when it is ahead of the authorized one).
		const inspect = await this.#runCloneOp(daemonId, "inspect", this.#handleOf(entry), generation);
		const observed = inspect.kubernetes;
		if (observed === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`provider inspect for ${daemonId} reported no kubernetes observation; cannot bind the deletion receipt`,
			);
		}
		const podUid = observed.podUid;
		const pvcUid = observed.pvcUid;

		// A carried receipt stands for these resources while its generation,
		// claim, and namespace agree. The Pod is ephemeral — a stopped
		// workspace observes none — so its Pod uid must agree only when a Pod
		// is actually observed; a DIFFERENT live Pod is another writer and
		// never reuses this evidence.
		const sameResources =
			carried !== undefined &&
			carried.generation === generation &&
			(podUid === null || carried.podUid === podUid) &&
			carried.pvcUid === pvcUid &&
			(carried.validated === undefined || carried.validated.namespaceUid === observed.namespaceUid);
		if (
			sameResources &&
			carried !== undefined &&
			carried.state === "verified" &&
			carried.validated !== undefined
		) {
			return carried; // Already validated for this exact generation/claim/namespace.
		}

		// A carried receipt that no longer describes these resources is
		// invalidated and never reused. A verified receipt is NOT invalidated
		// merely because the Pod it was bound to has gone away.
		if (carried !== undefined && !sameResources) {
			registry.setWorkspaceDeletion(daemonId, {
				state: "deleting",
				requestedAt,
				receipt: { ...carried, state: "invalid" },
			});
		}

		// The Pod is EPHEMERAL: after an explicit stop it is gone, and the
		// evidence the STOP collected while the daemon was still alive is the
		// only authority left. Prefer that persisted receipt over the one a
		// previous attempt carried; both bind the same generation/claim/
		// namespace.
		const stopEvidence =
			podUid === null &&
			record.lastEvidence !== undefined &&
			record.lastEvidence.generation === generation &&
			record.lastEvidence.pvcUid === pvcUid &&
			(record.lastEvidence.validated === undefined ||
				record.lastEvidence.validated.namespaceUid === observed.namespaceUid)
				? record.lastEvidence
				: undefined;
		if (
			stopEvidence !== undefined &&
			stopEvidence.state === "verified" &&
			stopEvidence.validated !== undefined
		) {
			return stopEvidence;
		}

		// Pod gone: nothing can be quiesced or flushed, and the daemon that
		// would answer a fresh request no longer exists. The receipts above
		// are the only admissible evidence; without a verified one the delete
		// is refused with the workspace, volume, and store retained — never
		// verified away silently. A stop-time collection that FAILED is
		// reported as that failure, not as a bare missing receipt.
		if (podUid === null) {
			const recorded = stopEvidence?.error;
			const message =
				recorded !== undefined
					? `workspace ${daemonId} deletion blocked: stop-time evidence collection failed (${recorded.code}): ${recorded.message}; ` +
						`clear the rejected attempt (POST /ctl/workspaces/${daemonId}/clear-deletion), wake the workspace to preserve ` +
						"changes, stop it to collect evidence, then retry the delete"
					: `workspace ${daemonId} deletion blocked: its Pod is gone and no verified evidence receipt was carried; ` +
						`clear the rejected attempt (POST /ctl/workspaces/${daemonId}/clear-deletion), wake the workspace to preserve ` +
						"changes, stop it, then retry the delete";
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				...(carried !== undefined
					? { receipt: carried }
					: stopEvidence !== undefined
						? { receipt: stopEvidence }
						: {}),
				error: { code: recorded?.code ?? "unavailable", message },
			});
			this.#deps.eventLog.add(
				"warn",
				"server",
				recorded !== undefined
					? `delete ${daemonId} blocked: the stop-time evidence collection failed (${recorded.code}): ${recorded.message}`
					: `delete ${daemonId} blocked: no Pod observed and no usable evidence receipt: ${message}`,
				daemonId,
			);
			throw new CloneLifecycleError(recorded?.code ?? "unavailable", message);
		}

		// Pod observed: a partial retry asks the daemon about the SAME request
		// id (it replays its cached outcome under the fresh correlation); a
		// changed Pod gets a fresh request id.
		let requestId: string = randomUUID();
		if (sameResources && carried !== undefined) requestId = carried.requestId;

		// Persist PENDING before the request leaves the fleet: a crash here
		// must still identify the attempt (and its request id) on restart.
		registry.setWorkspaceDeletion(daemonId, {
			state: "deleting",
			requestedAt,
			receipt: { requestId, generation, podUid, pvcUid, state: "pending" },
		});
		try {
			// The persisted request id is threaded into the collector: the
			// daemon caches its quiesce outcome under THIS id, so a retry
			// after a fleet crash replays the same outcome instead of asking
			// a request id no daemon ever saw.
			const collected = await collect({
				requestId,
				workspaceId: daemonId,
				generation,
				podUid,
				pvcUid,
				namespaceUid: observed.namespaceUid,
				sourceRemote: record.source?.remote ?? "",
				pinnedRevision: record.pinnedRevision ?? "",
				branch: record.branch ?? "",
				binding,
				projectId: record.projectId,
				workspaceName: entry.name,
			});
			const verified: CloneDeletionReceipt = {
				requestId,
				correlationId: collected.correlationId,
				generation,
				podUid,
				pvcUid,
				state: "verified",
				validated: collected.receipt,
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "deleting",
				requestedAt,
				receipt: verified,
			});
			return verified;
		} catch (err) {
			const code = this.#evidenceErrorCode(err);
			const message = err instanceof Error ? err.message : String(err);
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				receipt: { requestId, generation, podUid, pvcUid, state: "invalid" },
				error: { code, message: `cannot collect final evidence: ${message}` },
			});
			this.#deps.eventLog.add(
				"warn",
				"server",
				`delete ${daemonId} blocked: final evidence unavailable (${code}): ${message}`,
				daemonId,
			);
			throw new CloneLifecycleError(
				code,
				`workspace ${daemonId} deletion blocked: final evidence could not be collected (${code}): ${message}; ` +
					`the workspace, its volume and its stored sessions are retained, and an explicit stop preserves the PVC ` +
					`(clear the rejected attempt at POST /ctl/workspaces/${daemonId}/clear-deletion to wake, preserve, stop, and retry)`,
			);
		}
	}

	/**
	 * P8.9 wake resume: compute the resume target for a NEW daemon spawn and,
	 * for bwrap volumes, materialize cold/missing transcripts into the volume.
	 * Returns the handoff env to write (OMP_SESSION_RESUME, plus
	 * OMP_SESSION_RESUME_REQUIRED for kubernetes), or undefined when the wake
	 * should boot fresh:
	 *   - never-started clones (no sessions anywhere) → fresh;
	 *   - explicit `resumeSessionId` that exists nowhere → typed
	 *     `unavailable` BEFORE compute starts (the edge pre-validates against
	 *     the store, so this only fires on a store/volume disagreement —
	 *     never a silent fresh boot over the user's pick);
	 *   - implicit wake → the last session the fleet recorded, else the
	 *     newest session in the volume ∪ store, so a stopped clone wake
	 *     continues its last session. A NEW session is chosen only when
	 *     neither the fleet nor the store has a previous session identity.
	 * bwrap hands the fleet-resolved HOST main-file path; kubernetes is not
	 * fleet-readable, so it hands the IN-POD main-file path
	 * (`/workspace/.home/agent/sessions/<relpath>`) and requires the daemon to
	 * restore/materialize it over the callback pair. Fill-missing-only
	 * materialization: existing volume files are never overwritten (the
	 * volume may hold a newer unacked tail; the daemon's tailer re-streams it
	 * once booted). Throws CloneLifecycleError `unavailable` when an explicit
	 * target cannot be resolved.
	 */
	async #resolveWakeResume(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string },
	): Promise<Record<string, string> | undefined> {
		const daemonId = entry.daemonId;
		const { profile } = this.#cloneProfile(entry);
		const store = this.#deps.logStore;
		const record = this.#deps.registry.get(daemonId)?.workspace;
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;
		const explicit = opts.resumeSessionId;
		if (profile.provider === "kubernetes") {
			return this.#resolveKubernetesWakeResume(entry, {
				explicit,
				fresh: opts.firstStart && !everStarted,
				store,
			});
		}
		const { volumeRoot } = this.#clonePaths(entry);
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");
		const target =
			explicit !== undefined
				? explicit
				: opts.firstStart && !everStarted
					? undefined
					: (pickNewestSessionId({
							sessionsDir,
							...(store !== null ? { store, workspaceId: daemonId } : {}),
						}) ?? this.#sessionIdFromFile(entry.lastSessionFile));
		if (target === undefined) return undefined; // Nothing to resume: fresh boot.

		if (store !== null) {
			try {
				materializeMissingSessionFiles({
					store,
					workspaceId: daemonId,
					sessionId: target,
					sessionsDir,
				});
			} catch (err) {
				if (explicit !== undefined) {
					// An explicit pick that cannot be materialized is a typed
					// failure — never a silent fresh boot over the user's pick.
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
		// Stale-lock cleanup (P8.9 boot-resume): the daemon locks the resumed
		// session file (`<file>.lock`) with its PID. A prior sandbox lifetime
		// that was stopped without a graceful release leaves that lock file
		// behind — and its PID is namespace-relative (e.g. 2 inside bwrap),
		// so the NEW sandbox's liveness probe sees an ALIVE pid 2 and refuses
		// to boot ("session file ... is locked by another omp-session"). This
		// wake only reaches here after the predecessor generation is PROVEN
		// terminated (P6.2 stop proof precedes the generation bump), so any
		// lock beside the resume target is definitionally stale: clear it
		// before the daemon spawns. Best-effort (a missing lock is fine).
		try {
			unlinkSync(`${mainFile}.lock`);
		} catch {
			// Absent or already cleared — nothing to do.
		}
		return { OMP_SESSION_RESUME: mainFile };
	}

	/**
	 * Kubernetes wake resume: the PVC is not fleet-readable, so the target is
	 * the explicit id, the last session the fleet recorded (the daemon
	 * reports an in-pod main path), or the newest session in the store. The
	 * handoff names the IN-POD main file and marks the resume required, so a
	 * cold/missing transcript is restored by the daemon over the pair and a
	 * failed restore exits before readiness.
	 */
	#resolveKubernetesWakeResume(
		entry: RegistryEntry,
		ctx: { explicit: string | undefined; fresh: boolean; store: FleetLogStore | null },
	): Record<string, string> | undefined {
		const daemonId = entry.daemonId;
		const { explicit, fresh, store } = ctx;
		const recorded = entry.lastSessionFile;
		const target =
			explicit !== undefined
				? explicit
				: fresh
					? undefined
					: (this.#sessionIdFromFile(recorded) ??
						(store !== null
							? pickNewestSessionId({
									sessionsDir: KUBERNETES_SESSIONS_ROOT,
									store,
									workspaceId: daemonId,
								})
							: undefined));
		if (target === undefined) return undefined; // No previous session identity: fresh boot.

		// Prefer the fleet's own recorded in-pod main file when it names this
		// target; otherwise map the store's validated main relpath under the
		// in-pod sessions root.
		let inPodMain: string | undefined;
		if (
			recorded !== undefined &&
			recorded.endsWith(".jsonl") &&
			recorded.startsWith(`${KUBERNETES_SESSIONS_ROOT}/`) &&
			this.#sessionIdFromFile(recorded) === target
		) {
			inPodMain = recorded;
		}
		if (inPodMain === undefined && store !== null) {
			let mainRelpath: string | undefined;
			try {
				mainRelpath = store.storedLineage(daemonId, target)?.mainRelpath;
			} catch {
				mainRelpath = undefined; // Unreadable lineage = no store main.
			}
			if (mainRelpath !== undefined && isNormalizedPosixRelativePath(mainRelpath)) {
				inPodMain = `${KUBERNETES_SESSIONS_ROOT}/${mainRelpath}`;
			}
		}
		if (inPodMain === undefined) {
			if (explicit !== undefined) {
				throw new CloneLifecycleError(
					"unavailable",
					`cannot resume session ${target} for ${daemonId}: no stored transcript and no recorded in-pod main file`,
				);
			}
			return undefined; // Implicit target has no recoverable transcript; boot fresh.
		}
		return { OMP_SESSION_RESUME: inPodMain, OMP_SESSION_RESUME_REQUIRED: "1" };
	}

	/** Session id from a recorded session-file path (`<stem>.jsonl`), when safe. */
	#sessionIdFromFile(sessionFile: string | undefined): string | undefined {
		if (sessionFile === undefined || !sessionFile.endsWith(".jsonl")) return undefined;
		const slash = Math.max(sessionFile.lastIndexOf("/"), sessionFile.lastIndexOf("\\"));
		const stem = sessionFile.slice(slash + 1, -".jsonl".length);
		return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem) ? stem : undefined;
	}

	/**
	 * Write the callback-enrollment handoff BEFORE ensure-running through the
	 * shared hardened writer (temp + fsync + rename; rejects symlinks,
	 * disallowed keys, oversized content, and a non-positive generation). The
	 * enrollment keys own their names: a resume hint may never shadow the
	 * callback pair.
	 */
	#writeCallbackEnv(
		entry: RegistryEntry,
		generation: number,
		credentialHex: string,
		extraEnv?: Record<string, string>,
	): void {
		const { stateDir } = this.#clonePaths(entry);
		const url = this.#deps.callbackUrl();
		const env: Record<string, string> = {
			OMP_SESSION_CALLBACK_URL: url,
			OMP_SESSION_CALLBACK_WORKSPACE: entry.daemonId,
			OMP_SESSION_CALLBACK_GENERATION: String(generation),
			OMP_SESSION_CALLBACK_TOKEN: credentialHex,
		};
		if (url.startsWith("http://")) env.OMP_SESSION_CALLBACK_ALLOW_HTTP = "1";
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
		const record: CallbackEnvRecord = {
			version: 1,
			workspaceId: entry.daemonId,
			generation,
			env,
		};
		writeCallbackEnvFile(stateDir, record);
	}

	/**
	 * Recover the raw enrollment token from the provider state handoff so a
	 * re-ensure on the SAME generation (or a retry of an in-flight attempt)
	 * keeps the credential the daemon already holds (restart-safe; only the
	 * digest is ever persisted). Returns undefined when no handoff matches.
	 */
	#recoverCallbackToken(entry: RegistryEntry, generation: number): string | undefined {
		const { stateDir } = this.#clonePaths(entry);
		try {
			const record = readCallbackEnvFile(stateDir, {
				workspaceId: entry.daemonId,
				generation,
				required: ["OMP_SESSION_CALLBACK_TOKEN"],
			});
			const token = record?.env.OMP_SESSION_CALLBACK_TOKEN;
			return token !== undefined && token.length > 0 ? token : undefined;
		} catch {
			return undefined;
		}
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
	 * Bounded callback→ready watcher: polls the transport pair status at 1s
	 * intervals and writes lifecycleStage "ready" once the daemon's pair is
	 * observed live. Never blocks callers; stops when the workspace leaves
	 * desired-running.
	 *
	 * A provider that reported `observed: running` can still die before its
	 * callback pair dials (or never dial at all). The watcher therefore
	 * periodically re-inspects the provider: a sandbox that is no longer
	 * running surfaces as status "error" + lifecycleStage "failed" with the
	 * typed message (never an eternal "callback" stage over a dead pid), and
	 * the polling stops. A live-but-slow sandbox keeps polling — the stage
	 * flips to "ready" the moment the pair establishes. There is no silent
	 * timeout that leaves the stage stuck.
	 *
	 * S1 post-ready liveness: the watcher does NOT retire at ready. A sandbox
	 * can die (or its worker be evicted) AFTER the pair established, and no
	 * other code path notices — the roster would present the row as live
	 * forever. After the ready transition the watcher switches to a slower
	 * {@link PAIR_POST_READY_POLL_MS} poll that never re-inspects while the
	 * pair is live; when the pair is lost it re-inspects the provider (at most
	 * once per interval) and demotes a non-running sandbox to the same
	 * failed/error vocabulary as the pre-ready branch. A deliberate stop ends
	 * the watch immediately (desiredState guard + explicit disarm), so a
	 * stopped workspace can never be relabeled a crash.
	 */
	#armPairWatcher(daemonId: string): void {
		if (this.#pairWatchers.has(daemonId)) return;
		let attempts = 0;
		/** The pair was observed live at least once (post-ready watch armed). */
		let ready = false;
		const tick = async (): Promise<void> => {
			const current = this.#deps.registry.get(daemonId);
			if (!current || current.workspace?.desiredState !== "running") {
				this.#pairWatchers.delete(daemonId);
				return;
			}
			const pair = this.#deps.transport.pairStatus(daemonId);
			if (pair.paired && pair.enrolled) {
				if (!ready) {
					this.#setStage(daemonId, "ready");
					ready = true;
				}
				// Live pair: never re-inspect. Keep a slower poll so a later
				// pair loss is noticed; reset the pre-ready budget so a pair
				// that flapped before ready still gets its full inspect cadence.
				attempts = 0;
				this.#schedulePairTick(daemonId, PAIR_POST_READY_POLL_MS, tick);
				return;
			}
			if (ready) {
				// The pair established, then went away. Bounded to one inspect
				// per poll interval (this branch only runs from that cadence).
				try {
					const inspect = await this.#runCloneOp(daemonId, "inspect", this.#handleOf(current));
					// Re-read AFTER the probe: a deliberate stop that landed
					// while the provider answered must never be mislabeled.
					const after = this.#deps.registry.get(daemonId);
					if (!after || after.workspace?.desiredState !== "running") {
						this.#pairWatchers.delete(daemonId);
						return;
					}
					if (inspect.observed !== "running") {
						this.#setStage(
							daemonId,
							"failed",
							`sandbox stopped after the callback pair established (observed ${inspect.observed})`,
						);
						this.#deps.registry.setStatus(
							daemonId,
							"error",
							`sandbox stopped after the callback pair established (observed ${inspect.observed}); stop and start to retry`,
						);
						this.#pairWatchers.delete(daemonId);
						this.#log(
							"warn",
							`clone ${daemonId} callback pair lost; sandbox ${inspect.observed}`,
							daemonId,
						);
						return;
					}
				} catch {
					// Inspect failed (provider unavailable or a typed
					// conflict/unavailable): the pair may still redial; the
					// next interval retries. A genuinely dead sandbox reports
					// observed != running (handled above).
				}
				this.#schedulePairTick(daemonId, PAIR_POST_READY_POLL_MS, tick);
				return;
			}
			attempts += 1;
			// Every 10th tick (~10s) re-inspect the provider: a sandbox the
			// provider claimed running but that has since died (or whose
			// callback never dials) must not sit at stage "callback" forever.
			if (attempts % 10 === 0) {
				try {
					const inspect = await this.#runCloneOp(daemonId, "inspect", this.#handleOf(current));
					// Same stop-race guard as the post-ready branch: a stop
					// that landed during the probe owns the entry's state.
					const after = this.#deps.registry.get(daemonId);
					if (!after || after.workspace?.desiredState !== "running") {
						this.#pairWatchers.delete(daemonId);
						return;
					}
					if (inspect.observed !== "running") {
						this.#setStage(
							daemonId,
							"failed",
							`sandbox stopped before the callback pair established (observed ${inspect.observed})`,
						);
						this.#deps.registry.setStatus(
							daemonId,
							"error",
							`sandbox stopped before the callback pair established (observed ${inspect.observed}); stop and start to retry`,
						);
						this.#pairWatchers.delete(daemonId);
						this.#log(
							"warn",
							`clone ${daemonId} callback never established; sandbox ${inspect.observed}`,
							daemonId,
						);
						return;
					}
				} catch {
					// Inspect failed (provider unavailable or a typed
					// conflict/unavailable): keep polling — the pair may
					// still come up; the next inspect retries. A genuinely
					// dead sandbox reports observed != running (not an
					// error), which is handled above.
				}
			}
			this.#schedulePairTick(daemonId, 1_000, tick);
		};
		this.#schedulePairTick(daemonId, 1_000, tick);
	}

	/** Arm one pair-watcher tick (replaces any pending timer for the id). */
	#schedulePairTick(daemonId: string, delayMs: number, tick: () => Promise<void>): void {
		this.#pairWatchers.set(
			daemonId,
			setTimeout(() => void tick(), delayMs),
		);
	}

	/** Cancel a workspace's pending pair-watcher tick, if any. */
	#disarmPairWatcher(daemonId: string): void {
		const timer = this.#pairWatchers.get(daemonId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#pairWatchers.delete(daemonId);
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

	/**
	 * Serialize lifecycle operations per workspace: each call chains behind
	 * the previous one, so registry read-modify-write transitions never
	 * interleave. Errors propagate to the caller (never swallowed) and the
	 * tail map self-cleans once the chain settles.
	 */
	#enqueue<T>(daemonId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(daemonId) ?? Promise.resolve();
		const result = previous.then(fn, fn);
		const tail: Promise<void> = result.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(daemonId, tail);
		void tail.then(() => {
			if (this.#queues.get(daemonId) === tail) this.#queues.delete(daemonId);
		});
		return result;
	}

	/**
	 * Reserved-environment admission (stage 2 item 5) for a kubernetes
	 * profile. Every secretRef env name must be a valid environment name and
	 * must not shadow a name the Pod/entrypoint owns (the callback pair,
	 * workspace identity, preparation inputs, home/path/agent dirs, provider
	 * version). Values remain cluster Secret references — never materialized
	 * fleet-side.
	 */
	#validateKubernetesEnvironment(
		profile: NonNullable<FleetConfig["providerProfiles"]>[string],
	): void {
		for (const envName of Object.keys(profile.secretRefs ?? {})) {
			if (!ENV_NAME_RE.test(envName)) {
				throw new CloneLifecycleError(
					"invalid_request",
					`profile "${profile.id}" secretRefs key ${JSON.stringify(envName)} is not a valid environment variable name`,
				);
			}
			if (
				RESERVED_SECRET_ENV_KEYS.includes(envName) ||
				KUBERNETES_RESERVED_ENV_KEYS.includes(envName)
			) {
				throw new CloneLifecycleError(
					"invalid_request",
					`profile "${profile.id}" secretRefs key ${envName} is a reserved environment name; reserved names are never injected from secretRefs`,
				);
			}
		}
		const callbackUrl = this.#deps.callbackUrl();
		try {
			// The authoritative daemon-side parser: a kubernetes Pod can only
			// dial a bare HTTPS origin (no credentials, no loopback or
			// unspecified host, no path/query/fragment).
			parseKubernetesCallbackUrl(callbackUrl);
		} catch (err) {
			throw new CloneLifecycleError(
				"invalid_request",
				`fleet callback URL ${JSON.stringify(callbackUrl)} is not usable by a kubernetes workspace: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Resolve the namespace API uid with kubectl (`OMP_KUBE_BIN` honored),
	 * exactly as the provider does. This is the ONLY binding fact the fleet
	 * establishes: the provider treats it as authoritative on every operation
	 * and never tolerates a placeholder, so it must be real before
	 * registration. Bounded at 60s.
	 */
	async #resolveNamespaceUid(context: string, namespace: string): Promise<string> {
		const bin = process.env.OMP_KUBE_BIN ?? "kubectl";
		const result = await runCommand(
			[bin, "--context", context, "get", "namespace", namespace, "-o", "jsonpath={.metadata.uid}"],
			{ timeoutMs: 60_000 },
		);
		const uid = result.stdout.trim();
		if (result.exitCode !== 0 || uid === "") {
			const lines = result.stderr
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
			const detail = lines[lines.length - 1] ?? `exit ${result.exitCode}`;
			throw new CloneLifecycleError(
				"unavailable",
				`cannot resolve namespace uid for ${namespace} (context ${context}): ${detail}`,
			);
		}
		if (uid.length > 128 || /\s/.test(uid)) {
			throw new CloneLifecycleError(
				"unavailable",
				`cannot resolve namespace uid for ${namespace} (context ${context}): kubectl returned an invalid uid`,
			);
		}
		return uid;
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
