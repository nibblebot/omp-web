/**
 * Kubernetes requirement preflight (P5.6). Split out of the provider
 * executable so `runtime/preflight.ts` can run these checks in process; the
 * provider executable no longer owns them.
 *
 * Only reads plus `auth can-i` access reviews reach the cluster: nothing is
 * installed, created, or mutated, and no Pod is ever created to probe from.
 * Every check that can fail carries an actionable remediation, and every
 * check runs (a cluster-dependent check reports its dependency failure
 * instead of being skipped silently).
 */

import type { ProviderProfile } from "../../../shared/provider-protocol";
import type { PreflightCheck, PreflightResult } from "../../preflight";
import { parseSecretRefs } from "./config";
import type { KubernetesConfig } from "./config";
import { defaultKubeExec, KUBE_REQUEST_TIMEOUT } from "./kubectl";
import type { KubeExec } from "./kubectl";
import { asRecord } from "./resources";

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
 * Production-profile preflight for a kubernetes profile. The kubectl executor
 * is injected by the caller (`runtime/preflight.ts` threads the executor the
 * provider itself uses; tests inject a fake), so an unspawnable client
 * surfaces as a failed row rather than an escaping exception.
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
