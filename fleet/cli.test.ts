/**
 * Unit tests for pure helpers in fleet/cli.ts (the first-run config offer,
 * its config-file writer, and the local preflight verb's config/profile
 * selection). The serve + sessions behavior lives in server-cli.test.ts.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { main, resolveBaseDirs, shouldOfferSetup, writeConfigFile } from "./cli";

afterAll(cleanupTempDirs);

describe("shouldOfferSetup", () => {
	test("offers only when no config file exists and stdin is a TTY", () => {
		expect(shouldOfferSetup(false, true)).toBe(true);
		expect(shouldOfferSetup(true, true)).toBe(false);
		expect(shouldOfferSetup(false, false)).toBe(false);
		expect(shouldOfferSetup(true, false)).toBe(false);
	});
});

describe("resolveBaseDirs", () => {
	test("defaults compose under the data home", () => {
		const dirs = resolveBaseDirs({ dataHome: "/dh" });
		expect(dirs.dataHome).toBe("/dh");
		expect(dirs.configPath).toBe(join("/dh", "config.json"));
		expect(dirs.workspaceDir).toBe(join("/dh", "workspaces"));
	});

	test("default data home is ~/.omp-web (expanded)", () => {
		const dirs = resolveBaseDirs({});
		expect(dirs.dataHome).toBe(join(homedir(), ".omp-web"));
		expect(dirs.configPath).toBe(join(homedir(), ".omp-web", "config.json"));
		expect(dirs.workspaceDir).toBe(join(homedir(), ".omp-web", "workspaces"));
	});

	test("explicit config-path and workspace-dir win over the data home", () => {
		const dirs = resolveBaseDirs({
			dataHome: "/dh",
			configPath: "~/custom.json",
			workspaceDir: "~/ws",
		});
		expect(dirs.configPath).toBe(join(homedir(), "custom.json"));
		expect(dirs.workspaceDir).toBe(join(homedir(), "ws"));
	});
});

describe("writeConfigFile", () => {
	test("writes workspaceDir only — no roots key, unknown keys stay forward-compatible", () => {
		const dir = tempDir("cli-config");
		const configPath = join(dir, "sub", "config.json");
		const workspaceDir = join(dir, "workspaces");
		writeConfigFile(configPath, workspaceDir);
		expect(existsSync(configPath)).toBe(true);
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		expect(parsed).toEqual({ workspaceDir });
	});
});

describe("preflight command", () => {
	test("refuses an invocation without --profile", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await main(["preflight"])).toBe(1);
			expect(stderr.mock.calls.flat().map(String).join(" ")).toContain("--profile");
		} finally {
			stderr.mockRestore();
		}
	});

	test("selects the profile from OMP_FLEET_CONFIG and runs its report", async () => {
		const dir = tempDir("cli-preflight");
		const workspaceDir = join(dir, "workspaces");
		mkdirSync(workspaceDir, { recursive: true });
		const executable = join(dir, "provider.js");
		writeFileSync(executable, "#!/usr/bin/env bun\n");
		chmodSync(executable, 0o755);
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				workspaceDir,
				providerProfiles: {
					probe: { provider: "bwrap", executable, tools: [] },
				},
			}),
		);
		const savedConfig = process.env.OMP_FLEET_CONFIG;
		process.env.OMP_FLEET_CONFIG = configPath;
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			// The local verb never dials the control plane: it loads the config
			// named by the env var, resolves the profile, and prints the report.
			const code = await main(["preflight", "--profile", "probe"]);
			expect([0, 1]).toContain(code);
			const report = stdout.mock.calls.flat().map(String).join("\n");
			expect(report).toMatch(/^profile probe: (ready|NOT ready)$/m);
			expect(report).toMatch(/^ {2}\[(ok|FAIL)\] /m);
			expect(stderr.mock.calls.flat().map(String).join(" ")).toBe("");

			// An unconfigured id names the profile and the config it looked in.
			stdout.mockClear();
			expect(await main(["preflight", "--profile", "nope"])).toBe(1);
			const message = stderr.mock.calls.flat().map(String).join(" ");
			expect(message).toContain("nope");
			expect(message).toContain(configPath);
			expect(stdout.mock.calls.flat().map(String).join("")).toBe("");
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
			if (savedConfig === undefined) delete process.env.OMP_FLEET_CONFIG;
			else process.env.OMP_FLEET_CONFIG = savedConfig;
		}
	});
});
