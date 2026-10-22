import { describe, expect, test } from "bun:test";
import type { SettingsItem, SettingsModel } from "#lib/wire/protocol";
import {
	changedCountsByTab,
	defaultSettingsTabId,
	SETTINGS_TABS,
	scrollSpyIndex,
	settingsSectionId,
	settingsTabHeadingId,
	settingsTabMeta,
	settingsTabRuns,
	tabBadgeCount,
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
	test("ids are unique and the session tab leads", () => {
		const ids = SETTINGS_TABS.map((tab) => tab.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(SETTINGS_TABS[0]?.id).toBe("session");
		expect(ids).not.toContain("common");
	});

	test("sections run session, omp, omp-web and client tabs sit last", () => {
		const runs = settingsTabRuns(SETTINGS_TABS);
		expect(runs.map((run) => run.section)).toEqual(["session", "omp", "omp-web"]);
		const client = SETTINGS_TABS.filter((tab) => tab.kind === "client");
		expect(client.map((tab) => tab.id)).toEqual(["web-ui", "features"]);
		expect(client.every((tab) => tab.section === "omp-web")).toBe(true);
	});

	test("SDK tab ids are unchanged by the label split", () => {
		expect(settingsTabMeta("appearance")?.kind).toBe("sdk");
		expect(settingsTabMeta("web-ui")?.kind).toBe("client");
		expect(settingsTabMeta("appearance")?.label).not.toBe(settingsTabMeta("web-ui")?.label);
	});
});

describe("settingsTabMeta", () => {
	test("finds a tab by id and returns undefined for an unknown id", () => {
		expect(settingsTabMeta("model")?.label).toBe("Model");
		expect(settingsTabMeta("nope")).toBeUndefined();
		expect(settingsTabMeta("common")).toBeUndefined();
	});
});

describe("settingsSectionId and settingsTabHeadingId", () => {
	test("builds a per-tab id from the section name, slugged", () => {
		expect(settingsSectionId("model", "Status Line")).toBe("settings-model-status-line");
		expect(settingsSectionId("web-ui", "Interface")).toBe("settings-web-ui-interface");
	});

	test("ids differ across tabs for the same section name", () => {
		expect(settingsSectionId("tools", "Advanced")).not.toBe(settingsSectionId("tasks", "Advanced"));
	});

	test("heading ids are per tab and never collide with section ids", () => {
		const headings = SETTINGS_TABS.map((tab) => settingsTabHeadingId(tab.id));
		expect(new Set(headings).size).toBe(headings.length);
		expect(headings).not.toContain(settingsSectionId("web-ui", "Interface"));
	});
});

describe("visibleSettingsTabs", () => {
	test("lists every tab while the model is still loading when a session is attached", () => {
		expect(visibleSettingsTabs(null, true)).toEqual(SETTINGS_TABS);
	});

	test("drops SDK tabs the model does not carry but keeps client tabs", () => {
		const ids = visibleSettingsTabs(model, true).map((tab) => tab.id);
		expect(ids).toEqual(["session", "appearance", "model", "context", "web-ui", "features"]);
	});

	test("the session tab needs an attached session", () => {
		expect(visibleSettingsTabs(model, false).map((tab) => tab.id)).not.toContain("session");
		expect(visibleSettingsTabs(null, false).some((tab) => tab.kind === "session")).toBe(false);
	});
});

describe("defaultSettingsTabId", () => {
	test("is the first visible tab", () => {
		expect(defaultSettingsTabId(visibleSettingsTabs(model, true))).toBe("session");
		expect(defaultSettingsTabId(visibleSettingsTabs(model, false))).toBe("appearance");
		expect(defaultSettingsTabId(visibleSettingsTabs(null, false))).toBe("appearance");
	});
});

describe("settingsTabRuns", () => {
	test("labels the omp and omp-web runs and leaves no section without a session", () => {
		const runs = settingsTabRuns(visibleSettingsTabs(model, false));
		expect(runs.map((run) => run.section)).toEqual(["omp", "omp-web"]);
		expect(runs[1]?.tabs.map((tab) => tab.id)).toEqual(["web-ui", "features"]);
	});

	test("an empty tab list yields no runs", () => {
		expect(settingsTabRuns([])).toEqual([]);
	});
});

describe("scrollSpyIndex", () => {
	test("picks the last heading whose top has crossed the spy line", () => {
		expect(scrollSpyIndex([-400, -20, 0, 300], 2, null)).toBe(2);
		expect(scrollSpyIndex([-400, -20, 150, 300], 2, null)).toBe(1);
	});

	test("is -1 before the first heading reaches the line", () => {
		expect(scrollSpyIndex([12, 400], 2, null)).toBe(-1);
		expect(scrollSpyIndex([], 2, null)).toBe(-1);
	});

	test("at the top the first heading wins even if later ones crossed the line", () => {
		expect(scrollSpyIndex([0, 180, 900], 300, "top")).toBe(0);
		expect(scrollSpyIndex([], 300, "top")).toBe(-1);
	});

	test("at the bottom the last heading wins even if it never reached the line", () => {
		expect(scrollSpyIndex([-400, -20, 300], 2, "bottom")).toBe(2);
		expect(scrollSpyIndex([], 2, "bottom")).toBe(-1);
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
		expect(tabBadgeCount(counts, settingsTabMeta("web-ui")!)).toBe(0);
	});
});
