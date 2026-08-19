import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_TEMPLATE, loadConfig, resolveConfigPath, type FleetConfig } from "./config";

const tmpDirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-config-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	// Hermetic against the dev-runner override: loadConfig lets
	// OMP_FLEET_LOCAL_TEMPLATE replace the local template outright, and a
	// shell that ran `bun run dev` carries it — every template assertion
	// below would see the override instead of the file/default.
	const savedLocalTemplate = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	beforeAll(() => {
		delete process.env.OMP_FLEET_LOCAL_TEMPLATE;
	});
	afterAll(() => {
		if (savedLocalTemplate === undefined) delete process.env.OMP_FLEET_LOCAL_TEMPLATE;
		else process.env.OMP_FLEET_LOCAL_TEMPLATE = savedLocalTemplate;
	});

	test("defaults when the file is missing", async () => {
		const config = await loadConfig(join(tmpDir(), "nope.json"));
		expect(config.templates).toEqual({ local: DEFAULT_LOCAL_TEMPLATE });
		expect(config.defaultTemplate).toBe("local");
		expect(config.spawnHook).toBeUndefined();
		expect(config.workspaceDir).toBe(join(homedir(), ".omp-web", "workspaces"));
	});

	test("shallow-merges the file over defaults, tolerating unknown fields", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(
			file,
			JSON.stringify({
				templates: {
					docker: {
						command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name}",
						host: "docker.local",
					},
				},
				defaultTemplate: "docker",
				futureOption: { nested: true },
			}),
		);
		const config = await loadConfig(file);
		expect(config.templates).toEqual({
			docker: {
				command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name}",
				host: "docker.local",
			},
		});
		expect(config.defaultTemplate).toBe("docker");
		expect(config.spawnHook).toBeUndefined();
	});

	test("partial file keeps defaults for the rest", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ defaultTemplate: "docker" }));
		const config = await loadConfig(file);
		expect(config.defaultTemplate).toBe("docker");
		expect(config.templates).toEqual({ local: DEFAULT_LOCAL_TEMPLATE });
	});

	test("a legacy roots key is ignored (configs written before its removal still load)", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ roots: ["~", "~/work"], defaultTemplate: "local" }));
		const config = await loadConfig(file);
		expect("roots" in config).toBe(false);
		expect(config.defaultTemplate).toBe("local");
	});

	test("OMP_FLEET_CONFIG is honored; an explicit path wins over it", async () => {
		const dir = tmpDir();
		const envFile = join(dir, "env.json");
		writeFileSync(
			envFile,
			JSON.stringify({ workspaceDir: "/from-env", defaultTemplate: "remote" }),
		);
		const explicitFile = join(dir, "explicit.json");
		writeFileSync(explicitFile, JSON.stringify({ workspaceDir: "/from-explicit" }));
		const prev = process.env.OMP_FLEET_CONFIG;
		process.env.OMP_FLEET_CONFIG = envFile;
		try {
			const fromEnv = await loadConfig();
			expect(fromEnv.workspaceDir).toBe("/from-env");
			expect(fromEnv.defaultTemplate).toBe("remote");

			const fromExplicit = await loadConfig(explicitFile);
			expect(fromExplicit.workspaceDir).toBe("/from-explicit");
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_CONFIG;
			else process.env.OMP_FLEET_CONFIG = prev;
		}
	});

	test("parses projectTemplates; absent by default", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(
			file,
			JSON.stringify({ projectTemplates: { "proj-a": "docker", "proj-b": "local" } }),
		);
		const config = await loadConfig(file);
		expect(config.projectTemplates).toEqual({ "proj-a": "docker", "proj-b": "local" });

		const defaults = await loadConfig(join(tmpDir(), "missing.json"));
		expect(defaults.projectTemplates).toBeUndefined();
	});

	test("malformed projectTemplates fall back to defaults", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ projectTemplates: 42 }));
		const config = await loadConfig(file);
		expect(config.projectTemplates).toBeUndefined();

		writeFileSync(file, JSON.stringify({ projectTemplates: { "proj-a": 7 } }));
		const config2 = await loadConfig(file);
		expect(config2.projectTemplates).toBeUndefined();
	});

	test("OMP_FLEET_LOCAL_TEMPLATE replaces the local template, file or not", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(
			file,
			JSON.stringify({
				templates: { docker: { command: "docker run omp-session {cwd}", host: "docker.local" } },
			}),
		);
		const prev = process.env.OMP_FLEET_LOCAL_TEMPLATE;
		process.env.OMP_FLEET_LOCAL_TEMPLATE = "bun /repo/server/index.ts --cwd {cwd} --port 0";
		try {
			const expected = { command: "bun /repo/server/index.ts --cwd {cwd} --port 0" };

			// Wins over the file's templates (and survives `local` being absent there).
			const fromFile = await loadConfig(file);
			expect(fromFile.templates).toEqual({
				docker: { command: "docker run omp-session {cwd}", host: "docker.local" },
				local: expected,
			});
			expect(fromFile.defaultTemplate).toBe("local");

			// Applies on the missing-file default path too.
			const fromDefaults = await loadConfig(join(tmpDir(), "missing.json"));
			expect(fromDefaults.templates.local).toEqual(expected);
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_LOCAL_TEMPLATE;
			else process.env.OMP_FLEET_LOCAL_TEMPLATE = prev;
		}
	});

	test("spawnHook: env OMP_FLEET_SPAWN_HOOK wins over the file", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ spawnHook: "/cfg/hook.sh" }));
		const fromFile = await loadConfig(file);
		expect(fromFile.spawnHook).toBe("/cfg/hook.sh");

		const prev = process.env.OMP_FLEET_SPAWN_HOOK;
		process.env.OMP_FLEET_SPAWN_HOOK = "/env/hook.sh";
		try {
			const fromEnv = await loadConfig(file);
			expect(fromEnv.spawnHook).toBe("/env/hook.sh");
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_SPAWN_HOOK;
			else process.env.OMP_FLEET_SPAWN_HOOK = prev;
		}
	});

	test("corrupt or malformed config falls back to defaults", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "bad-json.json"), "{ nope");
		expect(await loadConfig(join(dir, "bad-json.json"))).toEqual(
			await loadConfig(join(dir, "missing.json")),
		);

		writeFileSync(
			join(dir, "bad-shape.json"),
			JSON.stringify({ roots: "nope", templates: 42, defaultTemplate: 7 }),
		);
		expect(await loadConfig(join(dir, "bad-shape.json"))).toEqual(
			await loadConfig(join(dir, "missing.json")),
		);
	});
});

describe("workspaceDir", () => {
	/** Load with a controlled OMP_FLEET_WORKSPACE_DIR (isolated per call). */
	async function loadWithEnv(
		envValue: string | undefined,
		file?: string,
		flag?: string,
	): Promise<FleetConfig> {
		const prev = process.env.OMP_FLEET_WORKSPACE_DIR;
		if (envValue === undefined) delete process.env.OMP_FLEET_WORKSPACE_DIR;
		else process.env.OMP_FLEET_WORKSPACE_DIR = envValue;
		try {
			return await loadConfig(file, flag !== undefined ? { workspaceDir: flag } : undefined);
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_WORKSPACE_DIR;
			else process.env.OMP_FLEET_WORKSPACE_DIR = prev;
		}
	}

	test("defaults to ~/.omp-web/workspaces (expanded)", async () => {
		const config = await loadWithEnv(undefined, join(tmpDir(), "missing.json"));
		expect(config.workspaceDir).toBe(join(homedir(), ".omp-web", "workspaces"));
	});

	test("config-file workspaceDir key is honored (~ expanded)", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ workspaceDir: "/ws/file" }));
		expect((await loadWithEnv(undefined, file)).workspaceDir).toBe("/ws/file");

		writeFileSync(file, JSON.stringify({ workspaceDir: "~/ws" }));
		expect((await loadWithEnv(undefined, file)).workspaceDir).toBe(join(homedir(), "ws"));
	});

	test("malformed workspaceDir key falls back to the default", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ workspaceDir: 42 }));
		const config = await loadWithEnv(undefined, file);
		expect(config.workspaceDir).toBe(join(homedir(), ".omp-web", "workspaces"));
	});

	test("env OMP_FLEET_WORKSPACE_DIR wins over the config file (~ expanded)", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ workspaceDir: "/ws/file" }));

		expect((await loadWithEnv("/ws/env", file)).workspaceDir).toBe("/ws/env");
		expect((await loadWithEnv("~/ws/env", file)).workspaceDir).toBe(join(homedir(), "ws/env"));
	});

	test("empty env value is ignored (file/default apply)", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ workspaceDir: "/ws/file" }));
		expect((await loadWithEnv("", file)).workspaceDir).toBe("/ws/file");

		expect((await loadWithEnv("", join(tmpDir(), "missing.json"))).workspaceDir).toBe(
			join(homedir(), ".omp-web", "workspaces"),
		);
	});

	test("explicit flag (--workspace-dir) wins over env and the file (~ expanded)", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ workspaceDir: "/ws/file" }));

		expect((await loadWithEnv("/ws/env", file, "/ws/flag")).workspaceDir).toBe("/ws/flag");
		expect((await loadWithEnv(undefined, file, "~/ws/flag")).workspaceDir).toBe(
			join(homedir(), "ws/flag"),
		);
	});
});

describe("DEFAULT_LOCAL_TEMPLATE", () => {
	test("matches the contract command string", () => {
		expect(DEFAULT_LOCAL_TEMPLATE).toEqual({
			command:
				"omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}",
		});
	});
});

describe("resolveConfigPath", () => {
	test("defaults to ~/.omp-web/config.json (no explicit path, no env)", () => {
		const prev = process.env.OMP_FLEET_CONFIG;
		delete process.env.OMP_FLEET_CONFIG;
		try {
			expect(resolveConfigPath()).toBe(join(homedir(), ".omp-web", "config.json"));
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_CONFIG;
			else process.env.OMP_FLEET_CONFIG = prev;
		}
	});

	test("env OMP_FLEET_CONFIG wins over the default; explicit wins over env", () => {
		const prev = process.env.OMP_FLEET_CONFIG;
		process.env.OMP_FLEET_CONFIG = "~/from-env.json";
		try {
			expect(resolveConfigPath()).toBe(join(homedir(), "from-env.json"));
			expect(resolveConfigPath("/explicit.json")).toBe("/explicit.json");
			expect(resolveConfigPath("~/explicit.json")).toBe(join(homedir(), "explicit.json"));
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_CONFIG;
			else process.env.OMP_FLEET_CONFIG = prev;
		}
	});
});
