/**
 * Unit tests for pure helpers in fleet/cli.ts (the first-run config offer and
 * its config-file writer). The serve + sessions behavior lives in
 * server-cli.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { resolveBaseDirs, shouldOfferSetup, writeConfigFile } from "./cli";

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
