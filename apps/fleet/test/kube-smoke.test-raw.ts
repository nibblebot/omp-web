/**
 * Throwaway offline smoke for runtime/providers/kubernetes-provider.ts.
 * A stateful fake kubectl implements the exact call shapes the provider
 * issues; every case drives runOp()/preflightKubernetesProfile() end to
 * end. No cluster, no kubectl binary, no repo writes beyond /tmp state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPodManifest, preflightKubernetesProfile, runOp } from "../kubernetes-provider";
import type { KubeExecResult } from "../kubernetes-provider";
import type { ProviderProfile, ProviderRequest } from "../../../lib/runtime/provider-protocol";
import type { PreflightCheck } from "../preflight";

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
	if (cond) {
		console.log(`PASS ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name}: ${detail}`);
	}
}

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
				setTimeout(() => {
					const cur = cluster.pods.get(name as string);
					if (cur !== undefined && cur.phase === "Pending") cur.phase = "Running";
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
				});
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

type KubeProfile = ProviderProfile & { context?: string };

const PROFILE: KubeProfile = {
	id: "k8s-dev",
	provider: "kubernetes",
	executable: "/opt/omp-web/providers/kubernetes-provider",
	tools: [],
	image: "registry.example.com/omp-web/session-runtime:1.0.0",
	namespace: "omp-clones",
	context: "real-ctx",
	resources: { cpu: "1", memory: "2Gi" },
	storage: { class: "standard", size: "10Gi" },
	secretRefs: { OMP_MODEL_KEY: "omp-model-secret/key" },
};

const stateDir = mkdtempSync(join(tmpdir(), "kube-smoke-"));

function req(op: ProviderRequest["op"], over: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		op,
		workspaceId: "d1",
		generation: 1,
		workspaceDir: "/workspace/d1/.checkout",
		homeDir: "/workspace/d1/.home",
		profile: PROFILE as ProviderProfile,
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

const env: Record<string, string> = {
	OMP_KUBE_BIN: "kubectl",
	OMP_KUBE_ENSURE_WAIT_MS: "5000",
	OMP_KUBE_STOP_WAIT_MS: "5000",
	OMP_KUBE_DELETE_WAIT_MS: "5000",
	PATH: "/usr/bin:/bin",
};

function firstPvcName(): string {
	return [...cluster.pvcs.keys()][0] ?? "";
}
function firstPodName(): string {
	return [...cluster.pods.keys()][0] ?? "";
}

async function main(): Promise<void> {
	// Case A: fresh ensure creates PVC + pod, waits for Running.
	const fresh = await runOp(req("ensure-running"), { exec: fakeExec, env });
	check(
		"A fresh ensure -> running",
		fresh.ok === true && fresh.observed === "running",
		JSON.stringify(fresh),
	);
	const pvcA = firstPvcName();
	const podA = firstPodName();
	check(
		"A1 PVC deterministic name",
		pvcA.startsWith("omp-ws-d1-") && cluster.pvcs.size === 1,
		`${pvcA} size=${cluster.pvcs.size}`,
	);
	check("A2 pod same name as claim", podA === pvcA, `${podA} != ${pvcA}`);
	check(
		"A3 handle grammar",
		fresh.ok === true &&
			/^k8s:omp-clones\/omp-ws-d1-[a-z0-9]+:g1$/.test((fresh as { handle: string }).handle),
		JSON.stringify(fresh),
	);
	const ownedPvc = cluster.pvcs.get(pvcA);
	check(
		"A4 PVC ownership identity",
		ownedPvc !== undefined &&
			ownedPvc.labels[LABEL_MANAGED] === "omp-web" &&
			ownedPvc.annotations[ANN_WORKSPACE_ID] === "d1",
		JSON.stringify(ownedPvc),
	);
	const ownedPod = cluster.pods.get(podA);
	check(
		"A5 pod ownership identity",
		ownedPod !== undefined &&
			ownedPod.labels[LABEL_MANAGED] === "omp-web" &&
			ownedPod.labels[LABEL_GENERATION] === "1" &&
			ownedPod.annotations[ANN_TOKEN] !== "",
		JSON.stringify(ownedPod?.annotations),
	);

	// Case B: idempotent re-ensure (restart rediscovery with record intact).
	const again = await runOp(req("ensure-running"), { exec: fakeExec, env });
	check(
		"B re-ensure -> running, no duplicates",
		again.ok === true &&
			again.observed === "running" &&
			cluster.pods.size === 1 &&
			cluster.pvcs.size === 1,
		JSON.stringify(again),
	);

	// Case C: wiped stateDir (provider restart), rediscovery from pod identity.
	rmSync(stateDir, { recursive: true, force: true });
	const rediscovered = await runOp(req("ensure-running"), { exec: fakeExec, env });
	check(
		"C wiped-record ensure -> running",
		rediscovered.ok === true && rediscovered.observed === "running",
		JSON.stringify(rediscovered),
	);
	check(
		"C1 no duplicate resources",
		cluster.pods.size === 1 && cluster.pvcs.size === 1,
		`pods=${cluster.pods.size} pvcs=${cluster.pvcs.size}`,
	);

	// Case D: foreign pod squatting on the deterministic name -> conflict, untouched.
	{
		const pvcName = firstPvcName();
		const original = cluster.pods.get(pvcName) as FakePod;
		cluster.pods.set(pvcName, {
			uid: "uid-foreign",
			phase: "Running",
			labels: { [LABEL_MANAGED]: "someone-else" },
			annotations: { [ANN_TOKEN]: original.annotations[ANN_TOKEN] ?? "" },
		});
		rmSync(stateDir, { recursive: true, force: true });
		const resp = await runOp(req("ensure-running"), { exec: fakeExec, env });
		check(
			"D foreign pod -> conflict",
			resp.ok === false && resp.error.code === "conflict" && resp.error.retryable === false,
			JSON.stringify(resp),
		);
		cluster.pods.delete(pvcName);
		cluster.pods.set(pvcName, original);
	}

	// Case E: with an identity record present, a pod whose token differs from
	// the record is a conflict; the record is never silently re-anchored.
	{
		const pvcName = firstPvcName();
		// Case C wiped the record; re-establish it (adopts the pod's token).
		const seeded = await runOp(req("ensure-running"), { exec: fakeExec, env });
		check(
			"E0 record seeded",
			seeded.ok === true && seeded.observed === "running",
			JSON.stringify(seeded),
		);
		const pod = cluster.pods.get(pvcName) as FakePod;
		const snapshot = JSON.parse(JSON.stringify(pod)) as FakePod;
		cluster.pods.set(pvcName, {
			...pod,
			annotations: { ...pod.annotations, [ANN_TOKEN]: "foreign-token" },
		});
		const resp = await runOp(req("ensure-running"), { exec: fakeExec, env });
		check(
			"E token mismatch -> conflict",
			resp.ok === false && resp.error.code === "conflict",
			JSON.stringify(resp),
		);
		cluster.pods.set(pvcName, snapshot);
		// Restored: the provider's own pod is adoptable again.
		const reEnsure = await runOp(req("ensure-running"), { exec: fakeExec, env });
		check(
			"E1 restored pod adoptable again",
			reEnsure.ok === true && reEnsure.observed === "running",
			JSON.stringify(reEnsure),
		);
	}

	// Case F: stop retains the PVC and proves the pod gone.
	{
		const pvcName = firstPvcName();
		const resp = await runOp(req("stop"), { exec: fakeExec, env });
		check(
			"F stop -> stopped",
			resp.ok === true && resp.observed === "stopped",
			JSON.stringify(resp),
		);
		check(
			"F1 pod gone from API",
			!cluster.pods.has(pvcName),
			`pod present: ${cluster.pods.has(pvcName)}`,
		);
		check("F2 PVC retained", cluster.pvcs.has(pvcName), pvcName);
	}

	// Case G: replacement ensure reuses the PVC, new pod, single claim.
	{
		const pvcName = firstPvcName();
		const resp = await runOp(req("ensure-running"), { exec: fakeExec, env });
		check(
			"G replacement ensure -> running",
			resp.ok === true && resp.observed === "running",
			JSON.stringify(resp),
		);
		check("G1 single PVC reused", cluster.pvcs.size === 1 && cluster.pvcs.has(pvcName), pvcName);
		check("G2 pod recreated", cluster.pods.has(pvcName), pvcName);
	}

	// Case H: ensure generation 2 while generation 1 pod runs -> conflict.
	const gen2 = await runOp(req("ensure-running", { generation: 2 }), { exec: fakeExec, env });
	check(
		"H gen bump while running -> conflict",
		gen2.ok === false && gen2.error.code === "conflict" && /generation/.test(gen2.error.message),
		JSON.stringify(gen2),
	);

	// Case I: stop generation 2 against a gen-1 pod -> conflict.
	const stopGen2 = await runOp(req("stop", { generation: 2 }), { exec: fakeExec, env });
	check(
		"I stop wrong generation -> conflict",
		stopGen2.ok === false && stopGen2.error.code === "conflict",
		JSON.stringify(stopGen2),
	);

	// Case J: delete while running, auto-stop through the gate, then PVC removal.
	{
		const pvcName = firstPvcName();
		const resp = await runOp(req("delete"), { exec: fakeExec, env });
		check(
			"J delete (auto-stop) -> missing",
			resp.ok === true && resp.observed === "missing",
			JSON.stringify(resp),
		);
		check("J1 PVC removed", !cluster.pvcs.has(pvcName), pvcName);
		check("J2 pod removed", !cluster.pods.has(pvcName), pvcName);
	}

	// Case K: foreign PVC on the deterministic name -> conflict, never deleted.
	{
		const pvcName = "omp-ws-d7-82396aa3";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "someone-else" },
			annotations: { [ANN_WORKSPACE_ID]: "d7" },
			storageClassName: "standard",
			size: "10Gi",
			accessModes: ["ReadWriteOnce"],
		});
		const resp = await runOp(req("ensure-running", { workspaceId: "d7" }), { exec: fakeExec, env });
		check(
			"K foreign PVC -> conflict",
			resp.ok === false &&
				resp.error.code === "conflict" &&
				/foreign claim/.test(resp.error.message),
			JSON.stringify(resp),
		);
		cluster.pvcs.delete(pvcName);
	}

	// Case L: PVC storageClass drift -> conflict, never recreated.
	{
		const pvcName = "omp-ws-d8-56f89215";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "omp-web" },
			annotations: { [ANN_WORKSPACE_ID]: "d8", [ANN_TOKEN]: "t" },
			storageClassName: "slow-class",
			size: "10Gi",
			accessModes: ["ReadWriteOnce"],
		});
		const resp = await runOp(req("ensure-running", { workspaceId: "d8" }), { exec: fakeExec, env });
		check(
			"L storageClass drift -> conflict",
			resp.ok === false && resp.error.code === "conflict" && /immutable/.test(resp.error.message),
			JSON.stringify(resp),
		);
		cluster.pvcs.delete(pvcName);
	}

	// Case M: PVC size drift -> conflict.
	{
		const pvcName = "omp-ws-d9-f0b8e894";
		cluster.pvcs.set(pvcName, {
			labels: { [LABEL_MANAGED]: "omp-web" },
			annotations: { [ANN_WORKSPACE_ID]: "d9", [ANN_TOKEN]: "t" },
			storageClassName: "standard",
			size: "100Gi",
			accessModes: ["ReadWriteOnce"],
		});
		const resp = await runOp(req("ensure-running", { workspaceId: "d9" }), { exec: fakeExec, env });
		check(
			"M size drift -> conflict",
			resp.ok === false && resp.error.code === "conflict" && /requests/.test(resp.error.message),
			JSON.stringify(resp),
		);
		cluster.pvcs.delete(pvcName);
	}

	// Case N: source.local on kubernetes -> invalid_request (retryable=false).
	const local = await runOp(
		req("ensure-running", { source: { local: "/host/x" } } as ProviderRequest),
		{ exec: fakeExec, env },
	);
	check(
		"N source.local -> invalid_request",
		local.ok === false &&
			local.error.code === "invalid_request" &&
			local.error.retryable === false &&
			/remote/.test(local.error.message),
		JSON.stringify(local),
	);

	// Case O: no explicit context anywhere -> invalid_request (never ambient).
	const noCtx = await runOp(
		req("ensure-running", { profile: { ...PROFILE, context: undefined } as ProviderProfile }),
		{
			exec: fakeExec,
			env: { ...env, OMP_KUBE_CONTEXT: undefined },
		},
	);
	check(
		"O no context -> invalid_request",
		noCtx.ok === false &&
			noCtx.error.code === "invalid_request" &&
			/context/.test(noCtx.error.message),
		JSON.stringify(noCtx),
	);

	// Case P: inspect after teardown -> missing, strict envelope.
	const inspect = await runOp(req("inspect"), { exec: fakeExec, env });
	const allowedKeys = ["ok", "handle", "observed", "pid", "startedAt", "error"];
	check(
		"P inspect missing + strict envelope",
		inspect.ok === true &&
			inspect.observed === "missing" &&
			Object.keys(inspect).every((k) => allowedKeys.includes(k)),
		JSON.stringify(inspect),
	);

	// Case Q: preflight, full pass and each missing-prerequisite variant.
	{
		const allOk = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		const failing: PreflightCheck[] = allOk.checks.filter((c) => !c.ok);
		check(
			"Q0 preflight all ok",
			allOk.ok === true,
			JSON.stringify(failing.map((c) => ({ name: c.name, detail: c.detail }))),
		);

		const noCtxP = await preflightKubernetesProfile(
			{ ...PROFILE, context: undefined } as ProviderProfile,
			{
				exec: fakeExec,
				env: { ...env, OMP_KUBE_CONTEXT: undefined },
			},
		);
		const ctxCheck = noCtxP.checks.find((c) => c.name === "kube-context");
		check(
			"Q1 preflight no context",
			noCtxP.ok === false &&
				ctxCheck !== undefined &&
				!ctxCheck.ok &&
				/context/.test(ctxCheck.remediation ?? ""),
			JSON.stringify(ctxCheck),
		);

		cluster.reachable = false;
		const apiDown = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		check(
			"Q2 preflight API down",
			apiDown.ok === false && apiDown.checks.some((c) => c.name === "kube-api" && !c.ok),
			JSON.stringify(apiDown.checks.filter((c) => !c.ok).map((c) => c.name)),
		);
		cluster.reachable = true;

		cluster.rbac.delete("create:persistentvolumeclaims:omp-clones");
		const noRbac = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		check(
			"Q3 preflight RBAC gap",
			noRbac.ok === false &&
				noRbac.checks.some(
					(c) =>
						c.name === "kube-rbac-create-persistentvolumeclaims" &&
						!c.ok &&
						/Role/.test(c.remediation ?? ""),
				),
			JSON.stringify(noRbac.checks.filter((c) => !c.ok).map((c) => c.name)),
		);
		cluster.rbac.add("create:persistentvolumeclaims:omp-clones");

		cluster.secrets.delete("omp-model-secret");
		const noSecret = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		check(
			"Q4 preflight secret missing",
			noSecret.ok === false &&
				noSecret.checks.some(
					(c) =>
						c.name === "kube-secret-OMP_MODEL_KEY" &&
						!c.ok &&
						/create secret/.test(c.remediation ?? ""),
				),
			JSON.stringify(noSecret.checks.filter((c) => !c.ok).map((c) => c.name)),
		);
		cluster.secrets.set("omp-model-secret", { data: { key: "c2VjcmV0LXZhbHVl" } });

		cluster.storageClasses.delete("standard");
		const noSc = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		check(
			"Q5 preflight storageclass missing",
			noSc.ok === false && noSc.checks.some((c) => c.name === "kube-storageclass" && !c.ok),
			JSON.stringify(noSc.checks.filter((c) => !c.ok).map((c) => c.name)),
		);
		cluster.storageClasses.add("standard");

		cluster.namespaces.delete("omp-clones");
		const noNs = await preflightKubernetesProfile(PROFILE as ProviderProfile, {
			exec: fakeExec,
			env,
		});
		check(
			"Q6 preflight namespace missing",
			noNs.ok === false && noNs.checks.some((c) => c.name === "kube-namespace" && !c.ok),
			JSON.stringify(noNs.checks.filter((c) => !c.ok).map((c) => c.name)),
		);
		cluster.namespaces.add("omp-clones");
	}

	// Case R: pod manifests render correctly (no Service, callback env carried, secretKeyRef).
	{
		const pod = buildPodManifest(
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
				profile: PROFILE as ProviderProfile,
				stateDir,
				source: { remote: "https://example.com/repo.git" },
				revision: "0123456789012345678901234567890123456789",
				branch: "main",
			},
			"tok-1",
			{ OMP_SESSION_CALLBACK_URL: "https://fleet.example/cb" },
		);
		check("R1 pod kind", pod.kind === "Pod", pod.kind as string);
		check(
			"R2 no service field",
			(pod as { spec: Record<string, unknown> }).spec.service === undefined,
			"service present?",
		);
		const spec = pod.spec as {
			restartPolicy: string;
			automountServiceAccountToken: boolean;
			volumes: unknown[];
			containers: Array<{
				env: Array<{ name: string; value?: string; valueFrom?: Record<string, unknown> }>;
				securityContext: Record<string, unknown>;
				resources: Record<string, unknown>;
			}>;
		};
		check("R3 restartPolicy Never", spec.restartPolicy === "Never", spec.restartPolicy);
		check(
			"R4 no SA token automount",
			spec.automountServiceAccountToken === false,
			String(spec.automountServiceAccountToken),
		);
		const envNames = spec.containers[0].env.map((e) => e.name);
		check(
			"R5 workspace env",
			envNames.includes("OMP_WORKSPACE_ID") &&
				envNames.includes("OMP_WORKSPACE_DIR") &&
				envNames.includes("PI_CODING_AGENT_DIR"),
			envNames.join(","),
		);
		check(
			"R6 prep env injected",
			envNames.includes("OMP_PREP_SOURCE_REMOTE") && envNames.includes("OMP_PREP_REVISION"),
			envNames.join(","),
		);
		check(
			"R7 callback env injected",
			envNames.includes("OMP_SESSION_CALLBACK_URL"),
			envNames.join(","),
		);
		check(
			"R8 secretKeyRef, not value",
			spec.containers[0].env.find((e) => e.name === "OMP_MODEL_KEY")?.valueFrom?.secretKeyRef !==
				undefined,
			JSON.stringify(spec.containers[0].env.find((e) => e.name === "OMP_MODEL_KEY")),
		);
		check(
			"R9 hardened securityContext",
			spec.containers[0].securityContext.allowPrivilegeEscalation === false &&
				JSON.stringify(spec.containers[0].securityContext.capabilities) ===
					JSON.stringify({ drop: ["ALL"] }),
			JSON.stringify(spec.containers[0].securityContext),
		);
		check(
			"R10 volumes PVC + tmp",
			JSON.stringify(spec.volumes.map((v) => (v as { name: string }).name)) ===
				JSON.stringify(["workspace", "tmp"]),
			JSON.stringify(spec.volumes),
		);
	}

	console.log(failures === 0 ? "\nALL SMOKE CASES PASSED" : `\n${failures} FAILURES`);
	rmSync(stateDir, { recursive: true, force: true });
	if (failures > 0) process.exit(1);
}

main().catch((cause) => {
	console.error("smoke crashed:", cause);
	process.exit(1);
});
