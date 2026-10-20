/**
 * Spawn tests for fleet/server.ts ("POST /ctl/projects with start:true" and
 * POST /ctl/spawn). The spawn template carries `{fleet}` (`--fleet-stdin`): the
 * fleet writes one JSON payload (callback pair plus listener token) to the child's
 * stdin. The fake child appends that payload to a file, records its env, and
 * sleeps. The test parses the payload and dials the fleet with the callback test
 * daemon, the way a real session would, so an entry reaches "ready" through the
 * pair path. No real omp process runs.
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

/** The `--fleet-stdin` payload the host runtime writes to the child's stdin. */
type FleetPayload = {
	v: 1;
	callback: {
		url: string;
		workspace: string;
		generation: number;
		token: string;
		allowHttp?: true;
		proxy?: string;
	};
	token?: string;
};

describe("spawn with start:true and POST /ctl/spawn", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let repoReal: string;
	let envFile: string;
	let payloadFile: string;
	const spawned: string[] = [];
	const daemons: CallbackDaemon[] = [];

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		await gitInit(repoDir);
		repoReal = realpathSync(repoDir);
		envFile = join(tmp, "child-env.txt");
		payloadFile = join(tmp, "child-payload.txt");
		server = await startTestFleet(
			{ statePath, configPath },
			{
				templates: {
					test: {
						// `:` swallows the expanded `--fleet-stdin`. The env dump is renamed into
						// place so a reader never sees it half written.
						command: `: {fleet}; { cat; echo; } >> '${payloadFile}'; env > '${envFile}.tmp' && mv '${envFile}.tmp' '${envFile}'; sleep 30`,
					},
				},
				defaultTemplate: "test",
			},
			{ settings: { registry: async () => [] } },
		);
	});

	afterAll(async () => {
		for (const daemon of daemons) await daemon.stop();
		for (const daemonId of spawned) await server.lifecycle.stop(daemonId);
		if (server !== undefined) await server.close();
	});

	// Stand in for the spawned session: wait for the child's recorded stdin
	// payload, then dial the fleet with its callback pair and wait for the pair.
	async function dialAsSession(): Promise<FleetPayload> {
		await waitFor(
			() =>
				existsSync(envFile) &&
				existsSync(payloadFile) &&
				readFileSync(payloadFile, "utf8").endsWith("\n"),
			5000,
			"child payload and env recorded",
		);
		const lastLine = readFileSync(payloadFile, "utf8").trim().split("\n").at(-1)!;
		const payload = JSON.parse(lastLine) as FleetPayload;
		const daemon = startCallbackDaemon({
			url: payload.callback.url,
			workspaceId: payload.callback.workspace,
			generation: payload.callback.generation,
			token: payload.callback.token,
		});
		daemons.push(daemon);
		await daemon.waitConnected(5000);
		return payload;
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
		expect(body.entry.cwd).toBe(repoReal);
		expect(body.entry.projectId).toBe(body.project.projectId);
		expect(body.entry.labels).toEqual(["env=prod"]);

		const payload = await dialAsSession();
		expect(payload.v).toBe(1);
		expect(payload.callback.workspace).toBe(body.entry.daemonId);
		expect(typeof payload.callback.generation).toBe("number");
		expect(payload.callback.token).toMatch(/^[0-9a-f]{64}$/);
		// The pair and listener token travel on stdin only: never in the child's env.
		const childEnv = readFileSync(envFile, "utf8");
		expect(childEnv).toMatch(/^OMP_SESSION_LOG_MIRROR=0$/m);
		expect(childEnv).not.toMatch(/OMP_SESSION_CALLBACK_/);
		expect(childEnv).not.toMatch(/OMP_SESSION_TOKEN=/);
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

	test("POST /ctl/stop then /ctl/start run a spawned session through the lifecycle's kind-agnostic verbs", async () => {
		const project = server.registry.projects().find((p) => p.path === repoReal)!;
		const row = server.registry
			.list()
			.find((e) => e.projectId === project.projectId && e.status === "ready")!;
		const stopped = await postJson(server.port, "/ctl/stop", { selector: row.daemonId });
		expect(stopped.status).toBe(200);
		expect(server.registry.get(row.daemonId)?.status).toBe("asleep");

		const launches = (): string[] => readFileSync(payloadFile, "utf8").trim().split("\n");
		const before = launches().length;
		const started = await postJson(server.port, "/ctl/start", { daemonId: row.daemonId });
		expect(started.status).toBe(200);
		expect(await started.json()).toEqual({ daemonId: row.daemonId, observed: "running" });
		await waitFor(() => launches().length === before + 1, 5000, "child relaunched by start");
		const relaunch = JSON.parse(launches().at(-1)!) as FleetPayload;
		expect(relaunch.callback.workspace).toBe(row.daemonId);
		// A fresh generation: the stop revoked the first credential.
		expect(relaunch.callback.generation).toBeGreaterThan(1);
		expect(server.registry.get(row.daemonId)?.status).toBe("connecting");

		const unknown = await postJson(server.port, "/ctl/start", { daemonId: "no-such-daemon" });
		expect(unknown.status).toBe(404);
	});
});
