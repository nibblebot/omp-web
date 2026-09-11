/**
 * Provider boundary regressions (P5.1/P5.4). These cases drive real provider
 * executables (tiny `#!/bin/sh` stubs that emit one canned envelope) so the
 * assertions cover observable invoker behavior, not internal plumbing: the
 * profile-dependent success-observation gate, the shared wire validator's
 * bracketed-source admission, and the Kubernetes invocation budget derived in
 * runtime/providers/kubernetes/timeouts.ts.
 *
 * Every filesystem fixture is a tracked `tempDir()` scratch dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	OMP_PROVIDER_PROTO,
	ProviderProtocolError,
	validateKubernetesSource,
} from "../shared/provider-protocol";
import type { ProviderOp, ProviderRequest } from "../shared/provider-protocol";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { ProviderOpError, runProviderOp } from "./provider-exec";
import {
	KUBERNETES_OP_TERMINATION_MS,
	KUBERNETES_WAIT_MS_MAX,
	kubernetesOpTimeouts,
	readKubernetesWaits,
} from "./providers/kubernetes/timeouts";

afterAll(cleanupTempDirs);

const KUBERNETES_BINDING = {
	resourceIdentity: "0123456789abcdef0123456789abcdef",
	context: "test-context",
	namespace: "test-ns",
	namespaceUid: "ns-uid",
};

const OBSERVATION = { namespaceUid: "ns-uid", podUid: "pod-uid", pvcUid: "pvc-uid" };

/** A valid request for one profile; the profile's executable is irrelevant. */
function request(
	provider: "bwrap" | "kubernetes",
	op: ProviderOp = "ensure-running",
): ProviderRequest {
	return {
		providerProto: OMP_PROVIDER_PROTO,
		op,
		workspaceId: "w1",
		generation: 1,
		workspaceDir: "/tmp/w1",
		homeDir: "/tmp/h1",
		stateDir: "/tmp/s1",
		profile: { id: "p1", provider, executable: "/bin/true", tools: [] },
		...(provider === "kubernetes" ? { kubernetes: { ...KUBERNETES_BINDING } } : {}),
	};
}

/** A real executable that drains stdin and prints exactly `envelope` at exit 0. */
function providerExecutable(envelope: unknown): string {
	const dir = tempDir("omp-provider-exec-");
	const responsePath = join(dir, "response.json");
	writeFileSync(responsePath, `${JSON.stringify(envelope)}\n`);
	const script = join(dir, "provider.sh");
	writeFileSync(script, `#!/bin/sh\ncat >/dev/null\ncat ${JSON.stringify(responsePath)}\n`);
	chmodSync(script, 0o755);
	return script;
}

/** Await a promise that must reject; returns the thrown ProviderOpError. */
async function rejection(promise: Promise<unknown>): Promise<ProviderOpError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ProviderOpError) return err;
		throw err;
	}
	throw new Error("expected the invocation to reject");
}

function okEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ok: true,
		providerProto: OMP_PROVIDER_PROTO,
		handle: "h1",
		observed: "running",
		...extra,
	};
}

describe("profile-dependent success observation", () => {
	test("refuses a kubernetes success with no kubernetes observation", async () => {
		const executable = providerExecutable(okEnvelope());
		const err = await rejection(runProviderOp(executable, request("kubernetes")));
		expect(err).toBeInstanceOf(ProviderOpError);
		expect(err.code).toBe("internal");
		expect(err.message).toContain("without a kubernetes observation");
	});

	test("refuses a bwrap success carrying a kubernetes observation", async () => {
		const executable = providerExecutable(okEnvelope({ kubernetes: OBSERVATION }));
		const err = await rejection(runProviderOp(executable, request("bwrap")));
		expect(err).toBeInstanceOf(ProviderOpError);
		expect(err.code).toBe("internal");
		expect(err.message).toContain("reported a kubernetes observation");
	});

	test("accepts a kubernetes success that observes its objects", async () => {
		const executable = providerExecutable(okEnvelope({ kubernetes: OBSERVATION }));
		const response = await runProviderOp(executable, request("kubernetes"));
		if (!response.ok) throw new Error("expected an ok response");
		expect(response.kubernetes).toEqual(OBSERVATION);
	});

	test("accepts a bwrap success with no kubernetes observation", async () => {
		const executable = providerExecutable(okEnvelope());
		const response = await runProviderOp(executable, request("bwrap"));
		if (!response.ok) throw new Error("expected an ok response");
		expect(response.kubernetes).toBeUndefined();
	});

	test("does not gate a provider-reported failure envelope", async () => {
		const executable = providerExecutable({
			ok: false,
			providerProto: OMP_PROVIDER_PROTO,
			error: { code: "unavailable", message: "not yet", retryable: true },
		});
		const response = await runProviderOp(executable, request("kubernetes"));
		expect(response.ok).toBe(false);
	});
});

describe("kubernetes source admission", () => {
	test("refuses malformed bracketed authorities", () => {
		for (const source of [
			"ssh://[]/repo",
			"https://[not-an-ipv6]:garbage/repo",
			"ssh://[::1]:70000/repo",
			"https://[::1]:/repo",
		]) {
			let code = "accepted";
			try {
				validateKubernetesSource(source);
			} catch (err) {
				code = err instanceof ProviderProtocolError ? err.code : "other";
			}
			expect(code).toBe("invalid_request");
		}
	});

	test("accepts a valid bracketed IPv6 authority verbatim", () => {
		const source = "ssh://[2001:db8::1]:2222/team/repo.git";
		expect(validateKubernetesSource(source)).toBe(source);
	});
});

describe("kubernetes invocation budget", () => {
	test("defaults apply only when an override is absent", () => {
		expect(readKubernetesWaits({})).toEqual({
			ensureWaitMs: 120_000,
			stopWaitMs: 60_000,
			deleteWaitMs: 60_000,
			lockWaitMs: 30_000,
		});
		expect(readKubernetesWaits({ OMP_KUBE_ENSURE_WAIT_MS: "1500" }).ensureWaitMs).toBe(1500);
	});

	test("rejects non-integer and out-of-range overrides", () => {
		for (const [name, raw] of [
			["OMP_KUBE_ENSURE_WAIT_MS", "0"],
			["OMP_KUBE_ENSURE_WAIT_MS", String(KUBERNETES_WAIT_MS_MAX + 1)],
			["OMP_KUBE_STOP_WAIT_MS", "not-a-number"],
			["OMP_KUBE_DELETE_WAIT_MS", "1.5"],
			["OMP_KUBE_LOCK_WAIT_MS", ""],
		]) {
			let code = "accepted";
			try {
				readKubernetesWaits({ [name]: raw });
			} catch (err) {
				code = err instanceof ProviderProtocolError ? err.code : "other";
			}
			expect(code).toBe("invalid_request");
		}
	});

	test("covers the lock plus every object wait even at the maximum knobs", () => {
		const max = String(KUBERNETES_WAIT_MS_MAX);
		const waits = readKubernetesWaits({
			OMP_KUBE_ENSURE_WAIT_MS: max,
			OMP_KUBE_STOP_WAIT_MS: max,
			OMP_KUBE_DELETE_WAIT_MS: max,
			OMP_KUBE_LOCK_WAIT_MS: max,
		});
		const timeouts = kubernetesOpTimeouts(waits);
		// The outer invoker timeout must outlast the child budget; the child
		// budget must outlast every wait the provider itself can consume.
		for (const op of ["inspect", "ensure-running", "stop", "delete"] as const) {
			expect(timeouts[op].invocationTimeoutMs).toBe(
				timeouts[op].childTimeoutMs + KUBERNETES_OP_TERMINATION_MS,
			);
		}
		expect(timeouts.inspect.childTimeoutMs).toBeGreaterThanOrEqual(waits.lockWaitMs);
		expect(timeouts.stop.childTimeoutMs).toBeGreaterThanOrEqual(
			waits.lockWaitMs + waits.stopWaitMs,
		);
		expect(timeouts.delete.childTimeoutMs).toBeGreaterThanOrEqual(
			waits.lockWaitMs + 3 * waits.deleteWaitMs,
		);
		expect(timeouts["ensure-running"].childTimeoutMs).toBeGreaterThanOrEqual(
			waits.lockWaitMs + waits.ensureWaitMs + waits.stopWaitMs + waits.deleteWaitMs,
		);
	});
});
