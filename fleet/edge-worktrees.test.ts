/**
 * Fleet edge worktree command tests: create_worktree / add_worktree /
 * worktree_delete_info / delete_worktree / list_project_branches /
 * list_projects against a real git repo, on a standalone edge mount
 * (serverless: the "local" template idles so start:true never dials a real
 * omp-session).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredProject } from "../shared/protocol";
import type { FleetConfig } from "./config";
import { DaemonConnector } from "./connector";
import { FleetEdge } from "./edge";
import { FleetEventLog } from "./events";
import { Registry } from "./registry";
import { SpawnSupervisor } from "./supervisor";
import { managedWorktreePath, registerWorktreeEntry } from "./worktrees";
import {
	asRoster,
	openBrowser,
	serveEdge,
	waitFor,
	type BrowserSocket,
	cleanupTempDirs,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

describe("edge worktree commands", () => {
	let tmp: string;
	let registry: Registry;
	let connector: DaemonConnector;
	let config: FleetConfig;
	let supervisor: SpawnSupervisor;
	let edge: FleetEdge;
	let served: { port: number; stop(): void };
	let repoDir: string;
	let project: RegisteredProject;
	let browser: BrowserSocket;

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
		tmp = mkdtempSync(join(tmpdir(), "omp-web-edge-wt-"));
		registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		connector = new DaemonConnector(registry);
		// The "local" template idles so a start:true spawn never reaches a
		// real omp-session; the tests stop the child themselves.
		config = {
			templates: { local: { command: "sleep 30" } },
			defaultTemplate: "local",
			workspaceDir: join(tmp, "workspaces"),
		};
		supervisor = new SpawnSupervisor(registry, connector, config);
		edge = new FleetEdge({
			registry,
			connector,
			supervisor,
			config,
			eventLog: new FleetEventLog(),
			fleet: {
				port: 0,
				startedAt: Date.now(),
				statePath: join(tmp, "state.json"),
				configPath: null,
			},
		});
		served = serveEdge(edge);
		// A real git repo (main checkout) to register.
		repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		const init = Bun.spawn(["git", "init", "-q", "-b", "main"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await init.exited).toBe(0);
		await gitIn(repoDir, ["config", "user.email", "test@example.com"]);
		await gitIn(repoDir, ["config", "user.name", "Test"]);
		writeFileSync(join(repoDir, "readme.md"), "hi\n");
		await gitIn(repoDir, ["add", "."]);
		await gitIn(repoDir, ["commit", "-q", "-m", "init"]);
		project = await registry.addProject(repoDir);
	});

	afterAll(async () => {
		served.stop();
		edge.close();
		await supervisor.close();
		await connector.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("create_worktree (start:false) lands under workspaceDir and broadcasts a tagged roster entry", async () => {
		browser = await openBrowser(served.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		const target = managedWorktreePath(config.workspaceDir, project.path, "My Branch");
		await browser.send({
			type: "create_worktree",
			id: "wt1",
			projectId: project.projectId,
			name: "My Branch",
		});
		const roster = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && f.daemons.some((d) => d.cwd === target),
				"roster with the new worktree",
			),
		);
		const entry = roster.daemons.find((d) => d.cwd === target)!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
		expect(entry.managed).toBe(true);
		expect(existsSync(target)).toBe(true);
		// The roster never leaks tokens/endpoints.
		expect(JSON.stringify(roster)).not.toContain("token");
		expect(JSON.stringify(roster)).not.toContain("endpoint");
	});

	test("add_worktree registers a discovered-but-unregistered worktree", async () => {
		const outside = join(tmp, "raw-wt");
		await gitIn(repoDir, ["worktree", "add", "-b", "raw-feat", outside]);
		await browser.send({
			type: "add_worktree",
			id: "wt2",
			projectId: project.projectId,
			worktreePath: outside,
		});
		const roster = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && f.daemons.some((d) => d.cwd === outside),
				"roster with the added worktree",
			),
		);
		const entry = roster.daemons.find((d) => d.cwd === outside)!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.status).toBe("asleep");
		// Outside the workspace root: not managed (no worktree deletion offer).
		expect(entry).not.toHaveProperty("managed");
	});

	test("worktree_delete_info answers with the unicast guard-evidence frame", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "My Branch");
		const entry = registry.list().find((e) => e.cwd === target)!;
		await browser.send({ type: "worktree_delete_info", id: "wt3", daemonId: entry.daemonId });
		const frame = await browser.waitForFrame(
			(f) => f.type === "worktree_delete_info" && f.daemonId === entry.daemonId,
			"worktree_delete_info",
		);
		if (frame.type !== "worktree_delete_info") throw new Error("expected worktree_delete_info");
		expect(frame.owned).toBe(true);
		expect(frame.dirty).toBe(false);
		expect(frame.branch).toBe("my-branch");
		expect(frame.merged).toBe(true);
		expect(frame.unpushed).toBe(false);
		expect(JSON.stringify(frame)).not.toContain("token");
		// Unknown daemon: an error frame, never a fabricated evidence payload.
		await browser.send({ type: "worktree_delete_info", id: "wt4", daemonId: "d999" });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("unknown daemon"),
			"unknown-daemon error",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("d999");
	});

	test("delete_worktree stops, evicts, and git-removes the managed worktree", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "My Branch");
		const entry = registry.list().find((e) => e.cwd === target)!;
		// Floor: only roster frames NEWER than the last one seen so far count —
		// the priming roster (pre-entry) must not satisfy the "gone" predicate.
		const rosters = browser.events.filter((ev) => ev.frame.type === "roster");
		const floorId = rosters.length > 0 ? rosters[rosters.length - 1].id : 0;
		await browser.send({ type: "delete_worktree", id: "wt5", daemonId: entry.daemonId });
		await browser.waitForEvent(
			(ev) =>
				ev.id > floorId &&
				ev.frame.type === "roster" &&
				!ev.frame.daemons.some((d) => d.daemonId === entry.daemonId),
			"roster without the deleted worktree",
		);
		expect(registry.get(entry.daemonId)).toBeUndefined();
		// The roster broadcast rides registry.remove, which precedes the git
		// removal — wait for the directory to actually disappear.
		await waitFor(() => (existsSync(target) ? null : "removed"), 5000, "worktree removed");
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
			target,
		);
	});

	test("delete_worktree refuses a dirty worktree with an error frame, nothing mutated", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "Dirty");
		await browser.send({
			type: "create_worktree",
			id: "wt6",
			projectId: project.projectId,
			name: "Dirty",
		});
		const roster = asRoster(
			await browser.waitForFrame(
				(f) => f.type === "roster" && f.daemons.some((d) => d.cwd === target),
				"roster with the dirty worktree",
			),
		);
		const entry = roster.daemons.find((d) => d.cwd === target)!;
		writeFileSync(join(entry.cwd, "scratch.txt"), "x\n");
		await browser.send({ type: "delete_worktree", id: "wt7", daemonId: entry.daemonId });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("uncommitted changes"),
			"dirty refusal",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("uncommitted changes");
		expect(registry.get(entry.daemonId)).toBeDefined();
		expect(existsSync(target)).toBe(true);
	});

	test("create_worktree with start:true spawns a daemon on the worktree (project-tagged)", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "Started");
		// The spawn's own create broadcast precedes the projectId tag; wait
		// for a NEWER roster that carries the tag.
		const rosters = browser.events.filter((ev) => ev.frame.type === "roster");
		const floorId = rosters.length > 0 ? rosters[rosters.length - 1].id : 0;
		await browser.send({
			type: "create_worktree",
			id: "wt8",
			projectId: project.projectId,
			name: "Started",
			start: true,
		});
		const tagged = await browser.waitForEvent(
			(ev) =>
				ev.id > floorId &&
				ev.frame.type === "roster" &&
				ev.frame.daemons.some((d) => d.cwd === target && d.projectId === project.projectId),
			"roster with the spawned worktree",
		);
		const roster = asRoster(tagged.frame);
		const entry = roster.daemons.find((d) => d.cwd === target)!;
		expect(entry.mode).toBe("spawned");
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.managed).toBe(true);
		// Stop the idling child (`sleep 30`) so the suite ends clean.
		await supervisor.stop(entry.daemonId);
	});

	test("create_worktree refuses an existing branch checked out elsewhere", async () => {
		await browser.send({
			type: "create_worktree",
			id: "wt9",
			projectId: project.projectId,
			name: "Conflicting",
			existingBranch: "main",
		});
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("already checked out elsewhere"),
			"checked-out refusal",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("main");
	});

	test("create_worktree attaches an existingBranch not checked out elsewhere", async () => {
		// Success path for the picker's primary flow: existingBranch names a
		// branch NOT checked out anywhere → the worktree attaches to it.
		// Opens its OWN browser (the cluster's shared `browser` is assigned
		// by an earlier test that a -t filter may skip).
		const add = await gitIn(repoDir, ["branch", "feature2"]);
		expect(add.exitCode).toBe(0);
		const target = managedWorktreePath(config.workspaceDir, project.path, "From Branch");
		const local = await openBrowser(served.port);
		try {
			await local.waitForFrame((f) => f.type === "roster", "roster");
			await local.send({
				type: "create_worktree",
				id: "wt11",
				projectId: project.projectId,
				name: "From Branch",
				existingBranch: "feature2",
			});
			const roster = asRoster(
				await local.waitForFrame(
					(f) => f.type === "roster" && f.daemons.some((d) => d.cwd === target),
					"roster with the existing-branch worktree",
				),
			);
			const entry = roster.daemons.find((d) => d.cwd === target)!;
			expect(entry.projectId).toBe(project.projectId);
			expect(entry.mode).toBe("spawned");
			expect(entry.managed).toBe(true);
			expect(existsSync(target)).toBe(true);
			// start:false entries carry no roster branch field; git is the
			// ground truth that the worktree sits on the attached branch.
			expect((await gitIn(target, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe(
				"feature2",
			);
		} finally {
			local.close();
		}
	});

	test("create_worktree with an unknown project errors", async () => {
		await browser.send({ type: "create_worktree", id: "wt10", projectId: "p999", name: "x" });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("unknown project"),
			"unknown project",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("p999");
	});

	test("list_project_branches answers with branches and checked-out state", async () => {
		// A fresh repo (main + feature checked out in a linked worktree + an
		// unchecked third branch) so the assertions don't couple to the
		// shared repoDir's accumulated branches.
		const repo = join(tmp, "branch-picker-repo");
		mkdirSync(repo, { recursive: true });
		const init = Bun.spawn(["git", "init", "-q", "-b", "main"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await init.exited).toBe(0);
		await gitIn(repo, ["config", "user.email", "test@example.com"]);
		await gitIn(repo, ["config", "user.name", "Test"]);
		writeFileSync(join(repo, "readme.md"), "hi\n");
		await gitIn(repo, ["add", "."]);
		await gitIn(repo, ["commit", "-q", "-m", "init"]);
		const linked = join(tmp, "branch-picker-linked");
		const add = await gitIn(repo, ["worktree", "add", "-q", "-b", "feature", linked]);
		expect(add.exitCode).toBe(0);
		await gitIn(repo, ["branch", "unused"]);
		const project = await registry.addProject(repo);
		try {
			browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({
				type: "list_project_branches",
				id: "br1",
				projectId: project.projectId,
			});
			const frame = await browser.waitForFrame(
				(f) => f.type === "project_branches",
				"project_branches frame",
			);
			if (frame.type !== "project_branches") throw new Error("expected project_branches");
			expect(frame.projectId).toBe(project.projectId);
			const byName = new Map(frame.branches.map((b) => [b.name, b]));
			expect(byName.get("main")).toEqual({
				name: "main",
				checkedOut: true,
				worktreePath: realpathSync(repo),
			});
			expect(byName.get("feature")).toEqual({
				name: "feature",
				checkedOut: true,
				worktreePath: realpathSync(linked),
			});
			expect(byName.get("unused")).toEqual({ name: "unused", checkedOut: false });
			expect(frame.branches).toHaveLength(3);
		} finally {
			browser.close();
			await gitIn(repo, ["worktree", "remove", "--force", linked]);
			try {
				registry.removeProject(project.projectId);
			} catch {
				// Already clean.
			}
		}
	});

	test("list_project_branches with an unknown project errors", async () => {
		browser = await openBrowser(served.port);
		await browser.waitForFrame((f) => f.type === "roster", "roster");
		await browser.send({ type: "list_project_branches", id: "br2", projectId: "p999" });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("unknown project"),
			"unknown project",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("p999");
	});

	test("list_projects lists a registered project's unmanaged linked worktrees and drops roster cwds", async () => {
		// A linked worktree of the registered project: only the
		// registry-backed merge surfaces it (there is no root scanning).
		const wtPath = join(tmp, "merge-wt");
		const add = await gitIn(repoDir, ["worktree", "add", "-q", "-b", "merge-branch", wtPath]);
		expect(add.exitCode).toBe(0);
		const wtReal = realpathSync(wtPath);
		const expected = {
			name: "merge-wt",
			path: wtReal,
			isWorktree: true,
			worktreeOf: project.name,
			branch: "merge-branch",
		};
		try {
			browser = await openBrowser(served.port);
			await browser.waitForFrame((f) => f.type === "roster", "roster");
			await browser.send({ type: "list_projects" });
			const frame = await browser.waitForFrame((f) => f.type === "projects", "projects frame");
			if (frame.type !== "projects") throw new Error("expected projects");
			expect(frame.projects).toContainEqual(expected);

			// Registering a daemon on that cwd marks it managed → the row
			// disappears. A fresh browser avoids stale projects frames.
			const entry = await registerWorktreeEntry(registry, supervisor, project, wtReal, {
				start: false,
			});
			try {
				browser.close();
				browser = await openBrowser(served.port);
				await browser.waitForFrame((f) => f.type === "roster", "roster");
				await browser.send({ type: "list_projects" });
				const frame2 = await browser.waitForFrame((f) => f.type === "projects", "projects frame");
				if (frame2.type !== "projects") throw new Error("expected projects");
				expect(frame2.projects.some((p) => p.path === wtReal)).toBe(false);
			} finally {
				registry.remove(entry.daemonId);
			}
		} finally {
			browser.close();
			await gitIn(repoDir, ["worktree", "remove", "--force", wtReal]);
		}
	});
});
