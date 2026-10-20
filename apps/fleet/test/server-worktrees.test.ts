/**
 * Worktree lifecycle route tests for fleet/server.ts ("worktree lifecycle
 * routes" describe): create/delete routes over loopback HTTP against a real
 * git repo, the delete-info guard evidence, and the CLI add-worktree/rm-worktree
 * commands driving the same routes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RegisteredProject } from "#lib/wire/protocol";
import { main } from "../cli";
import { openBrowser } from "./edge.testkit";
import type { RegistryEntry } from "../registry";
import { type FleetServer, resolveStatePath } from "../server";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	pinSettingsInMemory,
	postJson,
	startTestFleet,
} from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
await pinSettingsInMemory();

test("explicit relative fleet state paths resolve absolutely", () => {
	expect(resolveStatePath("relative/fleet-state.json")).toBe(resolve("relative/fleet-state.json"));
});

describe("worktree lifecycle routes", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let workspaceDir: string;
	let repoDir: string;
	let server: FleetServer;
	let project: RegisteredProject;

	/** One `git -C <cwd> <args>` invocation against the real local repo. */
	async function gitIn(
		cwd: string,
		args: string[],
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);
		return { exitCode: await proc.exited, stdout, stderr };
	}

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		workspaceDir = join(tmp, "workspaces");
		// A real git repo (main checkout) to register.
		repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir, "-b", "main");
		await gitIn(repoDir, ["config", "user.email", "test@example.com"]);
		await gitIn(repoDir, ["config", "user.name", "Test"]);
		writeFileSync(join(repoDir, "readme.md"), "hello\n");
		await gitIn(repoDir, ["add", "."]);
		await gitIn(repoDir, ["commit", "-q", "-m", "init"]);
		// The "local" template idles so a start:true spawn never reaches a
		// real omp-session; the route tests stop the child themselves.
		server = await startTestFleet(
			{ statePath, configPath },
			{ templates: { local: { command: ": {fleet}; sleep 30" } }, defaultTemplate: "local" },
			{ workspaceDir },
		);
		project = server.registry.addProject(repoDir).project;
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("POST /ctl/projects/:id/worktrees creates a worktree and registers the entry (start:false)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Feature Branch",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.status).toBe("asleep");
		expect(entry).not.toHaveProperty("workspace");
		const target = join(workspaceDir, project.name, "feature-branch");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(workspaceDir, project.name, ".omp-web-repo"))).toBe(false);
		// git agrees: the worktree is listed with the slug branch.
		const list = await gitIn(repoDir, ["worktree", "list", "--porcelain"]);
		expect(list.stdout).toContain(target);
		expect(list.stdout).toContain("branch refs/heads/feature-branch");
	});

	test("POST create with start:true also spawns a daemon on the worktree", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Started",
			start: true,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		const target = join(workspaceDir, project.name, "started");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(workspaceDir, project.name, ".omp-web-repo"))).toBe(false);
		// The spawned child idles (`sleep 30`); stop it so the suite ends clean.
		await server.lifecycle.stop(entry.daemonId);
	});

	test("POST /ctl/spawn on a registered project's linked worktree stamps the entry's projectId", async () => {
		const target = join(workspaceDir, project.name, "started");
		expect(existsSync(target)).toBe(true);
		const res = await postJson(server.port, "/ctl/spawn", { cwd: target });
		expect(res.status).toBe(200);
		const entry = (await res.json()) as RegistryEntry;
		expect(entry.daemonId).toBeTruthy();
		// The cwd is NOT the main checkout, but it belongs to the project's
		// worktree set, so the stamp still attaches it to the project group.
		expect(entry.projectId).toBe(project.projectId);
		expect(server.registry.get(entry.daemonId)?.projectId).toBe(project.projectId);
		await server.lifecycle.stop(entry.daemonId);
	});

	test("GET /ctl/sessions exposes linked worktrees without private provenance", async () => {
		// A linked worktree created out-of-band with raw git: project sync
		// registers it as an asleep row (there is no add-existing route).
		const rawPath = join(tmp, "raw-worktree");
		expect((await gitIn(repoDir, ["worktree", "add", "-b", "raw-feat", rawPath])).exitCode).toBe(0);
		// Await the registry change that sync's new row produces (no polling).
		const registrySettled = new Promise<void>((resolve) => {
			const prev = server.registry.onChange;
			server.registry.onChange = (change) => {
				prev?.(change);
				if (!server.registry.list().some((e) => e.cwd === rawPath)) return;
				server.registry.onChange = prev;
				resolve();
			};
		});
		server.sync.syncNow();
		await registrySettled;
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const entries: RegistryEntry[] = await res.json();
		const created = entries.find(
			(entry) => entry.cwd === join(workspaceDir, project.name, "feature-branch"),
		);
		const registered = entries.find((entry) => entry.cwd === rawPath);
		expect(created).toBeDefined();
		expect(registered).toBeDefined();
		for (const entry of [created, registered]) {
			expect(entry).not.toHaveProperty("workspace");
		}
		if (registered) server.registry.remove(registered.daemonId);
		await gitIn(repoDir, ["worktree", "remove", "--force", rawPath]);
	});

	test("a clean created linked worktree inside workspaceDir can be deleted from disk", async () => {
		const created = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Adopted Inside",
		});
		expect(created.status).toBe(201);
		// Unchecked: the create 201 body is `{entry: RegistryEntry}` by route contract.
		const createdBody = (await created.json()) as { entry: RegistryEntry };
		const entry = createdBody.entry;
		const target = entry.cwd;
		expect(existsSync(target)).toBe(true);
		const info = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}/delete-info`,
		);
		expect(info.status).toBe(200);
		expect(await info.json()).toMatchObject({ linked: true, dirty: false });
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
		});
		expect(del.status).toBe(200);
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
			target,
		);
	});

	test("POST /ctl/remove forgets a dirty registered worktree without deleting its files or Git registration", async () => {
		const created = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Registered Dirty",
		});
		expect(created.status).toBe(201);
		// Unchecked: the create 201 body is `{entry: RegistryEntry}` by route contract.
		const createdBody = (await created.json()) as { entry: RegistryEntry };
		const entry = createdBody.entry;
		const target = entry.cwd;
		writeFileSync(join(target, "readme.md"), "user edits\n");
		writeFileSync(join(target, "scratch.txt"), "untracked user work\n");
		const removed = await postJson(server.port, "/ctl/remove", { selector: entry.daemonId });
		expect(removed.status).toBe(200);
		expect(await removed.json()).toMatchObject({ removed: [entry.daemonId] });
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(readFileSync(join(target, "readme.md"), "utf8")).toBe("user edits\n");
		expect(readFileSync(join(target, "scratch.txt"), "utf8")).toBe("untracked user work\n");
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).toContain(target);
		expect((await gitIn(target, ["status", "--porcelain"])).stdout).toContain("scratch.txt");
	});

	test("POST create 404s on an unknown project and 409s on a duplicate target", async () => {
		const unknown = await postJson(server.port, "/ctl/projects/p999/worktrees", { name: "x" });
		expect(unknown.status).toBe(404);
		const dup = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Feature Branch",
		});
		expect(dup.status).toBe(409);
		const dupBody = (await dup.json()) as { error?: string };
		expect(dupBody.error).toContain("create worktree failed");
	});

	test("GET /ctl/worktrees/:id/delete-info answers for a known daemon and 404s for an unknown one", async () => {
		const target = join(workspaceDir, project.name, "feature-branch");
		const entry = server.registry.list().find((e) => e.cwd === target)!;
		const res = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}/delete-info`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { daemonId?: string };
		expect(body.daemonId).toBe(entry.daemonId);
		// Unknown daemons 404.
		const missing = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999/delete-info`);
		expect(missing.status).toBe(404);
	});

	test("GET /ctl/worktrees/:id/delete-info 400s for a clone workspace (same as the edge)", async () => {
		const clone = server.registry.create({
			name: "clone-info",
			cwd: join(workspaceDir, "clone-info"),
			project: project.name,
			labels: [],
			template: "test",
			status: "asleep",
			projectId: project.projectId,
			workspace: { kind: "clone", projectId: project.projectId, desiredState: "stopped" },
		});
		const res = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${clone.daemonId}/delete-info`,
		);
		expect(res.status).toBe(400);
	});

	test("DELETE /ctl/worktrees/:id stops, evicts, and git-removes the worktree", async () => {
		const target = join(workspaceDir, project.name, "feature-branch");
		const entry = server.registry.list().find((e) => e.cwd === target)!;
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			removed?: string;
			worktree?: { path?: string; branch?: string };
		};
		expect(body.removed).toBe(entry.daemonId);
		expect(body.worktree?.path).toBe(target);
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
			target,
		);
	});

	test("DELETE refuses a dirty worktree with 409 and an error envelope", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Dirty",
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { entry: RegistryEntry };
		const entry = created.entry;
		writeFileSync(join(entry.cwd, "scratch.txt"), "x\n");
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(del.status).toBe(409);
		const delBody = (await del.json()) as { error?: string };
		expect(delBody.error).toContain("uncommitted changes");
		// The guard runs before any mutation: the row and the dirty files survive.
		expect(server.registry.get(entry.daemonId)).toBeDefined();
		expect(existsSync(join(entry.cwd, "scratch.txt"))).toBe(true);
	});

	test("DELETE that git refuses (locked) answers 500 and keeps the row and the worktree (FLC-21)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Locked",
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { entry: RegistryEntry };
		const entry = created.entry;
		// A lock passes the pre-check but makes `git worktree remove` refuse,
		// the removal that runs after the stop.
		expect((await gitIn(repoDir, ["worktree", "lock", entry.cwd])).exitCode).toBe(0);
		try {
			const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(del.status).toBe(500);
			const delBody = (await del.json()) as { error?: string };
			expect(delBody.error).toContain("locked");
			expect(server.registry.get(entry.daemonId)).toMatchObject({ status: "asleep" });
			expect(existsSync(entry.cwd)).toBe(true);
		} finally {
			await gitIn(repoDir, ["worktree", "unlock", entry.cwd]);
		}
	});

	test("a legacy entry without a source checkout resolves its repository from Git and deletes", async () => {
		const target = join(workspaceDir, project.name, "legacy-unsourced");
		expect(
			(await gitIn(repoDir, ["worktree", "add", "-b", "legacy-unsourced", target])).exitCode,
		).toBe(0);
		// Old registry entries carry grouping metadata but no workspace source.
		const legacy = server.registry.create({
			name: "legacy-unsourced",
			cwd: target,
			project: project.name,
			projectId: project.projectId,
			worktreeOf: project.name,
			labels: [],
			status: "asleep",
		});
		const sessions = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(sessions.status).toBe(200);
		const entries: RegistryEntry[] = await sessions.json();
		const publicLegacy = entries.find((entry) => entry.daemonId === legacy.daemonId);
		expect(publicLegacy).toBeDefined();
		expect(publicLegacy).not.toHaveProperty("workspace");
		const info = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${legacy.daemonId}/delete-info`,
		);
		expect(info.status).toBe(200);
		expect(await info.json()).toMatchObject({ linked: true, dirty: false });
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${legacy.daemonId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(server.registry.get(legacy.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
			target,
		);
	});

	test("DELETE with deleteBranch naming the merged branch also removes it (-d only)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Branchy",
		});
		expect(res.status).toBe(201);
		// Unchecked: the create 201 body is `{entry: RegistryEntry}` by route contract.
		const created = (await res.json()) as { entry: RegistryEntry };
		const entry = created.entry;
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deleteBranch: "branchy" }),
		});
		expect(del.status).toBe(200);
		// Unchecked: the DELETE 200 body is `{worktree}` by route contract (fields asserted below).
		const delBody = (await del.json()) as {
			worktree?: { branch?: string; branchDeleted?: boolean };
		};
		expect(delBody.worktree?.branch).toBe("branchy");
		expect(delBody.worktree?.branchDeleted).toBe(true);
		expect((await gitIn(repoDir, ["branch", "--list", "branchy"])).stdout.trim()).toBe("");
	});

	test("DELETE with a boolean deleteBranch answers 400 and removes nothing", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Boolean Branch",
		});
		expect(res.status).toBe(201);
		// Unchecked: the create 201 body is `{entry: RegistryEntry}` by route contract.
		const created = (await res.json()) as { entry: RegistryEntry };
		const entry = created.entry;
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deleteBranch: true }),
		});
		expect(del.status).toBe(400);
		expect(server.registry.get(entry.daemonId)).toBeDefined();
		await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
		});
	});

	test("DELETE on an unknown daemon 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});

	test("linked worktree survives restart with a changed workspaceDir and permits clean disk deletion", async () => {
		const paths = fleetPaths("omp-web-linked-restart-");
		const originalWorkspaceDir = join(paths.tmp, "original-workspaces");
		const changedWorkspaceDir = join(paths.tmp, "changed-workspaces");
		const config = {
			templates: { local: { command: ": {fleet}; sleep 30" } },
			defaultTemplate: "local",
		};
		let restarted: FleetServer | undefined;
		try {
			restarted = await startTestFleet(paths, config, { workspaceDir: originalWorkspaceDir });
			const { project: registered } = restarted.registry.addProject(repoDir);
			const created = await postJson(
				restarted.port,
				`/ctl/projects/${registered.projectId}/worktrees`,
				{ name: "Restart Linked", start: false },
			);
			expect(created.status).toBe(201);
			const body = await created.json();
			expect(typeof body.entry.daemonId).toBe("string");
			const entry = restarted.registry.get(body.entry.daemonId)!;
			expect(entry.cwd).toBe(join(originalWorkspaceDir, registered.name, "restart-linked"));
			await restarted.close();
			restarted = undefined;
			restarted = await startTestFleet(paths, config, { workspaceDir: changedWorkspaceDir });
			const info = await fetch(
				`http://127.0.0.1:${restarted.port}/ctl/worktrees/${entry.daemonId}/delete-info`,
			);
			expect(info.status).toBe(200);
			expect(await info.json()).toMatchObject({ linked: true, dirty: false });
			const deleted = await fetch(
				`http://127.0.0.1:${restarted.port}/ctl/worktrees/${entry.daemonId}`,
				{ method: "DELETE" },
			);
			expect(deleted.status).toBe(200);
			expect(restarted.registry.get(entry.daemonId)).toBeUndefined();
			expect(existsSync(entry.cwd)).toBe(false);
			expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
				entry.cwd,
			);
		} finally {
			if (restarted) await restarted.close();
		}
	});

	test("CLI add-worktree creates via the route (selector by name, --no-start respected)", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"add-worktree",
				project.name,
				"Cli Branch",
				"--no-start",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		const output = logs.join("\n");
		expect(output).toContain("created worktree");
		expect(output).toContain("cli-branch");
		expect(output).toContain("not started");
		expect(existsSync(join(workspaceDir, project.name, "cli-branch"))).toBe(true);
	});

	test("CLI rm-worktree deletes via the route (--delete-branch removes the merged branch)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Rm Me",
			start: false,
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const target = entry.cwd;
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"rm-worktree",
				entry.daemonId,
				"--delete-branch",
				"rm-me",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("removed worktree daemon");
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		// The merged branch was `git branch -d`-ed (never -D).
		expect((await gitIn(repoDir, ["branch", "--list", "rm-me"])).stdout.trim()).toBe("");
	});

	test(
		"a worktree removed on disk is poll-evicted and announces exactly one worktree_removed frame",
		async () => {
			const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
				name: "Vanishing",
			});
			expect(res.status).toBe(201);
			const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
			expect(entry.worktreeOf).toBe(project.name);
			expect(existsSync(entry.cwd)).toBe(true);
			// The row carries a session file, so the eviction announces the toast.
			const sessionFile = join(tmp, "vanishing-session.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "s1", cwd: entry.cwd })}\n`,
			);
			server.registry.update(entry.daemonId, { lastSessionFile: sessionFile });

			// Browser stream open BEFORE the dir vanishes (the toast must land).
			const browser = await openBrowser(server.port);
			// Simulate `git worktree remove` run OUTSIDE the fleet: only the
			// directory disappears; the fleet sees it on the next git-state
			// poll (default 10s interval).
			rmSync(entry.cwd, { recursive: true, force: true });

			// The next poll probes the vanished cwd, fails, and evicts:
			// registry.remove (roster broadcast rides onChange) + one unringed
			// worktree_removed toast.
			const frame = await browser.waitForFrame(
				(f) => f.type === "worktree_removed",
				"worktree_removed frame",
				15_000,
			);
			if (frame.type !== "worktree_removed") throw new Error("expected worktree_removed");
			expect(frame).toMatchObject({
				type: "worktree_removed",
				daemonId: entry.daemonId,
				name: entry.name,
				path: entry.cwd,
			});
			// Evicted from the roster (the broadcast dropped the entry first).
			expect(server.registry.get(entry.daemonId)).toBeUndefined();
			const roster = browser.frames.find(
				(f) =>
					(f.type === "roster_delta" && f.removed.includes(entry.daemonId)) ||
					(f.type === "roster" && !f.daemons.some((d) => d.daemonId === entry.daemonId)),
			);
			expect(roster).toBeDefined();
			// Exactly one toast per eviction: the entry is gone, so later polls
			// cannot re-fire.
			expect(browser.frames.filter((f) => f.type === "worktree_removed")).toHaveLength(1);
			browser.close();

			// UI-initiated deletion never emits the frame: delete another
			// worktree through the route with a fresh browser attached.
			const uiRes = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
				name: "Ui Delete",
			});
			expect(uiRes.status).toBe(201);
			const uiEntry = ((await uiRes.json()) as { entry: RegistryEntry }).entry;
			const uiBrowser = await openBrowser(server.port);
			const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${uiEntry.daemonId}`, {
				method: "DELETE",
			});
			expect(del.status).toBe(200);
			// The route evicts synchronously; wait for its roster broadcast,
			// then pin that no toast rode along.
			await uiBrowser.waitForFrame(
				(f) =>
					(f.type === "roster_delta" && f.removed.includes(uiEntry.daemonId)) ||
					(f.type === "roster" && !f.daemons.some((d) => d.daemonId === uiEntry.daemonId)),
				"roster without UI-deleted entry",
			);
			expect(uiBrowser.frames.filter((f) => f.type === "worktree_removed")).toHaveLength(0);
			uiBrowser.close();
		},
		{ timeout: 20_000 },
	);

	test(
		"a vanished linked row with no session file is evicted without a worktree_removed frame",
		async () => {
			const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
				name: "Never Started",
			});
			expect(res.status).toBe(201);
			// Unchecked: the create 201 body is `{entry: RegistryEntry}` by route contract.
			const created = (await res.json()) as { entry: RegistryEntry };
			const entry = created.entry;
			expect(entry.lastSessionFile).toBeUndefined();
			const browser = await openBrowser(server.port);
			rmSync(entry.cwd, { recursive: true, force: true });
			await browser.waitForFrame(
				(f) =>
					(f.type === "roster_delta" && f.removed.includes(entry.daemonId)) ||
					(f.type === "roster" && !f.daemons.some((d) => d.daemonId === entry.daemonId)),
				"roster without vanished entry",
				15_000,
			);
			expect(server.registry.get(entry.daemonId)).toBeUndefined();
			expect(browser.frames.filter((f) => f.type === "worktree_removed")).toHaveLength(0);
			browser.close();
		},
		{ timeout: 20_000 },
	);
});
