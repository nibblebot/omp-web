/**
 * Kubernetes provider configuration resolution (operator-explicit; no ambient
 * discovery) plus the secret-reference parser shared with preflight. Every
 * failure here happens BEFORE any cluster call: the persisted binding is
 * authoritative for context/namespace/namespaceUid and the Pod/PVC name, and a
 * profile (or request) that disagrees with it is a conflict, never a silent
 * re-resolution.
 */

import {
	computeSourcePinDigest,
	ProviderProtocolError,
	RESOURCE_IDENTITY_RE,
	validateKubernetesSource,
} from "../../../shared/provider-protocol";
import type { KubernetesBinding, ProviderRequest } from "../../../shared/provider-protocol";
import { PrepareWorkspaceError, validateWorkspaceRef } from "../../prepare-workspace";
import { KUBERNETES_RESERVED_ENV_KEYS, RESERVED_SECRET_ENV_KEYS } from "../../sandbox-env";

const DEFAULT_STORAGE_SIZE = "10Gi";

export interface KubernetesConfig {
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

/**
 * Names the provider, the sandbox allowlist, or the callback handoff own. A
 * profile `secretRefs` key may never be one of them: Kubernetes resolves a
 * duplicate env name to the LAST entry and the provider appends Secret-backed
 * refs after its fixed entries, so a shadowing reference would let a Secret
 * replace a provider-owned input (for example the fleet-pinned preparation
 * remote or the daemon's launch token). Checked here, before any API call.
 */
const RESERVED_ENV_NAMES: Record<string, true> = {};
for (const name of [...RESERVED_SECRET_ENV_KEYS, ...KUBERNETES_RESERVED_ENV_KEYS]) {
	RESERVED_ENV_NAMES[name] = true;
}

export function parseSecretRefs(
	secretRefs: Record<string, string> | undefined,
): Record<string, { secretName: string; secretKey: string; envName: string }> {
	const out: KubernetesConfig["secretRefs"] = {};
	for (const [envName, ref] of Object.entries(secretRefs ?? {})) {
		if (!ENV_NAME_RE.test(envName)) {
			throw ProviderProtocolError.invalidRequest(
				`profile.secretRefs key ${JSON.stringify(envName)} is not a valid environment variable name`,
			);
		}
		if (RESERVED_ENV_NAMES[envName] === true) {
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
 */
export function resolveConfig(
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
