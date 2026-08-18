/**
 * Boot reconciliation tests for fleet/server.ts ("boot reconciliation (#3)"
 * describe): a fleet booted against a seeded registry must downgrade stale
 * non-terminal spawned entries, redial remote entries persisted 'ready', and
 * leave intentional stops and terminal errors untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Registry } from "./registry";
import { startFleet, type FleetServer } from "./server";
import {
	FAKE_CWD,
	cleanupTempDirs,
	fleetPaths,
	startFakeDaemon,
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

describe("boot reconciliation (#3)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		writeFileSync(configPath, JSON.stringify({}));
		fake = startFakeDaemon("boot-token");
		// Seed the registry exactly as a previous fleet process would have
		// left it: stale non-terminal statuses (children/sockets died with
		// that process), an intentional stop, and a real error.
		const registry = new Registry(statePath);
		await registry.load();
		registry.create({
			name: "stale-ready",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "ready",
			readyAt: Date.now() - 60_000,
			pid: 12345,
		});
		registry.create({
			name: "stuck-spawning",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "spawning",
		});
		registry.create({
			name: "stale-connecting",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "connecting",
		});
		registry.create({
			name: "boot-dial",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: fake.url,
			token: "boot-token",
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.create({
			name: "stopped",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			status: "asleep",
		});
		registry.create({
			name: "terminal-error",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			status: "error",
			error: "unauthorized (401): daemon rejected the token",
		});
		server = await startFleet({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

	test("spawned stale 'ready'/'spawning'/'connecting' entries are downgraded to asleep with stale readyAt/pid cleared", () => {
		const entries = server.registry.list();
		const staleReady = entries.find((e) => e.name === "stale-ready")!;
		expect(staleReady.status).toBe("asleep");
		expect(staleReady.readyAt).toBeUndefined();
		expect(staleReady.pid).toBeUndefined();
		expect(entries.find((e) => e.name === "stuck-spawning")!.status).toBe("asleep");
		expect(entries.find((e) => e.name === "stale-connecting")!.status).toBe("asleep");
	});

	test("a remote entry persisted 'ready' is redialed at boot (connecting → ready via the connector)", async () => {
		const entry = server.registry.list().find((e) => e.name === "boot-dial")!;
		// The boot reconcile dials immediately; the fake must see the token.
		await waitFor(() => fake.seen.authHeader !== null, 5000, "boot dial");
		expect(fake.seen.authHeader).toBe("Bearer boot-token");
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "ready",
			5000,
			"re-ready after boot redial",
		);
		expect(server.registry.get(entry.daemonId)?.readyAt).toBeTypeOf("number");
	});

	test("intentionally stopped and terminal-error entries are left untouched", async () => {
		const stopped = server.registry.list().find((e) => e.name === "stopped")!;
		const errored = server.registry.list().find((e) => e.name === "terminal-error")!;
		expect(stopped.status).toBe("asleep");
		expect(errored.status).toBe("error");
		expect(errored.error).toContain("unauthorized");
		// A short wait proves the stopped entry was NOT dialed: the connector
		// transitions synchronously on connect(), so any dial would have left
		// "asleep" by now.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 400);
		await promise;
		expect(server.registry.get(stopped.daemonId)?.status).toBe("asleep");
		expect(server.connector.isConnected(stopped.daemonId)).toBe(false);
	});
});
