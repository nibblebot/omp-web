import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_TEMPLATE, loadConfig } from "./config";

const tmpDirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-config-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const DEFAULT_ROOTS = [join(homedir(), "repos")];

describe("loadConfig", () => {
	test("defaults when the file is missing", async () => {
		const config = await loadConfig(join(tmpDir(), "nope.json"));
		expect(config.roots).toEqual(DEFAULT_ROOTS);
		expect(config.templates).toEqual({ local: DEFAULT_LOCAL_TEMPLATE });
		expect(config.defaultTemplate).toBe("local");
		expect(config.spawnHook).toBeUndefined();
	});

	test("shallow-merges the file over defaults, tolerating unknown fields", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(
			file,
			JSON.stringify({
				roots: ["/srv/repos"],
				templates: {
					docker: { command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name}", host: "docker.local" },
				},
				defaultTemplate: "docker",
				futureOption: { nested: true },
			}),
		);
		const config = await loadConfig(file);
		expect(config.roots).toEqual(["/srv/repos"]);
		expect(config.templates).toEqual({
			docker: { command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name}", host: "docker.local" },
		});
		expect(config.defaultTemplate).toBe("docker");
		expect(config.spawnHook).toBeUndefined();
	});

	test("partial file keeps defaults for the rest", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ roots: ["/x"] }));
		const config = await loadConfig(file);
		expect(config.roots).toEqual(["/x"]);
		expect(config.templates).toEqual({ local: DEFAULT_LOCAL_TEMPLATE });
		expect(config.defaultTemplate).toBe("local");
	});

	test("expands ~ in roots", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ roots: ["~", "~/work", "/abs/path"] }));
		const config = await loadConfig(file);
		expect(config.roots).toEqual([homedir(), join(homedir(), "work"), "/abs/path"]);
	});

	test("OMP_FLEET_CONFIG is honored; an explicit path wins over it", async () => {
		const dir = tmpDir();
		const envFile = join(dir, "env.json");
		writeFileSync(envFile, JSON.stringify({ roots: ["/from-env"], defaultTemplate: "remote" }));
		const explicitFile = join(dir, "explicit.json");
		writeFileSync(explicitFile, JSON.stringify({ roots: ["/from-explicit"] }));
		const prev = process.env.OMP_FLEET_CONFIG;
		process.env.OMP_FLEET_CONFIG = envFile;
		try {
			const fromEnv = await loadConfig();
			expect(fromEnv.roots).toEqual(["/from-env"]);
			expect(fromEnv.defaultTemplate).toBe("remote");

			const fromExplicit = await loadConfig(explicitFile);
			expect(fromExplicit.roots).toEqual(["/from-explicit"]);
		} finally {
			if (prev === undefined) delete process.env.OMP_FLEET_CONFIG;
			else process.env.OMP_FLEET_CONFIG = prev;
		}
	});

	test("parses projectTemplates; absent by default", async () => {
		const file = join(tmpDir(), "config.json");
		writeFileSync(file, JSON.stringify({ projectTemplates: { "proj-a": "docker", "proj-b": "local" } }));
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
			expect(fromFile.templates).toEqual({ docker: { command: "docker run omp-session {cwd}", host: "docker.local" }, local: expected });
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
		expect(await loadConfig(join(dir, "bad-json.json"))).toEqual(await loadConfig(join(dir, "missing.json")));

		writeFileSync(join(dir, "bad-shape.json"), JSON.stringify({ roots: "nope", templates: 42, defaultTemplate: 7 }));
		expect(await loadConfig(join(dir, "bad-shape.json"))).toEqual(await loadConfig(join(dir, "missing.json")));
	});
});

describe("DEFAULT_LOCAL_TEMPLATE", () => {
	test("matches the contract command string", () => {
		expect(DEFAULT_LOCAL_TEMPLATE).toEqual({
			command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}",
		});
	});
});
