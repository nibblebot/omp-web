/**
 * Offline contract tests for the kubernetes provider (P5.3).
 *
 * Every case drives the exported `runOp` / `preflightKubernetesProfile` seam
 * against a stateful fake kubectl: no cluster, no kubectl binary, no network.
 * The fake implements the exact call shapes the provider issues (explicit
 * `--context`, `--ignore-not-found` GETs, `create -f -` manifests on stdin,
 * `--wait=false` deletes, `auth can-i`, secret/storage-class lookups) and owns
 * the objects the provider creates, so each case can assert the response
 * envelope AND what happened to the cluster.
 *
 * Converted from the throwaway offline smoke harness: the fixtures carry the
 * frozen `providerProto: 2` contract, the persisted Kubernetes binding, and the
 * callback-env handoff; every state directory comes from testkit `tempDir()`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LockHeldError, acquireFileLock } from "../../shared/file-lock";
import {
	OMP_PROVIDER_PROTO,
	ProviderProtocolError,
	computeSourcePinDigest,
	parseProcStartTime,
	validateProviderRequest,
	type KubernetesBinding,
	type ProviderErrorCode,
	type ProviderErrorResponse,
	type ProviderObserved,
	type ProviderOkResponse,
	type ProviderProfile,
	type ProviderRequest,
	type ProviderResponse,
} from "../../shared/provider-protocol";
import { cleanupTempDirs, tempDir } from "../../shared/testkit";
import { CALLBACK_ENV_FILE, writeCallbackEnvFile } from "../callback-env";
import type { PreflightCheck, PreflightResult } from "../preflight";
import { preflightKubernetesProfile } from "./kubernetes/preflight";
import { runOp } from "./kubernetes-provider";
import type { KubeExec, KubeExecResult } from "./kubernetes/kubectl";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const NAMESPACE = "omp-clones";
const NAMESPACE_UID = "namespace-uid-1";
const REPLACED_NAMESPACE_UID = "namespace-uid-2";
const CONTEXT = "k8s-contract-context";
const WORKSPACE_ID = "ws-1";
const PROFILE_ID = "k8s-dev";
const IMAGE = "registry.example.com/omp-web/session-runtime:1.0.0";
const RESOURCE_IDENTITY = "0123456789abcdef0123456789abcdef";
const RESOURCE_NAME = `omp-ws-${RESOURCE_IDENTITY}`;
const REVISION = "1111111111111111111111111111111111111111";
const BRANCH = "main";
const SOURCE_REMOTE = "https://git.example.com/team/repo.git";
const CALLBACK_URL = "https://fleet.example.com/callback/up";
/** 64 lowercase hex characters = the enrolled 32-byte callback credential. */
const CALLBACK_TOKEN = "0f".repeat(32);
const CALLBACK_DIGEST = createHash("sha256")
	.update(Buffer.from(CALLBACK_TOKEN, "hex"))
	.digest("hex");
const MODEL_SECRET_NAME = "omp-model-secret";
const MODEL_SECRET_KEY = "key";
/** Fixed pod start time: `startedAt` must not depend on the wall clock. */
const POD_START_TIME = "2026-01-01T00:00:00.000Z";
const UNREACHABLE = "The connection to the server localhost:8080 was refused";

/** Sanitized baseline documents the fleet ships for a provider-side volume. */
const BASELINE_CONFIG_YAML =
	"# Seeded from the operator's global config by omp-web (allowlisted agent-behavior keys only).\n" +
	"{modelRoles: {default: openrouter/deepseek/deepseek-v4.1-flash:high}}\n";
const BASELINE_MODELS_YAML = "{providers: {}}\n";
const BASELINE = { configYaml: BASELINE_CONFIG_YAML, modelsYaml: BASELINE_MODELS_YAML };
/** Name the provider derives for the workspace-scoped baseline ConfigMap. */
const BASELINE_CM_NAME = `${RESOURCE_NAME}-baseline`;

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

// ---------------------------------------------------------------------------
// Harness: stateful fake kubectl + fixtures (shared by every case)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asStringMap(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(asRecord(value))) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
}

function kubeOk(stdout = ""): KubeExecResult {
	return { code: 0, stdout, stderr: "" };
}

function kubeJson(value: unknown): KubeExecResult {
	return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function kubeFail(stderr: string): KubeExecResult {
	return { code: 1, stdout: "", stderr };
}

function alreadyExists(kind: string, name: string): KubeExecResult {
	return kubeFail(
		`Error from server (AlreadyExists): ${kind.toLowerCase()}s ${JSON.stringify(name)} already exists`,
	);
}

/** The API's `DeleteOptions.preconditions.uid` check, as the server enforces it. */
function uidPrecondition(currentUid: string, expectedUid: string | null): KubeExecResult | null {
	if (expectedUid === null || expectedUid === currentUid) return null;
	return kubeFail(
		`Error from server (Conflict): Precondition failed: UID ${JSON.stringify(expectedUid)} does not match ${JSON.stringify(currentUid)}`,
	);
}

interface FakeCall {
	bin: string;
	context: string | null;
	args: string[];
	input: string | undefined;
}

interface FakePod {
	name: string;
	uid: string;
	phase: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	containerReason: string | null;
	/** The exact manifest the provider POSTed, for render assertions. */
	manifest: Record<string, unknown>;
	/** A DELETE was acknowledged but the object is still terminating. */
	deleting?: boolean;
}

interface FakePvc {
	name: string;
	uid: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	storageClassName: string | undefined;
	size: string | undefined;
	accessModes: string[];
	manifest: Record<string, unknown>;
	deleting?: boolean;
}

interface FakeConfigMap {
	name: string;
	uid: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	data: Record<string, string>;
	manifest: Record<string, unknown>;
	deleting?: boolean;
}

function configMapObject(cm: FakeConfigMap, namespace: string): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		name: cm.name,
		namespace,
		uid: cm.uid,
		labels: cm.labels,
		annotations: cm.annotations,
	};
	if (cm.deleting === true) metadata["deletionTimestamp"] = POD_START_TIME;
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata,
		data: cm.data,
	};
}

function podObject(pod: FakePod, namespace: string): Record<string, unknown> {
	const status: Record<string, unknown> = { phase: pod.phase, startTime: POD_START_TIME };
	if (pod.containerReason !== null) {
		status.containerStatuses = [
			pod.phase === "Failed" || pod.phase === "Succeeded"
				? { name: "session", state: { terminated: { reason: pod.containerReason } } }
				: { name: "session", state: { waiting: { reason: pod.containerReason } } },
		];
	}
	const metadata: Record<string, unknown> = {
		name: pod.name,
		namespace,
		uid: pod.uid,
		labels: pod.labels,
		annotations: pod.annotations,
	};
	if (pod.deleting === true) metadata["deletionTimestamp"] = POD_START_TIME;
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata,
		status,
	};
}

function pvcObject(pvc: FakePvc, namespace: string): Record<string, unknown> {
	const spec: Record<string, unknown> = {
		accessModes: pvc.accessModes,
		volumeMode: "Filesystem",
		resources: { requests: { storage: pvc.size } },
	};
	if (pvc.storageClassName !== undefined) spec.storageClassName = pvc.storageClassName;
	const metadata: Record<string, unknown> = {
		name: pvc.name,
		namespace,
		uid: pvc.uid,
		labels: pvc.labels,
		annotations: pvc.annotations,
	};
	if (pvc.deleting === true) metadata["deletionTimestamp"] = POD_START_TIME;
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata,
		spec,
	};
}

class FakeCluster {
	readonly pods = new Map<string, FakePod>();
	readonly pvcs = new Map<string, FakePvc>();
	readonly configMaps = new Map<string, FakeConfigMap>();
	readonly namespaces = new Map<string, string>([[NAMESPACE, NAMESPACE_UID]]);
	/** StorageClass name -> carries a default-class annotation. */
	readonly storageClasses = new Map<string, boolean>([["standard", false]]);
	readonly secrets = new Map<string, { data: Record<string, string> }>([
		[MODEL_SECRET_NAME, { data: { [MODEL_SECRET_KEY]: "c2VjcmV0LXZhbHVl" } }],
	]);
	readonly rbac = new Set<string>();
	readonly calls: FakeCall[] = [];
	/** Manifest kinds in POST order: exactly what the provider created. */
	readonly createdKinds: string[] = [];
	readonly deletedKinds: string[] = [];
	reachable = true;
	context = CONTEXT;
	kubectlPresent = true;
	/** Phase freshly created pods carry; null means Pending -> Running settle. */
	createPodPhase: string | null = null;
	createPodReason: string | null = null;
	/** Fires when an observed Pending pod settles to Running. */
	onPodRunning: ((name: string) => void) | null = null;
	/**
	 * True (the default) settles a Pending pod to Running on its first read.
	 * A case that must observe a Pod stuck before its container starts (a
	 * peer's launch still in flight) turns this off.
	 */
	settlePendingPods = true;
	podCreates = 0;
	/** Kinds whose DELETE is acknowledged but completes on the next GET. */
	readonly holdDeletes = new Set<string>();
	/** Fires immediately before a DELETE is evaluated. */
	onBeforeDelete: ((kind: string, name: string) => void) | null = null;
	/** Fires before the namespace is read (to model a mid-operation replace). */
	onNamespaceRead: (() => void) | null = null;
	private uidSeq = 0;

	constructor() {
		for (const verb of ["get", "create", "delete"]) {
			for (const resource of ["pods", "persistentvolumeclaims", "configmaps"]) {
				this.rbac.add(`${verb}:${resource}:${NAMESPACE}`);
			}
		}
	}

	nextUid(kind: string): string {
		this.uidSeq += 1;
		return `uid-${kind}-${this.uidSeq}`;
	}

	/**
	 * A fresh pod is observed Pending once (the provider's post-create read),
	 * then settles to Running for the next read (its wait probe): deterministic
	 * without timers.
	 */
	readPod(pod: FakePod): Record<string, unknown> {
		const snapshot: FakePod = { ...pod };
		if (pod.phase === "Pending" && this.settlePendingPods) {
			pod.phase = "Running";
			this.onPodRunning?.(pod.name);
		}
		return podObject(snapshot, NAMESPACE);
	}

	create(manifest: Record<string, unknown>): KubeExecResult {
		const kind = String(manifest["kind"] ?? "");
		const metadata = asRecord(manifest["metadata"]);
		const spec = asRecord(manifest["spec"]);
		const name = String(metadata["name"] ?? "");
		const labels = asStringMap(metadata["labels"]);
		const annotations = asStringMap(metadata["annotations"]);
		if (kind === "Pod") {
			if (this.pods.has(name)) return alreadyExists(kind, name);
			this.createdKinds.push(kind);
			this.podCreates += 1;
			const pod: FakePod = {
				name,
				uid: this.nextUid("pod"),
				phase: this.createPodPhase ?? "Pending",
				labels,
				annotations,
				containerReason: this.createPodReason,
				manifest,
			};
			this.pods.set(name, pod);
			return kubeJson(podObject(pod, NAMESPACE));
		}
		if (kind === "PersistentVolumeClaim") {
			if (this.pvcs.has(name)) return alreadyExists(kind, name);
			this.createdKinds.push(kind);
			const requests = asRecord(asRecord(spec["resources"])["requests"]);
			const pvc: FakePvc = {
				name,
				uid: this.nextUid("pvc"),
				labels,
				annotations,
				storageClassName:
					typeof spec["storageClassName"] === "string" ? spec["storageClassName"] : undefined,
				size: typeof requests["storage"] === "string" ? requests["storage"] : undefined,
				accessModes: Array.isArray(spec["accessModes"])
					? spec["accessModes"].filter((mode): mode is string => typeof mode === "string")
					: [],
				manifest,
			};
			this.pvcs.set(name, pvc);
			return kubeJson(pvcObject(pvc, NAMESPACE));
		}
		if (kind === "ConfigMap") {
			if (this.configMaps.has(name)) return alreadyExists(kind, name);
			this.createdKinds.push(kind);
			const data: Record<string, string> = {};
			for (const [key, entry] of Object.entries(asRecord(manifest["data"]))) {
				if (typeof entry === "string") data[key] = entry;
			}
			const cm: FakeConfigMap = {
				name,
				uid: this.nextUid("configmap"),
				labels,
				annotations,
				data,
				manifest,
			};
			this.configMaps.set(name, cm);
			return kubeJson(configMapObject(cm, NAMESPACE));
		}
		return kubeFail(`unsupported create ${kind}`);
	}

	delete(kind: string, name: string, expectedUid: string | null): KubeExecResult {
		this.onBeforeDelete?.(kind, name);
		if (kind === "pod") {
			const pod = this.pods.get(name);
			if (pod === undefined) {
				return kubeFail(`Error from server (NotFound): pods ${JSON.stringify(name)} not found`);
			}
			const precondition = uidPrecondition(pod.uid, expectedUid);
			if (precondition !== null) return precondition;
			this.deletedKinds.push(kind);
			if (this.holdDeletes.has(kind)) pod.deleting = true;
			else this.pods.delete(name);
			return kubeOk();
		}
		if (kind === "persistentvolumeclaim") {
			const pvc = this.pvcs.get(name);
			if (pvc === undefined) {
				return kubeFail(
					`Error from server (NotFound): persistentvolumeclaims ${JSON.stringify(name)} not found`,
				);
			}
			const precondition = uidPrecondition(pvc.uid, expectedUid);
			if (precondition !== null) return precondition;
			this.deletedKinds.push(kind);
			if (this.holdDeletes.has(kind)) pvc.deleting = true;
			else this.pvcs.delete(name);
			return kubeOk();
		}
		if (kind === "configmap") {
			const cm = this.configMaps.get(name);
			if (cm === undefined) {
				return kubeFail(
					`Error from server (NotFound): configmaps ${JSON.stringify(name)} not found`,
				);
			}
			const precondition = uidPrecondition(cm.uid, expectedUid);
			if (precondition !== null) return precondition;
			this.deletedKinds.push(kind);
			if (this.holdDeletes.has(kind)) cm.deleting = true;
			else this.configMaps.delete(name);
			return kubeOk();
		}
		return kubeFail(`unsupported delete ${kind}`);
	}
}

/** The provider's offline dependency seam (OpDeps in kubernetes-provider.ts). */
interface OpDeps {
	exec: KubeExec;
	env: Record<string, string | undefined>;
	ensureWaitMs: number;
	stopWaitMs: number;
	deleteWaitMs: number;
	lockWaitMs: number;
}

function makeExec(cluster: FakeCluster): KubeExec {
	return async (argv, input) => {
		const args = [...argv];
		const bin = args.shift() ?? "";
		let context: string | null = null;
		const rest: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] as string;
			if (arg === "--context") {
				context = args[++i] as string;
				continue;
			}
			if (arg.startsWith("--request-timeout=")) continue;
			rest.push(arg);
		}
		cluster.calls.push({ bin, context, args: rest, input });

		let namespace: string | null = null;
		let outputJson = false;
		let fromStdin = false;
		let clientOnly = false;
		let ignoreNotFound = false;
		let rawPath: string | null = null;
		const positional: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i] as string;
			if (arg.startsWith("--raw=")) {
				rawPath = arg.slice("--raw=".length);
				continue;
			}
			if (arg === "-n" || arg === "--namespace") {
				namespace = rest[++i] as string;
				continue;
			}
			if (arg === "-o") {
				outputJson = rest[++i] === "json";
				continue;
			}
			if (arg === "-f") {
				fromStdin = rest[++i] === "-";
				continue;
			}
			if (arg === "--client") {
				clientOnly = true;
				continue;
			}
			if (arg === "--ignore-not-found") {
				ignoreNotFound = true;
				continue;
			}
			if (arg.startsWith("-")) continue;
			positional.push(arg);
		}
		const verb = positional[0] ?? "";
		const kind = positional[1];
		const name = positional[2];

		if (verb === "version") {
			if (clientOnly) {
				return cluster.kubectlPresent
					? kubeJson({ clientVersion: { gitVersion: "v1.29.0" } })
					: kubeFail("kubectl: command not found");
			}
			return cluster.reachable
				? kubeJson({ serverVersion: { gitVersion: "v1.29.0" } })
				: kubeFail(UNREACHABLE);
		}
		if (!cluster.reachable) return kubeFail(UNREACHABLE);
		if (context !== cluster.context) {
			return kubeFail(`context ${JSON.stringify(context)} does not exist`);
		}

		if (verb === "get" && kind === "namespace") {
			cluster.onNamespaceRead?.();
			const uid = cluster.namespaces.get(name as string);
			if (uid === undefined) {
				if (ignoreNotFound) return kubeOk();
				return kubeFail(
					`Error from server (NotFound): namespaces ${JSON.stringify(name)} not found`,
				);
			}
			return outputJson
				? kubeJson({ apiVersion: "v1", kind: "Namespace", metadata: { name, uid } })
				: kubeOk();
		}
		if (verb === "get" && kind === "storageclass") {
			if (name === undefined) {
				return kubeJson({
					apiVersion: "storage.k8s.io/v1",
					kind: "StorageClassList",
					items: [...cluster.storageClasses].map(([storageClass, isDefault]) => ({
						metadata: {
							name: storageClass,
							annotations: isDefault
								? { "storageclass.kubernetes.io/is-default-class": "true" }
								: {},
						},
					})),
				});
			}
			if (!cluster.storageClasses.has(name)) {
				return kubeFail(
					`Error from server (NotFound): storageclasses.storage.k8s.io ${JSON.stringify(name)} not found`,
				);
			}
			return kubeOk();
		}
		if (verb === "auth" && kind === "can-i") {
			const canVerb = positional[2] ?? "";
			const resource = positional[3] ?? "";
			return cluster.rbac.has(`${canVerb}:${resource}:${namespace}`) ? kubeOk() : kubeFail("no");
		}
		if (verb === "get" && kind === "secret") {
			const secret = cluster.secrets.get(name as string);
			if (secret === undefined) {
				return kubeFail(`Error from server (NotFound): secrets ${JSON.stringify(name)} not found`);
			}
			return kubeJson(secret);
		}
		if (verb === "get" && kind === "pod") {
			const pod = cluster.pods.get(name as string);
			if (pod === undefined) return kubeOk();
			const object = cluster.readPod(pod);
			if (pod.deleting === true) cluster.pods.delete(pod.name);
			return kubeJson(object);
		}
		if (verb === "get" && kind === "persistentvolumeclaim") {
			const pvc = cluster.pvcs.get(name as string);
			if (pvc === undefined) return kubeOk();
			const object = pvcObject(pvc, namespace ?? NAMESPACE);
			if (pvc.deleting === true) cluster.pvcs.delete(name as string);
			return kubeJson(object);
		}
		if (verb === "get" && kind === "configmap") {
			const cm = cluster.configMaps.get(name as string);
			if (cm === undefined) return kubeOk();
			const object = configMapObject(cm, namespace ?? NAMESPACE);
			if (cm.deleting === true) cluster.configMaps.delete(name as string);
			return kubeJson(object);
		}
		if (verb === "create") {
			if (!fromStdin || input === undefined) return kubeFail("create requires -f -");
			return cluster.create(JSON.parse(input) as Record<string, unknown>);
		}
		if (verb === "delete") {
			if (rawPath === null) return kubeFail("delete requires --raw");
			const segments = rawPath.split("/");
			const pathNamespace = segments[4] ?? "";
			const plural = segments[5] ?? "";
			const objectName = segments[6] ?? "";
			const deleteKind =
				plural === "pods"
					? "pod"
					: plural === "persistentvolumeclaims"
						? "persistentvolumeclaim"
						: plural === "configmaps"
							? "configmap"
							: "";
			if (deleteKind === "") return kubeFail(`unsupported raw delete ${rawPath}`);
			if (pathNamespace !== NAMESPACE) {
				return kubeFail(
					`Error from server (NotFound): namespaces ${JSON.stringify(pathNamespace)} not found`,
				);
			}
			let expectedUid: string | null = null;
			if (input !== undefined) {
				const body = JSON.parse(input) as { preconditions?: { uid?: unknown } };
				if (typeof body.preconditions?.uid === "string") expectedUid = body.preconditions.uid;
			}
			return cluster.delete(deleteKind, objectName, expectedUid);
		}
		return kubeFail(`unsupported kubectl invocation: ${positional.join(" ")}`);
	};
}

interface RequestOverrides {
	generation?: number;
	profile?: ProviderProfile;
	workspaceId?: string;
	binding?: Partial<KubernetesBinding>;
	/** null omits the field entirely (an untrusted or incomplete request). */
	source?: ProviderRequest["source"] | null;
	revision?: string | null;
	branch?: string | null;
	/** Omitted entirely when unset (a fleet with nothing to seed). */
	baseline?: ProviderRequest["baseline"];
}

interface HandoffOverrides {
	workspaceId?: string;
	generation?: number;
	env?: Record<string, string>;
}

interface KubeHarness {
	cluster: FakeCluster;
	stateDir: string;
	deps: OpDeps;
	handoffEnv(generation?: number): Record<string, string>;
	writeHandoff(over?: HandoffOverrides): void;
	writeRawHandoff(value: unknown): void;
	request(op: ProviderRequest["op"], over?: RequestOverrides): ProviderRequest;
	run(
		op: ProviderRequest["op"],
		over?: RequestOverrides,
		overrides?: Partial<OpDeps>,
	): Promise<ProviderResponse>;
	preflight(profile?: ProviderProfile): Promise<PreflightResult>;
}

function kubernetesProfile(over: Partial<ProviderProfile> = {}): ProviderProfile {
	return {
		id: PROFILE_ID,
		provider: "kubernetes",
		executable: "/opt/omp-web/providers/kubernetes-provider",
		tools: [],
		image: IMAGE,
		namespace: NAMESPACE,
		context: CONTEXT,
		resources: { cpu: "1", memory: "2Gi" },
		storage: { class: "standard", size: "10Gi" },
		secretRefs: { OMP_MODEL_KEY: `${MODEL_SECRET_NAME}/${MODEL_SECRET_KEY}` },
		...over,
	};
}

function createHarness(): KubeHarness {
	const cluster = new FakeCluster();
	const stateDir = tempDir("kube-provider-");
	const exec = makeExec(cluster);
	const deps: OpDeps = {
		exec,
		env: { OMP_KUBE_BIN: "kubectl" },
		ensureWaitMs: 200,
		stopWaitMs: 200,
		deleteWaitMs: 200,
		lockWaitMs: 250,
	};

	const handoffEnv = (generation = 1): Record<string, string> => ({
		OMP_SESSION_CALLBACK_URL: CALLBACK_URL,
		OMP_SESSION_CALLBACK_WORKSPACE: WORKSPACE_ID,
		OMP_SESSION_CALLBACK_GENERATION: String(generation),
		OMP_SESSION_CALLBACK_TOKEN: CALLBACK_TOKEN,
	});
	const writeHandoff = (over: HandoffOverrides = {}): void => {
		const generation = over.generation ?? 1;
		writeCallbackEnvFile(stateDir, {
			version: 1,
			workspaceId: over.workspaceId ?? WORKSPACE_ID,
			generation,
			env: over.env ?? handoffEnv(generation),
		});
	};
	const writeRawHandoff = (value: unknown): void => {
		writeFileSync(join(stateDir, CALLBACK_ENV_FILE), `${JSON.stringify(value)}\n`, { mode: 0o600 });
	};
	const request = (op: ProviderRequest["op"], over: RequestOverrides = {}): ProviderRequest => {
		const built: ProviderRequest = {
			providerProto: OMP_PROVIDER_PROTO,
			op,
			workspaceId: over.workspaceId ?? WORKSPACE_ID,
			generation: over.generation ?? 1,
			workspaceDir: "/workspace/ws-1/.checkout",
			homeDir: "/workspace/ws-1/.home",
			profile: over.profile ?? kubernetesProfile(),
			stateDir,
			kubernetes: {
				resourceIdentity: RESOURCE_IDENTITY,
				context: CONTEXT,
				namespace: NAMESPACE,
				namespaceUid: NAMESPACE_UID,
				...over.binding,
			},
		};
		if (over.source !== null) built.source = over.source ?? { remote: SOURCE_REMOTE };
		if (over.revision !== null) built.revision = over.revision ?? REVISION;
		if (over.branch !== null) built.branch = over.branch ?? BRANCH;
		if (over.baseline !== undefined) built.baseline = over.baseline;
		return built;
	};
	return {
		cluster,
		stateDir,
		deps,
		handoffEnv,
		writeHandoff,
		writeRawHandoff,
		request,
		run: (op, over = {}, overrides = {}) => runOp(request(op, over), { ...deps, ...overrides }),
		preflight: (profile = kubernetesProfile()) =>
			preflightKubernetesProfile(profile, { exec, env: deps.env }),
	};
}

/** Copy a request without one field: an untrusted/incomplete wire payload. */
function withoutField(request: ProviderRequest, field: keyof ProviderRequest): ProviderRequest {
	const clone: Record<string, unknown> = { ...request };
	delete clone[field];
	return clone as unknown as ProviderRequest;
}

function expectOk(response: ProviderResponse, observed: ProviderObserved): ProviderOkResponse {
	if (!response.ok) {
		throw new Error(
			`expected ok:${observed}, got ${response.error.code}: ${response.error.message}`,
		);
	}
	expect(response.providerProto).toBe(OMP_PROVIDER_PROTO);
	expect(response.observed).toBe(observed);
	expect(response.kubernetes).toBeDefined();
	expect(response.handle.startsWith(`k8s:${NAMESPACE}/`)).toBe(true);
	return response;
}

function expectFailure(
	response: ProviderResponse,
	code: ProviderErrorCode,
	retryable: boolean,
	message?: RegExp,
): ProviderErrorResponse {
	if (response.ok) throw new Error(`expected ${code}, got ok:${response.observed}`);
	expect(response.providerProto).toBe(OMP_PROVIDER_PROTO);
	expect(response.error.code).toBe(code);
	expect(response.error.retryable).toBe(retryable);
	if (message !== undefined) expect(response.error.message).toMatch(message);
	return response;
}

/** A malformed wire payload must be refused before dispatch, typed. */
function expectProtocolRejection(payload: unknown): void {
	let thrown: unknown;
	try {
		validateProviderRequest(payload);
	} catch (cause) {
		thrown = cause;
	}
	expect(thrown).toBeInstanceOf(ProviderProtocolError);
	expect((thrown as ProviderProtocolError).code).toBe("invalid_request");
}

function podOf(cluster: FakeCluster, name = RESOURCE_NAME): FakePod {
	const pod = cluster.pods.get(name);
	if (pod === undefined) throw new Error(`fake cluster has no pod ${name}`);
	return pod;
}

function pvcOf(cluster: FakeCluster, name = RESOURCE_NAME): FakePvc {
	const pvc = cluster.pvcs.get(name);
	if (pvc === undefined) throw new Error(`fake cluster has no claim ${name}`);
	return pvc;
}

/** No object was created, mutated, or deleted. */
function expectNoMutations(cluster: FakeCluster): void {
	expect(cluster.pods.size).toBe(0);
	expect(cluster.pvcs.size).toBe(0);
	expect(cluster.createdKinds).toEqual([]);
	expect(cluster.deletedKinds).toEqual([]);
}

function writeLockFile(
	path: string,
	owner: { pid: number; procStartTime: number; name: string; token: string },
): void {
	writeFileSync(path, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function lockPathOf(harness: KubeHarness): string {
	return join(harness.stateDir, "lock");
}

/** Owner token of a lock file written by shared/file-lock.ts. */
function lockTokenOf(path: string): string {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"token" in parsed &&
		typeof parsed.token === "string"
	) {
		return parsed.token;
	}
	throw new Error(`lock file ${path} carries no owner token`);
}

function containerOf(manifest: Record<string, unknown>): Record<string, unknown> {
	const containers = asRecord(manifest["spec"])["containers"];
	const list = Array.isArray(containers) ? containers : [];
	return asRecord(list[0]);
}

function envOf(container: Record<string, unknown>): Map<string, Record<string, unknown>> {
	const list = Array.isArray(container["env"]) ? container["env"] : [];
	const byName = new Map<string, Record<string, unknown>>();
	for (const entry of list) {
		const record = asRecord(entry);
		if (typeof record["name"] === "string") byName.set(record["name"], record);
	}
	return byName;
}

function checkRow(result: PreflightResult, name: string): PreflightCheck {
	const check = result.checks.find((entry) => entry.name === name);
	if (check === undefined) {
		const names = result.checks.map((entry) => entry.name).join(", ");
		throw new Error(`preflight has no ${name} row: ${names}`);
	}
	return check;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

let h: KubeHarness;

beforeEach(() => {
	h = createHarness();
});

afterAll(cleanupTempDirs);

describe("protocol version", () => {
	test("rejects a missing providerProto through runOp before any cluster call", async () => {
		h.writeHandoff();
		const response = await runOp(
			withoutField(h.request("ensure-running"), "providerProto"),
			h.deps,
		);
		expectFailure(response, "invalid_request", false, /providerProto/);
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("rejects a wrong providerProto through runOp before any cluster call", async () => {
		h.writeHandoff();
		for (const version of [1, 3, 0]) {
			const response = await runOp(
				{ ...h.request("ensure-running"), providerProto: version },
				h.deps,
			);
			expectFailure(response, "invalid_request", false, /providerProto/);
		}
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("rejects a stale providerProto at the wire validator", () => {
		const wire: Record<string, unknown> = { ...h.request("ensure-running") };
		const missing = { ...wire };
		delete missing["providerProto"];
		expectProtocolRejection(missing);
		expectProtocolRejection({ ...wire, providerProto: 1 });
		expectProtocolRejection({ ...wire, providerProto: 3 });
		expect(validateProviderRequest({ ...wire, providerProto: OMP_PROVIDER_PROTO }).op).toBe(
			"ensure-running",
		);
	});

	test("accepts a baseline payload and refuses malformed ones", () => {
		const wire: Record<string, unknown> = { ...h.request("ensure-running") };
		const parsed = validateProviderRequest({ ...wire, baseline: BASELINE });
		expect(parsed.baseline).toEqual(BASELINE);

		// config.yml alone is a complete baseline; models.yml is optional.
		const configOnly = validateProviderRequest({
			...wire,
			baseline: { configYaml: BASELINE_CONFIG_YAML },
		});
		expect(configOnly.baseline).toEqual({ configYaml: BASELINE_CONFIG_YAML });

		expectProtocolRejection({ ...wire, baseline: "not an object" });
		expectProtocolRejection({ ...wire, baseline: {} });
		expectProtocolRejection({ ...wire, baseline: { configYaml: "" } });
		expectProtocolRejection({ ...wire, baseline: { configYaml: BASELINE_CONFIG_YAML, extra: 1 } });
		expectProtocolRejection({
			...wire,
			baseline: { configYaml: BASELINE_CONFIG_YAML, modelsYaml: "" },
		});
		// A credential never rides this channel: the field set is closed.
		expectProtocolRejection({
			...wire,
			baseline: { configYaml: BASELINE_CONFIG_YAML, apiKey: "sk-live-not-a-reference" },
		});
	});

	test("a successful operation retains handle and observed", async () => {
		h.writeHandoff();
		const response = expectOk(await h.run("ensure-running"), "running");
		expect(response.handle).toBe(`k8s:${NAMESPACE}/${RESOURCE_NAME}:g1`);
		expect(response.kubernetes).toEqual({
			namespaceUid: NAMESPACE_UID,
			podUid: podOf(h.cluster).uid,
			pvcUid: pvcOf(h.cluster).uid,
		});
		expect(typeof response.startedAt).toBe("number");
	});
});

describe("pre-mutation validation", () => {
	test("refuses source.local on a kubernetes profile", async () => {
		h.writeHandoff();
		const response = await h.run("ensure-running", { source: { local: "/host/checkout" } });
		expectFailure(response, "invalid_request", false, /remote/);
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("refuses remote sources the shared validator rejects", async () => {
		const invalid = [
			"/srv/checkout",
			"file:///srv/checkout",
			"https://user:pass@git.example.com/team/repo.git",
			"https://git.example.com/team/repo.git?ref=main",
			"ssh://git@git.example.com:99999/team/repo.git",
			"ssh://[]/repo",
			"https://[not-an-ipv6]:garbage/repo",
			"ssh://[::1]:70000/repo",
			"https://[::1]:/repo",
		];
		h.writeHandoff();
		for (const remote of invalid) {
			const response = await h.run("ensure-running", { source: { remote } });
			expectFailure(response, "invalid_request", false, /invalid kubernetes source/);
		}
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("accepts an absolute ssh remote carrying a username", async () => {
		h.writeHandoff();
		const response = expectOk(
			await h.run("ensure-running", {
				source: { remote: "ssh://git@git.example.com/team/repo.git" },
			}),
			"running",
		);
		expect(response.kubernetes?.podUid).toBe(podOf(h.cluster).uid);
	});

	test("accepts a bracketed IPv6 host with a port", async () => {
		h.writeHandoff();
		const response = expectOk(
			await h.run("ensure-running", { source: { remote: "ssh://[::1]:2222/team/repo.git" } }),
			"running",
		);
		expect(response.kubernetes?.podUid).toBe(podOf(h.cluster).uid);
	});

	test("requires the binding, remote, revision, branch, and image", async () => {
		h.writeHandoff();
		expectFailure(
			await runOp(withoutField(h.request("ensure-running"), "kubernetes"), h.deps),
			"invalid_request",
			false,
			/requires request\.kubernetes/,
		);
		expectFailure(
			await runOp(withoutField(h.request("ensure-running"), "source"), h.deps),
			"invalid_request",
			false,
			/source\.remote/,
		);
		expectFailure(
			await runOp(withoutField(h.request("ensure-running"), "revision"), h.deps),
			"invalid_request",
			false,
			/revision/,
		);
		expectFailure(
			await runOp(withoutField(h.request("ensure-running"), "branch"), h.deps),
			"invalid_request",
			false,
			/branch/,
		);
		expectFailure(
			await h.run("ensure-running", { profile: kubernetesProfile({ image: undefined }) }),
			"invalid_request",
			false,
			/image/,
		);
		// The provider also syntax-validates the branch through the shared
		// `validateWorkspaceRef` (runtime/prepare-workspace.ts), so a name git
		// rejects is refused before the first kubectl call.
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("rejects reserved or invalid secret reference names before any cluster call", async () => {
		h.writeHandoff();
		const reserved = [
			"HOME",
			"PATH",
			"OMP_PROVIDER_PROTO",
			"OMP_WORKSPACE_DIR",
			"OMP_SESSION_CALLBACK_TOKEN",
			"GIT_SSH_COMMAND",
			// Provider-owned Pod inputs: a shadowing secretRef would let a
			// Secret replace the fleet-pinned preparation tuple or the launch
			// token the daemon matches.
			"OMP_WORKSPACE_TOKEN",
			"OMP_WORKSPACE_ROOT",
			"OMP_PREP_SOURCE_REMOTE",
			"OMP_PREP_REVISION",
			"OMP_PREP_BRANCH",
			"PI_CODING_AGENT_DIR",
			"OMP_SANDBOX_BASELINE_CONFIG",
		];
		for (const envName of reserved) {
			const profile = kubernetesProfile({
				secretRefs: { [envName]: `${MODEL_SECRET_NAME}/${MODEL_SECRET_KEY}` },
			});
			expectFailure(
				await h.run("ensure-running", { profile }),
				"invalid_request",
				false,
				/reserved/,
			);
		}
		for (const envName of ["1BAD", "with-dash", "spaced name"]) {
			const profile = kubernetesProfile({
				secretRefs: { [envName]: `${MODEL_SECRET_NAME}/${MODEL_SECRET_KEY}` },
			});
			expectFailure(
				await h.run("ensure-running", { profile }),
				"invalid_request",
				false,
				/environment variable name/,
			);
		}
		for (const reference of [
			"no-slash",
			"omp-model-secret/",
			"/key",
			"omp-model-secret/key/extra",
		]) {
			const profile = kubernetesProfile({ secretRefs: { OMP_MODEL_KEY: reference } });
			expectFailure(
				await h.run("ensure-running", { profile }),
				"invalid_request",
				false,
				/secretName/,
			);
		}
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("rejects a resourceIdentity that is not 32 lowercase hex", async () => {
		const invalid = [
			"0123456789abcdef0123456789abcde",
			"0123456789abcdef0123456789abcdef0",
			"0123456789ABCDEF0123456789abcdef",
			"0123456789abcdef0123456789abcdeg",
			"",
		];
		h.writeHandoff();
		for (const resourceIdentity of invalid) {
			const response = await h.run("ensure-running", { binding: { resourceIdentity } });
			expectFailure(response, "invalid_request", false, /resourceIdentity/);
		}
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("rejects a non-positive generation before any cluster call", async () => {
		const wire: Record<string, unknown> = { ...h.request("ensure-running") };
		for (const generation of [0, -1]) {
			expectProtocolRejection({ ...wire, generation });
		}
		h.writeHandoff();
		// The handoff is generation-scoped, so a non-positive generation cannot
		// enroll and is refused before any API call.
		expectFailure(
			await h.run("ensure-running", { generation: 0 }),
			"conflict",
			false,
			/generation/,
		);
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("refuses when the callback handoff is absent", async () => {
		expectFailure(
			await h.run("ensure-running"),
			"unavailable",
			true,
			/callback-env\.json is absent/,
		);
		expect(h.cluster.calls).toEqual([]);
		expectNoMutations(h.cluster);
	});

	test("refuses a handoff for another workspace or generation", async () => {
		h.writeHandoff({ workspaceId: "ws-other" });
		expectFailure(await h.run("ensure-running"), "conflict", false, /targets workspace ws-other/);
		h.writeHandoff({ generation: 2 });
		expectFailure(await h.run("ensure-running"), "conflict", false, /stale enrollment/);
		expectNoMutations(h.cluster);
	});

	test("refuses a handoff without a usable 256-bit credential", async () => {
		const base = { version: 1, workspaceId: WORKSPACE_ID, generation: 1 };
		h.writeRawHandoff({
			...base,
			env: {
				OMP_SESSION_CALLBACK_URL: CALLBACK_URL,
				OMP_SESSION_CALLBACK_WORKSPACE: WORKSPACE_ID,
				OMP_SESSION_CALLBACK_GENERATION: "1",
			},
		});
		expectFailure(await h.run("ensure-running"), "unavailable", true, /OMP_SESSION_CALLBACK_TOKEN/);
		h.writeRawHandoff({
			...base,
			env: { ...h.handoffEnv(), OMP_SESSION_CALLBACK_TOKEN: "not-a-credential" },
		});
		expectFailure(await h.run("ensure-running"), "unavailable", true, /256-bit credential/);
		// The fence is the digest derived from this handoff, compared against
		// the launch record and the Pod annotation (the annotation case below);
		// the handoff carries no declared digest key.
		expectNoMutations(h.cluster);
	});

	test("refuses a handoff carrying a disallowed env key", async () => {
		h.writeRawHandoff({
			version: 1,
			workspaceId: WORKSPACE_ID,
			generation: 1,
			env: { ...h.handoffEnv(), FOO: "bar" },
		});
		expectFailure(await h.run("ensure-running"), "unavailable", true, /not allowlisted/);
		expectNoMutations(h.cluster);
	});

	test("refuses a mismatched or missing namespace uid before mutation", async () => {
		h.writeHandoff();
		expectFailure(
			await h.run("ensure-running", { binding: { namespaceUid: "namespace-uid-other" } }),
			"conflict",
			false,
			/was replaced/,
		);
		h.cluster.namespaces.delete(NAMESPACE);
		expectFailure(await h.run("ensure-running"), "conflict", false, /no longer exists/);
		expectNoMutations(h.cluster);
	});

	test("maps an unreachable API to a typed unavailable failure", async () => {
		h.writeHandoff();
		h.cluster.reachable = false;
		expectFailure(await h.run("ensure-running"), "unavailable", true, /unreachable|refused/);
		expectNoMutations(h.cluster);
	});
});

describe("lifecycle", () => {
	test("a fresh ensure creates the claim and pod for the bound generation", async () => {
		h.writeHandoff();
		const response = expectOk(await h.run("ensure-running"), "running");

		expect(h.cluster.createdKinds).toEqual(["PersistentVolumeClaim", "Pod"]);
		expect(h.cluster.podCreates).toBe(1);
		const pod = podOf(h.cluster);
		const pvc = pvcOf(h.cluster);
		expect(pod.name).toBe(RESOURCE_NAME);
		expect(pvc.name).toBe(RESOURCE_NAME);
		expect(response.kubernetes).toEqual({
			namespaceUid: NAMESPACE_UID,
			podUid: pod.uid,
			pvcUid: pvc.uid,
		});
		expect(response.handle).toBe(`k8s:${NAMESPACE}/${RESOURCE_NAME}:g1`);

		expect(pod.labels[LABEL_MANAGED_BY]).toBe("omp-web");
		expect(pod.labels[LABEL_PART_OF]).toBe("omp-web-clones");
		expect(pod.labels[LABEL_PROFILE]).toBe(PROFILE_ID);
		expect(pod.labels[LABEL_RESOURCE_ID]).toBe(RESOURCE_IDENTITY);
		expect(pod.labels[LABEL_GENERATION]).toBe("1");
		expect(pod.annotations[ANN_WORKSPACE_ID]).toBe(WORKSPACE_ID);
		expect(pod.annotations[ANN_PROFILE_ID]).toBe(PROFILE_ID);
		expect(pod.annotations[ANN_NAMESPACE_UID]).toBe(NAMESPACE_UID);
		expect(pod.annotations[ANN_WORKSPACE_TOKEN]).not.toBe("");
		expect(pod.annotations[ANN_CALLBACK_DIGEST]).toBe(CALLBACK_DIGEST);
		expect(pod.annotations[ANN_SOURCE_PIN_DIGEST]).toBe(
			computeSourcePinDigest(SOURCE_REMOTE, REVISION, BRANCH),
		);

		expect(pvc.labels[LABEL_MANAGED_BY]).toBe("omp-web");
		expect(pvc.labels[LABEL_RESOURCE_ID]).toBe(RESOURCE_IDENTITY);
		expect(pvc.labels[LABEL_GENERATION]).toBeUndefined();
		expect(pvc.annotations[ANN_SOURCE_PIN_DIGEST]).toBe(
			computeSourcePinDigest(SOURCE_REMOTE, REVISION, BRANCH),
		);
		expect(pvc.storageClassName).toBe("standard");
		expect(pvc.size).toBe("10Gi");
		expect(pvc.accessModes).toEqual(["ReadWriteOnce"]);
	});

	test("re-ensure adopts the running pod and claim without duplicating them", async () => {
		h.writeHandoff();
		const first = expectOk(await h.run("ensure-running"), "running");
		const second = expectOk(await h.run("ensure-running"), "running");
		expect(second.handle).toBe(first.handle);
		expect(second.kubernetes).toEqual(first.kubernetes);
		expect(h.cluster.podCreates).toBe(1);
		expect(h.cluster.pods.size).toBe(1);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("stop retains the claim and proves the pod gone, repeatedly", async () => {
		h.writeHandoff();
		const running = expectOk(await h.run("ensure-running"), "running");
		const stopped = expectOk(await h.run("stop"), "stopped");
		expect(stopped.kubernetes).toEqual({
			namespaceUid: NAMESPACE_UID,
			podUid: null,
			pvcUid: running.kubernetes?.pvcUid ?? null,
		});
		expect(h.cluster.pods.size).toBe(0);
		expect(h.cluster.pvcs.has(RESOURCE_NAME)).toBe(true);
		const repeated = expectOk(await h.run("stop"), "stopped");
		expect(repeated.kubernetes?.pvcUid).toBe(running.kubernetes?.pvcUid);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("a wake after stop reuses the claim uid with a new pod uid", async () => {
		h.writeHandoff();
		const running = expectOk(await h.run("ensure-running"), "running");
		expectOk(await h.run("stop"), "stopped");
		const woke = expectOk(await h.run("ensure-running"), "running");
		expect(woke.kubernetes?.pvcUid).toBe(running.kubernetes?.pvcUid);
		expect(woke.kubernetes?.podUid).not.toBe(running.kubernetes?.podUid);
		expect(h.cluster.podCreates).toBe(2);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("delete removes both objects and repeated delete succeeds", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		const first = expectOk(await h.run("delete"), "missing");
		expect(first.kubernetes).toEqual({ namespaceUid: NAMESPACE_UID, podUid: null, pvcUid: null });
		expect(h.cluster.pods.size).toBe(0);
		expect(h.cluster.pvcs.size).toBe(0);
		const repeated = expectOk(await h.run("delete"), "missing");
		expect(repeated.handle).toBe(first.handle);
		expect(repeated.kubernetes).toEqual(first.kubernetes);
	});

	test("adopts a retained claim after the provider record is lost", async () => {
		h.writeHandoff();
		const running = expectOk(await h.run("ensure-running"), "running");

		rmSync(h.stateDir, { recursive: true, force: true });
		h.writeHandoff();
		const adopted = expectOk(await h.run("ensure-running"), "running");
		expect(adopted.kubernetes).toEqual(running.kubernetes);
		expect(h.cluster.podCreates).toBe(1);

		// The pod is gone while the claim survives: a lost record recreates the
		// pod against the retained claim, never a second claim.
		expectOk(await h.run("stop"), "stopped");
		rmSync(h.stateDir, { recursive: true, force: true });
		h.writeHandoff();
		const recreated = expectOk(await h.run("ensure-running"), "running");
		expect(recreated.kubernetes?.pvcUid).toBe(running.kubernetes?.pvcUid);
		expect(recreated.kubernetes?.podUid).not.toBe(running.kubernetes?.podUid);
		expect(h.cluster.pvcs.size).toBe(1);
		expect(h.cluster.podCreates).toBe(2);
	});

	test("refuses a foreign claim beside an owned pod", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		const owned = pvcOf(h.cluster);
		h.cluster.pvcs.set(RESOURCE_NAME, {
			...owned,
			labels: { [LABEL_MANAGED_BY]: "someone-else" },
			annotations: { [ANN_WORKSPACE_ID]: WORKSPACE_ID },
		});

		expectFailure(await h.run("ensure-running"), "conflict", false, /workspace identity check/);
		expectFailure(await h.run("inspect"), "conflict", false, /workspace identity check/);
		expect(h.cluster.pods.size).toBe(1);
		expect(pvcOf(h.cluster).labels[LABEL_MANAGED_BY]).toBe("someone-else");
		expect(h.cluster.deletedKinds).toEqual([]);
	});

	test("reports conflict when the namespace is replaced during ensure", async () => {
		h.writeHandoff();
		h.cluster.onPodRunning = () => {
			h.cluster.namespaces.set(NAMESPACE, REPLACED_NAMESPACE_UID);
		};
		expectFailure(
			await h.run("ensure-running"),
			"conflict",
			false,
			/replaced during ensure-running/,
		);
		// The resources created by the interrupted operation are retained.
		expect(h.cluster.pods.has(RESOURCE_NAME)).toBe(true);
		expect(h.cluster.pvcs.has(RESOURCE_NAME)).toBe(true);
		expect(h.cluster.deletedKinds).toEqual([]);
	});

	test("replaces a failed launch on retry with the recorded token and digest", async () => {
		h.writeHandoff();
		h.cluster.createPodPhase = "Failed";
		h.cluster.createPodReason = "CrashLoopBackOff";
		expectFailure(
			await h.run("ensure-running"),
			"unavailable",
			false,
			/did not reach Running \(Failed: CrashLoopBackOff\)/,
		);
		const failed = podOf(h.cluster);
		expect(failed.labels[LABEL_GENERATION]).toBe("1");
		const token = failed.annotations[ANN_WORKSPACE_TOKEN];
		const claimUid = pvcOf(h.cluster).uid;

		h.cluster.createPodPhase = null;
		h.cluster.createPodReason = null;
		const retried = expectOk(await h.run("ensure-running"), "running");
		expect(h.cluster.podCreates).toBe(2);
		const replacement = podOf(h.cluster);
		expect(replacement.uid).not.toBe(failed.uid);
		expect(replacement.labels[LABEL_GENERATION]).toBe("1");
		expect(replacement.annotations[ANN_WORKSPACE_TOKEN]).toBe(token);
		expect(replacement.annotations[ANN_CALLBACK_DIGEST]).toBe(CALLBACK_DIGEST);
		expect(retried.kubernetes?.pvcUid).toBe(claimUid);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("management operations work without a callback handoff", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		unlinkSync(join(h.stateDir, CALLBACK_ENV_FILE));
		expectOk(await h.run("inspect"), "running");
		expectOk(await h.run("stop"), "stopped");
		expectOk(await h.run("delete"), "missing");
		expect(h.cluster.pods.size).toBe(0);
		expect(h.cluster.pvcs.size).toBe(0);
	});

	test("retains the claim uid when a replacement pod never starts", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		expectOk(await h.run("stop"), "stopped");

		// The replacement Pod stays Pending through the readiness budget: the
		// launch is unavailable, but the claim uid must already be durable.
		h.cluster.settlePendingPods = false;
		expectFailure(
			await h.run("ensure-running", {}, { ensureWaitMs: 50 }),
			"unavailable",
			true,
			/retry ensure-running to adopt it/,
		);
		// Someone replaced the claim (same name and metadata) while the launch
		// was stuck; the recorded uid still fences it on the next attempt.
		const claim = pvcOf(h.cluster);
		h.cluster.pvcs.set(RESOURCE_NAME, { ...claim, uid: "uid-replaced-pvc" });

		h.cluster.settlePendingPods = true;
		expectFailure(await h.run("ensure-running"), "conflict", false, /recorded/);
		expect(h.cluster.pods.size).toBe(1);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("management operations tolerate an unusable callback credential", async () => {
		h.writeHandoff();
		await h.run("ensure-running");

		// Same workspace/generation, credential missing: identity is intact,
		// so inspect/stop must still work.
		h.writeRawHandoff({
			version: 1,
			workspaceId: WORKSPACE_ID,
			generation: 1,
			env: {
				OMP_SESSION_CALLBACK_URL: CALLBACK_URL,
				OMP_SESSION_CALLBACK_WORKSPACE: WORKSPACE_ID,
				OMP_SESSION_CALLBACK_GENERATION: "1",
			},
		});
		expectOk(await h.run("inspect"), "running");
		expectOk(await h.run("stop"), "stopped");

		// A malformed credential must not block the retained claim's teardown.
		h.writeRawHandoff({
			version: 1,
			workspaceId: WORKSPACE_ID,
			generation: 1,
			env: { ...h.handoffEnv(), OMP_SESSION_CALLBACK_TOKEN: "not-a-credential" },
		});
		expectOk(await h.run("delete"), "missing");
		expect(h.cluster.pods.size).toBe(0);
		expect(h.cluster.pvcs.size).toBe(0);
	});
});

describe("concurrency and the workspace lock", () => {
	test("two concurrent ensure calls produce a single pod", async () => {
		h.writeHandoff();
		const responses = await Promise.all([h.run("ensure-running"), h.run("ensure-running")]);
		const ok = responses.filter((response): response is ProviderOkResponse => response.ok);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		for (const response of ok) expect(response.observed).toBe("running");
		expect(new Set(ok.map((response) => response.kubernetes?.podUid)).size).toBe(1);
		for (const response of responses) {
			if (response.ok) continue;
			// Losing the concurrency race is a typed, retryable lock conflict.
			expect(response.error.code).toBe("conflict");
			expect(response.error.retryable).toBe(true);
		}
		expect(h.cluster.podCreates).toBe(1);
		expect(h.cluster.pods.size).toBe(1);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("converges on a peer's live observation while the peer holds the lock", async () => {
		h.writeHandoff();
		const running = expectOk(await h.run("ensure-running"), "running");
		const lock = acquireFileLock(lockPathOf(h), "peer-provider");
		try {
			const peered = expectOk(await h.run("ensure-running", {}, { lockWaitMs: 50 }), "running");
			expect(peered.handle).toBe(running.handle);
			expect(peered.kubernetes).toEqual(running.kubernetes);
			expect(h.cluster.podCreates).toBe(1);
		} finally {
			lock.release();
		}
	});

	test("a peer's still-Pending pod is never reported running", async () => {
		h.writeHandoff();
		// The peer's launch created the Pod, and no container has run yet: the
		// pod never settles, so the peer's ensure is still in flight.
		h.cluster.settlePendingPods = false;
		expectFailure(
			await h.run("ensure-running", {}, { ensureWaitMs: 50 }),
			"unavailable",
			true,
			/retry ensure-running to adopt it/,
		);
		expect(podOf(h.cluster).phase).toBe("Pending");

		const lock = acquireFileLock(lockPathOf(h), "peer-provider");
		try {
			// The envelope is a typed failure, not an observation: the fleet's
			// ensure persists the handle and the authorized generation only on
			// an ok response, so a Pending peer Pod can never authorize this
			// generation (nor turn its ready state on).
			expectFailure(
				await h.run("ensure-running", {}, { lockWaitMs: 50 }),
				"unavailable",
				true,
				/still Pending \(no container has run\)/,
			);
			// The probe observed the peer's own objects without touching them.
			expect(h.cluster.podCreates).toBe(1);
			expect(h.cluster.pods.size).toBe(1);
			expect(h.cluster.pvcs.size).toBe(1);
		} finally {
			lock.release();
		}
	});

	test("a live owner's lock is a typed conflict, and is never broken", async () => {
		h.writeHandoff();
		const startTime = parseProcStartTime(process.pid);
		expect(startTime).not.toBeNull();
		const path = lockPathOf(h);
		const owner = {
			pid: process.pid,
			procStartTime: startTime ?? 0,
			name: "live-holder",
			token: "d".repeat(32),
		};
		writeLockFile(path, owner);
		try {
			const response = await h.run("ensure-running", {}, { lockWaitMs: 0 });
			expectFailure(response, "conflict", true, /workspace lock/);
			expect(lockTokenOf(path)).toBe(owner.token);
			expectNoMutations(h.cluster);
		} finally {
			unlinkSync(path);
		}
	});

	test("recovers a lock whose owner pid was reused", async () => {
		h.writeHandoff();
		const startTime = parseProcStartTime(process.pid);
		expect(startTime).not.toBeNull();
		const path = lockPathOf(h);
		writeLockFile(path, {
			pid: process.pid,
			procStartTime: (startTime ?? 0) + 1,
			name: "reused-pid",
			token: "e".repeat(32),
		});
		expectOk(await h.run("ensure-running"), "running");
		expect(existsSync(path)).toBe(false);
	});

	test("recovers a lock whose owner process is dead", async () => {
		h.writeHandoff();
		const path = lockPathOf(h);
		// Above the kernel's maximum pid (PID_MAX_LIMIT = 4 * 1024 * 1024).
		writeLockFile(path, {
			pid: 99_999_999,
			procStartTime: 1,
			name: "dead-holder",
			token: "f".repeat(32),
		});
		expectOk(await h.run("ensure-running"), "running");
		expect(existsSync(path)).toBe(false);
	});

	test("an old owner's release never removes a replacement owner's lock", () => {
		const path = join(tempDir("kube-lock-"), "lock");
		const first = acquireFileLock(path, "first");
		// The stale breaker renames the lock aside, then a replacement acquires it.
		unlinkSync(path);
		const second = acquireFileLock(path, "second");
		const replacementToken = lockTokenOf(path);
		first.release();
		expect(existsSync(path)).toBe(true);
		expect(lockTokenOf(path)).toBe(replacementToken);
		expect(() => acquireFileLock(path, "third")).toThrow(LockHeldError);
		second.release();
		expect(existsSync(path)).toBe(false);
	});
});

describe("ownership fences", () => {
	test("never mutates or deletes a foreign pod on the deterministic name", async () => {
		h.writeHandoff();
		h.cluster.pods.set(RESOURCE_NAME, {
			name: RESOURCE_NAME,
			uid: "uid-foreign",
			phase: "Running",
			labels: { [LABEL_MANAGED_BY]: "someone-else" },
			annotations: {},
			containerReason: null,
			manifest: {},
		});
		expectFailure(await h.run("ensure-running"), "conflict", false, /refusing to reuse or replace/);
		expectFailure(await h.run("stop"), "conflict", false, /refusing to stop/);
		expectFailure(await h.run("delete"), "conflict", false, /refusing to delete/);
		expect(podOf(h.cluster).uid).toBe("uid-foreign");
		expect(h.cluster.pvcs.size).toBe(0);
		expect(h.cluster.deletedKinds).toEqual([]);
	});

	test("fences a pod from another generation while inspect still reports it", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		podOf(h.cluster).labels[LABEL_GENERATION] = "2";
		expectFailure(await h.run("ensure-running"), "conflict", false, /generation 2/);
		expectFailure(await h.run("stop"), "conflict", false, /generation 2/);
		expectFailure(await h.run("delete"), "conflict", false, /generation 2/);
		expect(podOf(h.cluster).labels[LABEL_GENERATION]).toBe("2");
		// Documented: inspect reports the live generation as-is so the fleet can
		// stop it before replacing it.
		const inspected = expectOk(await h.run("inspect"), "running");
		expect(inspected.kubernetes?.podUid).toBe(podOf(h.cluster).uid);
		podOf(h.cluster).labels[LABEL_GENERATION] = "1";
		expectOk(await h.run("ensure-running"), "running");
	});

	test("refuses malformed generation labels", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		for (const label of ["01", "1x", "+1", "1.0", " 1", ""]) {
			podOf(h.cluster).labels[LABEL_GENERATION] = label;
			expectFailure(await h.run("inspect"), "conflict", false, /positive-decimal/);
		}
		expectFailure(await h.run("ensure-running"), "conflict", false, /positive-decimal/);
		podOf(h.cluster).labels[LABEL_GENERATION] = "1";
		expectOk(await h.run("inspect"), "running");
	});

	test("refuses a pod whose launch token differs from the recorded identity", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		const token = podOf(h.cluster).annotations[ANN_WORKSPACE_TOKEN];
		podOf(h.cluster).annotations[ANN_WORKSPACE_TOKEN] = "foreign-launch-token";
		expectFailure(await h.run("ensure-running"), "conflict", false, /launch token/);
		expectFailure(await h.run("stop"), "conflict", false, /launch token/);
		expectFailure(await h.run("delete"), "conflict", false, /launch token/);
		expect(podOf(h.cluster).annotations[ANN_WORKSPACE_TOKEN]).toBe("foreign-launch-token");
		podOf(h.cluster).annotations[ANN_WORKSPACE_TOKEN] = token;
		expectOk(await h.run("ensure-running"), "running");
	});

	test("refuses a pod whose callback credential digest does not match", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		podOf(h.cluster).annotations[ANN_CALLBACK_DIGEST] = "b".repeat(64);
		expectFailure(await h.run("ensure-running"), "conflict", false, /callback credential digest/);

		// With the record lost the handoff is the only source of truth.
		rmSync(h.stateDir, { recursive: true, force: true });
		h.writeHandoff();
		expectFailure(await h.run("ensure-running"), "conflict", false, /enrolled handoff/);

		delete podOf(h.cluster).annotations[ANN_CALLBACK_DIGEST];
		expectFailure(await h.run("ensure-running"), "conflict", false, /does not carry/);
		expect(h.cluster.deletedKinds).toEqual([]);
	});

	test("refuses to delete a replacement whose API uid moved after validation", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		// The validated Pod is swapped for a same-named replacement between the
		// ownership read and the DELETE; the API uid precondition must refuse it.
		h.cluster.onBeforeDelete = (kind) => {
			if (kind === "pod") podOf(h.cluster).uid = "uid-replacement-pod";
		};
		expectFailure(await h.run("stop"), "conflict", false, /uid precondition/);
		expect(podOf(h.cluster).uid).toBe("uid-replacement-pod");
		expect(h.cluster.deletedKinds).toEqual([]);
	});

	test("fences a retained claim whose uid changed across generations", async () => {
		h.writeHandoff();
		const running = expectOk(await h.run("ensure-running"), "running");
		expectOk(await h.run("stop"), "stopped");

		// The claim outlives the Pod, so the recorded uid fences the NEXT
		// generation too: a same-named replacement must not be attached.
		const claim = pvcOf(h.cluster);
		h.cluster.pvcs.set(RESOURCE_NAME, { ...claim, uid: "uid-replaced-pvc" });
		h.writeHandoff({ generation: 2 });

		expectFailure(await h.run("ensure-running", { generation: 2 }), "conflict", false, /recorded/);
		expect(h.cluster.podCreates).toBe(1);
		expect(running.kubernetes?.pvcUid).toBe(claim.uid);
	});

	test("refuses a claim replaced after the pod reports Running", async () => {
		h.writeHandoff();
		h.cluster.onPodRunning = () => {
			const claim = pvcOf(h.cluster);
			h.cluster.pvcs.set(RESOURCE_NAME, { ...claim, uid: "uid-swapped-pvc" });
		};
		expectFailure(await h.run("ensure-running"), "conflict", false, /workspace identity check/);
		expect(pvcOf(h.cluster).uid).toBe("uid-swapped-pvc");
	});

	test("refuses a foreign pod observed at the final running check", async () => {
		h.writeHandoff();
		h.cluster.onPodRunning = () => {
			podOf(h.cluster).labels[LABEL_MANAGED_BY] = "someone-else";
		};
		expectFailure(await h.run("ensure-running"), "conflict", false, /refusing to adopt/);
		expect(podOf(h.cluster).labels[LABEL_MANAGED_BY]).toBe("someone-else");
	});

	test("inspect conflicts when the namespace is replaced mid-operation", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		// Second read: withOpContext's initial check, then the operation's own.
		let reads = 0;
		h.cluster.onNamespaceRead = () => {
			reads += 1;
			if (reads === 2) h.cluster.namespaces.set(NAMESPACE, REPLACED_NAMESPACE_UID);
		};
		expectFailure(await h.run("inspect"), "conflict", false, /replaced during inspect/);
	});

	test("stop conflicts when the namespace is replaced mid-operation", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		let reads = 0;
		h.cluster.onNamespaceRead = () => {
			reads += 1;
			if (reads === 2) h.cluster.namespaces.set(NAMESPACE, REPLACED_NAMESPACE_UID);
		};
		expectFailure(await h.run("stop"), "conflict", false, /replaced during stop/);
	});

	test("delete conflicts when the namespace is replaced mid-operation", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		let reads = 0;
		h.cluster.onNamespaceRead = () => {
			reads += 1;
			if (reads === 2) h.cluster.namespaces.set(NAMESPACE, REPLACED_NAMESPACE_UID);
		};
		expectFailure(await h.run("delete"), "conflict", false, /replaced during delete/);
	});
});

describe("pod manifest", () => {
	test("renders the hardened pod with the exact workspace mounts", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		const manifest = podOf(h.cluster).manifest;
		expect(manifest["kind"]).toBe("Pod");
		// No Service, Secret, ServiceAccount, or anything else was created.
		expect(h.cluster.createdKinds).toEqual(["PersistentVolumeClaim", "Pod"]);

		const spec = asRecord(manifest["spec"]);
		expect(spec["restartPolicy"]).toBe("Never");
		expect(spec["automountServiceAccountToken"]).toBe(false);
		expect(spec["enableServiceLinks"]).toBe(false);
		const podSecurity = asRecord(spec["securityContext"]);
		expect(podSecurity["runAsNonRoot"]).toBe(true);
		expect(podSecurity["runAsUser"]).toBe(10001);
		expect(podSecurity["runAsGroup"]).toBe(10001);
		expect(podSecurity["fsGroup"]).toBe(10001);
		expect(podSecurity["seccompProfile"]).toEqual({ type: "RuntimeDefault" });

		const container = containerOf(manifest);
		expect(container["name"]).toBe("session");
		expect(container["image"]).toBe(IMAGE);
		expect(container["securityContext"]).toMatchObject({
			runAsNonRoot: true,
			runAsUser: 10001,
			runAsGroup: 10001,
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		});
		expect(container["volumeMounts"]).toEqual([
			{ name: "workspace", mountPath: "/workspace" },
			{ name: "tmp", mountPath: "/tmp" },
		]);
		const volumes = Array.isArray(spec["volumes"]) ? spec["volumes"] : [];
		expect(volumes).toEqual([
			{ name: "workspace", persistentVolumeClaim: { claimName: RESOURCE_NAME, readOnly: false } },
			{ name: "tmp", emptyDir: {} },
		]);
		// No service-account token is projected into the pod.
		expect(volumes.some((volume) => Object.hasOwn(asRecord(volume), "secret"))).toBe(false);
		expect(volumes.some((volume) => Object.hasOwn(asRecord(volume), "projected"))).toBe(false);
	});

	test("injects the workspace/callback env and secrets as secretKeyRef", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		const manifest = podOf(h.cluster).manifest;
		const env = envOf(containerOf(manifest));
		const envValue = (name: string): unknown => env.get(name)?.["value"];

		expect(envValue("OMP_PROVIDER_PROTO")).toBe(String(OMP_PROVIDER_PROTO));
		expect(envValue("OMP_WORKSPACE_ID")).toBe(WORKSPACE_ID);
		expect(envValue("OMP_WORKSPACE_GENERATION")).toBe("1");
		expect(envValue("OMP_WORKSPACE_ROOT")).toBe("/workspace");
		expect(envValue("OMP_WORKSPACE_DIR")).toBe("/workspace/.checkout");
		expect(envValue("HOME")).toBe("/workspace/.home");
		expect(envValue("OMP_PREP_SOURCE_REMOTE")).toBe(SOURCE_REMOTE);
		expect(envValue("OMP_PREP_REVISION")).toBe(REVISION);
		expect(envValue("OMP_PREP_BRANCH")).toBe(BRANCH);
		expect(envValue("OMP_SESSION_CALLBACK_URL")).toBe(CALLBACK_URL);
		expect(envValue("OMP_SESSION_CALLBACK_TOKEN")).toBe(CALLBACK_TOKEN);
		expect(envValue("GIT_SSH_COMMAND")).toBe("/opt/omp-web/runtime/image/git-ssh.sh");
		expect(containerOf(manifest)["resources"]).toEqual({
			requests: { cpu: "1", memory: "2Gi" },
			limits: { cpu: "1", memory: "2Gi" },
		});

		const secret = env.get("OMP_MODEL_KEY");
		expect(secret?.["valueFrom"]).toEqual({
			secretKeyRef: { name: MODEL_SECRET_NAME, key: MODEL_SECRET_KEY },
		});
		expect(Object.hasOwn(secret ?? {}, "value")).toBe(false);
	});
});

describe("baseline delivery", () => {
	/** The mounted baseline volume, or undefined when the pod has none. */
	function baselineVolume(spec: Record<string, unknown>): unknown {
		const volumes = Array.isArray(spec["volumes"]) ? spec["volumes"] : [];
		return volumes.find((volume) => asRecord(volume)["name"] === "baseline");
	}

	test("mounts the sanitized documents and points the in-pod seed at them", async () => {
		h.writeHandoff();
		await h.run("ensure-running", { baseline: BASELINE });

		// The ConfigMap must exist before the Pod that mounts it, and both
		// documents ride it with their file names as data keys.
		expect(h.cluster.createdKinds).toEqual(["PersistentVolumeClaim", "ConfigMap", "Pod"]);
		const cm = h.cluster.configMaps.get(BASELINE_CM_NAME);
		expect(cm?.data).toEqual({
			"config.yml": BASELINE_CONFIG_YAML,
			"models.yml": BASELINE_MODELS_YAML,
		});

		const manifest = podOf(h.cluster).manifest;
		const spec = asRecord(manifest["spec"]);
		expect(baselineVolume(spec)).toEqual({
			name: "baseline",
			configMap: { name: BASELINE_CM_NAME, optional: false },
		});
		const container = containerOf(manifest);
		const mounts = container["volumeMounts"] as unknown[];
		expect(mounts).toContainEqual({
			name: "baseline",
			mountPath: "/opt/omp-web/baseline",
			readOnly: true,
		});
		expect(envOf(container).get("OMP_SANDBOX_BASELINE_CONFIG")?.["value"]).toBe(
			"/opt/omp-web/baseline/config.yml",
		);
	});

	test("omits the mount, env, and object when the fleet had nothing to seed", async () => {
		h.writeHandoff();
		await h.run("ensure-running");

		expect(h.cluster.createdKinds).toEqual(["PersistentVolumeClaim", "Pod"]);
		expect(h.cluster.configMaps.size).toBe(0);
		const manifest = podOf(h.cluster).manifest;
		expect(baselineVolume(asRecord(manifest["spec"]))).toBeUndefined();
		expect(envOf(containerOf(manifest)).has("OMP_SANDBOX_BASELINE_CONFIG")).toBe(false);
	});

	test("replaces a previous baseline instead of reusing it", async () => {
		h.writeHandoff();
		await h.run("ensure-running", { baseline: BASELINE });
		expectOk(await h.run("stop"), "stopped");

		const edited = { configYaml: "{modelRoles: {default: openai-codex/gpt-5.6-sol:xhigh}}\n" };
		await h.run("ensure-running", { baseline: edited });

		expect(h.cluster.createdKinds.filter((kind) => kind === "ConfigMap")).toHaveLength(2);
		expect(h.cluster.configMaps.get(BASELINE_CM_NAME)?.data).toEqual({
			"config.yml": edited.configYaml,
		});
		// The pod was replaced against the retained claim, not duplicated.
		expect(h.cluster.podCreates).toBe(2);
		expect(h.cluster.pvcs.size).toBe(1);
	});

	test("refuses to replace a foreign ConfigMap on the deterministic name", async () => {
		h.writeHandoff();
		// Establish the workspace without a baseline, then stop it so the next
		// ensure-running must create a Pod (and therefore touch the name).
		await h.run("ensure-running");
		expectOk(await h.run("stop"), "stopped");
		// Someone else's object squatting on the name the provider derives.
		h.cluster.configMaps.set(BASELINE_CM_NAME, {
			name: BASELINE_CM_NAME,
			uid: "uid-foreign-configmap",
			labels: { [LABEL_MANAGED_BY]: "someone-else" },
			annotations: {},
			data: { "config.yml": "theirs\n" },
			manifest: {},
		});

		const response = await h.run("ensure-running", { baseline: BASELINE });
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected the foreign object to be refused");
		expect(response.error.code).toBe("conflict");
		expect(response.error.message).toMatch(/workspace identity check/);
		// The foreign object and the absence of our Pod are both preserved.
		expect(h.cluster.configMaps.get(BASELINE_CM_NAME)?.data).toEqual({ "config.yml": "theirs\n" });
		expect(h.cluster.pods.size).toBe(0);
	});

	test("delete removes the ConfigMap with the pod and claim", async () => {
		h.writeHandoff();
		await h.run("ensure-running", { baseline: BASELINE });
		expect(h.cluster.configMaps.size).toBe(1);

		expectOk(await h.run("delete"), "missing");
		expect(h.cluster.pods.size).toBe(0);
		expect(h.cluster.pvcs.size).toBe(0);
		expect(h.cluster.configMaps.size).toBe(0);
		// Absence of every tracked object is what makes a repeat a clean no-op.
		expectOk(await h.run("delete"), "missing");
	});

	test("a retained volume from a pre-baseline generation still deletes cleanly", async () => {
		h.writeHandoff();
		await h.run("ensure-running");
		expect(h.cluster.configMaps.size).toBe(0);

		const response = await h.run("delete");
		expectOk(response, "missing");
		expect(h.cluster.deletedKinds).toEqual(["pod", "persistentvolumeclaim"]);
	});

	test("waits out an asynchronous ConfigMap delete before recreating it", async () => {
		h.writeHandoff();
		await h.run("ensure-running", { baseline: BASELINE });
		expectOk(await h.run("stop"), "stopped");

		// The DELETE is acknowledged but the object survives one read (a
		// finalizer): the replacement Pod must wait for absence rather than
		// hitting AlreadyExists on the create.
		h.cluster.holdDeletes.add("configmap");
		const response = expectOk(await h.run("ensure-running", { baseline: BASELINE }), "running");
		expect(response.kubernetes?.podUid).toBe(podOf(h.cluster).uid);
		expect(h.cluster.createdKinds.filter((kind) => kind === "ConfigMap")).toHaveLength(2);
		expect(h.cluster.configMaps.get(BASELINE_CM_NAME)?.data).toEqual({
			"config.yml": BASELINE_CONFIG_YAML,
			"models.yml": BASELINE_MODELS_YAML,
		});
	});
});

describe("preflight", () => {
	test("passes every check for a prepared profile", async () => {
		const result = await h.preflight();
		expect(result.profileId).toBe(PROFILE_ID);
		expect(result.provider).toBe("kubernetes");
		expect(result.ok).toBe(true);
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(checkRow(result, "kube-context").detail).toContain(CONTEXT);
		expect(checkRow(result, "kube-api").ok).toBe(true);
		expect(checkRow(result, "kube-namespace").ok).toBe(true);
		expect(checkRow(result, "kube-rbac-create-pods").ok).toBe(true);
		expect(checkRow(result, "kube-rbac-delete-persistentvolumeclaims").ok).toBe(true);
		expect(checkRow(result, "kube-storageclass").ok).toBe(true);
		expect(checkRow(result, "kube-secret-OMP_MODEL_KEY").ok).toBe(true);
		expect(checkRow(result, "kube-image").ok).toBe(true);
	});

	test("fails the context row when no explicit context is configured", async () => {
		const result = await h.preflight(kubernetesProfile({ context: undefined }));
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-context");
		expect(row.ok).toBe(false);
		expect(row.remediation ?? "").toMatch(/context/);
	});

	test("fails the API row when the context cannot reach the API", async () => {
		h.cluster.reachable = false;
		const result = await h.preflight();
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-api");
		expect(row.ok).toBe(false);
		expect(row.remediation ?? "").toMatch(/kubeconfig/);
	});

	test("fails the RBAC row for a missing create permission", async () => {
		h.cluster.rbac.delete(`create:persistentvolumeclaims:${NAMESPACE}`);
		const result = await h.preflight();
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-rbac-create-persistentvolumeclaims");
		expect(row.ok).toBe(false);
		expect(row.remediation ?? "").toMatch(/Role/);
	});

	test("fails the secret row when the referenced key is absent", async () => {
		h.cluster.secrets.set(MODEL_SECRET_NAME, { data: {} });
		const result = await h.preflight();
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-secret-OMP_MODEL_KEY");
		expect(row.ok).toBe(false);
		expect(row.detail).toMatch(/no key/);
		expect(row.remediation ?? "").toMatch(/add key/);
	});

	test("fails the StorageClass row when the pinned class does not exist", async () => {
		h.cluster.storageClasses.clear();
		const result = await h.preflight();
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-storageclass");
		expect(row.ok).toBe(false);
		expect(row.remediation ?? "").toMatch(/StorageClass/);
	});

	test("fails the namespace row when the namespace is gone", async () => {
		h.cluster.namespaces.delete(NAMESPACE);
		const result = await h.preflight();
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-namespace");
		expect(row.ok).toBe(false);
		expect(row.remediation ?? "").toMatch(/create namespace/);
	});

	test("fails when the profile omits storage.class and no default exists", async () => {
		h.cluster.storageClasses.clear();
		const result = await h.preflight(kubernetesProfile({ storage: { size: "10Gi" } }));
		expect(result.ok).toBe(false);
		const row = checkRow(result, "kube-default-storageclass");
		expect(row.ok).toBe(false);
		expect(row.detail).toMatch(/no default StorageClass/);
		expect(row.remediation ?? "").toMatch(/default/);
	});

	test("passes when exactly one default StorageClass backs an omitted class", async () => {
		h.cluster.storageClasses.set("standard", true);
		const result = await h.preflight(kubernetesProfile({ storage: { size: "10Gi" } }));
		const row = checkRow(result, "kube-default-storageclass");
		expect(row.ok).toBe(true);
		expect(row.detail).toMatch(/default StorageClass standard/);
		expect(result.ok).toBe(true);
	});
});
