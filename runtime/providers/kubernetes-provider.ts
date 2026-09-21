#!/usr/bin/env bun
/**
 * Kubernetes provider (P5.3): implements the frozen provider operation
 * protocol (docs/clone-contracts.md, "Provider operation protocol") for
 * clone workspaces on an operator-prepared Kubernetes API.
 *
 * Invocation: `<executable> ensure-running|inspect|stop|delete` with exactly
 * one JSON request on stdin and one JSON response on stdout; exit 0 when a
 * response was produced (the `ok` flag classifies the outcome). stderr is a
 * human log the fleet never parses.
 *
 * Resource model (one workspace = one Pod + one PVC, nothing else):
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
 *   NetworkPolicies, and never changes kubectl's ambient current-context:
 *   every call carries an explicit `--context`.
 *
 * Durable identity (never PID-only; the pod has no host pid):
 * - The provider records its launch identity at
 *   `<stateDir>/provider.k8s.json` = {version, workspaceId, generation,
 *   workspaceToken, namespace, podName, podUid, pvcName, createdAt,
 *   startedAt}. `workspaceToken` is embedded in the pod's
 *   `omp-web.omp.dev/workspace-token` annotation, the API-side analogue of
 *   bwrap's `/proc/<pid>/cmdline` token check.
 * - Liveness = the pod exists via the API AND its uid matches the record
 *   AND its identity annotations (managed-by, workspace-id, generation,
 *   token) match AND it is not terminating/terminal. A replaced pod (uid
 *   change with matching annotations) is re-anchored; a foreign-token pod
 *   squatting on the deterministic name is a `conflict`, never adopted or
 *   deleted by a different identity.
 * - `stop` deletes the pod and PROVES the requested generation terminated
 *   by polling the API until the pod is gone; an uncertain predecessor is
 *   `conflict` (retryable) and later replacement refuses to start a second
 *   writer until termination is proven. The PVC is retained.
 * - `delete` runs only after stop semantics (it stops first when the pod
 *   is still present), verifies the claim's ownership labels before
 *   removing it, a foreign claim on the deterministic name is never
 *   deleted, and then removes the provider stateDir.
 *
 * Restart rediscovery: pod/PVC names are deterministic from workspaceId
 * (DNS-1123 sanitize + 8-char sha256 suffix), so after a fleet or provider
 * restart `ensure-running` re-finds resources by name + identity
 * annotations even with an empty stateDir (the record is rebuilt from pod
 * annotations; the token is adopted from the pod it already runs).
 *
 * Configuration (operator-explicit; no ambient discovery):
 * - kube context: `profile.context` (additive protocol field agreed with
 *   the Runtime owner; effective fallback is the `OMP_KUBE_CONTEXT`
 *   environment of the fleet process), required; the ambient
 *   current-context is NEVER used.
 * - namespace/image: `profile.namespace` / `profile.image`, required.
 * - resources/storage: `profile.resources {cpu, memory}` (applied as both
 *   requests and limits → Guaranteed QoS), `profile.storage {class, size}`
 *   (class optional = cluster default; size defaults to 10 Gi).
 * - model/tool credentials: `profile.secretRefs` maps ENV name →
 *   `<secretName>/<key>`, injected as native `secretKeyRef` env. Secrets
 *   must pre-exist; they are verified by preflight, never created.
 * - callback enrollment: the fleet-written `<stateDir>/callback-env.json`
 *   handoff (same contract as bwrap-provider) is injected as pod env. The
 *   enrollment token is generation-scoped and readable by anyone with pod
 *   get permission in the operator-approved namespace, the same exposure
 *   class as bwrap's process environment; the namespace must be scoped
 *   accordingly (P5.5 RBAC is operator-owned).
 * - in-pod preparation: the fleet resolves the pin and passes it through
 *   the additive request fields `source.remote`/`revision`/`branch`; the
 *   provider injects them as OMP_PREP_* env and the image entrypoint
 *   initializes a NEW workspace volume once (verified marker), so
 *   replacement pods never re-clone or re-resolve. `source.local` is a
 *   fleet-host path and is rejected for kubernetes profiles.
 *
 * Missing prerequisites fail `unavailable`/`invalid_request` with
 * actionable remediation. There is no auto-install, no RBAC/namespace
 * creation, and no ephemeral/emptyDir fallback for workspace storage.
 *
 * Bundle-safety: imports only node builtins and shared/*; no import.meta
 * path reads, no self-respawn. `kubectl` argv arrays only, never a shell.
 */

import type { Subprocess } from "bun";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	ProviderProtocolError,
	parseProviderRequest,
	type ProviderObserved,
	type ProviderProfile,
	type ProviderRequest,
	type ProviderResponse,
} from "../../shared/provider-protocol";
import type { ProviderErrorCode } from "../../shared/provider-protocol";
import { acquireFileLock } from "../../shared/file-lock";
import { ENV_ALLOW_KEYS } from "../bwrap-args";
import type { PreflightCheck, PreflightResult } from "../preflight";

// ---------------------------------------------------------------------------
// Request/profile extensions (landing in shared/provider-protocol.ts)
// ---------------------------------------------------------------------------

/**
 * Additive request fields agreed with the Runtime owner: the clone pin the
 * provider needs to initialize a NEW workspace volume in-pod. Until the
 * shared validator carries them they arrive as undefined; the provider then
 * simply runs pods without preparation input.
 */
interface KubernetesProviderRequest extends ProviderRequest {
	/** Clone source; exactly one member. `local` is rejected for kubernetes. */
	source?: { local?: string; remote?: string };
	/** Pinned full commit (registry pinnedRevision); retries never re-resolve. */
	revision?: string;
	/** Branch to create at the pinned commit. */
	branch?: string;
}

/** Additive profile field agreed with the Runtime owner (see header). */
type KubernetesProfile = ProviderProfile & { context?: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The provider's identity record in its private per-workspace stateDir. */
const RECORD_FILE = "provider.k8s.json";
const STATE_LOCK_HOLDER = "kubernetes-provider";
/** Fleet-written callback enrollment handoff (0600), read before a create. */
const CALLBACK_ENV_FILE = "callback-env.json";
const CALLBACK_ENV_VERSION = 1;
const CALLBACK_ENV_PREFIX = "OMP_SESSION_CALLBACK_";
/** P8.9 wake-resume hint; allowlisted so a bwrap-shaped handoff never surprises us. */
const RESUME_ENV_KEY = "OMP_SESSION_RESUME";

/** In-pod workspace volume layout (frozen "Preparation layout"). */
const POD_WORKSPACE_ROOT = "/workspace";
const POD_CHECKOUT_DIR = `${POD_WORKSPACE_ROOT}/.checkout`;
const POD_HOME_DIR = `${POD_WORKSPACE_ROOT}/.home`;

const DEFAULT_STORAGE_SIZE = "10Gi";
const POD_UID = 10001;

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

function envMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Label/annotation vocabulary. Every object the provider creates carries
// the managed-by label; the provider refuses to mutate or delete any
// object that does not carry it with the matching workspace identity.
const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_PART_OF = "app.kubernetes.io/part-of";
const LABEL_WORKSPACE_HASH = "omp-web.omp.dev/workspace-hash";
const LABEL_PROFILE = "omp-web.omp.dev/profile-id";
const LABEL_GENERATION = "omp-web.omp.dev/generation";
const ANN_WORKSPACE_ID = "omp-web.omp.dev/workspace-id";
const ANN_WORKSPACE_TOKEN = "omp-web.omp.dev/workspace-token";
const ANN_PROFILE_ID = "omp-web.omp.dev/profile-id";
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

// ---------------------------------------------------------------------------
// Configuration resolution (operator-explicit; no ambient discovery)
// ---------------------------------------------------------------------------

interface KubernetesConfig {
	kubectlBin: string;
	context: string;
	namespace: string;
	image: string;
	resources?: { cpu?: string; memory?: string };
	storageClass?: string;
	storageSize: string;
	secretRefs: Record<string, { secretName: string; secretKey: string; envName: string }>;
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
		const match = SECRET_REF_PARSE_RE.exec(ref);
		if (match === null) {
			throw ProviderProtocolError.invalidRequest(
				`profile.secretRefs.${envName} must be "<secretName>/<key>" within the profile namespace, got ${JSON.stringify(ref)}`,
			);
		}
		out[envName] = { secretName: match[1], secretKey: match[3], envName };
	}
	return out;
}

/**
 * Resolve the effective configuration, failing BEFORE any cluster call.
 * Context resolution order: profile.context (additive field) →
 * OMP_KUBE_CONTEXT env → invalid_request. The ambient kubectl
 * current-context is never consulted.
 */
function resolveConfig(
	request: ProviderRequest,
	env: Record<string, string | undefined> = process.env,
): KubernetesConfig {
	const profile = request.profile as KubernetesProfile;
	if (profile.provider !== "kubernetes") {
		throw ProviderProtocolError.invalidRequest(
			`profile ${profile.id} is a ${profile.provider} profile, not kubernetes`,
		);
	}
	const context = profile.context ?? env.OMP_KUBE_CONTEXT;
	if (context === undefined || context.trim() === "") {
		throw ProviderProtocolError.invalidRequest(
			"kubernetes profile requires an explicit API context: set providerProfiles." +
				`${profile.id}.context (or export OMP_KUBE_CONTEXT); the ambient current-context is never used`,
		);
	}
	if (profile.namespace === undefined || profile.namespace.trim() === "") {
		throw ProviderProtocolError.invalidRequest(
			`kubernetes profile ${profile.id} requires a namespace (operator-prepared)`,
		);
	}
	if (profile.image === undefined || profile.image.trim() === "") {
		throw ProviderProtocolError.invalidRequest(
			`kubernetes profile ${profile.id} requires an image (the session-runtime image)`,
		);
	}
	return {
		kubectlBin: env.OMP_KUBE_BIN ?? "kubectl",
		context,
		namespace: profile.namespace,
		image: profile.image,
		resources: profile.resources,
		storageClass: profile.storage?.class,
		storageSize: profile.storage?.size ?? DEFAULT_STORAGE_SIZE,
		secretRefs: parseSecretRefs(profile.secretRefs),
	};
}

// ---------------------------------------------------------------------------
// Naming (deterministic → restart rediscovery without a listing)
// ---------------------------------------------------------------------------

const DNS1123_MAX = 63;

function workspaceHash(workspaceId: string): string {
	return createHash("sha256").update(workspaceId).digest("hex").slice(0, 8);
}

/** DNS-1123 label sanitize: lowercase, fold invalid runs to `-`. */
function dns1123(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Deterministic base name for the workspace's pod and claim:
 * `omp-ws-<sanitized-id>-<hash8>`, ≤ 63 chars, stable across restarts.
 * The hash suffix keeps distinct ids with equal sanitizations apart.
 */
function baseNameFor(workspaceId: string): string {
	const sanitized = dns1123(workspaceId);
	const hash = workspaceHash(workspaceId);
	const room = DNS1123_MAX - "omp-ws--".length - hash.length;
	const stem = sanitized.slice(0, room).replace(/-+$/g, "");
	return `omp-ws-${stem === "" ? "ws" : stem}-${hash}`;
}

/** Opaque handle: stable per workspace+generation, pod UID excluded (UID changes on in-generation pod replacement; the record re-anchors it). */
function handleFor(namespace: string, workspaceId: string, generation: number): string {
	return `k8s:${namespace}/${baseNameFor(workspaceId)}:g${generation}`;
}

/** DNS-1123 label value for the profile id (label charset is narrower). */
function profileLabel(profileId: string): string {
	return dns1123(profileId).slice(0, DNS1123_MAX) || "profile";
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** True when the object's labels/annotations identify THIS workspace. */
function ownedByWorkspace(
	meta: { labels: Record<string, string>; annotations: Record<string, string> },
	workspaceId: string,
): boolean {
	return (
		meta.labels[LABEL_MANAGED_BY] === MANAGED_BY_VALUE &&
		meta.annotations[ANN_WORKSPACE_ID] === workspaceId
	);
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
	podName: string;
	pvcName: string;
	/** API uid of the pod this record is anchored to; re-verified each op. */
	podUid: string;
	createdAt: number;
	startedAt?: number;
	stoppedAt?: number;
}

function readRecord(stateDir: string): KubernetesLaunchRecord | null {
	let raw: string;
	try {
		raw = readFileSync(join(stateDir, RECORD_FILE), "utf8");
	} catch {
		return null;
	}
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			value.version !== 1 ||
			typeof value.workspaceId !== "string" ||
			typeof value.generation !== "number" ||
			typeof value.workspaceToken !== "string" ||
			typeof value.namespace !== "string" ||
			typeof value.podName !== "string" ||
			typeof value.pvcName !== "string" ||
			typeof value.podUid !== "string"
		) {
			return null;
		}
		return value as unknown as KubernetesLaunchRecord;
	} catch {
		return null;
	}
}

/** Atomically write the identity record (tmp file + rename). */
function writeRecord(stateDir: string, record: KubernetesLaunchRecord): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = join(stateDir, `.${RECORD_FILE}.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(tmp, join(stateDir, RECORD_FILE));
}

// ---------------------------------------------------------------------------
// Callback enrollment handoff (same contract as bwrap-provider)
// ---------------------------------------------------------------------------

function isCallbackEnvKey(key: string): boolean {
	return (
		key === RESUME_ENV_KEY || (key.startsWith(CALLBACK_ENV_PREFIX) && ENV_ALLOW_KEYS.includes(key))
	);
}

/**
 * Read the fleet's callback enrollment handoff (`<stateDir>/callback-env.json`,
 * 0600, version 1). Identity+generation mismatch is `conflict` (a stale
 * enrollment must never start a generation); absence yields null.
 */
function readCallbackEnv(
	stateDir: string,
	workspaceId: string,
	generation: number,
): Record<string, string> | null {
	const file = join(stateDir, CALLBACK_ENV_FILE);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null; // absent (or unreadable): launch without callback env
	}
	try {
		const mode = statSync(file).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			console.error(
				`kubernetes-provider: ${CALLBACK_ENV_FILE} is mode ${mode.toString(8)}, expected 0600`,
			);
		}
	} catch {
		// Stat raced a rewrite; the content parse below is authoritative.
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} is not valid JSON`, { cause });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE} must be a JSON object`);
	}
	const record = value as Record<string, unknown>;
	if (record.version !== CALLBACK_ENV_VERSION) {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} has unsupported version ${JSON.stringify(record.version)}`,
		);
	}
	if (typeof record.workspaceId !== "string" || typeof record.generation !== "number") {
		throw ProviderProtocolError.unavailable(
			`${CALLBACK_ENV_FILE} is missing workspaceId/generation`,
		);
	}
	if (record.workspaceId !== workspaceId) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets workspace ${record.workspaceId}, requested ${workspaceId}`,
		);
	}
	if (record.generation !== generation) {
		throw new ProviderProtocolError(
			"conflict",
			`${CALLBACK_ENV_FILE} targets generation ${record.generation}, requested ${generation}; a new generation must not start under a stale enrollment`,
		);
	}
	const rawEnv = record.env;
	if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
		throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE}.env must be an object`);
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(rawEnv as Record<string, unknown>)) {
		if (!isCallbackEnvKey(key)) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE}.env.${key} is not an allowed callback env key`,
			);
		}
		if (typeof entry !== "string" || entry.length === 0) {
			throw ProviderProtocolError.unavailable(
				`${CALLBACK_ENV_FILE}.env.${key} must be a non-empty string`,
			);
		}
		if (entry.length > 4096) {
			throw ProviderProtocolError.unavailable(`${CALLBACK_ENV_FILE}.env.${key} exceeds 4096 bytes`);
		}
		env[key] = entry;
	}
	return env;
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

/** DELETE one object without blocking; absent is success. */
async function kubeDelete(
	exec: KubeExec,
	cfg: KubernetesConfig,
	kind: string,
	name: string,
	what: string,
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Object inspection (plain-record navigation, no schema dependency)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function podMeta(pod: Record<string, unknown>): {
	uid: string;
	deletionTimestamp: string | null;
	labels: Record<string, string>;
	annotations: Record<string, string>;
} {
	const metadata = asRecord(pod.metadata) ?? {};
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

function pvcMeta(pvc: Record<string, unknown>): {
	labels: Record<string, string>;
	annotations: Record<string, string>;
	storageClassName: string | undefined;
	size: string | undefined;
	accessModes: string[];
} {
	const metadata = asRecord(pvc.metadata) ?? {};
	const spec = asRecord(pvc.spec) ?? {};
	const resources = asRecord(spec.resources) ?? {};
	const requests = asRecord(resources.requests) ?? {};
	const accessModes = Array.isArray(spec.accessModes)
		? spec.accessModes.filter((m): m is string => typeof m === "string")
		: [];
	return {
		labels: (asRecord(metadata.labels) ?? {}) as Record<string, string>,
		annotations: (asRecord(metadata.annotations) ?? {}) as Record<string, string>,
		storageClassName: typeof spec.storageClassName === "string" ? spec.storageClassName : undefined,
		size: typeof requests.storage === "string" ? requests.storage : undefined,
		accessModes,
	};
}

// ---------------------------------------------------------------------------
// Manifest builders (pure; unit-testable without a cluster)
// ---------------------------------------------------------------------------

function identityLabels(
	workspaceId: string,
	profileId: string,
	generation: number,
): Record<string, string> {
	return {
		[LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
		[LABEL_PART_OF]: PART_OF_VALUE,
		[LABEL_WORKSPACE_HASH]: workspaceHash(workspaceId),
		[LABEL_PROFILE]: dns1123(profileId).slice(0, DNS1123_MAX) || "profile",
		[LABEL_GENERATION]: String(generation),
	};
}

function identityAnnotations(
	workspaceId: string,
	profileId: string,
	workspaceToken: string,
): Record<string, string> {
	return {
		[ANN_WORKSPACE_ID]: workspaceId,
		[ANN_PROFILE_ID]: profileId,
		[ANN_WORKSPACE_TOKEN]: workspaceToken,
	};
}

/** The per-workspace persistent claim (retained across stop/replacement). */
export function buildPvcManifest(
	cfg: KubernetesConfig,
	profileId: string,
	workspaceId: string,
	generation: number,
	workspaceToken: string,
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
			name: baseNameFor(workspaceId),
			namespace: cfg.namespace,
			labels: identityLabels(workspaceId, profileId, generation),
			annotations: identityAnnotations(workspaceId, profileId, workspaceToken),
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
	request: KubernetesProviderRequest,
	workspaceToken: string,
	callbackEnv: Record<string, string>,
): Record<string, unknown> {
	const { workspaceId, generation } = request;
	const name = baseNameFor(workspaceId);

	const env: Record<string, unknown>[] = [
		{ name: "OMP_WORKSPACE_ID", value: workspaceId },
		{ name: "OMP_WORKSPACE_GENERATION", value: String(generation) },
		{ name: "OMP_WORKSPACE_TOKEN", value: workspaceToken },
		{ name: "OMP_PROVIDER_PROTO", value: "1" },
		{ name: "OMP_WORKSPACE_ROOT", value: POD_WORKSPACE_ROOT },
		{ name: "OMP_WORKSPACE_DIR", value: POD_CHECKOUT_DIR },
		{ name: "HOME", value: POD_HOME_DIR },
		{ name: "PI_CODING_AGENT_DIR", value: `${POD_HOME_DIR}/agent` },
		{ name: "PATH", value: "/usr/local/bin:/usr/bin:/bin" },
		{ name: "LANG", value: "C.UTF-8" },
		{ name: "TERM", value: "xterm-256color" },
	];

	// In-pod preparation input (only consumed when the PVC's verified init
	// marker is absent, i.e. a NEW workspace volume).
	if (request.source?.remote !== undefined) {
		env.push({ name: "OMP_PREP_SOURCE_REMOTE", value: request.source.remote });
		if (request.revision !== undefined)
			env.push({ name: "OMP_PREP_REVISION", value: request.revision });
		if (request.branch !== undefined) env.push({ name: "OMP_PREP_BRANCH", value: request.branch });
	}

	// Callback enrollment handoff (generation-scoped; see header).
	for (const [key, value] of Object.entries(callbackEnv)) {
		env.push({ name: key, value });
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
			runAsUser: POD_UID,
			runAsGroup: POD_UID,
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		},
		volumeMounts: [
			{ name: "workspace", mountPath: POD_WORKSPACE_ROOT },
			{ name: "tmp", mountPath: "/tmp" },
		],
	};

	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name,
			namespace: cfg.namespace,
			labels: identityLabels(workspaceId, request.profile.id, generation),
			annotations: identityAnnotations(workspaceId, request.profile.id, workspaceToken),
		},
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			terminationGracePeriodSeconds: 15,
			securityContext: {
				runAsNonRoot: true,
				runAsUser: POD_UID,
				runAsGroup: POD_UID,
				fsGroup: POD_UID,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [container],
			volumes: [
				{ name: "workspace", persistentVolumeClaim: { claimName: name, readOnly: false } },
				{ name: "tmp", emptyDir: {} },
			],
		},
	};
}

// ---------------------------------------------------------------------------
// Shared op plumbing
// ---------------------------------------------------------------------------

function ok(
	handle: string,
	observed: ProviderObserved,
	extra?: { startedAt?: number },
): ProviderResponse {
	return { ok: true, handle, observed, ...extra };
}

function err(
	code: Exclude<ProviderErrorCode, "timeout">,
	message: string,
	retryable: boolean,
): ProviderResponse {
	return { ok: false, error: { code, message, retryable } };
}

/** Map a kubectl-level failure to the typed vocabulary. */
function kubeFailure(cause: unknown, what: string): ProviderResponse {
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface OpDeps {
	exec: KubeExec;
	env: Record<string, string | undefined>;
	ensureWaitMs: number;
	stopWaitMs: number;
	deleteWaitMs: number;
}

function defaultDeps(): OpDeps {
	return {
		exec: defaultKubeExec,
		env: process.env,
		ensureWaitMs: envMs("OMP_KUBE_ENSURE_WAIT_MS", ENSURE_WAIT_MS_DEFAULT),
		stopWaitMs: envMs("OMP_KUBE_STOP_WAIT_MS", STOP_WAIT_MS_DEFAULT),
		deleteWaitMs: envMs("OMP_KUBE_DELETE_WAIT_MS", DELETE_WAIT_MS_DEFAULT),
	};
}

/**
 * ensure-running: idempotent create-or-adopt. Rediscovery order is
 * deterministic name → ownership labels → token/generation annotations →
 * API uid re-anchor; the stateDir record is rebuilt when lost. A live pod
 * for a DIFFERENT generation, a foreign-token pod, or a terminating
 * predecessor is `conflict`, never a second writer on the claim.
 */
async function opEnsureRunning(
	rawRequest: ProviderRequest,
	deps: OpDeps,
): Promise<ProviderResponse> {
	const request = rawRequest as KubernetesProviderRequest;
	const { stateDir, workspaceId, generation } = request;

	let cfg: KubernetesConfig;
	try {
		cfg = resolveConfig(request, deps.env);
		if (request.source?.local !== undefined) {
			throw ProviderProtocolError.invalidRequest(
				"source.local is a fleet-host filesystem path and cannot initialize a kubernetes volume; use source.remote for kubernetes profiles",
			);
		}
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			return err(
				cause.code === "timeout" ? "internal" : cause.code,
				cause.message,
				cause.retryable,
			);
		}
		return err("invalid_request", String(cause), false);
	}

	const podName = baseNameFor(workspaceId);
	const handle = handleFor(cfg.namespace, workspaceId, generation);

	mkdirSync(stateDir, { recursive: true });
	let lock;
	try {
		lock = acquireFileLock(join(stateDir, "lock"), STATE_LOCK_HOLDER);
	} catch {
		return err("conflict", "another provider instance holds the workspace lock", true);
	}

	try {
		let record = readRecord(stateDir);
		let pod: Record<string, unknown> | null;
		try {
			pod = await kubeGet(deps.exec, cfg, "pod", podName);
		} catch (cause) {
			return kubeFailure(cause, "ensure-running");
		}

		if (pod !== null) {
			const meta = podMeta(pod);
			if (!ownedByWorkspace(meta, workspaceId)) {
				return err(
					"conflict",
					`pod ${cfg.namespace}/${podName} exists without this workspace's ownership identity; refusing to touch a foreign object; inspect it manually (kubectl --context <ctx> -n ${cfg.namespace} describe pod ${podName})`,
					false,
				);
			}
			const podToken = meta.annotations[ANN_WORKSPACE_TOKEN] ?? "";
			if (podToken === "") {
				return err(
					"conflict",
					`pod ${cfg.namespace}/${podName} carries no workspace-token annotation; this provider never creates such a pod, refusing to adopt it`,
					false,
				);
			}
			const podGeneration = Number.parseInt(meta.labels[LABEL_GENERATION] ?? "", 10);
			if (Number.isSafeInteger(podGeneration) && podGeneration !== generation) {
				return err(
					"conflict",
					`workspace runs under generation ${podGeneration}, requested ${generation}; stop the running generation before replacement`,
					false,
				);
			}
			if (record !== null && record.workspaceToken !== podToken) {
				return err(
					"conflict",
					`pod ${podName} carries a different workspace token than the recorded identity; refusing to adopt; delete the pod manually or run stop/delete`,
					false,
				);
			}
			if (meta.deletionTimestamp !== null) {
				return err(
					"conflict",
					`pod ${podName} is terminating; replacement waits for proven termination`,
					true,
				);
			}

			// Adopt / re-anchor: same workspace+generation, token from the pod
			// when the record was lost (fleet/provider restart with wiped state).
			const token = record?.workspaceToken ?? podToken;
			const phase = podPhase(pod);
			if (phase === "Failed" || phase === "Succeeded") {
				// Terminated corpse: provably not writing. Remove it and wait for
				// proven absence before creating the replacement (same generation,
				// same token, the PVC init marker still guards preparation).
				try {
					await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName} (terminal ${phase})`);
					if (!(await waitGone(deps.exec, cfg, "pod", podName, deps.stopWaitMs))) {
						return err("conflict", `terminated pod ${podName} did not disappear in time`, true);
					}
				} catch (cause) {
					return kubeFailure(cause, "ensure-running");
				}
				return await createPodAndWait(request, cfg, deps, token, record, handle);
			}

			// Pending or Running: anchor the record to the API uid, then wait
			// for Running within the budget (image pulls can be slow).
			record = {
				version: 1,
				workspaceId,
				generation,
				workspaceToken: token,
				namespace: cfg.namespace,
				podName,
				pvcName: podName,
				podUid: meta.uid,
				createdAt: record?.createdAt ?? Date.now(),
				startedAt: podStartTime(pod) ?? record?.startedAt,
			};
			writeRecord(stateDir, record);
			if (phase === "Running") {
				return ok(handle, "running", { startedAt: record.startedAt });
			}
			let waited: PodRunningWait;
			try {
				waited = await waitPodRunning(deps.exec, cfg, podName, deps.ensureWaitMs);
			} catch (cause) {
				return kubeFailure(cause, "ensure-running");
			}
			if (waited.running) {
				try {
					const startedPod = await kubeGet(deps.exec, cfg, "pod", podName);
					record.startedAt = startedPod === null ? Date.now() : podStartTime(startedPod);
				} catch (cause) {
					record.startedAt = Date.now();
					writeRecord(stateDir, record);
					return kubeFailure(cause, "ensure-running");
				}
				writeRecord(stateDir, record);
				return ok(handle, "running", { startedAt: record.startedAt });
			}
			if (waited.phase === "Failed" || waited.phase === "Succeeded") {
				return err(
					"unavailable",
					`pod ${podName} terminated during start (${waited.reason ?? waited.phase}); inspect with kubectl --context <ctx> -n ${cfg.namespace} logs ${podName}; the next ensure-running replaces the terminated pod`,
					false,
				);
			}
			const reason = waited.reason;
			const remediation =
				reason !== null && /ImagePull|ErrImage/i.test(reason)
					? `image ${cfg.image} cannot be pulled (${reason}); make the session-runtime image available to the cluster`
					: `pod still ${waited.phase} after ${deps.ensureWaitMs}ms (${reason ?? "no container reason"}); retry ensure-running to adopt it`;
			return err("unavailable", remediation, true);
		}

		// Pod absent: a same-generation record means the pod vanished
		// externally: recreate with the recorded token. A different
		// generation means a replacement after a proven stop, fresh token.
		// No record means a new workspace.
		const token =
			record !== null && record.generation === generation
				? record.workspaceToken
				: randomUUID().replace(/-/g, "");

		// Ensure the persistent claim BEFORE the pod references it.
		let pvc: Record<string, unknown> | null;
		try {
			pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName);
		} catch (cause) {
			return kubeFailure(cause, "ensure-running");
		}
		if (pvc !== null) {
			const meta = pvcMeta(pvc);
			if (!ownedByWorkspace(meta, workspaceId)) {
				return err(
					"conflict",
					`claim ${cfg.namespace}/${podName} exists without this workspace's ownership identity; refusing to attach a foreign claim`,
					false,
				);
			}
			// PVC spec is immutable after creation: drift is an operator
			// decision, never silently recreated (which would destroy data).
			if (cfg.storageClass !== undefined && meta.storageClassName !== cfg.storageClass) {
				return err(
					"conflict",
					`existing claim ${podName} uses storageClass ${JSON.stringify(meta.storageClassName)}, profile requests ${JSON.stringify(cfg.storageClass)}; PVC spec is immutable; align the profile or migrate the claim deliberately`,
					false,
				);
			}
			if (meta.size !== undefined && meta.size !== cfg.storageSize) {
				return err(
					"conflict",
					`existing claim ${podName} requests ${meta.size}, profile requests ${cfg.storageSize}; PVC size changes need a deliberate volume expansion, not pod replacement`,
					false,
				);
			}
			if (!meta.accessModes.includes("ReadWriteOnce")) {
				return err(
					"conflict",
					`existing claim ${podName} has accessModes ${meta.accessModes.join(",")}, expected ReadWriteOnce`,
					false,
				);
			}
		} else {
			try {
				await kubeCreate(
					deps.exec,
					cfg,
					buildPvcManifest(cfg, request.profile.id, workspaceId, generation, token),
					`persistentvolumeclaim ${podName}`,
				);
			} catch (cause) {
				return kubeFailure(cause, "ensure-running");
			}
		}

		return await createPodAndWait(request, cfg, deps, token, record, handle);
	} finally {
		lock.release();
	}
}

/** Create the workspace pod and wait for Running; shared by all ensure paths. */
async function createPodAndWait(
	request: KubernetesProviderRequest,
	cfg: KubernetesConfig,
	deps: OpDeps,
	workspaceToken: string,
	record: KubernetesLaunchRecord | null,
	handle: string,
): Promise<ProviderResponse> {
	const { stateDir, workspaceId, generation } = request;
	const podName = baseNameFor(workspaceId);

	let callbackEnv: Record<string, string>;
	try {
		callbackEnv = readCallbackEnv(stateDir, workspaceId, generation) ?? {};
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			return err(
				cause.code === "timeout" ? "internal" : cause.code,
				cause.message,
				cause.retryable,
			);
		}
		return err("internal", `cannot read callback enrollment: ${String(cause)}`, false);
	}

	try {
		await kubeCreate(
			deps.exec,
			cfg,
			buildPodManifest(cfg, request, workspaceToken, callbackEnv),
			`pod ${podName}`,
		);
	} catch (cause) {
		return kubeFailure(cause, "ensure-running");
	}

	const created = await kubeGet(deps.exec, cfg, "pod", podName);
	const uid = created === null ? "" : podMeta(created).uid;
	const next: KubernetesLaunchRecord = {
		version: 1,
		workspaceId,
		generation,
		workspaceToken,
		namespace: cfg.namespace,
		podName,
		pvcName: podName,
		podUid: uid,
		createdAt: record?.createdAt ?? Date.now(),
	};
	writeRecord(stateDir, next);

	let waited: PodRunningWait;
	try {
		waited = await waitPodRunning(deps.exec, cfg, podName, deps.ensureWaitMs);
	} catch (cause) {
		return kubeFailure(cause, "ensure-running");
	}
	if (waited.running) {
		try {
			const running = await kubeGet(deps.exec, cfg, "pod", podName);
			next.startedAt = running === null ? Date.now() : podStartTime(running);
			if (running !== null) next.podUid = podMeta(running).uid;
		} catch (cause) {
			next.startedAt = Date.now();
		}
		writeRecord(stateDir, next);
		return ok(handle, "running", { startedAt: next.startedAt });
	}
	const reason = waited.reason;
	const remediation =
		reason !== null && /ImagePull|ErrImage/i.test(reason)
			? `image ${cfg.image} cannot be pulled (${reason}); make the session-runtime image available to the cluster`
			: `pod ${podName} did not reach Running (${waited.phase}${reason === null ? "" : `: ${reason}`}); the identity is recorded; retry ensure-running to adopt it`;
	return err("unavailable", remediation, waited.phase !== "Failed" && waited.phase !== "Succeeded");
}

/** inspect: report the API-observed state; identity mismatches are conflicts. */
async function opInspect(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest as KubernetesProviderRequest;
	const { stateDir, workspaceId, generation } = request;

	let cfg: KubernetesConfig;
	try {
		cfg = resolveConfig(request, deps.env);
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			return err(
				cause.code === "timeout" ? "internal" : cause.code,
				cause.message,
				cause.retryable,
			);
		}
		return err("invalid_request", String(cause), false);
	}
	const podName = baseNameFor(workspaceId);
	const handle = handleFor(cfg.namespace, workspaceId, generation);

	let pod: Record<string, unknown> | null;
	let pvc: Record<string, unknown> | null;
	try {
		pod = await kubeGet(deps.exec, cfg, "pod", podName);
		pvc = pod === null ? await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName) : null;
	} catch (cause) {
		return kubeFailure(cause, "inspect");
	}

	const record = readRecord(stateDir);
	if (pod !== null) {
		const meta = podMeta(pod);
		if (!ownedByWorkspace(meta, workspaceId)) {
			return err(
				"conflict",
				`pod ${cfg.namespace}/${podName} exists without this workspace's ownership identity`,
				false,
			);
		}
		if (
			record !== null &&
			record.workspaceToken !== (meta.annotations[ANN_WORKSPACE_TOKEN] ?? "")
		) {
			return err("conflict", `pod ${podName} token does not match the recorded identity`, false);
		}
		if ((meta.annotations[ANN_WORKSPACE_TOKEN] ?? "") === "" && record === null) {
			return err(
				"conflict",
				`pod ${cfg.namespace}/${podName} carries no workspace-token annotation and no identity record exists`,
				false,
			);
		}
		const phase = podPhase(pod);
		if (meta.deletionTimestamp === null && (phase === "Running" || phase === "Pending")) {
			return ok(handle, "running", { startedAt: podStartTime(pod) ?? record?.startedAt });
		}
		return ok(handle, "stopped", { startedAt: record?.startedAt });
	}
	if (pvc !== null || record !== null) {
		// Compute gone, storage (or at least the identity record) retained.
		return ok(handle, "stopped", { startedAt: record?.startedAt });
	}
	return ok(handle, "missing");
}

/** stop: delete the pod and PROVE the requested generation terminated. */
async function opStop(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest as KubernetesProviderRequest;
	const { stateDir, workspaceId, generation } = request;

	let cfg: KubernetesConfig;
	try {
		cfg = resolveConfig(request, deps.env);
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			return err(
				cause.code === "timeout" ? "internal" : cause.code,
				cause.message,
				cause.retryable,
			);
		}
		return err("invalid_request", String(cause), false);
	}
	const podName = baseNameFor(workspaceId);
	const handle = handleFor(cfg.namespace, workspaceId, generation);

	let pod: Record<string, unknown> | null;
	try {
		pod = await kubeGet(deps.exec, cfg, "pod", podName);
	} catch (cause) {
		return kubeFailure(cause, "stop");
	}

	if (pod === null) {
		// Idempotent: the claim (and any record) is retained by design.
		return ok(handle, "stopped");
	}

	const meta = podMeta(pod);
	if (!ownedByWorkspace(meta, workspaceId)) {
		return err(
			"conflict",
			`pod ${cfg.namespace}/${podName} is not owned by this workspace; refusing to stop a foreign object`,
			false,
		);
	}
	const record = readRecord(stateDir);
	if (record !== null && record.workspaceToken !== (meta.annotations[ANN_WORKSPACE_TOKEN] ?? "")) {
		return err("conflict", `pod ${podName} token does not match the recorded identity`, false);
	}
	const podGeneration = Number.parseInt(meta.labels[LABEL_GENERATION] ?? "", 10);
	if (Number.isSafeInteger(podGeneration) && podGeneration !== generation) {
		return err(
			"conflict",
			`workspace runs under generation ${podGeneration}, stop requested generation ${generation}`,
			false,
		);
	}

	try {
		await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName}`);
	} catch (cause) {
		return kubeFailure(cause, "stop");
	}

	// Proof, never assumption: the pod must be gone from the API before we
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
			`could not prove generation ${generation} terminated: pod ${podName} still exists after ${deps.stopWaitMs}ms`,
			true,
		);
	}
	if (record !== null) {
		writeRecord(stateDir, { ...record, stoppedAt: Date.now() });
	}
	return ok(handle, "stopped");
}

/**
 * delete: authorized only after the stop proof; a live or uncertain pod
 * is stopped through the same identity checks first, and an unprovable
 * termination is `conflict`. The claim's ownership identity is verified
 * before removal; a foreign claim is never deleted.
 */
async function opDelete(rawRequest: ProviderRequest, deps: OpDeps): Promise<ProviderResponse> {
	const request = rawRequest as KubernetesProviderRequest;
	const { stateDir, workspaceId, generation } = request;

	let cfg: KubernetesConfig;
	try {
		cfg = resolveConfig(request, deps.env);
	} catch (cause) {
		if (cause instanceof ProviderProtocolError) {
			return err(
				cause.code === "timeout" ? "internal" : cause.code,
				cause.message,
				cause.retryable,
			);
		}
		return err("invalid_request", String(cause), false);
	}
	const podName = baseNameFor(workspaceId);
	const handle = handleFor(cfg.namespace, workspaceId, generation);

	try {
		const pod = await kubeGet(deps.exec, cfg, "pod", podName);
		if (pod !== null) {
			const meta = podMeta(pod);
			if (!ownedByWorkspace(meta, workspaceId)) {
				return err(
					"conflict",
					`pod ${cfg.namespace}/${podName} is not owned by this workspace; refusing to delete`,
					false,
				);
			}
			const record = readRecord(stateDir);
			const podToken = meta.annotations[ANN_WORKSPACE_TOKEN] ?? "";
			if (record !== null && record.workspaceToken !== podToken) {
				return err("conflict", `pod ${podName} token does not match the recorded identity`, false);
			}
			if (record === null) {
				// No record: ownership labels were verified above, but without
				// a state record deletion is authorized only when the pod is
				// provably terminal (it cannot be writing).
				const phase = podPhase(pod);
				if (phase !== "Failed" && phase !== "Succeeded") {
					return err(
						"conflict",
						`pod ${podName} has no identity record and is ${phase}; run stop first or wait for the pod to terminate`,
						false,
					);
				}
			}
			const phase = podPhase(pod);
			if (phase !== "Failed" && phase !== "Succeeded") {
				await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName}`);
			} else {
				await kubeDelete(deps.exec, cfg, "pod", podName, `pod ${podName} (terminal ${phase})`);
			}
			if (!(await waitGone(deps.exec, cfg, "pod", podName, deps.deleteWaitMs))) {
				return err(
					"conflict",
					`delete: could not prove the generation terminated (pod ${podName} still exists)`,
					true,
				);
			}
		}

		const pvc = await kubeGet(deps.exec, cfg, "persistentvolumeclaim", podName);
		if (pvc !== null) {
			const meta = pvcMeta(pvc);
			if (!ownedByWorkspace(meta, workspaceId)) {
				return err(
					"conflict",
					`claim ${cfg.namespace}/${podName} is not owned by this workspace; refusing to delete a foreign claim`,
					false,
				);
			}
			await kubeDelete(deps.exec, cfg, "persistentvolumeclaim", podName, `claim ${podName}`);
			if (!(await waitGone(deps.exec, cfg, "persistentvolumeclaim", podName, deps.deleteWaitMs))) {
				return err(
					"conflict",
					`claim ${podName} did not disappear in time (finalizers?); retry delete`,
					true,
				);
			}
		}
	} catch (cause) {
		return kubeFailure(cause, "delete");
	}

	rmSync(stateDir, { recursive: true, force: true });
	return ok(handle, "missing");
}

// ---------------------------------------------------------------------------
// Preflight (P5.6): actionable, no installs, no object creation
// ---------------------------------------------------------------------------

/**
 * Production-profile preflight for a kubernetes profile. Every check that
 * can fail carries an actionable remediation; all checks run (cluster-
 * dependent checks report their dependency failure rather than being
 * skipped silently). Nothing is installed, created, or mutated: the only
 * API traffic is reads plus `auth can-i` access reviews.
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
	const kprofile = profile as KubernetesProfile;

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
	const context = kprofile.context ?? env.OMP_KUBE_CONTEXT;
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

	// 6. StorageClass (when the profile pins one).
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
			detail: `image ${profile.image}; pullability is verified at first pod start; ensure the cluster can pull this reference (imagePullSecrets are namespace-scoped and operator-managed)`,
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
				error: { code: cause.code, message: cause.message, retryable: cause.retryable },
			};
		} else {
			response = {
				ok: false,
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
