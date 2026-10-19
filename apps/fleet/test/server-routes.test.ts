/**
 * Control-plane route tests for fleet/server.ts ("fleet control plane"
 * describe): the /ctl/* routes exercised over loopback HTTP against a real
 * fleet server (see server.testkit). No omp-session children are spawned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { RegistryEntry } from "../registry";
import type { FleetServer } from "../server";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
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

describe("fleet control plane", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let entry: RegistryEntry;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		// Plain cwd usable by the spawn tests (no discovery roots exist).
		mkdirSync(join(tmp, "spawn-cwd"), { recursive: true });
		server = await startTestFleet(
			{ statePath, configPath },
			{},
			// Stub the settings provider registry: the default lazily opens
			// the real ~/.omp auth DB, and these tests must not touch it.
			{ settings: { registry: async () => [] } },
		);
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("GET /ctl/sessions reflects the registry (empty at boot)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	test("GET /ctl/projects returns {projects: RegisteredProject[]} with registered checkouts", async () => {
		const repoDir = join(tmp, "registered-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const added = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(added.status).toBe(201);
		const addedBody = (await added.json()) as { project: { projectId: string } };
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/ctl/projects`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { projects?: unknown };
			expect(Object.keys(body)).toEqual(["projects"]);
			expect(Array.isArray(body.projects)).toBe(true);
			const projects = body.projects as Array<{ projectId: string; path: string }>;
			const found = projects.find((p) => p.projectId === addedBody.project.projectId);
			expect(found?.path).toBe(realpathSync(repoDir));
		} finally {
			server.registry.removeProject(addedBody.project.projectId);
		}
	});

	test("POST /ctl/projects registers a git repo and returns 201 with the project", async () => {
		const repoDir = join(tmp, "ctl-add-project-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const rosterBefore = server.registry.list();
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			project?: { projectId?: string; path?: string; name?: string; addedAt?: number };
			entry?: unknown;
		};
		expect(body.project?.projectId).toMatch(/^p\d+$/);
		expect(body.project?.path).toBe(realpathSync(repoDir));
		expect(body.project?.name).toBe(basename(repoDir));
		expect(typeof body.project?.addedAt).toBe("number");
		expect(body.entry).toBeUndefined();
		// The default workspace is auto-registered: exactly one new roster
		// entry for the repo's main checkout, asleep and tagged with the project.
		const roster = server.registry.list();
		expect(roster).toHaveLength(rosterBefore.length + 1);
		const main = roster.find((e) => e.cwd === realpathSync(repoDir));
		expect(main).toBeDefined();
		expect(main!).toMatchObject({
			name: basename(repoDir),
			cwd: realpathSync(repoDir),
			project: basename(repoDir),
			projectId: body.project!.projectId,
			labels: [],
			status: "asleep",
		});
		// The registered project shows up in GET /ctl/projects.
		const merged = (await (await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)).json()) as {
			projects: Array<{ projectId: string }>;
		};
		expect(merged.projects.some((p) => p.projectId === body.project!.projectId)).toBe(true);
		// Cleanup: the never-started default workspace is a provably-empty
		// placeholder, so the DELETE drops it with the project: a straight 200,
		// not the 409 a real referencing daemon gets.
		const del = await fetch(
			`http://127.0.0.1:${server.port}/ctl/projects/${body.project!.projectId}`,
			{ method: "DELETE" },
		);
		expect(del.status).toBe(200);
	});

	test("POST /ctl/projects on an already-registered checkout answers 200 existing:true and does not spawn", async () => {
		const repoDir = join(tmp, "ctl-dedup-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const first = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { project: { projectId: string } };
		try {
			const rosterBefore = server.registry.list().length;
			// Drift (jgc5): an existing checkout still syncs, as the edge's add_project does.
			const supervisor = server.supervisor;
			const realSync = supervisor.syncNow;
			let syncs = 0;
			supervisor.syncNow = (...args: Parameters<typeof realSync>) => {
				syncs++;
				return realSync.apply(supervisor, args);
			};
			const dup = await postJson(server.port, "/ctl/projects", { path: repoDir });
			supervisor.syncNow = realSync;
			expect(syncs).toBe(1);
			expect(dup.status).toBe(200);
			const dupBody = (await dup.json()) as {
				existing?: boolean;
				project?: { projectId?: string };
			};
			expect(dupBody.existing).toBe(true);
			expect(dupBody.project?.projectId).toBe(firstBody.project.projectId);
			expect(
				server.registry.projects().filter((p) => p.path === realpathSync(repoDir)),
			).toHaveLength(1);
			// No spawn: the deduped POST adds no roster entry.
			expect(server.registry.list()).toHaveLength(rosterBefore);
		} finally {
			server.registry.removeProject(firstBody.project.projectId);
		}
	});

	test("POST /ctl/projects 400s when the path is not a git repo", async () => {
		const plainDir = join(tmp, "ctl-not-a-repo");
		mkdirSync(plainDir, { recursive: true });
		const res = await postJson(server.port, "/ctl/projects", { path: plainDir });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("not a git repository");
	});

	test("DELETE /ctl/projects/:id removes the project and its non-clone rows", async () => {
		const repoDir = join(tmp, "ctl-cascade-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { project: { projectId: string } };
		const projectId = body.project.projectId;
		const row = server.registry.create({
			name: "row",
			cwd: realpathSync(repoDir),
			project: basename(repoDir),
			labels: [],
			template: "test",
			status: "asleep",
			projectId,
		});
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/projects/${projectId}`, {
			method: "DELETE",
		});
		expect(del.status).toBe(200);
		const delBody = (await del.json()) as { removed?: unknown };
		expect(delBody.removed).toBe(projectId);
		expect(server.registry.projects().some((p) => p.projectId === projectId)).toBe(false);
		expect(server.registry.get(row.daemonId)).toBeUndefined();
	});

	test("DELETE /ctl/projects/:id 409s naming clone workspaces and changes nothing", async () => {
		const repoDir = join(tmp, "ctl-clone-blocked-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { project: { projectId: string } };
		const projectId = body.project.projectId;
		const clone = server.registry.create({
			name: "clone",
			cwd: realpathSync(repoDir),
			project: basename(repoDir),
			labels: [],
			template: "test",
			status: "asleep",
			projectId,
			workspace: { kind: "clone", projectId, desiredState: "stopped" },
		});
		try {
			const del = await fetch(`http://127.0.0.1:${server.port}/ctl/projects/${projectId}`, {
				method: "DELETE",
			});
			expect(del.status).toBe(409);
			const delBody = (await del.json()) as { error?: string };
			expect(delBody.error).toContain(
				`project ${projectId} has clone workspaces: ${clone.daemonId}`,
			);
			expect(server.registry.projects().some((p) => p.projectId === projectId)).toBe(true);
			expect(server.registry.get(clone.daemonId)).toBeDefined();
		} finally {
			server.registry.remove(clone.daemonId);
			try {
				server.registry.removeProject(projectId);
			} catch {
				// Already removed.
			}
		}
	});

	test("DELETE /ctl/projects/:id 404s for an unknown project id", async () => {
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/projects/p999`, {
			method: "DELETE",
		});
		expect(del.status).toBe(404);
		const body = (await del.json()) as { error?: string };
		expect(body.error).toContain("unknown project id");
	});

	test("GET /ctl/settings returns the settings model", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/settings`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tabs?: Array<{ id: string }> };
		expect(Array.isArray(body.tabs)).toBe(true);
	});

	test("POST /ctl/settings/set persists a coerced value and returns a fresh model", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tabs: Array<{
				id: string;
				groups: Array<{ items: Array<{ path: string; value: unknown; changed: boolean }> }>;
			}>;
		};
		const item = body.tabs
			.find((tab) => tab.id === "context")
			?.groups.flatMap((group) => group.items)
			.find((item) => item.path === "compaction.thresholdPercent");
		expect(item?.value).toBe(50);
		expect(item?.changed).toBe(true);
		// Restore the schema default so the shared in-memory singleton stays
		// pristine for the rest of the file.
		await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "default",
		});
	});

	test("POST /ctl/settings/set 400s on an unknown path", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "no.such.path",
			value: 1,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Unknown setting");
	});

	test("POST /ctl/settings/set 400s on an uncoercible value", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "abc",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Invalid numeric value");
	});

	test("POST /ctl/settings/set 400s when path is missing", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", { value: 1 });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("missing or invalid field: path");
	});

	test("POST /ctl/settings/unset removes an override and reports changed=false", async () => {
		const setRes = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
		});
		expect(setRes.status).toBe(200);
		const res = await postJson(server.port, "/ctl/settings/unset", {
			path: "compaction.thresholdPercent",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tabs: Array<{
				id: string;
				groups: Array<{ items: Array<{ path: string; value: unknown; changed: boolean }> }>;
			}>;
		};
		const item = body.tabs
			.find((tab) => tab.id === "context")
			?.groups.flatMap((group) => group.items)
			.find((item) => item.path === "compaction.thresholdPercent");
		expect(item?.value).not.toBe(50);
		expect(item?.changed).toBe(false);
	});

	test("POST /ctl/settings/set 409s when expectedRevision is stale", async () => {
		const current = (await (
			await fetch(`http://127.0.0.1:${server.port}/ctl/settings`)
		).json()) as { revision?: number };
		const staleRevision = current.revision ?? 0;
		// Advance the revision so staleRevision no longer matches.
		const advance = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
		});
		expect(advance.status).toBe(200);
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "60",
			expectedRevision: staleRevision,
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Settings changed");
		await postJson(server.port, "/ctl/settings/unset", { path: "compaction.thresholdPercent" });
	});

	test("POST /ctl/settings/unset 409s when expectedRevision is stale", async () => {
		const current = (await (
			await fetch(`http://127.0.0.1:${server.port}/ctl/settings`)
		).json()) as { revision?: number };
		const staleRevision = current.revision ?? 0;
		const advance = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
		});
		expect(advance.status).toBe(200);
		const res = await postJson(server.port, "/ctl/settings/unset", {
			path: "compaction.thresholdPercent",
			expectedRevision: staleRevision,
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Settings changed");
		await postJson(server.port, "/ctl/settings/unset", { path: "compaction.thresholdPercent" });
	});

	test("POST /ctl/settings/set 400s on a project layer write", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
			layer: "project",
		});
		expect(res.status).toBe(400);
	});

	test("POST /ctl/settings/set 400s on a non-numeric expectedRevision", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
			expectedRevision: "3",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("invalid field: expectedRevision");
	});

	test("POST /ctl/spawn 400s on a nonexistent path", async () => {
		const res = await postJson(server.port, "/ctl/spawn", { cwd: join(tmp, "does-not-exist") });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("POST /ctl/spawn 400s when name/labels contain NUL", async () => {
		const cwd = join(tmp, "spawn-cwd");
		const resName = await postJson(server.port, "/ctl/spawn", { cwd, name: "a\u0000b" });
		expect(resName.status).toBe(400);
		const bodyName = (await resName.json()) as { error?: string };
		expect(bodyName.error).toContain("NUL");
		const resLabels = await postJson(server.port, "/ctl/spawn", {
			cwd,
			labels: ["k=v", "x\u0000y"],
		});
		expect(resLabels.status).toBe(400);
		const bodyLabels = (await resLabels.json()) as { error?: string };
		expect(bodyLabels.error).toContain("NUL");
	});

	test("POST /ctl/spawn 400s when a label is not k=v (same rule as the edge)", async () => {
		const cwd = join(tmp, "spawn-cwd");
		const res = await postJson(server.port, "/ctl/spawn", { cwd, labels: ["k=v", "bare"] });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("labels must be an array of k=v strings");
	});

	test("POST /ctl/add is gone (404)", async () => {
		const res = await postJson(server.port, "/ctl/add", {
			name: "gone",
			url: "ws://127.0.0.1:1",
			token: "t",
		});
		expect(res.status).toBe(404);
	});

	test("registry.create adds a connecting row that GET /ctl/sessions reports", () => {
		entry = server.registry.create({
			name: "enrolled",
			cwd: join(tmp, "spawn-cwd"),
			project: "fake-proj",
			labels: ["env=test"],
			template: "test",
			status: "connecting",
		});
		expect(entry.labels).toEqual(["env=test"]);
		expect(entry.status).toBe("connecting");
	});

	test("GET /ctl/sessions lists the registered row", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry[];
		const found = body.find((e) => e.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.name).toBe("enrolled");
		expect(found?.status).toBe("connecting");
	});

	test("GET /ctl/debug returns fleet facts, per-session internals, and the event log", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/debug`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// Fleet facts block.
		const fleet = body.fleet as {
			port?: number;
			startedAt?: number;
			uptimeSec?: number;
			statePath?: string;
			configPath?: unknown;
		};
		expect(fleet.port).toBe(server.port);
		expect(typeof fleet.startedAt).toBe("number");
		expect(fleet.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(fleet.statePath).toBe(statePath);
		expect(fleet.configPath).toBe(configPath);
		// Sessions carry the live entry plus its pair and supervisor internals.
		const sessions = body.sessions as Array<Record<string, unknown>>;
		expect(Array.isArray(sessions)).toBe(true);
		const found = sessions.find((session) => session.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.status).toBe("connecting");
		expect(found?.registeredAt).toBe(server.registry.get(entry.daemonId)?.registeredAt);
		expect(found?.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(found?.pair).toMatchObject({ enrolled: false, paired: false });
		expect(Array.isArray(body.log)).toBe(true);
	});

	test("POST /ctl/prompt with an unknown selector 404s", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: "d999", text: "hi" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/stop 404s on an unknown selector", async () => {
		const res = await postJson(server.port, "/ctl/stop", { selector: "nope" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/stop marks a registered entry asleep", async () => {
		const res = await postJson(server.port, "/ctl/stop", { selector: entry.daemonId });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stopped?: unknown };
		expect(body.stopped).toEqual([entry.daemonId]);
		expect(server.registry.get(entry.daemonId)?.status).toBe("asleep");
	});

	test("POST /ctl/remove 404s on an unknown selector", async () => {
		const res = await postJson(server.port, "/ctl/remove", { selector: "nope" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/remove evicts a registry entry", async () => {
		const added = server.registry.create({
			name: "removable",
			cwd: join(tmp, "spawn-cwd"),
			project: "fake-proj",
			labels: [],
			template: "test",
			status: "asleep",
		});
		const del = await postJson(server.port, "/ctl/remove", { selector: added.daemonId });
		expect(del.status).toBe(200);
		const body = (await del.json()) as { removed?: unknown };
		expect(body.removed).toEqual([added.daemonId]);
		expect(server.registry.get(added.daemonId)).toBeUndefined();
	});

	test("unknown route 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/nope`);
		expect(res.status).toBe(404);
	});
});

describe("GET /ctl/usage", () => {
	let usageServer: FleetServer;
	// Swapped per test; the injected source never touches the real auth DB.
	let source: () => Promise<UsageReport[] | null> = async () => [];

	beforeAll(async () => {
		const { statePath, configPath } = fleetPaths();
		usageServer = await startTestFleet(
			{ statePath, configPath },
			{},
			{ usage: { source: () => source() } },
		);
	});

	afterAll(async () => {
		if (usageServer !== undefined) await usageServer.close();
	});

	test("returns the usage reports as a JSON array", async () => {
		const report = { provider: "anthropic", fetchedAt: 1, limits: [] } as UsageReport;
		source = async () => [report];
		const res = await fetch(`http://127.0.0.1:${usageServer.port}/ctl/usage`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([report]);
	});

	test("a null source (no usage support) answers an empty array", async () => {
		source = async () => null;
		const res = await fetch(`http://127.0.0.1:${usageServer.port}/ctl/usage`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("a failing source answers 502 without echoing the provider error", async () => {
		source = async () => {
			throw new Error("401 from https://api.example/usage?key=sk-secret");
		};
		const res = await fetch(`http://127.0.0.1:${usageServer.port}/ctl/usage`);
		expect(res.status).toBe(502);
		const body = await res.text();
		expect(body).not.toContain("sk-secret");
		expect(JSON.parse(body)).toEqual({ error: "Usage unavailable (see the fleet log)" });
	});
});
