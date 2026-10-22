import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { HIDDEN_SETTING_PATHS } from "#lib/sdk-settings/settings-layout";
import {
	buildSettingsModel,
	NEXT_SESSION_PATHS,
	settingEffect,
	settingView,
	type SettingsSession,
} from "#lib/sdk-settings/settings-model";
import { LIVE_SETTING_TRACE } from "./live-setting-trace";

await Settings.init({ inMemory: true });

const session: SettingsSession = {
	getAvailableThinkingLevels: () => ["low", "high"],
	getAvailableModels: () => [],
};

// Every web-reachable row, including rows whose gate is closed in this environment:
// a gated row can become visible later, so it needs a classification too.
const webPaths = createSettingsHost()
	.entries.filter((entry) => entry.ui !== undefined && !HIDDEN_SETTING_PATHS[entry.path])
	.map((entry) => entry.path);
const webPathSet = new Set(webPaths);

describe("settingEffect classification", () => {
	test("every web row is traced as next-session or live, never both", () => {
		const unclassified = webPaths.filter(
			(path) =>
				!Object.hasOwn(NEXT_SESSION_PATHS, path) && !Object.hasOwn(LIVE_SETTING_TRACE, path),
		);
		const both = webPaths.filter(
			(path) => Object.hasOwn(NEXT_SESSION_PATHS, path) && Object.hasOwn(LIVE_SETTING_TRACE, path),
		);
		expect({ unclassified, both }).toEqual({ unclassified: [], both: [] });
	});

	test("neither list holds a stale or hidden path", () => {
		const stale = [...Object.keys(NEXT_SESSION_PATHS), ...Object.keys(LIVE_SETTING_TRACE)].filter(
			(path) => !webPathSet.has(path),
		);
		expect(stale).toEqual([]);
	});

	test("settingEffect follows the lists", () => {
		for (const path of webPaths) {
			expect({ path, effect: settingEffect(path) }).toEqual({
				path,
				effect: Object.hasOwn(NEXT_SESSION_PATHS, path) ? "next-session" : "live",
			});
		}
	});

	test("every emitted item carries its path's effect, never restart", () => {
		const model = buildSettingsModel(session, []);
		const items = model.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.items));
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			expect({ path: item.path, effect: item.view?.effect }).toEqual({
				path: item.path,
				effect: settingEffect(item.path),
			});
		}
	});

	test("effect does not depend on the model target", () => {
		for (const path of webPaths) {
			const current = settingView(path, Settings.instance, { target: "current-session" });
			const future = settingView(path, Settings.instance, { target: "future-sessions" });
			expect({ path, effect: future.effect }).toEqual({ path, effect: current.effect });
		}
	});

	test("a live row stays live in the future-sessions model", () => {
		const model = buildSettingsModel(session, [], { target: "future-sessions" });
		const items = model.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.items));
		expect(items.find((item) => item.path === "steeringMode")?.view?.effect).toBe("live");
		expect(items.find((item) => item.path === "defaultThinkingLevel")?.view?.effect).toBe(
			"next-session",
		);
	});
});
