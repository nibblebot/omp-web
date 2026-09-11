/**
 * kubectl execution boundary for the workspace provider: the injectable
 * runner, typed call failures, and every API read/write/poll the lifecycle
 * uses. Every call carries `--context` (the ambient context is never consulted
 * or mutated) and explicit argv arrays, never a shell.
 */

import type { Subprocess } from "bun";
import type { KubernetesConfig } from "./config";
import { objectMeta, podContainerReason, podPhase } from "./resources";

/** Kubectl per-call API timeout (flag) and spawn-level kill budget. */
export const KUBE_REQUEST_TIMEOUT = "15s";
const KUBE_EXEC_KILL_MS = 60_000;
/** kubectl payload cap; provider protocol envelopes stay capped separately. */
const KUBE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** Poll cadence for bounded absence/readiness waits. */
export const POLL_INTERVAL_MS = 500;

export interface KubeExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** One kubectl invocation: explicit argv, optional stdin manifest. */
export type KubeExec = (argv: readonly string[], input?: string) => Promise<KubeExecResult>;

/** Resolve after `ms` milliseconds (withResolvers; no executor nesting). */
export function delay(ms: number): Promise<void> {
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
export async function defaultKubeExec(
	argv: readonly string[],
	input?: string,
): Promise<KubeExecResult> {
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
export class KubeCallError extends Error {
	constructor(
		message: string,
		readonly result: KubeExecResult,
	) {
		super(message);
	}
}

/**
 * Thrown when the API refuses a deletion because the object's identity moved:
 * we never delete a replacement object we did not validate.
 */
export class KubePreconditionError extends Error {}

export function kubeArgs(cfg: KubernetesConfig, rest: readonly string[]): string[] {
	return [
		cfg.kubectlBin,
		"--context",
		cfg.context,
		`--request-timeout=${KUBE_REQUEST_TIMEOUT}`,
		...rest,
	];
}

/** GET one object as JSON; null when absent (--ignore-not-found). */
export async function kubeGet(
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

/**
 * CREATE one object from a manifest on stdin (never apply: no adopting or
 * patching foreign objects). Returns the server's own object (uid included),
 * so a caller can pin the created object's uid without a second read.
 */
export async function kubeCreate(
	exec: KubeExec,
	cfg: KubernetesConfig,
	manifest: Record<string, unknown>,
	what: string,
): Promise<Record<string, unknown> | null> {
	const result = await exec(
		kubeArgs(cfg, ["create", "-n", cfg.namespace, "-f", "-", "-o", "json"]),
		`${JSON.stringify(manifest)}\n`,
	);
	if (result.code !== 0) {
		throw new KubeCallError(
			`kubectl create ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			result,
		);
	}
	const text = result.stdout.trim();
	return text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
}

/** core/v1 resource path segment per kind the provider deletes. */
const CORE_V1_PLURAL: Record<string, string> = {
	pod: "pods",
	persistentvolumeclaim: "persistentvolumeclaims",
	configmap: "configmaps",
};

/**
 * DELETE one object with an API-enforced uid precondition.
 *
 * `kubectl delete <kind> <name>` carries no portable uid precondition, so the
 * provider issues the raw core/v1 API DELETE with a `DeleteOptions` body
 * carrying `preconditions.uid`: the API server atomically refuses to remove an
 * object whose uid moved (a same-named replacement created after validation),
 * which is exactly the ownership fence. Never `--force`: the default graceful
 * termination applies. Absent objects are success.
 */
export async function kubeDelete(
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
	const plural = CORE_V1_PLURAL[kind];
	if (plural === undefined) {
		throw new KubePreconditionError(`refusing to delete ${what}: unsupported core/v1 kind ${kind}`);
	}
	const body = JSON.stringify({
		apiVersion: "v1",
		kind: "DeleteOptions",
		preconditions: { uid: expectedUid },
	});
	const result = await exec(
		kubeArgs(cfg, [
			"delete",
			`--raw=/api/v1/namespaces/${cfg.namespace}/${plural}/${name}`,
			"-f",
			"-",
		]),
		`${body}\n`,
	);
	if (result.code === 0) return;
	const stderr = result.stderr;
	if (/NotFound|not found/i.test(stderr)) return;
	if (/precondition|Conflict/i.test(stderr)) {
		throw new KubePreconditionError(
			`refusing to delete ${what}: the API refused the uid precondition (the object was replaced after validation): ${stderr.trim() || `exit ${result.code}`}`,
		);
	}
	throw new KubeCallError(
		`kubectl delete ${what} failed: ${stderr.trim() || `exit ${result.code}`}`,
		result,
	);
}

/** API uid of the bound namespace, or null when it no longer exists. */
export async function kubeNamespaceUid(
	exec: KubeExec,
	cfg: KubernetesConfig,
): Promise<string | null> {
	const namespace = await kubeGet(exec, cfg, "namespace", cfg.namespace, { namespaced: false });
	if (namespace === null) return null;
	const uid = objectMeta(namespace).uid;
	return uid === "" ? null : uid;
}

/** One observed workspace: both objects plus the live namespace uid. */
export interface ObservedObjects {
	namespaceUid: string | null;
	pod: Record<string, unknown> | null;
	pvc: Record<string, unknown> | null;
}

/** GET the Pod, the PVC, and the bound namespace's uid. */
export async function observeObjects(
	exec: KubeExec,
	cfg: KubernetesConfig,
): Promise<ObservedObjects> {
	const pod = await kubeGet(exec, cfg, "pod", cfg.resourceName);
	const pvc = await kubeGet(exec, cfg, "persistentvolumeclaim", cfg.resourceName);
	const namespaceUid = await kubeNamespaceUid(exec, cfg);
	return { namespaceUid, pod, pvc };
}

/** Poll until `probe` reports done or the budget elapses. */
export async function pollUntil(budgetMs: number, probe: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (await probe()) return true;
		if (Date.now() >= deadline) return false;
		await delay(POLL_INTERVAL_MS);
	}
}

/** Wait until the named object is gone from the API (404), bounded. */
export async function waitGone(
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
export async function waitPodRunning(
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
