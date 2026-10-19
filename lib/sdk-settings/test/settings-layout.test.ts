import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import {
	ADVANCED_GROUP,
	ADVANCED_SETTING_PATHS,
	HIDDEN_SETTING_PATHS,
	TAB_SECTION_ORDER,
	WEB_TRUE_CONDITIONS,
} from "#lib/sdk-settings/settings-layout";
import {
	buildSettingsModel,
	settingEffect,
	type SettingsSession,
	WEB_RENDER_PATHS,
} from "#lib/sdk-settings/settings-model";

// The model reads the shared Settings singleton for gates and values. Keep it in-memory.
await Settings.init({ inMemory: true });

const session: SettingsSession = {
	getAvailableThinkingLevels: () => ["low", "high"],
	getAvailableModels: () => [],
};

// The manifest is checked against the live SDK host, never against inventory.json.
const hostRows = createSettingsHost().entries.filter((entry) => entry.ui !== undefined);
const hostPaths = new Set(hostRows.map((entry) => entry.path));
const model = buildSettingsModel(session, []);
const emitted = new Set(
	model.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.items.map((item) => item.path))),
);

describe("settings layout manifest", () => {
	test("hidden and advanced path sets are disjoint", () => {
		for (const path of hostPaths) {
			expect({
				path,
				both:
					Object.hasOwn(HIDDEN_SETTING_PATHS, path) && Object.hasOwn(ADVANCED_SETTING_PATHS, path),
			}).toEqual({ path, both: false });
		}
	});

	test("every manifest path exists in the live host", () => {
		for (const set of [HIDDEN_SETTING_PATHS, ADVANCED_SETTING_PATHS]) {
			for (const path of Object.keys(set)) expect(hostPaths.has(path)).toBe(true);
		}
	});

	test("hidden rows are never emitted", () => {
		for (const path of Object.keys(HIDDEN_SETTING_PATHS)) {
			expect(emitted.has(path)).toBe(false);
		}
	});

	test("every manifest section exists in the host for its tab", () => {
		for (const [tab, sections] of Object.entries(TAB_SECTION_ORDER)) {
			const groups = new Set(
				hostRows.filter((entry) => entry.ui?.tab === tab).map((entry) => entry.ui?.group ?? ""),
			);
			for (const section of sections)
				expect({ tab, section, present: groups.has(section) }).toEqual({
					tab,
					section,
					present: true,
				});
		}
	});

	test("sections follow the manifest order, ungrouped first, Advanced last", () => {
		for (const tab of model.tabs) {
			const names = tab.groups.map((group) => group.name);
			const listed = TAB_SECTION_ORDER[tab.id] ?? [];
			const positions = names
				.filter((name) => listed.includes(name))
				.map((name) => listed.indexOf(name));
			expect({ tab: tab.id, positions }).toEqual({
				tab: tab.id,
				positions: [...positions].sort((a, b) => a - b),
			});
			if (names.includes(""))
				expect({ tab: tab.id, first: names[0] }).toEqual({ tab: tab.id, first: "" });
			if (names.includes(ADVANCED_GROUP)) {
				expect({ tab: tab.id, last: names.at(-1) }).toEqual({ tab: tab.id, last: ADVANCED_GROUP });
			}
		}
	});

	test("a row is emitted exactly when its gate holds, honoring WEB_TRUE_CONDITIONS", () => {
		for (const entry of hostRows) {
			if (HIDDEN_SETTING_PATHS[entry.path]) continue;
			const condition = entry.ui?.condition;
			const forced = condition !== undefined && WEB_TRUE_CONDITIONS[entry.path] === condition;
			const expected = forced || (entry.condition ? entry.condition() : true);
			expect({ path: entry.path, shown: emitted.has(entry.path) }).toEqual({
				path: entry.path,
				shown: expected,
			});
		}
	});

	test("terminal-probe gates are forced visible in the web model", () => {
		expect(emitted.has("terminal.showImages")).toBe(true);
		expect(emitted.has("expandThinkingBlocks")).toBe(true);
	});

	test("WEB_RENDER_PATHS: 49 live, non-hidden host rows", () => {
		const paths = Object.keys(WEB_RENDER_PATHS);
		expect(paths).toHaveLength(49);
		for (const path of paths) {
			expect({
				path,
				host: hostPaths.has(path),
				hidden: HIDDEN_SETTING_PATHS[path] === true,
			}).toEqual({
				path,
				host: true,
				hidden: false,
			});
			expect({ path, effect: settingEffect(path) }).toEqual({ path, effect: "live" });
		}
	});
});
