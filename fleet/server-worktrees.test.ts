/**
 * Worktree lifecycle route tests for fleet/server.ts ("worktree lifecycle
 * routes" describe): create/add-existing/delete routes over loopback HTTP
 * against a real git repo, the delete-info guard evidence, and the CLI
 * add-worktree/rm-worktree commands driving the same routes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegisteredProject } from "../shared/protocol";
import { main } from "./cli";
import type { RegistryEntry } from "./registry";
import type { FleetServer } from "./server";
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
			{ roots: [], templates: { local: { command: "sleep 30" } }, defaultTemplate: "local" },
			{ workspaceDir },
		);
		project = await server.registry.addProject(repoDir);
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("POST /ctl/projects/:id/worktrees creates a managed worktree and registers the entry (start:false)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Feature Branch",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
		const target = join(workspaceDir, project.name, "feature-branch");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		// Ownership marker records the owning repo realpath.
		expect(readFileSync(join(workspaceDir, project.name, ".ompweb-repo"), "utf8").trim()).toBe(
			repoDir,
		);
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
		expect(entry.mode).toBe("spawned");
		const target = join(workspaceDir, project.name, "started");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		// The spawned child idles (`sleep 30`); stop it so the suite ends clean.
		await server.supervisor.stop(entry.daemonId);
	});

	test("POST add-existing registers a discovered-but-unregistered worktree (start:false)", async () => {
		// A linked worktree created out-of-band with raw git — exactly what
		// discovery's Add-existing tab would list.
		const outside = join(tmp, "raw-worktree");
		const add = await gitIn(repoDir, ["worktree", "add", "-b", "raw-feat", outside]);
		expect(add.exitCode).toBe(0);
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: outside,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.cwd).toBe(outside);
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
	});

	test("POST add-existing refuses the main checkout and non-worktree paths", async () => {
		const main = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: repoDir,
		});
		expect(main.status).toBe(400);
		const mainBody = (await main.json()) as { error?: string };
		expect(mainBody.error).toContain("not a linked worktree");
		const notRepo = join(tmp, "not-a-repo");
		mkdirSync(notRepo, { recursive: true });
		const plain = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: notRepo,
		});
		expect(plain.status).toBe(400);
	});

	test("POST add-existing refuses an already-registered worktree (409)", async () => {
		const outside = join(tmp, "raw-worktree");
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: outside,
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("already registered");
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

	test("GET /ctl/worktrees/:id/delete-info returns guard evidence (never deletes)", async () => {
		const target = join(workspaceDir, project.name, "feature-branch");
		const entry = server.registry.list().find((e) => e.cwd === target)!;
		const res = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}/delete-info`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			daemonId?: string;
			owned?: boolean;
			dirty?: boolean;
			branch?: string;
			merged?: boolean;
			unpushed?: boolean;
		};
		expect(body.daemonId).toBe(entry.daemonId);
		expect(body.owned).toBe(true);
		expect(body.dirty).toBe(false);
		expect(body.branch).toBe("feature-branch");
		expect(body.merged).toBe(true);
		expect(body.unpushed).toBe(false);
		// Unknown daemons 404.
		const missing = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999/delete-info`);
		expect(missing.status).toBe(404);
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

	test("DELETE refuses a dirty worktree with 409, leaving entry and dir intact", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Dirty",
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const target = entry.cwd;
		writeFileSync(join(target, "scratch.txt"), "x\n");
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(del.status).toBe(409);
		const delBody = (await del.json()) as { error?: string };
		expect(delBody.error).toContain("uncommitted changes");
		// The refusal mutated nothing.
		expect(server.registry.get(entry.daemonId)).toBeDefined();
		expect(existsSync(target)).toBe(true);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).toContain(target);
	});

	test("DELETE refuses a not-owned cwd with 403", async () => {
		const rogue = server.registry.create({
			name: "rogue",
			cwd: join(tmp, "outside-rogue"),
			project: "x",
			labels: [],
			mode: "spawned",
			status: "asleep",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${rogue.daemonId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(403);
		expect(server.registry.get(rogue.daemonId)).toBeDefined();
		server.registry.remove(rogue.daemonId);
	});

	test("DELETE with deleteBranch:true also removes the merged branch (-d only)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Branchy",
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deleteBranch: true }),
		});
		expect(del.status).toBe(200);
		const delBody = (await del.json()) as {
			worktree?: { branch?: string; branchDeleted?: boolean };
		};
		expect(delBody.worktree?.branch).toBe("branchy");
		expect(delBody.worktree?.branchDeleted).toBe(true);
		expect((await gitIn(repoDir, ["branch", "--list", "branchy"])).stdout.trim()).toBe("");
	});

	test("DELETE on an unknown daemon 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
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

	test("CLI add-worktree --existing registers a discovered worktree", async () => {
		const outside = join(tmp, "cli-existing");
		await gitIn(repoDir, ["worktree", "add", "-b", "cli-feat", outside]);
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"add-worktree",
				project.projectId,
				"--existing",
				outside,
				"--no-start",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("registered worktree");
		expect(
			server.registry.list().some((e) => e.cwd === outside && e.projectId === project.projectId),
		).toBe(true);
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

	test("GET /ctl/projects merges a registered project's unregistered linked worktrees and drops roster cwds", async () => {
		// A linked worktree OUTSIDE the discovery roots (roots are [] here):
		// only the registry-backed merge can surface it.
		const wtPath = join(tmp, "ctl-merge-wt");
		const add = await gitIn(repoDir, ["worktree", "add", "-q", "-b", "merge-feat", wtPath]);
		expect(add.exitCode).toBe(0);
		const wtReal = realpathSync(wtPath);
		let entry: RegistryEntry | undefined;
		try {
			const merged = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: Array<{
					name: string;
					path: string;
					isWorktree: boolean;
					worktreeOf?: string;
					branch?: string;
				}>;
			};
			expect(merged.projects).toContainEqual({
				name: "ctl-merge-wt",
				path: wtReal,
				isWorktree: true,
				worktreeOf: project.name,
				branch: "merge-feat",
			});

			// A roster entry for that cwd marks it managed → the row
			// disappears from the projects array.
			entry = server.registry.create({
				name: "ctl-merge-wt",
				cwd: wtReal,
				project: "ctl-merge-wt",
				projectId: project.projectId,
				worktreeOf: project.name,
				labels: [],
				mode: "spawned",
				status: "asleep",
			});
			const merged2 = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: Array<{ path: string }>;
			};
			expect(merged2.projects.some((p) => p.path === wtReal)).toBe(false);
		} finally {
			if (entry) server.registry.remove(entry.daemonId);
			await gitIn(repoDir, ["worktree", "remove", "--force", wtReal]);
		}
	});
});
