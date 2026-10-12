/**
 * Spawn tests for fleet/server.ts ("POST /ctl/projects with start:true" and
 * POST /ctl/spawn). The spawn template records the child's callback env to a
 * file and sleeps. The test reads the credential from that file and dials the
 * fleet with the callback test daemon, the way a real session would, so an
 * entry reaches "ready" through the pair path. No real omp process runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RegistryEntry } from "../registry";
import type { FleetServer } from "../server";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	postJson,
	startTestFleet,
	waitFor,
	pinSettingsInMemory,
} from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
await pinSettingsInMemory();

const TOKEN_LINE = /^OMP_SESSION_CALLBACK_TOKEN=[0-9a-f]{64}$/m;

function recordedEnv(file: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return env;
}

describe("spawn with start:true and POST /ctl/spawn", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let repoReal: string;
	let envFile: string;
	const spawned: string[] = [];
	const daemons: CallbackDaemon[] = [];

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		repoReal = realpathSync(repoDir);
		envFile = join(tmp, "child-env.txt");
		server = await startTestFleet(
			{ statePath, configPath },
			{
				templates: { test: { command: `env > '${envFile}'; sleep 30` } },
				defaultTemplate: "test",
			},
			{ settings: { registry: async () => [] } },
		);
	});

	afterAll(async () => {
		for (const daemon of daemons) await daemon.stop();
		for (const daemonId of spawned) await server.supervisor.stop(daemonId);
		if (server !== undefined) await server.close();
	});

	// Stand in for the spawned session: wait for its recorded callback env,
	// then dial the fleet with that credential and wait for the pair.
	async function dialAsSession(): Promise<CallbackDaemon> {
		await waitFor(
			() => existsSync(envFile) && TOKEN_LINE.test(readFileSync(envFile, "utf8")),
			5000,
			"child callback env recorded",
		);
		const env = recordedEnv(envFile);
		const daemon = startCallbackDaemon({
			url: env.OMP_SESSION_CALLBACK_URL,
			workspaceId: env.OMP_SESSION_CALLBACK_WORKSPACE,
			generation: Number(env.OMP_SESSION_CALLBACK_GENERATION),
			token: env.OMP_SESSION_CALLBACK_TOKEN,
		});
		daemons.push(daemon);
		await daemon.waitConnected(5000);
		return daemon;
	}

	test("start:true spawns on the project path, tags the entry's projectId, and reaches ready", async () => {
		const repoDir = join(tmp, "repo");
		const res = await postJson(server.port, "/ctl/projects", {
			path: repoDir,
			start: true,
			template: "test",
			labels: ["env=prod"],
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			project: { projectId: string; path: string };
			entry: RegistryEntry;
		};
		spawned.push(body.entry.daemonId);
		expect(body.project.path).toBe(repoReal);
		expect(body.entry.mode).toBe("spawned");
		expect(body.entry.cwd).toBe(repoReal);
		expect(body.entry.projectId).toBe(body.project.projectId);
		expect(body.entry.labels).toEqual(["env=prod"]);

		await dialAsSession();
		expect(recordedEnv(envFile).OMP_SESSION_CALLBACK_WORKSPACE).toBe(body.entry.daemonId);
		await waitFor(
			() => server.registry.get(body.entry.daemonId)?.status === "ready",
			5000,
			"spawned entry ready",
		);
		expect(server.registry.get(body.entry.daemonId)?.projectId).toBe(body.project.projectId);
	});

	test("start:true with an unknown template 500s but the project stays registered", async () => {
		const otherDir = join(tmp, "other-repo");
		mkdirSync(otherDir, { recursive: true });
		await gitInit(otherDir);
		const before = server.registry.projects().length;
		const res = await postJson(server.port, "/ctl/projects", {
			path: otherDir,
			start: true,
			template: "no-such-template",
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn failed");
		// The project stays registered (staged: registration happens first).
		expect(server.registry.projects().some((p) => p.path === realpathSync(otherDir))).toBe(true);
		expect(server.registry.projects().length).toBe(before + 1);
		// No daemon entry was created for the failed spawn.
		const project = server.registry.projects().find((p) => p.path === realpathSync(otherDir));
		expect(server.registry.list().some((e) => e.projectId === project?.projectId)).toBe(false);
	});

	test("POST /ctl/spawn on a registered project's main checkout stamps the entry's projectId", async () => {
		const project = server.registry.projects().find((p) => p.path === repoReal)!;
		const res = await postJson(server.port, "/ctl/spawn", { cwd: repoReal, template: "test" });
		expect(res.status).toBe(200);
		const entry = (await res.json()) as RegistryEntry;
		spawned.push(entry.daemonId);
		// The response carries the stamped entry; the registry agrees.
		expect(entry.daemonId).toBeTruthy();
		expect(entry.projectId).toBe(project.projectId);
		expect(server.registry.get(entry.daemonId)?.projectId).toBe(project.projectId);
		// The project's other daemons (the start:true one) are untouched.
		expect(
			server.registry
				.list()
				.filter((e) => e.projectId === project.projectId)
				.every((e) => e.cwd === repoReal),
		).toBe(true);
	});
});
