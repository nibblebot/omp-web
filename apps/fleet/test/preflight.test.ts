/**
 * Targeted tests for the fleet-side production-profile preflight: the
 * host-generic rows (executable, durable dirs, secretRefs, aggregation) and
 * the merge of the rows a provider reports through its `preflight` op. The
 * provider-owned rows themselves are tested next to their providers
 * (bwrap-preflight.test.ts, kube-smoke.test.ts case Q); the providers here
 * are throwaway shell scripts, so the suite never needs bwrap or a cluster.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BwrapProfile,
	HostProfile,
	KubernetesProfile,
	PreflightCheck,
} from "#lib/runtime/provider-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { runProfilePreflight } from "../preflight";

afterAll(cleanupTempDirs);

function profile(overrides: Partial<BwrapProfile> = {}): BwrapProfile {
	return {
		id: "test",
		provider: "bwrap",
		executable: "/nonexistent-provider",
		tools: [],
		...overrides,
	};
}

function kubeProfile(overrides: Partial<KubernetesProfile> = {}): KubernetesProfile {
	return {
		id: "test",
		provider: "kubernetes",
		executable: "/nonexistent-provider",
		...overrides,
	};
}

interface Fixture {
	root: string;
	workspaceRoot: string;
	logsRoot: string;
	/** An executable that is not a provider (exits 0 with no output). */
	tool: string;
}

/** A fixture dir tree: executable script + workspace/logs roots. */
function fixtureDirs(): Fixture {
	const root = tempDir("preflight-fixture-");
	const workspaceRoot = join(root, "workspaces");
	const logsRoot = join(root, "logs");
	const tool = join(root, "tool");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(logsRoot, { recursive: true });
	writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return { root, workspaceRoot, logsRoot, tool };
}

function ctxFor(fixture: Fixture) {
	return {
		workspaceRoot: fixture.workspaceRoot,
		logsRoot: fixture.logsRoot,
		env: { HOME: fixture.root },
	};
}

/** A provider executable whose stdout is `stdout` for any op; the request lands in `<exe>.stdin`. */
function provider(f: Fixture, stdout: string, exitCode = 0): string {
	const exe = join(f.root, `provider-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(exe, `#!/bin/sh\ncat > "$0.stdin"\nprintf '%s\\n' '${stdout}'\nexit ${exitCode}\n`);
	chmodSync(exe, 0o755);
	return exe;
}

const names = (checks: PreflightCheck[]) => checks.map((c) => c.name);

describe("profile-executable check", () => {
	test("missing executable fails with remediation naming the profile", async () => {
		const result = await runProfilePreflight(profile(), ctxFor(fixtureDirs()));
		const exe = result.checks.find((c) => c.name === "profile-executable");
		expect(exe).toBeDefined();
		expect(exe!.ok).toBe(false);
		expect(exe!.remediation).toContain('providerProfiles."test".executable');
		expect(result.ok).toBe(false);
	});

	test("a missing executable skips the provider rows (no invocation to fail)", async () => {
		const result = await runProfilePreflight(profile(), ctxFor(fixtureDirs()));
		expect(names(result.checks)).not.toContain("provider-preflight");
	});

	test("non-executable file fails and executable file passes", async () => {
		const f = fixtureDirs();
		const script = join(f.root, "provider.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o644);

		const noExec = await runProfilePreflight(profile({ executable: script }), ctxFor(f));
		const exeNoExec = noExec.checks.find((c) => c.name === "profile-executable");
		expect(exeNoExec!.ok).toBe(false);
		expect(exeNoExec!.remediation).toContain("chmod +x");

		chmodSync(script, 0o755);
		const withExec = await runProfilePreflight(profile({ executable: script }), ctxFor(f));
		const exeWithExec = withExec.checks.find((c) => c.name === "profile-executable");
		expect(exeWithExec!.ok).toBe(true);
		expect(exeWithExec!.detail).toBe(script);
	});
});

describe("durable state dirs", () => {
	test("existing writable roots pass; missing roots with a writable parent pass", async () => {
		const f = fixtureDirs();
		const missingWs = join(f.root, "not-yet-created-workspaces");
		const result = await runProfilePreflight(profile({ executable: f.tool }), {
			...ctxFor(f),
			workspaceRoot: missingWs,
		});
		const ws = result.checks.find((c) => c.name === "durable-workspace-root");
		expect(ws!.ok).toBe(true);
		expect(ws!.detail).toContain("created on demand");
		const logs = result.checks.find((c) => c.name === "durable-logs-root");
		expect(logs!.ok).toBe(true);
	});

	test("a non-directory at the root fails with remediation", async () => {
		const f = fixtureDirs();
		const fileAsDir = join(f.root, "blocked");
		writeFileSync(fileAsDir, "x");
		const result = await runProfilePreflight(profile({ executable: f.tool }), {
			...ctxFor(f),
			workspaceRoot: fileAsDir,
		});
		const ws = result.checks.find((c) => c.name === "durable-workspace-root");
		expect(ws!.ok).toBe(false);
		expect(ws!.remediation).toContain("mkdir -p");
	});
});

describe("secretRefs rows", () => {
	test("env resolution: present passes, missing fails actionably, bad scheme fails", async () => {
		const f = fixtureDirs();
		const ctx = ctxFor(f);
		const result = await runProfilePreflight(
			profile({ executable: f.tool, secretRefs: { model: "env:MODEL_CRED" } }),
			{ ...ctx, env: { HOME: f.root, MODEL_CRED: "sekrit" } },
		);
		expect(result.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(true);
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
		expect(badScheme.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(false);
	});

	test("k8s secretRefs on a kubernetes profile stay green (API-side resolution)", async () => {
		const f = fixtureDirs();
		const result = await runProfilePreflight(
			kubeProfile({ executable: f.tool, secretRefs: { model: "k8s-secret/model-auth" } }),
			ctxFor(f),
		);
		expect(result.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(true);
	});
});

describe("provider rows merged from the preflight op", () => {
	test("the provider's rows join the host-generic rows; no kind-specific placeholder rows", async () => {
		const f = fixtureDirs();
		const rows: PreflightCheck[] = [
			{ name: "kube-api", ok: true, detail: "reachable" },
			{ name: "kube-namespace", ok: true, detail: "exists" },
		];
		const exe = provider(f, JSON.stringify({ ok: true, checks: rows }));
		const result = await runProfilePreflight(kubeProfile({ executable: exe }), ctxFor(f));
		const all = names(result.checks);
		expect(all).toEqual(
			expect.arrayContaining(["profile-executable", "kube-api", "kube-namespace"]),
		);
		for (const placeholder of ["k8s-context", "k8s-namespace", "k8s-image", "k8s-fields"]) {
			expect(all).not.toContain(placeholder);
		}
		expect(result.ok).toBe(true);
		expect(result.provider).toBe("kubernetes");
	});

	test("the provider receives a preflight request carrying the fleet workspace root", async () => {
		const f = fixtureDirs();
		const exe = provider(
			f,
			JSON.stringify({ ok: true, checks: [{ name: "x", ok: true, detail: "d" }] }),
		);
		await runProfilePreflight(profile({ executable: exe }), ctxFor(f));
		const request = JSON.parse(readFileSync(`${exe}.stdin`, "utf8")) as Record<string, unknown>;
		expect(request).toMatchObject({
			op: "preflight",
			workspaceDir: f.workspaceRoot,
			profile: { id: "test", provider: "bwrap" },
		});
	});

	test("a failing provider row fails the whole report and keeps its remediation", async () => {
		const f = fixtureDirs();
		const exe = provider(
			f,
			JSON.stringify({
				ok: true,
				checks: [
					{ name: "kube-api", ok: false, detail: "unreachable", remediation: "fix the kubeconfig" },
				],
			}),
		);
		const result = await runProfilePreflight(kubeProfile({ executable: exe }), ctxFor(f));
		const row = result.checks.find((c) => c.name === "kube-api");
		expect(row).toEqual({
			name: "kube-api",
			ok: false,
			detail: "unreachable",
			remediation: "fix the kubeconfig",
		});
		expect(result.ok).toBe(false);
	});

	test("a provider that rejects the op (older executable) is a failing row, never success", async () => {
		const f = fixtureDirs();
		const exe = provider(
			f,
			JSON.stringify({
				ok: false,
				error: { code: "invalid_request", message: "op must be one of x", retryable: false },
			}),
		);
		const result = await runProfilePreflight(profile({ executable: exe }), ctxFor(f));
		const row = result.checks.find((c) => c.name === "provider-preflight");
		expect(row!.ok).toBe(false);
		expect(row!.detail).toContain("invalid_request");
		expect(row!.remediation).toContain("preflight op");
		expect(result.ok).toBe(false);
	});

	test("a provider that exits non-zero or prints garbage is a failing row", async () => {
		const f = fixtureDirs();
		for (const exe of [provider(f, "", 1), provider(f, "not json")]) {
			const result = await runProfilePreflight(profile({ executable: exe }), ctxFor(f));
			const row = result.checks.find((c) => c.name === "provider-preflight");
			expect(row!.ok).toBe(false);
			expect(typeof row!.remediation).toBe("string");
			expect(result.ok).toBe(false);
		}
	});

	test("a provider that answers with no checks cannot make the profile ready", async () => {
		const f = fixtureDirs();
		const exe = provider(f, JSON.stringify({ ok: true, checks: [] }));
		const result = await runProfilePreflight(profile({ executable: exe }), ctxFor(f));
		expect(result.checks.find((c) => c.name === "provider-preflight")!.ok).toBe(false);
		expect(result.ok).toBe(false);
	});

	test("a provider that hangs is bounded by providerTimeoutMs", async () => {
		const f = fixtureDirs();
		const exe = join(f.root, "hang.sh");
		writeFileSync(exe, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		const result = await runProfilePreflight(profile({ executable: exe }), {
			...ctxFor(f),
			providerTimeoutMs: 300,
		});
		const row = result.checks.find((c) => c.name === "provider-preflight");
		expect(row!.ok).toBe(false);
		expect(row!.detail).toContain("300ms");
	});
});

describe("aggregation", () => {
	test("every failing check carries a remediation; overall ok is the AND", async () => {
		const f = fixtureDirs();
		const result = await runProfilePreflight(profile(), ctxFor(f)); // missing executable
		const failed = result.checks.filter((c) => !c.ok);
		expect(failed.length).toBeGreaterThan(0);
		for (const check of failed) {
			expect(typeof check.remediation).toBe("string");
		}
		expect(result.ok).toBe(false);
	});
});

describe("host profile (in-process, no provider executable)", () => {
	const host = (overrides: Partial<HostProfile> = {}): HostProfile => ({
		id: "test",
		provider: "host",
		...overrides,
	});

	test("reports the host-generic rows, the runtime rows and an explicit no-sandbox row, with no provider invocation", async () => {
		const f = fixtureDirs();
		const entry = join(f.root, "entry.js");
		writeFileSync(entry, "");
		const result = await runProfilePreflight(host(), {
			...ctxFor(f),
			env: { HOME: f.root, OMP_RUNTIME_ENTRY: entry },
		});
		expect(names(result.checks)).toEqual([
			"profile-executable",
			"callback-url",
			"durable-workspace-root",
			"durable-logs-root",
			"profile-secrets",
			"runtime-entry",
			"runtime-bin",
			"host-isolation",
		]);
		const row = (name: string) => result.checks.find((c) => c.name === name)!;
		expect(row("profile-executable")).toMatchObject({ ok: true });
		expect(row("profile-executable").detail).toContain("in-process");
		expect(row("runtime-entry")).toMatchObject({ ok: true, detail: entry });
		expect(row("host-isolation")).toMatchObject({ ok: true });
		expect(row("host-isolation").detail).toContain("no sandbox");
		expect(names(result.checks)).not.toContain("provider-preflight");
		expect(result.ok).toBe(true);
		expect(result.provider).toBe("host");
	});

	test("a missing runtime entry fails with remediation", async () => {
		const f = fixtureDirs();
		const result = await runProfilePreflight(host(), {
			...ctxFor(f),
			env: { HOME: f.root, OMP_RUNTIME_ENTRY: join(f.root, "absent.js") },
		});
		const entry = result.checks.find((c) => c.name === "runtime-entry")!;
		expect(entry.ok).toBe(false);
		expect(entry.remediation).toContain("OMP_RUNTIME_ENTRY");
		expect(result.ok).toBe(false);
	});

	test("secretRefs resolve from the fleet env, as for bwrap", async () => {
		const f = fixtureDirs();
		const withRef = host({ secretRefs: { model: "env:MODEL_CRED" } });
		const found = await runProfilePreflight(withRef, {
			...ctxFor(f),
			env: { HOME: f.root, MODEL_CRED: "x" },
		});
		expect(found.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(true);
		const missing = await runProfilePreflight(withRef, ctxFor(f));
		expect(missing.checks.find((c) => c.name === "profile-secrets")!.ok).toBe(false);
	});
});
