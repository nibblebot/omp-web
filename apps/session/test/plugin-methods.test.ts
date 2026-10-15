import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "#lib/testkit/temp-dir.testkit";

// The SDK resolves its config root from HOME once per process, so every op
// runs in a child process whose HOME is a temp dir. The real PluginManager
// reads and writes that temp ~/.omp/plugins; nothing here touches the user's.

const MODULE_PATH = fileURLToPath(new URL("../plugin-methods.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type Result = { ok: unknown } | { error: string };
type Op = [method: string, args: unknown[]];
type PluginRow = Record<string, unknown>;
type PluginDetailShape = {
	features: Array<{ name: string; description?: string; enabled: boolean; default: boolean }>;
	featuresCustomized: boolean;
	settings: PluginRow[];
};
type LockShape = {
	plugins: Record<string, { enabled: boolean; enabledFeatures: unknown }>;
	settings: Record<string, Record<string, unknown>>;
};

function makeHome(): { home: string; cwd: string; lock: string } {
	const home = tempDir("plugin-home-");
	const cwd = tempDir("plugin-cwd-");
	const plugins = join(home, ".omp", "plugins");
	const nodeModules = join(plugins, "node_modules");
	const linkTarget = tempDir("plugin-linked-src-");
	mkdirSync(join(nodeModules, "demo-plugin"), { recursive: true });
	writeFileSync(
		join(linkTarget, "package.json"),
		JSON.stringify({ name: "linked-plugin", version: "0.3.0", omp: { features: {} } }),
	);
	symlinkSync(linkTarget, join(nodeModules, "linked-plugin"), "dir");
	writeFileSync(
		join(plugins, "package.json"),
		JSON.stringify({ dependencies: { "demo-plugin": "1.2.0", "linked-plugin": "0.3.0" } }),
	);
	writeFileSync(
		join(nodeModules, "demo-plugin", "package.json"),
		JSON.stringify({
			name: "demo-plugin",
			version: "1.2.0",
			omp: {
				description: "Demo plugin",
				features: {
					core: { description: "Core tools", default: true },
					extra: { description: "Extra tools" },
				},
				settings: {
					token: { type: "string", secret: true, description: "API token" },
					level: { type: "number", default: 2, min: 1, max: 5 },
					mode: { type: "enum", values: ["a", "b"], default: "a" },
					on: { type: "boolean" },
				},
			},
		}),
	);
	const lock = join(plugins, "omp-plugins.lock.json");
	writeFileSync(
		lock,
		JSON.stringify({
			plugins: {
				"demo-plugin": { enabled: true, enabledFeatures: null },
				"linked-plugin": { enabled: true, enabledFeatures: null },
			},
			settings: {},
		}),
	);
	return { home, cwd, lock };
}

async function run(home: string, cwd: string, ops: Op[]): Promise<Result[]> {
	const code = `
		const { createPluginMethods } = await import(${JSON.stringify(MODULE_PATH)});
		const methods = createPluginMethods({ cwd: ${JSON.stringify(cwd)} });
		const out = [];
		for (const [method, args] of JSON.parse(process.env.PLUGIN_OPS)) {
			try {
				out.push({ ok: await methods[method](args) });
			} catch (err) {
				out.push({ error: err instanceof Error ? err.message : String(err) });
			}
		}
		process.stdout.write(JSON.stringify(out));
	`;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	]) {
		delete env[key];
	}
	env.HOME = home;
	env.PLUGIN_OPS = JSON.stringify(ops);
	const proc = Bun.spawn([process.execPath, "-e", code], {
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exit !== 0) throw new Error(`plugin child failed (${exit}): ${stderr}`);
	return JSON.parse(stdout) as Result[];
}

function okValue(result: Result | undefined): unknown {
	if (!result || !("ok" in result)) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result.ok;
}

function errorText(result: Result | undefined): string {
	if (!result || !("error" in result))
		throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.error;
}

function readLock(lock: string): LockShape {
	return JSON.parse(readFileSync(lock, "utf8")) as LockShape;
}

describe("session plugin methods", () => {
	test("listPlugins reports npm and link sources without vundefined", async () => {
		const { home, cwd } = makeHome();
		const [result] = await run(home, cwd, [["listPlugins", []]]);
		const plugins = okValue(result) as PluginRow[];
		const demo = plugins.find((plugin) => plugin["name"] === "demo-plugin");
		const linked = plugins.find((plugin) => plugin["name"] === "linked-plugin");
		expect(demo).toEqual({
			name: "demo-plugin",
			version: "1.2.0",
			source: "npm",
			enabled: true,
			description: "Demo plugin",
		});
		expect(linked?.["source"]).toBe("link");
		expect(JSON.stringify(plugins)).not.toContain("undefined");
	});

	test("getPluginConfig shapes features and redacts secret settings", async () => {
		const { home, cwd } = makeHome();
		const [result] = await run(home, cwd, [["getPluginConfig", ["demo-plugin"]]]);
		const detail = okValue(result) as PluginDetailShape;
		expect(detail.featuresCustomized).toBe(false);
		expect(detail.features).toEqual([
			{ name: "core", description: "Core tools", enabled: true, default: true },
			{ name: "extra", description: "Extra tools", enabled: false, default: false },
		]);
		const token = detail.settings.find((row) => row["key"] === "token");
		expect(token).toEqual({
			key: "token",
			type: "string",
			description: "API token",
			secret: true,
			set: false,
		});
		const mode = detail.settings.find((row) => row["key"] === "mode");
		expect(mode).toMatchObject({ type: "enum", values: ["a", "b"], default: "a", set: false });
	});

	test("secret values are stored on disk but never echoed on the wire", async () => {
		const { home, cwd, lock } = makeHome();
		const secret = "sk-test-secret-value-123";
		const [write, read] = await run(home, cwd, [
			["setPluginSetting", ["demo-plugin", "token", secret]],
			["getPluginConfig", ["demo-plugin"]],
		]);
		expect(JSON.stringify(okValue(write))).not.toContain(secret);
		expect(JSON.stringify(okValue(read))).not.toContain(secret);
		const readDetail = okValue(read) as PluginDetailShape;
		const token = readDetail.settings.find((row) => row["key"] === "token");
		expect(token).toMatchObject({ secret: true, set: true });
		expect(token).not.toHaveProperty("value");
		expect(token).not.toHaveProperty("default");
		expect(readLock(lock).settings["demo-plugin"]?.["token"]).toBe(secret);
	});

	test("setPluginSetting validates, reports errors without the value, and clears on null", async () => {
		const { home, cwd, lock } = makeHome();
		const results = await run(home, cwd, [
			["setPluginSetting", ["demo-plugin", "level", 9]],
			["setPluginSetting", ["demo-plugin", "mode", "zzz"]],
			["setPluginSetting", ["demo-plugin", "missing", "x"]],
			["setPluginSetting", ["demo-plugin", "on", true]],
			["setPluginSetting", ["demo-plugin", "on", null]],
		]);
		expect(errorText(results[0])).toBe("Invalid value for level: Must be <= 5");
		expect(errorText(results[1])).toBe("Invalid value for mode: Must be one of: a, b");
		expect(errorText(results[2])).toBe("Unknown setting: missing");
		expect(okValue(results[3])).toMatchObject({ settings: expect.any(Array) });
		expect(readLock(lock).settings["demo-plugin"]?.["on"]).toBeUndefined();
		expect(readLock(lock).settings["demo-plugin"]).toBeDefined();
	});

	test("setPluginFeatures selects features, validates names, and resets on null", async () => {
		const { home, cwd, lock } = makeHome();
		const [select, bad, reset] = await run(home, cwd, [
			["setPluginFeatures", ["demo-plugin", ["extra"]]],
			["setPluginFeatures", ["demo-plugin", ["nope"]]],
			["setPluginFeatures", ["demo-plugin", null]],
		]);
		expect(okValue(select)).toMatchObject({
			featuresCustomized: true,
			features: [
				{ name: "core", enabled: false, default: true },
				{ name: "extra", enabled: true, default: false },
			],
		});
		expect(errorText(bad)).toBe("Unknown feature: nope");
		expect(okValue(reset)).toMatchObject({ featuresCustomized: false });
		expect(readLock(lock).plugins["demo-plugin"]?.enabledFeatures).toBeNull();
	});

	test("setPluginEnabled persists and unknown plugins are rejected", async () => {
		const { home, cwd, lock } = makeHome();
		const [disable, unknown, list] = await run(home, cwd, [
			["setPluginEnabled", ["demo-plugin", false]],
			["getPluginConfig", ["nope"]],
			["listPlugins", []],
		]);
		expect(okValue(disable)).toMatchObject({ name: "demo-plugin", enabled: false });
		expect(errorText(unknown)).toBe("Unknown plugin: nope");
		const listed = okValue(list) as PluginRow[];
		const demo = listed.find((plugin) => plugin["name"] === "demo-plugin");
		expect(demo?.["enabled"]).toBe(false);
		expect(readLock(lock).plugins["demo-plugin"]?.enabled).toBe(false);
	});
});
