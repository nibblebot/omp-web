/**
 * Provision-hook tests for fleet/server.ts ("POST /ctl/provision (spawn
 * hook)" describe): the spawnHook config runs a shell provider whose last
 * stdout line is the JSON (name/url/token/cwd) for the new remote entry,
 * plus direct runSpawnHook unit coverage and the CLI `provision` command.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli";
import type { RegistryEntry } from "./registry";
import { runSpawnHook, startFleet, type FleetServer } from "./server";
import {
	cleanupTempDirs,
	fleetPaths,
	postJson,
	startFakeDaemon,
	startTestFleet,
	waitFor,
	type FakeDaemon,
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
	let hookFake: FakeDaemon;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		envFile = join(tmp, "hook-env.txt");
		hookFake = startFakeDaemon("hook-token");
		hookPath = join(tmp, "hook.sh");
		writeHappyHook();
		// `sh -c <path>` needs the exec bit; rewrites below keep the mode.
		chmodSync(hookPath, 0o755);
		hookServer = await startTestFleet({ statePath, configPath }, { spawnHook: hookPath });
	});

	afterAll(async () => {
		if (hookServer !== undefined) await hookServer.close();
		if (hookFake !== undefined) hookFake.close();
	});

	/** The shared hook: records its env, prints noise, then last-line JSON (name/url/token/cwd). */
	function writeHappyHook(): void {
		writeFileSync(
			hookPath,
			[
				"#!/bin/sh",
				`echo "name=$OMP_HOOK_NAME" >> ${envFile}`,
				`echo "labels=$OMP_HOOK_LABELS" >> ${envFile}`,
				"echo 'provisioning sandbox...'", // noise: must not break parsing
				"echo 'still working...'",
				`printf '{"name":"hook-%s","url":"ws://127.0.0.1:${hookFake.port}","token":"hook-token","cwd":"/srv/sandbox"}\\n' "$OMP_HOOK_NAME"`,
				"echo ''", // trailing blank line: last NON-empty line is the JSON
			].join("\n") + "\n",
		);
	}

	test("happy path: hook JSON → remote entry created and dialed with the Bearer token", async () => {
		const res = await postJson(hookServer.port, "/ctl/provision", {
			name: "sandbox-a",
			labels: ["env=prod", "team=x"],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.name).toBe("hook-sandbox-a"); // hook name wins over the requested name
		expect(body.labels).toEqual(["env=prod", "team=x"]);
		expect(body.cwd).toBe("/srv/sandbox");
		expect(body.project).toBe("sandbox");
		expect(body.endpoint).toBe(`ws://127.0.0.1:${hookFake.port}`);
		expect(body.token).toBe("hook-token");
		expect(body.status).toBe("connecting");
		// The connector must dial the printed endpoint with the Bearer token.
		await waitFor(() => hookFake.seen.authHeader !== null, 5000, "provision dial");
		expect(hookFake.seen.authHeader).toBe("Bearer hook-token");
		// The hook env carried the requested name and comma-joined labels.
		const envText = readFileSync(envFile, "utf8");
		expect(envText).toContain("name=sandbox-a");
		expect(envText).toContain("labels=env=prod,team=x");
	});

	test("uses the requested name and empty cwd when the hook output omits them", async () => {
		const { tmp: dir, statePath, configPath: cfg } = fleetPaths();
		const hook = join(dir, "hook.sh");
		writeFileSync(
			hook,
			`#!/bin/sh\nprintf '{"url":"ws://127.0.0.1:${hookFake.port}","token":"hook-token"}\n'\n`,
		);
		chmodSync(hook, 0o755);
		writeFileSync(cfg, JSON.stringify({ spawnHook: hook }));
		const srv = await startFleet({ port: 0, statePath, configPath: cfg });
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

	test("502 when the last stdout line is not valid JSON", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho 'provisioning...'\necho 'not json'\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("not valid JSON");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the hook output lacks url or token", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, '#!/bin/sh\necho \'{"name":"x"}\'\n');
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("missing url or token");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the hook prints a non-ws url", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, '#!/bin/sh\necho \'{"url":"http://example.com","token":"t"}\'\n');
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("url must be ws:// or wss://");
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
		// The 502 tests rewrote the shared hook; restore the happy-path one.
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
		expect(output).toContain("hook-cli-sandbox");
		expect(output).toContain("connecting");
		// The --label flag reached the hook env and the registered entry.
		expect(readFileSync(envFile, "utf8")).toContain("labels=env=test");
		const entry = hookServer.registry.list().find((e) => e.name === "hook-cli-sandbox");
		expect(entry?.labels).toEqual(["env=test"]);
	});
});
