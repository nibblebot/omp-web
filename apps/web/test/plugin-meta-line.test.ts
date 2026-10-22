import { describe, expect, test } from "bun:test";
import type { PluginSummary } from "#lib/wire/protocol";
import { pluginMetaLine } from "../store/plugins";

const base: PluginSummary = { name: "demo", source: "npm", enabled: true };

describe("Plugin row meta line", () => {
	test("shows state, source, and version", () => {
		expect(pluginMetaLine({ ...base, version: "1.2.0" })).toBe("Enabled · npm · v1.2.0");
	});

	test("omits the version when the manifest has none (never vundefined)", () => {
		const line = pluginMetaLine(base);
		expect(line).toBe("Enabled · npm");
		expect(line).not.toContain("undefined");
	});

	test("omits an empty version string", () => {
		expect(pluginMetaLine({ ...base, version: "" })).toBe("Enabled · npm");
	});

	test("reports disabled linked plugins", () => {
		expect(pluginMetaLine({ ...base, source: "link", enabled: false })).toBe("Disabled · link");
	});
});
