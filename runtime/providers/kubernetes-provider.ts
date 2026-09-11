#!/usr/bin/env bun
/**
 * Kubernetes provider (P5.3): implements the frozen provider operation
 * protocol (OMP_PROVIDER_PROTO = 2, docs/clone-contracts.md "Provider
 * operation protocol") for clone workspaces on an operator-prepared
 * Kubernetes API.
 *
 * Invocation: `<executable> ensure-running|inspect|stop|delete` with exactly
 * one JSON request on stdin and one JSON response on stdout; exit 0 when a
 * response was produced (the `ok` flag classifies the outcome). stderr is a
 * human log the fleet never parses. Every envelope carries `providerProto`;
 * every kubernetes response also carries
 * `kubernetes: {namespaceUid, podUid, pvcUid}` (null = object absent, and the
 * namespace uid the operation actually observed).
 *
 * Resource model (one workspace = one Pod + one PVC + an optional baseline
 * ConfigMap, nothing else):
 * - Both object names are exactly `omp-ws-<resourceIdentity>`
 *   (`KubernetesBinding.resourceIdentity`, 32 lowercase hex chars generated
 *   once by the fleet), so restart rediscovery needs no listing and two
 *   workspaces can never collide on a sanitized name. The binding's context
 *   and namespace are authoritative: the ambient kubectl current-context is
 *   never consulted or mutated.
 * - A persistent per-workspace PVC (`ReadWriteOnce`) holds the runtime
 *   workspace volume: `.omp-workspace-init.json`, `.checkout/`, `.home/`
 *   (frozen "Preparation layout"). Stop retains the claim; replacement
 *   reuses it; initialization runs only when the verified init marker is
 *   absent (new workspace), enforced by the image entrypoint.
 * - A single Pod mounts the claim at /workspace and runs the session daemon
 *   with `restartPolicy: "Never"` so identity is never masked by a kubelet
 *   restart. No Service/Ingress is created: the daemon dials the fleet
 *   callback pair outbound (P5.3: no inbound pod service required).
 * - No cluster mutation beyond these namespaced objects, ever. The provider
 *   never creates namespaces, RBAC, StorageClasses, Secrets, or
 *   NetworkPolicies.
 *
 * Durable identity (never PID-only; the pod has no host pid):
 * - The provider records its launch identity at
 *   `<stateDir>/provider.k8s.json` = {version, workspaceId, generation,
 *   workspaceToken, namespace, namespaceUid, resourceIdentity, podName,
 *   pvcName, podUid, pvcUid, sourceRemote, revision, branch,
 *   sourcePinDigest, callbackDigest, createdAt, startedAt?, stoppedAt?}.
 *   `workspaceToken` is the API-side analogue of bwrap's argv token. The
 *   `pvcUid` fence is retained across generations (the claim outlives the Pod
 *   that first mounted it), so it is read from the record regardless of the
 *   requested generation.
 * - ONE ownership validator (`ownershipReason`, resources.ts) is shared by all
 *   four operations: managed-by / part-of labels, the workspace-id annotation,
 *   the full profile-id annotation plus its label, the resource-id label, the
 *   namespace-uid annotation against the binding, the object's own API uid
 *   when the record pins one, and (for Pods) the exact positive-decimal
 *   generation label and the provider launch token. A foreign or
 *   generation-fenced object is never adopted, mutated, or deleted.
 * - Callback credential: the fleet's `enrollWorkspace` persists the SHA-256
 *   digest of the DECODED 256-bit credential. The provider persists that same
 *   digest (never the credential) in the record and the Pod annotation,
 *   recomputes it from the handoff, and refuses to reuse or adopt a Pod whose
 *   annotation disagrees. The raw credential lives only in the protected
 *   `<stateDir>/callback-env.json` handoff and the Pod environment: it is
 *   never logged and never included in a response.
 * - Source pin: `sourcePinDigest` = lowercase sha256 of UTF-8
 *   `JSON.stringify([source.remote, revision, branch])` is stamped on both
 *   objects and compared against the request tuple and the provider record,
 *   so a retained volume can never silently serve a different pin.
 * - `stop` deletes the pod and PROVES the requested generation terminated by
 *   polling the API until the pod is gone; an uncertain predecessor is
 *   `conflict` (retryable). The PVC is retained. Stop works with no callback
 *   handoff: ownership comes from the resource binding and the launch record.
 * - `delete` validates every present object before the FIRST deletion, deletes
 *   through an API uid-preconditioned DELETE, waits for absence, and leaves the
 *   stateDir for the fleet to remove after confirmed deletion (P3.7).
 * - Every operation takes the hardened per-workspace `acquireFileLock`
 *   (shared/file-lock.ts) and waits, bounded, for a peer that holds it rather
 *   than declaring conflict immediately.
 *
 * Configuration (operator-explicit; no ambient discovery):
 * - context/namespace/namespaceUid/resourceIdentity: `request.kubernetes`
 *   (the persisted binding), cross-checked against `profile.context` and
 *   `profile.namespace` when present.
 * - image: `profile.image`, required.
 * - resources/storage: `profile.resources {cpu, memory}` (applied as both
 *   requests and limits → Guaranteed QoS), `profile.storage {class, size}`.
 * - model/tool credentials: `profile.secretRefs` maps ENV name →
 *   `<secretName>/<key>`, injected as native `secretKeyRef` env; reserved
 *   names are refused before any cluster call (see config.ts).
 * - callback enrollment: the fleet-written `callback-env.json` handoff is
 *   injected as pod env; management operations tolerate an absent or unusable
 *   credential and never trust an identity mismatch.
 *
 * Missing prerequisites fail `unavailable`/`invalid_request` with
 * actionable remediation. There is no auto-install, no RBAC/namespace
 * creation, and no ephemeral/emptyDir fallback for workspace storage.
 *
 * Bundle-safety: imports only node builtins and shared/*; no import.meta
 * path reads, no self-respawn. `kubectl` argv arrays only, never a shell.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLock, LockHeldError } from "../../shared/file-lock";
import type { FileLock } from "../../shared/file-lock";
import {
	OMP_PROVIDER_PROTO,
	ProviderProtocolError,
	parseProviderRequest,
	type KubernetesObserved,
	type ProviderObserved,
	type ProviderRequest,
	type ProviderResponse,
} from "../../shared/provider-protocol";
import type { ProviderErrorCode } from "../../shared/provider-protocol";
import { CALLBACK_ENV_FILE, readCallbackEnvFile } from "../callback-env";
import type { CallbackEnvRecord } from "../callback-env";
import { resolveConfig } from "./kubernetes/config";
import type { KubernetesConfig } from "./kubernetes/config";
import {
	ANN_CALLBACK_DIGEST,
	ANN_WORKSPACE_TOKEN,
	baselineConfigMapName,
	buildBaselineConfigMapManifest,
	buildPodManifest,
	buildPvcManifest,
	objectIdentity,
	objectMeta,
	ownershipReason,
	podPhase,
	podStartTime,
	pvcMeta,
	type KubernetesObjectIdentity,
	type WorkspaceOwnership,
} from "./kubernetes/resources";
import {
	defaultKubeExec,
	delay,
	KubeCallError,
	KubePreconditionError,
	kubeCreate,
	kubeDelete,
	kubeGet,
	kubeNamespaceUid,
	observeObjects,
	POLL_INTERVAL_MS,
	waitGone,
	waitPodRunning,
	type KubeExec,
	type ObservedObjects,
	type PodRunningWait,
} from "./kubernetes/kubectl";
import { readKubernetesWaits } from "./kubernetes/timeouts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The provider's identity record in its private per-workspace stateDir. */
const RECORD_FILE = "provider.k8s.json";
/** Hardened per-workspace lock file inside the stateDir. */
const LOCK_FILE = "lock";
const STATE_LOCK_HOLDER = "kubernetes-provider";

/** Callback handoff env keys (allowlisted by runtime/callback-env.ts). */
const CALLBACK_URL_ENV_KEY = "OMP_SESSION_CALLBACK_URL";
const CALLBACK_WORKSPACE_ENV_KEY = "OMP_SESSION_CALLBACK_WORKSPACE";
const CALLBACK_GENERATION_ENV_KEY = "OMP_SESSION_CALLBACK_GENERATION";
const CALLBACK_TOKEN_ENV_KEY = "OMP_SESSION_CALLBACK_TOKEN";
/** A kubernetes launch requires URL, workspace, generation, and credential. */
const CALLBACK_REQUIRED_ENV_KEYS = [
	CALLBACK_URL_ENV_KEY,
	CALLBACK_WORKSPACE_ENV_KEY,
	CALLBACK_GENERATION_ENV_KEY,
	CALLBACK_TOKEN_ENV_KEY,
] as const;

// ---------------------------------------------------------------------------
// Identity record (stateDir/provider.k8s.json)
// ---------------------------------------------------------------------------

interface KubernetesLaunchRecord {
	version: 1;
	workspaceId: string;
	generation: number;
	workspaceToken: string;
	namespace: string;
	namespaceUid: string;
	resourceIdentity: string;
	podName: string;
	pvcName: string;
	/** API uid of the Pod this record is anchored to (null until observed). */
	podUid: string | null;
	/**
	 * API uid of the claim observed alongside the Pod (null until observed).
	 * The claim outlives a Pod generation, so this fence is compared
	 * independently of the record's generation.
	 */
	pvcUid: string | null;
	sourceRemote: string;
	revision: string;
	branch: string;
	sourcePinDigest: string;
	/** sha256 hex of the DECODED callback credential; never the credential. */
	callbackDigest: string;
	createdAt: number;
	startedAt?: number;
	stoppedAt?: number;
}

const RECORD_STRING_FIELDS = [
	"workspaceId",
	"workspaceToken",
	"namespace",
	"namespaceUid",
	"resourceIdentity",
	"podName",
	"pvcName",
	"sourceRemote",
	"revision",
	"branch",
	"sourcePinDigest",
	"callbackDigest",
] as const;

function readRecord(stateDir: string): KubernetesLaunchRecord | null {
	let raw: string;
	try {
		raw = readFileSync(join(stateDir, RECORD_FILE), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (value.version !== 1) return null;
	for (const field of RECORD_STRING_FIELDS) {
		const entry = value[field];
		if (typeof entry !== "string" || entry === "") return null;
	}
	const generation = value.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
		return null;
	}
	const createdAt = value.createdAt;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
	for (const field of ["podUid", "pvcUid"] as const) {
		const entry = value[field];
		if (entry !== null && (typeof entry !== "string" || entry === "")) return null;
	}
	return value as unknown as KubernetesLaunchRecord;
}

/** Atomically write the identity record (tmp file + rename, mode 0600). */
function writeRecord(stateDir: string, record: KubernetesLaunchRecord): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = join(stateDir, `.${RECORD_FILE}.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(tmp, join(stateDir, RECORD_FILE));
}

/** The record's generation-scoped state, when the record describes it. */
function recordForGeneration(
	record: KubernetesLaunchRecord | null,
	generation: number,
): KubernetesLaunchRecord | null {
	return record !== null && record.generation === generation ? record : null;
}

/**
 * The request tuple must agree with the provider's persisted state: a lost
 * record is adoption (allowed, re-validated against Kubernetes metadata), a
 * disagreeing record is a conflict (the workspace's binding, namespace,
 * source, pin, or branch changed underneath a retained volume).
 */
function recordMismatch(
	record: KubernetesLaunchRecord | null,
	cfg: KubernetesConfig,
	request: ProviderRequest,
): string | null {
	if (record === null) return null;
	if (record.workspaceId !== request.workspaceId) {
		return `the launch record belongs to workspace ${record.workspaceId}, requested ${request.workspaceId}`;
	}
	if (record.resourceIdentity !== cfg.resourceIdentity) {
		return `the launch record is bound to resource ${record.resourceIdentity}, request carries ${cfg.resourceIdentity}`;
	}
	if (record.namespace !== cfg.namespace) {
		return `the launch record was created in namespace ${record.namespace}, request binds ${cfg.namespace}`;
	}
	if (record.namespaceUid !== cfg.namespaceUid) {
		return `the launch record pins namespace uid ${record.namespaceUid}, request binds ${cfg.namespaceUid}`;
	}
	if (
		record.sourceRemote !== cfg.sourceRemote ||
		record.revision !== cfg.revision ||
		record.branch !== cfg.branch ||
		record.sourcePinDigest !== cfg.sourcePinDigest
	) {
		return (
			`the launch record pins ${record.sourceRemote}@${record.revision} (${record.branch}), ` +
			`request carries ${cfg.sourceRemote}@${cfg.revision} (${cfg.branch})`
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Callback enrollment handoff (runtime/callback-env.ts)
// ---------------------------------------------------------------------------

interface CallbackHandoff {
	/** Allowlisted env to inject into the Pod (carries the raw credential). */
	env: Record<string, string>;
	/** sha256 hex of the DECODED credential; never the credential itself. */
	digest: string;
}

/**
 * sha256 hex of the DECODED credential, byte-identical to the fleet's
 * `enrollWorkspace` digest: 64-char hex is decoded from hex, anything else
 * from base64; both must yield exactly 32 bytes. Returns null when the token
 * is not a usable 256-bit credential. The raw token is never logged.
 */
function callbackCredentialDigest(token: string): string | null {
	const text = token.trim();
	if (/^[0-9a-fA-F]{64}$/.test(text)) {
		return createHash("sha256").update(Buffer.from(text, "hex")).digest("hex");
	}
	const decoded = Buffer.from(text, "base64");
	if (decoded.byteLength !== 32) return null;
	return createHash("sha256").update(decoded).digest("hex");
}

/**
 * Read the fleet's callback enrollment handoff. A launch requires it (identity
 * and generation checked; a stale enrollment must never start a generation);
 * a management operation treats an absent, other-generation, or unusable
 * handoff as "no enrollment evidence" — never an identity mismatch — so
 * stop/delete keep working when only a credential is broken.
 */
function readHandoff(
	stateDir: string,
	workspaceId: string,
	generation: number,
	required: boolean,
): CallbackHandoff | null {
	let record: CallbackEnvRecord | null;
	try {
		record = required
			? readCallbackEnvFile(stateDir, {
					workspaceId,
					generation,
					required: CALLBACK_REQUIRED_ENV_KEYS,
				})
			: readCallbackEnvFile(stateDir);
	} catch (cause) {
		// Management operations never depend on enrollment state: a broken,
		// foreign, or stale handoff must not block stop/delete/inspect
		// (ownership comes from the resource binding and the launch record).
		if (required) throw cause;
		return null;
	}
	if (record === null) {
		if (!required) return null;
		throw new ProviderProtocolError(
			"unavailable",
			`${CALLBACK_ENV_FILE} is absent: the fleet must enroll a callback credential and write the handoff before ensure-running`,
		);
	}
	const env = record.env;
	if (env[CALLBACK_WORKSPACE_ENV_KEY] !== workspaceId) {
		if (!required) return null;
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE}.${CALLBACK_WORKSPACE_ENV_KEY} targets ${JSON.stringify(env[CALLBACK_WORKSPACE_ENV_KEY] ?? null)}, requested ${workspaceId}`,
		);
	}
	if (env[CALLBACK_GENERATION_ENV_KEY] !== String(generation)) {
		if (!required) return null;
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE}.${CALLBACK_GENERATION_ENV_KEY} targets generation ${JSON.stringify(env[CALLBACK_GENERATION_ENV_KEY] ?? null)}, requested ${generation}; a new generation must not start under a stale enrollment`,
		);
	}
	const token = env[CALLBACK_TOKEN_ENV_KEY];
	if (token === undefined) {
		if (!required) return null;
		throw new ProviderProtocolError(
			"unavailable",
			`${CALLBACK_ENV_FILE} carries no ${CALLBACK_TOKEN_ENV_KEY}: a kubernetes launch requires the enrolled callback credential`,
		);
	}
	const digest = callbackCredentialDigest(token);
	if (digest === null) {
		if (!required) return null;
		throw new ProviderProtocolError(
			"unavailable",
			`${CALLBACK_ENV_FILE}.${CALLBACK_TOKEN_ENV_KEY} is not a usable 256-bit credential (64-char hex or base64 of 32 bytes)`,
		);
	}
	return { env, digest };
}

/**
 * The digest the Pod annotation must carry for this generation. The record and
 * the handoff are both sources of truth: when both exist and disagree the
 * credential changed underneath a recorded Pod, which is a conflict.
 */
function expectedCallbackDigest(
	record: KubernetesLaunchRecord | null,
	generation: number,
	handoff: CallbackHandoff | null,
): string | undefined {
	const recorded = recordForGeneration(record, generation)?.callbackDigest;
	const enrolled = handoff?.digest;
	if (recorded !== undefined && enrolled !== undefined && recorded !== enrolled) {
		throw new ProviderProtocolError(
			"conflict",
			`the launch record holds callback digest ${recorded} but the handoff enrolls ${enrolled}; the credential for generation ${generation} changed`,
		);
	}
	return enrolled ?? recorded;
}

// ---------------------------------------------------------------------------
// Shared op plumbing
// ---------------------------------------------------------------------------

function ok(
	handle: string,
	observedState: ProviderObserved,
	kubernetes: KubernetesObserved,
	extra?: { startedAt?: number },
): ProviderResponse {
	return {
		ok: true,
		providerProto: OMP_PROVIDER_PROTO,
		handle,
		observed: observedState,
		kubernetes,
		...extra,
	};
}

function err(
	code: Exclude<ProviderErrorCode, "timeout">,
	message: string,
	retryable: boolean,
): ProviderResponse {
	return {
		ok: false,
		providerProto: OMP_PROVIDER_PROTO,
		error: { code, message, retryable },
	};
}

/** Protocol observation: object API uids by kind, null when absent. */
function observed(
	namespaceUid: string,
	pod: Record<string, unknown> | null,
	pvc: Record<string, unknown> | null,
): KubernetesObserved {
	const podUid = pod === null ? "" : objectMeta(pod).uid;
	const pvcUid = pvc === null ? "" : objectMeta(pvc).uid;
	return {
		namespaceUid,
		podUid: podUid === "" ? null : podUid,
		pvcUid: pvcUid === "" ? null : pvcUid,
	};
}

/** Uniform refusal for an object this workspace may not touch. */
function refuseObject(
	cfg: KubernetesConfig,
	kind: "pod" | "persistentvolumeclaim" | "configmap",
	name: string,
	reason: string,
	what: string,
): ProviderResponse {
	const noun = kind === "pod" ? "pod" : kind === "configmap" ? "configmap" : "claim";
	return err(
		"conflict",
		`${noun} ${cfg.namespace}/${name} failed the workspace identity check: it ${reason}; refusing to ${what} it. If it belongs to another generation of this workspace, stop that generation first. Inspect it manually: kubectl --context <ctx> -n ${cfg.namespace} describe ${kind} ${name}`,
		false,
	);
}

/**
 * Final namespace fence shared by every operation that reports an outcome
 * after touching objects: a namespace deleted or replaced mid-operation must
 * surface as a conflict, never a stale success.
 */
function namespaceReplaced(
	cfg: KubernetesConfig,
	observedUid: string | null,
	what: string,
): ProviderResponse | null {
	if (observedUid === null) {
		return err(
			"conflict",
			`the bound namespace ${cfg.namespace} disappeared during ${what} (pinned uid ${cfg.namespaceUid}); the resources are retained for inspection`,
			false,
		);
	}
	if (observedUid !== cfg.namespaceUid) {
		return err(
			"conflict",
			`namespace ${cfg.namespace} was replaced during ${what} (uid ${cfg.namespaceUid} -> ${observedUid}); the resources are retained for inspection`,
			false,
		);
	}
	return null;
}

/** Map a kubectl-level or protocol failure to the typed vocabulary. */
function kubeFailure(cause: unknown, what: string): ProviderResponse {
	if (cause instanceof KubePreconditionError) {
		return err("conflict", cause.message, false);
	}
	if (cause instanceof KubeCallError) {
		const text = cause.result.stderr;
		if (
			/ENOENT|no such file or directory|executable file not found|not found in \$PATH|Executable not found/i.test(
				text,
			)
		) {
			return err(
				"unavailable",
				`kubectl is not available: ${text.trim()}; install kubectl (>= 1.27) or set OMP_KUBE_BIN`,
				false,
			);
		}
		if (
			/exec timeout|i\/o timeout|connection refused|Unable to connect|TLS handshake/i.test(text)
		) {
			return err(
				"unavailable",
				`kubernetes API unreachable for the configured context: ${cause.message}`,
				true,
			);
		}
		if (/forbidden|Unauthorized/i.test(text)) {
			return err(
				"unavailable",
				`${what}: insufficient RBAC in the profile namespace: ${cause.message}; ask the operator to grant pods/persistentvolumeclaims get|create|delete`,
				false,
			);
		}
		return err("unavailable", `${what}: ${cause.message}`, true);
	}
	if (cause instanceof ProviderProtocolError) {
		return err(cause.code === "timeout" ? "internal" : cause.code, cause.message, cause.retryable);
	}
	return err("internal", `${what}: ${String(cause)}`, false);
}

/**
 * Refresh the baseline ConfigMap immediately before a Pod that mounts it is
 * created. The object is workspace-scoped (one name per workspace, like the
 * Pod), so a previous generation's copy must be replaced rather than reused:
 * the operator's agent config may have changed since. The old object is
 * deleted through the uid-preconditioned path, its absence is PROVEN before
 * the replacement is created (a finalizer keeps deletion asynchronous, and the
 * API rejects a duplicate CREATE), and only then is the new one created.
 */
async function ensureBaselineConfigMap(
	exec: KubeExec,
	cfg: KubernetesConfig,
	request: ProviderRequest,
	identity: KubernetesObjectIdentity,
	ownership: WorkspaceOwnership,
	waitMs: number,
): Promise<void> {
	if (request.baseline === undefined) return;
	const name = baselineConfigMapName(cfg);
	const existing = await kubeGet(exec, cfg, "configmap", name);
	if (existing !== null) {
		// Same identity discipline as the Pod and PVC: an object on this
		// workspace's deterministic name that is not provably ours is never
		// replaced, so a name collision cannot destroy someone else's data.
		const reason = ownershipReason("configmap", objectMeta(existing), ownership);
		if (reason !== null) {
			throw new KubePreconditionError(
				`configmap ${cfg.namespace}/${name} failed the workspace identity check: it ${reason}; refusing to replace it. Inspect it manually: kubectl --context <ctx> -n ${cfg.namespace} describe configmap ${name}`,
			);
		}
		await kubeDelete(exec, cfg, "configmap", name, `configmap ${name}`, objectMeta(existing).uid);
		if (!(await waitGone(exec, cfg, "configmap", name, waitMs))) {
			throw new KubePreconditionError(
				`configmap ${name} did not disappear within ${waitMs}ms (finalizers?); retry ensure-running`,
			);
		}
	}
	await kubeCreate(
		exec,
		cfg,
		buildBaselineConfigMapManifest(cfg, request, identity),
		`configmap ${name}`,
	);
}

// ---------------------------------------------------------------------------
// Workspace lock
// ---------------------------------------------------------------------------

/**
 * Take the hardened per-workspace lock, waiting (bounded) for a peer that
 * holds it. While waiting, `onPeer` may report the peer's live observation
 * (bwrap-style: the concurrent invocation that owns the lock publishes a
 * record, and its Pod is the workspace) so a retry converges on it instead of
 * conflicting. A lock still held at the deadline yields `timeout`.
 */
type LockAcquisition =
	| { kind: "acquired"; lock: FileLock }
	| { kind: "peer"; response: ProviderResponse }
	| { kind: "timeout" };

async function acquireWorkspaceLock(
	stateDir: string,
	waitMs: number,
	onPeer: () => Promise<ProviderResponse | null>,
): Promise<LockAcquisition> {
	mkdirSync(stateDir, { recursive: true });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			return {
				kind: "acquired",
				lock: acquireFileLock(join(stateDir, LOCK_FILE), STATE_LOCK_HOLDER),
			};
		} catch (cause) {
			if (!(cause instanceof LockHeldError)) throw cause;
		}
		const peer = await onPeer();
		if (peer !== null) return { kind: "peer", response: peer };
		if (Date.now() >= deadline) return { kind: "timeout" };
		await delay(POLL_INTERVAL_MS);
	}
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface OpDeps {
	exec: KubeExec;
	env: Record<string, string | undefined>;
	ensureWaitMs: number;
	stopWaitMs: number;
	deleteWaitMs: number;
	lockWaitMs: number;
}

function defaultDeps(): OpDeps {
	return {
		exec: defaultKubeExec,
		env: process.env,
		...readKubernetesWaits(process.env),
	};
}

/** Everything validated before an operation touches an object, plus the lock. */
interface OpContext {
	request: ProviderRequest;
	cfg: KubernetesConfig;
	/** Expected ownership values for the requested generation. */
	ownership: WorkspaceOwnership;
	handle: string;
	/** Provider state for this workspace, any generation. */
	record: KubernetesLaunchRecord | null;
	/** The record's state for the requested generation, when it describes it. */
	recorded: KubernetesLaunchRecord | null;
	/** Claim uid fenced across generations (the claim outlives a Pod). */
	recordedPvcUid: string | null;
	/** Callback handoff; non-null only for a launch (or a matching handoff). */
	handoff: CallbackHandoff | null;
}

/** Build the expected ownership values (may throw on a digest disagreement). */
function workspaceOwnership(
	request: ProviderRequest,
	cfg: KubernetesConfig,
	record: KubernetesLaunchRecord | null,
	handoff: CallbackHandoff | null,
): WorkspaceOwnership {
	const recorded = recordForGeneration(record, request.generation);
	const callbackDigest = expectedCallbackDigest(record, request.generation, handoff);
	return {
		workspaceId: request.workspaceId,
		profileId: request.profile.id,
		resourceIdentity: cfg.resourceIdentity,
		namespaceUid: cfg.namespaceUid,
		sourcePinDigest: cfg.sourcePinDigest,
		...(recorded?.workspaceToken !== undefined ? { providerToken: recorded.workspaceToken } : {}),
		...(callbackDigest !== undefined ? { callbackDigest } : {}),
	};
}

/**
 * Serialize and prepare one workspace operation: resolve and validate the
 * request (binding, source, pin, branch), read the callback handoff, take the
 * per-workspace lock (waiting for a peer), then read provider state and
 * confirm the bound namespace still carries its recorded uid. Returns a typed
 * failure response instead of throwing.
 */
async function withOpContext(
	request: ProviderRequest,
	deps: OpDeps,
	opts: { requireHandoff: boolean; peerProbe?: boolean },
	run: (ctx: OpContext) => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
	const what = request.op;

	let cfg: KubernetesConfig;
	try {
		cfg = resolveConfig(request, deps.env);
	} catch (cause) {
		return kubeFailure(cause, `${what} profile`);
	}

	// The private stateDir holds the handoff, the identity record, and the
	// lock; create it before the first read so a missing directory is a plain
	// "handoff absent" answer rather than a filesystem error.
	mkdirSync(request.stateDir, { recursive: true });

	let handoff: CallbackHandoff | null;
	try {
		handoff = readHandoff(
			request.stateDir,
			request.workspaceId,
			request.generation,
			opts.requireHandoff,
		);
	} catch (cause) {
		return kubeFailure(cause, `${what} callback enrollment`);
	}

	// Opaque handle: stable per workspace (binding) + generation.
	const handle = `k8s:${cfg.namespace}/${cfg.resourceName}:g${request.generation}`;
	let acquisition: LockAcquisition;
	try {
		acquisition = await acquireWorkspaceLock(request.stateDir, deps.lockWaitMs, () =>
			opts.peerProbe === true
				? peerRunningResponse(request, cfg, deps, handoff, handle)
				: Promise.resolve(null),
		);
	} catch (cause) {
		return kubeFailure(cause, `${what} workspace lock`);
	}
	if (acquisition.kind === "peer") return acquisition.response;
	if (acquisition.kind === "timeout") {
		return err(
			"conflict",
			`another provider operation for ${request.workspaceId} still holds the workspace lock after ${deps.lockWaitMs}ms; retry once it finishes`,
			true,
		);
	}
	const lock = acquisition.lock;

	try {
		const record = readRecord(request.stateDir);
		const mismatch = recordMismatch(record, cfg, request);
		if (mismatch !== null) return err("conflict", mismatch, false);
		const ownership = workspaceOwnership(request, cfg, record, handoff);

		const namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		if (namespaceUid === null) {
			return err(
				"conflict",
				`the bound namespace ${cfg.namespace} no longer exists (pinned uid ${cfg.namespaceUid}); the workspace's resources are gone. Re-register the workspace against an operator-prepared namespace`,
				false,
			);
		}
		if (namespaceUid !== cfg.namespaceUid) {
			return err(
				"conflict",
				`namespace ${cfg.namespace} was replaced (uid ${cfg.namespaceUid} -> ${namespaceUid}); the binding is fixed at registration and the old resources are gone. Re-register the workspace`,
				false,
			);
		}

		return await run({
			request,
			cfg,
			ownership,
			handle,
			record,
			recorded: recordForGeneration(record, request.generation),
			recordedPvcUid: record?.pvcUid ?? null,
			handoff,
		});
	} catch (cause) {
		return kubeFailure(cause, what);
	} finally {
		lock.release();
	}
}

/**
 * A peer holds the lock: watch for the live record it publishes (bwrap-style)
 * and, when its Pod is owned by this workspace and Running, report that
 * observation instead of waiting out the lock and conflicting. A Pod that
 * exists but is NOT proven running (a Pending launch: created, no container
 * yet) is reported as a typed retryable failure, never as `running`: an ok
 * response would let the fleet persist this generation as authorized for a
 * workspace with no runtime and no daemon. Anything else is not evidence, so
 * the wait continues.
 */
async function peerRunningResponse(
	request: ProviderRequest,
	cfg: KubernetesConfig,
	deps: OpDeps,
	handoff: CallbackHandoff | null,
	handle: string,
): Promise<ProviderResponse | null> {
	try {
		const record = readRecord(request.stateDir);
		const recorded = recordForGeneration(record, request.generation);
		if (recorded === null) return null;
		if (recordMismatch(record, cfg, request) !== null) return null;
		const pod = await kubeGet(deps.exec, cfg, "pod", cfg.resourceName);
		if (pod === null) return null;
		const meta = objectMeta(pod);
		if (meta.deletionTimestamp !== null) return null;
		const phase = podPhase(pod);
		if (phase !== "Running" && phase !== "Pending") return null;
		const pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", cfg.resourceName);
		if (pvc === null) return null;
		const ownership = workspaceOwnership(request, cfg, record, handoff);
		if (
			ownershipReason("pod", meta, ownership, {
				generation: request.generation,
				objectUid: recorded.podUid,
			}) !== null
		) {
			return null;
		}
		if (
			ownershipReason("persistentvolumeclaim", pvcMeta(pvc), ownership, {
				objectUid: record?.pvcUid ?? null,
			}) !== null
		) {
			return null;
		}
		const namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		if (namespaceUid !== cfg.namespaceUid) return null;
		if (phase !== "Running") {
			// Owned objects, no container yet: the peer's launch is mid-flight,
			// so the workspace is not running. A failure envelope persists
			// nothing and sends the next attempt through the ordinary
			// inspect-first path, which adopts or replaces this very Pod.
			return err(
				"unavailable",
				`another provider operation for ${request.workspaceId} holds the workspace lock and its pod ${cfg.namespace}/${cfg.resourceName} is still ${phase} (no container has run); retry ensure-running once that launch settles`,
				true,
			);
		}
		return ok(handle, "running", observed(cfg.namespaceUid, pod, pvc), {
			startedAt: recorded.startedAt,
		});
	} catch {
		// A peer probe is best-effort evidence: any failure means "keep waiting".
		return null;
	}
}

/** Launch inputs stamped into a Pod/PVC and its record. */
interface LaunchInputs {
	/** Provider launch token (API-side analogue of bwrap's argv token). */
	workspaceToken: string;
	/** Callback credential digest (sha256 of the decoded credential). */
	callbackDigest: string;
	/** Previous record, for createdAt continuity. */
	record: KubernetesLaunchRecord | null;
	/** API uid of the Pod this launch is anchored to, when one was observed. */
	podUid: string | null;
	/** API uid of the claim that must be mounted (validated or just created). */
	pvcUid: string | null;
}

/** Observed uids persisted alongside a launch. */
interface LaunchObservation {
	podUid: string | null;
	pvcUid: string | null;
	startedAt?: number;
}

function launchRecord(
	request: ProviderRequest,
	cfg: KubernetesConfig,
	launch: LaunchInputs,
	observation: LaunchObservation,
): KubernetesLaunchRecord {
	return {
		version: 1,
		workspaceId: request.workspaceId,
		generation: request.generation,
		workspaceToken: launch.workspaceToken,
		namespace: cfg.namespace,
		namespaceUid: cfg.namespaceUid,
		resourceIdentity: cfg.resourceIdentity,
		podName: cfg.resourceName,
		pvcName: cfg.resourceName,
		podUid: observation.podUid,
		pvcUid: observation.pvcUid,
		sourceRemote: cfg.sourceRemote,
		revision: cfg.revision,
		branch: cfg.branch,
		sourcePinDigest: cfg.sourcePinDigest,
		callbackDigest: launch.callbackDigest,
		createdAt: launch.record?.createdAt ?? Date.now(),
		...(observation.startedAt !== undefined ? { startedAt: observation.startedAt } : {}),
	};
}

/**
 * ensure-running: idempotent create-or-adopt. Every input is validated BEFORE
 * anything is created or replaced: the request tuple (binding, source, pin,
 * branch), the callback handoff, and any Pod/PVC already on the deterministic
 * name. Reuse an owned running Pod and a retained PVC; adopt resources after a
 * lost provider record only when their persisted identities (labels,
 * annotations, pin digest, credential digest, namespace uid) agree. A live Pod
 * for a DIFFERENT generation, a foreign object, or a terminating predecessor is
 * `conflict`; never a second writer on the claim.
 */
async function opEnsureRunning(
	rawRequest: ProviderRequest,
	deps: OpDeps,
): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: true, peerProbe: true }, async (ctx) => {
		const { cfg, recorded, recordedPvcUid } = ctx;
		const podName = cfg.resourceName;

		let pod: Record<string, unknown> | null;
		let pvc: Record<string, unknown> | null;
		try {
			pod = await kubeGet(deps.exec, cfg, "pod", podName);
			pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName);
		} catch (cause) {
			return kubeFailure(cause, "ensure-running");
		}

		if (pod !== null) {
			const meta = objectMeta(pod);
			const reason = ownershipReason("pod", meta, ctx.ownership, {
				generation: request.generation,
				objectUid: recorded?.podUid ?? null,
			});
			if (reason !== null) {
				return refuseObject(cfg, "pod", podName, reason, "reuse or replace");
			}
			if (pvc === null) {
				return err(
					"conflict",
					`pod ${cfg.namespace}/${podName} exists without its claim ${podName}; the volume identity is broken. Inspect the namespace manually before replacing either object`,
					false,
				);
			}
			const claimReason = ownershipReason("persistentvolumeclaim", pvcMeta(pvc), ctx.ownership, {
				objectUid: recordedPvcUid,
			});
			if (claimReason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", podName, claimReason, "attach");
			}
			if (meta.deletionTimestamp !== null) {
				return err(
					"conflict",
					`pod ${podName} is terminating; replacement waits for proven termination (retry ensure-running once it is gone)`,
					true,
				);
			}

			const token = recorded?.workspaceToken ?? meta.annotations[ANN_WORKSPACE_TOKEN] ?? "";
			const callbackDigest =
				recorded?.callbackDigest ?? meta.annotations[ANN_CALLBACK_DIGEST] ?? "";
			const launch: LaunchInputs = {
				workspaceToken: token,
				callbackDigest,
				record: ctx.record,
				podUid: meta.uid === "" ? null : meta.uid,
				pvcUid: objectMeta(pvc).uid === "" ? null : objectMeta(pvc).uid,
			};
			const phase = podPhase(pod);

			if (phase === "Failed" || phase === "Succeeded") {
				// Terminated corpse: provably not writing. Remove it and prove
				// absence before creating the replacement (same generation, same
				// token; the claim's init marker still guards preparation).
				try {
					await kubeDelete(
						deps.exec,
						cfg,
						"pod",
						podName,
						`pod ${podName} (terminal ${phase})`,
						meta.uid,
					);
				} catch (cause) {
					return kubeFailure(cause, "ensure-running");
				}
				let gone: boolean;
				try {
					gone = await waitGone(deps.exec, cfg, "pod", podName, deps.stopWaitMs);
				} catch (cause) {
					return kubeFailure(cause, "ensure-running");
				}
				if (!gone) {
					return err(
						"conflict",
						`terminated pod ${podName} did not disappear within ${deps.stopWaitMs}ms; retry ensure-running`,
						true,
					);
				}
				return await createPodAndWait(ctx, deps, launch);
			}

			// Pending or Running: anchor the record to the observed identity,
			// then wait for Running within the budget (image pulls are slow).
			const anchored = launchRecord(request, cfg, launch, {
				podUid: launch.podUid,
				pvcUid: launch.pvcUid,
				...(podStartTime(pod) !== undefined ? { startedAt: podStartTime(pod) } : {}),
			});
			writeRecord(request.stateDir, anchored);

			if (phase === "Running") {
				return await reportRunning(ctx, deps, launch);
			}
			let waited: PodRunningWait;
			try {
				waited = await waitPodRunning(deps.exec, cfg, podName, deps.ensureWaitMs);
			} catch (cause) {
				return kubeFailure(cause, "ensure-running");
			}
			if (waited.running) {
				return await reportRunning(ctx, deps, launch);
			}
			if (waited.phase === "Failed" || waited.phase === "Succeeded") {
				return err(
					"unavailable",
					`pod ${podName} terminated during start (${waited.reason ?? waited.phase}); inspect with kubectl --context <ctx> -n ${cfg.namespace} logs ${podName}; the next ensure-running replaces the terminated pod`,
					false,
				);
			}
			const reason2 = waited.reason;
			const remediation =
				reason2 !== null && /ImagePull|ErrImage/i.test(reason2)
					? `image ${cfg.image} cannot be pulled (${reason2}); make the session-runtime image available to the cluster`
					: `pod still ${waited.phase} after ${deps.ensureWaitMs}ms (${reason2 ?? "no container reason"}); retry ensure-running to adopt it`;
			return err("unavailable", remediation, true);
		}

		// Pod absent: create (or replace) it. The claim is ensured first, and a
		// same-generation record means the Pod vanished externally: recreate it
		// with the recorded token and digest so the daemon keeps its pin.
		const token = recorded?.workspaceToken ?? randomUUID().replace(/-/g, "");
		const callbackDigest = ctx.ownership.callbackDigest ?? ctx.handoff?.digest;
		if (callbackDigest === undefined) {
			return err(
				"unavailable",
				`no callback credential digest is available for workspace ${request.workspaceId} generation ${request.generation}; the fleet must enroll and hand off the credential before ensure-running`,
				false,
			);
		}

		let pvcUid: string | null;
		if (pvc !== null) {
			const claim = pvcMeta(pvc);
			const reason = ownershipReason("persistentvolumeclaim", claim, ctx.ownership, {
				objectUid: recordedPvcUid,
			});
			if (reason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", podName, reason, "attach");
			}
			if (claim.deletionTimestamp !== null) {
				return err(
					"conflict",
					`claim ${podName} is terminating; never create a Pod against a claim being deleted (retry once it is gone)`,
					true,
				);
			}
			// PVC spec is immutable after creation: drift is an operator
			// decision, never silently recreated (which would destroy data).
			if (cfg.storageClass !== undefined && claim.storageClassName !== cfg.storageClass) {
				return err(
					"conflict",
					`existing claim ${podName} uses storageClass ${JSON.stringify(claim.storageClassName)}, profile requests ${JSON.stringify(cfg.storageClass)}; PVC spec is immutable, align the profile or migrate the claim deliberately`,
					false,
				);
			}
			if (claim.size !== undefined && claim.size !== cfg.storageSize) {
				return err(
					"conflict",
					`existing claim ${podName} requests ${claim.size}, profile requests ${cfg.storageSize}; PVC size changes need a deliberate volume expansion, not pod replacement`,
					false,
				);
			}
			if (!claim.accessModes.includes("ReadWriteOnce")) {
				return err(
					"conflict",
					`existing claim ${podName} has accessModes ${claim.accessModes.join(",")}, expected ReadWriteOnce`,
					false,
				);
			}
			pvcUid = claim.uid === "" ? null : claim.uid;
		} else {
			let created: Record<string, unknown> | null;
			try {
				created = await kubeCreate(
					deps.exec,
					cfg,
					buildPvcManifest(cfg, objectIdentity(ctx.ownership, token, callbackDigest)),
					`persistentvolumeclaim ${podName}`,
				);
			} catch (cause) {
				return kubeFailure(cause, "ensure-running");
			}
			const createdUid = created === null ? "" : objectMeta(created).uid;
			pvcUid = createdUid === "" ? null : createdUid;
		}

		const launch: LaunchInputs = {
			workspaceToken: token,
			callbackDigest,
			record: ctx.record,
			podUid: null,
			pvcUid,
		};
		return await createPodAndWait(ctx, deps, launch);
	});
}

/**
 * Create the workspace pod and wait for Running; shared by every ensure path.
 * The record is written as soon as the Pod's uid is observed and carries the
 * validated/created claim uid, so a crash or a stuck Pending Pod between create
 * and Running still leaves a fully re-anchorable identity (a lost claim uid
 * would let a retry adopt a same-named replacement claim).
 */
async function createPodAndWait(
	ctx: OpContext,
	deps: OpDeps,
	launch: LaunchInputs,
): Promise<ProviderResponse> {
	const { request, cfg } = ctx;
	const podName = cfg.resourceName;
	const identity = objectIdentity(ctx.ownership, launch.workspaceToken, launch.callbackDigest);

	try {
		// The mounted objects must exist before the Pod that references them,
		// or the kubelet cannot start the container.
		await ensureBaselineConfigMap(
			deps.exec,
			cfg,
			request,
			identity,
			ctx.ownership,
			deps.stopWaitMs,
		);
		await kubeCreate(
			deps.exec,
			cfg,
			buildPodManifest(cfg, request, identity, ctx.handoff?.env ?? {}),
			`pod ${podName}`,
		);
	} catch (cause) {
		return kubeFailure(cause, "ensure-running");
	}

	const created = await kubeGet(deps.exec, cfg, "pod", podName);
	const uid = created === null ? "" : objectMeta(created).uid;
	launch.podUid = uid === "" ? null : uid;
	writeRecord(
		request.stateDir,
		launchRecord(request, cfg, launch, { podUid: launch.podUid, pvcUid: launch.pvcUid }),
	);

	let waited: PodRunningWait;
	try {
		waited = await waitPodRunning(deps.exec, cfg, podName, deps.ensureWaitMs);
	} catch (cause) {
		return kubeFailure(cause, "ensure-running");
	}
	if (waited.running) {
		return await reportRunning(ctx, deps, launch);
	}
	const reason = waited.reason;
	const remediation =
		reason !== null && /ImagePull|ErrImage/i.test(reason)
			? `image ${cfg.image} cannot be pulled (${reason}); make the session-runtime image available to the cluster`
			: `pod ${podName} did not reach Running (${waited.phase}${reason === null ? "" : `: ${reason}`}); the identity is recorded, retry ensure-running to adopt it`;
	return err("unavailable", remediation, waited.phase !== "Failed" && waited.phase !== "Succeeded");
}

/**
 * Finish a running ensure: re-observe both objects, re-run the ownership
 * validator against the exact launch uids, require the claim to remain
 * present, recheck the bound namespace uid, persist the observed uids, and
 * report. An object replaced during the readiness wait (or a replaced
 * namespace) is a conflict, never a silent success: the record must never
 * acquire an identity the launch did not validate.
 */
async function reportRunning(
	ctx: OpContext,
	deps: OpDeps,
	launch: LaunchInputs,
): Promise<ProviderResponse> {
	const { request, cfg, handle } = ctx;
	let objects: ObservedObjects;
	try {
		objects = await observeObjects(deps.exec, cfg);
	} catch (cause) {
		return kubeFailure(cause, "ensure-running");
	}
	const namespaceFailure = namespaceReplaced(cfg, objects.namespaceUid, "ensure-running");
	if (namespaceFailure !== null) return namespaceFailure;
	if (objects.pod === null) {
		return err(
			"unavailable",
			`pod ${cfg.resourceName} disappeared during ensure-running; retry to recreate it`,
			true,
		);
	}
	const meta = objectMeta(objects.pod);
	if (meta.uid === "") {
		return err("internal", `pod ${cfg.namespace}/${cfg.resourceName} carries no API uid`, false);
	}
	const podReason = ownershipReason("pod", meta, ctx.ownership, {
		generation: request.generation,
		objectUid: launch.podUid,
	});
	if (podReason !== null) {
		return refuseObject(cfg, "pod", cfg.resourceName, podReason, "adopt");
	}
	if (objects.pvc === null) {
		return err(
			"conflict",
			`pod ${cfg.namespace}/${cfg.resourceName} exists without its claim ${cfg.resourceName}; the volume identity is broken`,
			false,
		);
	}
	const claimReason = ownershipReason(
		"persistentvolumeclaim",
		pvcMeta(objects.pvc),
		ctx.ownership,
		{
			objectUid: launch.pvcUid,
		},
	);
	if (claimReason !== null) {
		return refuseObject(cfg, "persistentvolumeclaim", cfg.resourceName, claimReason, "attach");
	}
	const startedAt = podStartTime(objects.pod) ?? launch.record?.startedAt;
	const record = launchRecord(request, cfg, launch, {
		podUid: meta.uid,
		pvcUid: objectMeta(objects.pvc).uid || null,
		...(startedAt !== undefined ? { startedAt } : {}),
	});
	writeRecord(request.stateDir, record);
	return ok(handle, "running", observed(objects.namespaceUid as string, objects.pod, objects.pvc), {
		startedAt: record.startedAt,
	});
}

/**
 * inspect: report the API-observed state. A foreign object, a claim that is
 * missing beside a live Pod, or a replaced namespace is a `conflict`; a Pod
 * of another generation is reported as-is (the fleet's replacement fence needs
 * to see the live generation before it stops it).
 */
async function opInspect(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: false }, async (ctx) => {
		const { cfg, handle, recorded, recordedPvcUid } = ctx;
		let objects: ObservedObjects;
		try {
			objects = await observeObjects(deps.exec, cfg);
		} catch (cause) {
			return kubeFailure(cause, "inspect");
		}
		const namespaceFailure = namespaceReplaced(cfg, objects.namespaceUid, "inspect");
		if (namespaceFailure !== null) return namespaceFailure;
		const namespaceUid = objects.namespaceUid as string;

		if (objects.pod !== null) {
			const meta = objectMeta(objects.pod);
			const reason = ownershipReason("pod", meta, ctx.ownership, {
				objectUid: recorded?.podUid ?? null,
			});
			if (reason !== null) {
				return refuseObject(cfg, "pod", cfg.resourceName, reason, "inspect");
			}
			if (objects.pvc === null) {
				return err(
					"conflict",
					`pod ${cfg.namespace}/${cfg.resourceName} exists without its claim ${cfg.resourceName}; the volume identity is broken`,
					false,
				);
			}
			const claimReason = ownershipReason(
				"persistentvolumeclaim",
				pvcMeta(objects.pvc),
				ctx.ownership,
				{ objectUid: recordedPvcUid },
			);
			if (claimReason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", cfg.resourceName, claimReason, "inspect");
			}
			const phase = podPhase(objects.pod);
			if (meta.deletionTimestamp === null && (phase === "Running" || phase === "Pending")) {
				return ok(handle, "running", observed(namespaceUid, objects.pod, objects.pvc), {
					startedAt: podStartTime(objects.pod) ?? recorded?.startedAt,
				});
			}
			return ok(handle, "stopped", observed(namespaceUid, objects.pod, objects.pvc), {
				startedAt: recorded?.startedAt,
			});
		}

		if (objects.pvc !== null) {
			const reason = ownershipReason("persistentvolumeclaim", pvcMeta(objects.pvc), ctx.ownership, {
				objectUid: recordedPvcUid,
			});
			if (reason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", cfg.resourceName, reason, "inspect");
			}
			// Compute gone, storage retained.
			return ok(handle, "stopped", observed(namespaceUid, null, objects.pvc), {
				startedAt: recorded?.startedAt,
			});
		}

		if (ctx.record !== null) {
			// Compute gone and storage gone, but the launch identity remains.
			return ok(handle, "stopped", observed(namespaceUid, null, null), {
				startedAt: recorded?.startedAt,
			});
		}
		return ok(handle, "missing", observed(namespaceUid, null, null));
	});
}

/**
 * stop: validate and delete the requested Pod, prove its absence, recheck the
 * bound namespace, and retain the claim (and the launch record). Pod absence is
 * success. Ownership comes from the binding plus the launch record, so stop
 * works with no callback handoff at all.
 */
async function opStop(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: false }, async (ctx) => {
		const { cfg, handle, recorded, recordedPvcUid } = ctx;
		const podName = cfg.resourceName;

		let pod: Record<string, unknown> | null;
		let pvc: Record<string, unknown> | null;
		try {
			pod = await kubeGet(deps.exec, cfg, "pod", podName);
			pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName);
		} catch (cause) {
			return kubeFailure(cause, "stop");
		}

		if (pod === null) {
			// Idempotent: the claim and the record are retained by design, and
			// absence is the requested state. A retained claim is reported only
			// when it is this workspace's own (a foreign one is never touched).
			const claimOwned =
				pvc !== null &&
				ownershipReason("persistentvolumeclaim", pvcMeta(pvc), ctx.ownership, {
					objectUid: recordedPvcUid,
				}) === null;
			let namespaceUid: string | null;
			try {
				namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
			} catch (cause) {
				return kubeFailure(cause, "stop");
			}
			const namespaceFailure = namespaceReplaced(cfg, namespaceUid, "stop");
			if (namespaceFailure !== null) return namespaceFailure;
			return ok(handle, "stopped", observed(namespaceUid as string, null, claimOwned ? pvc : null));
		}

		const meta = objectMeta(pod);
		const reason = ownershipReason("pod", meta, ctx.ownership, {
			generation: request.generation,
			objectUid: recorded?.podUid ?? null,
		});
		if (reason !== null) {
			return refuseObject(cfg, "pod", podName, reason, "stop");
		}
		if (pvc !== null) {
			const claimReason = ownershipReason("persistentvolumeclaim", pvcMeta(pvc), ctx.ownership, {
				objectUid: recordedPvcUid,
			});
			if (claimReason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", podName, claimReason, "stop");
			}
		}

		try {
			await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName}`, meta.uid);
		} catch (cause) {
			return kubeFailure(cause, "stop");
		}

		// Proof, never assumption: the Pod must be gone from the API before we
		// report stopped and any replacement may write the claim.
		let gone: boolean;
		try {
			gone = await waitGone(deps.exec, cfg, "pod", podName, deps.stopWaitMs);
		} catch (cause) {
			return kubeFailure(cause, "stop");
		}
		if (!gone) {
			return err(
				"conflict",
				`could not prove generation ${request.generation} terminated: pod ${podName} still exists after ${deps.stopWaitMs}ms`,
				true,
			);
		}
		if (ctx.record !== null) {
			writeRecord(request.stateDir, { ...ctx.record, stoppedAt: Date.now() });
		}
		let namespaceUid: string | null;
		try {
			namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		} catch (cause) {
			return kubeFailure(cause, "stop");
		}
		const namespaceFailure = namespaceReplaced(cfg, namespaceUid, "stop");
		if (namespaceFailure !== null) return namespaceFailure;
		return ok(handle, "stopped", observed(namespaceUid as string, null, pvc));
	});
}

/**
 * delete: every PRESENT object is validated before the first deletion, each
 * deletion goes through the API uid precondition, and absence is proven before
 * success. Repeated deletion succeeds once every object is absent, and the
 * bound namespace is re-observed before the success is reported. The stateDir
 * (and the lock this operation holds) is left in place: the fleet removes
 * provider state after it confirms the deletion (P3.7).
 */
async function opDelete(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: false }, async (ctx) => {
		const { cfg, handle, recorded, recordedPvcUid } = ctx;
		const podName = cfg.resourceName;

		let pod: Record<string, unknown> | null;
		let pvc: Record<string, unknown> | null;
		let baseline: Record<string, unknown> | null;
		try {
			pod = await kubeGet(deps.exec, cfg, "pod", podName);
			pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName);
			baseline = await kubeGet(deps.exec, cfg, "configmap", baselineConfigMapName(cfg));
		} catch (cause) {
			return kubeFailure(cause, "delete");
		}

		let namespaceUid: string | null;
		try {
			namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		} catch (cause) {
			return kubeFailure(cause, "delete");
		}
		const namespaceFailure = namespaceReplaced(cfg, namespaceUid, "delete");
		if (namespaceFailure !== null) return namespaceFailure;

		if (pod === null && pvc === null && baseline === null) {
			// Every object is already absent: the requested state is reached.
			return ok(handle, "missing", observed(namespaceUid as string, null, null));
		}

		// Validate EVERY present object BEFORE the first deletion.
		let podUid = "";
		if (pod !== null) {
			const meta = objectMeta(pod);
			const reason = ownershipReason("pod", meta, ctx.ownership, {
				generation: request.generation,
				objectUid: recorded?.podUid ?? null,
			});
			if (reason !== null) {
				return refuseObject(cfg, "pod", podName, reason, "delete");
			}
			if (ctx.record === null) {
				// Ownership labels were verified, but without any state record
				// deletion is authorized only when the Pod is provably terminal
				// (it cannot be writing).
				const phase = podPhase(pod);
				if (phase !== "Failed" && phase !== "Succeeded") {
					return err(
						"conflict",
						`pod ${podName} has no identity record and is ${phase}; run stop first or wait for the pod to terminate`,
						false,
					);
				}
			}
			podUid = meta.uid;
		}
		let pvcUid = "";
		if (pvc !== null) {
			const claim = pvcMeta(pvc);
			const reason = ownershipReason("persistentvolumeclaim", claim, ctx.ownership, {
				objectUid: recordedPvcUid,
			});
			if (reason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", podName, reason, "delete");
			}
			pvcUid = claim.uid;
		}
		let baselineUid = "";
		if (baseline !== null) {
			const meta = objectMeta(baseline);
			const reason = ownershipReason("configmap", meta, ctx.ownership);
			if (reason !== null) {
				return refuseObject(cfg, "configmap", baselineConfigMapName(cfg), reason, "delete");
			}
			baselineUid = meta.uid;
		}

		try {
			if (pod !== null) {
				await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName}`, podUid);
				if (!(await waitGone(deps.exec, cfg, "pod", podName, deps.deleteWaitMs))) {
					return err(
						"conflict",
						`delete: could not prove the pod terminated (pod ${podName} still exists); retry delete`,
						true,
					);
				}
			}
			if (pvc !== null) {
				await kubeDelete(
					deps.exec,
					cfg,
					"persistentvolumeclaim",
					podName,
					`claim ${podName}`,
					pvcUid,
				);
				if (
					!(await waitGone(deps.exec, cfg, "persistentvolumeclaim", podName, deps.deleteWaitMs))
				) {
					return err(
						"conflict",
						`claim ${podName} did not disappear in time (finalizers?); retry delete`,
						true,
					);
				}
			}
			// Last: the baseline ConfigMap never carried a claim on the
			// volume, so a failure above leaves it in place for the retry
			// rather than orphaning the objects that still exist.
			if (baseline !== null) {
				const name = baselineConfigMapName(cfg);
				await kubeDelete(deps.exec, cfg, "configmap", name, `configmap ${name}`, baselineUid);
				if (!(await waitGone(deps.exec, cfg, "configmap", name, deps.deleteWaitMs))) {
					return err("conflict", `configmap ${name} did not disappear in time; retry delete`, true);
				}
			}
		} catch (cause) {
			return kubeFailure(cause, "delete");
		}

		let finalNamespaceUid: string | null;
		try {
			finalNamespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		} catch (cause) {
			return kubeFailure(cause, "delete");
		}
		const finalNamespaceFailure = namespaceReplaced(cfg, finalNamespaceUid, "delete");
		if (finalNamespaceFailure !== null) return finalNamespaceFailure;
		return ok(handle, "missing", observed(finalNamespaceUid as string, null, null));
	});
}

// ---------------------------------------------------------------------------
// Protocol entry
// ---------------------------------------------------------------------------

const OPS: Record<
	ProviderRequest["op"],
	(r: ProviderRequest, deps: OpDeps) => Promise<ProviderResponse>
> = {
	"ensure-running": opEnsureRunning,
	inspect: opInspect,
	stop: opStop,
	delete: opDelete,
};

/** Exported for offline contract tests; the fleet entry is main() below. */
export async function runOp(
	request: ProviderRequest,
	deps?: Partial<OpDeps>,
): Promise<ProviderResponse> {
	// Version fence at the dispatch point too, so an in-process caller (or a
	// future embedder) cannot bypass the wire validator's check.
	if (request.providerProto !== OMP_PROVIDER_PROTO) {
		return err(
			"invalid_request",
			`request carries providerProto ${JSON.stringify(request.providerProto ?? null)}; this provider implements ${OMP_PROVIDER_PROTO}`,
			false,
		);
	}
	return OPS[request.op](request, { ...defaultDeps(), ...deps });
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length !== 1 || !(OPS as Record<string, unknown>)[argv[0]]) {
		process.stderr.write(
			`kubernetes-provider: expected <ensure-running|inspect|stop|delete> with one JSON request on stdin, got argv ${argv.join(" ")}\n`,
		);
		return 1;
	}

	let raw = "";
	for await (const chunk of process.stdin as AsyncIterable<string>) {
		raw += chunk;
		if (raw.length > 1024 * 1024) {
			process.stderr.write("kubernetes-provider: request exceeds 1 MiB\n");
			return 1;
		}
	}

	let response: ProviderResponse;
	try {
		const request = parseProviderRequest(raw);
		if (argv[0] !== request.op) {
			throw ProviderProtocolError.invalidRequest(
				`argv op ${argv[0]} does not match request op ${request.op}`,
			);
		}
		response = await runOp(request);
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			response = {
				ok: false,
				providerProto: OMP_PROVIDER_PROTO,
				error: { code: cause.code, message: cause.message, retryable: cause.retryable },
			};
		} else {
			response = {
				ok: false,
				providerProto: OMP_PROVIDER_PROTO,
				error: { code: "internal", message: `provider failed: ${String(cause)}`, retryable: false },
			};
		}
	}

	process.stdout.write(`${JSON.stringify(response)}\n`);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
