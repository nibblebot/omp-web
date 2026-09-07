/**
 * Targeted tests for the production-profile preflight (P5.6). Deterministic
 * host-generic checks (executable, durable dirs, profile tools, denied
 * binds, k8s requirement rows, secretRefs, aggregation) use synthetic
 * fixtures; the live host checks (bwrap binary/userns, runtime entry/bin,
 * callback reachability) are exercised in the smokes instead of this file,
 * so the suite never depends on the host having bwrap/userns.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderProfile } from "../shared/provider-protocol";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { runProfilePreflight } from "./preflight";

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
function fixtureDirs() {
	const root = tempDir("preflight-fixture-");
	const workspaceRoot = join(root, "workspaces");
	const logsRoot = join(root, "logs");
	const tool = join(root, "tool");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(logsRoot, { recursive: true });
	writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return { root, workspaceRoot, logsRoot, tool };
}

function ctxFor(fixture: ReturnType<typeof fixtureDirs>, home: string) {
	return {
		workspaceRoot: fixture.workspaceRoot,
		logsRoot: fixture.logsRoot,
		env: { HOME: home },
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
	test("kubernetes profile: missing context/namespace/image fail actionably; complete set passes", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const ctx = ctxFor(f, home);
		// No context anywhere -> k8s-context fails; namespace/image missing too.
		const incomplete = await runProfilePreflight(
			profile({ provider: "kubernetes", executable: f.tool, namespace: "ns1", image: "img:1" }),
			ctx,
		);
		const contextRow = incomplete.checks.find((c) => c.name === "k8s-context");
		expect(contextRow!.ok).toBe(false);
		expect(contextRow!.remediation).toContain("context");
		expect(incomplete.ok).toBe(false);
		// Env fallback OMP_KUBE_CONTEXT satisfies context.
		const withEnv = await runProfilePreflight(
			profile({ provider: "kubernetes", executable: f.tool, namespace: "ns1", image: "img:1" }),
			{ ...ctx, env: { HOME: home, OMP_KUBE_CONTEXT: "my-ctx" } },
		);
		expect(withEnv.checks.find((c) => c.name === "k8s-context")!.ok).toBe(true);
		expect(withEnv.checks.find((c) => c.name === "k8s-namespace")!.ok).toBe(true);
		expect(withEnv.checks.find((c) => c.name === "k8s-image")!.ok).toBe(true);
		// Complete profile passes all k8s rows.
		const full = await runProfilePreflight(
			profile({
				provider: "kubernetes",
				executable: f.tool,
				context: "my-ctx",
				namespace: "ns1",
				image: "img:1",
				storage: { class: "fast", size: "10Gi" },
			}),
			ctx,
		);
		for (const name of ["k8s-context", "k8s-namespace", "k8s-image", "k8s-storage"]) {
			expect(full.checks.find((c) => c.name === name)!.ok).toBe(true);
		}
	});

	test("a kubernetes profile still runs the executable + secret checks", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(
			profile({ provider: "kubernetes", executable: f.tool }),
			ctxFor(f, home),
		);
		const names = result.checks.map((c) => c.name);
		expect(names).not.toContain("bwrap-binary");
		expect(names).not.toContain("bwrap-userns");
		expect(names).not.toContain("runtime-entry");
		expect(names).not.toContain("runtime-bin");
		expect(names).toContain("profile-executable");
		expect(names).toContain("k8s-context");
		expect(names).toContain("k8s-namespace");
		expect(names).toContain("k8s-image");
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
		const result = await runProfilePreflight(
			profile({
				provider: "kubernetes",
				executable: f.tool,
				context: "c",
				namespace: "ns",
				image: "img",
				secretRefs: { model: "k8s-secret/model-auth" },
			}),
			ctxFor(f, home),
		);
		expect(result.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(true);
	});

	test("stray k8s fields on a bwrap profile stay green with detail", async () => {
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

describe("aggregation", () => {
	test("a kubernetes profile never runs host bwrap/runtime checks", async () => {
		const f = fixtureDirs();
		const home = syntheticHome();
		const result = await runProfilePreflight(
			profile({ provider: "kubernetes", executable: f.tool }),
			ctxFor(f, home),
		);
		const names = result.checks.map((c) => c.name);
		expect(names).not.toContain("bwrap-binary");
		expect(names).not.toContain("bwrap-userns");
		expect(names).not.toContain("runtime-entry");
		expect(names).not.toContain("runtime-bin");
		expect(names).toContain("k8s-context");
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
