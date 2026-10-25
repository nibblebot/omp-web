/**
 * Shared fixtures/helpers for the fleet/server split test files (*.test.ts).
 * NOT a test file: bun test discovery (`.test.`/`_test.`/`.spec.`/`_spec.`
 * patterns) never matches `*.testkit.ts`, so this never runs as a suite.
 *
 * Everything here exercises loopback HTTP against a real fleet server. No
 * omp-session children are spawned; tests that need a session's side of the
 * callback pair use callback-session.testkit.ts.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { startFleet, type FleetServer } from "../server";

// Entry test files register the cleanup at their own top level:
// `afterAll(cleanupTempDirs)`; see the shared testkit's doc comment.
export { cleanupTempDirs };

// The /ctl/settings routes lazily initialize the process-global Settings
// singleton on first use; pin it to in-memory so route tests never touch the
// real ~/.omp config. The pin lives at each entry file's top level, NOT here:
// a top-level await in this imported module races bun 1.3.14's parallel
// test-file loader (importers sporadically observe this module's bindings in
// TDZ: "Cannot access 'FAKE_CWD' before initialization").
export async function pinSettingsInMemory(): Promise<void> {
	await Settings.init({ inMemory: true });
}

export const FAKE_CWD = "/tmp/fake-proj";

/** Poll until `predicate` is truthy or the timeout elapses. */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 20);
		await promise;
	}
	throw new Error(`timed out waiting for ${what}`);
}

export function postJson(port: number, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** `git init -q` (plus extra args) in `cwd`, asserting success. */
export async function gitInit(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "init", "-q", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(await proc.exited).toBe(0);
}

export interface FleetPaths {
	tmp: string;
	statePath: string;
	configPath: string;
}

/**
 * Fresh tmp/state/config paths inside a tracked temp dir (see tempDir in
 * lib/testkit/temp-dir.testkit). Replaces the original suites' raw mkdtempSync describe
 * dirs, which never got rmSync'd. Entry test files register
 * `afterAll(cleanupTempDirs)` at their top level; each bun test file runs in
 * its own process, so one registration per file removes its own dirs.
 */
export function fleetPaths(prefix = "omp-web-test-"): FleetPaths {
	const tmp = tempDir(prefix);
	return { tmp, statePath: join(tmp, "state.json"), configPath: join(tmp, "config.json") };
}

/**
 * Hermetic stats config for suites that call `startFleet` directly (bypassing
 * startTestFleet). Without it, createStatsApp falls back to the operator's
 * real $PI_CONFIG_DIR/stats.db (default ~/.omp/stats.db) and real sessions
 * dir, making suites environment-dependent and touching operator state.
 */
export function hermeticStatsConfig(statePath: string): {
	statsDbPath: string;
	sessionsDir: string;
} {
	const dir = dirname(statePath);
	return { statsDbPath: join(dir, "stats.db"), sessionsDir: join(dir, "agent-sessions") };
}

type FleetExtra = Omit<Parameters<typeof startFleet>[0], "port" | "statePath" | "configPath">;

/**
 * Boot a test fleet on ephemeral port 0 against the given paths: writes
 * `config` to configPath, then starts the fleet. `extra` merges into the
 * startFleet options (port/statePath/configPath are owned by this helper).
 * Stats defaults to the hermetic per-fleet locations; `extra.statsConfig`
 * overrides.
 */
export async function startTestFleet(
	paths: Pick<FleetPaths, "statePath" | "configPath">,
	config: unknown,
	extra: FleetExtra = {},
): Promise<FleetServer> {
	writeFileSync(paths.configPath, JSON.stringify(config));
	return startFleet({
		port: 0,
		statePath: paths.statePath,
		configPath: paths.configPath,
		statsConfig: hermeticStatsConfig(paths.statePath),
		...extra,
	});
}
