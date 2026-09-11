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
 * every successful kubernetes response also carries
 * `kubernetes: {namespaceUid, podUid, pvcUid}` (null = object absent, and the
 * namespace uid the operation actually observed).
 *
 * Resource model (one workspace = one Pod + one PVC, nothing else):
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
 * - A single Pod mounts the claim at /workspace and runs the session
 *   daemon with `restartPolicy: "Never"` so identity is never masked by a
 *   kubelet restart. No Service/Ingress is created: the daemon dials the
 *   fleet callback pair outbound (P5.3: no inbound pod service required).
 * - No cluster mutation beyond these two namespaced objects, ever. The
 *   provider never creates namespaces, RBAC, StorageClasses, Secrets, or
 *   NetworkPolicies.
 *
 * Durable identity (never PID-only; the pod has no host pid):
 * - The provider records its launch identity at
 *   `<stateDir>/provider.k8s.json` = {version, workspaceId, generation,
 *   workspaceToken, namespace, namespaceUid, resourceIdentity, podName,
 *   pvcName, podUid, pvcUid, sourceRemote, revision, branch,
 *   sourcePinDigest, callbackDigest, createdAt, startedAt?, stoppedAt?}.
 *   `workspaceToken` is the API-side analogue of bwrap's argv token.
 * - ONE ownership validator (`ownershipReason`) is shared by all four
 *   operations: managed-by / part-of labels, the workspace-id annotation, the
 *   full profile-id annotation plus its label, the resource-id label, the
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
 *   so a retained volume can never silently serve a different pin. The
 *   volume-resident preparation marker (`.omp-workspace-init.json`) is
 *   validated in-pod by prepare-workspace/prepare-inpod after the PVC is
 *   mounted; the provider validates the same tuple (workspace, source, pin,
 *   branch) from the request and from Kubernetes metadata, because the claim
 *   is not mounted on the fleet host and no shared marker reader is exported.
 * - `stop` deletes the pod and PROVES the requested generation terminated
 *   by polling the API until the pod is gone; an uncertain predecessor is
 *   `conflict` (retryable). The PVC is retained. Stop works with no callback
 *   handoff: ownership comes from the resource binding and the launch record.
 * - `delete` validates every present object before the FIRST deletion,
 *   deletes with a fresh-GET uid barrier (kubectl has no portable uid
 *   precondition flag), waits for absence, and leaves the stateDir for the
 *   fleet to remove after confirmed deletion (P3.7).
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
 *   requests and limits → Guaranteed QoS), `profile.storage {class, size}`
 *   (class optional = cluster default; size defaults to 10 Gi).
 * - model/tool credentials: `profile.secretRefs` maps ENV name →
 *   `<secretName>/<key>`, injected as native `secretKeyRef` env. Secrets
 *   must pre-exist; they are verified by preflight, never created.
 * - callback enrollment: the fleet-written `callback-env.json` handoff is
 *   injected as pod env.
 * - in-pod preparation: the fleet resolves the pin and passes it through the
 *   request fields `source.remote`/`revision`/`branch`; the provider injects
 *   them as OMP_PREP_* env and the image entrypoint initializes a NEW
 *   workspace volume once (verified marker), so replacement pods never
 *   re-clone or re-resolve. `source.local` is a fleet-host path and is
 *   rejected for kubernetes profiles.
 *
 * Missing prerequisites fail `unavailable`/`invalid_request` with
 * actionable remediation. There is no auto-install, no RBAC/namespace
 * creation, and no ephemeral/emptyDir fallback for workspace storage.
 *
 * Bundle-safety: imports only node builtins and shared/*; no import.meta
 * path reads, no self-respawn. `kubectl` argv arrays only, never a shell.
 */

import type { Subprocess } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLock, LockHeldError } from "../../shared/file-lock";
import type { FileLock } from "../../shared/file-lock";
import {
	computeSourcePinDigest,
	OMP_PROVIDER_PROTO,
	ProviderProtocolError,
	parseProviderRequest,
	RESOURCE_IDENTITY_RE,
	validateKubernetesSource,
	type KubernetesBinding,
	type KubernetesObserved,
	type ProviderObserved,
	type ProviderProfile,
	type ProviderRequest,
	type ProviderResponse,
} from "../../shared/provider-protocol";
import type { ProviderErrorCode } from "../../shared/provider-protocol";
import { CALLBACK_ENV_FILE, readCallbackEnvFile } from "../callback-env";
import type { CallbackEnvRecord } from "../callback-env";
import { RESERVED_SECRET_ENV_KEYS } from "../bwrap-args";
import { PrepareWorkspaceError, validateWorkspaceRef } from "../prepare-workspace";
import type { PreflightCheck, PreflightResult } from "../preflight";

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

/** Exact positive decimal generation label ("01", "1x", "+1", "1.0" rejected). */
const GENERATION_LABEL_RE = /^[1-9][0-9]*$/;

/** In-pod workspace volume layout (frozen "Preparation layout"). */
const POD_WORKSPACE_ROOT = "/workspace";
const POD_CHECKOUT_DIR = `${POD_WORKSPACE_ROOT}/.checkout`;
const POD_HOME_DIR = `${POD_WORKSPACE_ROOT}/.home`;

/**
 * Sanitized agent-behavior baseline delivery (P5.5). The fleet ships the
 * documents in the request; they are materialized as a ConfigMap mounted
 * read-only here, and the image's in-pod preparation seeds
 * `.home/agent/{config.yml,models.yml}` from it before the daemon starts.
 * The mount is a delivery channel for the seed, never runtime config: the
 * sandbox reads the copies under its own home.
 */
const POD_BASELINE_DIR = "/opt/omp-web/baseline";
/** Env key the in-pod seed reads (runtime/sandbox-baseline.ts source override). */
const BASELINE_CONFIG_ENV_KEY = "OMP_SANDBOX_BASELINE_CONFIG";
/** ConfigMap name suffix; the object is workspace-scoped like the Pod/PVC. */
const BASELINE_CONFIGMAP_SUFFIX = "-baseline";
/** ConfigMap data keys, which become the file names under {@link POD_BASELINE_DIR}. */
const BASELINE_CONFIG_KEY = "config.yml";
const BASELINE_MODELS_KEY = "models.yml";

const DEFAULT_STORAGE_SIZE = "10Gi";
/** Runtime uid/gid the pod runs as (the PVC's fsGroup). */
const RUNTIME_UID = 10001;

/** Env key for the image-owned SSH wrapper (runtime/image/git-ssh.sh). */
const GIT_SSH_COMMAND_ENV_KEY = "GIT_SSH_COMMAND";
/** Absolute wrapper path inside the session-runtime image (see the Containerfile). */
const POD_GIT_SSH_COMMAND = "/opt/omp-web/runtime/image/git-ssh.sh";

/** Kubectl per-call API timeout (flag) and spawn-level kill budget. */
const KUBE_REQUEST_TIMEOUT = "15s";
const KUBE_EXEC_KILL_MS = 60_000;
/** kubectl payload cap; provider protocol envelopes stay capped separately. */
const KUBE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/** Wait budgets (env-tunable; pods can pull images on cold nodes). */
const ENSURE_WAIT_MS_DEFAULT = 120_000;
const STOP_WAIT_MS_DEFAULT = 60_000;
const DELETE_WAIT_MS_DEFAULT = 60_000;
const POLL_INTERVAL_MS = 500;
/** How long an operation waits for a peer that holds the workspace lock. */
const LOCK_WAIT_MS_DEFAULT = 30_000;

function envMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Label/annotation vocabulary. Every object the provider creates carries
// the managed-by label; the provider refuses to mutate or delete any
// object that does not carry the whole identity below.
const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_PART_OF = "app.kubernetes.io/part-of";
const LABEL_PROFILE = "omp-web.omp.dev/profile-id";
const LABEL_GENERATION = "omp-web.omp.dev/generation";
const LABEL_RESOURCE_ID = "omp-web.omp.dev/resource-id";
const ANN_WORKSPACE_ID = "omp-web.omp.dev/workspace-id";
const ANN_WORKSPACE_TOKEN = "omp-web.omp.dev/workspace-token";
const ANN_PROFILE_ID = "omp-web.omp.dev/profile-id";
const ANN_NAMESPACE_UID = "omp-web.omp.dev/namespace-uid";
const ANN_CALLBACK_DIGEST = "omp-web.omp.dev/callback-credential-digest";
const ANN_SOURCE_PIN_DIGEST = "omp-web.omp.dev/source-pin-digest";
const MANAGED_BY_VALUE = "omp-web";
const PART_OF_VALUE = "omp-web-clones";

// ---------------------------------------------------------------------------
// kubectl execution boundary (injectable for offline contract tests)
// ---------------------------------------------------------------------------

export interface KubeExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** One kubectl invocation: explicit argv, optional stdin manifest. */
export type KubeExec = (argv: readonly string[], input?: string) => Promise<KubeExecResult>;

/** Resolve after `ms` milliseconds (withResolvers; no executor nesting). */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Collect one piped child stream up to maxBytes, decoding as UTF-8. */
async function collectPipe(pipe: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = pipe.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let overflow = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			if (!overflow) {
				if (total + value.byteLength > maxBytes) {
					overflow = true;
					chunks.push(value.subarray(0, maxBytes - total));
				} else {
					chunks.push(value);
				}
			}
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text = new TextDecoder().decode(merged);
	if (overflow) text += "\n[kubernetes-provider: output truncated]\n";
	return text;
}

/**
 * Default kubectl runner: explicit argv array (never a shell), piped
 * stdin/stdout/stderr, byte-capped output, and a hard kill budget so a
 * wedged API connection cannot hang the one-shot invocation forever.
 */
async function defaultKubeExec(argv: readonly string[], input?: string): Promise<KubeExecResult> {
	let proc: Subprocess<"ignore" | "pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn<"ignore" | "pipe", "pipe", "pipe">([...argv], {
			stdin: input === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const result: KubeExecResult = { code: 127, stdout: "", stderr: message };
		throw new KubeCallError(`cannot spawn ${argv[0] ?? "kubectl"}: ${message}`, result);
	}
	if (input !== undefined && proc.stdin !== undefined) {
		proc.stdin.write(input);
		proc.stdin.end();
	}
	const stdoutP = collectPipe(proc.stdout as ReadableStream<Uint8Array>, KUBE_OUTPUT_MAX_BYTES);
	const stderrP = collectPipe(proc.stderr as ReadableStream<Uint8Array>, KUBE_OUTPUT_MAX_BYTES);
	const deadline = Date.now() + KUBE_EXEC_KILL_MS;
	let timedOut = false;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			timedOut = true;
			proc.kill();
			break;
		}
		const { promise: settledP, resolve: settle } = Promise.withResolvers<{ code: number } | null>();
		proc.exited.then(
			(code) => settle({ code }),
			() => settle(null),
		);
		setTimeout(() => settle(null), remaining);
		const settled = await settledP;
		if (settled !== null) break;
	}
	const code = await proc.exited;
	const [stdout, stderrRaw] = await Promise.all([stdoutP, stderrP]);
	const stderr = timedOut ? `${stderrRaw}\nkubernetes-provider: exec timeout`.trim() : stderrRaw;
	return { code: timedOut ? -1 : code, stdout, stderr };
}

/** Thrown when a kubectl invocation itself fails (mapped per-op). */
class KubeCallError extends Error {
	constructor(
		message: string,
		readonly result: KubeExecResult,
	) {
		super(message);
	}
}

/**
 * Thrown when the object's API uid moved between the validation GET and the
 * deletion: we never delete a replacement object we did not validate.
 */
class KubePreconditionError extends Error {}

// ---------------------------------------------------------------------------
// Configuration resolution (operator-explicit; no ambient discovery)
// ---------------------------------------------------------------------------

interface KubernetesConfig {
	kubectlBin: string;
	/** Explicit kubeconfig context from the persisted binding. */
	context: string;
	/** Namespace from the persisted binding. */
	namespace: string;
	/** Namespace API uid from the persisted binding (never re-resolved). */
	namespaceUid: string;
	/** Fleet-generated resource identity (32 lowercase hex). */
	resourceIdentity: string;
	/** Deterministic Pod/PVC name: `omp-ws-<resourceIdentity>`. */
	resourceName: string;
	image: string;
	resources?: { cpu?: string; memory?: string };
	storageClass?: string;
	storageSize: string;
	secretRefs: Record<string, { secretName: string; secretKey: string; envName: string }>;
	/** Validated clone remote (`request.source.remote`). */
	sourceRemote: string;
	/** Pinned full commit (fleet-resolved once). */
	revision: string;
	/** Branch created at the pin. */
	branch: string;
	/** sha256 of the [sourceRemote, revision, branch] tuple. */
	sourcePinDigest: string;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `<secretName>/<key>`: DNS-1123 subdomain name + k8s secret key charset. */
const SECRET_REF_PARSE_RE = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?)\/([-._A-Za-z0-9]+)$/;

function parseSecretRefs(
	secretRefs: Record<string, string> | undefined,
): Record<string, { secretName: string; secretKey: string; envName: string }> {
	const out: KubernetesConfig["secretRefs"] = {};
	for (const [envName, ref] of Object.entries(secretRefs ?? {})) {
		if (!ENV_NAME_RE.test(envName)) {
			throw ProviderProtocolError.invalidRequest(
				`profile.secretRefs key ${JSON.stringify(envName)} is not a valid environment variable name`,
			);
		}
		// Reserved names carry the provider's own launch, preparation,
		// callback, home, path, and protocol values; a secret reference must
		// never shadow one (P5.5). Validated here, before any API call. The
		// image-owned SSH wrapper entry is reserved for the same reason.
		if (envName === GIT_SSH_COMMAND_ENV_KEY || RESERVED_SECRET_ENV_KEYS.includes(envName)) {
			throw ProviderProtocolError.invalidRequest(
				`profile.secretRefs.${envName} would shadow a reserved environment name the provider injects; rename the secret reference and consume it under an application-specific variable`,
			);
		}
		const match = SECRET_REF_PARSE_RE.exec(ref);
		if (match === null) {
			throw ProviderProtocolError.invalidRequest(
				`profile.secretRefs.${envName} must be "<secretName>/<key>" within the profile namespace, got ${JSON.stringify(ref)}`,
			);
		}
		// Group 1 is the full secret name, group 3 the key (group 2 is the
		// inner capture of the name pattern).
		out[envName] = { secretName: match[1], secretKey: match[3], envName };
	}
	return out;
}

/** The deterministic Pod/PVC name: exactly `omp-ws-<resourceIdentity>`. */
function resourceNameFor(binding: KubernetesBinding): string {
	if (!RESOURCE_IDENTITY_RE.test(binding.resourceIdentity)) {
		throw ProviderProtocolError.invalidRequest(
			`request.kubernetes.resourceIdentity must be 32 lowercase hex characters, got ${JSON.stringify(binding.resourceIdentity)}`,
		);
	}
	return `omp-ws-${binding.resourceIdentity}`;
}

/**
 * Refuse a branch the shared ref grammar rejects, in the provider's own error
 * vocabulary. `validateWorkspaceRef` (P4.1) is the single source of truth for
 * git-ref syntax: admission and preparation call it, so this provider calls it
 * too instead of carrying a second, drifting grammar. The branch names the
 * workspace volume's checkout ref, so an unusable one must be refused before
 * any kubectl call.
 */
function assertBranchRef(branch: string): void {
	try {
		validateWorkspaceRef(branch);
	} catch (cause) {
		if (cause instanceof PrepareWorkspaceError && cause.code === "invalid_request") {
			throw ProviderProtocolError.invalidRequest(
				`request.branch ${JSON.stringify(branch)} is not a usable git ref name`,
				{ cause },
			);
		}
		throw cause;
	}
}

/**
 * Resolve the effective configuration, failing BEFORE any cluster call.
 * The persisted binding is authoritative for context/namespace/namespaceUid
 * and for the Pod/PVC name; a profile (or a request) that disagrees with it
 * is a conflict, never a silent re-resolution.
 */
function resolveConfig(
	request: ProviderRequest,
	env: Record<string, string | undefined> = process.env,
): KubernetesConfig {
	const profile = request.profile;
	if (profile.provider !== "kubernetes") {
		throw ProviderProtocolError.invalidRequest(
			`profile ${profile.id} is a ${profile.provider} profile, not kubernetes`,
		);
	}
	const binding = request.kubernetes;
	if (binding === undefined) {
		throw ProviderProtocolError.invalidRequest(
			`kubernetes profile ${profile.id} requires request.kubernetes (the persisted resource binding); re-register the workspace to resolve it`,
		);
	}
	if (profile.namespace !== undefined && profile.namespace !== binding.namespace) {
		throw new ProviderProtocolError(
			"conflict",
			`profile namespaces ${JSON.stringify(profile.namespace)} but the workspace is bound to ${JSON.stringify(binding.namespace)}; the binding is fixed at registration`,
		);
	}
	if (profile.context !== undefined && profile.context !== binding.context) {
		throw new ProviderProtocolError(
			"conflict",
			`profile context ${JSON.stringify(profile.context)} but the workspace is bound to ${JSON.stringify(binding.context)}; the binding is fixed at registration`,
		);
	}
	if (binding.namespaceUid.trim() === "") {
		throw ProviderProtocolError.invalidRequest(
			"request.kubernetes.namespaceUid must be the namespace's API uid captured at registration",
		);
	}
	if (profile.image === undefined || profile.image.trim() === "") {
		throw ProviderProtocolError.invalidRequest(
			`kubernetes profile ${profile.id} requires an image (the session-runtime image)`,
		);
	}
	if (request.source?.local !== undefined) {
		throw ProviderProtocolError.invalidRequest(
			"source.local is a fleet-host filesystem path and cannot initialize a kubernetes volume; use source.remote for kubernetes profiles",
		);
	}
	const remote = request.source?.remote;
	if (remote === undefined) {
		throw ProviderProtocolError.invalidRequest(
			`kubernetes profile ${profile.id} requires source.remote: the in-pod volume can only be initialized from a remote clone source`,
		);
	}
	const sourceRemote = validateKubernetesSource(remote);
	if (request.revision === undefined) {
		throw ProviderProtocolError.invalidRequest(
			"kubernetes operations require the resolved revision (the full commit pinned by the fleet); resolve the pin before invoking the provider",
		);
	}
	if (request.branch === undefined) {
		throw ProviderProtocolError.invalidRequest(
			"kubernetes operations require the workspace branch created at the pinned revision",
		);
	}
	assertBranchRef(request.branch);
	return {
		kubectlBin: env.OMP_KUBE_BIN ?? "kubectl",
		context: binding.context,
		namespace: binding.namespace,
		namespaceUid: binding.namespaceUid,
		resourceIdentity: binding.resourceIdentity,
		resourceName: resourceNameFor(binding),
		image: profile.image,
		resources: profile.resources,
		storageClass: profile.storage?.class,
		storageSize: profile.storage?.size ?? DEFAULT_STORAGE_SIZE,
		secretRefs: parseSecretRefs(profile.secretRefs),
		sourceRemote,
		revision: request.revision,
		branch: request.branch,
		sourcePinDigest: computeSourcePinDigest(sourceRemote, request.revision, request.branch),
	};
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

const DNS1123_MAX = 63;

/**
 * DNS-1123 label value for the profile id (the label charset is narrower than
 * the annotation's): sanitize to a label, truncate to 63, then trim the
 * hyphens truncation may have exposed (a label may not end in "-").
 */
function profileLabel(profileId: string): string {
	const sanitized = profileId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized.slice(0, DNS1123_MAX).replace(/-+$/g, "") || "profile";
}

// ---------------------------------------------------------------------------
// Identity helpers (ONE ownership validator, all four operations)
// ---------------------------------------------------------------------------

interface ObjectMeta {
	uid: string;
	deletionTimestamp: string | null;
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

/** Values an object's metadata must carry before this workspace may touch it. */
interface WorkspaceOwnership {
	workspaceId: string;
	profileId: string;
	resourceIdentity: string;
	namespaceUid: string;
	sourcePinDigest: string;
	/** Launch token recorded for the requested generation, when known. */
	providerToken?: string;
	/** Callback credential digest recorded/enrolled for the generation. */
	callbackDigest?: string;
}

/** Everything the provider stamps onto a Pod/PVC (see {@link buildPvcManifest}). */
export interface KubernetesObjectIdentity {
	workspaceId: string;
	profileId: string;
	resourceIdentity: string;
	namespaceUid: string;
	sourcePinDigest: string;
	workspaceToken: string;
	callbackDigest: string;
}

/**
 * The SINGLE ownership validator (P5.3 step 5), used by all four operations.
 * Returns null when the object is this workspace's own object for the
 * requested tuple; otherwise the human clause explaining why it is NOT (the
 * caller turns it into a refusal). A foreign object is never mutated or
 * deleted.
 *
 * `opts.generation` fences Pods to one generation; `opts.objectUid` pins the
 * object's own API uid when the provider record carries one. Pods must always
 * carry the launch token annotation, an exact positive-decimal generation
 * label, and the callback credential digest annotation.
 */
function ownershipReason(
	kind: "pod" | "persistentvolumeclaim" | "configmap",
	meta: ObjectMeta,
	identity: WorkspaceOwnership,
	opts?: { generation?: number; objectUid?: string | null },
): string | null {
	const { labels, annotations } = meta;
	if (labels[LABEL_MANAGED_BY] !== MANAGED_BY_VALUE) {
		return `does not carry ${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE}`;
	}
	if (labels[LABEL_PART_OF] !== PART_OF_VALUE) {
		return `does not carry ${LABEL_PART_OF}=${PART_OF_VALUE}`;
	}
	if (annotations[ANN_WORKSPACE_ID] !== identity.workspaceId) {
		return `does not carry ${ANN_WORKSPACE_ID} for this workspace`;
	}
	if (annotations[ANN_PROFILE_ID] !== identity.profileId) {
		return `does not carry ${ANN_PROFILE_ID}=${JSON.stringify(identity.profileId)}`;
	}
	if (labels[LABEL_PROFILE] !== profileLabel(identity.profileId)) {
		return `does not carry ${LABEL_PROFILE}=${JSON.stringify(profileLabel(identity.profileId))}`;
	}
	if (labels[LABEL_RESOURCE_ID] !== identity.resourceIdentity) {
		return `does not carry ${LABEL_RESOURCE_ID}=${JSON.stringify(identity.resourceIdentity)}`;
	}
	if (annotations[ANN_NAMESPACE_UID] !== identity.namespaceUid) {
		return `was created against namespace uid ${JSON.stringify(annotations[ANN_NAMESPACE_UID] ?? null)}, not the bound ${JSON.stringify(identity.namespaceUid)}`;
	}
	if (annotations[ANN_SOURCE_PIN_DIGEST] !== identity.sourcePinDigest) {
		return `was created against a different source/pin/branch tuple (${ANN_SOURCE_PIN_DIGEST} mismatch)`;
	}
	if (opts?.objectUid !== undefined && opts.objectUid !== null && meta.uid !== opts.objectUid) {
		return `carries API uid ${JSON.stringify(meta.uid)}, not the recorded ${JSON.stringify(opts.objectUid)}`;
	}
	if (kind === "pod") {
		const token = annotations[ANN_WORKSPACE_TOKEN];
		if (typeof token !== "string" || token === "") {
			return `does not carry ${ANN_WORKSPACE_TOKEN}`;
		}
		if (identity.providerToken !== undefined && token !== identity.providerToken) {
			return "carries a different provider launch token than the recorded identity";
		}
		const rawGeneration = labels[LABEL_GENERATION];
		if (rawGeneration === undefined || !GENERATION_LABEL_RE.test(rawGeneration)) {
			return `does not carry an exact positive-decimal ${LABEL_GENERATION} label (got ${JSON.stringify(rawGeneration ?? null)})`;
		}
		if (opts?.generation !== undefined && Number(rawGeneration) !== opts.generation) {
			return `runs under generation ${rawGeneration} but generation ${opts.generation} was requested`;
		}
		const digest = annotations[ANN_CALLBACK_DIGEST];
		if (typeof digest !== "string" || digest === "") {
			return `does not carry ${ANN_CALLBACK_DIGEST}`;
		}
		if (identity.callbackDigest !== undefined && digest !== identity.callbackDigest) {
			return "carries a callback credential digest that does not match the enrolled handoff";
		}
	}
	return null;
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

/** Build the complete identity stamped onto (and read back from) an object. */
function objectIdentity(
	ownership: WorkspaceOwnership,
	workspaceToken: string,
	callbackDigest: string,
): KubernetesObjectIdentity {
	return {
		workspaceId: ownership.workspaceId,
		profileId: ownership.profileId,
		resourceIdentity: ownership.resourceIdentity,
		namespaceUid: ownership.namespaceUid,
		sourcePinDigest: ownership.sourcePinDigest,
		workspaceToken,
		callbackDigest,
	};
}

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
	/** API uid of the claim observed alongside the Pod (null until observed). */
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
// Callback enrollment handoff (runtime/callback-env.ts, shared with bwrap)
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
 * a management operation treats an absent or other-generation handoff as "no
 * enrollment evidence" so stop/delete keep working with no handoff at all.
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
		throw new ProviderProtocolError(
			"unavailable",
			`${CALLBACK_ENV_FILE} carries no ${CALLBACK_TOKEN_ENV_KEY}: a kubernetes launch requires the enrolled callback credential`,
		);
	}
	const digest = callbackCredentialDigest(token);
	if (digest === null) {
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
// kubectl helpers (every call carries --context; the ambient context is
// never consulted or mutated)
// ---------------------------------------------------------------------------

function kubeArgs(cfg: KubernetesConfig, rest: readonly string[]): string[] {
	return [
		cfg.kubectlBin,
		"--context",
		cfg.context,
		`--request-timeout=${KUBE_REQUEST_TIMEOUT}`,
		...rest,
	];
}

/** GET one object as JSON; null when absent (--ignore-not-found). */
async function kubeGet(
	exec: KubeExec,
	cfg: KubernetesConfig,
	kind: string,
	name: string,
	opts?: { namespaced?: boolean },
): Promise<Record<string, unknown> | null> {
	const namespaced = opts?.namespaced ?? true;
	const argv = kubeArgs(cfg, [
		"get",
		kind,
		name,
		...(namespaced ? ["-n", cfg.namespace] : []),
		"--ignore-not-found",
		"-o",
		"json",
	]);
	const result = await exec(argv);
	if (result.code !== 0) {
		throw new KubeCallError(
			`kubectl get ${kind}/${name} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			result,
		);
	}
	const text = result.stdout.trim();
	if (text === "") return null;
	return JSON.parse(text) as Record<string, unknown>;
}

/** CREATE one object from a manifest on stdin (never apply: no adopting or patching foreign objects). */
async function kubeCreate(
	exec: KubeExec,
	cfg: KubernetesConfig,
	manifest: Record<string, unknown>,
	what: string,
): Promise<void> {
	const result = await exec(
		kubeArgs(cfg, ["create", "-n", cfg.namespace, "-f", "-"]),
		`${JSON.stringify(manifest)}\n`,
	);
	if (result.code !== 0) {
		throw new KubeCallError(
			`kubectl create ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			result,
		);
	}
}

/**
 * DELETE one object without blocking, after re-confirming its API uid.
 *
 * kubectl has no portable `--uid`/`--resourceVersion` precondition flag for
 * `delete` across the supported version range, so the provider cannot hand the
 * API an atomic precondition. It therefore re-GETs the object immediately
 * before the delete and refuses when the uid moved: a replacement object
 * created between validation and this call is never removed by us. The window
 * between this GET and the DELETE is the residual race, documented here rather
 * than hidden. Absent objects are success; plain `--wait=false` delete, never
 * `--force`.
 */
async function kubeDelete(
	exec: KubeExec,
	cfg: KubernetesConfig,
	kind: string,
	name: string,
	what: string,
	expectedUid: string,
): Promise<void> {
	if (expectedUid === "") {
		throw new KubePreconditionError(
			`refusing to delete ${what}: the validated object carries no API uid`,
		);
	}
	const current = await kubeGet(exec, cfg, kind, name);
	if (current === null) return;
	const uid = objectMeta(current).uid;
	if (uid !== expectedUid) {
		throw new KubePreconditionError(
			`refusing to delete ${what}: its API uid changed (${expectedUid} -> ${uid || "none"}) after validation`,
		);
	}
	const result = await exec(
		kubeArgs(cfg, ["delete", kind, name, "-n", cfg.namespace, "--wait=false"]),
	);
	if (result.code !== 0) {
		if (/NotFound|not found/i.test(result.stderr)) return;
		throw new KubeCallError(
			`kubectl delete ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			result,
		);
	}
}

/** API uid of the bound namespace, or null when it no longer exists. */
async function kubeNamespaceUid(exec: KubeExec, cfg: KubernetesConfig): Promise<string | null> {
	const namespace = await kubeGet(exec, cfg, "namespace", cfg.namespace, { namespaced: false });
	if (namespace === null) return null;
	const uid = objectMeta(namespace).uid;
	return uid === "" ? null : uid;
}

// ---------------------------------------------------------------------------
// Object inspection (plain-record navigation, no schema dependency)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function objectMeta(object: Record<string, unknown>): ObjectMeta {
	const metadata = asRecord(object.metadata) ?? {};
	return {
		uid: typeof metadata.uid === "string" ? metadata.uid : "",
		deletionTimestamp:
			typeof metadata.deletionTimestamp === "string" ? metadata.deletionTimestamp : null,
		labels: (asRecord(metadata.labels) ?? {}) as Record<string, string>,
		annotations: (asRecord(metadata.annotations) ?? {}) as Record<string, string>,
	};
}

function podPhase(pod: Record<string, unknown>): string {
	const status = asRecord(pod.status);
	return typeof status?.phase === "string" ? status.phase : "Unknown";
}

function podStartTime(pod: Record<string, unknown>): number | undefined {
	const status = asRecord(pod.status);
	if (typeof status?.startTime !== "string") return undefined;
	const ms = Date.parse(status.startTime);
	return Number.isNaN(ms) ? undefined : ms;
}

/** First waiting/terminated container reason, for actionable failures. */
function podContainerReason(pod: Record<string, unknown>): string | null {
	const status = asRecord(pod.status);
	const list = status?.containerStatuses;
	if (!Array.isArray(list)) return null;
	for (const entry of list) {
		const state = asRecord(asRecord(entry)?.state);
		const waiting = asRecord(state?.waiting);
		if (typeof waiting?.reason === "string") return waiting.reason;
		const terminated = asRecord(state?.terminated);
		if (typeof terminated?.reason === "string") return terminated.reason;
	}
	return null;
}

function pvcMeta(pvc: Record<string, unknown>): ObjectMeta & {
	storageClassName: string | undefined;
	size: string | undefined;
	accessModes: string[];
} {
	const spec = asRecord(pvc.spec) ?? {};
	const resources = asRecord(spec.resources) ?? {};
	const requests = asRecord(resources.requests) ?? {};
	const accessModes = Array.isArray(spec.accessModes)
		? spec.accessModes.filter((m): m is string => typeof m === "string")
		: [];
	return {
		...objectMeta(pvc),
		storageClassName: typeof spec.storageClassName === "string" ? spec.storageClassName : undefined,
		size: typeof requests.storage === "string" ? requests.storage : undefined,
		accessModes,
	};
}

/** One observed workspace: both objects plus the live namespace uid. */
interface ObservedObjects {
	namespaceUid: string | null;
	pod: Record<string, unknown> | null;
	pvc: Record<string, unknown> | null;
}

/** GET the Pod, the PVC, and the bound namespace's uid. */
async function observeObjects(exec: KubeExec, cfg: KubernetesConfig): Promise<ObservedObjects> {
	const pod = await kubeGet(exec, cfg, "pod", cfg.resourceName);
	const pvc = await kubeGet(exec, cfg, "persistentvolumeclaim", cfg.resourceName);
	const namespaceUid = await kubeNamespaceUid(exec, cfg);
	return { namespaceUid, pod, pvc };
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

// ---------------------------------------------------------------------------
// Manifest builders (pure; unit-testable without a cluster)
// ---------------------------------------------------------------------------

function identityLabels(
	workspaceId: string,
	profileId: string,
	resourceIdentity: string,
	generation?: number,
): Record<string, string> {
	const labels: Record<string, string> = {
		[LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
		[LABEL_PART_OF]: PART_OF_VALUE,
		[LABEL_RESOURCE_ID]: resourceIdentity,
		[LABEL_PROFILE]: profileLabel(profileId),
	};
	// The generation label is Pod-only: a retained claim outlives the
	// generation that created it, and a stale value would be misleading.
	if (generation !== undefined) labels[LABEL_GENERATION] = String(generation);
	return labels;
}

function identityAnnotations(identity: KubernetesObjectIdentity): Record<string, string> {
	return {
		[ANN_WORKSPACE_ID]: identity.workspaceId,
		[ANN_PROFILE_ID]: identity.profileId,
		[ANN_NAMESPACE_UID]: identity.namespaceUid,
		[ANN_WORKSPACE_TOKEN]: identity.workspaceToken,
		[ANN_CALLBACK_DIGEST]: identity.callbackDigest,
		[ANN_SOURCE_PIN_DIGEST]: identity.sourcePinDigest,
	};
}

/** The per-workspace persistent claim (retained across stop/replacement). */
export function buildPvcManifest(
	cfg: KubernetesConfig,
	identity: KubernetesObjectIdentity,
): Record<string, unknown> {
	const spec: Record<string, unknown> = {
		accessModes: ["ReadWriteOnce"],
		volumeMode: "Filesystem",
		resources: { requests: { storage: cfg.storageSize } },
	};
	if (cfg.storageClass !== undefined) spec.storageClassName = cfg.storageClass;
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: {
			name: cfg.resourceName,
			namespace: cfg.namespace,
			labels: identityLabels(identity.workspaceId, identity.profileId, identity.resourceIdentity),
			annotations: identityAnnotations(identity),
		},
		spec,
	};
}

/**
 * The workspace pod: single container, no inbound service, restartPolicy
 * Never, service-account token unmounted (P5.5: no Kubernetes credentials
 * inside agent execution), hardened securityContext, PVC at /workspace
 * plus an emptyDir /tmp for the read-only root filesystem.
 */
export function buildPodManifest(
	cfg: KubernetesConfig,
	request: ProviderRequest,
	identity: KubernetesObjectIdentity,
	callbackEnv: Record<string, string>,
): Record<string, unknown> {
	const { workspaceId, generation } = request;

	const env: Record<string, unknown>[] = [
		{ name: "OMP_WORKSPACE_ID", value: workspaceId },
		{ name: "OMP_WORKSPACE_GENERATION", value: String(generation) },
		{ name: "OMP_WORKSPACE_TOKEN", value: identity.workspaceToken },
		{ name: "OMP_PROVIDER_PROTO", value: String(OMP_PROVIDER_PROTO) },
		{ name: "OMP_WORKSPACE_ROOT", value: POD_WORKSPACE_ROOT },
		{ name: "OMP_WORKSPACE_DIR", value: POD_CHECKOUT_DIR },
		{ name: "HOME", value: POD_HOME_DIR },
		{ name: "PI_CODING_AGENT_DIR", value: `${POD_HOME_DIR}/agent` },
		{ name: "PATH", value: "/usr/local/bin:/usr/bin:/bin" },
		{ name: "LANG", value: "C.UTF-8" },
		{ name: "TERM", value: "xterm-256color" },
		// Image-owned SSH wrapper: pins the operator's Git identity for
		// in-pod preparation and network probes (P3.5). Reserved, so a
		// profile secretRef can never replace it (see parseSecretRefs).
		{ name: GIT_SSH_COMMAND_ENV_KEY, value: POD_GIT_SSH_COMMAND },
	];

	// In-pod preparation input: ALWAYS all three fields (the image entrypoint
	// requires them on every pod start, and the resolved config proves they
	// are present before any cluster call). An initialized volume never
	// re-clones: prepare-workspace validates the existing marker instead.
	env.push({ name: "OMP_PREP_SOURCE_REMOTE", value: cfg.sourceRemote });
	env.push({ name: "OMP_PREP_REVISION", value: cfg.revision });
	env.push({ name: "OMP_PREP_BRANCH", value: cfg.branch });

	// Callback enrollment handoff (generation-scoped; carries the raw
	// credential into the pod env only).
	for (const [key, value] of Object.entries(callbackEnv)) {
		env.push({ name: key, value });
	}

	// Sanitized baseline: point the in-pod seed at the mounted documents.
	// Absent baseline → no mount and no env, so a volume with no operator
	// config to seed stays unseeded exactly as before.
	const baseline = request.baseline;
	if (baseline !== undefined) {
		env.push({
			name: BASELINE_CONFIG_ENV_KEY,
			value: `${POD_BASELINE_DIR}/${BASELINE_CONFIG_KEY}`,
		});
	}

	// Model/tool credentials via native secret references only.
	for (const ref of Object.values(cfg.secretRefs)) {
		env.push({
			name: ref.envName,
			valueFrom: { secretKeyRef: { name: ref.secretName, key: ref.secretKey } },
		});
	}

	const resources: Record<string, unknown> = {};
	if (cfg.resources?.cpu !== undefined || cfg.resources?.memory !== undefined) {
		const quantities: Record<string, string> = {};
		if (cfg.resources.cpu !== undefined) quantities.cpu = cfg.resources.cpu;
		if (cfg.resources.memory !== undefined) quantities.memory = cfg.resources.memory;
		// Identical requests/limits → Guaranteed QoS: a stateful single
		// writer must not be the node's first eviction candidate.
		resources.requests = quantities;
		resources.limits = quantities;
	}

	const container: Record<string, unknown> = {
		name: "session",
		image: cfg.image,
		imagePullPolicy: "IfNotPresent",
		env,
		resources,
		securityContext: {
			runAsNonRoot: true,
			runAsUser: RUNTIME_UID,
			runAsGroup: RUNTIME_UID,
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		},
		volumeMounts: [
			{ name: "workspace", mountPath: POD_WORKSPACE_ROOT },
			{ name: "tmp", mountPath: "/tmp" },
			...(baseline !== undefined
				? [{ name: "baseline", mountPath: POD_BASELINE_DIR, readOnly: true }]
				: []),
		],
	};

	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: cfg.resourceName,
			namespace: cfg.namespace,
			labels: identityLabels(
				workspaceId,
				identity.profileId,
				identity.resourceIdentity,
				generation,
			),
			annotations: identityAnnotations(identity),
		},
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			terminationGracePeriodSeconds: 15,
			securityContext: {
				runAsNonRoot: true,
				runAsUser: RUNTIME_UID,
				runAsGroup: RUNTIME_UID,
				fsGroup: RUNTIME_UID,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [container],
			volumes: [
				{
					name: "workspace",
					persistentVolumeClaim: { claimName: cfg.resourceName, readOnly: false },
				},
				{ name: "tmp", emptyDir: {} },
				...(baseline !== undefined
					? [
							{
								name: "baseline",
								configMap: { name: baselineConfigMapName(cfg), optional: false },
							},
						]
					: []),
			],
		},
	};
}

/** ConfigMap name holding this workspace's sanitized baseline documents. */
function baselineConfigMapName(cfg: KubernetesConfig): string {
	return `${cfg.resourceName}${BASELINE_CONFIGMAP_SUFFIX}`;
}

/**
 * The baseline ConfigMap: `data` keys become the file names under
 * {@link POD_BASELINE_DIR}. It carries the same identity labels/annotations
 * as the Pod and PVC, so it is attributable to exactly this workspace
 * generation, and only allowlisted, credential-free documents ever land here
 * (the fleet sanitized them; the provider copies them verbatim).
 */
export function buildBaselineConfigMapManifest(
	cfg: KubernetesConfig,
	request: ProviderRequest,
	identity: KubernetesObjectIdentity,
): Record<string, unknown> {
	const baseline = request.baseline;
	if (baseline === undefined) {
		throw new Error("baseline ConfigMap manifest requires a request baseline");
	}
	const { workspaceId, generation } = request;
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: {
			name: baselineConfigMapName(cfg),
			namespace: cfg.namespace,
			labels: identityLabels(
				workspaceId,
				identity.profileId,
				identity.resourceIdentity,
				generation,
			),
			annotations: identityAnnotations(identity),
		},
		data: {
			[BASELINE_CONFIG_KEY]: baseline.configYaml,
			...(baseline.modelsYaml !== undefined ? { [BASELINE_MODELS_KEY]: baseline.modelsYaml } : {}),
		},
	};
}

/**
 * Refresh the baseline ConfigMap immediately before a Pod that mounts it is
 * created. The object is workspace-scoped (one name per workspace, like the
 * Pod), so a previous generation's copy must be replaced rather than reused:
 * the operator's agent config may have changed since. The old object is
 * deleted through the uid-preconditioned path and the new one created right
 * after, so the name is only ever briefly absent, and only while the pod that
 * would mount it does not exist yet (ensure-running reaches here solely to
 * create one).
 */
async function ensureBaselineConfigMap(
	exec: KubeExec,
	cfg: KubernetesConfig,
	request: ProviderRequest,
	identity: KubernetesObjectIdentity,
	ownership: WorkspaceOwnership,
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
	}
	await kubeCreate(
		exec,
		cfg,
		buildBaselineConfigMapManifest(cfg, request, identity),
		`configmap ${name}`,
	);
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

/** Poll until `probe` reports done or the budget elapses. */
async function pollUntil(budgetMs: number, probe: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (await probe()) return true;
		if (Date.now() >= deadline) return false;
		await delay(POLL_INTERVAL_MS);
	}
}

/** Wait until the named object is gone from the API (404), bounded. */
async function waitGone(
	exec: KubeExec,
	cfg: KubernetesConfig,
	kind: string,
	name: string,
	budgetMs: number,
): Promise<boolean> {
	return pollUntil(budgetMs, async () => (await kubeGet(exec, cfg, kind, name)) === null);
}

/** Outcome of waiting for a pod to reach Running. */
export interface PodRunningWait {
	running: boolean;
	phase: string;
	reason: string | null;
}

/** Wait until the pod is Running, bounded. Returns phase detail for errors. */
async function waitPodRunning(
	exec: KubeExec,
	cfg: KubernetesConfig,
	name: string,
	budgetMs: number,
): Promise<PodRunningWait> {
	let last: Record<string, unknown> | null = null;
	const done = await pollUntil(budgetMs, async () => {
		last = await kubeGet(exec, cfg, "pod", name);
		if (last === null) return false;
		return podPhase(last) === "Running";
	});
	const phase = last === null ? "Missing" : podPhase(last);
	return { running: done, phase, reason: last === null ? null : podContainerReason(last) };
}

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
		ensureWaitMs: envMs("OMP_KUBE_ENSURE_WAIT_MS", ENSURE_WAIT_MS_DEFAULT),
		stopWaitMs: envMs("OMP_KUBE_STOP_WAIT_MS", STOP_WAIT_MS_DEFAULT),
		deleteWaitMs: envMs("OMP_KUBE_DELETE_WAIT_MS", DELETE_WAIT_MS_DEFAULT),
		lockWaitMs: envMs("OMP_KUBE_LOCK_WAIT_MS", LOCK_WAIT_MS_DEFAULT),
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
				objectUid: recorded.pvcUid,
			}) !== null
		) {
			return null;
		}
		const namespaceUid = await kubeNamespaceUid(deps.exec, cfg);
		if (namespaceUid !== cfg.namespaceUid) return null;
		if (phase !== "Running") {
			// Owned objects, no container yet: the peer's launch is mid-flight,
			// so the workspace is not running. A failure envelope persists
			// nothing (the fleet's ensure persists the handle and the
			// authorized generation only on an ok response) and sends the next
			// attempt through the ordinary inspect-first path, which adopts or
			// replaces this very Pod instead of creating a second one.
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
		const { cfg, recorded } = ctx;
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
				objectUid: recorded?.pvcUid ?? null,
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
			const launch: LaunchInputs = { workspaceToken: token, callbackDigest, record: ctx.record };
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
				podUid: meta.uid === "" ? null : meta.uid,
				pvcUid: objectMeta(pvc).uid === "" ? null : objectMeta(pvc).uid,
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
		const launch: LaunchInputs = { workspaceToken: token, callbackDigest, record: ctx.record };

		if (pvc !== null) {
			const claim = pvcMeta(pvc);
			const reason = ownershipReason("persistentvolumeclaim", claim, ctx.ownership, {
				objectUid: recorded?.pvcUid ?? null,
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
		} else {
			try {
				await kubeCreate(
					deps.exec,
					cfg,
					buildPvcManifest(cfg, objectIdentity(ctx.ownership, token, callbackDigest)),
					`persistentvolumeclaim ${podName}`,
				);
			} catch (cause) {
				return kubeFailure(cause, "ensure-running");
			}
		}

		return await createPodAndWait(ctx, deps, launch);
	});
}

/**
 * Create the workspace pod and wait for Running; shared by every ensure path.
 * The record is written as soon as the Pod's uid is observed, so a crash
 * between create and Running still leaves a re-anchorable identity.
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
		await ensureBaselineConfigMap(deps.exec, cfg, request, identity, ctx.ownership);
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
	writeRecord(
		request.stateDir,
		launchRecord(request, cfg, launch, { podUid: uid === "" ? null : uid, pvcUid: null }),
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
 * Finish a running ensure: re-observe both objects, recheck the bound
 * namespace uid (a namespace deleted and recreated while the operation ran is
 * a conflict, never a silent success, and the observed resources are retained
 * for inspection), persist the observed uids, and report the observation.
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
	if (objects.namespaceUid === null) {
		return err(
			"conflict",
			`the bound namespace ${cfg.namespace} disappeared during ensure-running (pinned uid ${cfg.namespaceUid}); the resources are retained for inspection`,
			false,
		);
	}
	if (objects.namespaceUid !== cfg.namespaceUid) {
		return err(
			"conflict",
			`namespace ${cfg.namespace} was replaced during ensure-running (uid ${cfg.namespaceUid} -> ${objects.namespaceUid}); the resources are retained for inspection`,
			false,
		);
	}
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
	const startedAt = podStartTime(objects.pod) ?? launch.record?.startedAt;
	const record = launchRecord(request, cfg, launch, {
		podUid: meta.uid,
		pvcUid: objects.pvc === null ? null : objectMeta(objects.pvc).uid || null,
		...(startedAt !== undefined ? { startedAt } : {}),
	});
	writeRecord(request.stateDir, record);
	return ok(handle, "running", observed(objects.namespaceUid, objects.pod, objects.pvc), {
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
		const { cfg, handle, recorded } = ctx;
		let objects: ObservedObjects;
		try {
			objects = await observeObjects(deps.exec, cfg);
		} catch (cause) {
			return kubeFailure(cause, "inspect");
		}

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
				{
					objectUid: recorded?.pvcUid ?? null,
				},
			);
			if (claimReason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", cfg.resourceName, claimReason, "inspect");
			}
			const phase = podPhase(objects.pod);
			if (meta.deletionTimestamp === null && (phase === "Running" || phase === "Pending")) {
				return ok(handle, "running", observed(cfg.namespaceUid, objects.pod, objects.pvc), {
					startedAt: podStartTime(objects.pod) ?? recorded?.startedAt,
				});
			}
			return ok(handle, "stopped", observed(cfg.namespaceUid, objects.pod, objects.pvc), {
				startedAt: recorded?.startedAt,
			});
		}

		if (objects.pvc !== null) {
			const reason = ownershipReason("persistentvolumeclaim", pvcMeta(objects.pvc), ctx.ownership, {
				objectUid: recorded?.pvcUid ?? null,
			});
			if (reason !== null) {
				return refuseObject(cfg, "persistentvolumeclaim", cfg.resourceName, reason, "inspect");
			}
			// Compute gone, storage retained.
			return ok(handle, "stopped", observed(cfg.namespaceUid, null, objects.pvc), {
				startedAt: recorded?.startedAt,
			});
		}

		if (ctx.record !== null) {
			// Compute gone and storage gone, but the launch identity remains.
			return ok(handle, "stopped", observed(cfg.namespaceUid, null, null), {
				startedAt: recorded?.startedAt,
			});
		}
		return ok(handle, "missing", observed(cfg.namespaceUid, null, null));
	});
}

/**
 * stop: validate and delete the requested Pod, prove its absence, and retain
 * the claim (and the launch record). Pod absence is success. Ownership comes
 * from the binding plus the launch record, so stop works with no callback
 * handoff at all.
 */
async function opStop(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: false }, async (ctx) => {
		const { cfg, handle, recorded } = ctx;
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
					objectUid: recorded?.pvcUid ?? null,
				}) === null;
			return ok(handle, "stopped", observed(cfg.namespaceUid, null, claimOwned ? pvc : null));
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
				objectUid: recorded?.pvcUid ?? null,
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
		return ok(handle, "stopped", observed(cfg.namespaceUid, null, pvc));
	});
}

/**
 * delete: every PRESENT object is validated before the first deletion, each
 * deletion goes through the fresh-GET uid barrier, and absence is proven before
 * success. Repeated deletion succeeds once both objects are absent. The
 * stateDir (and the lock this operation holds) is left in place: the fleet
 * removes provider state after it confirms the deletion (P3.7), so removing it
 * here would race the lock's own release.
 */
async function opDelete(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest;
	return withOpContext(request, deps, { requireHandoff: false }, async (ctx) => {
		const { cfg, handle, recorded } = ctx;
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

		if (pod === null && pvc === null && baseline === null) {
			// Every object is already absent: the requested state is reached.
			return ok(handle, "missing", observed(cfg.namespaceUid, null, null));
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
				objectUid: recorded?.pvcUid ?? null,
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

		return ok(handle, "missing", observed(cfg.namespaceUid, null, null));
	});
}

// ---------------------------------------------------------------------------
// Preflight (P5.6): actionable, no installs, no object creation
// ---------------------------------------------------------------------------

/** Parse `kubectl get storageclass -o json` into its items, best effort. */
function storageClassItems(stdout: string): Record<string, unknown>[] | null {
	try {
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		if (!Array.isArray(parsed.items)) return null;
		return parsed.items.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
	} catch {
		return null;
	}
}

/** True when a StorageClass carries either default-class annotation. */
function isDefaultStorageClass(item: Record<string, unknown>): boolean {
	const annotations = asRecord(asRecord(item.metadata)?.annotations) ?? {};
	const defaults = [
		"storageclass.kubernetes.io/is-default-class",
		"storageclass.beta.kubernetes.io/is-default-class",
	];
	return defaults.some((key) => annotations[key] === "true");
}

/**
 * Production-profile preflight for a kubernetes profile. Every check that
 * can fail carries an actionable remediation; all checks run (cluster-
 * dependent checks report their dependency failure rather than being
 * skipped silently). Nothing is installed, created, or mutated: the only
 * API traffic is reads plus `auth can-i` access reviews, all of it from the
 * fleet host (the provider preflight never creates a Pod to probe from).
 *
 * Wired into runtime/preflight.ts by the Runtime owner; exported here so
 * the wiring is one function call.
 */
export async function preflightKubernetesProfile(
	profile: ProviderProfile,
	opts?: { exec?: KubeExec; env?: Record<string, string | undefined> },
): Promise<PreflightResult> {
	const exec = opts?.exec ?? defaultKubeExec;
	const env = opts?.env ?? process.env;
	const checks: PreflightCheck[] = [];

	// 1. kubectl client binary (no API traffic).
	let clientVersion: string | null = null;
	{
		const result = await exec([env.OMP_KUBE_BIN ?? "kubectl", "version", "--client", "-o", "json"]);
		if (result.code === 0) {
			try {
				const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
				const client = asRecord(parsed.clientVersion);
				clientVersion = typeof client?.gitVersion === "string" ? client.gitVersion : "unknown";
				checks.push({
					name: "kubectl-client",
					ok: true,
					detail: `kubectl client ${clientVersion}`,
				});
			} catch {
				checks.push({
					name: "kubectl-client",
					ok: false,
					detail: "kubectl version --client returned unparseable output",
					remediation: "install a kubectl >= 1.27 build or set OMP_KUBE_BIN",
				});
			}
		} else {
			checks.push({
				name: "kubectl-client",
				ok: false,
				detail: `kubectl version --client failed: ${result.stderr.trim() || `exit ${result.code}`}`,
				remediation: "install kubectl (>= 1.27) on the fleet host or set OMP_KUBE_BIN",
			});
		}
	}

	// 2. Explicit context (the ambient current-context is never used).
	const context = profile.context ?? env.OMP_KUBE_CONTEXT;
	if (context === undefined || context.trim() === "") {
		checks.push({
			name: "kube-context",
			ok: false,
			detail: "no explicit API context configured",
			remediation: `set providerProfiles.${profile.id}.context (or export OMP_KUBE_CONTEXT); the ambient kubectl current-context is never used implicitly`,
		});
	} else {
		checks.push({ name: "kube-context", ok: true, detail: `context ${context}` });
	}

	const clusterReady = clientVersion !== null && context !== undefined && context.trim() !== "";
	const bin = env.OMP_KUBE_BIN ?? "kubectl";
	const base =
		context === undefined
			? [bin]
			: [bin, "--context", context, `--request-timeout=${KUBE_REQUEST_TIMEOUT}`];
	const skipped = (name: string, what: string): PreflightCheck => ({
		name,
		ok: false,
		detail: `${what} could not be checked: no usable kubectl client/context`,
		remediation: "fix kubectl-client and kube-context above first",
	});

	// 3. API reachability.
	let apiReady = false;
	if (clusterReady) {
		const result = await exec([...base, "version", "--request-timeout=5s"]);
		if (result.code === 0) {
			apiReady = true;
			checks.push({ name: "kube-api", ok: true, detail: `API reachable via context ${context}` });
		} else {
			checks.push({
				name: "kube-api",
				ok: false,
				detail: `API not reachable via context ${context}: ${result.stderr.trim() || `exit ${result.code}`}`,
				remediation:
					"check the kubeconfig credentials and network path for this context; the provider never switches contexts",
			});
		}
	} else {
		checks.push(skipped("kube-api", "API reachability"));
	}

	// 4. Namespace (operator-prepared).
	const namespace = profile.namespace;
	let namespaceReady = false;
	if (!apiReady) {
		checks.push(skipped("kube-namespace", "namespace existence"));
	} else if (namespace === undefined || namespace.trim() === "") {
		checks.push({
			name: "kube-namespace",
			ok: false,
			detail: "profile has no namespace",
			remediation: `set providerProfiles.${profile.id}.namespace to an operator-prepared namespace`,
		});
	} else {
		const result = await exec([...base, "get", "namespace", namespace, "-o", "name"]);
		namespaceReady = result.code === 0;
		checks.push(
			result.code === 0
				? { name: "kube-namespace", ok: true, detail: `namespace ${namespace} exists` }
				: {
						name: "kube-namespace",
						ok: false,
						detail: `namespace ${namespace}: ${result.stderr.trim() || `exit ${result.code}`}`,
						remediation: `ask the operator to create namespace ${namespace} and grant the profile's RBAC within it; the provider never creates namespaces`,
					},
		);
	}

	// 5. Narrow RBAC: exactly the verbs the provider uses, nothing broader.
	if (apiReady && namespaceReady && namespace !== undefined) {
		for (const [verb, resource] of [
			["get", "pods"],
			["create", "pods"],
			["delete", "pods"],
			["get", "persistentvolumeclaims"],
			["create", "persistentvolumeclaims"],
			["delete", "persistentvolumeclaims"],
			// The sanitized baseline is delivered as a workspace-scoped
			// ConfigMap, so the profile needs the same three verbs on it.
			["get", "configmaps"],
			["create", "configmaps"],
			["delete", "configmaps"],
		] as const) {
			const result = await exec([
				...base,
				"auth",
				"can-i",
				verb,
				resource,
				"-n",
				namespace,
				"--quiet",
			]);
			checks.push(
				result.code === 0
					? {
							name: `kube-rbac-${verb}-${resource}`,
							ok: true,
							detail: `can ${verb} ${resource} in ${namespace}`,
						}
					: {
							name: `kube-rbac-${verb}-${resource}`,
							ok: false,
							detail: `cannot ${verb} ${resource} in namespace ${namespace}`,
							remediation: `grant the context's identity ${verb} on ${resource} in namespace ${namespace} (namespace-scoped Role; no cluster-wide grant is needed)`,
						},
			);
		}
	} else {
		checks.push(skipped("kube-rbac", "RBAC verbs"));
	}

	// 6. Storage: the pinned StorageClass must exist; when the profile omits a
	//    class the cluster must offer exactly one default (an unset
	//    storageClassName is only usable when a default backs it).
	if (profile.storage?.class !== undefined) {
		if (!apiReady) {
			checks.push(skipped("kube-storageclass", "StorageClass existence"));
		} else {
			const storageClass = profile.storage.class;
			const result = await exec([...base, "get", "storageclass", storageClass, "-o", "name"]);
			checks.push(
				result.code === 0
					? { name: "kube-storageclass", ok: true, detail: `StorageClass ${storageClass} exists` }
					: {
							name: "kube-storageclass",
							ok: false,
							detail: `StorageClass ${storageClass}: ${result.stderr.trim() || `exit ${result.code}`}`,
							remediation: `ask the operator to provision StorageClass ${storageClass} or change providerProfiles.${profile.id}.storage.class; the provider never creates storage classes`,
						},
			);
		}
	} else if (!apiReady) {
		checks.push(skipped("kube-default-storageclass", "the default StorageClass"));
	} else {
		const result = await exec([...base, "get", "storageclass", "-o", "json"]);
		const items = result.code === 0 ? storageClassItems(result.stdout) : null;
		if (items === null) {
			checks.push({
				name: "kube-default-storageclass",
				ok: false,
				detail: `could not list StorageClasses: ${result.stderr.trim() || `exit ${result.code}`}`,
				remediation: `grant the context's identity get on storageclasses, or pin providerProfiles.${profile.id}.storage.class`,
			});
		} else {
			const defaults = items.filter(isDefaultStorageClass);
			checks.push(
				defaults.length === 1
					? {
							name: "kube-default-storageclass",
							ok: true,
							detail: `default StorageClass ${String(asRecord(defaults[0]?.metadata)?.name ?? "unknown")} backs an omitted storage.class`,
						}
					: {
							name: "kube-default-storageclass",
							ok: false,
							detail:
								defaults.length === 0
									? "the profile omits storage.class and the cluster has no default StorageClass"
									: `the profile omits storage.class and the cluster has ${defaults.length} default StorageClasses (ambiguous)`,
							remediation: `pin providerProfiles.${profile.id}.storage.class, or ask the operator to mark exactly one StorageClass default (storageclass.kubernetes.io/is-default-class=true)`,
						},
			);
		}
	}

	// 7. Secret references must resolve (name + key) before first launch.
	let secretRefs: KubernetesConfig["secretRefs"] = {};
	try {
		secretRefs = parseSecretRefs(profile.secretRefs);
	} catch (cause) {
		checks.push({
			name: "kube-secretrefs",
			ok: false,
			detail: String(cause instanceof Error ? cause.message : cause),
			remediation: `fix providerProfiles.${profile.id}.secretRefs entries to "<secretName>/<key>"`,
		});
	}
	for (const ref of Object.values(secretRefs)) {
		if (!apiReady || !namespaceReady || namespace === undefined) {
			checks.push(skipped(`kube-secret-${ref.envName}`, `secret ${ref.secretName}`));
			continue;
		}
		const result = await exec([
			...base,
			"get",
			"secret",
			ref.secretName,
			"-n",
			namespace,
			"-o",
			"json",
		]);
		if (result.code !== 0) {
			checks.push({
				name: `kube-secret-${ref.envName}`,
				ok: false,
				detail: `secret ${ref.secretName}: ${result.stderr.trim() || `exit ${result.code}`}`,
				remediation: `ask the operator to create secret ${ref.secretName} in namespace ${namespace} with key ${ref.secretKey}; the provider never creates secrets`,
			});
			continue;
		}
		try {
			const secret = JSON.parse(result.stdout) as Record<string, unknown>;
			const data = asRecord(secret.data) ?? {};
			checks.push(
				Object.hasOwn(data, ref.secretKey)
					? {
							name: `kube-secret-${ref.envName}`,
							ok: true,
							detail: `secret ${ref.secretName} key ${ref.secretKey} resolves for env ${ref.envName}`,
						}
					: {
							name: `kube-secret-${ref.envName}`,
							ok: false,
							detail: `secret ${ref.secretName} exists but has no key ${ref.secretKey}`,
							remediation: `add key ${ref.secretKey} to secret ${ref.secretName} in namespace ${namespace}`,
						},
			);
		} catch {
			checks.push({
				name: `kube-secret-${ref.envName}`,
				ok: false,
				detail: `secret ${ref.secretName} returned unparseable JSON`,
				remediation: "inspect the API response for the secret manually",
			});
		}
	}

	// 8. Image: declared; pullability is observed at first pod start
	//    (ImagePullBackOff surfaces as an actionable ensure-running failure).
	if (profile.image === undefined || profile.image.trim() === "") {
		checks.push({
			name: "kube-image",
			ok: false,
			detail: "profile has no image",
			remediation: `set providerProfiles.${profile.id}.image to the session-runtime image (see runtime/image/Containerfile)`,
		});
	} else {
		checks.push({
			name: "kube-image",
			ok: true,
			detail: `image ${profile.image}; pullability is verified at first pod start, ensure the cluster can pull this reference (imagePullSecrets are namespace-scoped and operator-managed)`,
		});
	}

	return {
		ok: checks.every((check) => check.ok),
		profileId: profile.id,
		provider: "kubernetes",
		checks,
	};
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
