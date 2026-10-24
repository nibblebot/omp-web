/**
 * Fetch a local-source clone's branch into its project (n96e): the control
 * route runs `git fetch <clone checkout> <branch>:<branch>` in the project's
 * main repo through the lifecycle, creating the branch or fast-forwarding it
 * and never overwriting. Real git repos and a real clone checkout over a
 * real fleet control plane (loopback HTTP); the provider executable is never
 * invoked (clones are created stopped).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetServer } from "../server";
import {
	cleanupTempDirs,
	fleetPaths,
	gitInit,
	pinSettingsInMemory,
	postJson,
	startTestFleet,
} from "./server.testkit";

afterAll(cleanupTempDirs);
await pinSettingsInMemory();

async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

/** The ref's commit, or null when the ref does not exist. */
async function tip(cwd: string, ref: string): Promise<string | null> {
	try {
		return await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
	} catch {
		return null;
	}
}

async function commitFile(cwd: string, name: string, text: string): Promise<string> {
	writeFileSync(join(cwd, name), text);
	await git(cwd, ["add", name]);
	await git(cwd, ["commit", "-q", "-m", `add ${name}`]);
	return await git(cwd, ["rev-parse", "HEAD"]);
}

interface Fixture {
	server: FleetServer;
	repoDir: string;
	projectId: string;
}

async function bootFleet(): Promise<Fixture> {
	const paths = fleetPaths("omp-clone-fetch-");
	const repoDir = join(paths.tmp, "repo");
	mkdirSync(repoDir, { recursive: true });
	await gitInit(repoDir, "-b", "main");
	await commitFile(repoDir, "readme.md", "hello\n");
	// Clones are created stopped, so this executable is never run.
	const executable = join(paths.tmp, "never-run-provider");
	writeFileSync(executable, "#!/bin/sh\nexit 1\n");
	chmodSync(executable, 0o755);
	const server = await startTestFleet(
		{ statePath: paths.statePath, configPath: paths.configPath },
		{
			providerProfiles: {
				local: { id: "local", provider: "bwrap", executable, tools: [] },
				remote: { id: "remote", provider: "kubernetes", executable },
			},
		},
		{ workspaceDir: join(paths.tmp, "workspaces") },
	);
	const { project } = server.registry.addProject(repoDir);
	return { server, repoDir, projectId: project.projectId };
}

async function createClone(
	fx: Fixture,
	name: string,
	source?: { local?: string; remote?: string },
): Promise<{ daemonId: string; branch: string; checkout: string }> {
	const res = await postJson(fx.server.port, "/ctl/clones", {
		projectId: fx.projectId,
		name,
		profileId: "local",
		...(source !== undefined ? { source } : {}),
		start: false,
	});
	expect(res.status).toBe(201);
	const { entry } = (await res.json()) as { entry: { daemonId: string } };
	const record = fx.server.registry.get(entry.daemonId)!;
	return {
		daemonId: entry.daemonId,
		branch: record.workspace!.branch!,
		checkout: join(record.cwd!, ".checkout"),
	};
}

function fetchInto(fx: Fixture, daemonId: string): Promise<Response> {
	return postJson(fx.server.port, `/ctl/clones/${daemonId}/fetch-into-project`, {});
}

describe("fetch a clone's branch into its project", () => {
	test("creates the branch in the project, leaving the project's checkout alone", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "feat-create");
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBeNull();
			const work = await commitFile(clone.checkout, "a.txt", "a\n");
			const mainBefore = await tip(fx.repoDir, "refs/heads/main");

			const res = await fetchInto(fx, clone.daemonId);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { outcome: string; commit: string; branch: string };
			expect(body).toMatchObject({ outcome: "created", commit: work, branch: clone.branch });
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBe(work);
			expect(await tip(fx.repoDir, "refs/heads/main")).toBe(mainBefore);
			expect(await git(fx.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
			expect(existsSync(join(fx.repoDir, "a.txt"))).toBe(false);

			// Nothing new in the clone: the same commit is reported, not refetched.
			const again = await fetchInto(fx, clone.daemonId);
			expect(again.status).toBe(200);
			expect(((await again.json()) as { outcome: string }).outcome).toBe("up-to-date");
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("fast-forwards an existing project branch", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "feat-ff");
			const first = await commitFile(clone.checkout, "a.txt", "a\n");
			expect((await fetchInto(fx, clone.daemonId)).status).toBe(200);
			const second = await commitFile(clone.checkout, "b.txt", "b\n");

			const res = await fetchInto(fx, clone.daemonId);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				outcome: "updated",
				commit: second,
				previousCommit: first,
			});
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBe(second);
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("refuses a non-fast-forward update and leaves the project branch untouched", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "feat-diverge");
			await commitFile(clone.checkout, "a.txt", "a\n");
			expect((await fetchInto(fx, clone.daemonId)).status).toBe(200);
			// The project's branch moves on its own, then the clone moves too.
			await git(fx.repoDir, ["checkout", "-q", clone.branch]);
			const projectWork = await commitFile(fx.repoDir, "p.txt", "p\n");
			await git(fx.repoDir, ["checkout", "-q", "main"]);
			await commitFile(clone.checkout, "b.txt", "b\n");

			const res = await fetchInto(fx, clone.daemonId);
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain("fast-forward");
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBe(projectWork);
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("refuses when the project branch is checked out, naming where", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "feat-checked-out");
			await commitFile(clone.checkout, "a.txt", "a\n");
			expect((await fetchInto(fx, clone.daemonId)).status).toBe(200);
			await commitFile(clone.checkout, "b.txt", "b\n");
			await git(fx.repoDir, ["checkout", "-q", clone.branch]);
			const before = await tip(fx.repoDir, `refs/heads/${clone.branch}`);

			const res = await fetchInto(fx, clone.daemonId);
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain("checked out");
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBe(before);
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("refuses a remote-source clone and does not flag it as local-source", async () => {
		const fx = await bootFleet();
		try {
			const local = await createClone(fx, "feat-local");
			const remote = await createClone(fx, "feat-remote", { remote: `file://${fx.repoDir}` });
			expect(fx.server.registry.get(remote.daemonId)!.workspace!.source).toEqual({
				remote: `file://${fx.repoDir}`,
			});
			await commitFile(remote.checkout, "a.txt", "a\n");

			const res = await fetchInto(fx, remote.daemonId);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain("remote source");
			expect(await tip(fx.repoDir, `refs/heads/${remote.branch}`)).toBeNull();

			const roster = (await (
				await fetch(`http://127.0.0.1:${fx.server.port}/ctl/sessions`)
			).json()) as Array<{ daemonId: string; localSource?: true }>;
			expect(roster.find((r) => r.daemonId === local.daemonId)?.localSource).toBe(true);
			expect(roster.find((r) => r.daemonId === remote.daemonId)?.localSource).toBeUndefined();
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("refuses a clone whose provider volume the fleet cannot read", async () => {
		const fx = await bootFleet();
		try {
			const clone = await createClone(fx, "feat-k8s");
			await commitFile(clone.checkout, "a.txt", "a\n");
			fx.server.registry.updateWorkspace(clone.daemonId, { profileId: "remote" });

			const res = await fetchInto(fx, clone.daemonId);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain("kubernetes");
			expect(await tip(fx.repoDir, `refs/heads/${clone.branch}`)).toBeNull();
		} finally {
			await fx.server.close();
		}
	}, 30_000);

	test("refuses a non-clone row and an unknown daemon", async () => {
		const fx = await bootFleet();
		try {
			const direct = fx.server.registry.create({
				name: "plain",
				cwd: fx.repoDir,
				project: "repo",
				projectId: fx.projectId,
				status: "asleep",
			});
			expect((await fetchInto(fx, direct.daemonId)).status).toBe(400);
			expect((await fetchInto(fx, "d999")).status).toBe(404);
		} finally {
			await fx.server.close();
		}
	}, 30_000);
});
