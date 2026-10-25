/**
 * Fleet edge worktree command tests: create_worktree / worktree_delete_info /
 * delete_worktree / list_project_branches against a real git repo, on a
 * standalone edge mount.
 * Worktree entries are non-clone spawned entries: the "local" template
 * idles (`sleep 30`) and never pairs, so the fleet only ever sees the
 * roster and git state, never a session dialed by the fleet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RosterEntry, RegisteredProject, ServerFrame } from "#lib/wire/protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { SessionTransportRegistry } from "../session-transport";
import { FleetEdge } from "../edge";
import { FleetEventLog } from "../events";
import { ProjectSync } from "../project-sync";
import { Registry } from "../registry";
import type { WorkspaceLifecycle } from "../workspace-lifecycle";
import { managedWorktreePath, registerWorktreeEntry } from "../worktrees";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import {
	openBrowser,
	serveEdge,
	testEviction,
	testWaker,
	waitFor,
	type BrowserSocket,
} from "./edge.testkit";

afterAll(cleanupTempDirs);

/** A roster broadcast: the priming `roster`, or a mutation's `roster_delta`. */
const isRosterFrame = (f: ServerFrame): boolean => f.type === "roster" || f.type === "roster_delta";
/** Rows a post-mutation broadcast carries: a delta's upserted rows, or a full roster's entries. */
function rowsOf(f: ServerFrame): RosterEntry[] {
	if (f.type === "roster_delta") return f.upserted;
	return f.type === "roster" ? f.entries : [];
}
/** True when a roster broadcast drops the session: a delta removing it, or a full roster without it. */
function dropsRow(f: ServerFrame, workspaceId: string): boolean {
	if (f.type === "roster_delta") return f.removed.includes(workspaceId);
	return f.type === "roster" && !f.entries.some((d) => d.workspaceId === workspaceId);
}

describe("edge worktree commands", () => {
	let tmp: string;
	let registry: Registry;
	let transport: SessionTransportRegistry;
	let config: FleetConfig;
	let lifecycle: WorkspaceLifecycle;
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
		tmp = tempDir("omp-web-edge-wt-");
		registry = new Registry(join(tmp, "state.json"));
		await registry.load();
		// The "local" template idles so a start:true spawn never reaches a
		// real omp-session; the tests stop the child themselves.
		config = {
			templates: { local: { command: "sleep 30" } },
			defaultTemplate: "local",
			workspaceDir: join(tmp, "workspaces"),
			bind: "127.0.0.1",
		};
		transport = new SessionTransportRegistry();
		({ lifecycle } = makeHostLifecycle({
			registry,
			config,
			transport,
			statePath: join(tmp, "state.json"),
			callbackUrl: () => "https://fleet.test/callback",
		}));
		edge = new FleetEdge({
			registry,
			lifecycle,
			sync: new ProjectSync(registry, lifecycle),
			eviction: testEviction(registry, lifecycle),
			waker: testWaker(registry, lifecycle, transport),
			config,
			eventLog: new FleetEventLog(),
			transport,
			fleet: {
				port: 0,
				startedAt: Date.now(),
				statePath: join(tmp, "state.json"),
				configPath: null,
				bind: "127.0.0.1",
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
		project = registry.addProject(repoDir).project;
	});

	afterAll(async () => {
		served.stop();
		edge.close();
		lifecycle.close();
		transport.close();
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
		const created = await browser.waitForFrame(
			(f) => isRosterFrame(f) && rowsOf(f).some((d) => d.cwd === target),
			"roster with the new worktree",
		);
		const entry = rowsOf(created).find((d) => d.cwd === target)!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.status).toBe("asleep");
		expect(existsSync(target)).toBe(true);
		// The roster never leaks tokens/endpoints.
		expect(JSON.stringify(created)).not.toContain("token");
		expect(JSON.stringify(created)).not.toContain("endpoint");
	});

	test("delete_worktree removes a clean attached linked worktree", async () => {
		const outside = join(config.workspaceDir, "repo", "raw-wt");
		await gitIn(repoDir, ["worktree", "add", "-b", "raw-feat", outside]);
		const entry = await registerWorktreeEntry(registry, lifecycle, project, outside, {
			start: false,
		});
		await browser.send({
			type: "worktree_delete_info",
			id: "attached-info",
			workspaceId: entry.workspaceId,
		});
		const info = await browser.waitForFrame(
			(f) => f.type === "worktree_delete_info" && f.workspaceId === entry.workspaceId,
			"attached worktree_delete_info",
		);
		if (info.type !== "worktree_delete_info") throw new Error("expected worktree_delete_info");
		expect(info.linked).toBe(true);
		expect(info.dirty).toBe(false);
		// Floor: only roster frames NEWER than the last one seen so far count.
		const rosters = browser.events.filter((ev) => isRosterFrame(ev.frame));
		const floorId = rosters.length > 0 ? rosters[rosters.length - 1].id : 0;
		await browser.send({
			type: "delete_worktree",
			id: "attached-delete",
			workspaceId: entry.workspaceId,
		});
		await browser.waitForEvent(
			(ev) => ev.id > floorId && dropsRow(ev.frame, entry.workspaceId),
			"roster without the attached worktree",
		);
		expect(registry.get(entry.workspaceId)).toBeUndefined();
		await waitFor(
			() => (existsSync(outside) ? null : "removed"),
			5000,
			"attached worktree removed",
		);
	});

	test("worktree_delete_info answers with the unicast guard-evidence frame", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "My Branch");
		const entry = registry.list().find((e) => e.cwd === target)!;
		await browser.send({ type: "worktree_delete_info", id: "wt3", workspaceId: entry.workspaceId });
		const frame = await browser.waitForFrame(
			(f) => f.type === "worktree_delete_info" && f.workspaceId === entry.workspaceId,
			"worktree_delete_info",
		);
		if (frame.type !== "worktree_delete_info") throw new Error("expected worktree_delete_info");
		expect(frame.linked).toBe(true);
		expect(frame.dirty).toBe(false);
		expect(frame.branch).toBe("my-branch");
		expect(frame.merged).toBe(true);
		expect(frame.unpushed).toBe(false);
		expect(JSON.stringify(frame)).not.toContain("token");
		// Unknown session: an error frame, never a fabricated evidence payload.
		await browser.send({ type: "worktree_delete_info", id: "wt4", workspaceId: "d999" });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("unknown session"),
			"unknown-session error",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("d999");
	});

	test("delete_worktree removes a linked worktree after the creation root changes", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "My Branch");
		const entry = registry.list().find((e) => e.cwd === target)!;
		// Floor: only roster frames NEWER than the last one seen so far count.
		// The priming roster (pre-entry) must not satisfy the "gone" predicate.
		const rosters = browser.events.filter((ev) => isRosterFrame(ev.frame));
		const floorId = rosters.length > 0 ? rosters[rosters.length - 1].id : 0;
		const originalRoot = config.workspaceDir;
		config.workspaceDir = join(tmp, "replacement-workspaces");
		try {
			await browser.send({ type: "delete_worktree", id: "wt5", workspaceId: entry.workspaceId });
			await browser.waitForEvent(
				(ev) => ev.id > floorId && dropsRow(ev.frame, entry.workspaceId),
				"roster without the deleted worktree",
			);
			expect(registry.get(entry.workspaceId)).toBeUndefined();
			// registry.remove broadcasts before Git removal finishes.
			await waitFor(() => (existsSync(target) ? null : "removed"), 5000, "worktree removed");
			expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
				target,
			);
		} finally {
			config.workspaceDir = originalRoot;
		}
	});

	test("delete_worktree rejects the main checkout (not a linked worktree)", async () => {
		const main = registry.create({
			name: "main",
			cwd: repoDir,
			project: project.name,
			status: "asleep",
			projectId: project.projectId,
			workspace: {
				kind: "worktree",
				projectId: project.projectId,
				desiredState: "stopped",
				source: { local: repoDir },
			},
		});
		try {
			await browser.send({
				type: "delete_worktree",
				id: "reject-main",
				workspaceId: main.workspaceId,
			});
			await browser.waitForFrame(
				(f) => f.type === "error" && f.error.includes("not a linked Git worktree"),
				"main checkout refusal",
			);
			expect(registry.get(main.workspaceId)).toBeDefined();
			expect(existsSync(repoDir)).toBe(true);
		} finally {
			registry.remove(main.workspaceId);
		}
	});

	test("delete_worktree refuses a dirty worktree with an error frame, nothing mutated", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "Dirty");
		await browser.send({
			type: "create_worktree",
			id: "wt6",
			projectId: project.projectId,
			name: "Dirty",
		});
		const created = await browser.waitForFrame(
			(f) => isRosterFrame(f) && rowsOf(f).some((d) => d.cwd === target),
			"roster with the dirty worktree",
		);
		const entry = rowsOf(created).find((d) => d.cwd === target)!;
		writeFileSync(join(entry.cwd, "scratch.txt"), "x\n");
		await browser.send({ type: "delete_worktree", id: "wt7", workspaceId: entry.workspaceId });
		const err = await browser.waitForFrame(
			(f) => f.type === "error" && f.error.includes("uncommitted changes"),
			"dirty refusal",
		);
		if (err.type !== "error") throw new Error("expected error");
		expect(err.error).toContain("uncommitted changes");
		expect(registry.get(entry.workspaceId)).toBeDefined();
		expect(existsSync(target)).toBe(true);
	});

	test("delete_worktree that git refuses (locked) keeps the row and the worktree (FLC-21)", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "Locked");
		await browser.send({
			type: "create_worktree",
			id: "wt-locked-1",
			projectId: project.projectId,
			name: "Locked",
		});
		const created = await browser.waitForFrame(
			(f) => isRosterFrame(f) && rowsOf(f).some((d) => d.cwd === target),
			"roster with the locked worktree",
		);
		const entry = rowsOf(created).find((d) => d.cwd === target)!;
		// A lock passes the pre-check (clean linked worktree) but makes
		// `git worktree remove` refuse, the removal that runs after the stop.
		expect((await gitIn(repoDir, ["worktree", "lock", target])).exitCode).toBe(0);
		try {
			await browser.send({
				type: "delete_worktree",
				id: "wt-locked-2",
				workspaceId: entry.workspaceId,
			});
			await browser.waitForFrame(
				(f) => f.type === "error" && f.error.includes("locked"),
				"git refusal of the locked worktree",
			);
			expect(registry.get(entry.workspaceId)).toMatchObject({ status: "asleep" });
			expect(existsSync(target)).toBe(true);
		} finally {
			await gitIn(repoDir, ["worktree", "unlock", target]);
		}
	});

	test("create_worktree with start:true spawns a session on the worktree (project-tagged)", async () => {
		const target = managedWorktreePath(config.workspaceDir, project.path, "Started");
		// The spawn's own create broadcast precedes the projectId tag; wait
		// for a NEWER roster that carries the tag.
		const rosters = browser.events.filter((ev) => isRosterFrame(ev.frame));
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
				isRosterFrame(ev.frame) &&
				rowsOf(ev.frame).some((d) => d.cwd === target && d.projectId === project.projectId),
			"roster with the spawned worktree",
		);
		const entry = rowsOf(tagged.frame).find((d) => d.cwd === target)!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		// Stop the idling child (`sleep 30`) so the suite ends clean.
		await lifecycle.stop(entry.workspaceId);
	});

	test("create_worktree refuses an existing branch checked out elsewhere", async () => {
		await browser.send({
			type: "create_worktree",
			id: "wt9",
			projectId: project.projectId,
			name: "Conflicting",
			existingBranch: "main",
		});
		const answer = await browser.waitForFrame(
			(f) => f.type === "workspace_create_result" && f.id === "wt9",
			"checked-out refusal",
		);
		if (answer.type !== "workspace_create_result")
			throw new Error("expected workspace_create_result");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("already checked out elsewhere");
		expect(answer.error).toContain("main");
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
			const created = await local.waitForFrame(
				(f) => isRosterFrame(f) && rowsOf(f).some((d) => d.cwd === target),
				"roster with the existing-branch worktree",
			);
			const entry = rowsOf(created).find((d) => d.cwd === target)!;
			expect(entry.projectId).toBe(project.projectId);
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
		const answer = await browser.waitForFrame(
			(f) => f.type === "workspace_create_result" && f.id === "wt10",
			"unknown project",
		);
		if (answer.type !== "workspace_create_result")
			throw new Error("expected workspace_create_result");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("p999");
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
		const { project } = registry.addProject(repo);
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
});
