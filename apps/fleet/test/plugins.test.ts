import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type PluginStore } from "#lib/plugins/installed-plugins";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { createFleetPlugins } from "../plugins";
import type { FleetServer } from "../server";
import { cleanupTempDirs, fleetPaths, postJson, startTestFleet } from "./server.testkit";

// Entry test files register the cleanup at their own top level (bun 1.3 loader).
afterAll(cleanupTempDirs);

// The fleet service reads and writes through an injected store, so these tests
// never open the real lock file or the agent's plugin root.

interface FakeState {
	plugins: InstalledPlugin[];
	settings: Record<string, Record<string, unknown>>;
}

function fakeStore(state: FakeState): PluginStore {
	const find = (name: string): InstalledPlugin => {
		const plugin = state.plugins.find((p) => p.name === name);
		if (!plugin) throw new Error(`Plugin ${name} not found in runtime config`);
		return plugin;
	};
	return {
		list: async () => state.plugins,
		getPlugin: async (name) => state.plugins.find((p) => p.name === name),
		setEnabled: async (name, enabled) => {
			find(name).enabled = enabled;
		},
		setEnabledFeatures: async (name, features) => {
			find(name).enabledFeatures = features;
		},
		getPluginSettings: async (name) => state.settings[name] ?? {},
		setPluginSetting: async (name, key, value) => {
			state.settings[name] = { ...state.settings[name], [key]: value };
		},
		deletePluginSetting: async (name, key) => {
			const next = { ...state.settings[name] };
			delete next[key];
			state.settings[name] = next;
		},
	};
}

function demoPlugin(path: string): InstalledPlugin {
	return {
		name: "demo-plugin",
		version: "1.2.0",
		path,
		enabled: true,
		enabledFeatures: null,
		manifest: {
			version: "1.2.0",
			description: "Demo",
			features: {
				base: { description: "Base", default: true },
				extra: { description: "Extra" },
			},
			settings: {
				token: { type: "string", secret: true },
				level: { type: "number", default: 2, min: 1, max: 5 },
			},
		},
	};
}

function alphaPlugin(path: string): InstalledPlugin {
	return { ...demoPlugin(path), name: "alpha-plugin", manifest: { version: "0.1.0" } };
}

function setup(settings: FakeState["settings"] = {}) {
	const plugins = [demoPlugin(tempDir("fleet-plugin-")), alphaPlugin(tempDir("fleet-plugin-"))];
	const state: FakeState = { plugins, settings };
	const service = createFleetPlugins({ openStore: async () => fakeStore(state) });
	return { state, service };
}

describe("createFleetPlugins", () => {
	test("list returns sorted summaries with no version placeholder", async () => {
		const { service } = setup();
		const list = await service.list();
		expect(list.map((p) => p.name)).toEqual(["alpha-plugin", "demo-plugin"]);
		expect(list[1]).toEqual({
			name: "demo-plugin",
			version: "1.2.0",
			source: "npm",
			enabled: true,
			description: "Demo",
		});
		expect(JSON.stringify(list)).not.toContain("undefined");
	});

	test("get never sends a secret value or default, only the set flag", async () => {
		const { service } = setup({ "demo-plugin": { token: "sk-live-123", level: 3 } });
		const detail = await service.get("demo-plugin");
		const token = detail.settings.find((row) => row.key === "token");
		expect(token).toEqual({ key: "token", type: "string", secret: true, set: true });
		expect(detail.settings.find((row) => row.key === "level")).toMatchObject({
			type: "number",
			value: 3,
			default: 2,
			min: 1,
			max: 5,
			set: true,
		});
		expect(JSON.stringify(detail)).not.toContain("sk-live-123");
	});

	test("setEnabled persists and returns the fresh detail", async () => {
		const { state, service } = setup();
		const detail = await service.setEnabled("demo-plugin", false);
		expect(detail.enabled).toBe(false);
		expect(state.plugins.find((p) => p.name === "demo-plugin")?.enabled).toBe(false);
	});

	test("setFeatures selects an explicit list, then null restores manifest defaults", async () => {
		const { service } = setup();
		const selected = await service.setFeatures("demo-plugin", ["extra"]);
		expect(selected.featuresCustomized).toBe(true);
		expect(selected.features.map((f) => [f.name, f.enabled])).toEqual([
			["base", false],
			["extra", true],
		]);
		const cleared = await service.setFeatures("demo-plugin", null);
		expect(cleared.featuresCustomized).toBe(false);
		expect(cleared.features.map((f) => [f.name, f.enabled])).toEqual([
			["base", true],
			["extra", false],
		]);
	});

	test("setFeatures rejects an unknown feature as a client error", async () => {
		const { service } = setup();
		await expect(service.setFeatures("demo-plugin", ["nope"])).rejects.toMatchObject({
			status: 400,
			message: "Unknown feature: nope",
		});
	});

	test("setSetting validates against the schema and never echoes the rejected value", async () => {
		const { service } = setup();
		await expect(service.setSetting("demo-plugin", "level", 9)).rejects.toMatchObject({
			status: 400,
			message: "Invalid value for level: Must be <= 5",
		});
		await expect(service.setSetting("demo-plugin", "missing", 1)).rejects.toMatchObject({
			status: 400,
			message: "Unknown setting: missing",
		});
	});

	test("setSetting persists a valid value and null clears it", async () => {
		const { state, service } = setup();
		const set = await service.setSetting("demo-plugin", "level", 4);
		expect(set.settings.find((row) => row.key === "level")).toMatchObject({ value: 4, set: true });
		expect(state.settings["demo-plugin"]).toEqual({ level: 4 });
		const cleared = await service.setSetting("demo-plugin", "level", null);
		expect(cleared.settings.find((row) => row.key === "level")).toMatchObject({ set: false });
		expect(state.settings["demo-plugin"]).toEqual({});
	});

	test("an unknown plugin is a 404", async () => {
		const { service } = setup();
		await expect(service.get("nope")).rejects.toMatchObject({
			status: 404,
			message: "Unknown plugin: nope",
		});
	});
});

describe("plugin routes", () => {
	let server: FleetServer;
	let state: FakeState;

	beforeAll(async () => {
		state = {
			plugins: [demoPlugin(tempDir("fleet-plugin-")), alphaPlugin(tempDir("fleet-plugin-"))],
			settings: {},
		};
		server = await startTestFleet(fleetPaths(), {}, { pluginStore: async () => fakeStore(state) });
	});

	afterAll(async () => {
		await server.close();
	});

	const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
	const demo = () => state.plugins.find((p) => p.name === "demo-plugin");

	test("GET /ctl/plugins lists installed plugins sorted by name", async () => {
		const res = await fetch(url("/ctl/plugins"));
		expect(res.status).toBe(200);
		const list = (await res.json()) as Array<{ name: string }>;
		expect(list.map((p) => p.name)).toEqual(["alpha-plugin", "demo-plugin"]);
	});

	test("GET /ctl/plugins/:name returns the detail with features and setting rows", async () => {
		const res = await fetch(url("/ctl/plugins/demo-plugin"));
		expect(res.status).toBe(200);
		const detail = (await res.json()) as {
			name: string;
			enabled: boolean;
			settings: Array<{ key: string }>;
		};
		expect(detail.name).toBe("demo-plugin");
		expect(detail.enabled).toBe(true);
		expect(detail.settings.map((row) => row.key)).toEqual(["token", "level"]);
		expect(JSON.stringify(detail)).toContain('"extra"');
	});

	test("GET an unknown plugin is 404", async () => {
		const res = await fetch(url("/ctl/plugins/nope"));
		expect(res.status).toBe(404);
	});

	test("POST enabled persists the toggle and rejects a non-boolean", async () => {
		const off = await postJson(server.port, "/ctl/plugins/demo-plugin/enabled", { enabled: false });
		expect(off.status).toBe(200);
		expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
		expect(demo()?.enabled).toBe(false);

		const bad = await postJson(server.port, "/ctl/plugins/demo-plugin/enabled", { enabled: "no" });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toContain("enabled must be a boolean");

		const on = await postJson(server.port, "/ctl/plugins/demo-plugin/enabled", { enabled: true });
		expect(on.status).toBe(200);
		expect(demo()?.enabled).toBe(true);
	});

	test("POST features selects an explicit list, rejects an unknown feature, null restores defaults", async () => {
		const pick = await postJson(server.port, "/ctl/plugins/demo-plugin/features", {
			features: ["extra"],
		});
		expect(pick.status).toBe(200);
		expect(demo()?.enabledFeatures).toEqual(["extra"]);

		const unknown = await postJson(server.port, "/ctl/plugins/demo-plugin/features", {
			features: ["x"],
		});
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toContain("Unknown feature");

		const reset = await postJson(server.port, "/ctl/plugins/demo-plugin/features", {
			features: null,
		});
		expect(reset.status).toBe(200);
		expect(demo()?.enabledFeatures).toBeNull();
	});

	test("POST setting stores a secret and never echoes it back", async () => {
		const secret = "sk-route-secret-42";
		const res = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "token",
			value: secret,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).not.toContain(secret);
		expect(state.settings["demo-plugin"]?.token).toBe(secret);

		const detail = await fetch(url("/ctl/plugins/demo-plugin"));
		const text = await detail.text();
		expect(text).not.toContain(secret);
		const row = (
			JSON.parse(text) as { settings: Array<{ key: string; set?: boolean }> }
		).settings.find((r) => r.key === "token");
		expect(row?.set).toBe(true);
	});

	test("POST setting rejects an invalid value without echoing it", async () => {
		const rejected = "sk-rejected-value";
		const res = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "level",
			value: rejected,
		});
		expect(res.status).toBe(400);
		expect(await res.text()).not.toContain(rejected);
	});

	test("POST setting 400s on an unknown key or a missing value", async () => {
		const unknown = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "nope",
			value: 1,
		});
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toContain("Unknown setting: nope");

		const missing = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "token",
		});
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toContain("setting value required");
	});

	test("POST setting with null clears a stored secret", async () => {
		const res = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "token",
			value: null,
		});
		expect(res.status).toBe(200);
		expect(state.settings["demo-plugin"]?.token).toBeUndefined();
		const detail = (await res.json()) as { settings: Array<{ key: string; set?: boolean }> };
		expect(detail.settings.find((r) => r.key === "token")?.set).toBe(false);
	});

	test("POST a write to an unknown plugin is 404", async () => {
		const res = await postJson(server.port, "/ctl/plugins/nope/enabled", { enabled: true });
		expect(res.status).toBe(404);
	});

	test("no plugin route response carries a secret value", async () => {
		const secret = "sk-sweep-7f3a";
		const written = await postJson(server.port, "/ctl/plugins/demo-plugin/setting", {
			key: "token",
			value: secret,
		});
		const bodies = [
			await written.text(),
			await (await fetch(url("/ctl/plugins"))).text(),
			await (await fetch(url("/ctl/plugins/demo-plugin"))).text(),
			await (
				await postJson(server.port, "/ctl/plugins/demo-plugin/enabled", { enabled: true })
			).text(),
		];
		for (const body of bodies) expect(body).not.toContain(secret);
		expect(state.settings["demo-plugin"]?.token).toBe(secret);
	});
});
