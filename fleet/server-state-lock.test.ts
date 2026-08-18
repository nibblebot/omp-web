/**
 * State-lock tests for fleet/server.ts ("fleet state lock" describe): one
 * fleet per state file via an O_EXCL pidfile lock — a second startFleet on
 * the same path rejects with LockHeldError, close() releases the lock, and
 * a spawned `serve` exits 77 with the lock message while another fleet
 * holds the state.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LockHeldError } from "../shared/file-lock";
import { startFleet } from "./server";
import { cleanupTempDirs, fleetPaths, pinSettingsInMemory } from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
await pinSettingsInMemory();

describe("fleet state lock", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;

	beforeAll(() => {
		({ tmp, statePath, configPath } = fleetPaths());
		writeFileSync(configPath, JSON.stringify({}));
	});

	afterAll(() => {
		// Keep the describe's explicit cleanup: it mirrors the lock-release
		// lifecycle this describe exercises. The shared testkit afterAll also
		// removes the dir best-effort, so a failed test can't leak it (the
		// second rmSync is a force no-op on an already-removed path).
		rmSync(tmp, { recursive: true, force: true });
	});

	function fleetOpts() {
		return {
			port: 0,
			statePath,
			configPath,
			// Stub the settings provider registry like the main suite so the
			// real ~/.omp auth DB is never opened.
			settings: { registry: async () => [] },
		};
	}

	test("a second startFleet on the same state path rejects with LockHeldError", async () => {
		const server = await startFleet(fleetOpts());
		try {
			await expect(startFleet(fleetOpts())).rejects.toThrow(LockHeldError);
		} finally {
			await server.close();
		}
	});

	test("after close(), the same state path can be started again", async () => {
		const first = await startFleet(fleetOpts());
		await first.close();
		const second = await startFleet(fleetOpts());
		await second.close();
	});

	test("serve exits 77 with the lock message when another fleet holds the state", async () => {
		const first = await startFleet(fleetOpts());
		try {
			const serve = Bun.spawn(["bun", "fleet/cli.ts", "serve", "--port", "0"], {
				cwd: join(import.meta.dir, ".."),
				env: { ...process.env, OMP_FLEET_STATE: statePath, OMP_FLEET_CONFIG: configPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, errText] = await Promise.all([
				new Response(serve.stdout).text(),
				new Response(serve.stderr).text(),
			]);
			const exit = await serve.exited;
			expect(exit).toBe(77);
			expect(out).toBe("");
			expect(errText).toContain(
				`fleet already running (pid ${process.pid}) — state locked at ${statePath}.lock`,
			);
		} finally {
			await first.close();
		}
	});
});
