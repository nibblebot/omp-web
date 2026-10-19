/**
 * Boot reconciliation tests for fleet/server.ts ("boot reconciliation (#3)"
 * describe): dead local sessions become 'asleep' immediately. Enrolled local
 * sessions with live locks and enrolled sessions get 'reconnecting'
 * until redial grace expires. Unenrolled entries go straight to 'asleep'.
 * Intentional stops and terminal errors stay untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../registry";
import { startFleet } from "../server";
import type { FleetServer } from "../server";
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
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await child.exited).toBe(0);
		const deadPid = child.pid;
		try {
			process.kill(deadPid, 0);
			throw new Error("exited child pid is unexpectedly alive");
		} catch (err) {
			expect(err).toHaveProperty("code", "ESRCH");
		}
		const liveSessionFile = join(tmp, "live-session.jsonl");
		const staleSessionFile = join(tmp, "stale-session.jsonl");
		writeFileSync(
			`${liveSessionFile}.lock`,
			JSON.stringify({ pid: process.pid, name: "live-session", startedAt: Date.now() }),
		);
		writeFileSync(
			`${staleSessionFile}.lock`,
			JSON.stringify({ pid: deadPid, name: "dead-session", startedAt: 0 }),
		);
		// Seed the registry exactly as a previous fleet process would have
		// left it: stale non-terminal statuses (children/sockets died with
		// that process), an enrolled and an unenrolled 'ready' entry,
		// an intentional stop, and a real error.
		const registry = new Registry(statePath);
		await registry.load();
		registry.create({
			name: "stale-ready",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			template: "test",
			status: "ready",
			readyAt: Date.now() - 60_000,
			pid: deadPid,
		});
		registry.create({
			name: "stuck-spawning",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			template: "test",
			status: "spawning",
		});
		registry.create({
			name: "stale-connecting",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			template: "test",
			status: "connecting",
		});
		const enrolled = registry.create({
			name: "enrolled-ready",
			cwd: "",
			project: "",
			labels: [],
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.setWorkspaceEnrollment(enrolled.daemonId, {
			credentialHash: createHash("sha256").update(BOOT_CREDENTIAL).digest("hex"),
			generation: 1,
		});
		for (const fixture of [
			{ name: "enrolled-live-local", lastSessionFile: liveSessionFile, pid: process.pid },
			{
				name: "enrolled-missing-local",
				lastSessionFile: join(tmp, "missing-session.jsonl"),
				pid: process.pid,
			},
			{ name: "enrolled-stale-local", lastSessionFile: staleSessionFile, pid: process.pid },
			{ name: "enrolled-dead-pid", pid: deadPid },
		]) {
			const local = registry.create({
				...fixture,
				cwd: tmp,
				project: "fake-proj",
				labels: [],
				template: "test",
				status: "ready",
				readyAt: Date.now() - 120_000,
			});
			registry.setWorkspaceEnrollment(local.daemonId, {
				credentialHash: createHash("sha256").update(BOOT_CREDENTIAL).digest("hex"),
				generation: 1,
			});
		}
		registry.create({
			name: "unenrolled-ready",
			cwd: "",
			project: "",
			labels: [],
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.create({
			name: "stopped",
			cwd: "",
			project: "",
			labels: [],
			status: "asleep",
		});
		registry.create({
			name: "terminal-error",
			cwd: "",
			project: "",
			labels: [],
			status: "error",
			error: "daemon rejected the credential",
		});
		registry.flush();
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

	test("an enrolled entry persisted 'ready' is reconnecting at boot, with stale readyAt cleared", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-ready")!;
		expect(entry.status).toBe("reconnecting");
		expect(entry.readyAt).toBeUndefined();
	});

	test("an enrolled local entry with a live session lock is reconnecting at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-live-local")!;
		expect(entry.status).toBe("reconnecting");
		expect(entry.readyAt).toBeUndefined();
		expect(entry.pid).toBeUndefined();
	});

	test("an enrolled local entry with a missing session lock goes straight to asleep at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-missing-local")!;
		expect(entry.status).toBe("asleep");
		expect(entry.readyAt).toBeUndefined();
		expect(entry.pid).toBeUndefined();
	});

	test("an enrolled local entry with a stale dead-pid session lock goes straight to asleep at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-stale-local")!;
		expect(entry.status).toBe("asleep");
		expect(entry.readyAt).toBeUndefined();
		expect(entry.pid).toBeUndefined();
	});

	test("an enrolled local entry with a dead recorded pid and no session file goes straight to asleep at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-dead-pid")!;
		expect(entry.status).toBe("asleep");
		expect(entry.readyAt).toBeUndefined();
		expect(entry.pid).toBeUndefined();
	});

	test("an unenrolled entry persisted 'ready' goes straight to asleep at boot", () => {
		const entry = server.registry.list().find((e) => e.name === "unenrolled-ready")!;
		expect(entry.status).toBe("asleep");
		expect(entry.readyAt).toBeUndefined();
	});

	test("an enrolled local entry with a live session lock becomes asleep after the redial grace", async () => {
		const entry = server.registry.list().find((e) => e.name === "enrolled-live-local")!;
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "asleep",
			TEST_REDIAL_GRACE_MS + 2_000,
			"redial grace expiry",
		);
		expect(server.registry.get(entry.daemonId)?.status).toBe("asleep");
	}, 10_000);

	test("an enrolled entry becomes asleep after the redial grace", async () => {
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
