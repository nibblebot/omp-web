/**
 * Targeted tests for the bwrap provider's preflight rows (the `preflight` op
 * body). Deterministic: profile tools, denied binds, runtime entry/bin and a
 * missing bwrap binary use synthetic fixtures, so the suite never depends on
 * the host having bwrap or user namespaces.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightCheck, BwrapProfile } from "#lib/runtime/provider-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { preflightBwrapProfile } from "../bwrap-preflight";

afterAll(cleanupTempDirs);

function profile(overrides: Partial<BwrapProfile> = {}): BwrapProfile {
	return { id: "test", provider: "bwrap", executable: "/unused", tools: [], ...overrides };
}

/** Synthetic operator home (deny roots derive from HOME) plus a workspace root and a tool file. */
interface Fixture {
	root: string;
	home: string;
	workspaceRoot: string;
	tool: string;
}

function fixture(): Fixture {
	const root = tempDir("bwrap-preflight-");
	const home = join(root, "home");
	const workspaceRoot = join(root, "workspaces");
	const tool = join(root, "tool");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return { root, home, workspaceRoot, tool };
}

function rows(f: Fixture, p: BwrapProfile, env: Record<string, string | undefined> = {}) {
	return preflightBwrapProfile(p, {
		workspaceRoot: f.workspaceRoot,
		env: { HOME: f.home, OMP_BWRAP_BIN: join(f.root, "no-such-bwrap"), ...env },
	});
}

const named = (checks: PreflightCheck[], name: string) => checks.find((c) => c.name === name);

describe("bwrap-owned rows", () => {
	test("emits exactly the bwrap host rows", async () => {
		const f = fixture();
		const checks = await rows(f, profile());
		expect(checks.map((c) => c.name)).toEqual([
			"bwrap-binary",
			"bwrap-userns",
			"runtime-entry",
			"runtime-bin",
			"profile-tools",
			"denied-binds",
		]);
	});

	test("a missing bwrap binary fails binary and userns rows with remediation", async () => {
		const f = fixture();
		const checks = await rows(f, profile());
		for (const name of ["bwrap-binary", "bwrap-userns"]) {
			const row = named(checks, name)!;
			expect(row.ok, name).toBe(false);
			expect(row.remediation, name).toBeDefined();
		}
		expect(named(checks, "bwrap-binary")!.remediation).toContain("OMP_BWRAP_BIN");
	});

	test("runtime entry and bin: missing fails, present passes", async () => {
		const f = fixture();
		const missing = await rows(f, profile(), {
			OMP_RUNTIME_ENTRY: join(f.root, "no-entry.ts"),
			OMP_RUNTIME_BIN: join(f.root, "no-bun"),
		});
		expect(named(missing, "runtime-entry")!.ok).toBe(false);
		expect(named(missing, "runtime-entry")!.remediation).toContain("OMP_RUNTIME_ENTRY");
		expect(named(missing, "runtime-bin")!.ok).toBe(false);
		expect(named(missing, "runtime-bin")!.remediation).toContain("OMP_RUNTIME_BIN");

		const entry = join(f.root, "entry.ts");
		writeFileSync(entry, "");
		const present = await rows(f, profile(), { OMP_RUNTIME_ENTRY: entry, OMP_RUNTIME_BIN: f.tool });
		expect(named(present, "runtime-entry")!.ok).toBe(true);
		expect(named(present, "runtime-bin")!.ok).toBe(true);
	});
});

describe("profile tools + denied binds", () => {
	test("a non-absolute tool fails with remediation naming the profile", async () => {
		const f = fixture();
		const checks = await rows(f, profile({ tools: ["relative-tool"] }));
		const tools = named(checks, "profile-tools")!;
		expect(tools.ok).toBe(false);
		expect(tools.remediation).toContain('providerProfiles."test".tools');
	});

	test("a missing absolute tool fails", async () => {
		const f = fixture();
		const checks = await rows(f, profile({ tools: [join(f.root, "absent")] }));
		expect(named(checks, "profile-tools")!.ok).toBe(false);
	});

	test("a tool inside the operator home is a denied bind and fails", async () => {
		const f = fixture();
		const sshFile = join(f.home, ".ssh", "id_ed25519");
		mkdirSync(join(f.home, ".ssh"), { recursive: true });
		writeFileSync(sshFile, "secret");
		const denied = named(await rows(f, profile({ tools: [sshFile] })), "denied-binds")!;
		expect(denied.ok).toBe(false);
		expect(denied.detail).toContain(".ssh");
		expect(denied.remediation).toContain("operator home/ssh state");
	});

	test("a workspace root inside the operator home fails the denied-bind row", async () => {
		const f = fixture();
		const checks = await preflightBwrapProfile(profile(), {
			workspaceRoot: join(f.home, ".ssh", "clones"),
			env: { HOME: f.home, OMP_BWRAP_BIN: join(f.root, "no-such-bwrap") },
		});
		const denied = named(checks, "denied-binds")!;
		expect(denied.ok).toBe(false);
		expect(denied.remediation).toContain("workspace root");
	});

	test("an allowed absolute tool passes both tool rows", async () => {
		const f = fixture();
		const checks = await rows(f, profile({ tools: [f.tool] }));
		expect(named(checks, "profile-tools")!.ok).toBe(true);
		expect(named(checks, "denied-binds")!.ok).toBe(true);
	});

	test("every failing row carries a remediation", async () => {
		const f = fixture();
		const checks = await rows(f, profile({ tools: ["relative-tool"] }));
		for (const check of checks.filter((c) => !c.ok)) {
			expect(typeof check.remediation, check.name).toBe("string");
		}
	});
});
