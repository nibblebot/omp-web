import { describe, expect, test } from "bun:test";
import type { SettingsItem, SettingsModel } from "#lib/wire/protocol";
import {
	changedCountsByTab,
	DEFAULT_SETTINGS_TAB_ID,
	SETTINGS_TABS,
	settingsTabMeta,
	tabBadgeCount,
	settingsSectionId,
	visibleSettingsTabs,
} from "../../prefs/settings-tabs";

function item(path: string, changed: boolean): SettingsItem {
	return { path, label: path, description: "", type: "boolean", value: null, changed };
}

const model: SettingsModel = {
	tabs: [
		{
			id: "appearance",
			label: "Appearance",
			groups: [
				{ name: "Theme", items: [item("theme", true), item("composer.x", false)] },
				{ name: "Advanced", items: [item("advanced.y", true)] },
			],
		},
		{
			id: "model",
			label: "Model",
			groups: [{ name: "Thinking", items: [item("thinking", true), item("sampling", true)] }],
		},
		{
			id: "context",
			label: "Context",
			groups: [{ name: "Compaction", items: [item("compaction", false)] }],
		},
	],
};

describe("SETTINGS_TABS", () => {
	test("ids are unique, Common opens first and Appearance leads the SDK tabs", () => {
		const ids = SETTINGS_TABS.map((tab) => tab.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(SETTINGS_TABS[0]?.id).toBe("common");
		expect(SETTINGS_TABS[1]?.id).toBe("appearance");
		expect(DEFAULT_SETTINGS_TAB_ID).toBe("common");
	});

	test("client tabs sit last", () => {
		const client = SETTINGS_TABS.filter((tab) => tab.kind === "client");
		expect(client.map((tab) => tab.id)).toEqual(["web-ui", "features"]);
	});
});

describe("settingsTabMeta", () => {
	test("finds a tab by id and returns undefined for an unknown id", () => {
		expect(settingsTabMeta("model")?.label).toBe("Model");
		expect(settingsTabMeta("nope")).toBeUndefined();
	});
});

describe("settingsSectionId", () => {
	test("builds a per-tab id from the section name, slugged", () => {
		expect(settingsSectionId("model", "Status Line")).toBe("settings-model-status-line");
		expect(settingsSectionId("web-ui", "Interface")).toBe("settings-web-ui-interface");
	});

	test("ids differ across tabs for the same section name", () => {
		expect(settingsSectionId("tools", "Advanced")).not.toBe(settingsSectionId("tasks", "Advanced"));
	});
});

describe("visibleSettingsTabs", () => {
	test("lists every tab while the model is still loading", () => {
		expect(visibleSettingsTabs(null)).toEqual(SETTINGS_TABS);
	});

	test("drops SDK tabs the model does not carry but keeps Installed and client tabs", () => {
		const ids = visibleSettingsTabs(model).map((tab) => tab.id);
		expect(ids).toEqual([
			"common",
			"appearance",
			"model",
			"context",
			"installed",
			"web-ui",
			"features",
		]);
	});
});

describe("changedCountsByTab and tabBadgeCount", () => {
	test("counts changed items per model tab, across every group including Advanced", () => {
		const counts = changedCountsByTab(model);
		expect(counts.get("appearance")).toBe(2);
		expect(counts.get("model")).toBe(2);
		expect(counts.get("context")).toBe(0);
	});

	test("an absent model yields no counts", () => {
		expect(changedCountsByTab(null).size).toBe(0);
	});

	test("badges show for SDK tabs only, defaulting to 0 when the tab is absent", () => {
		const counts = changedCountsByTab(model);
		expect(tabBadgeCount(counts, settingsTabMeta("model")!)).toBe(2);
		expect(tabBadgeCount(counts, settingsTabMeta("tools")!)).toBe(0);
		expect(tabBadgeCount(counts, settingsTabMeta("installed")!)).toBe(0);
		expect(tabBadgeCount(counts, settingsTabMeta("web-ui")!)).toBe(0);
	});
});
