import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { RegistryChange } from "../registry";
import { Registry } from "../registry";

afterAll(cleanupTempDirs);

function tmpStatePath(): string {
	return join(tempDir("omp-session-registry-"), "state.json");
}

type CreateInit = Parameters<Registry["create"]>[0];

/** Minimal valid create() payload; override any field. */
function baseInit(overrides: Partial<CreateInit> = {}): CreateInit {
	return {
		name: "demo",
		cwd: "/tmp/proj-a",
		project: "proj-a",
		...overrides,
	};
}

function loadedRegistry(statePath: string): Promise<Registry> {
	const registry = new Registry(statePath);
	return registry.load().then(() => registry);
}

/** Status of one entry as the state file holds it (not the in-memory copy). */
function onDiskStatus(statePath: string, daemonId: string): string | undefined {
	const { entries } = JSON.parse(readFileSync(statePath, "utf8")) as {
		entries: Array<{ daemonId: string; status: string }>;
	};
	return entries.find((e) => e.daemonId === daemonId)?.status;
}

describe("Registry", () => {
	test("missing state file loads as an empty registry; first id is d1", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		expect(registry.list()).toEqual([]);
		expect(registry.get("d1")).toBeUndefined();
		const entry = registry.create(baseInit());
		expect(entry.daemonId).toBe("d1");
		expect(entry.status).toBe("spawning");
		expect(entry.registeredAt).toBeGreaterThan(0);
	});

	test("create stores every field incl. template", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(
			baseInit({
				name: "alpha",
				cwd: "/srv/repos/web",
				project: "web",
				worktreeOf: "main",
				template: "local",
				status: "ready",
			}),
		);
		expect(registry.get(entry.daemonId)).toEqual(entry);
		expect(registry.get(entry.daemonId)).toMatchObject({
			name: "alpha",
			cwd: "/srv/repos/web",
			project: "web",
			worktreeOf: "main",
			template: "local",
			status: "ready",
		});
	});

	test("persistence round-trip: reload from disk deep-equals memory", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const a = registry.create(
			baseInit({
				name: "alpha",
			}),
		);
		const b = registry.create(
			baseInit({
				name: "beta",
				cwd: "/tmp/proj-b",
				project: "proj-b",
			}),
		);
		registry.setStatus(a.daemonId, "ready");
		registry.setStatus(b.daemonId, "error", "connect refused");

		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list()).toEqual(registry.list());
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d1", "d2"]);
		// nextId is persisted too.
		expect(JSON.parse(readFileSync(statePath, "utf8")).nextId).toBe(3);
	});

	test("worktree kind is inferred from worktreeOf; a plain entry is direct", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const linked = registry.create(baseInit({ worktreeOf: "/tmp/main" }));
		expect(linked.workspace?.kind).toBe("worktree");
		const direct = registry.create(baseInit());
		expect(direct.workspace).toEqual({ kind: "direct", projectId: "", desiredState: "running" });
		registry.flush();
		expect((await loadedRegistry(statePath)).list()).toEqual(registry.list());
	});

	test("explicit worktree workspace persists through workspace mutations and reload", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(
			baseInit({
				workspace: {
					kind: "worktree",
					projectId: "p1",
					desiredState: "running",
					source: { local: "/tmp/main" },
				},
			}),
		);
		registry.updateWorkspace(entry.daemonId, { desiredState: "stopped" });
		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.get(entry.daemonId)?.workspace).toEqual({
			kind: "worktree",
			projectId: "p1",
			desiredState: "stopped",
			source: { local: "/tmp/main" },
		});
		expect(reloaded.list()).toEqual(registry.list());
	});

	test("legacy persisted entries infer workspace kind lazily", async () => {
		const statePath = tmpStatePath();
		const fixtures = [
			// `managed` is the legacy persisted roster flag, no longer a create() field.
			{ ...baseInit(), managed: true },
			baseInit({ worktreeOf: "/tmp/main" }),
			{
				...baseInit({
					workspace: { kind: "worktree", projectId: "p1", desiredState: "running" },
				}),
				managed: true,
			},
			baseInit({
				workspace: { kind: "worktree", projectId: "p1", desiredState: "stopped" },
			}),
			baseInit(),
			baseInit({
				workspace: { kind: "clone", projectId: "p1", desiredState: "stopped" },
			}),
		];
		const original = JSON.stringify({
			nextId: 7,
			entries: fixtures.map((init, index) => ({
				...init,
				daemonId: `d${index + 1}`,
				registeredAt: 1,
				status: "asleep",
			})),
		});
		writeFileSync(statePath, original);
		const registry = new Registry(statePath);
		let changes = 0;
		registry.onChange = () => {
			changes++;
		};
		await registry.load();
		expect(changes).toBe(0);
		expect(readFileSync(statePath, "utf8")).toBe(original);
		for (const daemonId of ["d1", "d2", "d3", "d4"]) {
			expect(registry.get(daemonId)?.workspace?.kind).toBe("worktree");
		}
		expect(registry.get("d5")?.workspace).toEqual({
			kind: "direct",
			projectId: "",
			desiredState: "running",
		});
		expect(registry.get("d6")?.workspace).toEqual({
			kind: "clone",
			projectId: "p1",
			desiredState: "stopped",
		});
		registry.update("d3", { name: "migrated" });
		expect(changes).toBe(1);
		registry.flush();
		const persisted = JSON.parse(readFileSync(statePath, "utf8"));
		expect(persisted.entries[2].workspace.kind).toBe("worktree");
		expect((await loadedRegistry(statePath)).list()).toEqual(registry.list());
	});

	test("a legacy `labels` key is dropped on load and does not survive the next write", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({
				nextId: 2,
				entries: [
					{
						...baseInit(),
						daemonId: "d1",
						registeredAt: 1,
						status: "asleep",
						labels: ["env=prod"],
					},
				],
			}),
		);
		const registry = await loadedRegistry(statePath);
		expect(registry.get("d1")).not.toHaveProperty("labels");
		registry.update("d1", { name: "renamed" });
		registry.flush();
		const persisted = JSON.parse(readFileSync(statePath, "utf8"));
		expect(persisted.entries[0].name).toBe("renamed");
		expect(persisted.entries[0]).not.toHaveProperty("labels");
	});

	test("dN allocation is monotonic across remove and reload (no id reuse)", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		expect(registry.create(baseInit()).daemonId).toBe("d1");
		expect(registry.create(baseInit()).daemonId).toBe("d2");
		expect(registry.remove("d1")).toBe(true);
		// Same instance: the counter already advanced.
		expect(registry.create(baseInit()).daemonId).toBe("d3");

		// Reload from disk: d1 stays gone and the counter stays advanced.
		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d2", "d3"]);
		expect(reloaded.create(baseInit()).daemonId).toBe("d4");
	});

	test("atomic save: disk always holds complete JSON and never leaves tmp files", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		for (let i = 0; i < 5; i++) registry.create(baseInit({ name: `daemon-${i}` }));
		registry.update("d1", { name: "renamed" });
		registry.setStatus("d2", "error", "boom");
		registry.remove("d3");

		registry.flush();
		const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(onDisk.entries).toEqual(registry.list());
		expect(onDisk.nextId).toBe(6);
		expect(readdirSync(dirname(statePath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("a failed write surfaces from flush and the next flush persists", async () => {
		const statePath = tmpStatePath();
		let failRename = false;
		const registry = new Registry(statePath, () => {
			if (failRename) throw new Error("injected save failure");
		});
		await registry.load();
		registry.create(baseInit({ name: "kept" }));
		registry.setStatus("d1", "ready");
		registry.flush();

		// The mutation lands in memory and does not throw; the failed persist
		// surfaces from flush(), and the real state file keeps the last complete
		// snapshot.
		failRename = true;
		expect(registry.create(baseInit({ name: "lost" })).daemonId).toBe("d2");
		expect(registry.get("d2")?.name).toBe("lost");
		expect(() => registry.flush()).toThrow("injected save failure");
		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as {
			nextId: number;
			entries: Array<{ daemonId: string; name: string; status: string }>;
		};
		expect(onDisk.entries.map((e) => e.daemonId)).toEqual(["d1"]);
		expect(onDisk.entries.map((e) => e.name)).toEqual(["kept"]);
		expect(onDisk.entries[0]?.status).toBe("ready");
		expect(onDisk.nextId).toBe(2);

		// The write stays pending: once the failure clears, the next flush
		// persists everything, including the entry created during the failure.
		failRename = false;
		registry.flush();
		const recovered = JSON.parse(readFileSync(statePath, "utf8")) as {
			nextId: number;
			entries: Array<{ daemonId: string; name: string }>;
		};
		expect(recovered.entries.map((e) => e.daemonId)).toEqual(["d1", "d2"]);
		expect(recovered.entries.map((e) => e.name)).toEqual(["kept", "lost"]);
		expect(recovered.nextId).toBe(3);
		// The stale tmp file from the failed attempt is replaced and renamed.
		expect(readdirSync(dirname(statePath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("a corrupt state file falls back to the .bak kept by the previous write", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		registry.create(baseInit({ name: "first" }));
		registry.flush();
		registry.create(baseInit({ name: "second" }));
		// This write keeps the state with only "first" as state.json.bak.
		registry.flush();
		writeFileSync(statePath, "{ torn write");

		const errors: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		try {
			const restored = new Registry(statePath);
			await restored.load();
			expect(restored.list().map((e) => e.name)).toEqual(["first"]);
			const loggedRestore = errors.some((line) =>
				line.includes("restored the last good registry state"),
			);
			expect(loggedRestore).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	test("volatile status writes are coalesced: disk lags until flush()", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit());
		registry.flush();
		registry.setStatus(entry.daemonId, "ready");
		registry.setStatus(entry.daemonId, "asleep");
		registry.setStatus(entry.daemonId, "ready");
		// Volatile-only changes wait for the 200 ms timer: the state file still
		// holds the status from the last write.
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		expect(onDiskStatus(statePath, entry.daemonId)).toBe("spawning");
		registry.flush();
		expect(onDiskStatus(statePath, entry.daemonId)).toBe("ready");
	});

	test("close() persists a pending volatile change", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit());
		registry.flush();
		registry.setStatus(entry.daemonId, "ready");
		expect(onDiskStatus(statePath, entry.daemonId)).toBe("spawning");
		registry.close();
		expect(onDiskStatus(statePath, entry.daemonId)).toBe("ready");
	});

	test("update applies a partial patch, persists, and throws on unknown id", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit({ name: "old" }));
		const updated = registry.update(entry.daemonId, { name: "new", branch: "feature/x" });
		expect(updated).not.toBe(entry); // copy-on-update
		expect(registry.get(entry.daemonId)).toBe(updated);
		expect(registry.get(entry.daemonId)).toMatchObject({ name: "new", cwd: "/tmp/proj-a" });
		expect(() => registry.update("d99", { name: "x" })).toThrow("d99");

		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.get("d1")?.name).toBe("new");
	});

	test("setStatus sets and clears the error field", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit());

		registry.setStatus(entry.daemonId, "error", "spawn failed: port busy");
		expect(registry.get(entry.daemonId)).toMatchObject({
			status: "error",
			error: "spawn failed: port busy",
		});

		// Any non-error transition clears the error.
		registry.setStatus(entry.daemonId, "ready");
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		expect(registry.get(entry.daemonId)?.error).toBeUndefined();

		// "error" without a message clears a previous error too.
		registry.setStatus(entry.daemonId, "error", "boom");
		registry.setStatus(entry.daemonId, "error");
		expect(registry.get(entry.daemonId)?.error).toBeUndefined();

		// Status and cleared error survive a reload.
		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.get(entry.daemonId)?.status).toBe("error");
		expect(reloaded.get(entry.daemonId)?.error).toBeUndefined();

		expect(() => registry.setStatus("d99", "ready")).toThrow("d99");
	});

	test("remove returns false for unknown ids and persists the removal", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const a = registry.create(baseInit({ name: "a" }));
		registry.create(baseInit({ name: "b" }));
		expect(registry.remove("d99")).toBe(false);
		expect(registry.remove(a.daemonId)).toBe(true);
		expect(registry.get(a.daemonId)).toBeUndefined();
		expect(registry.list().map((e) => e.daemonId)).toEqual(["d2"]);

		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d2"]);
	});

	test("list returns a defensive copy", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		registry.create(baseInit({ name: "a" }));
		registry.create(baseInit({ name: "b" }));
		const snapshot = registry.list();
		snapshot.pop();
		expect(registry.list()).toHaveLength(2);
	});

	test("onChange fires on every mutation but not on load or failed remove", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const changes: RegistryChange[] = [];
		registry.onChange = (change) => {
			changes.push(change);
		};
		const entry = registry.create(baseInit()); // 1
		expect(changes[0]?.upserted).toEqual([entry]);
		expect(changes[0]?.removed).toEqual([]);
		registry.update(entry.daemonId, { name: "x" }); // 2
		registry.setStatus(entry.daemonId, "ready"); // 3
		expect(registry.remove("d99")).toBe(false); // not a mutation
		registry.remove(entry.daemonId); // 4
		expect(changes[3]?.upserted).toEqual([]);
		expect(changes[3]?.removed).toEqual([entry.daemonId]);
		await registry.load(); // initialization, not a mutation
		registry.create(baseInit()); // 5
		expect(changes).toHaveLength(5);
	});

	test("corrupt state files throw with the path in the message", async () => {
		const statePath = tmpStatePath();
		writeFileSync(statePath, "{ definitely not json");
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		writeFileSync(statePath, JSON.stringify({ nextId: "oops", entries: [] }));
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		writeFileSync(
			statePath,
			JSON.stringify({ nextId: 1, entries: [{ name: "missing-daemonId" }] }),
		);
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);
	});

	test("nextId is floored above the highest id on disk (no reuse after hand-edit)", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({
				nextId: 2,
				entries: [
					{
						daemonId: "d5",
						name: "x",
						cwd: "/x",
						project: "x",
						status: "ready",
						registeredAt: 1,
					},
				],
			}),
		);
		const registry = await loadedRegistry(statePath);
		expect(registry.create(baseInit()).daemonId).toBe("d6");
	});
});

describe("workspace enrollment and store-orphan markers", () => {
	test("setWorkspaceEnrollment persists the binding and workspaceEnrollments() reports it", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		registry.create(baseInit({ name: "enrolled" }));
		registry.create(baseInit({ name: "plain" }));
		registry.setWorkspaceEnrollment("d1", { credentialHash: "a".repeat(64), generation: 3 });

		expect(registry.workspaceEnrollments()).toEqual([
			{ workspaceId: "d1", enrollment: { credentialHash: "a".repeat(64), generation: 3 } },
		]);
		registry.flush();
		expect((await loadedRegistry(statePath)).workspaceEnrollments()).toEqual(
			registry.workspaceEnrollments(),
		);
	});

	test("clearWorkspaceEnrollment ignores a stale generation and clears the matching one", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		registry.create(baseInit());
		registry.setWorkspaceEnrollment("d1", { credentialHash: "b".repeat(64), generation: 2 });

		// A revocation carrying an older generation must not wipe the newer
		// binding, in memory or on disk.
		expect(registry.clearWorkspaceEnrollment("d1", 1)).toBe(false);
		expect(registry.workspaceEnrollments()).toHaveLength(1);
		registry.flush();
		expect((await loadedRegistry(statePath)).workspaceEnrollments()).toHaveLength(1);

		expect(registry.clearWorkspaceEnrollment("d1", 2)).toBe(true);
		expect(registry.workspaceEnrollments()).toEqual([]);
		registry.flush();
		expect((await loadedRegistry(statePath)).workspaceEnrollments()).toEqual([]);
		// Nothing left to clear.
		expect(registry.clearWorkspaceEnrollment("d1", 2)).toBe(false);
	});

	test("markStoreOrphan sets and persists the marker; clearStoreOrphan clears it", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		registry.create(baseInit());

		registry.markStoreOrphan("d1", "deleted without verification");
		expect(registry.storeOrphans()).toEqual({
			d1: { at: expect.any(Number), reason: "deleted without verification" },
		});
		registry.flush();
		expect((await loadedRegistry(statePath)).storeOrphans()).toEqual(registry.storeOrphans());

		expect(registry.clearStoreOrphan("d1")).toBe(true);
		expect(registry.storeOrphans()).toEqual({});
		registry.flush();
		expect((await loadedRegistry(statePath)).storeOrphans()).toEqual({});
		// A workspace with no marker is a no-op.
		expect(registry.clearStoreOrphan("d1")).toBe(false);
	});

	test("malformed storeOrphans in the state file are rejected on load", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({ nextId: 1, entries: [], storeOrphans: { w1: { reason: "no at" } } }),
		);
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		writeFileSync(
			statePath,
			JSON.stringify({ nextId: 1, entries: [], storeOrphans: { w1: null } }),
		);
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		// An array is not a markers map; accepting it would silently drop
		// every marker.
		writeFileSync(statePath, JSON.stringify({ nextId: 1, entries: [], storeOrphans: [] }));
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		// Positive control: a well-formed marker still loads.
		writeFileSync(
			statePath,
			JSON.stringify({ nextId: 1, entries: [], storeOrphans: { w1: { at: 5, reason: "r" } } }),
		);
		const registry = await loadedRegistry(statePath);
		expect(registry.storeOrphans()).toEqual({ w1: { at: 5, reason: "r" } });
	});
});

describe("registered projects (Phase 2)", () => {
	/** A real git repo in a fresh tmp dir (addProject validates the .git entry). */
	async function makeRepo(): Promise<string> {
		const dir = join(tempDir("omp-web-repo-"), "repo");
		mkdirSync(dir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		return dir;
	}

	test("addProject validates the path and allocates p1, p2, …", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		expect(() => registry.addProject(join(tmpdir(), "does-not-exist"))).toThrow("not a directory");
		const plainDir = tempDir("omp-web-plain-");
		expect(() => registry.addProject(plainDir)).toThrow("not a git repository");

		const repoA = await makeRepo();
		const a = registry.addProject(repoA);
		expect(a.existing).toBe(false);
		expect(a.project).toMatchObject({ projectId: "p1", path: repoA, name: "repo" });
		expect(a.project.addedAt).toBeGreaterThan(0);
		const repoB = await makeRepo();
		expect(registry.addProject(repoB).project.projectId).toBe("p2");
		expect(registry.projects().map((p) => p.projectId)).toEqual(["p1", "p2"]);
	});

	test("dedup on realpath: a symlinked path aliases the same project", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const repo = await makeRepo();
		const alias = join(dirname(repo), "alias");
		symlinkSync(repo, alias);
		const first = registry.addProject(repo);
		const second = registry.addProject(alias);
		expect(second).toEqual({ project: first.project, existing: true }); // no duplicate registration
		expect(registry.projects()).toHaveLength(1);
	});

	test("persistence round-trip: projects + nextProjectId survive reload; atomic write intact", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const repoA = await makeRepo();
		const repoB = await makeRepo();
		registry.addProject(repoA);
		const b = registry.addProject(repoB).project;
		// A local daemon tagged with a project id persists too.
		registry.create(baseInit({ projectId: b.projectId }));

		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.projects()).toEqual(registry.projects());
		expect(reloaded.projects().map((p) => p.projectId)).toEqual(["p1", "p2"]);
		expect(reloaded.get("d1")?.projectId).toBe(b.projectId);

		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		expect(onDisk.projects).toEqual(registry.projects());
		expect(onDisk.nextProjectId).toBe(3);
		expect(onDisk.nextId).toBe(2);
		// Atomic write: complete JSON, no tmp files left behind.
		expect(readdirSync(dirname(statePath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("old state files (no projects/nextProjectId keys) load fine and gain the keys on the next write", async () => {
		const statePath = tmpStatePath();
		writeFileSync(statePath, JSON.stringify({ nextId: 4, entries: [] }));
		const registry = await loadedRegistry(statePath);
		expect(registry.projects()).toEqual([]);
		const repo = await makeRepo();
		expect(registry.addProject(repo).project.projectId).toBe("p1");
		registry.flush();
		const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		expect(onDisk.projects).toEqual(registry.projects());
		expect(onDisk.nextProjectId).toBe(2);
		expect(onDisk.nextId).toBe(4); // untouched by the project write
	});

	test("removeProject drops the project and every non-clone row, returning their ids", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const { project } = registry.addProject(await makeRepo());
		const main = registry.create(baseInit({ projectId: project.projectId, status: "ready" }));
		const linked = registry.create(
			baseInit({
				projectId: project.projectId,
				worktreeOf: "/tmp/proj-a",
				status: "asleep",
				lastSessionFile: "/tmp/proj-a/.omp/session.json",
			}),
		);
		const other = registry.addProject(await makeRepo()).project;
		const unrelated = registry.create(baseInit({ projectId: other.projectId }));
		expect(registry.removeProject(project.projectId)).toEqual([main.daemonId, linked.daemonId]);
		expect(registry.projects().map((p) => p.projectId)).toEqual([other.projectId]);
		expect(registry.list().map((e) => e.daemonId)).toEqual([unrelated.daemonId]);
		expect(() => registry.removeProject(project.projectId)).toThrow(
			`unknown project id: ${project.projectId}`,
		);
	});

	test("removeProject refuses while the project owns a clone and changes nothing", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const { project } = registry.addProject(await makeRepo());
		const main = registry.create(baseInit({ projectId: project.projectId }));
		const clone = registry.create(
			baseInit({
				projectId: project.projectId,
				workspace: { kind: "clone", projectId: project.projectId, desiredState: "stopped" },
			}),
		);
		expect(() => registry.removeProject(project.projectId)).toThrow(
			`project ${project.projectId} has clone workspaces: ${clone.daemonId}`,
		);
		expect(registry.projects()).toHaveLength(1);
		expect(registry.get(main.daemonId)).toBeDefined();
		expect(registry.get(clone.daemonId)).toBeDefined();
	});

	test("setProjectMissing persists the flag across reload and clears it", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const { project } = registry.addProject(await makeRepo());
		registry.setProjectMissing(project.projectId, true);
		registry.flush();
		expect((await loadedRegistry(statePath)).projects()[0]?.missing).toBe(true);
		registry.setProjectMissing(project.projectId, false);
		registry.flush();
		expect((await loadedRegistry(statePath)).projects()[0]).not.toHaveProperty("missing");
	});

	test("pN ids are monotonic across remove and reload (no reuse)", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const a = registry.addProject(await makeRepo()).project;
		registry.addProject(await makeRepo());
		registry.removeProject(a.projectId);

		registry.flush();
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.projects().map((p) => p.projectId)).toEqual(["p2"]);
		expect(reloaded.addProject(await makeRepo()).project.projectId).toBe("p3");
	});

	test("addProject/removeProject fire onChange AND onProjectsChange; daemon mutations fire only onChange; projects() is a defensive copy", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		let fired = 0;
		let projectFired = 0;
		registry.onChange = () => {
			fired++;
		};
		registry.onProjectsChange = () => {
			projectFired++;
		};
		const repo = await makeRepo();
		const { project } = registry.addProject(repo); // both hooks
		expect(fired).toBe(1);
		expect(projectFired).toBe(1);
		// A daemon mutation fires onChange only; project broadcasts stay off
		// the hot path (the edge's registered_projects frame rides
		// onProjectsChange).
		registry.create(baseInit({ projectId: project.projectId }));
		expect(fired).toBe(2);
		expect(projectFired).toBe(1);
		registry.remove("d1"); // daemon mutation: onChange only
		expect(fired).toBe(3);
		expect(projectFired).toBe(1);
		registry.removeProject(project.projectId); // both hooks
		expect(fired).toBe(4);
		expect(projectFired).toBe(2);
		expect(() => registry.removeProject(project.projectId)).toThrow(); // refused: not a mutation
		expect(fired).toBe(4);
		expect(projectFired).toBe(2);

		const again = registry.addProject(repo);
		const snapshot = registry.projects();
		snapshot.pop();
		expect(registry.projects()).toHaveLength(1);
		expect(registry.projects()[0]).toBe(again.project);
	});

	test("nextProjectId is floored above the highest project id on disk (no reuse after hand-edit)", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({
				nextId: 1,
				entries: [],
				projects: [{ projectId: "p7", path: "/x", name: "x", addedAt: 1 }],
				nextProjectId: 2,
			}),
		);
		const registry = await loadedRegistry(statePath);
		expect(registry.projects().map((p) => p.projectId)).toEqual(["p7"]);
		expect(registry.addProject(await makeRepo()).project.projectId).toBe("p8");
	});

	test("corrupt projects in state files throw with the path in the message", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({ nextId: 1, entries: [], projects: [{ name: "missing-projectId" }] }),
		);
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);
	});
});

describe("Registry legacy state", () => {
	test("legacy mode and branchCreatedByOmpWeb keys are dropped at load", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({
				nextId: 2,
				entries: [
					{
						daemonId: "d1",
						name: "old",
						cwd: "/tmp/old",
						project: "old",
						mode: "remote",
						status: "asleep",
						registeredAt: 1,
						workspace: {
							kind: "worktree",
							projectId: "p1",
							desiredState: "stopped",
							branchCreatedByOmpWeb: true,
						},
					},
				],
			}),
		);
		const registry = await loadedRegistry(statePath);
		const entry = registry.get("d1");
		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("mode");
		expect(entry?.workspace).not.toHaveProperty("branchCreatedByOmpWeb");
	});
});
