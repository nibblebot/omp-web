/**
 * Phase 3 spawn tests for fleet/server.ts ("POST /ctl/projects with
 * start:true" describe): registering a project with start:true boots the
 * spawned child template whose OMP_SESSION listening line points at the
 * shared fake omp-session daemon (see server.testkit), so the supervisor's
 * spawn dial completes against the fake — no real children spawn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RegistryEntry } from "./registry";
import type { FleetServer } from "./server";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	ompSessionPrintfCommand,
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

describe("POST /ctl/projects with start:true (Phase 3 spawn)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;
	let repoReal: string;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		// The spawn fixture: the fake omp-session reports the spawned cwd in
		// hello_ok (the connector rejects a mismatch), so the fake starts
		// with the repo's realpath before registration — the template's
		// listening line points at it.
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		repoReal = realpathSync(repoDir);
		fake = startFakeDaemon("spawn-token", repoReal);
		server = await startTestFleet(
			{ statePath, configPath },
			{
				templates: { test: { command: ompSessionPrintfCommand(fake.port) } },
				defaultTemplate: "test",
			},
			{ settings: { registry: async () => [] } },
		);
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

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
		expect(body.project.path).toBe(repoReal);
		expect(body.entry.mode).toBe("spawned");
		expect(body.entry.cwd).toBe(repoReal);
		expect(body.entry.projectId).toBe(body.project.projectId);
		expect(body.entry.labels).toEqual(["env=prod"]);
		// The supervisor's spawn dialed the fake: the connector reaches ready.
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
