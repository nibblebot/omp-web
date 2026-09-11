/**
 * Kubernetes object identity and manifests for the workspace provider.
 *
 * Nothing here talks to the API: the label/annotation vocabulary, the SINGLE
 * ownership validator every operation shares, the metadata navigation used to
 * read objects back, and the pure Pod/PVC/ConfigMap builders. The provider
 * executable keeps the stateful lifecycle (records, handoff, locking, ops).
 */

import { OMP_PROVIDER_PROTO } from "../../../shared/provider-protocol";
import type { ProviderRequest } from "../../../shared/provider-protocol";
import type { KubernetesConfig } from "./config";

// ---------------------------------------------------------------------------
// In-pod layout and environment vocabulary
// ---------------------------------------------------------------------------

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

/** Runtime uid/gid the pod runs as (the PVC's fsGroup). */
const RUNTIME_UID = 10001;

/** Env key for the image-owned SSH wrapper (runtime/image/git-ssh.sh). */
const GIT_SSH_COMMAND_ENV_KEY = "GIT_SSH_COMMAND";
/** Absolute wrapper path inside the session-runtime image (see the Containerfile). */
const POD_GIT_SSH_COMMAND = "/opt/omp-web/runtime/image/git-ssh.sh";

// Label/annotation vocabulary. Every object the provider creates carries
// the managed-by label; the provider refuses to mutate or delete any
// object that does not carry the whole identity below.
const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_PART_OF = "app.kubernetes.io/part-of";
const LABEL_PROFILE = "omp-web.omp.dev/profile-id";
const LABEL_GENERATION = "omp-web.omp.dev/generation";
const LABEL_RESOURCE_ID = "omp-web.omp.dev/resource-id";
const ANN_WORKSPACE_ID = "omp-web.omp.dev/workspace-id";
export const ANN_WORKSPACE_TOKEN = "omp-web.omp.dev/workspace-token";
const ANN_PROFILE_ID = "omp-web.omp.dev/profile-id";
const ANN_NAMESPACE_UID = "omp-web.omp.dev/namespace-uid";
export const ANN_CALLBACK_DIGEST = "omp-web.omp.dev/callback-credential-digest";
const ANN_SOURCE_PIN_DIGEST = "omp-web.omp.dev/source-pin-digest";
const MANAGED_BY_VALUE = "omp-web";
const PART_OF_VALUE = "omp-web-clones";

/** Exact positive decimal generation label ("01", "1x", "+1", "1.0" rejected). */
const GENERATION_LABEL_RE = /^[1-9][0-9]*$/;

// ---------------------------------------------------------------------------
// Metadata navigation (plain records, no schema dependency)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export interface ObjectMeta {
	uid: string;
	deletionTimestamp: string | null;
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

export function objectMeta(object: Record<string, unknown>): ObjectMeta {
	const metadata = asRecord(object.metadata) ?? {};
	return {
		uid: typeof metadata.uid === "string" ? metadata.uid : "",
		deletionTimestamp:
			typeof metadata.deletionTimestamp === "string" ? metadata.deletionTimestamp : null,
		labels: (asRecord(metadata.labels) ?? {}) as Record<string, string>,
		annotations: (asRecord(metadata.annotations) ?? {}) as Record<string, string>,
	};
}

export function podPhase(pod: Record<string, unknown>): string {
	const status = asRecord(pod.status);
	return typeof status?.phase === "string" ? status.phase : "Unknown";
}

export function podStartTime(pod: Record<string, unknown>): number | undefined {
	const status = asRecord(pod.status);
	if (typeof status?.startTime !== "string") return undefined;
	const ms = Date.parse(status.startTime);
	return Number.isNaN(ms) ? undefined : ms;
}

/** First waiting/terminated container reason, for actionable failures. */
export function podContainerReason(pod: Record<string, unknown>): string | null {
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

export function pvcMeta(pvc: Record<string, unknown>): ObjectMeta & {
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

/** Values an object's metadata must carry before this workspace may touch it. */
export interface WorkspaceOwnership {
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
export function ownershipReason(
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

/** Build the complete identity stamped onto (and read back from) an object. */
export function objectIdentity(
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
export function baselineConfigMapName(cfg: KubernetesConfig): string {
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
