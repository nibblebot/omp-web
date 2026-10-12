/**
 * Provision-hook tests for fleet/server.ts ("POST /ctl/provision (spawn
 * hook)" describe): the spawnHook config runs via `sh -c` with the callback
 * enrollment in its env. Exit 0 registers an enrolled remote entry; non-zero
 * exit or timeout rolls it back. Also covers direct runSpawnHook units and
 * the CLI `provision` command.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import type { RegistryEntry } from "../registry";
import { runSpawnHook, startFleet, type FleetServer } from "../server";
import {
	cleanupTempDirs,
	fleetPaths,
	hermeticStatsConfig,
	postJson,
	startTestFleet,
	pinSettingsInMemory,
} from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
await pinSettingsInMemory();

describe("POST /ctl/provision (spawn hook)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let hookPath: string;
	let envFile: string;
	let hookServer: FleetServer;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		envFile = join(tmp, "hook-env.txt");
		hookPath = join(tmp, "hook.sh");
		writeHappyHook();
		// `sh -c <path>` needs the exec bit; rewrites below keep the mode.
		chmodSync(hookPath, 0o755);
		hookServer = await startTestFleet({ statePath, configPath }, { spawnHook: hookPath });
	});

	afterAll(async () => {
		if (hookServer !== undefined) await hookServer.close();
	});

	/**
	 * The shared hook: records the provision env (name, labels, callback
	 * enrollment, log-mirror flag), prints stdout noise that must be ignored,
	 * and exits 0.
	 */
	function writeHappyHook(): void {
		writeFileSync(
			hookPath,
			[
				"#!/bin/sh",
				`echo "name=$OMP_HOOK_NAME" >> ${envFile}`,
				`echo "labels=$OMP_HOOK_LABELS" >> ${envFile}`,
				`echo "callback=$OMP_SESSION_CALLBACK_URL" >> ${envFile}`,
				`echo "workspace=$OMP_SESSION_CALLBACK_WORKSPACE" >> ${envFile}`,
				`echo "generation=$OMP_SESSION_CALLBACK_GENERATION" >> ${envFile}`,
				`echo "token=$OMP_SESSION_CALLBACK_TOKEN" >> ${envFile}`,
				`echo "allowHttp=\${OMP_SESSION_CALLBACK_ALLOW_HTTP-unset}" >> ${envFile}`,
				`echo "logMirror=\${OMP_SESSION_LOG_MIRROR-unset}" >> ${envFile}`,
				"echo 'provisioning sandbox...'",
				"echo 'still working...'",
				"exit 0",
			].join("\n") + "\n",
		);
	}

	test("exit 0: enrolled remote entry created; hook env carries the callback enrollment", async () => {
		const res = await postJson(hookServer.port, "/ctl/provision", {
			name: "sandbox-a",
			labels: ["env=prod", "team=x"],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.name).toBe("sandbox-a");
		expect(body.labels).toEqual(["env=prod", "team=x"]);
		expect(body.cwd).toBe("");
		expect(body.project).toBe("");
		expect(body.status).toBe("connecting");
		expect(body).not.toHaveProperty("token");
		const envText = readFileSync(envFile, "utf8");
		expect(envText).toContain("name=sandbox-a");
		expect(envText).toContain("labels=env=prod,team=x");
		expect(envText).toMatch(/^callback=http:\/\/.+$/m);
		expect(envText).toMatch(/^token=[0-9a-f]{64}$/m);
		expect(envText).toContain("generation=1");
		expect(envText).toContain("allowHttp=1");
		expect(envText).toContain("logMirror=unset");
	});

	test("hook stdout is ignored: exit 0 succeeds with the requested name and empty cwd", async () => {
		const { tmp: dir, statePath: sp, configPath: cfg } = fleetPaths();
		const hook = join(dir, "hook.sh");
		writeFileSync(hook, "#!/bin/sh\necho 'not json at all'\nexit 0\n");
		chmodSync(hook, 0o755);
		writeFileSync(cfg, JSON.stringify({ spawnHook: hook }));
		const srv = await startFleet({
			port: 0,
			statePath: sp,
			configPath: cfg,
			statsConfig: hermeticStatsConfig(sp),
		});
		try {
			const res = await postJson(srv.port, "/ctl/provision", { name: "requested-name" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as RegistryEntry;
			expect(body.name).toBe("requested-name");
			expect(body.cwd).toBe("");
			expect(body.project).toBe("");
		} finally {
			await srv.close();
		}
	});

	test("502 when the hook exits non-zero; nothing is registered", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho 'provider exploded' >&2\nexit 3\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn hook exited 3");
		expect(body.error).toContain("provider exploded");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("runSpawnHook kills the child and rejects on timeout", async () => {
		// `exec` replaces sh with sleep so the SIGKILL lands on the sleeper.
		await expect(runSpawnHook("exec sleep 120", {}, 200)).rejects.toThrow(/timed out/);
	});

	test("runSpawnHook captures stdout and rejects on non-zero exit", async () => {
		await expect(runSpawnHook("echo 'output'; exit 7", {})).rejects.toThrow(/exited 7/);
	});

	test("CLI provision posts to /ctl/provision and prints the entry", async () => {
		// The 502 test rewrote the shared hook; restore the happy-path one.
		writeHappyHook();
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main([
				"provision",
				"cli-sandbox",
				"--label",
				"env=test",
				"--port",
				String(hookServer.port),
			]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).toContain("provisioned");
		expect(output).toContain("(cli-sandbox)");
		expect(output).toContain("status connecting");
		// The --label flag reached the hook env and the registered entry.
		expect(readFileSync(envFile, "utf8")).toContain("labels=env=test");
		const entry = hookServer.registry.list().find((e) => e.name === "cli-sandbox");
		expect(entry?.labels).toEqual(["env=test"]);
	});
});
