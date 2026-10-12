/**
 * Boot reconciliation tests for fleet/server.ts ("boot reconciliation (#3)"
 * describe): a fleet booted against a seeded registry downgrades stale
 * non-terminal spawned entries to 'asleep'. An enrolled remote entry persisted
 * 'ready' drops to 'reconnecting' (its daemon redials with the persisted
 * enrollment) and becomes 'asleep' once the redial grace elapses. An
 * unenrolled remote entry has nothing to redial with, so it goes straight to
 * 'asleep'. Intentional stops and terminal errors stay untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Registry } from "../registry";
import { startFleet, type FleetServer } from "../server";
import {
	FAKE_CWD,
	cleanupTempDirs,
	fleetPaths,
	hermeticStatsConfig,
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

const BOOT_CREDENTIAL = "boot-credential";

describe("boot reconciliation (#3)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;

	const TEST_REDIAL_GRACE_MS = 1_500;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		writeFileSync(configPath, JSON.stringify({}));
		// Seed the registry exactly as a previous fleet process would have
		// left it: stale non-terminal statuses (children/sockets died with
		// that process), an enrolled and an unenrolled remote 'ready' entry,
		// an intentional stop, and a real error.
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
		const enrolled = registry.create({
			name: "enrolled-ready",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.setWorkspaceEnrollment(enrolled.daemonId, {
			credentialHash: createHash("sha256").update(BOOT_CREDENTIAL).digest("hex"),
			generation: 1,
		});
		registry.create({
			name: "unenrolled-ready",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.create({
			name: "stopped",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			status: "asleep",
		});
		registry.create({
			name: "terminal-error",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			status: "error",
			error: "daemon rejected the credential",
		});
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			statsConfig: hermeticStatsConfig(statePath),
			redialGraceMs: TEST_REDIAL_GRACE_MS,
		});
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
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

	test("an enrolled remote entry persisted 'ready' is reconnecting at boot, with stale readyAt cleared", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-ready")!;
		expect(entry.status).toBe("reconnecting");
		expect(entry.readyAt).toBeUndefined();
	});

	test("an unenrolled remote entry persisted 'ready' goes straight to asleep at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "unenrolled-ready")!;
		expect(entry.status).toBe("asleep");
		expect(entry.readyAt).toBeUndefined();
	});

	test("an enrolled entry still 'reconnecting' after the redial grace becomes asleep", async () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-ready")!;
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "asleep",
			TEST_REDIAL_GRACE_MS + 2_000,
			"redial grace expiry",
		);
		expect(server.registry.get(entry.daemonId)?.status).toBe("asleep");
	}, 10_000);

	test("intentionally stopped and terminal-error entries are left untouched", () => {
		const stopped = server.registry.list().find((e) => e.name === "stopped")!;
		const errored = server.registry.list().find((e) => e.name === "terminal-error")!;
		expect(stopped.status).toBe("asleep");
		expect(errored.status).toBe("error");
		expect(errored.error).toContain("rejected");
	});
});
