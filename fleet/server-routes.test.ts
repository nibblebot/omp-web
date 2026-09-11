/**
 * Control-plane route tests for fleet/server.ts ("fleet control plane"
 * describe): the /ctl/* routes exercised over loopback HTTP against a real
 * DaemonConnector + the shared fake omp-session daemon (see server.testkit).
 * No real omp-session children are spawned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RegistryEntry } from "./registry";
import type { FleetServer } from "./server";
import {
	FAKE_CWD,
	cleanupTempDirs,
	fleetPaths,
	gitInit,
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

describe("fleet control plane", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;
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
		if (fake !== undefined) fake.close();
	});

	test("GET /ctl/sessions reflects the registry (empty at boot)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	test("GET /ctl/projects returns registered projects and their unregistered worktrees", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects?: unknown; registered?: unknown };
		expect(Array.isArray(body.projects)).toBe(true);
		expect(body.projects).toHaveLength(0);
		expect(Array.isArray(body.registered)).toBe(true);
		expect(body.registered).toHaveLength(0);

		// A registered project (real git repo) appears in `registered`;
		// `projects` stays empty — it lists only unregistered linked
		// worktrees now that root scanning is gone.
		const repoDir = join(tmp, "registered-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const project = await server.registry.addProject(repoDir);
		try {
			const merged = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: unknown[];
				registered: Array<{ projectId: string }>;
			};
			expect(merged.registered).toHaveLength(1);
			expect(merged.registered[0].projectId).toBe(project.projectId);
		} finally {
			server.registry.removeProject(project.projectId);
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
		// entry for the repo's main checkout, asleep and tagged with the
		// project (no worktreeOf — main checkouts stay untagged).
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
			mode: "spawned",
			status: "asleep",
		});
		expect(main!.worktreeOf).toBeUndefined();
		expect(main!.lastSessionFile).toBeUndefined();
		expect(main!.endpoint).toBeUndefined();
		// The registered project shows up in GET /ctl/projects.
		const merged = (await (await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)).json()) as {
			registered: Array<{ projectId: string }>;
		};
		expect(merged.registered.some((p) => p.projectId === body.project!.projectId)).toBe(true);
		// Cleanup: the never-started default workspace is a provably-empty
		// placeholder, so removeProject drops it with the project and the
		// DELETE stays a straight 200.
		const del = await fetch(
			`http://127.0.0.1:${server.port}/ctl/projects/${body.project!.projectId}`,
			{ method: "DELETE" },
		);
		expect(del.status).toBe(200);
		expect(server.registry.list()).toHaveLength(rosterBefore.length);
	});

	test("POST /ctl/projects dedupes an already-registered realpath to 409 with the existing project", async () => {
		const repoDir = join(tmp, "ctl-dedup-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const first = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { project: { projectId: string } };
		try {
			// Same realpath again (also via a trailing-slash variant): dedup → 409 + project.
			const dup = await postJson(server.port, "/ctl/projects", { path: repoDir });
			expect(dup.status).toBe(409);
			const dupBody = (await dup.json()) as { error?: string; project?: { projectId?: string } };
			expect(dupBody.error).toContain("already registered");
			expect(dupBody.error).toContain(firstBody.project.projectId);
			expect(dupBody.project?.projectId).toBe(firstBody.project.projectId);
			// One registration only.
			expect(
				server.registry.projects().filter((p) => p.path === realpathSync(repoDir)),
			).toHaveLength(1);
			// The deduped POST creates NO second default workspace: the roster
			// still holds exactly the first POST's main-checkout entry.
			expect(server.registry.list().filter((e) => e.cwd === realpathSync(repoDir))).toHaveLength(1);
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

	test("DELETE /ctl/projects/:id 409s naming daemons that still reference the project", async () => {
		const repoDir = join(tmp, "ctl-blocked-repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { project: { projectId: string } };
		// A daemon referencing the project blocks removal (no cascade). This
		// entry is NOT a provably-empty placeholder: a real session file
		// means it has transcripts, so it must block.
		const ref = server.registry.create({
			name: "ref",
			cwd: realpathSync(repoDir),
			project: basename(repoDir),
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			lastSessionFile: join(tmp, "ref-session.json"),
			projectId: body.project.projectId,
		});
		try {
			const del = await fetch(
				`http://127.0.0.1:${server.port}/ctl/projects/${body.project.projectId}`,
				{ method: "DELETE" },
			);
			expect(del.status).toBe(409);
			const delBody = (await del.json()) as { error?: string };
			expect(delBody.error).toContain("in use by daemons");
			expect(delBody.error).toContain(ref.daemonId);
			expect(server.registry.projects().some((p) => p.projectId === body.project.projectId)).toBe(
				true,
			);
			// Once the daemon is gone, removal succeeds.
			server.registry.remove(ref.daemonId);
			const ok = await fetch(
				`http://127.0.0.1:${server.port}/ctl/projects/${body.project.projectId}`,
				{ method: "DELETE" },
			);
			expect(ok.status).toBe(200);
			const okBody = (await ok.json()) as { removed?: unknown };
			expect(okBody.removed).toBe(body.project.projectId);
			expect(server.registry.projects().some((p) => p.projectId === body.project.projectId)).toBe(
				false,
			);
		} finally {
			server.registry.remove(ref.daemonId);
			try {
				server.registry.removeProject(body.project.projectId);
			} catch {
				// Already removed by the happy path above.
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

	test("GET /ctl/settings returns the unattached settings model", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/settings`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tabs?: Array<{ id: string; label: string; groups: Array<{ items: unknown[] }> }>;
		};
		expect(Array.isArray(body.tabs)).toBe(true);
		expect((body.tabs ?? []).length).toBeGreaterThan(0);
		for (const tab of body.tabs ?? []) {
			expect(tab.label.length).toBeGreaterThan(0);
			expect(tab.groups.length).toBeGreaterThan(0);
		}
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

	test("POST /ctl/provision 400s when no spawnHook is configured", async () => {
		const res = await postJson(server.port, "/ctl/provision", { name: "sandbox" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn hook");
	});

	test("POST /ctl/add 400s on invalid JSON", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	test("POST /ctl/add creates a remote entry and the connector dials with the Bearer header", async () => {
		fake = startFakeDaemon("sekret");
		const res = await postJson(server.port, "/ctl/add", {
			name: "added",
			url: fake.url,
			token: "sekret",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.status).toBe("connecting");
		entry = body;
		// The connector must dial the fake and present the Bearer header.
		await waitFor(() => fake.seen.authHeader !== null, 5000, "fake daemon dial");
		expect(fake.seen.authHeader).toBe("Bearer sekret");
		// hello_ok.cwd is adopted when the entry had no cwd.
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "ready",
			5000,
			"daemon ready",
		);
		expect(server.registry.get(entry.daemonId)?.cwd).toBe(FAKE_CWD);
	});

	test("sessions list reflects the registry after add", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry[];
		const found = body.find((e) => e.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.name).toBe("added");
		expect(found?.status).toBe("ready");
		expect(found?.endpoint).toBe(fake.url);
	});

	test("GET /ctl/debug returns fleet facts, per-session internals, and the event log — never tokens", async () => {
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
		// Sessions carry the live entry plus connector/supervisor internals.
		const sessions = body.sessions as Array<Record<string, unknown>>;
		expect(Array.isArray(sessions)).toBe(true);
		const found = sessions.find((session) => session.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.status).toBe("ready");
		expect(found?.endpoint).toBe(fake.url);
		expect(found?.registeredAt).toBe(server.registry.get(entry.daemonId)?.registeredAt);
		expect(found?.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(found?.connector).toMatchObject({ state: "streaming", attempts: 0 });
		// The log holds the lifecycle trail for this daemon (its status
		// transitions landed in the ring at the connector wiring points).
		const log = body.log as Array<{
			source?: string;
			daemonId?: string;
			level?: string;
			message?: string;
		}>;
		expect(Array.isArray(log)).toBe(true);
		expect(log.length).toBeGreaterThan(0);
		expect(
			log.some((event) => event.source === "connector" && event.daemonId === entry.daemonId),
		).toBe(true);
		expect(
			log.some(
				(event) => event.source === "server" && event.message === `added added (${fake.url})`,
			),
		).toBe(true);
		// The browser-facing payload must never leak a bearer token: no key
		// named "token" anywhere in the JSON tree.
		const scan = (value: unknown): void => {
			if (Array.isArray(value)) return value.forEach(scan);
			if (typeof value === "object" && value !== null) {
				for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
					expect(key).not.toBe("token");
					scan(val);
				}
			}
		};
		scan(body);
	});

	test("POST /ctl/prompt with an unknown selector 404s", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: "d999", text: "hi" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/prompt without waitMs returns { submitted } and dispatches", async () => {
		const res = await postJson(server.port, "/ctl/prompt", {
			selector: entry.daemonId,
			text: "ping",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { submitted?: unknown };
		expect(body.submitted).toEqual([entry.daemonId]);
		// The background dispatch must reach the fake (prompt call observed).
		await waitFor(
			() =>
				fake.seen.calls.some(
					(c) =>
						(c as { type?: string; method?: string }).type === "call" &&
						(c as { method?: string }).method === "prompt",
				),
			5000,
			"prompt call on fake",
		);
	});

	test("POST /ctl/prompt with waitMs returns PromptResult[]", async () => {
		const res = await postJson(server.port, "/ctl/prompt", {
			selector: entry.daemonId,
			text: "hello there",
			waitMs: 5000,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			daemonId?: string;
			ok?: boolean;
			text?: string;
			error?: string;
		}>;
		expect(body).toHaveLength(1);
		expect(body[0]?.daemonId).toBe(entry.daemonId);
		expect(body[0]?.ok).toBe(true);
		expect(body[0]?.error).toBeUndefined();
	});

	test("POST /ctl/stop 404s on an unknown selector", async () => {
		const res = await postJson(server.port, "/ctl/stop", { selector: "nope" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/stop marks a remote entry asleep", async () => {
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

	test("POST /ctl/remove evicts a remote entry from the registry", async () => {
		// Its own fake daemon + fresh entry, so the shared `entry` fixture
		// (and the shared `fake`) stays intact for later tests.
		const localFake = startFakeDaemon("remove-token");
		try {
			const res = await postJson(server.port, "/ctl/add", {
				name: "removable",
				url: localFake.url,
				token: "remove-token",
			});
			expect(res.status).toBe(200);
			const added = (await res.json()) as RegistryEntry;
			await waitFor(
				() => server.registry.get(added.daemonId)?.status === "ready",
				5000,
				"removable daemon ready",
			);
			// #24: the connector tracks per-daemon state for the dialed entry;
			// removal must prune it, not leave listeners/waiters/retain counts
			// behind a gone registry entry.
			const before = server.connector.stateCount();
			expect(before).toBeGreaterThan(0);
			const del = await postJson(server.port, "/ctl/remove", { selector: added.daemonId });
			expect(del.status).toBe(200);
			const body = (await del.json()) as { removed?: unknown };
			expect(body.removed).toEqual([added.daemonId]);
			expect(server.registry.get(added.daemonId)).toBeUndefined();
			expect(server.connector.stateCount()).toBe(before - 1);
			expect(server.connector.isConnected(added.daemonId)).toBe(false);
		} finally {
			localFake.close();
		}
	});

	test("unknown route 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/nope`);
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Clone projections + delete-time provider-kind dispatch
// ---------------------------------------------------------------------------

/** `git -C <cwd> <args>` (throws on failure). */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

/** Real local repo with one commit on main (repo-local identity only). */
async function makeRepo(dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await gitInit(dir, "-b", "main");
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
}

/**
 * Scripted fixture provider speaking OMP_PROVIDER_PROTO = 2 (`<exe> <op>`,
 * one JSON request on stdin, one JSON envelope on stdout). Every request is
 * appended to `<stateDir>/ops.jsonl`; ensure reports running, inspect/stop
 * report stopped, delete reports missing.
 */
function writeFakeProvider(dir: string): string {
	const executable = join(dir, "fake-provider.js");
	mkdirSync(dir, { recursive: true });
	const script = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(req.stateDir, { recursive: true });
appendFileSync(join(req.stateDir, "ops.jsonl"), JSON.stringify({ op, generation: req.generation }) + "\\n");
const ok = (observed) => JSON.stringify({ ok: true, providerProto: 2, handle: req.handle ?? "handle-1", observed, pid: 4242 });
const err = (code, message) => JSON.stringify({ ok: false, providerProto: 2, error: { code, message, retryable: false } });
if (op === "ensure-running") console.log(ok("running"));
else if (op === "inspect") console.log(ok("stopped"));
else if (op === "stop") console.log(ok("stopped"));
else if (op === "delete") console.log(ok("missing"));
else console.log(err("invalid_request", "unknown provider op"));
`;
	writeFileSync(executable, script);
	chmodSync(executable, 0o755);
	return executable;
}

/** Fleet-private workspace-record keys that must never cross a route boundary. */
const PRIVATE_WORKSPACE_KEYS = [
	"kubernetes",
	"source",
	"providerHandle",
	"enrollment",
	"deletion",
	"sourcePinDigest",
	"lastAttemptedGeneration",
	"workspace",
];

/** Assert no fleet-private workspace key exists anywhere in a JSON tree. */
function expectNoPrivateWorkspaceKeys(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) expectNoPrivateWorkspaceKeys(item);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		expect(PRIVATE_WORKSPACE_KEYS).not.toContain(key);
		expectNoPrivateWorkspaceKeys(nested);
	}
}

const PUBLIC_WORKSPACE_KEYS = [
	"branch",
	"desiredState",
	"kind",
	"pinnedRevision",
	"profileId",
	"projectId",
];

/** The full private record a kubernetes clone persists (never real here). */
function kubernetesWorkspaceRecord(
	projectId: string,
	resourceIdentity: string,
): RegistryEntry["workspace"] {
	return {
		kind: "clone",
		projectId,
		desiredState: "stopped",
		profileId: "k8s",
		providerKind: "kubernetes",
		kubernetes: {
			resourceIdentity,
			context: "minikube",
			namespace: "omp",
			namespaceUid: "namespace-uid-1",
		},
		source: { remote: "https://example.test/acme/repo.git" },
		pinnedRevision: "a".repeat(40),
		branch: "workspace/kube",
		sourcePinDigest: "b".repeat(64),
		lastAttemptedGeneration: 3,
		providerHandle: "k8s-handle",
		enrollment: { credentialHash: "c".repeat(64), generation: 3 },
		deletion: {
			state: "delete-pending-retry",
			requestedAt: 1,
			error: { code: "conflict", message: "dirty checkout" },
		},
	};
}

describe("clone projections and provider-kind cleanup", () => {
	let tmp: string;
	let workspaceDir: string;
	let repoDir: string;
	let projectId: string;
	let server: FleetServer;

	beforeAll(async () => {
		const paths = fleetPaths("omp-web-routes-clones-");
		tmp = paths.tmp;
		workspaceDir = join(tmp, "workspaces");
		mkdirSync(workspaceDir, { recursive: true });
		repoDir = join(tmp, "repo");
		await makeRepo(repoDir);
		const provider = writeFakeProvider(join(tmp, "provider"));
		server = await startTestFleet(
			{ statePath: paths.statePath, configPath: paths.configPath },
			{
				workspaceDir,
				providerProfiles: {
					local: { id: "local", provider: "bwrap", executable: provider, tools: [] },
				},
			},
			{ workspaceDir },
		);
		projectId = (await server.registry.addProject(repoDir)).projectId;
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	/** Create a stopped bwrap clone through the public route. */
	async function createClone(name: string): Promise<string> {
		const res = await postJson(server.port, "/ctl/clones", {
			projectId,
			name,
			profileId: "local",
			start: false,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry: { daemonId: string } };
		return body.entry.daemonId;
	}

	test("POST /ctl/clones returns the public entry projection only", async () => {
		const res = await postJson(server.port, "/ctl/clones", {
			projectId,
			name: "public-entry",
			profileId: "local",
			start: false,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry: Record<string, unknown> };
		const entry = body.entry;
		// The public facts the CLI/UI consume.
		expect(entry.workspaceKind).toBe("clone");
		expect(entry.desiredState).toBe("stopped");
		expect(entry.providerProfileId).toBe("local");
		expect(entry.projectId).toBe(projectId);
		// The fleet-private record never rides the response: not under a
		// `workspace` key, not flattened, not under any other name.
		expect(entry).not.toHaveProperty("workspace");
		expectNoPrivateWorkspaceKeys(body);
		// The persisted record behind it really does carry those fields.
		const raw = server.registry.get(String(entry.daemonId))!.workspace!;
		expect(raw.providerKind).toBe("bwrap");
		expect(raw.source).toEqual({ local: realpathSync(repoDir) });
		expect(raw.pinnedRevision).toBeDefined();
		expect(typeof raw.branch).toBe("string");
	});

	test("GET /ctl/sessions exposes only the public workspace projection", async () => {
		const daemonId = await createClone("projected");
		const started = await postJson(server.port, "/ctl/start", { daemonId });
		expect(started.status).toBe(200);
		const raw = server.registry.get(daemonId)!.workspace!;
		// Preconditions: the live record carries private facts to drop.
		expect(raw.providerHandle).toBe("handle-1");
		expect(raw.enrollment?.generation).toBe(1);
		expect(raw.lastAttemptedGeneration).toBe(1);
		expect(raw.source).toBeDefined();

		const k8s = server.registry.create({
			name: "kube-projected",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: kubernetesWorkspaceRecord(projectId, "1".repeat(32)),
		});

		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			daemonId: string;
			workspace?: Record<string, unknown>;
		}>;
		const projected = body.find((entry) => entry.daemonId === daemonId);
		expect(projected?.workspace).toBeDefined();
		expect(Object.keys(projected!.workspace!).sort()).toEqual(PUBLIC_WORKSPACE_KEYS);
		expect(projected!.workspace).toMatchObject({
			kind: "clone",
			projectId,
			profileId: "local",
			desiredState: "running",
			pinnedRevision: raw.pinnedRevision,
			branch: raw.branch,
		});
		// A kubernetes record's binding, pin digest, enrollment, and deletion
		// state are fleet-private even though the record persists them.
		const kubeEntry = body.find((entry) => entry.daemonId === k8s.daemonId);
		expect(kubeEntry?.workspace).toBeDefined();
		expect(Object.keys(kubeEntry!.workspace!).sort()).toEqual(PUBLIC_WORKSPACE_KEYS);
		expect(server.registry.get(k8s.daemonId)!.workspace!.kubernetes).toBeDefined();
		// The projected objects carry no private remainder at any depth.
		expectNoPrivateWorkspaceKeys(projected!.workspace);
		expectNoPrivateWorkspaceKeys(kubeEntry!.workspace);
	});

	test("POST /ctl/start and /ctl/wake never return the provider handle", async () => {
		const started = await createClone("start-handle");
		const startRes = await postJson(server.port, "/ctl/start", { daemonId: started });
		expect(startRes.status).toBe(200);
		const startBody: Record<string, unknown> = await startRes.json();
		expect(startBody).toEqual({ daemonId: started, observed: "running", generation: 1 });
		expectNoPrivateWorkspaceKeys(startBody);
		// The record does hold the handle the route withholds.
		expect(server.registry.get(started)!.workspace!.providerHandle).toBe("handle-1");

		const woken = await createClone("wake-handle");
		const wakeRes = await postJson(server.port, "/ctl/wake", { daemonId: woken });
		expect(wakeRes.status).toBe(200);
		const wakeBody: Record<string, unknown> = await wakeRes.json();
		expect(wakeBody).toEqual({ daemonId: woken, observed: "running", generation: 1 });
		expectNoPrivateWorkspaceKeys(wakeBody);
		expect(server.registry.get(woken)!.workspace!.providerHandle).toBe("handle-1");
	});

	test("cleanup of a kubernetes workspace removes only the provider state dirs", async () => {
		const identity = "2".repeat(32);
		const entry = server.registry.create({
			name: "kube-cleanup",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: kubernetesWorkspaceRecord(projectId, identity),
		});
		const stateDir = join(workspaceDir, ".kubernetes", identity);
		const legacyStateDir = join(workspaceDir, ".provider-state", entry.daemonId);
		const localVolume = join(workspaceDir, entry.daemonId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "provider.json"), "{}\n");
		mkdirSync(legacyStateDir, { recursive: true });
		writeFileSync(join(legacyStateDir, "ops.jsonl"), "\n");
		mkdirSync(localVolume, { recursive: true });
		writeFileSync(join(localVolume, "keep.txt"), "keep\n");

		await server.resourceDeleter.deleteWorkspaceResources(
			entry.daemonId,
			server.registry.get(entry.daemonId)!,
		);

		expect(existsSync(stateDir)).toBe(false);
		expect(existsSync(legacyStateDir)).toBe(false);
		// The guarded local-volume branch was NOT taken: a kubernetes
		// workspace's volume is the PVC the provider already deleted.
		expect(existsSync(join(localVolume, "keep.txt"))).toBe(true);
	});

	test("cleanup of a bwrap workspace removes the guarded local volume", async () => {
		const entry = server.registry.create({
			name: "bwrap-cleanup",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: {
				kind: "clone",
				projectId,
				desiredState: "stopped",
				profileId: "local",
				providerKind: "bwrap",
				source: { local: realpathSync(repoDir) },
				pinnedRevision: "a".repeat(40),
				branch: "workspace/bwrap-cleanup",
			},
		});
		const volume = join(workspaceDir, entry.daemonId);
		mkdirSync(join(volume, ".checkout"), { recursive: true });
		writeFileSync(join(volume, ".checkout", "readme.md"), "hello\n");
		server.registry.update(entry.daemonId, { cwd: volume });
		// Provider state that is NOT this workspace's: a bwrap cleanup must
		// leave the kubernetes state root alone.
		const kubeState = join(workspaceDir, ".kubernetes", "3".repeat(32));
		mkdirSync(kubeState, { recursive: true });
		writeFileSync(join(kubeState, "keep.json"), "{}\n");

		await server.resourceDeleter.deleteWorkspaceResources(
			entry.daemonId,
			server.registry.get(entry.daemonId)!,
		);

		expect(existsSync(volume)).toBe(false);
		expect(existsSync(join(kubeState, "keep.json"))).toBe(true);
	});

	test("a legacy record with no provider kind keeps the guarded local-volume path", async () => {
		const entry = server.registry.create({
			name: "legacy-cleanup",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: {
				kind: "clone",
				projectId,
				desiredState: "stopped",
				profileId: "local",
			},
		});
		const volume = join(workspaceDir, entry.daemonId);
		mkdirSync(join(volume, ".home"), { recursive: true });
		writeFileSync(join(volume, ".home", "sentinel"), "x\n");
		server.registry.update(entry.daemonId, { cwd: volume });

		await server.resourceDeleter.deleteWorkspaceResources(
			entry.daemonId,
			server.registry.get(entry.daemonId)!,
		);

		expect(existsSync(volume)).toBe(false);
	});

	test("the local-volume path refuses a volume outside the workspace root", async () => {
		const outside = join(tmp, "outside-volume");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep.txt"), "keep\n");
		const entry = server.registry.create({
			name: "outside-cleanup",
			cwd: outside,
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: {
				kind: "clone",
				projectId,
				desiredState: "stopped",
				profileId: "local",
				providerKind: "bwrap",
			},
		});

		await expect(
			server.resourceDeleter.deleteWorkspaceResources(
				entry.daemonId,
				server.registry.get(entry.daemonId)!,
			),
		).rejects.toThrow();
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	test("the kubernetes path refuses a state path outside the workspace root", async () => {
		const outsideState = join(tmp, "outside-state");
		mkdirSync(outsideState, { recursive: true });
		writeFileSync(join(outsideState, "keep.txt"), "keep\n");
		// A corrupted record whose identity escapes the managed root.
		const entry = server.registry.create({
			name: "escaping-cleanup",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: kubernetesWorkspaceRecord(projectId, "../../outside-state"),
		});

		await expect(
			server.resourceDeleter.deleteWorkspaceResources(
				entry.daemonId,
				server.registry.get(entry.daemonId)!,
			),
		).rejects.toThrow();
		expect(existsSync(join(outsideState, "keep.txt"))).toBe(true);
	});

	test("a placeholder workspace with no volume is a no-op cleanup", async () => {
		const entry = server.registry.create({
			name: "placeholder-cleanup",
			cwd: "",
			project: basename(repoDir),
			projectId,
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			workspace: {
				kind: "clone",
				projectId,
				desiredState: "stopped",
				profileId: "local",
				providerKind: "bwrap",
			},
		});
		await expect(
			server.resourceDeleter.deleteWorkspaceResources(
				entry.daemonId,
				server.registry.get(entry.daemonId)!,
			),
		).resolves.toBeUndefined();
	});
});
