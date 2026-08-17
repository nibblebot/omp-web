/**
 * resolveStatsConfig env precedence: PI_CONFIG_DIR → stats.db,
 * PI_CODING_AGENT_DIR → sessions (wins over XDG_DATA_HOME), XDG_DATA_HOME
 * fallback. No port/host — the fleet control plane owns those.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStatsConfig } from "../fleet/stats/config";

/** Scrub the runner's own PI_/XDG_ vars so tests are hermetic. */
function baseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!/^(PI_|XDG_DATA_HOME$)/.test(k)) env[k] = v;
	}
	return env;
}

describe("resolveStatsConfig env precedence", () => {
	test("PI_CONFIG_DIR drives configRoot and statsDbPath", () => {
		const cfg = resolveStatsConfig({ ...baseEnv(), PI_CONFIG_DIR: "/tmp/picfg" });
		expect(cfg.configRoot).toBe("/tmp/picfg");
		expect(cfg.statsDbPath).toBe(join("/tmp/picfg", "stats.db"));
	});

	test("PI_CODING_AGENT_DIR drives sessionsDir", () => {
		const cfg = resolveStatsConfig({ ...baseEnv(), PI_CODING_AGENT_DIR: "/tmp/piagent" });
		expect(cfg.sessionsDir).toBe(join("/tmp/piagent", "sessions"));
	});

	test("XDG_DATA_HOME is the sessions fallback", () => {
		const cfg = resolveStatsConfig({ ...baseEnv(), XDG_DATA_HOME: "/tmp/xdg" });
		expect(cfg.sessionsDir).toBe(join("/tmp/xdg", "omp", "agent", "sessions"));
	});

	test("PI_CODING_AGENT_DIR wins over XDG_DATA_HOME", () => {
		const cfg = resolveStatsConfig({
			...baseEnv(),
			PI_CODING_AGENT_DIR: "/tmp/piagent",
			XDG_DATA_HOME: "/tmp/xdg",
		});
		expect(cfg.sessionsDir).toBe(join("/tmp/piagent", "sessions"));
	});

	test("sessions fall back under PI_CONFIG_DIR when neither agent var is set", () => {
		const cfg = resolveStatsConfig({ ...baseEnv(), PI_CONFIG_DIR: "/tmp/picfg" });
		expect(cfg.sessionsDir).toBe(join("/tmp/picfg", "agent", "sessions"));
	});

	test("defaults under the real home dir", () => {
		const cfg = resolveStatsConfig(baseEnv());
		expect(cfg.configRoot).toBe(join(homedir(), ".omp"));
		expect(cfg.statsDbPath).toBe(join(homedir(), ".omp", "stats.db"));
		expect(cfg.sessionsDir).toBe(join(homedir(), ".omp", "agent", "sessions"));
	});
});
