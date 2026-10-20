/**
 * Offline contract suite for the shipped Kubernetes provider
 * (apps/fleet/kubernetes-provider.ts; promoted from kube-smoke.test-raw.ts,
 * whose filename no bun test pattern matched). A stateful fake kubectl
 * implements the exact call shapes the provider issues; every case drives
 * runOp() / preflightKubernetesProfile() / buildPodManifest() end to end. No
 * cluster, no kubectl binary, no repo writes: the only scratch state is the
 * testkit-managed temp dir.
 *
 * The sections are sequential by construction (fresh ensure -> re-ensure ->
 * wiped record -> foreign squatters -> stop -> replacement -> delete ->
 * preflight -> manifests): each asserts on the cluster/stateDir the previous
 * section left behind, so the tests must stay in declaration order (bun runs a
 * file's tests serially unless `test.concurrent` opts out).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KUBERNETES_POD_LAYOUT } from "#lib/runtime/provider-protocol";
import { CALLBACK_ENV_FILE, readCallbackEnv } from "#lib/runtime/provider-callback-env";
import type {
	PreflightCheck,
	ProviderErrorResponse,
	ProviderOkResponse,
	KubernetesProfile,
	ProviderRequest,
	ProviderResponse,
} from "#lib/runtime/provider-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { KubeExecResult } from "../kubernetes-provider";
import { buildPodManifest, preflightKubernetesProfile, runOp } from "../kubernetes-provider";

afterAll(cleanupTempDirs);

// ---------------------------------------------------------------------------
// Stateful fake kubectl
// ---------------------------------------------------------------------------

interface FakePod {
	uid: string;
	phase: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	startTime?: string;
	containerReason?: string | null;
	/** Phase a Pending pod settles into (default Running). */
	settlesTo?: string;
}

interface FakePvc {
	labels: Record<string, string>;
	annotations: Record<string, string>;
	storageClassName?: string;
	size?: string;
	accessModes: string[];
}

class FakeCluster {
	pods = new Map<string, FakePod>();
	pvcs = new Map<string, FakePvc>();
	namespaces = new Set<string>(["omp-clones"]);
	storageClasses = new Set<string>(["standard"]);
	secrets = new Map<string, { data: Record<string, string> }>();
	rbac = new Set<string>();
	reachable = true;
	/** Phase the inventory helper pod settles into after creation. */
	helperPhase: "Succeeded" | "Failed" = "Succeeded";
	/** What `kubectl logs` returns for the helper. */
	sessionLog = "";
	/** Every inventory helper manifest the provider created. */
	helperManifests: Record<string, unknown>[] = [];
	context = "real-ctx";
	clientVersion = true;
}

const cluster = new FakeCluster();
const callLog: string[] = [];

const LABEL_MANAGED = "app.kubernetes.io/managed-by";
const ANN_WORKSPACE_ID = "omp-web.omp.dev/workspace-id";
const ANN_TOKEN = "omp-web.omp.dev/workspace-token";
const LABEL_GENERATION = "omp-web.omp.dev/generation";

function fakeExec(argv: readonly string[], input?: string): Promise<KubeExecResult> {
	return (async () => {
		const a = [...argv];
		const bin = a.shift();
		let ctx: string | null = null;
		const rest: string[] = [];
		for (let i = 0; i < a.length; i++) {
			const arg = a[i] as string;
			if (arg === "--context") {
				ctx = a[++i] as string;
				continue;
			}
			if (arg.startsWith("--request-timeout=")) continue;
			rest.push(arg);
		}
		callLog.push(JSON.stringify({ bin, ctx, rest, input }));
		const err = (code: number, msg: string): KubeExecResult => ({ code, stdout: "", stderr: msg });
		const json = (obj: unknown): KubeExecResult => ({
			code: 0,
			stdout: `${JSON.stringify(obj)}\n`,
			stderr: "",
		});
		const empty = (): KubeExecResult => ({ code: 0, stdout: "", stderr: "" });

		if (rest.length === 0) return err(1, "no verb");
		const verb = rest.shift() as string;

		if (!cluster.reachable && verb !== "version") {
			return err(1, "The connection to the server localhost:8080 was refused");
		}
		if (verb !== "version" && ctx !== cluster.context) {
			return err(1, `context "${String(ctx)}" does not exist`);
		}

		if (verb === "version") {
			if (rest[0] === "--client") {
				if (!cluster.clientVersion) return err(1, "client version unavailable");
				return json({ clientVersion: { gitVersion: "v1.29.0" } });
			}
			if (cluster.reachable) return json({ serverVersion: { gitVersion: "v1.29.0" } });
			return err(1, "The connection to the server localhost:8080 was refused");
		}

		if (verb === "logs") return { code: 0, stdout: cluster.sessionLog, stderr: "" };

		const kind = rest[0] as string | undefined;
		let name = rest[1] as string | undefined;
		let ns: string | null = null;
		for (let i = 1; i < rest.length; i++) {
			const arg = rest[i] as string;
			if (arg === "-n") {
				ns = rest[++i] as string;
			} else if (i === 1) {
				name = arg;
			}
		}

		if (verb === "get" && kind === "namespace") {
			if (cluster.namespaces.has(name as string)) return empty();
			return err(1, `Error from server (NotFound): namespaces "${name}" not found`);
		}
		if (verb === "get" && kind === "storageclass") {
			if (cluster.storageClasses.has(name as string)) return empty();
			return err(
				1,
				`Error from server (NotFound): storageclasses.storage.k8s.io "${name}" not found`,
			);
		}
		if (verb === "auth" && kind === "can-i") {
			const canVerb = rest[1] as string;
			const resource = rest[2] as string;
			if (cluster.rbac.has(`${canVerb}:${resource}:${ns}`)) return empty();
			return err(1, "no");
		}
		if (verb === "get" && kind === "secret") {
			const secret = cluster.secrets.get(name as string);
			if (secret === undefined)
				return err(1, `Error from server (NotFound): secrets "${name}" not found`);
			return json(secret);
		}
		if (verb === "get" && kind === "persistentvolumeclaim") {
			const pvc = cluster.pvcs.get(name as string);
			if (pvc === undefined) return empty(); // --ignore-not-found
			return json({
				apiVersion: "v1",
				kind: "PersistentVolumeClaim",
				metadata: {
					name,
					namespace: ns ?? "default",
					uid: `uid-${name}`,
					labels: pvc.labels,
					annotations: pvc.annotations,
				},
				spec: {
					accessModes: pvc.accessModes,
					storageClassName: pvc.storageClassName,
					resources: { requests: { storage: pvc.size } },
				},
			});
		}
		if (verb === "get" && kind === "pod") {
			const pod = cluster.pods.get(name as string);
			if (pod === undefined) return empty(); // --ignore-not-found
			const metadata: Record<string, unknown> = {
				name,
				namespace: ns ?? "default",
				uid: pod.uid,
				labels: pod.labels,
				annotations: pod.annotations,
			};
			if (pod.phase !== "Running") {
				// Simulated startup delay: Pending settles to Running quickly.
				// Real timer on purpose: the provider's awaited poll loop drives
				// it, so faked timers would stall the op under test.
				setTimeout(() => {
					const cur = cluster.pods.get(name as string);
					if (cur !== undefined && cur.phase === "Pending") cur.phase = cur.settlesTo ?? "Running";
				}, 30);
			}
			const status: Record<string, unknown> = { phase: pod.phase };
			if (pod.startTime !== undefined) status.startTime = pod.startTime;
			if (pod.containerReason !== undefined) {
				status.containerStatuses = [{ state: { waiting: { reason: pod.containerReason } } }];
			}
			return json({ apiVersion: "v1", kind: "Pod", metadata, status });
		}
		if (verb === "create") {
			const manifest = JSON.parse(input as string) as {
				kind: string;
				metadata: {
					name: string;
					labels: Record<string, string>;
					annotations: Record<string, string>;
				};
				spec: {
					accessModes?: string[];
					storageClassName?: string;
					resources?: { requests?: { storage?: string } };
				};
			};
			if (manifest.kind === "Pod") {
				const podName = manifest.metadata.name;
				if (cluster.pods.has(podName)) {
					return err(1, `Error from server (AlreadyExists): pods "${podName}" already exists`);
				}
				const uid = `uid-${podName}-${cluster.pods.size}`;
				cluster.pods.set(podName, {
					uid,
					phase: "Pending",
					labels: manifest.metadata.labels,
					annotations: manifest.metadata.annotations,
					startTime: new Date().toISOString(),
					// Inventory helpers run to completion instead of staying Running.
					...(podName.endsWith("-ls") ? { settlesTo: cluster.helperPhase } : {}),
				});
				if (podName.endsWith("-ls")) cluster.helperManifests.push(manifest);
				return json({ ...manifest, metadata: { ...manifest.metadata, uid } });
			}
			if (manifest.kind === "PersistentVolumeClaim") {
				const pvcName = manifest.metadata.name;
				if (cluster.pvcs.has(pvcName)) {
					return err(
						1,
						`Error from server (AlreadyExists): persistentvolumeclaims "${pvcName}" already exists`,
					);
				}
				cluster.pvcs.set(pvcName, {
					labels: manifest.metadata.labels,
					annotations: manifest.metadata.annotations,
					storageClassName: manifest.spec.storageClassName,
					size: manifest.spec.resources?.requests?.storage,
					accessModes: manifest.spec.accessModes ?? ["ReadWriteOnce"],
				});
				return empty();
			}
			return err(1, `unsupported create ${manifest.kind}`);
		}
		if (verb === "delete") {
			const kind2 = rest[0] as string;
			const name2 = rest[1] as string;
			if (kind2 === "pod") {
				if (!cluster.pods.has(name2)) {
					return err(1, `Error from server (NotFound): pods "${name2}" not found`);
				}
				cluster.pods.delete(name2);
				return empty();
			}
			if (kind2 === "persistentvolumeclaim") {
				if (!cluster.pvcs.has(name2)) {
					return err(
						1,
						`Error from server (NotFound): persistentvolumeclaims "${name2}" not found`,
					);
				}
				cluster.pvcs.delete(name2);
				return empty();
			}
			return err(1, `unsupported delete ${kind2}`);
		}
		return err(1, `unsupported kubectl verb ${verb}`);
	})();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE: KubernetesProfile = {
	id: "k8s-dev",
	provider: "kubernetes",
	executable: "/opt/omp-web/providers/kubernetes-provider",
	image: "registry.example.com/omp-web/session-runtime:1.0.0",
	namespace: "omp-clones",
	context: "real-ctx",
	resources: { cpu: "1", memory: "2Gi" },
	storage: { class: "standard", size: "10Gi" },
	secretRefs: { OMP_MODEL_KEY: "omp-model-secret/key" },
};

/**
 * Provider-private state dir. Cases C and D swap in a fresh (empty) dir to
 * simulate a provider restart that lost its identity record; the old file
 * deleted the dir instead, which is the same contract for the provider.
 */
let stateDir = tempDir("kube-smoke-");

function req(op: ProviderRequest["op"], over: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		op,
		workspaceId: "d1",
		generation: 1,
		workspaceDir: "/workspace/d1/.checkout",
		homeDir: "/workspace/d1/.home",
		profile: PROFILE,
		stateDir,
		...over,
	};
}

cluster.secrets.set("omp-model-secret", { data: { key: "c2VjcmV0LXZhbHVl" } });
for (const verb of ["get", "create", "delete"]) {
	for (const resource of ["pods", "persistentvolumeclaims"]) {
		cluster.rbac.add(`${verb}:${resource}:omp-clones`);
	}
}
cluster.rbac.add("get:pods/log:omp-clones");

const env: Record<string, string> = {
	OMP_KUBE_BIN: "kubectl",
	OMP_KUBE_ENSURE_WAIT_MS: "5000",
	OMP_KUBE_STOP_WAIT_MS: "5000",
	OMP_KUBE_DELETE_WAIT_MS: "5000",
	PATH: "/usr/bin:/bin",
};

/**
 * Cross-section state (the raw smoke held these in `main()` locals; the
 * section-per-describe port keeps them at module scope). Written by the case
 * that creates them, read by later sections that assert on them.
 */
/** Case A's ensure response; A3 asserts its handle grammar. */
let freshEnsure: ProviderResponse | undefined;
/** The d1 claim/pod name created by case A (deterministic for workspace d1). */
let d1Claim = "";
let d1Pod = "";

/**
 * Assert the success envelope (ok === true) and narrow it. The raw envelope is
 * the custom failure message, matching what the old `check(..., detail)`
 * printed for triage.
 */
function expectOk(resp: ProviderResponse): ProviderOkResponse {
	expect(resp.ok, JSON.stringify(resp)).toBe(true);
	if (!resp.ok || "checks" in resp)
		throw new Error(`expected ok envelope: ${JSON.stringify(resp)}`);
	return resp;
}

/**
 * Assert the failure envelope (ok === false) and narrow it. The raw envelope
 * is the custom failure message; the caller then pins code/message/retryable.
 */
function expectError(resp: ProviderResponse): ProviderErrorResponse {
	expect(resp.ok, JSON.stringify(resp)).toBe(false);
	if (resp.ok) throw new Error(`expected error envelope: ${JSON.stringify(resp)}`);
	return resp;
}

// ---------------------------------------------------------------------------
// Cases A-C: ensure, idempotent re-ensure, wiped-record rediscovery
// ---------------------------------------------------------------------------

describe("case A: fresh ensure creates PVC + pod, waits for Running", () => {
	test("A fresh ensure -> running", async () => {
		const fresh = await runOp(req("ensure-running"), { exec: fakeExec, env });
		freshEnsure = fresh;
		d1Claim = [...cluster.pvcs.keys()][0] ?? "";
		d1Pod = [...cluster.pods.keys()][0] ?? "";
		const ok = expectOk(fresh);
		expect(ok.observed).toBe("running");
	});

	test("A1 PVC deterministic name", () => {
		const detail = `${d1Claim} size=${cluster.pvcs.size}`;
		expect(d1Claim.startsWith("omp-ws-d1-"), detail).toBe(true);
		expect(cluster.pvcs.size, detail).toBe(1);
	});

	test("A2 pod same name as claim", () => {
		expect(d1Pod, `${d1Pod} != ${d1Claim}`).toBe(d1Claim);
	});

	test("A3 handle grammar", () => {
		const fresh = freshEnsure;
		expect(fresh?.ok, JSON.stringify(fresh)).toBe(true);
		if (fresh?.ok !== true || !("handle" in fresh)) {
			throw new Error(`no ok envelope from case A: ${JSON.stringify(fresh)}`);
		}
		expect(fresh.handle, JSON.stringify(fresh)).toMatch(/^k8s:omp-clones\/omp-ws-d1-[a-z0-9]+:g1$/);
	});

	test("A4 PVC ownership identity", () => {
		const ownedPvc = cluster.pvcs.get(d1Claim);
		expect(ownedPvc, JSON.stringify(ownedPvc)).toBeDefined();
		expect(ownedPvc!.labels[LABEL_MANAGED]).toBe("omp-web");
		expect(ownedPvc!.annotations[ANN_WORKSPACE_ID]).toBe("d1");
	});

	test("A5 pod ownership identity", () => {
		const ownedPod = cluster.pods.get(d1Pod);
		expect(ownedPod, JSON.stringify(ownedPod?.annotations)).toBeDefined();
		expect(ownedPod!.labels[LABEL_MANAGED]).toBe("omp-web");
		expect(ownedPod!.labels[LABEL_GENERATION]).toBe("1");
		expect(ownedPod!.annotations[ANN_TOKEN], JSON.stringify(ownedPod!.annotations)).not.toBe("");
	});
});

describe("case B: idempotent re-ensure (restart rediscovery with record intact)", () => {
	test("B re-ensure -> running, no duplicates", async () => {
		const again = expectOk(await runOp(req("ensure-running"), { exec: fakeExec, env }));
		expect(again.observed).toBe("running");
		expect(cluster.pods.size).toBe(1);
		expect(cluster.pvcs.size).toBe(1);
	});
});

describe("case C: wiped stateDir (provider restart), rediscovery from pod identity", () => {
	test("C wiped-record ensure -> running", async () => {
		// Fresh empty state dir == the old rmSync wipe: no identity record, so
		// the provider must rediscover the pod it owns from pod identity alone.
		stateDir = tempDir("kube-smoke-");
		const rediscovered = expectOk(await runOp(req("ensure-running"), { exec: fakeExec, env }));
		expect(rediscovered.observed).toBe("running");
	});

	test("C1 no duplicate resources", () => {
		const detail = `pods=${cluster.pods.size} pvcs=${cluster.pvcs.size}`;
		expect(cluster.pods.size, detail).toBe(1);
		expect(cluster.pvcs.size, detail).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Cases D-E: foreign/mismatched identity is a conflict, never adopted
// ---------------------------------------------------------------------------

describe("case D: foreign pod squatting on the deterministic name -> conflict, untouched", () => {
	test("D foreign pod -> conflict", async () => {
		const original = cluster.pods.get(d1Claim)!;
		cluster.pods.set(d1Claim, {
			uid: "uid-foreign",
			phase: "Running",
			labels: { [LABEL_MANAGED]: "someone-else" },
			annotations: { [ANN_TOKEN]: original.annotations[ANN_TOKEN] ?? "" },
		});
		// No identity record: the conflict must be proven by the pod's labels.
		stateDir = tempDir("kube-smoke-");
		try {
			const resp = expectError(await runOp(req("ensure-running"), { exec: fakeExec, env }));
			expect(resp.error.code).toBe("conflict");
			expect(resp.error.retryable).toBe(false);
		} finally {
			cluster.pods.delete(d1Claim);
			cluster.pods.set(d1Claim, original);
		}
	});
});

describe("case E: a pod whose token differs from the record is a conflict", () => {
	// Case C wiped the record; re-establish it (adopts the pod's token).
	test("E0 record seeded", async () => {
		const seeded = expectOk(await runOp(req("ensure-running"), { exec: fakeExec, env }));
		expect(seeded.observed).toBe("running");
	});

	test("E token mismatch -> conflict", async () => {
		const pod = cluster.pods.get(d1Claim)!;
		const snapshot = JSON.parse(JSON.stringify(pod)) as FakePod;
		cluster.pods.set(d1Claim, {
			...pod,
			annotations: { ...pod.annotations, [ANN_TOKEN]: "foreign-token" },
		});
		try {
			const resp = expectError(await runOp(req("ensure-running"), { exec: fakeExec, env }));
			expect(resp.error.code).toBe("conflict");
		} finally {
			// The record is never silently re-anchored to a foreign token.
			cluster.pods.set(d1Claim, snapshot);
		}
	});

	test("E1 restored pod adoptable again", async () => {
		const reEnsure = expectOk(await runOp(req("ensure-running"), { exec: fakeExec, env }));
		expect(reEnsure.observed).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// Cases F-G: stop retains the PVC; the replacement ensure reuses it
// ---------------------------------------------------------------------------

describe("case F: stop retains the PVC and proves the pod gone", () => {
	test("F stop -> stopped", async () => {
		const resp = expectOk(await runOp(req("stop"), { exec: fakeExec, env }));
		expect(resp.observed).toBe("stopped");
	});

	test("F1 pod gone from API", () => {
		expect(cluster.pods.has(d1Claim), `pod present: ${cluster.pods.has(d1Claim)}`).toBe(false);
	});

	test("F2 PVC retained", () => {
		expect(cluster.pvcs.has(d1Claim), d1Claim).toBe(true);
	});
});

describe("case F2: list-sessions proves the volume inventory with a read-only helper pod", () => {
	const END = "OMP_LIST_SESSIONS_END";

	test("F2a inventory is parsed and the helper is read-only, owned, and removed", async () => {
		cluster.sessionLog = `123\ts1/s1.jsonl\n45\ts1/sub/a.jsonl\n${END}\n`;
		const listed = expectOk(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.sessions).toEqual([
			{ path: "s1/s1.jsonl", size: 123 },
			{ path: "s1/sub/a.jsonl", size: 45 },
		]);
		expect(listed.complete).toBe(true);
		expect(cluster.pods.size, [...cluster.pods.keys()].join(",")).toBe(0);
		const manifest = cluster.helperManifests.at(-1) as {
			metadata: {
				name: string;
				labels: Record<string, string>;
				annotations: Record<string, string>;
			};
			spec: {
				restartPolicy: string;
				volumes: { persistentVolumeClaim: { claimName: string; readOnly: boolean } }[];
				containers: { volumeMounts: { readOnly: boolean }[]; command: string[] }[];
			};
		};
		expect(manifest.metadata.name).toBe(`${d1Claim}-ls`);
		expect(manifest.metadata.labels[LABEL_MANAGED]).toBe("omp-web");
		expect(manifest.metadata.annotations[ANN_WORKSPACE_ID]).toBe("d1");
		expect(manifest.spec.restartPolicy).toBe("Never");
		expect(manifest.spec.volumes[0]?.persistentVolumeClaim).toEqual({
			claimName: d1Claim,
			readOnly: true,
		});
		expect(manifest.spec.containers[0]?.volumeMounts[0]?.readOnly).toBe(true);
		expect(manifest.spec.containers[0]?.command.at(-1)).toContain(
			"/workspace/.home/agent/sessions",
		);
	});

	test("F2b an empty sessions dir is an empty complete inventory", async () => {
		cluster.sessionLog = `${END}\n`;
		const listed = expectOk(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.sessions).toEqual([]);
		expect(listed.complete).toBe(true);
	});

	test("F2c a listing without the end marker is a failure, not a shorter inventory", async () => {
		cluster.sessionLog = "123\ts1/s1.jsonl\n";
		const listed = expectError(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.error.code).toBe("unavailable");
		expect(listed.error.message).toMatch(/no end marker/);
		expect(cluster.pods.size).toBe(0);
	});

	test("F2d a malformed line is a failure", async () => {
		cluster.sessionLog = `not-a-size\ts1/s1.jsonl\n${END}\n`;
		const listed = expectError(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.error.code).toBe("unavailable");
		expect(listed.error.message).toMatch(/unparseable/);
	});

	test("F2e a helper that fails is a failure and is still removed", async () => {
		cluster.helperPhase = "Failed";
		cluster.sessionLog = "find: permission denied\n";
		const listed = expectError(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		cluster.helperPhase = "Succeeded";
		expect(listed.error.code).toBe("unavailable");
		expect(listed.error.message).toMatch(/failed \(Failed\)/);
		expect(cluster.pods.size).toBe(0);
	});

	test("F2f an inventory beyond the file bound is truncated and flagged incomplete", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 10_001; i++) lines.push(`1\ts1/f${i}.jsonl`);
		cluster.sessionLog = `${lines.join("\n")}\n${END}\n`;
		const listed = expectOk(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.sessions?.length).toBe(10_000);
		expect(listed.complete).toBe(false);
	});

	test("F2g a workspace with no claim has an empty complete inventory", async () => {
		const listed = expectOk(
			await runOp(req("list-sessions", { workspaceId: "d9" }), { exec: fakeExec, env }),
		);
		expect(listed.observed).toBe("missing");
		expect(listed.sessions).toEqual([]);
		expect(listed.complete).toBe(true);
	});
});

describe("case G: replacement ensure reuses the PVC, new pod, single claim", () => {
	test("G replacement ensure -> running", async () => {
		const resp = expectOk(await runOp(req("ensure-running"), { exec: fakeExec, env }));
		expect(resp.observed).toBe("running");
	});

	test("G1 single PVC reused", () => {
		expect(cluster.pvcs.size, d1Claim).toBe(1);
		expect(cluster.pvcs.has(d1Claim), d1Claim).toBe(true);
	});

	test("G2 pod recreated", () => {
		expect(cluster.pods.has(d1Claim), d1Claim).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Cases H-I: generation fencing
// ---------------------------------------------------------------------------

describe("case H: ensure generation 2 while generation 1 pod runs", () => {
	test("H gen bump while running -> conflict", async () => {
		const gen2 = expectError(
			await runOp(req("ensure-running", { generation: 2 }), { exec: fakeExec, env }),
		);
		expect(gen2.error.code).toBe("conflict");
		expect(gen2.error.message).toMatch(/generation/);
	});
});

describe("case I: stop generation 2 against a gen-1 pod", () => {
	test("I stop wrong generation -> conflict", async () => {
		const stopGen2 = expectError(
			await runOp(req("stop", { generation: 2 }), { exec: fakeExec, env }),
		);
		expect(stopGen2.error.code).toBe("conflict");
	});
});

describe("case I2: list-sessions refuses while the workspace pod exists", () => {
	test("I2 live pod -> conflict (retryable), no helper created", async () => {
		const before = cluster.helperManifests.length;
		const listed = expectError(await runOp(req("list-sessions"), { exec: fakeExec, env }));
		expect(listed.error.code).toBe("conflict");
		expect(listed.error.retryable).toBe(true);
		expect(listed.error.message).toMatch(/stop the workspace/);
		expect(cluster.helperManifests.length).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Case J: delete auto-stops through the gate, then removes the claim
// ---------------------------------------------------------------------------

describe("case J: delete while running, auto-stop through the gate, then PVC removal", () => {
	test("J delete (auto-stop) -> missing", async () => {
		const resp = expectOk(await runOp(req("delete"), { exec: fakeExec, env }));
		expect(resp.observed).toBe("missing");
	});

	test("J1 PVC removed", () => {
		expect(cluster.pvcs.has(d1Claim), d1Claim).toBe(false);
	});

	test("J2 pod removed", () => {
		expect(cluster.pods.has(d1Claim), d1Claim).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cases K-M: foreign claim / immutable drift are conflicts, never recreated
// ---------------------------------------------------------------------------

describe("case K: foreign PVC on the deterministic name", () => {
	test("K foreign PVC -> conflict", async () => {
		const pvcName = "omp-ws-d7-82396aa3";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "someone-else" },
			annotations: { [ANN_WORKSPACE_ID]: "d7" },
			storageClassName: "standard",
			size: "10Gi",
			accessModes: ["ReadWriteOnce"],
		});
		try {
			const resp = expectError(
				await runOp(req("ensure-running", { workspaceId: "d7" }), { exec: fakeExec, env }),
			);
			expect(resp.error.code).toBe("conflict");
			expect(resp.error.message).toMatch(/foreign claim/);
		} finally {
			cluster.pvcs.delete(pvcName);
		}
	});
});

describe("case L: PVC storageClass drift", () => {
	test("L storageClass drift -> conflict", async () => {
		const pvcName = "omp-ws-d8-56f89215";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "omp-web" },
			annotations: { [ANN_WORKSPACE_ID]: "d8", [ANN_TOKEN]: "t" },
			storageClassName: "slow-class",
			size: "10Gi",
			accessModes: ["ReadWriteOnce"],
		});
		try {
			const resp = expectError(
				await runOp(req("ensure-running", { workspaceId: "d8" }), { exec: fakeExec, env }),
			);
			expect(resp.error.code).toBe("conflict");
			expect(resp.error.message).toMatch(/immutable/);
		} finally {
			cluster.pvcs.delete(pvcName);
		}
	});
});

describe("case M: PVC size drift", () => {
	test("M size drift -> conflict", async () => {
		const pvcName = "omp-ws-d9-f0b8e894";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "omp-web" },
			annotations: { [ANN_WORKSPACE_ID]: "d9", [ANN_TOKEN]: "t" },
			storageClassName: "standard",
			size: "100Gi",
			accessModes: ["ReadWriteOnce"],
		});
		try {
			const resp = expectError(
				await runOp(req("ensure-running", { workspaceId: "d9" }), { exec: fakeExec, env }),
			);
			expect(resp.error.code).toBe("conflict");
			expect(resp.error.message).toMatch(/requests/);
		} finally {
			cluster.pvcs.delete(pvcName);
		}
	});
});

// ---------------------------------------------------------------------------
// Cases N-O: request-shape rejections
// ---------------------------------------------------------------------------

describe("case N: source.local on kubernetes", () => {
	test("N source.local -> invalid_request", async () => {
		const local = expectError(
			await runOp(req("ensure-running", { source: { local: "/host/x" } } as ProviderRequest), {
				exec: fakeExec,
				env,
			}),
		);
		expect(local.error.code).toBe("invalid_request");
		expect(local.error.retryable).toBe(false);
		expect(local.error.message).toMatch(/remote/);
	});
});

describe("case O: no explicit context anywhere (never ambient)", () => {
	test("O no context -> invalid_request", async () => {
		const noCtx = expectError(
			await runOp(req("ensure-running", { profile: { ...PROFILE, context: undefined } }), {
				exec: fakeExec,
				env: { ...env, OMP_KUBE_CONTEXT: undefined },
			}),
		);
		expect(noCtx.error.code).toBe("invalid_request");
		expect(noCtx.error.message).toMatch(/context/);
	});
});

// ---------------------------------------------------------------------------
// Case P: inspect after teardown -> missing, strict envelope
// ---------------------------------------------------------------------------

describe("case P: inspect after teardown", () => {
	test("P inspect missing + strict envelope", async () => {
		const inspect = expectOk(await runOp(req("inspect"), { exec: fakeExec, env }));
		expect(inspect.observed).toBe("missing");
		const allowedKeys = ["ok", "handle", "observed", "pid", "startedAt", "error"];
		expect(
			Object.keys(inspect).every((k) => allowedKeys.includes(k)),
			JSON.stringify(inspect),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Case Q: preflight, full pass and each missing-prerequisite variant
// ---------------------------------------------------------------------------

describe("case Q: preflight", () => {
	/** Run the provider's preflight and return its rows (the library entry the op dispatches to). */
	const preflight = (profile: KubernetesProfile, opEnv: Record<string, string | undefined> = env) =>
		preflightKubernetesProfile(profile, { exec: fakeExec, env: opEnv });
	const failingNames = (checks: PreflightCheck[]) =>
		JSON.stringify(checks.filter((c) => !c.ok).map((c) => c.name));

	test("Q0 preflight all ok", async () => {
		const checks = await preflight(PROFILE);
		const failing = checks.filter((c) => !c.ok);
		expect(
			failing.length,
			JSON.stringify(failing.map((c) => ({ name: c.name, detail: c.detail }))),
		).toBe(0);
	});

	test("Q0b the preflight op answers {ok:true, checks} with the same rows", async () => {
		const response = await runOp(req("preflight"), { exec: fakeExec, env });
		expect(response.ok, JSON.stringify(response)).toBe(true);
		if (!response.ok || !("checks" in response)) {
			throw new Error(`expected a preflight envelope: ${JSON.stringify(response)}`);
		}
		expect(response.checks.map((c) => c.name)).toEqual(
			(await preflight(PROFILE)).map((c) => c.name),
		);
		expect(Object.keys(response).sort()).toEqual(["checks", "ok"]);
	});

	test("Q1 preflight no context", async () => {
		const checks = await preflight(
			{ ...PROFILE, context: undefined },
			{
				...env,
				OMP_KUBE_CONTEXT: undefined,
			},
		);
		const ctxCheck = checks.find((c) => c.name === "kube-context");
		expect(ctxCheck, JSON.stringify(ctxCheck)).toBeDefined();
		expect(ctxCheck!.ok).toBe(false);
		expect(ctxCheck!.remediation ?? "").toMatch(/context/);
	});

	test("Q2 preflight API down", async () => {
		cluster.reachable = false;
		try {
			const checks = await preflight(PROFILE);
			expect(
				checks.some((c) => c.name === "kube-api" && !c.ok && (c.remediation ?? "") !== ""),
				failingNames(checks),
			).toBe(true);
		} finally {
			cluster.reachable = true;
		}
	});

	test("Q3 preflight RBAC gap", async () => {
		cluster.rbac.delete("create:persistentvolumeclaims:omp-clones");
		try {
			const checks = await preflight(PROFILE);
			expect(
				checks.some(
					(c) =>
						c.name === "kube-rbac-create-persistentvolumeclaims" &&
						!c.ok &&
						/Role/.test(c.remediation ?? ""),
				),
				failingNames(checks),
			).toBe(true);
		} finally {
			cluster.rbac.add("create:persistentvolumeclaims:omp-clones");
		}
	});

	test("Q4 preflight secret missing", async () => {
		cluster.secrets.delete("omp-model-secret");
		try {
			const checks = await preflight(PROFILE);
			expect(
				checks.some(
					(c) =>
						c.name === "kube-secret-OMP_MODEL_KEY" &&
						!c.ok &&
						/create secret/.test(c.remediation ?? ""),
				),
				failingNames(checks),
			).toBe(true);
		} finally {
			cluster.secrets.set("omp-model-secret", { data: { key: "c2VjcmV0LXZhbHVl" } });
		}
	});

	test("Q5 preflight storageclass missing", async () => {
		cluster.storageClasses.delete("standard");
		try {
			const checks = await preflight(PROFILE);
			expect(
				checks.some((c) => c.name === "kube-storageclass" && !c.ok),
				failingNames(checks),
			).toBe(true);
		} finally {
			cluster.storageClasses.add("standard");
		}
	});

	test("Q6 preflight namespace missing", async () => {
		cluster.namespaces.delete("omp-clones");
		try {
			const checks = await preflight(PROFILE);
			expect(
				checks.some((c) => c.name === "kube-namespace" && !c.ok),
				failingNames(checks),
			).toBe(true);
		} finally {
			cluster.namespaces.add("omp-clones");
		}
	});
});

// ---------------------------------------------------------------------------
// Case R: pod manifest rendering (no Service, callback env, secretKeyRef)
// ---------------------------------------------------------------------------

/** The pod spec shape case R asserts on (buildPodManifest returns a record). */
interface PodSpec {
	restartPolicy: string;
	automountServiceAccountToken: boolean;
	volumes: Array<{ name: string }>;
	containers: Array<{
		env: Array<{ name: string; value?: string; valueFrom?: Record<string, unknown> }>;
		securityContext: Record<string, unknown>;
		resources: Record<string, unknown>;
	}>;
	/** Never rendered by the provider; case R2 asserts it stays absent. */
	service?: unknown;
}

describe("case R: pod manifests render correctly", () => {
	/** Exactly case R's raw manifest input; pure, so each case rebuilds it. */
	function podManifest(callbackEnv: Record<string, string> = {}): Record<string, unknown> {
		return buildPodManifest(
			{
				kubectlBin: "kubectl",
				context: "real-ctx",
				namespace: "omp-clones",
				image: PROFILE.image as string,
				resources: PROFILE.resources,
				storageClass: "standard",
				storageSize: "10Gi",
				secretRefs: {
					OMP_MODEL_KEY: {
						secretName: "omp-model-secret",
						secretKey: "key",
						envName: "OMP_MODEL_KEY",
					},
				},
			},
			{
				op: "ensure-running",
				workspaceId: "d1",
				generation: 1,
				workspaceDir: "/workspace/d1/.checkout",
				homeDir: "/workspace/d1/.home",
				profile: PROFILE,
				stateDir,
				source: { remote: "https://example.com/repo.git" },
				revision: "0123456789012345678901234567890123456789",
				branch: "main",
			},
			"tok-1",
			{ OMP_SESSION_CALLBACK_URL: "https://fleet.example/cb", ...callbackEnv },
		);
	}

	/**
	 * The fresh manifest's spec, cast once: buildPodManifest returns a loose
	 * record (the raw case R cast the same shape at each use site).
	 */
	function podSpec(): PodSpec {
		return podManifest().spec as PodSpec;
	}

	test("R1 pod kind", () => {
		const pod = podManifest();
		expect(pod.kind, String(pod.kind)).toBe("Pod");
	});

	test("R2 no service field", () => {
		const spec = podSpec();
		expect(spec.service, "service present?").toBeUndefined();
	});

	test("R3 restartPolicy Never", () => {
		const spec = podSpec();
		expect(spec.restartPolicy, spec.restartPolicy).toBe("Never");
	});

	test("R4 no SA token automount", () => {
		const spec = podSpec();
		expect(spec.automountServiceAccountToken, String(spec.automountServiceAccountToken)).toBe(
			false,
		);
	});

	test("R5 workspace env", () => {
		const spec = podSpec();
		const envNames = spec.containers[0].env.map((e) => e.name);
		const detail = envNames.join(",");
		expect(envNames, detail).toContain("OMP_WORKSPACE_ID");
		expect(envNames, detail).toContain("OMP_WORKSPACE_DIR");
		expect(envNames, detail).toContain("PI_CODING_AGENT_DIR");
	});

	test("R6 prep env injected", () => {
		const spec = podSpec();
		const envNames = spec.containers[0].env.map((e) => e.name);
		const detail = envNames.join(",");
		expect(envNames, detail).toContain("OMP_PREP_SOURCE_REMOTE");
		expect(envNames, detail).toContain("OMP_PREP_REVISION");
	});

	test("R7 callback env injected", () => {
		const spec = podSpec();
		const envNames = spec.containers[0].env.map((e) => e.name);
		expect(envNames, envNames.join(",")).toContain("OMP_SESSION_CALLBACK_URL");
	});

	test("R8 secretKeyRef, not value", () => {
		const spec = podSpec();
		const modelKey = spec.containers[0].env.find((e) => e.name === "OMP_MODEL_KEY");
		expect(modelKey?.valueFrom?.secretKeyRef, JSON.stringify(modelKey)).toBeDefined();
	});

	test("R9 hardened securityContext", () => {
		const spec = podSpec();
		const securityContext = spec.containers[0].securityContext;
		const detail = JSON.stringify(securityContext);
		expect(securityContext.allowPrivilegeEscalation, detail).toBe(false);
		expect(securityContext.capabilities, detail).toEqual({ drop: ["ALL"] });
	});

	test("R10 volumes PVC + tmp", () => {
		const spec = podSpec();
		expect(
			spec.volumes.map((v) => v.name),
			JSON.stringify(spec.volumes),
		).toEqual(["workspace", "tmp"]);
	});

	/** Write the fleet's callback-env.json handoff and read it back as the provider does. */
	function handoffEnv(env: Record<string, string>): Record<string, string> | null {
		const dir = tempDir("kube-smoke-handoff-");
		writeFileSync(
			join(dir, CALLBACK_ENV_FILE),
			JSON.stringify({ version: 1, workspaceId: "d1", generation: 1, env }),
			{ mode: 0o600 },
		);
		return readCallbackEnv("kube-smoke", dir, "d1", 1);
	}

	const PAIR_ENV = {
		OMP_SESSION_CALLBACK_URL: "https://fleet.example/cb",
		OMP_SESSION_CALLBACK_WORKSPACE: "d1",
		OMP_SESSION_CALLBACK_GENERATION: "1",
		OMP_SESSION_CALLBACK_TOKEN: "tok",
	};
	const RESUME_PATH = `${KUBERNETES_POD_LAYOUT.sessionsDir}/--workspace-.checkout--/20260906T1200_sess1.jsonl`;

	test("R11 a wake resume hint in the handoff file reaches the pod env", () => {
		const env = handoffEnv({ ...PAIR_ENV, OMP_SESSION_RESUME: RESUME_PATH });
		expect(env?.OMP_SESSION_RESUME).toBe(RESUME_PATH);
		const rendered = (podManifest(env ?? {}).spec as PodSpec).containers[0].env;
		expect(rendered.find((e) => e.name === "OMP_SESSION_RESUME")?.value).toBe(RESUME_PATH);
		expect(rendered.find((e) => e.name === "OMP_SESSION_RESUME_UNWRITTEN")).toBeUndefined();
	});

	test("R12 the unwritten marker rides with the hint; a first start renders neither", () => {
		const env = handoffEnv({
			...PAIR_ENV,
			OMP_SESSION_RESUME: RESUME_PATH,
			OMP_SESSION_RESUME_UNWRITTEN: "1",
		});
		const rendered = (podManifest(env ?? {}).spec as PodSpec).containers[0].env;
		expect(rendered.find((e) => e.name === "OMP_SESSION_RESUME_UNWRITTEN")?.value).toBe("1");

		const fresh = (podManifest(handoffEnv(PAIR_ENV) ?? {}).spec as PodSpec).containers[0].env;
		expect(fresh.map((e) => e.name)).not.toContain("OMP_SESSION_RESUME");
		expect(fresh.map((e) => e.name)).not.toContain("OMP_SESSION_RESUME_UNWRITTEN");
	});

	test("R13 the handoff file still refuses env keys outside the closed list", () => {
		expect(() => handoffEnv({ ...PAIR_ENV, OMP_SESSION_NAME: "x" })).toThrow(
			"not an allowed callback env key",
		);
	});
});
