/**
 * resolveStatsConfig env precedence: PI_CONFIG_DIR → stats.db,
 * PI_CODING_AGENT_DIR → sessions (wins over XDG_DATA_HOME), XDG_DATA_HOME
 * fallback. No port/host; the fleet control plane owns those.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStatsConfig } from "../stats-config";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

/** Scrub the runner's own PI_/XDG_ vars so tests are hermetic. */
function baseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!/^(OMP_PROFILE$|PI_|XDG_DATA_HOME$)/.test(k)) env[k] = v;
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

	test("existing XDG_DATA_HOME root holds stats and flattened sessions", () => {
		const xdg = tempDir("omp-stats-xdg-");
		mkdirSync(join(xdg, "omp"));
		const cfg = resolveStatsConfig({ ...baseEnv(), XDG_DATA_HOME: xdg });
		expect(cfg.sessionsDir).toBe(join(xdg, "omp", "sessions"));
		expect(cfg.statsDbPath).toBe(join(xdg, "omp", "stats.db"));
	});

	test("PI_CODING_AGENT_DIR wins over XDG_DATA_HOME", () => {
		const cfg = resolveStatsConfig({
			...baseEnv(),
			PI_CODING_AGENT_DIR: "/tmp/piagent",
			XDG_DATA_HOME: "/tmp/xdg",
		});
		expect(cfg.sessionsDir).toBe(join("/tmp/piagent", "sessions"));
	});

	test("unmigrated XDG roots leave stats and sessions at the default", () => {
		const xdg = tempDir("omp-stats-xdg-unmigrated-");
		const cfg = resolveStatsConfig({ ...baseEnv(), XDG_DATA_HOME: xdg });
		expect(cfg.statsDbPath).toBe(join(homedir(), ".omp", "stats.db"));
		expect(cfg.sessionsDir).toBe(join(homedir(), ".omp", "agent", "sessions"));
	});

	test("a custom agent directory disables XDG redirection for the database too", () => {
		const xdg = tempDir("omp-stats-xdg-custom-");
		mkdirSync(join(xdg, "omp"));
		const cfg = resolveStatsConfig({
			...baseEnv(),
			PI_CODING_AGENT_DIR: "/tmp/piagent",
			XDG_DATA_HOME: xdg,
		});
		expect(cfg.statsDbPath).toBe(join(homedir(), ".omp", "stats.db"));
		expect(cfg.sessionsDir).toBe("/tmp/piagent/sessions");
	});

	test("OMP_PROFILE wins over PI_PROFILE and the custom agent directory", () => {
		const cfg = resolveStatsConfig({
			...baseEnv(),
			OMP_PROFILE: "work",
			PI_PROFILE: "legacy",
			PI_CODING_AGENT_DIR: "/tmp/piagent",
		});
		const root = join(homedir(), ".omp", "profiles", "work");
		expect(cfg.configRoot).toBe(root);
		expect(cfg.statsDbPath).toBe(join(root, "stats.db"));
		expect(cfg.sessionsDir).toBe(join(root, "agent", "sessions"));
	});

	test("an explicitly empty OMP_PROFILE selects default instead of PI_PROFILE", () => {
		const cfg = resolveStatsConfig({ ...baseEnv(), OMP_PROFILE: "", PI_PROFILE: "legacy" });
		expect(cfg.configRoot).toBe(join(homedir(), ".omp"));
	});

	test("named profiles only adopt their own migrated XDG directory", () => {
		const xdg = tempDir("omp-stats-xdg-profile-");
		mkdirSync(join(xdg, "omp"));
		const env = { ...baseEnv(), OMP_PROFILE: "work", XDG_DATA_HOME: xdg };
		expect(resolveStatsConfig(env).statsDbPath).toBe(
			join(homedir(), ".omp", "profiles", "work", "stats.db"),
		);
		const profileRoot = join(xdg, "omp", "profiles", "work");
		mkdirSync(profileRoot, { recursive: true });
		expect(resolveStatsConfig(env).statsDbPath).toBe(join(profileRoot, "stats.db"));
		expect(resolveStatsConfig(env).sessionsDir).toBe(join(profileRoot, "sessions"));
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
