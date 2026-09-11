/**
 * Targeted tests for the production-profile preflight (P5.6). Deterministic
 * host-generic checks (executable, durable dirs, profile tools, denied
 * binds, k8s requirement rows, secretRefs, aggregation) use synthetic
 * fixtures; the live host checks (bwrap binary/userns, runtime entry/bin)
 * are exercised in the smokes instead of this file, so the suite never
 * depends on the host having bwrap/userns. The callback row's reachability
 * case dials a TCP listener bound on this host's own non-loopback address
 * and skips on a loopback-only host.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ProviderProfile } from "../shared/provider-protocol";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { runProfilePreflight } from "./preflight";
import type { KubeExec, KubeExecResult } from "./providers/kubernetes-provider";

afterAll(cleanupTempDirs);

/** Synthetic operator home the deny roots derive from (tmpdir is safe). */
function syntheticHome(): string {
	return tempDir("preflight-home-");
}

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
	return {
		id: "test",
		provider: "bwrap",
		executable: "/nonexistent-provider",
		tools: [],
		...overrides,
	};
}

/** A fixture dir tree: executable script + workspace/logs roots. */
interface FixtureDirs {
	root: string;
	workspaceRoot: string;
	logsRoot: string;
	tool: string;
}

function fixtureDirs(): FixtureDirs {
	const root = tempDir("preflight-fixture-");
	const workspaceRoot = join(root, "workspaces");
	const logsRoot = join(root, "logs");
	const tool = join(root, "tool");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(logsRoot, { recursive: true });
	writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return { root, workspaceRoot, logsRoot, tool };
}

function ctxFor(fixture: FixtureDirs, home: string) {
	return {
		workspaceRoot: fixture.workspaceRoot,
		logsRoot: fixture.logsRoot,
		env: { HOME: home },
	};
}

/**
 * Inject a fake kubectl for the provider requirement preflight. The default
 * answers model a healthy cluster/context/namespace/RBAC/secret; `respond`
 * overrides a single invocation (e.g. a missing StorageClass). Every argv is
 * recorded so a test can prove the executor was threaded through.
 */
function kubeStub(respond?: (argv: readonly string[]) => KubeExecResult | undefined): {
	exec: KubeExec;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: KubeExec = async (argv) => {
		calls.push([...argv]);
		const custom = respond?.(argv);
		if (custom !== undefined) return custom;
		if (argv.includes("--client")) {
			return {
				code: 0,
				stdout: JSON.stringify({ clientVersion: { gitVersion: "v1.30.1" } }),
				stderr: "",
			};
		}
		if (argv.includes("version")) {
			return { code: 0, stdout: "Client Version: v1.30.1\nServer Version: v1.30.1\n", stderr: "" };
		}
		if (argv.includes("auth") && argv.includes("can-i"))
			return { code: 0, stdout: "yes\n", stderr: "" };
		const getIndex = argv.indexOf("get");
		const resource = getIndex >= 0 ? argv[getIndex + 1] : undefined;
		if (resource === "namespace") {
			return { code: 0, stdout: `namespace/${argv[getIndex + 2]}\n`, stderr: "" };
		}
		if (resource === "storageclass") return { code: 0, stdout: "", stderr: "" };
		if (resource === "secret") {
			return { code: 0, stdout: JSON.stringify({ data: { password: "c2Vrcml0" } }), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

/** A kubernetes profile whose generic (non-cluster) rows all pass. */
function kubernetesProfile(f: FixtureDirs, overrides: Partial<ProviderProfile> = {}) {
	return profile({
		provider: "kubernetes",
		executable: f.tool,
		context: "my-ctx",
		namespace: "ns1",
		image: "img:1",
		storage: { class: "fast", size: "10Gi" },
		...overrides,
	});
}

/**
 * A non-loopback IPv4 of this host, or null on a loopback-only host. A
 * kubernetes callback URL may not be loopback (a Pod cannot dial it), so the
 * reachable-callback case needs a real interface and skips without one.
 */
function hostAddress(): string | null {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

const HOST_ADDRESS = hostAddress();

/**
 * A TCP listener this host can dial by its own non-loopback address. The
 * callback check only needs a completed TCP connect (it never writes a
 * byte), so a bare listener is a truthful stand-in for the gateway.
 */
async function listeningCallback(
	address: string,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((socket) => socket.end());
	await new Promise<void>((ready) => server.listen(0, "0.0.0.0", ready));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `https://${address}:${port}`,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
			}),
	};
}

describe("profile-executable check", () => {
	test("missing executable fails with remediation naming the profile", async () => {
		const result = await runProfilePreflight(profile(), ctxFor(fixtureDirs(), syntheticHome()));
		const exe = result.checks.find((c) => c.name === "profile-executable");
		expect(exe).toBeDefined();
		expect(exe!.ok).toBe(false);
		expect(exe!.remediation).toContain('providerProfiles."test".executable');
		expect(result.ok).toBe(false);
	});

	test("non-executable file fails and executable file passes", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const script = join(f.root, "provider.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o644);

		const noExec = await runProfilePreflight(profile({ executable: script }), ctxFor(f, home));
		const exeNoExec = noExec.checks.find((c) => c.name === "profile-executable");
		expect(exeNoExec!.ok).toBe(false);
		expect(exeNoExec!.remediation).toContain("chmod +x");

		chmodSync(script, 0o755);
		const withExec = await runProfilePreflight(profile({ executable: script }), ctxFor(f, home));
		const exeWithExec = withExec.checks.find((c) => c.name === "profile-executable");
		expect(exeWithExec!.ok).toBe(true);
		expect(exeWithExec!.detail).toBe(script);
	});
});

describe("durable state dirs", () => {
	test("existing writable roots pass; missing roots with a writable parent pass", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const missingWs = join(f.root, "not-yet-created-workspaces");
		const result = await runProfilePreflight(profile({ executable: f.tool }), {
			workspaceRoot: missingWs,
			logsRoot: f.logsRoot,
			env: { HOME: home },
		});
		const ws = result.checks.find((c) => c.name === "durable-workspace-root");
		expect(ws!.ok).toBe(true);
		expect(ws!.detail).toContain("created on demand");
		const logs = result.checks.find((c) => c.name === "durable-logs-root");
		expect(logs!.ok).toBe(true);
	});

	test("a non-directory at the root fails with remediation", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const fileAsDir = join(f.root, "blocked");
		writeFileSync(fileAsDir, "x");
		const result = await runProfilePreflight(profile({ executable: f.tool }), {
			workspaceRoot: fileAsDir,
			logsRoot: f.logsRoot,
			env: { HOME: home },
		});
		const ws = result.checks.find((c) => c.name === "durable-workspace-root");
		expect(ws!.ok).toBe(false);
		expect(ws!.remediation).toContain("mkdir -p");
	});
});

describe("profile tools + denied binds", () => {
	test("a non-absolute tool fails with remediation naming the profile", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(
			profile({ executable: f.tool, tools: ["relative-tool"] }),
			ctxFor(f, home),
		);
		const tools = result.checks.find((c) => c.name === "profile-tools");
		expect(tools!.ok).toBe(false);
		expect(tools!.remediation).toContain('providerProfiles."test".tools');
	});

	test("a tool inside the operator home is a denied bind and fails here", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const sshFile = join(home, ".ssh", "id_ed25519");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(sshFile, "secret");
		const result = await runProfilePreflight(
			profile({ executable: f.tool, tools: [sshFile] }),
			ctxFor(f, home),
		);
		const denied = result.checks.find((c) => c.name === "denied-binds");
		expect(denied!.ok).toBe(false);
		expect(denied!.detail).toContain(".ssh");
		expect(denied!.remediation).toContain("operator home/ssh state");
		expect(result.ok).toBe(false);
	});

	test("an allowed absolute tool passes both tool checks", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(
			profile({ executable: f.tool, tools: [f.tool] }),
			ctxFor(f, home),
		);
		expect(result.checks.find((c) => c.name === "profile-tools")!.ok).toBe(true);
		expect(result.checks.find((c) => c.name === "denied-binds")!.ok).toBe(true);
	});
});

describe("k8s rows are real requirement checks on kubernetes profiles", () => {
	test("a complete kubernetes profile passes the provider requirement rows", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(
			kubernetesProfile(f, { secretRefs: { OMP_TEST_SECRET: "model-auth/password" } }),
			{ ...ctxFor(f, home), kubeExec: exec },
		);
		const expected = [
			"kubectl-client",
			"kube-context",
			"kube-api",
			"kube-namespace",
			"kube-rbac-get-pods",
			"kube-rbac-create-pods",
			"kube-rbac-delete-pods",
			"kube-rbac-get-persistentvolumeclaims",
			"kube-rbac-create-persistentvolumeclaims",
			"kube-rbac-delete-persistentvolumeclaims",
			"kube-storageclass",
			"kube-secret-OMP_TEST_SECRET",
			"kube-image",
		];
		for (const name of expected) {
			const row = result.checks.find((c) => c.name === name);
			expect(row).toBeDefined();
			expect(row!.ok).toBe(true);
		}
		// Readiness additionally requires a Pod-reachable callback gateway
		// (OMP_FLEET_CALLBACK_URL); with none set that row is the only failure.
		expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["callback-url"]);
		expect(result.ok).toBe(false);
	});

	test("the removed k8s-context/namespace/image/storage summary rows are gone", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(kubernetesProfile(f), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const names = result.checks.map((c) => c.name);
		for (const removed of [
			"k8s-context",
			"k8s-namespace",
			"k8s-image",
			"k8s-storage",
			"k8s-fields",
		]) {
			expect(names).not.toContain(removed);
		}
	});

	test("missing context/namespace/image fail actionably through the provider rows", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(
			profile({ provider: "kubernetes", executable: f.tool }),
			{
				...ctxFor(f, home),
				kubeExec: exec,
			},
		);
		const context = result.checks.find((c) => c.name === "kube-context");
		expect(context).toBeDefined();
		expect(context!.ok).toBe(false);
		expect(context!.remediation!.length).toBeGreaterThan(0);
		const namespace = result.checks.find((c) => c.name === "kube-namespace");
		expect(namespace).toBeDefined();
		expect(namespace!.ok).toBe(false);
		const image = result.checks.find((c) => c.name === "kube-image");
		expect(image).toBeDefined();
		expect(image!.ok).toBe(false);
		expect(image!.remediation!.length).toBeGreaterThan(0);
		expect(result.ok).toBe(false);
	});

	test("an env-only OMP_KUBE_CONTEXT satisfies kube-context", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(
			profile({
				provider: "kubernetes",
				executable: f.tool,
				namespace: "ns1",
				image: "img:1",
				storage: { class: "fast", size: "10Gi" },
			}),
			{ ...ctxFor(f, home), env: { HOME: home, OMP_KUBE_CONTEXT: "my-ctx" }, kubeExec: exec },
		);
		expect(result.checks.find((c) => c.name === "kube-context")!.ok).toBe(true);
		expect(result.checks.find((c) => c.name === "kube-namespace")!.ok).toBe(true);
		expect(result.checks.find((c) => c.name === "kube-image")!.ok).toBe(true);
	});

	test("an omitted storage.class requires exactly one default StorageClass", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const defaultSc: KubeExecResult = {
			code: 0,
			stdout: JSON.stringify({
				items: [
					{
						metadata: {
							name: "standard",
							annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
						},
					},
				],
			}),
			stderr: "",
		};
		const { exec } = kubeStub((argv) =>
			argv.includes("get") && argv[argv.indexOf("get") + 1] === "storageclass"
				? defaultSc
				: undefined,
		);
		const result = await runProfilePreflight(kubernetesProfile(f, { storage: undefined }), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const names = result.checks.map((c) => c.name);
		expect(names).toContain("kube-default-storageclass");
		expect(names).not.toContain("kube-storageclass");
		expect(result.checks.find((c) => c.name === "kube-default-storageclass")!.ok).toBe(true);
	});

	test("a throwing kubeExec becomes a failed kube-preflight row with remediation", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const exec: KubeExec = async () => {
			throw new Error("kubectl is not installed");
		};
		const result = await runProfilePreflight(kubernetesProfile(f), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const preflight = result.checks.find((c) => c.name === "kube-preflight");
		expect(preflight).toBeDefined();
		expect(preflight!.ok).toBe(false);
		expect(preflight!.detail).toContain("kubectl is not installed");
		expect(preflight!.remediation!.length).toBeGreaterThan(0);
		expect(result.ok).toBe(false);
	});

	test("PreflightContext.kubeExec is threaded through to the provider preflight", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec, calls } = kubeStub();
		await runProfilePreflight(kubernetesProfile(f, { context: "threaded-ctx" }), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((argv) => argv[0] === "kubectl")).toBe(true);
		const auth = calls.find((argv) => argv.includes("auth") && argv.includes("can-i"));
		expect(auth).toBeDefined();
		expect(auth).toContain("--context");
		expect(auth).toContain("threaded-ctx");
	});

	test("a kubernetes profile still runs the executable + durable checks", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(kubernetesProfile(f), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const names = result.checks.map((c) => c.name);
		expect(names).not.toContain("bwrap-binary");
		expect(names).not.toContain("bwrap-userns");
		expect(names).not.toContain("runtime-entry");
		expect(names).not.toContain("runtime-bin");
		expect(names).toContain("profile-executable");
		expect(names).toContain("kubectl-client");
		expect(names).not.toContain("k8s-not-yet-supported");
		expect(result.provider).toBe("kubernetes");
	});

	test("secretRefs env resolution: present passes, missing fails actionably", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const ctx = ctxFor(f, home);
		const result = await runProfilePreflight(
			profile({
				executable: f.tool,
				secretRefs: { model: "env:MODEL_CRED" },
			}),
			{ ...ctx, env: { HOME: home, MODEL_CRED: "sekrit" } },
		);
		const secrets = result.checks.find((c) => c.name === "profile-secrets");
		expect(secrets!.ok).toBe(true);
		const missing = await runProfilePreflight(
			profile({ executable: f.tool, secretRefs: { model: "env:MISSING_VAR" } }),
			ctx,
		);
		const secretsMissing = missing.checks.find((c) => c.name === "profile-secrets");
		expect(secretsMissing!.ok).toBe(false);
		expect(secretsMissing!.remediation).toContain("MISSING_VAR");
		const badScheme = await runProfilePreflight(
			profile({ executable: f.tool, secretRefs: { model: "secret:models/key" } }),
			ctx,
		);
		const secretsBad = badScheme.checks.find((c) => c.name === "profile-secrets");
		expect(secretsBad!.ok).toBe(false);
	});

	test("k8s secretRefs on a kubernetes profile stay green (API-side resolution)", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(
			profile({
				provider: "kubernetes",
				executable: f.tool,
				context: "c",
				namespace: "ns",
				image: "img",
				storage: { class: "fast", size: "10Gi" },
				secretRefs: { OMP_TEST_SECRET: "model-auth/password" },
			}),
			{ ...ctxFor(f, home), kubeExec: exec },
		);
		expect(result.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(true);
		expect(result.checks.find((c) => c.name === "kube-secret-OMP_TEST_SECRET")!.ok).toBe(true);
	});

	test("stray k8s fields on a bwrap profile stay green with detail and run no kube rows", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(
			profile({
				executable: f.tool,
				storage: { class: "fast", size: "10Gi" },
				image: "example.invalid/img:tag",
				namespace: "ns1",
				context: "c1",
			}),
			ctxFor(f, home),
		);
		const k8s = result.checks.find((c) => c.name === "k8s-fields");
		expect(k8s).toBeDefined();
		expect(k8s!.ok).toBe(true);
		expect(k8s!.detail).toContain("not yet supported");
		expect(result.checks.map((c) => c.name).some((name) => name.startsWith("kube-"))).toBe(false);
	});

	test("bwrap profile with no k8s fields reports none", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(profile({ executable: f.tool }), ctxFor(f, home));
		const k8s = result.checks.find((c) => c.name === "k8s-fields");
		expect(k8s!.ok).toBe(true);
		expect(k8s!.detail).toBe("no k8s-only fields configured");
	});
});

describe("callback gateway", () => {
	test("a kubernetes profile without OMP_FLEET_CALLBACK_URL fails actionably", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(kubernetesProfile(f), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const row = result.checks.find((c) => c.name === "callback-url");
		expect(row).toBeDefined();
		expect(row!.ok).toBe(false);
		expect(row!.remediation).toContain("OMP_FLEET_CALLBACK_URL");
		expect(row!.remediation).toContain("Pod-reachable HTTPS origin");
		expect(result.ok).toBe(false);
	});

	test("a bwrap profile without a callback URL stays optional and passing", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(profile({ executable: f.tool }), ctxFor(f, home));
		const row = result.checks.find((c) => c.name === "callback-url");
		expect(row).toBeDefined();
		expect(row!.ok).toBe(true);
		expect(row!.detail).toContain("not configured");
		expect(row!.remediation).toBeUndefined();
	});

	test.skipIf(HOST_ADDRESS === null)(
		"a kubernetes profile with a Pod-reachable HTTPS origin passes",
		async () => {
			const f = fixtureDirs();
			const home = syntheticHome();
			const { exec } = kubeStub();
			const listener = await listeningCallback(HOST_ADDRESS!);
			try {
				const result = await runProfilePreflight(kubernetesProfile(f), {
					...ctxFor(f, home),
					callbackUrl: listener.url,
					kubeExec: exec,
				});
				const row = result.checks.find((c) => c.name === "callback-url");
				expect(row).toBeDefined();
				expect(row!.ok).toBe(true);
				expect(row!.detail).toContain("reachable from the fleet host");
				expect(result.ok).toBe(true);
			} finally {
				await listener.close();
			}
		},
	);
});

describe("aggregation", () => {
	test("a kubernetes profile never runs host bwrap/runtime checks", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const { exec } = kubeStub();
		const result = await runProfilePreflight(kubernetesProfile(f), {
			...ctxFor(f, home),
			kubeExec: exec,
		});
		const names = result.checks.map((c) => c.name);
		expect(names).not.toContain("bwrap-binary");
		expect(names).not.toContain("bwrap-userns");
		expect(names).not.toContain("runtime-entry");
		expect(names).not.toContain("runtime-bin");
		expect(names).toContain("kube-context");
		expect(result.provider).toBe("kubernetes");
	});

	test("every failing check carries a remediation; overall ok is the AND", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(profile(), ctxFor(f, home)); // missing executable
		const failed = result.checks.filter((c) => !c.ok);
		expect(failed.length).toBeGreaterThan(0);
		for (const check of failed) {
			expect(typeof check.remediation).toBe("string");
			expect(check.remediation!.length).toBeGreaterThan(0);
		}
		expect(result.ok).toBe(false);
	});
});
